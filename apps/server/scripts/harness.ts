/**
 * Real-time multiplayer harness. It starts the game server in this process and connects
 * headless bot players to it over real Socket.IO connections, each with its own simulated
 * round-trip latency and jitter. A bot runs the same client netcode as the browser: clock sync,
 * an adaptive input lead, tick-stamped inputs, prediction with replay on every snapshot. It
 * drives with the autopilot. All scenarios run at the same time, each in its own room:
 *
 *   2p          two players, one lap, 50 ms
 *   4p          four players at 50 / 100 / 150 / 200 ms with jitter
 *   8p          a full grid at mixed latencies
 *   two-rooms   two rooms racing at once: nothing may cross between them
 *   drop        the host disconnects for good mid-race: DNF, host passes on, race ends
 *   rejoin      a player drops mid-race and resumes the seat: same car, laps and Energy
 *   photo       a photo finish inside one tick, ranked by exact crossing time
 *   abilities   Shortcut, Gate Shift and Overdrive in a race: one track state for everyone
 *   session     three races in one room: cars, ready checks, points, the reversed grid
 *   ranking     three rated races: profiles from tickets, one rating for everyone, stored once
 *
 * Network scenarios: each bot reaches the server through a TCP proxy that degrades the link
 * (scripts/netem.ts): latency and jitter, loss stalls, outages, resets.
 *
 *   net-latency     50, 100 and 200 ms round trips with jitter, on the wire
 *   net-loss        3% of chunks stalled ~250 ms (lost and resent), both ways
 *   net-outage      a 3 s outage mid-race: the connection survives, the car coasts, it recovers
 *   net-reset       the connection is reset mid-race: the bot reconnects and resumes its seat
 *   net-timeout     a 20 s outage: the server drops the seat after its ping timeout and grace
 *   net-gate        a player reconnects while a gate shift is pending: same track state as all
 *   net-finished    a player who finished reconnects while the others still race
 *   net-host-lobby  the host drops in the lobby: the role passes on after the grace period
 *
 * Ratings go to a throwaway database: PostgreSQL when TEST_DATABASE_URL is set, else PGlite.
 *
 *   npm run harness -w @circuit-breaker/server            every scenario
 *   npm run harness -w @circuit-breaker/server -- 8p      only the named ones
 *
 * It can also fill a room a browser created on a running server with bots, which then ready
 * up and race whenever the host starts (Ctrl+C to stop):
 *
 *   npm run harness -w @circuit-breaker/server -- --join K7QX2M --bots 7
 *   (options: --url http://127.0.0.1:3001, --rtt 80, --profiles: each bot makes a profile
 *   first, so the races are rated)
 */
import {
  autopilotInput,
  createInput,
  EV,
  packInputFrame,
  RaceSimulation,
  TICK_RATE,
  unpackInputFrame,
  type LeaderboardResponse,
  type PlayerResponse,
  type RaceRating,
  type RaceResults,
  type RaceStartInfo,
} from '@circuit-breaker/shared';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api/http';
import { attachSocketServer } from '../src/net/socketServer';
import { RankingService } from '../src/ranking/service';
import { RankingStore } from '../src/ranking/store';
import { RoomManager } from '../src/rooms/RoomManager';
import { TEST_DATABASES } from '../test/db';
import { Bot, LOCAL_LIMITS, now, sleep, track, type BotOptions } from './bot';
import { NetemProxy, type NetemOptions } from './netem';

const GRACE_MS = 4000;

// --- Checks and helpers ------------------------------------------------------------------------

interface Check {
  ok: boolean;
  label: string;
  detail?: string;
}

const check = (ok: boolean, label: string, detail?: string): Check => ({ ok, label, detail });

