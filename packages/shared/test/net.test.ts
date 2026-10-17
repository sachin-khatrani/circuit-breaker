import { describe, expect, it } from 'vitest';
import { ClockSync, InputLead } from '../src/net/clock';
import {
  createRacerRow,
  decodeInputPacket,
  encodeInputPacket,
  FLAG_FROZEN,
  packCells,
  packInputFrame,
  packPredictedState,
  packRacerRow,
  unpackInputFrame,
  unpackPredictedState,
  unpackRacerRow,
  type InputFrame,
} from '../src/net/codec';
import { createRemoteSample, RemoteTrack } from '../src/net/interpolation';
import { Predictor } from '../src/net/predictor';
import { normalizeRoomCode, sanitizeNickname, type RaceStartInfo } from '../src/net/protocol';
import { autopilotInput } from '../src/sim/autopilot';
import { RACE_RULES, TICK_RATE } from '../src/sim/config';
import { packCourse } from '../src/sim/course';
import type { RaceEvent } from '../src/sim/events';
import { createInput, type PlayerInput } from '../src/sim/input';
import { RaceSimulation } from '../src/sim/race';
import { placeVehicle } from '../src/sim/vehicle';
import { Track } from '../src/track/track';
import { GRID_ZERO } from '../src/track/tracks/gridZero';

const track = new Track(GRID_ZERO);
const TICK_MS = 1000 / TICK_RATE;

