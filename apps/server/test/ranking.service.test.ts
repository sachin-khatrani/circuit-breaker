import { rateRace, type RaceRating, type RaceStats } from '@circuit-breaker/shared';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure, RankingService, type RankingOptions } from '../src/ranking/service';
import { RankingStore } from '../src/ranking/store';
import type { CompletedRace, CompletedRaceEntry } from '../src/ranking/types';
import { FlakyDb, TEST_DATABASES, type TestDb } from './db';

const STATS: RaceStats = {
  boosts: 1,
  overdrives: 0,
  shortcuts: 0,
  gateShifts: 0,
  shortcutRuns: 0,
  energy: 60,
  driftSeconds: 1.2,
  topSpeed: 80,
  wallHits: 0,
};

/** A finished race: one car per entry, in classification order. */
function completed(
  cars: { seat: string; profile: string | null; time?: number; dnf?: 'racing' | 'left' }[],
  uid = randomUUID(),
): CompletedRace {
  const now = new Date();
  const entries: CompletedRaceEntry[] = cars.map((c, i) => ({
    seatId: c.seat,
    profileId: c.profile,
    position: i + 1,
    finished: c.time !== undefined,
    dnfReason: c.time !== undefined ? null : (c.dnf ?? 'racing'),
    totalTime: c.time ?? null,
    bestLap: c.time === undefined ? null : c.time / 3,
    stats: STATS,
  }));
  return {
    uid,
    raceId: 7,
    roomCode: 'QWERTY',
    sessionId: 1,
    raceNumber: 1,
    trackId: 'grid-zero',
    laps: 3,
    startedAt: new Date(now.getTime() - 150_000),
    completedAt: now,
    entries,
  };
}