async function until(test: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const end = now() + timeoutMs;
  while (!test()) {
    if (now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Waits until the bot's own race clock has run `seconds` past GO. */
const raceSeconds = (b: Bot, seconds: number, timeoutMs = 60_000) =>
  until(
    () => b.race !== null && (b.predictor?.tick ?? 0) > b.race.goTick + seconds * TICK_RATE,
    timeoutMs,
    `${b.name} ${seconds} s into the race`,
  );

const ms = (seconds: number | null | undefined) =>
  seconds === null || seconds === undefined ? 'DNF' : `${seconds.toFixed(3)} s`;

/**
 * Seats every bot in one room (the first creates it), readies the others, sets the laps.
 * `url` is the server, or one address per bot (each through its own bad link).
 */
async function seatRoom(url: string | string[], bots: Bot[], laps: number): Promise<string> {
  const urlOf = (i: number) => (Array.isArray(url) ? url[i] : url);
  const [host, ...guests] = bots;
  await host.connect(urlOf(0));
  const grant = await host.create();
  const code = grant.room.code;
  for (const [i, guest] of guests.entries()) {
    await guest.connect(urlOf(i + 1));
    await guest.join(code);
  }
  for (const guest of guests) {
    const ack = await guest.request(EV.ready, { ready: true, raceId: guest.room?.raceId ?? 0 });
    if (!ack.ok) throw new Error(ack.error);
  }
  const ack = await host.request(EV.laps, { laps });
  if (!ack.ok) throw new Error(ack.error);
  return code;
}

async function startRace(host: Bot, bots: Bot[]): Promise<number> {
  const before = host.race?.raceId ?? 0;
  const ack = await host.request(EV.start, { raceId: host.room?.raceId ?? 0 });
  if (!ack.ok) throw new Error(`start refused: ${ack.error}`);
  await until(() => bots.every((b) => (b.race?.raceId ?? 0) > before), 5000, 'race start');
  return host.race!.raceId;
}

async function finishRace(bots: Bot[], raceId: number, timeoutMs = 150_000): Promise<RaceResults> {
  await until(() => bots.every((b) => b.results?.raceId === raceId), timeoutMs, 'results');
  return bots[0].results!;
}

/** Checks every race should pass: one start for all, one result for all, in a sane order. */
function raceChecks(bots: Bot[], results: RaceResults): Check[] {
  const checks: Check[] = [];
  const first = bots[0].race!;
  checks.push(
    check(
      bots.every((b) => JSON.stringify(b.race) === JSON.stringify(first)),
      'every player got the same start (server timestamp, grid, racers)',
    ),
  );
  const slots = first.racers.map((r) => r.slot);
  checks.push(check(new Set(slots).size === slots.length, 'distinct grid slots', slots.join(',')));
  const same = bots.every((b) => JSON.stringify(b.results) === JSON.stringify(results));
  checks.push(check(same, 'every player got identical results from the server'));
  const finished = results.entries.filter((e) => e.finished);
  const ordered = finished.every(
    (e, i) => i === 0 || (finished[i - 1].totalTime ?? 0) <= (e.totalTime ?? 0),
  );
  const dnfLast = results.entries.every(
    (e, i) => e.finished || results.entries.slice(i).every((x) => !x.finished),
  );
  checks.push(check(ordered && dnfLast, 'results ranked by finish time, DNF last'));
  checks.push(
    check(
      results.entries.every((e, i) => e.position === i + 1),
      'positions 1..n with no gaps or duplicates',
    ),
  );
  return checks;
}

/** The same race run offline with the same bots: identical when no input was ever late. */
function offlineReplay(bots: Bot[], info: RaceStartInfo): Map<string, number | null> {
  const sim = new RaceSimulation(track, { laps: info.laps, startEnergy: info.startEnergy });
  const byId = new Map(bots.map((b) => [b.playerId, b]));
  for (const r of info.racers) sim.addRacer(r.id, r.name, r.slot);
  const inputs = info.racers.map(() => createInput());
  const quantised = createInput();
  while (sim.phase !== 'finished' && sim.tick < 60 * 400) {
    sim.racers.forEach((r, i) => {
      const bot = byId.get(r.id)!;
      const options = r.finished ? { pace: 0.75, racingLine: true } : bot.autopilot;
      const input = autopilotInput(
        track,
        r.vehicle,
        { ...options, course: sim.course, tick: sim.tick },
        inputs[i],
      );
      if (sim.phase === 'countdown') input.throttle = sim.goTick - sim.tick < 15 ? 1 : 0;
      sim.setInput(r.id, unpackInputFrame(packInputFrame(input), quantised));
    });
    sim.step();
    sim.drainEvents();
  }
  return new Map(sim.racers.map((r) => [r.id, r.finishTime]));
}

function determinismCheck(bots: Bot[], results: RaceResults): Check {
  const missed = bots.reduce((sum, b) => sum + b.missed, 0);
  const corrections = bots.reduce((sum, b) => sum + b.corrections, 0);
  if (missed > 0 || corrections > 0) {
    return check(
      true,
      'offline replay comparison skipped',
      `${missed} input ticks guessed by the server, ${corrections} corrections`,
    );
  }
  const offline = offlineReplay(bots, bots[0].race!);
  const exact = results.entries.every((e) => offline.get(e.id) === e.totalTime);
  return check(
    exact,
    'server race is bit-identical to an offline replay of the same inputs',
    exact
      ? undefined
      : results.entries.map((e) => `${e.name} ${e.totalTime} vs ${offline.get(e.id)}`).join('; '),
  );
}

function netSummary(bots: Bot[]): string {
  return bots
    .map(
      (b) =>
        `${b.name} rtt ${b.options.rttMs}±${b.options.jitterMs ?? 0} lead ${b.lead.lead.toFixed(1)} ` +
        `missed ${b.missed} corr ${b.corrections}/${b.maxCorrection.toFixed(2)}m`,
    )
    .join(' | ');
}

function resultSummary(results: RaceResults): string {
  return results.entries.map((e) => `${e.position}. ${e.name} ${ms(e.totalTime)}`).join(', ');
}

// --- Bad links ---------------------------------------------------------------------------------

const proxies = new Set<NetemProxy>();

/** A TCP proxy in front of the server that degrades the link (see netem.ts); its address. */
async function badLink(
  url: string,
  options: Partial<NetemOptions>,
): Promise<{ proxy: NetemProxy; url: string }> {
  const target = new URL(url);
  const proxy = new NetemProxy({ host: target.hostname, port: Number(target.port) }, options);
  proxies.add(proxy);
  return { proxy, url: `http://127.0.0.1:${await proxy.listen()}` };
}

/** After a reset or a timeout: a new connection through the same link, and the seat back. */
async function reconnect(b: Bot, url: string): Promise<boolean> {
  b.drop();
  await b.connect(url);
  try {
    await b.resume();
    return true;
  } catch {
    return false;
  }
}

/** How the remote cars were drawn: share of frames that were smooth, and any stop. */
function remoteSummary(bots: Bot[]): string {
  return bots
    .map((b) => {
      const f = b.remoteFrames;
      const total = f.interpolated + f.extrapolated + f.held;
      const pct = (n: number) => ((n / Math.max(1, total)) * 100).toFixed(2);
      return `${b.name} ${pct(f.interpolated)}% interpolated, ${pct(f.extrapolated)}% extrapolated, ${pct(f.held)}% held (${total} car-frames)`;
    })
    .join(' | ');
}

const smoothShare = (b: Bot) => {
  const f = b.remoteFrames;
  return f.interpolated / Math.max(1, f.interpolated + f.extrapolated + f.held);
};

// --- Scenarios ---------------------------------------------------------------------------------

interface Scenario {
  name: string;
  run(url: string, manager: RoomManager, ranking: RankingService): Promise<Check[]>;
}

const all = new Set<Bot>();
const bot = (name: string, options: BotOptions) => {
  const b = new Bot(name, options);
  all.add(b);
  return b;
};

/** A plain race: n bots, given latencies, one lap; the results and sync are checked. */
function plainRace(name: string, makeBots: () => Bot[]): Scenario {
  return {
    name,
    async run(url) {
      const bots = makeBots();
      await seatRoom(url, bots, 1);
      const raceId = await startRace(bots[0], bots);
      const results = await finishRace(bots, raceId);
      const checks = raceChecks(bots, results);
      checks.push(
        check(
          results.entries.every((e) => e.finished),
          'every car finished',
        ),
      );
      checks.push(
        check(
          bots.every((b) => b.maxCorrection < 2),
          'prediction corrections stay small (< 2 m)',
          netSummary(bots),
        ),
      );
      checks.push(determinismCheck(bots, results));
      checks.push(check(true, 'results', resultSummary(results)));
      return checks;
    },
  };
}

const lanes = [0, 0.6, -0.6, 1.2, -1.2, 0.3, -0.3, 0.9];
const SCENARIOS: Scenario[] = [
  plainRace('2p', () => [
    bot('Ana', { rttMs: 50, jitterMs: 10 }),
    bot('Ben', { rttMs: 50, jitterMs: 10 }),
  ]),
  plainRace('4p', () =>
    [50, 100, 150, 200].map((rtt, i) =>
      bot(`Q${i + 1}`, {
        rttMs: rtt,
        jitterMs: 20,
        autopilot: { boost: true, racingLine: true, pace: 1 - i * 0.012, lane: lanes[i] },
      }),
    ),
  ),
  plainRace('8p', () =>
    [20, 50, 80, 110, 140, 170, 200, 60].map((rtt, i) =>
      bot(`G${i + 1}`, {
        rttMs: rtt,
        jitterMs: 20,
        autopilot: { boost: true, racingLine: true, pace: 1 - (i % 4) * 0.012, lane: lanes[i] },
      }),
    ),
  ),
  {
    name: 'two-rooms',
    async run(url) {
      const red = [0, 1, 2].map((i) => bot(`Red${i + 1}`, { rttMs: 60, jitterMs: 10 }));
      const blue = [0, 1, 2].map((i) => bot(`Blue${i + 1}`, { rttMs: 90, jitterMs: 10 }));
      const [redCode, blueCode] = await Promise.all([
        seatRoom(url, red, 1),
        seatRoom(url, blue, 1),
      ]);
      const [redRace, blueRace] = await Promise.all([
        startRace(red[0], red),
        startRace(blue[0], blue),
      ]);
      const [redResults, blueResults] = await Promise.all([
        finishRace(red, redRace),
        finishRace(blue, blueRace),
      ]);
      const redIds = new Set(red.map((b) => b.playerId));
      const blueIds = new Set(blue.map((b) => b.playerId));
      const leak = (bots: Bot[], other: Set<string>) =>
        bots.some((b) => [...b.seenIds].some((id) => other.has(id)));
      return [
        check(redCode !== blueCode, 'two different room codes', `${redCode} / ${blueCode}`),
        ...raceChecks(red, redResults),
        ...raceChecks(blue, blueResults),
        check(
          !leak(red, blueIds) && !leak(blue, redIds),
          'no player id, row or event from one room ever reached the other',
        ),
        check(
          red.every((b) => b.maxRows === 3) && blue.every((b) => b.maxRows === 3),
          'snapshots carry only the room’s own three cars',
        ),
        check(true, 'results', `${resultSummary(redResults)} || ${resultSummary(blueResults)}`),
      ];
    },
  },
  {
    name: 'drop',
    async run(url, manager) {
      const bots = ['Hal', 'Ivy', 'Jo'].map((n) => bot(n, { rttMs: 80, jitterMs: 20 }));
      const [host, ivy, jo] = bots;
      const code = await seatRoom(url, bots, 1);
      const raceId = await startRace(host, bots);
      await raceSeconds(host, 12);
      host.drop();
      await until(
        () => ivy.room?.players.some((p) => p.id === host.playerId && !p.connected) ?? false,
        3000,
        'the drop to show',
      );
      const shownDropped = true;
      await until(() => ivy.room?.hostId === ivy.playerId, GRACE_MS + 3000, 'host to pass on');
      const remaining = bots.slice(1);
      const results = await finishRace(remaining, raceId);
      const hostEntry = results.entries.find((e) => e.id === host.playerId);
      const checks = [
        check(shownDropped, 'others see the dropped player as disconnected at once'),
        check(
          ivy.room?.hostId === ivy.playerId &&
            !ivy.room.players.some((p) => p.id === host.playerId),
          'after the grace period the seat is gone and the host role passed to the next player',
        ),
        check(
          hostEntry !== undefined && hostEntry.dnf && hostEntry.position === results.entries.length,
          'the dropped car is ranked last as DNF',
          hostEntry
            ? `${hostEntry.name}: dnf ${hostEntry.dnf}, position ${hostEntry.position}`
            : 'missing',
        ),
        check(
          results.entries.filter((e) => e.id !== host.playerId).every((e) => e.finished),
          'everyone else finished',
        ),
        ...raceChecks(remaining, results),
      ];
      // The new host races again: only the two connected players are on the grid (the
      // other one says it is ready first; the host's own request counts as ready).
      await jo.request(EV.ready, { ready: true, raceId: jo.room?.raceId ?? 0 });
      const again = await ivy.request(EV.restart, { raceId: ivy.room?.raceId ?? 0 });
      checks.push(check(again.ok, 'the new host can start the next race'));
      await until(() => remaining.every((b) => (b.race?.raceId ?? 0) > raceId), 5000, 'race 2');
      checks.push(
        check(
          ivy.race!.racers.length === 2 && jo.race!.racers.length === 2,
          'race 2 has only the connected players',
        ),
      );
      checks.push(
        check(manager.rooms.get(code)?.seats.length === 2, 'the room has two seats left'),
      );
      checks.push(check(true, 'results', resultSummary(results)));
      return checks;
    },
  },
  {
    name: 'rejoin',
    async run(url, manager) {
      const bots = ['Kai', 'Lux', 'Max'].map((n) => bot(n, { rttMs: 70, jitterMs: 20 }));
      const [, lux] = bots;
      const code = await seatRoom(url, bots, 1);
      const raceId = await startRace(bots[0], bots);
      await raceSeconds(lux, 14);
      const room = manager.rooms.get(code)!;
      const state = () => {
        const r = room.currentRace!.sim.getRacer(lux.playerId)!;
        return {
          lap: r.lap,
          checkpoint: r.nextCheckpoint,
          energy: r.vehicle.energy,
          s: r.vehicle.trackS,
        };
      };
      const before = state();
      lux.drop();
      await sleep(1500);
      await lux.connect(url);
      const startsBefore = lux.raceStarts;
      const away = state();
      const grant = await lux.resume();
      const after = state();
      await until(() => lux.raceStarts > startsBefore, 3000, 'race re-sent after resume');
      const results = await finishRace(bots, raceId);
      const entry = results.entries.find((e) => e.id === lux.playerId);
      return [
        check(grant.playerId === lux.playerId, 'the token resumed the same seat and player id'),
        check(
          room.seats.length === 3 && room.currentRace!.sim.racers.length === 3 && lux.maxRows === 3,
          'no duplicate seat, car or row',
        ),
        check(
          after.lap === away.lap && after.checkpoint === away.checkpoint && away.lap >= before.lap,
          'laps and checkpoints kept through the drop and the resume',
          `before lap ${before.lap} gate ${before.checkpoint}, at resume lap ${after.lap} gate ${after.checkpoint}`,
        ),
        check(
          after.energy >= away.energy - 1e-9,
          'Energy kept through the resume (no reset)',
          `before drop ${before.energy.toFixed(1)}, before resume ${away.energy.toFixed(1)}, after ${after.energy.toFixed(1)}`,
        ),
        check(
          away.s > before.s,
          'the car kept rolling on the server while its player was away',
          `${before.s.toFixed(0)} m → ${away.s.toFixed(0)} m`,
        ),
        check(
          entry?.finished === true,
          'the resumed player finished the race',
          ms(entry?.totalTime),
        ),
        ...raceChecks(bots, results),
        check(true, 'results', resultSummary(results)),
      ];
    },
  },
  {
    name: 'abilities',
    async run(url, manager) {
      // Ana opens the shortcut and takes it; Ben shifts the gate; Cy fires Overdrive and also
      // takes the shortcut if it is open when it gets there.
      const bots = [
        // Ana and Ben save their Energy for their abilities (no boost bursts).
        bot('Ana', {
          rttMs: 60,
          jitterMs: 10,
          abilities: { shortcut: true },
          autopilot: { racingLine: true },
        }),
        bot('Ben', {
          rttMs: 150,
          jitterMs: 20,
          abilities: { gate: true },
          autopilot: { racingLine: true },
        }),
        bot('Cy', { rttMs: 100, jitterMs: 20, abilities: { overdrive: true, shortcut: false } }),
      ];
      const code = await seatRoom(url, bots, 1);
      const raceId = await startRace(bots[0], bots);
      const results = await finishRace(bots, raceId);
      const sim = manager.rooms.get(code)!.currentRace!.sim;
      const statsOf = (b: Bot) => sim.getRacer(b.playerId)!.stats;
      // Every snapshot tick two bots both received carried the same track state.
      let compared = 0;
      let differing = 0;
      for (const [t, k] of bots[0].courseByTick) {
        for (const other of bots.slice(1)) {
          const theirs = other.courseByTick.get(t);
          if (theirs === undefined) continue;
          compared++;
          if (theirs !== k) differing++;
        }
      }
      const used = results.abilities.filter((a) => a.ok).map((a) => `${a.name}:${a.ability}`);
      const publicEvents = (b: Bot) =>
        b.abilityEvents
          .filter((e) => e.type === 'ability')
          .map((e) => e.tick)
          .join(',');
      return [
        ...raceChecks(bots, results),
        check(
          results.entries.every((e) => e.finished),
          'every car finished',
        ),
        check(
          used.sort().join(' ') === 'Ana:shortcut Ben:gate Cy:overdrive',
          'each ability worked once, as the server recorded it',
          used.join(', '),
        ),
        check(
          statsOf(bots[0]).shortcutRuns === 1,
          'the player who opened the shortcut drove through it',
        ),
        check(
          compared > 100 && differing === 0,
          'every player got the same track state at every tick',
          `${compared} snapshot pairs compared, ${differing} differed`,
        ),
        check(
          new Set(bots.map(publicEvents)).size === 1,
          'every player was told about every ability, at the same server tick',
        ),
        check(
          bots.every((b) => b.maxCorrection < 2),
          'prediction corrections stay small (< 2 m)',
          netSummary(bots),
        ),
        check(true, 'results', resultSummary(results)),
      ];
    },
  },
  {
    name: 'session',
    async run(url, manager) {
      // Three races in one room: cars picked in the lobby, a ready check before each next
      // race, points added once per race, the grid reversed by the standings, stale requests
      // refused, and finally a new session.
      const bots = [
        bot('Ana', { rttMs: 50, jitterMs: 10, autopilot: { boost: true, racingLine: true } }),
        bot('Ben', {
          rttMs: 90,
          jitterMs: 15,
          autopilot: { boost: true, racingLine: true, pace: 0.97, lane: 0.6 },
        }),
        bot('Cy', {
          rttMs: 130,
          jitterMs: 20,
          autopilot: { boost: true, racingLine: true, pace: 0.94, lane: -0.6 },
        }),
      ];
      const [ana, ben, cy] = bots;
      const code = await seatRoom(url, bots, 1);
      const checks: Check[] = [];
      const room = () => manager.rooms.get(code)!;

      // Cars: Ben picks violet "Apex"; Cy may not take Ana's colour, nor a style that does not
      // exist, and gets the white "Brute" instead.
      const picked = await ben.request(EV.vehicle, { color: 4, style: 1 });
      const taken = await cy.request(EV.vehicle, { color: ana.room!.players[0].color, style: 0 });
      const invalid = await cy.request(EV.vehicle, { color: 6, style: 9 });
      const cyPick = await cy.request(EV.vehicle, { color: 6, style: 2 });
      checks.push(
        check(
          picked.ok && !taken.ok && !invalid.ok && cyPick.ok,
          'car choices are checked by the server (taken colour and unknown style refused)',
          `${taken.ok ? '' : taken.error} / ${invalid.ok ? '' : invalid.error}`,
        ),
      );

      const results: RaceResults[] = [];
      const grids: string[] = [];
      for (let n = 1; n <= 3; n++) {
        let raceId: number;
        if (n === 1) raceId = await startRace(ana, bots);
        else {
          // A ready check before the next race; the host's own request counts as ready.
          const stale = await ana.request(EV.restart, { raceId: (ana.room?.raceId ?? 1) - 1 });
          for (const b of [ben, cy]) {
            const ack = await b.request(EV.ready, { ready: true, raceId: b.room?.raceId ?? 0 });
            if (!ack.ok) throw new Error(ack.error);
          }
          await until(
            () => bots.every((b) => b.room?.players.filter((p) => p.ready).length === 2),
            5000,
            'everyone to see the ready check',
          );
          const before = ana.race?.raceId ?? 0;
          const go = await ana.request(EV.restart, { raceId: ana.room?.raceId ?? 0 });
          const twice = await ana.request(EV.restart, { raceId: before });
          checks.push(
            check(
              !stale.ok && go.ok && !twice.ok,
              `race ${n}: started once from the results (a stale and a repeated request refused)`,
              `${stale.ok ? '' : stale.error} / ${twice.ok ? '' : twice.error}`,
            ),
          );
          await until(() => bots.every((b) => (b.race?.raceId ?? 0) > before), 5000, `race ${n}`);
          raceId = ana.race!.raceId;
        }
        grids.push(ana.race!.racers.map((r) => r.name).join(','));
        const result = await finishRace(bots, raceId);
        results.push(result);
        checks.push(
          ...raceChecks(bots, result).map((c) => ({ ...c, label: `race ${n}: ${c.label}` })),
          check(
            result.entries.every((e) => e.finished),
            `race ${n}: every car finished`,
          ),
        );
      }

      // The cars chosen in the lobby went into every race.
      const carsOk = results.every((r) => {
        const e = (name: string) => r.entries.find((x) => x.name === name)!;
        return (
          e('Ben').color === 4 && e('Ben').style === 1 && e('Cy').color === 6 && e('Cy').style === 2
        );
      });
      checks.push(check(carsOk, 'every race used the cars picked in the lobby'));

      // Points: the table by position, added once per race, the same on every screen.
      const table = [100, 80, 65];
      const pointsOk = results.every((r) =>
        r.entries.every((e) => e.points === (e.finished ? table[e.position - 1] : 0)),
      );
      const totals = new Map<string, number>();
      for (const r of results)
        for (const e of r.entries) totals.set(e.id, (totals.get(e.id) ?? 0) + e.points);
      const last = results[2];
      const cumulativeOk = last.entries.every((e) => e.sessionPoints === totals.get(e.id));
      const roomOk = room().seats.every((s) => s.points === totals.get(s.id) && s.races === 3);
      const statesAgree = bots.every(
        (b) =>
          JSON.stringify(b.room?.players.map((p) => [p.id, p.points, p.rank])) ===
          JSON.stringify(ana.room?.players.map((p) => [p.id, p.points, p.rank])),
      );
      checks.push(check(pointsOk, 'race points follow the table (DNF scores 0)'));
      checks.push(
        check(
          cumulativeOk && roomOk && statesAgree,
          'session points add up over the three races, once each, the same for every player',
          last.entries.map((e) => `${e.name} ${e.sessionPoints} (#${e.sessionRank})`).join(', '),
        ),
      );
      checks.push(
        check(
          results.map((r) => r.raceNumber).join(',') === '1,2,3' && room().sessionRaces === 3,
          'races numbered 1, 2, 3 in the session',
        ),
      );
      // The grid: join order first, then the reverse of the standings after each race (fewest
      // points at the front; equal points: fewer wins, then join order).
      const joinOrder = new Map(bots.map((b, i) => [b.name, i]));
      const expectedGrid = (upTo: number) => {
        const wins = new Map<string, number>();
        for (const r of results.slice(0, upTo)) {
          const winner = r.entries.find((e) => e.position === 1 && e.finished);
          if (winner) wins.set(winner.name, (wins.get(winner.name) ?? 0) + 1);
        }
        return [...results[upTo - 1].entries]
          .sort(
            (a, b) =>
              a.sessionPoints - b.sessionPoints ||
              (wins.get(a.name) ?? 0) - (wins.get(b.name) ?? 0) ||
              joinOrder.get(a.name)! - joinOrder.get(b.name)!,
          )
          .map((e) => e.name)
          .join(',');
      };
      const gridOk =
        grids[0] === 'Ana,Ben,Cy' && grids[1] === expectedGrid(1) && grids[2] === expectedGrid(2);
      checks.push(
        check(gridOk, 'grid: join order, then the reversed standings', grids.join(' | ')),
      );
      checks.push(
        check(
          bots.every((b) => b.staleMessages === 0),
          'no snapshot or event from another race reached a player',
        ),
      );

      // Back to the lobby and a new session: everyone at zero again.
      const lobby = await ana.request(EV.toLobby, { raceId: ana.room?.raceId ?? 0 });
      const fresh = await ana.request(EV.newSession);
      await until(() => bots.every((b) => b.room?.sessionId === 2), 5000, 'the new session');
      checks.push(
        check(
          lobby.ok && fresh.ok && bots.every((b) => b.room!.players.every((p) => p.points === 0)),
          'a new session starts everyone from zero',
        ),
      );
      checks.push(check(true, 'results', results.map(resultSummary).join(' || ')));
      return checks;
    },
  },
  {
    name: 'ranking',
    async run(url, _manager, ranking) {
      // Three players with profiles and one without race three times in a room. The server
      // rates every race once; every player hears the same rating, after "pending"; the
      // leaderboard and the profiles agree with what the rooms were told.
      const bots = [
        bot('Ana', { rttMs: 40, jitterMs: 10, autopilot: { boost: true, racingLine: true } }),
        bot('Ben', {
          rttMs: 90,
          jitterMs: 15,
          autopilot: { boost: true, racingLine: true, pace: 0.97, lane: 0.6 },
        }),
        bot('Cy', {
          rttMs: 140,
          jitterMs: 20,
          autopilot: { boost: true, racingLine: true, pace: 0.94, lane: -0.6 },
        }),
        bot('Dee', {
          rttMs: 60,
          jitterMs: 10,
          autopilot: { boost: true, racingLine: true, pace: 0.9, lane: 1.2 },
        }),
      ];
      const [ana, ben, cy, dee] = bots;
      for (const b of [ana, ben, cy]) await b.profile(url);
      await seatRoom(url, bots, 1);
      const checks: Check[] = [];
      const seats = ana.room!.players.map((p) => [p.name, p.profileId]);
      checks.push(
        check(
          ana.room!.ranking &&
            JSON.stringify(seats) ===
              JSON.stringify([
                ['Ana', ana.profileId],
                ['Ben', ben.profileId],
                ['Cy', cy.profileId],
                ['Dee', null],
              ]),
          'seats carry the profiles their tickets were issued for (none for Dee)',
        ),
      );
      const rated: RaceRating[] = [];
      for (let n = 1; n <= 3; n++) {
        let raceId: number;
        if (n === 1) raceId = await startRace(ana, bots);
        else {
          for (const b of [ben, cy, dee]) {
            const ack = await b.request(EV.ready, { ready: true, raceId: b.room?.raceId ?? 0 });
            if (!ack.ok) throw new Error(ack.error);
          }
          await until(
            () => bots.every((b) => b.room?.players.filter((p) => p.ready).length === 3),
            5000,
            'the ready check',
          );
          const before = ana.race?.raceId ?? 0;
          const go = await ana.request(EV.restart, { raceId: ana.room?.raceId ?? 0 });
          if (!go.ok) throw new Error(go.error);
          await until(() => bots.every((b) => (b.race?.raceId ?? 0) > before), 5000, `race ${n}`);
          raceId = ana.race!.raceId;
        }
        const result = await finishRace(bots, raceId);
        checks.push(
          check(
            result.entries.every((e) => e.finished),
            `race ${n}: every car finished`,
          ),
        );
        await until(
          () =>
            bots.every((b) => b.ratings.some((r) => r.raceId === raceId && r.status === 'rated')),
          15_000,
          `race ${n}'s rating`,
        );
        const heard = bots.map((b) => b.ratings.filter((r) => r.raceId === raceId));
        const last = heard[0].at(-1)!;
        checks.push(
          check(
            heard.every((h) => h.map((r) => r.status).join() === 'pending,rated'),
            `race ${n}: every player heard "pending", then the saved rating, and nothing else`,
            heard.map((h) => h.map((r) => r.status).join('>')).join(' | '),
          ),
        );
        checks.push(
          check(
            heard.every((h) => JSON.stringify(h.at(-1)) === JSON.stringify(last)),
            `race ${n}: the same rating for every player`,
          ),
        );
        checks.push(
          check(
            last.entries.length === 3 &&
              JSON.stringify(last.unrated) ===
                JSON.stringify([{ id: dee.playerId, reason: 'No profile' }]),
            `race ${n}: three profiles rated; the car without one listed as unrated`,
            last.entries
              .map(
                (e) =>
                  `${e.profileId.slice(0, 4)} ${e.before}${e.delta >= 0 ? '+' : ''}${e.delta}=${e.after} #${e.rank}`,
              )
              .join(', '),
          ),
        );
        rated.push(last);
      }
      // What the rooms were told is what the database holds: one row per race and player,
      // each race starting from the rating the one before it left.
      const board = (await (
        await fetch(`${url}/api/leaderboard?offset=0&limit=10`)
      ).json()) as LeaderboardResponse;
      checks.push(
        check(
          board.total === 3 && board.entries.every((e) => e.races === 3),
          'the leaderboard lists the three profiles with three races each (each race applied once)',
          board.entries.map((e) => `#${e.rank} ${e.nickname} ${e.rating}`).join(', '),
        ),
      );
      let chained = true;
      for (const b of [ana, ben, cy]) {
        const steps = rated.map((r) => r.entries.find((e) => e.profileId === b.profileId)!);
        for (let i = 1; i < steps.length; i++) chained &&= steps[i].before === steps[i - 1].after;
        const page = (await (
          await fetch(`${url}/api/players/${b.profileId}`)
        ).json()) as PlayerResponse;
        chained &&= page.player.rating === steps.at(-1)!.after && page.recent.length === 3;
      }
      checks.push(
        check(chained, "each profile's rating follows its races, as the rooms were told"),
      );
      checks.push(check(ranking.pending === 0, 'no rating left waiting for the database'));
      return checks;
    },
  },
  {
    name: 'net-latency',
    async run(url) {
      // Real latency on the wire (TCP), not in the bot: 25, 50 and 100 ms each way plus jitter.
      const links = await Promise.all(
        [25, 50, 100].map((oneWay) => badLink(url, { latencyMs: oneWay, jitterMs: 10 })),
      );
      const bots = [50, 100, 200].map((rtt, i) =>
        bot(`Rtt${rtt}`, {
          rttMs: 0,
          remoteView: true,
          autopilot: { boost: true, racingLine: true, pace: 1 - i * 0.012, lane: lanes[i] },
        }),
      );
      await seatRoom(
        links.map((l) => l.url),
        bots,
        1,
      );
      const raceId = await startRace(bots[0], bots);
      const results = await finishRace(bots, raceId);
      const measured = bots
        .map(
          (b) =>
            `${b.name}: measured rtt ${b.clock.rtt.toFixed(0)} ms, lead ${b.lead.lead.toFixed(1)} ticks`,
        )
        .join('; ');
      return [
        ...raceChecks(bots, results),
        check(
          results.entries.every((e) => e.finished),
          'every car finished',
        ),
        check(
          bots.every((b) => b.maxCorrection < 2),
          'own-car prediction corrections stay small (< 2 m)',
          netSummary(bots),
        ),
        check(
          bots.every((b) => smoothShare(b) > 0.99 && b.remoteFrames.held === 0),
          'remote cars drawn between two snapshots in over 99% of frames, never stopped',
          remoteSummary(bots),
        ),
        check(true, 'round trips as the clients measured them', measured),
        determinismCheck(bots, results),
      ];
    },
  },
  {
    name: 'net-loss',
    async run(url) {
      // 3% of chunks are held ~250 ms (a lost packet, resent), and everything behind waits.
      const links = await Promise.all(
        [0, 1, 2].map(() =>
          badLink(url, { latencyMs: 30, jitterMs: 5, loss: 0.03, lossStallMs: 250 }),
        ),
      );
      const bots = ['Ana', 'Ben', 'Cy'].map((n, i) =>
        bot(`Loss${n}`, {
          rttMs: 0,
          remoteView: true,
          autopilot: { boost: true, racingLine: true, pace: 1 - i * 0.012, lane: lanes[i] },
        }),
      );
      await seatRoom(
        links.map((l) => l.url),
        bots,
        1,
      );
      const raceId = await startRace(bots[0], bots);
      const results = await finishRace(bots, raceId);
      return [
        ...raceChecks(bots, results),
        check(
          results.entries.every((e) => e.finished),
          'every car finished',
        ),
        check(
          bots.every((b) => b.socket?.connected === true),
          'no connection dropped (stalls are not disconnects)',
        ),
        check(
          bots.every((b) => b.maxCorrection < 6),
          'corrections stay under the snap distance (6 m): smoothed, never a jump',
          netSummary(bots),
        ),
        check(
          bots.every((b) => b.remoteFrames.held / Math.max(1, b.remoteFrames.interpolated) < 0.02),
          'remote cars kept moving: stopped (held) in under 2% of frames, the rest smooth or guessed',
          remoteSummary(bots),
        ),
      ];
    },
  },
  {
    name: 'net-outage',
    async run(url, manager) {
      const links = await Promise.all(
        [0, 1, 2].map(() => badLink(url, { latencyMs: 25, jitterMs: 5 })),
      );
      const bots = ['Ona', 'Pip', 'Quin'].map((n, i) =>
        bot(n, {
          rttMs: 0,
          autopilot: { boost: true, racingLine: true, pace: 1 - i * 0.012, lane: lanes[i] },
        }),
      );
      const [, pip] = bots;
      const code = await seatRoom(
        links.map((l) => l.url),
        bots,
        1,
      );
      const raceId = await startRace(bots[0], bots);
      await raceSeconds(pip, 12);
      const room = manager.rooms.get(code)!;
      const racer = () => room.currentRace!.sim.getRacer(pip.playerId)!;
      const seenOffline = { yes: false };
      const watch = setInterval(() => {
        if (bots[0].room?.players.some((p) => p.id === pip.playerId && !p.connected))
          seenOffline.yes = true;
      }, 50);
      const before = { lap: racer().lap, gate: racer().nextCheckpoint, s: racer().vehicle.trackS };
      links[1].proxy.outage(3000);
      await sleep(1500);
      const during = { throttle: racer().input.throttle, missed: pip.missed };
      await sleep(2500);
      clearInterval(watch);
      const after = { lap: racer().lap, gate: racer().nextCheckpoint };
      const results = await finishRace(bots, raceId);
      const entry = results.entries.find((e) => e.id === pip.playerId);
      return [
        check(
          pip.socket?.connected === true && !seenOffline.yes,
          'a 3 s outage is not a disconnect: the seat stayed connected',
        ),
        check(
          during.throttle === 0,
          'with no input arriving, the server stopped repeating the last one and the car coasted',
        ),
        check(
          after.lap > before.lap || (after.lap === before.lap && after.gate >= before.gate),
          'no lap or checkpoint was lost while the link was down',
          `lap ${before.lap} gate ${before.gate} → lap ${after.lap} gate ${after.gate}`,
        ),
        check(
          entry?.finished === true,
          'the player recovered (re-based on the next snapshot) and finished',
          `${ms(entry?.totalTime)}; ${netSummary([pip])}`,
        ),
        ...raceChecks(bots, results),
      ];
    },
  },
  {
    name: 'net-reset',
    async run(url, manager) {
      const links = await Promise.all(
        [0, 1, 2].map(() => badLink(url, { latencyMs: 30, jitterMs: 5 })),
      );
      const bots = ['Rae', 'Sol', 'Tam'].map((n, i) =>
        bot(n, {
          rttMs: 0,
          autopilot: { boost: true, racingLine: true, pace: 1 - i * 0.012, lane: lanes[i] },
        }),
      );
      const [, sol] = bots;
      const code = await seatRoom(
        links.map((l) => l.url),
        bots,
        1,
      );
      const raceId = await startRace(bots[0], bots);
      await raceSeconds(sol, 14);
      const room = manager.rooms.get(code)!;
      const state = () => {
        const r = room.currentRace!.sim.getRacer(sol.playerId)!;
        return { lap: r.lap, gate: r.nextCheckpoint, energy: r.vehicle.energy, id: r.id };
      };
      const before = state();
      // A reset: both ends see the connection die at once (a network change).
      links[1].proxy.cut();
      await until(() => sol.socket?.connected !== true, 3000, 'the reset to reach the bot');
      await until(
        () => bots[0].room?.players.some((p) => p.id === sol.playerId && !p.connected) ?? false,
        3000,
        'others to see the drop',
      );
      await sleep(1000);
      const startsBefore = sol.raceStarts;
      const resumed = await reconnect(sol, links[1].url);
      const after = state();
      await until(() => sol.raceStarts > startsBefore, 3000, 'the race re-sent after the resume');
      const results = await finishRace(bots, raceId);
      return [
        check(resumed, 'the bot reconnected and resumed its seat with its token'),
        check(
          after.id === before.id && room.seats.length === 3 && sol.maxRows === 3,
          'the same car and seat: no duplicate',
        ),
        check(
          after.lap >= before.lap && after.energy >= 0,
          'laps and checkpoints kept through the reset',
          `lap ${before.lap} gate ${before.gate} → lap ${after.lap} gate ${after.gate}`,
        ),
        check(
          results.entries.find((e) => e.id === sol.playerId)?.finished === true,
          'the player finished the race after resuming',
        ),
        ...raceChecks(bots, results),
      ];
    },
  },
  {
    name: 'net-timeout',
    async run(url, manager) {
      const links = await Promise.all(
        [0, 1, 2].map(() => badLink(url, { latencyMs: 25, jitterMs: 5 })),
      );
      const bots = ['Uma', 'Vik', 'Wes'].map((n, i) =>
        bot(n, {
          rttMs: 0,
          autopilot: { boost: true, racingLine: true, pace: 1 - i * 0.012, lane: lanes[i] },
        }),
      );
      const [uma, vik] = bots;
      const code = await seatRoom(
        links.map((l) => l.url),
        bots,
        1,
      );
      const raceId = await startRace(uma, bots);
      await raceSeconds(vik, 6);
      // 20 s without a byte: past the server's ping timeout (13 s) and the harness grace (4 s).
      const started = now();
      links[1].proxy.outage(20_000);
      await until(
        () => uma.room?.players.some((p) => p.id === vik.playerId && !p.connected) ?? false,
        16_000,
        'the server to time the connection out',
      );
      const detected = (now() - started) / 1000;
      await until(
        () => !(uma.room?.players.some((p) => p.id === vik.playerId) ?? true),
        GRACE_MS + 3000,
        'the seat to be given up after the grace period',
      );
      const results = await finishRace([uma, bots[2]], raceId);
      const entry = results.entries.find((e) => e.id === vik.playerId);
      await until(() => now() - started > 20_500, 5000, 'the outage to end');
      await until(() => vik.socket?.connected !== true, 15_000, 'the bot to notice');
      const resumed = await reconnect(vik, links[1].url);
      return [
        check(
          detected > 8 && detected < 15,
          'the server noticed the silent connection by its ping timeout',
          `${detected.toFixed(1)} s`,
        ),
        check(
          entry?.dnf === true && entry.dnfReason === 'left' && entry.position === 3,
          'after the grace period the car retired: DNF (left), last',
          entry ? `${entry.name}: ${entry.dnfReason}, P${entry.position}` : 'missing',
        ),
        check(!resumed, 'the token no longer resumes the seat (it expired)'),
        check(manager.rooms.get(code)?.seats.length === 2, 'the room kept the other two seats'),
        ...raceChecks([uma, bots[2]], results),
      ];
    },
  },
  {
    name: 'net-gate',
    async run(url, manager) {
      const links = await Promise.all(
        [0, 1, 2].map(() => badLink(url, { latencyMs: 40, jitterMs: 10 })),
      );
      const bots = [
        bot('Gia', { rttMs: 0, autopilot: { racingLine: true } }),
        bot('Hux', { rttMs: 0, abilities: { gate: true }, autopilot: { racingLine: true } }),
        bot('Ike', { rttMs: 0, autopilot: { boost: true, racingLine: true, lane: 0.6 } }),
      ];
      const [gia, hux, ike] = bots;
      const code = await seatRoom(
        links.map((l) => l.url),
        bots,
        1,
      );
      const raceId = await startRace(gia, bots);
      const room = manager.rooms.get(code)!;
      const course = () => room.currentRace!.sim.course;
      await until(() => course().gateSwitchTick >= 0, 30_000, 'the gate shift warning');
      const switchTick = course().gateSwitchTick;
      // Ike's connection resets during the warning; it is back before the gate moves.
      links[2].proxy.cut();
      await until(() => ike.socket?.connected !== true, 3000, 'the reset');
      await sleep(400);
      const resumed = await reconnect(ike, links[2].url);
      const resumedAt = room.currentRace!.sim.tick;
      const results = await finishRace(bots, raceId);
      let compared = 0;
      let differing = 0;
      for (const [t, k] of ike.courseByTick) {
        if (t <= resumedAt) continue;
        for (const other of [gia, hux]) {
          const theirs = other.courseByTick.get(t);
          if (theirs === undefined) continue;
          compared++;
          if (theirs !== k) differing++;
        }
      }
      return [
        check(
          resumed && resumedAt < switchTick,
          'resumed during the warning, before the switch',
          `resumed at tick ${resumedAt}, switch at ${switchTick}`,
        ),
        check(
          compared > 50 && differing === 0,
          'after the resume, the same track state as everyone at every tick',
          `${compared} snapshot pairs compared, ${differing} differed`,
        ),
        check(
          results.abilities.filter((a) => a.ok && a.ability === 'gate').length === 1,
          'the gate shift happened once',
        ),
        ...raceChecks(bots, results),
      ];
    },
  },
  {
    name: 'net-finished',
    async run(url, manager) {
      const links = await Promise.all(
        [0, 1, 2].map(() => badLink(url, { latencyMs: 30, jitterMs: 5 })),
      );
      const bots = [
        bot('Fast', { rttMs: 0, autopilot: { boost: true, racingLine: true } }),
        bot('Mid', {
          rttMs: 0,
          autopilot: { boost: true, racingLine: true, pace: 0.9, lane: 0.6 },
        }),
        bot('Slow', { rttMs: 0, autopilot: { racingLine: true, pace: 0.8, lane: -0.6 } }),
      ];
      const [fast] = bots;
      const code = await seatRoom(
        links.map((l) => l.url),
        bots,
        1,
      );
      const raceId = await startRace(fast, bots);
      const room = manager.rooms.get(code)!;
      await until(
        () => room.currentRace?.sim.getRacer(fast.playerId)?.finished === true,
        120_000,
        'the first finish',
      );
      const time = room.currentRace!.sim.getRacer(fast.playerId)!.finishTime;
      links[0].proxy.cut();
      await until(() => fast.socket?.connected !== true, 3000, 'the reset');
      const startsBefore = fast.raceStarts;
      const resumed = await reconnect(fast, links[0].url);
      await until(() => fast.raceStarts > startsBefore, 3000, 'the race re-sent');
      const results = await finishRace(bots, raceId);
      const entry = results.entries.find((e) => e.id === fast.playerId)!;
      return [
        check(
          resumed && room.currentRace!.results !== null,
          'resumed after finishing, while the others raced on',
        ),
        check(
          entry.position === 1 && entry.finished && entry.totalTime === time,
          'the finish stood: first place, the same time',
          `${ms(time)} before, ${ms(entry.totalTime)} in the results`,
        ),
        ...raceChecks(bots, results),
      ];
    },
  },
  {
    name: 'net-host-lobby',
    async run(url) {
      const links = await Promise.all([0, 1, 2].map(() => badLink(url, { latencyMs: 20 })));
      const bots = ['Host', 'Gus', 'Hal'].map((n) => bot(`Lobby${n}`, { rttMs: 0 }));
      const [host, gus, hal] = bots;
      await seatRoom(
        links.map((l) => l.url),
        bots,
        1,
      );
      links[0].proxy.cut();
      await until(
        () =>
          gus.room?.players.some(
            (p) => p.id === host.playerId && !p.connected && p.graceUntil !== null,
          ) ?? false,
        3000,
        'the host shown as dropped',
      );
      const refused = await gus.request(EV.start, { raceId: gus.room!.raceId });
      await until(
        () => gus.room?.hostId === gus.playerId,
        GRACE_MS + 3000,
        'the host role to pass on',
      );
      await hal.request(EV.ready, { ready: true, raceId: hal.room!.raceId });
      const started = await gus.request(EV.start, { raceId: gus.room!.raceId });
      await until(() => (gus.race?.racers.length ?? 0) === 2, 5000, 'a race of the two left');
      return [
        check(
          !refused.ok,
          'while the host is only dropped, nobody else can start',
          refused.ok ? '' : refused.error,
        ),
        check(
          gus.room?.hostId === gus.playerId && gus.room.players.length === 2,
          'after the grace period the seat is gone and the longest-standing player hosts',
        ),
        check(started.ok, 'the new host starts a race with the players left'),
      ];
    },
  },
  {
    name: 'photo',
    async run(url) {
      // Found by searching autopilot settings offline: these two cross the line ~5 ms apart.
      // Neither boosts, so neither depends on Energy cells the other may have picked up first.
      const bots = [
        bot('Pole', {
          rttMs: 40,
          jitterMs: 4,
          autopilot: { boost: false, racingLine: true, pace: 0.9924 },
        }),
        bot('Chase', {
          rttMs: 40,
          jitterMs: 4,
          autopilot: { boost: false, racingLine: true, pace: 1 },
        }),
      ];
      await seatRoom(url, bots, 1);
      const raceId = await startRace(bots[0], bots);
      const results = await finishRace(bots, raceId);
      const [a, b] = results.entries;
      const gap = (b.totalTime ?? 0) - (a.totalTime ?? 0);
      return [
        ...raceChecks(bots, results),
        check(
          a.finished && b.finished && gap >= 0 && gap < 0.1,
          'a close finish, ranked by exact crossing time',
          `${a.name} ${ms(a.totalTime)} beat ${b.name} by ${(gap * 1000).toFixed(2)} ms (${(gap / (1 / 60)).toFixed(2)} ticks)`,
        ),
        determinismCheck(bots, results),
      ];
    },
  },
];

// --- Runner ------------------------------------------------------------------------------------

/** Bots for a room on a running server: they join, ready up and race until Ctrl+C. */
async function fillRoom(args: string[]): Promise<void> {
  const option = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const code = option('join', '');
  const count = Math.min(7, Math.max(1, Number(option('bots', '1')) || 1));
  const url = option('url', 'http://127.0.0.1:3001');
  const rtt = Math.max(0, Number(option('rtt', '60')) || 0);
  const bots = Array.from({ length: count }, (_, i) =>
    bot(`Bot ${i + 1}`, {
      rttMs: rtt,
      jitterMs: 10,
      autopilot: { boost: true, racingLine: true, pace: 0.97 - i * 0.01, lane: lanes[i] },
    }),
  );
  // `--profiles`: each bot makes a profile over the HTTP API first, so its races are rated.
  const profiles = args.includes('--profiles');
  for (const b of bots) {
    if (profiles) await b.profile(url);
    await b.connect(url);
    await b.join(code);
    const ack = await b.request(EV.ready, { ready: true, raceId: b.room?.raceId ?? 0 });
    if (!ack.ok) console.warn(`${b.name}: ${ack.error}`);
  }
  console.log(`${count} bot(s) in room ${code} on ${url}; they race whenever the host starts.`);
  setInterval(() => {
    for (const b of all) b.update();
  }, 4);
  // After a race (on the results screen, or back in the lobby): ready for the next one.
  setInterval(() => {
    for (const b of bots) {
      const room = b.room;
      const me = room?.players.find((p) => p.id === b.playerId);
      const between = room?.phase === 'waiting' || room?.phase === 'results';
      if (room && between && me && !me.ready) {
        void b.request(EV.ready, { ready: true, raceId: room.raceId });
      }
    }
  }, 1000);
  process.on('SIGINT', () => {
    for (const b of bots) b.drop();
    process.exit(0);
  });
}

async function main(): Promise<void> {
  if (process.argv.includes('--join')) {
    await fillRoom(process.argv.slice(2));
    return;
  }
  const wanted = new Set(process.argv.slice(2));
  const scenarios = SCENARIOS.filter((s) => wanted.size === 0 || wanted.has(s.name));
  if (scenarios.length === 0) {
    console.error(`Unknown scenario. Choose from: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }

  // Ratings go to a throwaway database: PostgreSQL when TEST_DATABASE_URL is set, else PGlite.
  const database = TEST_DATABASES.at(-1)!;
  const db = await database.open();
  const ranking = new RankingService(new RankingStore(db.db), { log: () => {} });
  await ranking.start();
  const manager = new RoomManager(track, now, { graceMs: GRACE_MS, snapshotRate: 20, ranking });
  const api = createApi(ranking);
  const http = createServer((req, res) => {
    if (!api(req, res)) res.writeHead(404).end();
  });
  attachSocketServer(http, manager, now, {
    // Every bot connects from this machine: the per-address limits are for real players.
    limits: LOCAL_LIMITS,
    redeemTicket: (ticket) => ranking.redeemTicket(ticket),
  });
  manager.start(4);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  console.log(
    `harness: server on ${url}, ${scenarios.length} scenario(s), reconnect grace ${GRACE_MS} ms, ` +
      `ratings in ${database.name}`,
  );

  const loop = setInterval(() => {
    for (const b of all) b.update();
  }, 4);
  const started = now();
  const outcomes = await Promise.all(
    scenarios.map(async (scenario) => {
      try {
        return { scenario, checks: await scenario.run(url, manager, ranking) };
      } catch (error) {
        return { scenario, checks: [check(false, 'scenario ran to the end', String(error))] };
      }
    }),
  );
  clearInterval(loop);

  let failed = 0;
  for (const { scenario, checks } of outcomes) {
    const bad = checks.filter((c) => !c.ok).length;
    failed += bad;
    console.log(`\n${bad === 0 ? 'PASS' : 'FAIL'}  ${scenario.name}`);
    for (const c of checks) {
      console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? `: ${c.detail}` : ''}`);
    }
  }
  console.log(
    `\n${failed === 0 ? 'all scenarios passed' : `${failed} check(s) failed`} in ${((now() - started) / 1000).toFixed(1)} s`,
  );

  for (const b of all) b.drop();
  await Promise.all([...proxies].map((p) => p.close()));
  manager.stop();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await ranking.close();
  await db.drop();
  process.exit(failed === 0 ? 0 : 1);
}

void main();
