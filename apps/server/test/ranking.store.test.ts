import { rateRace, RATING_RULES, type RaceStats } from '@circuit-breaker/shared';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PermanentError } from '../src/db/errors';
import { migrate, MIGRATIONS, rollbackLatest } from '../src/db/migrations';
import { hashSecret, newProfileId } from '../src/ranking/identity';
import { RankingStore, type RaceRecord, type RaceRecordEntry } from '../src/ranking/store';
import { TEST_DATABASES, type TestDb } from './db';

const T0 = new Date('2026-10-13T12:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const STATS: RaceStats = {
  boosts: 3,
  overdrives: 1,
  shortcuts: 0,
  gateShifts: 0,
  shortcutRuns: 1,
  energy: 120,
  driftSeconds: 4.5,
  topSpeed: 88.2,
  wallHits: 2,
};

/** A result: finished in `time`, or a DNF ('racing' or 'left'). */
type Outcome = { id: string; time: number } | { id: string; dnf: 'racing' | 'left' };

/** A race record from outcomes in classification order. */
function race(outcomes: Outcome[], completedAt = T0, id: string = randomUUID()): RaceRecord {
  const entries: RaceRecordEntry[] = outcomes.map((o, i) => ({
    playerId: o.id,
    position: i + 1,
    finished: 'time' in o,
    dnfReason: 'dnf' in o ? o.dnf : null,
    time: 'time' in o ? o.time : null,
    bestLap: 'time' in o ? o.time / 3 - 0.25 : null,
    stats: STATS,
  }));
  return {
    id,
    roomCode: 'ABCDEF',
    sessionId: 1,
    raceNumber: 1,
    trackId: 'grid-zero',
    laps: 3,
    fieldSize: outcomes.length + 1,
    startedAt: new Date(completedAt.getTime() - 150_000),
    completedAt,
    entries,
  };
}