describe('protocol helpers', () => {
  it('sanitises nicknames and room codes', () => {
    expect(sanitizeNickname('  Nova  ')).toBe('Nova');
    expect(sanitizeNickname('<b>Zed</b>')).toBe('bZedb');
    expect(sanitizeNickname('a\u0000b​c')).toBe('abc');
    expect(sanitizeNickname('x'.repeat(40))).toHaveLength(16);
    expect(sanitizeNickname('   ')).toBeNull();
    expect(sanitizeNickname(42)).toBeNull();
    expect(normalizeRoomCode('ab-cd 23')).toBe('ABCD23');
    expect(normalizeRoomCode('ABCDE0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeRoomCode('ABC')).toBeNull();
    expect(normalizeRoomCode(null)).toBeNull();
  });
});

describe('input packets', () => {
  it('round-trip quantised frames', () => {
    const input: PlayerInput = {
      throttle: 0.734,
      brake: 0,
      steer: -0.41,
      boost: true,
      drift: false,
      reset: true,
      shortcut: false,
      gate: true,
      overdrive: false,
    };
    const frame = packInputFrame(input);
    expect(frame).toEqual([73, 0, -41, 21]);
    const decoded = decodeInputPacket(encodeInputPacket(4, 120, [frame, frame]));
    expect(decoded?.raceId).toBe(4);
    expect(decoded?.firstTick).toBe(120);
    expect(decoded?.frames).toHaveLength(2);
    const back = unpackInputFrame(decoded!.frames[1]);
    expect(back).toEqual({
      throttle: 0.73,
      brake: 0,
      steer: -0.41,
      boost: true,
      drift: false,
      reset: true,
      shortcut: false,
      gate: true,
      overdrive: false,
    });
  });

  it('reject anything malformed', () => {
    const ok: InputFrame = [100, 0, 0, 0];
    const bad: unknown[] = [
      null,
      'input',
      { firstTick: 1 },
      [],
      [5],
      [3, 5, 100, 0, 0],
      // The layout before race ids (a stale client): no race id, so the length is wrong.
      [5, ...ok],
      [3, -1, ...ok],
      [-1, 5, ...ok],
      ['3', 5, ...ok],
      [3, 5.5, ...ok],
      [3, 5, 101, 0, 0, 0],
      [3, 5, 50, 0, -101, 0],
      [3, 5, 50, 0, 0, 64],
      [3, 5, 50, 0, 0.5, 0],
      [3, 5, Number.NaN, 0, 0, 0],
      [3, 5, '50', 0, 0, 0],
      encodeInputPacket(
        3,
        5,
        Array.from({ length: 13 }, () => ok),
      ),
    ];
    for (const raw of bad) expect(decodeInputPacket(raw)).toBeNull();
  });
});

describe('snapshot rows and predicted state', () => {
  function raceAt(ticks: number) {
    const sim = new RaceSimulation(track, { skipCountdown: true });
    const racer = sim.addRacer('a', 'A');
    const input = createInput();
    for (let i = 0; i < ticks; i++) {
      autopilotInput(track, racer.vehicle, { boost: true, racingLine: true }, input);
      sim.setInput('a', input);
      sim.step();
    }
    return { sim, racer };
  }

  it('packs a racer row within quantisation', () => {
    const { racer } = raceAt(600);
    const row = unpackRacerRow(packRacerRow(racer, false), createRacerRow());
    expect(row.x).toBeCloseTo(racer.vehicle.x, 1);
    expect(row.z).toBeCloseTo(racer.vehicle.z, 1);
    expect(row.yaw).toBeCloseTo(racer.vehicle.yaw, 2);
    expect(row.vx).toBeCloseTo(racer.vehicle.vx, 1);
    expect(row.energy).toBe(Math.floor(racer.vehicle.energy));
    expect(row.position).toBe(racer.position);
  });

  it('restores a car exactly, so a replay gives identical results', () => {
    const { sim, racer } = raceAt(900);
    const state = JSON.parse(JSON.stringify(packPredictedState(racer))) as unknown;
    const copy = new RaceSimulation(track, { skipCountdown: true });
    const twin = copy.addRacer('a', 'A');
    expect(unpackPredictedState(state, twin)).toBe(true);
    copy.tick = sim.tick;
    const input = createInput();
    for (let i = 0; i < 600; i++) {
      autopilotInput(track, racer.vehicle, { boost: true, racingLine: true }, input);
      sim.setInput('a', input);
      copy.setInput('a', input);
      sim.step();
      copy.step();
    }
    expect(twin.vehicle.x).toBe(racer.vehicle.x);
    expect(twin.vehicle.z).toBe(racer.vehicle.z);
    expect(twin.vehicle.energy).toBe(racer.vehicle.energy);
    expect(twin.lap).toBe(racer.lap);
    expect(unpackPredictedState([1, 2, 3], twin)).toBe(false);
  });

  it('carries Energy cell state', () => {
    const cells = track.cells.map(() => ({ active: true, respawnTick: 0 }));
    cells[3] = { active: false, respawnTick: 900 };
    const packed = packCells(cells);
    expect(packed).toEqual([3, 900]);
  });
});

describe('clock sync', () => {
  const sampleClock = (asymmetric: boolean) => {
    const clock = new ClockSync();
    let rand = 7;
    const noise = () => ((rand = (rand * 16807) % 2147483647) / 2147483647) * 30;
    for (let i = 0; i < 10; i++) {
      const sent = i * 1000;
      const up = 40 + noise();
      const down = asymmetric ? 40 + noise() : up;
      clock.addSample(sent, sent + up + 12_345, sent + up + down);
    }
    return clock;
  };

  it('finds the server clock exactly when delays are symmetric, whatever the jitter', () => {
    const clock = sampleClock(false);
    expect(Math.abs(clock.offset - 12_345)).toBeLessThan(0.001);
    expect(clock.rtt).toBeGreaterThan(80);
  });

  it('stays within half the delay asymmetry otherwise (no ping can see more)', () => {
    const clock = sampleClock(true);
    expect(Math.abs(clock.offset - 12_345)).toBeLessThan(15);
  });
});

describe('remote car interpolation', () => {
  const row = (x: number, vx: number, flags = 0) => ({ ...createRacerRow(), x, vx, flags });

  it('moves smoothly between snapshots and holds after a gap', () => {
    const remote = new RemoteTrack();
    remote.push(0, row(0, 60));
    remote.push(3, row(3, 60)); // 60 m/s over 3 ticks = 3 m
    const out = createRemoteSample();
    expect(remote.sample(1.5, out)).toBe('interpolated');
    expect(out.x).toBeCloseTo(1.5, 5);
    expect(remote.sample(6, out)).toBe('extrapolated');
    expect(out.x).toBeCloseTo(6, 5);
    expect(remote.sample(40, out)).toBe('held');
    expect(out.x).toBeCloseTo(3 + 9, 5);
  });

  it('snaps across a respawn instead of sliding', () => {
    const remote = new RemoteTrack();
    remote.push(0, row(0, 60));
    remote.push(3, row(400, 0, FLAG_FROZEN));
    const out = createRemoteSample();
    remote.sample(1, out);
    expect(out.x).toBe(400);
  });

  it('ignores stale or repeated snapshots', () => {
    const remote = new RemoteTrack();
    remote.push(6, row(6, 60));
    remote.push(3, row(3, 60));
    remote.push(6, row(99, 60));
    expect(remote.size).toBe(1);
  });
});

// --- A whole race over a simulated network -------------------------------------------------

interface NetRunOptions {
  /** Round trip (ms) and jitter (ms, added one way, never reordering packets). */
  rtt: number;
  jitter: number;
  laps: number;
  bots: number;
  /** Start from a deliberately wrong lead instead of the ping estimate. */
  initialLead?: number;
  /**
   * Abilities in play: a rival (bot 0) opens the shortcut as "me" approaches it, "me" takes
   * it and fires Overdrive on the main straight, and another rival shifts the gate.
   */
  abilities?: boolean;
}

/** In-order delivery after a delay, like a TCP stream with variable latency. */
class Pipe<T> {
  private readonly queue: { at: number; data: T }[] = [];
  private lastAt = 0;
  constructor(
    private readonly delay: number,
    private readonly jitter: number,
    private readonly random: () => number,
  ) {}
  send(now: number, data: T): void {
    this.lastAt = Math.max(this.lastAt, now + this.delay + this.random() * this.jitter);
    this.queue.push({ at: this.lastAt, data });
  }
  receive(now: number): T[] {
    const out: T[] = [];
    while (this.queue.length > 0 && this.queue[0].at <= now) out.push(this.queue.shift()!.data);
    return out;
  }
}

/**
 * One networked client ("me") plus server-side bots. The client predicts with the shared
 * Predictor, stamps its inputs with ticks, sends them every 2 ticks with redundancy, and
 * follows the server's lead feedback; the server applies each input at its tick and sends
 * snapshots every 3 ticks (20 Hz). The client drives with the autopilot from its own
 * predicted car, as a player reacts to what they see.
 */
function runNetworkedRace(opts: NetRunOptions) {
  let seed = 12345;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const server = new RaceSimulation(track, {
    laps: opts.laps,
    startEnergy: opts.abilities ? 100 : undefined,
  });
  const ids = ['me', ...Array.from({ length: opts.bots }, (_, i) => `bot${i}`)];
  ids.forEach((id, slot) => server.addRacer(id, id, slot));
  const me = server.getRacer('me')!;
  const start: RaceStartInfo = {
    raceId: 1,
    trackId: track.id,
    laps: opts.laps,
    tickRate: TICK_RATE,
    startTime: 0,
    goTick: server.goTick,
    startEnergy: server.startEnergy,
    snapshotRate: 20,
    racers: ids.map((id, slot) => ({ id, name: id, color: slot, style: 0, slot })),
  };
  const client = new Predictor(track, start, 'me');
  const lead = new InputLead();
  if (opts.initialLead !== undefined) lead.lead = opts.initialLead;
  else lead.fromRtt(opts.rtt, opts.jitter, TICK_MS);
  const up = new Pipe<number[]>(opts.rtt / 2, opts.jitter, random);
  const down = new Pipe<{
    t: number;
    me: unknown;
    cells: unknown;
    course: unknown;
    b: number;
    m: number;
  }>(opts.rtt / 2, opts.jitter, random);
  const received = new Map<number, InputFrame>();
  let lastFrame: InputFrame = [0, 0, 0, 0];
  let newestTick = 0;
  let missed = 0;
  let missedAfterWarmup = 0;
  const frames = new Map<number, InputFrame>();
  const botInput = createInput();
  const meInput = createInput();
  const corrections: number[] = [];
  const applied: string[] = [];
  const missedTicks: number[] = [];
  const warmup = server.goTick + TICK_RATE;
  const serverEvents: RaceEvent[] = [];
  const entry = track.branches[0]?.entryMainS ?? 0;
  let rivalOpened = false;
  let rivalShifted = false;
  let overdriveSent = false;

  for (let now = 0; server.phase !== 'finished' && now < 600_000; now++) {
    // Server: take delivered input packets, then run every tick that is due.
    for (const packet of up.receive(now)) {
      const decoded = decodeInputPacket(packet);
      if (!decoded || decoded.raceId !== start.raceId) continue;
      decoded.frames.forEach((frame, i) => {
        const tick = decoded.firstTick + i;
        if (tick > server.tick && !received.has(tick)) received.set(tick, frame);
        newestTick = Math.max(newestTick, tick);
      });
    }
    while (server.tick < Math.floor(now / TICK_MS)) {
      const t = server.tick + 1;
      const frame = received.get(t);
      if (frame) {
        lastFrame = frame;
        received.delete(t);
      } else {
        missed++;
        missedTicks.push(t);
        if (t > warmup) missedAfterWarmup++;
      }
      applied.push((frame ?? lastFrame).join(','));
      server.setInput('me', unpackInputFrame(frame ?? lastFrame));
      ids.slice(1).forEach((id, i) => {
        const bot = server.getRacer(id)!;
        autopilotInput(
          track,
          bot.vehicle,
          {
            // The rival who opens the shortcut keeps its Energy for that.
            boost: !(opts.abilities && i === 0),
            racingLine: true,
            lane: (i % 3) - 1,
            course: server.course,
            tick: server.tick,
          },
          botInput,
        );
        if (server.phase === 'countdown') botInput.throttle = 0;
        if (opts.abilities && server.phase === 'racing') {
          // Bot 0 opens the shortcut once "me" is 250 m from it; bot 1 shifts the gate early.
          const toEntry = track.distanceAhead(me.vehicle.trackS, entry);
          if (i === 0 && !rivalOpened && me.started && me.vehicle.road === 0 && toEntry < 250) {
            botInput.shortcut = true;
            rivalOpened = true;
          }
          if (i === 1 && !rivalShifted && server.raceTime > 3) {
            botInput.gate = true;
            rivalShifted = true;
          }
        }
        server.setInput(id, botInput);
      });
      server.step();
      serverEvents.push(...server.drainEvents());
      if (t % 3 === 0) {
        down.send(now, {
          t,
          me: packPredictedState(me),
          cells: packCells(server.cells),
          course: packCourse(server.course),
          b: newestTick - t,
          m: missed,
        });
        missed = 0;
      }
    }
    // Client: re-base on delivered snapshots, then predict up to the lead target.
    for (const snap of down.receive(now)) {
      const rec = client.reconcile(snap.t, snap.me, snap.cells, snap.course);
      if (rec && snap.t > warmup) corrections.push(rec.error);
      lead.feedback(snap.b, snap.m, now, opts.rtt);
    }
    const target = Math.floor(now / TICK_MS + lead.lead);
    while (client.tick < target) {
      autopilotInput(
        track,
        client.racer.vehicle,
        {
          boost: true,
          racingLine: true,
          course: client.sim.course,
          tick: client.tick,
          shortcut: opts.abilities,
        },
        meInput,
      );
      if (client.sim.phase === 'countdown') {
        meInput.throttle = client.sim.goTick - client.tick <= 15 ? 1 : 0;
      }
      // Overdrive on the main straight, once the race is under way.
      const onStraight = client.racer.vehicle.trackS > 60 && client.racer.vehicle.trackS < 120;
      if (opts.abilities && !overdriveSent && client.racer.started && onStraight) {
        meInput.overdrive = true;
        overdriveSent = true;
      }
      client.step(meInput);
      frames.set(client.tick, packInputFrame(meInput));
      if (client.tick % 2 === 0) {
        const first = Math.max(1, client.tick - 5);
        const batch: InputFrame[] = [];
        for (let k = first; k <= client.tick; k++) batch.push(frames.get(k) ?? [0, 0, 0, 0]);
        up.send(now, encodeInputPacket(start.raceId, first, batch));
      }
    }
  }
  return {
    server,
    me,
    serverEvents,
    finishTime: me.finishTime,
    visibleCorrections: corrections.filter((e) => e > 0.01).length,
    maxCorrection: Math.max(0, ...corrections),
    missedAfterWarmup,
    lead: lead.lead,
    applied,
    missedTicks,
  };
}

describe('networked race (simulated latency)', () => {
  const reference = runNetworkedRace({ rtt: 0, jitter: 0, laps: 1, bots: 0 });

  it('finishes a lap through a zero-latency link like a local race', () => {
    expect(reference.me.finished).toBe(true);
    expect(reference.finishTime).toBeGreaterThan(40);
    expect(reference.visibleCorrections).toBe(0);
  });

  for (const rtt of [50, 100, 200]) {
    it(`gives the same race at ${rtt} ms round trip with jitter, with no visible corrections`, () => {
      const run = runNetworkedRace({ rtt, jitter: 20, laps: 1, bots: 0 });
      expect(run.me.finished).toBe(true);
      // Inputs carry their tick, so latency changes nothing on the server.
      expect(run.finishTime).toBe(reference.finishTime);
      expect(run.missedAfterWarmup).toBe(0);
      expect(run.visibleCorrections).toBe(0);
      expect(run.lead).toBeGreaterThan((rtt / 2 + 20) / TICK_MS);
    });
  }

  it('recovers from a lead that is far too short', () => {
    const run = runNetworkedRace({ rtt: 150, jitter: 10, laps: 1, bots: 0, initialLead: 1 });
    expect(run.me.finished).toBe(true);
    expect(run.missedAfterWarmup).toBe(0);
    expect(run.finishTime).toBe(reference.finishTime);
  });

  it('keeps corrections small in a full field contesting the same Energy cells', () => {
    const run = runNetworkedRace({ rtt: 100, jitter: 20, laps: 1, bots: 7 });
    expect(run.server.racers.filter((r) => r.finished)).toHaveLength(8);
    expect(run.missedAfterWarmup).toBe(0);
    // Mispredictions only come from cells other cars take first; they stay small and rare.
    expect(run.maxCorrection).toBeLessThan(3);
    expect(run.visibleCorrections).toBeLessThan(30);
  });

  it('keeps abilities and track changes exact through latency: a rival opens the shortcut, I take it', () => {
    const base = runNetworkedRace({ rtt: 0, jitter: 0, laps: 1, bots: 2, abilities: true });
    const used = base.serverEvents.filter((e) => e.type === 'ability').map((e) => e.ability);
    expect(used.sort()).toEqual(['gate', 'overdrive', 'shortcut']);
    expect(base.me.finished).toBe(true);
    expect(base.me.stats.shortcutRuns).toBe(1);
    expect(base.me.stats.overdrives).toBe(1);
    for (const rtt of [100, 200]) {
      const run = runNetworkedRace({ rtt, jitter: 20, laps: 1, bots: 2, abilities: true });
      // The track changes are scheduled ahead, so every client knew in time: the same race.
      expect(run.finishTime).toBe(base.finishTime);
      expect(run.me.stats.shortcutRuns).toBe(1);
      expect(run.visibleCorrections).toBe(0);
    }
  });
});

describe('multiplayer race rules', () => {
  it('ranks two cars that finish in the same tick by their exact crossing time', () => {
    const sim = new RaceSimulation(track, { laps: 1, skipCountdown: true });
    const a = sim.addRacer('a', 'A', 0);
    const b = sim.addRacer('b', 'B', 1);
    // Both on their last lap, just short of the line at the same speed. b is listed second
    // but sits 0.5 m closer, so within the next tick it crosses first.
    const setup: [typeof a, number, number][] = [
      [a, 1.0, -3],
      [b, 0.5, 3],
    ];
    for (const [r, back, lateral] of setup) {
      placeVehicle(r.vehicle, track, track.length - back, lateral);
      r.vehicle.vx = r.vehicle.trackFx * 70;
      r.vehicle.vz = r.vehicle.trackFz * 70;
      r.started = true;
      r.nextCheckpoint = 0;
      sim.setInput(r.id, { ...createInput(), throttle: 1 });
    }
    sim.step();
    const finishes = sim.drainEvents().filter((e) => e.type === 'finish');
    expect(finishes.map((e) => (e.type === 'finish' ? e.racerId : ''))).toEqual(['b', 'a']);
    expect(b.position).toBe(1);
    expect(a.position).toBe(2);
    expect(b.finishTime).toBeLessThan(a.finishTime ?? 0);
  });

  it('ranks a retired racer last and ends the race when everyone else is done', () => {
    const sim = new RaceSimulation(track, { laps: 1, skipCountdown: true });
    const a = sim.addRacer('a', 'A', 0);
    const b = sim.addRacer('b', 'B', 1);
    sim.retire('b');
    expect(b.retired).toBe(true);
    expect(sim.drainEvents().some((e) => e.type === 'retired')).toBe(true);
    const input = createInput();
    while (sim.phase !== 'finished' && sim.tick < 90 * TICK_RATE) {
      autopilotInput(track, a.vehicle, { racingLine: true }, input);
      sim.setInput('a', input);
      sim.step();
    }
    expect(sim.phase).toBe('finished');
    expect(a.finished).toBe(true);
    expect(a.position).toBe(1);
    expect(b.position).toBe(2);
    expect(b.finished).toBe(false);
  });

  it('ends the race at once when every racer has left', () => {
    const sim = new RaceSimulation(track, { laps: 3 });
    sim.addRacer('a', 'A', 0);
    sim.addRacer('b', 'B', 1);
    sim.retire('a');
    expect(sim.phase).toBe('countdown');
    sim.retire('b');
    expect(sim.phase).toBe('finished');
    expect(sim.drainEvents().at(-1)?.type).toBe('raceFinished');
    expect(RACE_RULES.finishGraceTicks).toBeGreaterThan(0);
  });
});