async function until(test: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Every rating a room was told about, in order. */
function recorder() {
  const seen: RaceRating[] = [];
  return { seen, notify: (r: RaceRating) => void seen.push(r), last: () => seen.at(-1) };
}

describe.each(TEST_DATABASES)('ranking service on $name', (database) => {
  const open: TestDb[] = [];
  const services: RankingService[] = [];
  afterEach(async () => {
    for (const s of services.splice(0)) await s.close(100);
    for (const t of open.splice(0)) await t.drop();
  });

  async function service(options: RankingOptions = {}, flaky = false) {
    const t = await database.open();
    open.push(t);
    const db = flaky ? new FlakyDb(t.db) : t.db;
    const svc = new RankingService(new RankingStore(db), {
      retryDelaysMs: [5, 10, 20],
      startRetryMs: 20,
      log: () => {},
      ...options,
    });
    services.push(svc);
    await svc.start();
    return { svc, db: db as FlakyDb, store: new RankingStore(t.db) };
  }

  it('makes an anonymous profile and finds it only with its own cookie token', async () => {
    const { svc } = await service();
    const made = await svc.createIdentity(null, '  Nova <b>Prime</b> ');
    expect(made.created).toBe(true);
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made.player).toMatchObject({ nickname: 'Nova bPrimeb', rating: 1000, rank: null });
    expect(made.player.id).toMatch(/^[0-9A-Z]{16}$/);
    expect(made.player.tag).toBe(made.player.id.slice(0, 4));
    // Nothing secret in what the player gets back.
    expect(JSON.stringify(made.player)).not.toContain(made.token);
    expect((await svc.me(made.token))?.id).toBe(made.player.id);
    // The same browser asking again keeps its profile.
    const again = await svc.createIdentity(made.token, 'Other');
    expect(again).toMatchObject({ created: false, token: made.token });
    expect(again.player.id).toBe(made.player.id);
    // Unknown, malformed or missing tokens find nothing.
    expect(await svc.me(null)).toBeNull();
    expect(await svc.me('x'.repeat(43))).toBeNull();
    expect(await svc.me('not a token')).toBeNull();
    // Two browsers, two profiles.
    const other = await svc.createIdentity(null, 'Vex');
    expect(other.player.id).not.toBe(made.player.id);
    expect((await svc.me(other.token))?.nickname).toBe('Vex');
  });

  it('restores a profile with its recovery code, and a new code locks the old one out', async () => {
    const { svc } = await service();
    const home = await svc.createIdentity(null, 'Nova');
    await expect(svc.newRecoveryCode(null)).rejects.toMatchObject({ status: 401 });
    const { code, player } = await svc.newRecoveryCode(home.token);
    expect(code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    expect(player.hasRecoveryCode).toBe(true);
    // Another browser (or after clearing site data): the code, typed loosely, restores it.
    const typed = ` ${code.toLowerCase().replace(/-/g, ' ')} `;
    const away = await svc.recover(null, typed);
    expect(away.player.id).toBe(home.player.id);
    expect(away.token).not.toBe(home.token);
    expect((await svc.me(away.token))?.id).toBe(home.player.id);
    expect((await svc.me(home.token))?.id).toBe(home.player.id);
    // Wrong or malformed codes do nothing.
    await expect(svc.recover(null, 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ')).rejects.toMatchObject({
      status: 400,
    });
    await expect(svc.recover(null, 'short')).rejects.toBeInstanceOf(ApiFailure);
    // A new code from the second browser: the old code and every other browser are out.
    const fresh = await svc.newRecoveryCode(away.token);
    expect(fresh.code).not.toBe(code);
    await expect(svc.recover(null, code)).rejects.toMatchObject({ status: 400 });
    expect(await svc.me(home.token)).toBeNull();
    expect((await svc.me(away.token))?.id).toBe(home.player.id);
  });

  it('renames only the caller, validates names, and keeps to five changes a day', async () => {
    const { svc } = await service();
    const a = await svc.createIdentity(null, 'Ana');
    const b = await svc.createIdentity(null, 'Ben');
    await expect(svc.rename(a.token, '<<>>')).rejects.toMatchObject({ status: 400 });
    await expect(svc.rename(null, 'Ghost')).rejects.toMatchObject({ status: 401 });
    for (let i = 1; i <= 5; i++) {
      expect((await svc.rename(a.token, `Ana ${i}`)).changed).toBe(true);
    }
    const blocked = await svc.rename(a.token, 'Ana 6');
    expect(blocked.changed).toBe(false);
    expect(blocked.note).toMatch(/5 times a day/);
    expect(blocked.player).toMatchObject({ nickname: 'Ana 5', nicknameChangesLeft: 0 });
    expect(blocked.player.nicknameResetsAt).not.toBeNull();
    expect((await svc.me(b.token))?.nickname).toBe('Ben');
  });

  it('issues single-use seat tickets that expire, and only to a known browser', async () => {
    const { svc } = await service();
    const a = await svc.createIdentity(null, 'Ana');
    await expect(svc.issueTicket(null, 'Ana')).rejects.toMatchObject({ status: 401 });
    await expect(svc.issueTicket('y'.repeat(43), 'Ana')).rejects.toMatchObject({ status: 401 });
    const first = await svc.issueTicket(a.token, 'Ana Prime');
    // The typed room name became the profile's name.
    expect(first.player.nickname).toBe('Ana Prime');
    expect(first.nicknameNote).toBeNull();
    expect(svc.redeemTicket(first.ticket)).toEqual({
      id: a.player.id,
      tag: a.player.tag,
      rating: 1000,
      races: 0,
    });
    expect(svc.redeemTicket(first.ticket)).toBeNull();
    expect(svc.redeemTicket('made up')).toBeNull();
    expect(svc.redeemTicket({ id: a.player.id })).toBeNull();
    const late = await svc.issueTicket(a.token, 'Ana Prime');
    const unused = await svc.issueTicket(a.token, 'Ana Prime');
    expect(svc.ticketCount).toBe(2);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect(svc.redeemTicket(late.ticket)).toBeNull();
      // Tickets nobody used are swept when the next one is issued: the map cannot grow.
      await svc.issueTicket(a.token, 'Ana Prime');
      expect(svc.ticketCount).toBe(1);
      expect(svc.redeemTicket(unused.ticket)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rates a race once, after the database commits, and tells the room', async () => {
    const { svc, store } = await service();
    const [a, b, c] = await Promise.all(
      ['Ana', 'Ben', 'Cy'].map((n) => svc.createIdentity(null, n)),
    );
    const race = completed([
      { seat: 's1', profile: b.player.id, time: 45 },
      { seat: 's2', profile: a.player.id, time: 46 },
      { seat: 's3', profile: null, time: 47 },
      { seat: 's4', profile: c.player.id, dnf: 'left' },
    ]);
    const room = recorder();
    const first = svc.submit(race, room.notify);
    expect(first).toMatchObject({ status: 'pending', entries: [] });
    expect(first.unrated).toEqual([{ id: 's3', reason: 'No profile' }]);
    await until(() => room.last()?.status === 'rated');
    const rated = room.last()!;
    const expected = rateRace([
      { id: b.player.id, rating: 1000, races: 0, finished: true, time: 45, dnfReason: null },
      { id: a.player.id, rating: 1000, races: 0, finished: true, time: 46, dnfReason: null },
      { id: c.player.id, rating: 1000, races: 0, finished: false, time: null, dnfReason: 'left' },
    ]);
    expect(rated.entries.map((e) => [e.id, e.profileId, e.delta])).toEqual([
      ['s1', b.player.id, expected[0].delta],
      ['s2', a.player.id, expected[1].delta],
      ['s4', c.player.id, expected[2].delta],
    ]);
    expect(rated.entries.map((e) => e.rank)).toEqual([1, 2, 3]);
    // Win and podium counted by the overall place (the unrated car third does not matter).
    expect(await store.player(b.player.id)).toMatchObject({ wins: 1, podiums: 1, races: 1 });
    expect(await store.player(c.player.id)).toMatchObject({ wins: 0, podiums: 0, finished: 0 });

    // Submitted again (a reconnect, a bug, anything): reported again, applied once.
    const again = recorder();
    svc.submit(race, again.notify);
    await until(() => again.last()?.status === 'rated');
    expect(again.last()!.entries.map((e) => e.delta)).toEqual(rated.entries.map((e) => e.delta));
    expect(await store.player(b.player.id)).toMatchObject({ races: 1, wins: 1 });
    const board = await svc.leaderboard(0, 10);
    expect(board.entries.map((e) => [e.nickname, e.races])).toEqual([
      ['Ben', 1],
      ['Ana', 1],
      ['Cy', 1],
    ]);
  });

  it('says why a race is unrated, and leaves out a profile racing two cars', async () => {
    const { svc } = await service();
    const [a, b, c] = await Promise.all(
      ['Ana', 'Ben', 'Cy'].map((n) => svc.createIdentity(null, n)),
    );
    const none = recorder();
    const alone = svc.submit(
      completed([
        { seat: 's1', profile: a.player.id, time: 45 },
        { seat: 's2', profile: null, time: 46 },
      ]),
      none.notify,
    );
    expect(alone.status).toBe('unrated');
    expect(alone.reason).toMatch(/2 players with profiles/);
    const nobody = svc.submit(
      completed([
        { seat: 's1', profile: a.player.id, dnf: 'racing' },
        { seat: 's2', profile: b.player.id, dnf: 'left' },
      ]),
      none.notify,
    );
    expect(nobody.status).toBe('unrated');
    expect(nobody.reason).toMatch(/no rated player finished/);
    // Ana in two tabs: both her cars are left out; Ben and Cy are rated against each other.
    const twice = recorder();
    const answer = svc.submit(
      completed([
        { seat: 's1', profile: a.player.id, time: 44 },
        { seat: 's2', profile: b.player.id, time: 45 },
        { seat: 's3', profile: a.player.id, time: 46 },
        { seat: 's4', profile: c.player.id, time: 47 },
      ]),
      twice.notify,
    );
    expect(answer.unrated).toEqual([
      { id: 's1', reason: 'One profile, two cars' },
      { id: 's3', reason: 'One profile, two cars' },
    ]);
    await until(() => twice.last()?.status === 'rated');
    expect(twice.last()!.entries.map((e) => e.id)).toEqual(['s2', 's4']);
    expect((await svc.me(a.token))?.races).toBe(0);
    expect(none.seen).toEqual([]);
    // A server without a database rates nothing, and says so.
    const off = new RankingService(null);
    const offAnswer = off.submit(completed([{ seat: 's', profile: 'X', time: 1 }]), () => {});
    expect(offAnswer.status).toBe('unrated');
    expect(offAnswer.reason).toMatch(/off on this server/);
    await expect(off.leaderboard(0, 10)).rejects.toMatchObject({ status: 503 });
  });

  it('keeps a finished race while the database is away, and saves it when it is back', async () => {
    const { svc, db, store } = await service({}, true);
    const a = await svc.createIdentity(null, 'Ana');
    const b = await svc.createIdentity(null, 'Ben');
    db.break();
    // Profiles and the leaderboard say so, without details.
    await expect(svc.leaderboard(0, 10)).rejects.toMatchObject({
      status: 503,
      message: 'Rankings are unavailable right now. Races still work.',
    });
    expect(svc.health().database).toBe('down');
    const room = recorder();
    expect(
      svc.submit(
        completed([
          { seat: 's1', profile: a.player.id, time: 45 },
          { seat: 's2', profile: b.player.id, time: 46 },
        ]),
        room.notify,
      ).status,
    ).toBe('pending');
    await until(() => room.seen.length > 0);
    expect(room.last()).toMatchObject({ status: 'retrying', entries: [] });
    expect(svc.pending).toBe(1);
    db.heal();
    await until(() => room.last()?.status === 'rated');
    expect(svc.pending).toBe(0);
    expect(svc.health().database).toBe('ok');
    expect((await store.player(a.player.id))!.races).toBe(1);
  });

  it('gives a race up after its retry window, and saves nothing of it', async () => {
    const { svc, db, store } = await service({ retryForMs: 60 }, true);
    const a = await svc.createIdentity(null, 'Ana');
    const b = await svc.createIdentity(null, 'Ben');
    db.break();
    const room = recorder();
    svc.submit(
      completed([
        { seat: 's1', profile: a.player.id, time: 45 },
        { seat: 's2', profile: b.player.id, time: 46 },
      ]),
      room.notify,
    );
    await until(() => room.last()?.status === 'failed');
    expect(room.seen.map((r) => r.status)).toEqual(['retrying', 'failed']);
    expect(room.last()!.reason).toMatch(/not saved/);
    db.heal();
    expect((await store.player(a.player.id))!.races).toBe(0);
    expect(svc.pending).toBe(0);
  });

  it('shuts down promptly, naming the ratings it could not save, and takes no more', async () => {
    const lines: string[] = [];
    const { svc, db } = await service({ log: (line) => lines.push(line) }, true);
    const a = await svc.createIdentity(null, 'Ana');
    const b = await svc.createIdentity(null, 'Ben');
    db.break();
    const race = completed([
      { seat: 's1', profile: a.player.id, time: 45 },
      { seat: 's2', profile: b.player.id, time: 46 },
    ]);
    svc.submit(race, () => {});
    await until(() => lines.some((l) => /waiting for the database/.test(l)));
    const started = Date.now();
    await svc.close(200);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(lines.some((l) => /not saved/.test(l) && l.includes(race.uid))).toBe(true);
    const late = svc.submit(
      completed([
        { seat: 's1', profile: a.player.id, time: 45 },
        { seat: 's2', profile: b.player.id, time: 46 },
      ]),
      () => {},
    );
    expect(late.status).toBe('failed');
  });

  it('starts while the database is away and catches up when it comes', async () => {
    const t = await database.open({ bare: true });
    open.push(t);
    const db = new FlakyDb(t.db);
    db.break();
    const lines: string[] = [];
    const svc = new RankingService(new RankingStore(db), {
      startRetryMs: 20,
      log: (l) => lines.push(l),
    });
    services.push(svc);
    await svc.start();
    expect(svc.health()).toMatchObject({ enabled: true, database: 'down' });
    await expect(svc.me(null)).rejects.toMatchObject({ status: 503 });
    db.heal();
    await until(() => svc.health().database === 'ok');
    expect(lines.some((l) => /not reachable/.test(l))).toBe(true);
    expect(lines.some((l) => /migrations: applied 1/.test(l))).toBe(true);
    expect(await svc.me(null)).toBeNull();
  });
});
