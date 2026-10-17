/**
 * Leaderboard and profile queries on a large table. Seeds a throwaway schema in
 * TEST_DATABASE_URL with N profiles (default 100,000) and their rated races, then times every
 * store call an API request makes (p50 and p99 of repeated runs) through the real store code,
 * and prints the plan of the heaviest ones. The schema is dropped at the end; nothing else in
 * the database is read or changed.
 *
 *   npm run dbbench -w @circuit-breaker/server -- --players 100000 --races 50000
 */
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { rateRace } from '@circuit-breaker/shared';
import { createPgDb, type Db } from '../src/db/db';
import { migrate } from '../src/db/migrations';
import { RankingStore, type RaceRecord } from '../src/ranking/store';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/** SQL for the profile id seeded for the number `n` (an SQL expression). */
const id = (n: string) => `upper(substr(md5((${n})::text), 1, 16))`;

async function seed(db: Db, players: number, races: number): Promise<void> {
  // About 5% of profiles never finished a rated race (they are not on the leaderboard).
  await db.query(
    `INSERT INTO players (id, nickname, created_at, last_active_at, rating, peak_rating, races,
                          finished, wins, podiums, best_lap_ms, last_race_at)
     SELECT ${id('g')},
            (array['Nova','Vex','Kai','Ana','Ben','Cyd','Zed','Lux','Ray','Max'])[1 + g % 10]
              || ' ' || (g % 9973),
            now() - (g % 365) * interval '1 day' - (g % 86400) * interval '1 second', now(),
            r.rating, r.rating + g % 40, c.races, c.finished, c.finished / 8, c.finished / 3,
            40000 + g % 9000, now()
     FROM generate_series(1, $1::int) g,
          LATERAL (SELECT greatest(100, 1000 + round(170 * (random() + random() + random() - 1.5)
                     * 2))::int AS rating) r,
          LATERAL (SELECT CASE WHEN g % 20 = 0 THEN 0 ELSE 1 + g % 200 END AS races) n,
          LATERAL (SELECT n.races, greatest(0, n.races - g % 3) AS finished) c`,
    [players],
  );
  await db.query(
    `INSERT INTO rated_races (id, room_code, session_id, race_number, track_id, laps, field_size,
                              rated_players, started_at, completed_at)
     SELECT md5('race' || k)::uuid, 'BENCH1', 1, 1, 'grid-zero', 3, 4, 4,
            now() - k * interval '1 minute' - interval '3 minutes', now() - k * interval '1 minute'
     FROM generate_series(1, $1::int) k`,
    [races],
  );
  await db.query(
    `INSERT INTO race_results (race_id, player_id, position, finished, dnf_reason, total_time_ms,
                               best_lap_ms, rating_before, rating_delta, rating_after, stats,
                               completed_at)
     SELECT md5('race' || k)::uuid, ${id('(k * 4 + j) % $2::int + 1')}, j + 1, true, null,
            130000 + j * 1000, 43000, 1000, 0, 1000, '{}'::jsonb, now() - k * interval '1 minute'
     FROM generate_series(1, $1::int) k, generate_series(0, 3) j`,
    [races, players],
  );
  await db.query(
    `INSERT INTO player_sessions (token_hash, player_id)
     SELECT md5('session' || g), ${id('g')} FROM generate_series(1, 1000) g WHERE g % 20 <> 0`,
  );
  // A live database is vacuumed by autovacuum; a fresh bulk load is not, so do it once here.
  await db.exec('VACUUM ANALYZE');
}

async function time(label: string, runs: number, fn: (i: number) => Promise<unknown>) {
  await fn(0);
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn(i + 1);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
  console.log(
    `  ${label.padEnd(44)} p50 ${q(0.5).toFixed(2).padStart(7)} ms   p99 ${q(0.99).toFixed(2).padStart(7)} ms`,
  );
  return { label, p50: q(0.5), p99: q(0.99) };
}