describe.each(TEST_DATABASES)('ranking store on $name', (database) => {
  const open: TestDb[] = [];
  afterEach(async () => {
    for (const t of open.splice(0)) await t.drop();
  });
  async function fresh(options: { bare?: boolean } = {}) {
    const t = await database.open(options);
    open.push(t);
    return t;
  }
  async function storeWith(hooks = {}) {
    const t = await fresh();
    return { store: new RankingStore(t.db, hooks), db: t.db };
  }
  async function players(store: RankingStore, n: number, at0 = T0): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = newProfileId();
      await store.createPlayer(id, `Racer ${i}`, hashSecret(`token ${id}`), at0);
      ids.push(id);
    }
    return ids;
  }

  it('migrates once, under a lock, refuses an edited migration, and rolls back', async () => {
    const { db } = await fresh({ bare: true });
    const both = await Promise.all([migrate(db), migrate(db)]);
    expect(both.map((applied) => applied.length).sort()).toEqual([0, MIGRATIONS.length]);
    expect(await migrate(db)).toEqual([]);
    const edited = [{ ...MIGRATIONS[0], up: `${MIGRATIONS[0].up}\n-- edited` }];
    await expect(migrate(db, edited)).rejects.toBeInstanceOf(PermanentError);
    // Down the way it came up: the leaderboard index first, then the tables.
    expect(await rollbackLatest(db)).toBe(2);
    expect(await rollbackLatest(db)).toBe(1);
    await expect(db.query('SELECT 1 FROM players')).rejects.toThrow();
    expect(await migrate(db)).toEqual([1, 2]);
    expect((await db.query('SELECT count(*)::int AS n FROM players')).rows[0]).toEqual({ n: 0 });
  });

  it('finds a profile only by its own session, and keeps several browsers apart', async () => {
    const { store } = await storeWith();
    const [a, b] = await players(store, 2);
    expect((await store.playerBySession(hashSecret(`token ${a}`), T0))?.id).toBe(a);
    expect((await store.playerBySession(hashSecret(`token ${b}`), T0))?.id).toBe(b);
    expect(await store.playerBySession(hashSecret('a guess'), T0)).toBeNull();
    await store.addSession(a, hashSecret('second browser'), T0);
    expect((await store.playerBySession(hashSecret('second browser'), T0))?.id).toBe(a);
    await store.deleteSession(hashSecret('second browser'));
    expect(await store.playerBySession(hashSecret('second browser'), T0)).toBeNull();
    // Being seen later marks the profile active.
    const later = await store.playerBySession(hashSecret(`token ${a}`), at(60));
    expect(later?.lastActiveAt.getTime()).toBe(at(60).getTime());
  });

  it('renames: the first name is free, then five changes a day', async () => {
    const { store } = await storeWith();
    const id = newProfileId();
    await store.createPlayer(id, null, hashSecret('t'), T0);
    let outcome = await store.rename(id, 'Nova', T0);
    expect(outcome).toMatchObject({ changed: true, blockedUntil: null });
    expect(outcome.player).toMatchObject({ nickname: 'Nova', nameChanges: 0 });
    for (let i = 1; i <= 5; i++) {
      outcome = await store.rename(id, `Nova ${i}`, at(i));
      expect(outcome.changed).toBe(true);
    }
    outcome = await store.rename(id, 'Six', at(10));
    expect(outcome.changed).toBe(false);
    expect(outcome.player.nickname).toBe('Nova 5');
    expect(outcome.blockedUntil?.getTime()).toBe(at(1 + 24 * 60).getTime());
    // The same name again is not a change at all.
    expect((await store.rename(id, 'Nova 5', at(11))).changed).toBe(false);
    // A day after the window opened, it opens again.
    outcome = await store.rename(id, 'Six', at(1 + 24 * 60));
    expect(outcome).toMatchObject({ changed: true });
    expect(outcome.player).toMatchObject({ nickname: 'Six', nameChanges: 1 });
  });

  it('replaces a recovery code and signs out every other browser', async () => {
    const { store } = await storeWith();
    const [a] = await players(store, 1);
    await store.addSession(a, hashSecret('laptop'), T0);
    const after = await store.replaceRecovery(a, hashSecret('code one'), hashSecret('laptop'), T0);
    expect(after.hasRecovery).toBe(true);
    expect((await store.playerByRecovery(hashSecret('code one')))?.id).toBe(a);
    // The browser that made the code keeps its session; the other one is signed out.
    expect(await store.playerBySession(hashSecret('laptop'), T0)).not.toBeNull();
    expect(await store.playerBySession(hashSecret(`token ${a}`), T0)).toBeNull();
    await store.replaceRecovery(a, hashSecret('code two'), hashSecret('laptop'), T0);
    expect(await store.playerByRecovery(hashSecret('code one'))).toBeNull();
    expect((await store.playerByRecovery(hashSecret('code two')))?.id).toBe(a);
  });

  it('applies a race once: ratings, finishes, wins, podiums, best laps and history', async () => {
    const { store, db } = await storeWith();
    const [p1, p2, p3, p4] = await players(store, 4);
    const record = race([
      { id: p1, time: 45 },
      { id: p2, time: 46.5 },
      { id: p3, dnf: 'racing' },
      { id: p4, dnf: 'left' },
    ]);
    const applied = await store.applyRace(record, rateRace);
    expect(applied.duplicate).toBe(false);
    const expected = rateRace(
      record.entries.map((e) => ({
        id: e.playerId,
        rating: 1000,
        races: 0,
        finished: e.finished,
        time: e.time,
        dnfReason: e.dnfReason,
      })),
    );
    expect(applied.changes).toEqual(expected);
    const rows = await Promise.all([p1, p2, p3, p4].map((id) => store.player(id)));
    expect(rows.map((r) => [r!.races, r!.finished, r!.wins, r!.podiums])).toEqual([
      [1, 1, 1, 1],
      [1, 1, 0, 1],
      // Third place without finishing is no podium.
      [1, 0, 0, 0],
      [1, 0, 0, 0],
    ]);
    expect(rows.map((r) => r!.rating)).toEqual(expected.map((c) => c.after));
    expect(rows[0]!.peakRating).toBe(expected[0].after);
    expect(rows[3]!.peakRating).toBe(1000);
    expect(rows[0]!.bestLapMs).toBe(14750);
    expect(rows[2]!.bestLapMs).toBeNull();
    expect(rows[0]!.lastRaceAt?.getTime()).toBe(T0.getTime());

    const history = await store.history(p4, 10);
    expect(history).toEqual([
      expect.objectContaining({
        raceId: record.id,
        position: 4,
        fieldSize: 5,
        finished: false,
        dnfReason: 'left',
        totalTimeMs: null,
        ratingBefore: 1000,
        ratingDelta: expected[3].delta,
      }),
    ]);
    const stats = await db.query<{ stats: RaceStats }>(
      'SELECT stats FROM race_results WHERE race_id = $1 AND player_id = $2',
      [record.id, p1],
    );
    expect(stats.rows[0].stats).toEqual(STATS);

    // The same race again: nothing changes, and the first changes come back.
    const again = await store.applyRace(record, rateRace);
    expect(again.duplicate).toBe(true);
    expect([...again.changes].sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      [...expected].sort((x, y) => x.id.localeCompare(y.id)),
    );
    const rowsAgain = await Promise.all([p1, p2, p3, p4].map((id) => store.player(id)));
    expect(rowsAgain).toEqual(rows);
    const counts = await db.query<{ races: number; results: number }>(
      `SELECT (SELECT count(*)::int FROM rated_races) AS races,
              (SELECT count(*)::int FROM race_results) AS results`,
    );
    expect(counts.rows[0]).toEqual({ races: 1, results: 4 });
  });

  it('rolls a failed race back completely', async () => {
    let fail = true;
    const { store, db } = await storeWith({
      beforeCommit: () => {
        if (fail) throw new Error('the connection dropped before COMMIT');
      },
    });
    const [a, b] = await players(store, 2);
    const record = race([
      { id: a, time: 45 },
      { id: b, time: 47 },
    ]);
    await expect(store.applyRace(record, rateRace)).rejects.toThrow(/before COMMIT/);
    const untouched = await Promise.all([a, b].map((id) => store.player(id)));
    expect(untouched.map((r) => [r!.rating, r!.races, r!.wins])).toEqual([
      [1000, 0, 0],
      [1000, 0, 0],
    ]);
    const counts = await db.query<{ races: number; results: number }>(
      `SELECT (SELECT count(*)::int FROM rated_races) AS races,
              (SELECT count(*)::int FROM race_results) AS results`,
    );
    expect(counts.rows[0]).toEqual({ races: 0, results: 0 });
    // The race id was not used up: a retry applies it.
    fail = false;
    expect((await store.applyRace(record, rateRace)).duplicate).toBe(false);
    expect((await store.player(a))!.races).toBe(1);
  });

  it('keeps races that finish at once consistent, each applied once', async () => {
    const { store, db } = await storeWith();
    const ids = await players(store, 6);
    // Twelve races over overlapping groups, each sent twice, all at the same moment.
    const records = Array.from({ length: 12 }, (_, i) => {
      const group = [ids[i % 6], ids[(i + 1) % 6], ids[(i + 3) % 6]];
      return race(
        group.map((id, k) => ({ id, time: 45 + ((k + i) % 3) })),
        at(i),
      );
    });
    const outcomes = await Promise.all(
      [...records, ...records].map((r) => store.applyRace(r, rateRace)),
    );
    expect(outcomes.filter((o) => !o.duplicate)).toHaveLength(12);
    const counts = await db.query<{ races: number; results: number }>(
      `SELECT (SELECT count(*)::int FROM rated_races) AS races,
              (SELECT count(*)::int FROM race_results) AS results`,
    );
    expect(counts.rows[0]).toEqual({ races: 12, results: 36 });
    for (const id of ids) {
      const row = (await store.player(id))!;
      const { rows } = await db.query<{ before: number; after: number; delta: number }>(
        `SELECT rating_before AS before, rating_after AS after, rating_delta AS delta
         FROM race_results WHERE player_id = $1`,
        [id],
      );
      expect(row.races).toBe(rows.length);
      expect(row.rating).toBe(1000 + rows.reduce((sum, r) => sum + r.delta, 0));
      // No lost update: every race started from the rating the one before it left.
      const befores = rows.map((r) => r.before).sort((x, y) => x - y);
      const afters = [1000, ...rows.map((r) => r.after)];
      afters.splice(afters.indexOf(row.rating), 1);
      expect(befores).toEqual(afters.sort((x, y) => x - y));
    }
  });

  it('counts rematches inside the window less', async () => {
    const { store } = await storeWith();
    const [a, b] = await players(store, 2);
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(
        await store.applyRace(
          race(
            [
              { id: a, time: 45 },
              { id: b, time: 46 },
            ],
            at(i * 10),
          ),
          rateRace,
        ),
      );
    }
    // The sixth race is the pair's sixth in the window: five already shared, so half weight.
    const sixthA = results[5].changes.find((c) => c.id === a)!;
    const sixthB = results[5].changes.find((c) => c.id === b)!;
    const pair = (shared: number) =>
      rateRace(
        [
          { id: a, rating: sixthA.before, races: 5, finished: true, time: 45, dnfReason: null },
          { id: b, rating: sixthB.before, races: 5, finished: true, time: 46, dnfReason: null },
        ],
        () => shared,
      );
    expect([sixthA.delta, sixthB.delta]).toEqual(pair(5).map((c) => c.delta));
    expect(pair(5)[0].delta).toBeLessThan(pair(0)[0].delta);
    // The fifth race still counted fully.
    const fifthA = results[4].changes.find((c) => c.id === a)!;
    const fifthB = results[4].changes.find((c) => c.id === b)!;
    expect(fifthA.delta).toBe(
      rateRace([
        { id: a, rating: fifthA.before, races: 4, finished: true, time: 45, dnfReason: null },
        { id: b, rating: fifthB.before, races: 4, finished: true, time: 46, dnfReason: null },
      ])[0].delta,
    );
    // A day later the pair counts fully again.
    const nextDay = await store.applyRace(
      race(
        [
          { id: a, time: 45 },
          { id: b, time: 46 },
        ],
        at(60 + RATING_RULES.rematchWindowHours * 60),
      ),
      rateRace,
    );
    const pa = nextDay.changes.find((c) => c.id === a)!;
    const pb = nextDay.changes.find((c) => c.id === b)!;
    const unDamped = rateRace([
      { id: a, rating: pa.before, races: 6, finished: true, time: 45, dnfReason: null },
      { id: b, rating: pb.before, races: 6, finished: true, time: 46, dnfReason: null },
    ]);
    expect(pa.delta).toBe(unDamped[0].delta);
  });

  it('refuses a race for a player without a profile, and broken result rows', async () => {
    const { store, db } = await storeWith();
    const [a] = await players(store, 1);
    const record = race([
      { id: a, time: 45 },
      { id: newProfileId(), time: 46 },
    ]);
    await expect(store.applyRace(record, rateRace)).rejects.toBeInstanceOf(PermanentError);
    expect((await store.player(a))!.races).toBe(0);
    // The schema itself refuses inconsistent numbers.
    const broken = await db
      .query(
        `INSERT INTO race_results (race_id, player_id, position, finished, dnf_reason,
           total_time_ms, best_lap_ms, rating_before, rating_delta, rating_after, stats,
           completed_at)
         VALUES ($1, $2, 1, true, null, 45000, 15000, 1000, 10, 1020, '{}', now())`,
        [randomUUID(), a],
      )
      .then(
        () => null,
        (error: { code?: string }) => error.code,
      );
    expect(broken).toMatch(/^23/);
    await expect(
      db.query('UPDATE players SET wins = 3, podiums = 1, finished = 1, races = 1 WHERE id = $1', [
        a,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('ranks by rating, wins, age and id; pages and searches the leaderboard', async () => {
    const { store, db } = await storeWith();
    // Profiles made a minute apart; their numbers set directly.
    const made: string[] = [];
    const specs: [string, number, number][] = [
      ['Alpha', 1200, 3],
      ['beta', 1100, 2],
      ['Bravo', 1100, 2],
      ['Charlie', 1100, 5],
      ['Delta', 980, 0],
      ['Echo_1', 1000, 1],
    ];
    for (const [i, [name, rating, wins]] of specs.entries()) {
      const id = newProfileId();
      await store.createPlayer(id, name, hashSecret(`t${i}`), at(i));
      await db.query(
        `UPDATE players SET rating = $2, peak_rating = $2, wins = $3, podiums = $3,
           finished = $3 + 1, races = $3 + 2 WHERE id = $1`,
        [id, rating, wins],
      );
      made.push(id);
    }
    // Two more with exactly equal numbers and creation time: the id decides.
    const twins = [newProfileId(), newProfileId()].sort();
    for (const id of [...twins].reverse()) {
      await store.createPlayer(id, 'Twin', hashSecret(id), at(30));
      await db.query(
        `UPDATE players SET rating = 990, peak_rating = 990, races = 1 WHERE id = $1`,
        [id],
      );
    }
    // And one without a rated race: never on the board.
    const unranked = newProfileId();
    await store.createPlayer(unranked, 'Zed', hashSecret('z'), at(40));

    const order = ['Alpha', 'Charlie', 'beta', 'Bravo', 'Echo_1', 'Twin', 'Twin', 'Delta'];
    const page1 = await store.leaderboard(0, 5);
    const page2 = await store.leaderboard(5, 5);
    expect(page1.total).toBe(8);
    expect([...page1.rows, ...page2.rows].map((r) => r.nickname)).toEqual(order);
    expect([...page1.rows, ...page2.rows].map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(page2.rows.filter((r) => r.nickname === 'Twin').map((r) => r.id)).toEqual(twins);
    for (const row of [...page1.rows, ...page2.rows]) {
      expect(await store.rankOf(row.id)).toBe(row.rank);
    }
    expect(await store.rankOf(unranked)).toBeNull();

    // Prefix search, any case, with its global ranks; LIKE wildcards are plain text.
    const b = await store.search('b', 10);
    expect(b.map((r) => [r.nickname, r.rank])).toEqual([
      ['beta', 3],
      ['Bravo', 4],
    ]);
    expect((await store.search('ECHO_', 10)).map((r) => r.nickname)).toEqual(['Echo_1']);
    expect(await store.search('_', 10)).toEqual([]);
    expect(await store.search('%', 10)).toEqual([]);
    expect(await store.search('Zed', 10)).toEqual([]);
  });
});