async function main(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url)
    throw new Error('Set TEST_DATABASE_URL (a database the benchmark may add a schema to).');
  if (url === process.env.DATABASE_URL)
    throw new Error('TEST_DATABASE_URL must not be DATABASE_URL.');
  const players = Number(arg('players', '100000'));
  const races = Number(arg('races', '50000'));
  const runs = Number(arg('runs', '40'));
  const schema = `cb_bench_${randomBytes(6).toString('hex')}`;
  const admin = createPgDb({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const db = createPgDb({
    connectionString: scoped.toString(),
    max: 4,
    statementTimeoutMs: 60_000,
  });
  try {
    await migrate(db);
    const t0 = performance.now();
    await seed(db, players, races);
    const counts = await db.query<{ p: number; r: number; rr: number }>(
      `SELECT (SELECT count(*)::int FROM players) AS p, (SELECT count(*)::int FROM rated_races) AS r,
              (SELECT count(*)::int FROM race_results) AS rr`,
    );
    console.log(
      `seeded ${counts.rows[0].p} profiles, ${counts.rows[0].r} rated races, ` +
        `${counts.rows[0].rr} result rows in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
    );
    const store = new RankingStore(db);
    const ranked = await db.query<{ id: string }>(
      `SELECT id FROM players WHERE races > 0 ORDER BY rating DESC, wins DESC, created_at, id`,
    );
    const at = (f: number) => ranked.rows[Math.floor(f * (ranked.rows.length - 1))].id;
    const [top, median, bottom] = [at(0), at(0.5), at(1)];
    const session = (
      await db.query<{ token_hash: string }>('SELECT token_hash FROM player_sessions LIMIT 1')
    ).rows[0].token_hash;
    console.log(`timing each call ${runs} times (after one warm-up run):`);
    const results = [
      await time('leaderboard page 1 (count + 25 rows)', runs, () => store.leaderboard(0, 25)),
      await time('leaderboard offset 5,000', runs, () => store.leaderboard(5000, 25)),
      await time('leaderboard offset 10,000 (the deepest allowed)', runs, () =>
        store.leaderboard(10_000, 25),
      ),
      await time('rank of the leader', runs, () => store.rankOf(top)),
      await time('rank of the median profile', runs, () => store.rankOf(median)),
      await time('rank of the last profile', runs, () => store.rankOf(bottom)),
      await time('search "nova" (10% of names match)', runs, () => store.search('nova', 20)),
      await time('search "nova 12" (a few match)', runs, () => store.search('nova 12', 20)),
      await time('search "qq" (nothing matches)', runs, () => store.search('qq', 20)),
      await time('profile by id', runs, () => store.player(median)),
      await time('race history (10 rows)', runs, () => store.history(median, 10)),
      await time('profile by session cookie', runs, () =>
        store.playerBySession(session, new Date(0)),
      ),
      await time('rate a 4-player race (one transaction)', runs, (i) => {
        const record: RaceRecord = {
          id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          roomCode: 'BENCH2',
          sessionId: 1,
          raceNumber: i + 1,
          trackId: 'grid-zero',
          laps: 3,
          fieldSize: 4,
          startedAt: new Date(Date.now() - 180_000),
          completedAt: new Date(),
          entries: [0.1, 0.3, 0.6, 0.9].map((f, position) => ({
            playerId: at(f),
            position: position + 1,
            finished: true,
            dnfReason: null,
            time: 130 + position,
            bestLap: 43,
            stats: {
              boosts: 0,
              overdrives: 0,
              shortcuts: 0,
              gateShifts: 0,
              shortcutRuns: 0,
              energy: 0,
              driftSeconds: 0,
              topSpeed: 0,
              wallHits: 0,
            },
          })),
        };
        return store.applyRace(record, rateRace);
      }),
    ];
    // The same calls as Step 8 made them (its SQL, with its index back), for comparison in this
    // same database.
    await db.exec(`CREATE INDEX step8_leaderboard ON players (rating DESC, wins DESC, created_at, id)
                     WHERE races > 0; ANALYZE players`);
    const step8Ahead = `(p.rating, p.wins) > (me.rating, me.wins)
      OR ((p.rating, p.wins) = (me.rating, me.wins) AND (p.created_at, p.id) < (me.created_at, me.id))`;
    const step8Search = (prefix: string) =>
      db.query(
        `SELECT me.id, (SELECT count(*)::int + 1 FROM players p WHERE p.races > 0 AND (${step8Ahead})) AS rank
         FROM players me WHERE me.races > 0 AND lower(me.nickname) LIKE lower($1) ESCAPE '\\'
         ORDER BY me.rating DESC, me.wins DESC, me.created_at, me.id LIMIT 20`,
        [`${prefix}%`],
      );
    console.log('the same calls with the Step 8 SQL and index:');
    results.push(
      await time('Step 8: rank of the median profile', runs, () =>
        db.query(
          `SELECT me.races, (SELECT count(*)::int + 1 FROM players p WHERE p.races > 0 AND (${step8Ahead})) AS rank
           FROM players me WHERE me.id = $1`,
          [median],
        ),
      ),
      await time('Step 8: search "nova"', runs, () => step8Search('nova')),
      await time('Step 8: search "nova 12"', runs, () => step8Search('nova 12')),
      await time('Step 8: search "qq"', runs, () => step8Search('qq')),
    );
    await db.exec('DROP INDEX step8_leaderboard');

    // The plans of the heaviest calls.
    const explain = async (label: string, sql: string, params: unknown[]) => {
      const plan = await db.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
        params,
      );
      console.log(`\nplan: ${label}`);
      for (const row of plan.rows) console.log(`  ${row['QUERY PLAN']}`);
    };
    const ahead = `(-p.rating, -p.wins, p.created_at, p.id) < (-me.rating, -me.wins, me.created_at, me.id)`;
    await explain(
      'rank of the median profile',
      `SELECT me.races, (SELECT count(*)::int + 1 FROM players p WHERE p.races > 0 AND ${ahead}) AS rank
       FROM players me WHERE me.id = $1`,
      [median],
    );
    await explain(
      'search "nova"',
      `WITH hits AS MATERIALIZED (
         SELECT me.id, me.rating, me.wins, me.created_at FROM players me
         WHERE me.races > 0 AND lower(me.nickname) LIKE lower($1) ESCAPE '\\'
       ),
       best AS MATERIALIZED (SELECT * FROM hits h ORDER BY -h.rating, -h.wins, h.created_at, h.id LIMIT 20),
       last AS (SELECT * FROM best b ORDER BY -b.rating DESC, -b.wins DESC, b.created_at DESC, b.id DESC LIMIT 1),
       ranked AS (
         SELECT p.id, row_number() OVER (ORDER BY -p.rating, -p.wins, p.created_at, p.id) AS rank
         FROM last JOIN players p ON p.races > 0
           AND (-p.rating, -p.wins, p.created_at, p.id) <= (-last.rating, -last.wins, last.created_at, last.id)
       )
       SELECT best.id, ranked.rank FROM best JOIN ranked ON ranked.id = best.id
       ORDER BY -best.rating, -best.wins, best.created_at, best.id`,
      ['nova%'],
    );
    console.log(`\n${JSON.stringify(results)}`);
  } finally {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
