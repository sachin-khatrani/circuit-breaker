import { createHash } from 'node:crypto';
import type { Db } from './db';
import { PermanentError } from './errors';

/**
 * Schema migrations. SQL lives in TypeScript so the server bundle carries it (no files to
 * ship beside dist/). Each migration has a reversing `down`. Never edit one that has been
 * applied anywhere: add a new one (the runner refuses to start on a changed checksum).
 */
export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'profiles, sessions, rated races',
    up: `
CREATE TABLE players (
  id                  text PRIMARY KEY,
  nickname            text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_active_at      timestamptz NOT NULL DEFAULT now(),
  rating              integer NOT NULL DEFAULT 1000,
  peak_rating         integer NOT NULL DEFAULT 1000,
  races               integer NOT NULL DEFAULT 0,
  finished            integer NOT NULL DEFAULT 0,
  wins                integer NOT NULL DEFAULT 0,
  podiums             integer NOT NULL DEFAULT 0,
  best_lap_ms         integer,
  last_race_at        timestamptz,
  recovery_hash       text UNIQUE,
  recovery_created_at timestamptz,
  name_window_start   timestamptz,
  name_changes        integer NOT NULL DEFAULT 0,
  CONSTRAINT players_counts CHECK (
    0 <= wins AND wins <= podiums AND podiums <= finished AND finished <= races),
  CONSTRAINT players_rating CHECK (rating >= 0 AND peak_rating >= rating),
  CONSTRAINT players_nickname CHECK (nickname IS NULL OR char_length(nickname) BETWEEN 1 AND 16)
);
CREATE INDEX players_leaderboard ON players (rating DESC, wins DESC, created_at, id)
  WHERE races > 0;
CREATE INDEX players_nickname_search ON players (lower(nickname) text_pattern_ops)
  WHERE races > 0;

CREATE TABLE player_sessions (
  token_hash   text PRIMARY KEY,
  player_id    text NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX player_sessions_player ON player_sessions (player_id);

CREATE TABLE rated_races (
  id            uuid PRIMARY KEY,
  room_code     text NOT NULL,
  session_id    integer NOT NULL,
  race_number   integer NOT NULL,
  track_id      text NOT NULL,
  laps          integer NOT NULL,
  field_size    integer NOT NULL,
  rated_players integer NOT NULL,
  started_at    timestamptz NOT NULL,
  completed_at  timestamptz NOT NULL,
  CONSTRAINT rated_races_size CHECK (rated_players BETWEEN 2 AND field_size AND field_size <= 8)
);

CREATE TABLE race_results (
  race_id       uuid NOT NULL REFERENCES rated_races (id) ON DELETE CASCADE,
  player_id     text NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  position      integer NOT NULL,
  finished      boolean NOT NULL,
  dnf_reason    text,
  total_time_ms integer,
  best_lap_ms   integer,
  rating_before integer NOT NULL,
  rating_delta  integer NOT NULL,
  rating_after  integer NOT NULL,
  stats         jsonb NOT NULL,
  completed_at  timestamptz NOT NULL,
  PRIMARY KEY (race_id, player_id),
  CONSTRAINT race_results_position CHECK (position BETWEEN 1 AND 8),
  CONSTRAINT race_results_rating CHECK (rating_after = rating_before + rating_delta),
  CONSTRAINT race_results_outcome CHECK (
    (finished AND dnf_reason IS NULL AND total_time_ms IS NOT NULL)
    OR (NOT finished AND dnf_reason IN ('left', 'racing') AND total_time_ms IS NULL))
);
CREATE INDEX race_results_player ON race_results (player_id, completed_at DESC);
`,
    down: `
DROP TABLE race_results;
DROP TABLE rated_races;
DROP TABLE player_sessions;
DROP TABLE players;
`,
  },
  {
    version: 2,
    name: 'leaderboard order as one index range',
    // Ranks, pages and searches read the leaderboard order (rating and wins descending, then
    // the older profile, then the id). Stored as negated values, that order is one ascending
    // row, so "every profile ahead of this one" is a single index range instead of an OR of
    // two (Step 9: 100,000 profiles, a search ranking 20 names went from ~140 ms to a few).
    up: `
CREATE INDEX players_rank ON players ((-rating), (-wins), created_at, id) WHERE races > 0;
DROP INDEX players_leaderboard;
`,
    down: `
CREATE INDEX players_leaderboard ON players (rating DESC, wins DESC, created_at, id)
  WHERE races > 0;
DROP INDEX players_rank;
`,
  },
];

/** Any constant will do: every server that migrates this database takes the same lock. */
const MIGRATION_LOCK = 0x43_42_38;

const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex').slice(0, 16);

const LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    integer PRIMARY KEY,
  name       text NOT NULL,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

interface Applied {
  version: number;
  checksum: string;
}

/**
 * Applies every pending migration in one transaction, holding an advisory lock so two servers
 * starting together cannot both migrate (the second waits, then finds nothing to do). Throws,
 * having changed nothing, if an applied migration's SQL no longer matches its checksum.
 */
export async function migrate(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<number[]> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await tx.exec(LEDGER);
    const { rows } = await tx.query<Applied>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const m of migrations) {
      const known = applied.get(m.version);
      if (known !== undefined && known !== checksum(m.up)) {
        throw new PermanentError(
          `migration ${m.version} (${m.name}) was changed after it was applied`,
        );
      }
    }
    const done: number[] = [];
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(m.version)) continue;
      await tx.exec(m.up);
      await tx.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [m.version, m.name, checksum(m.up)],
      );
      done.push(m.version);
    }
    return done;
  });
}

/** Undoes the newest applied migration (destructive: its tables and data go). */
export async function rollbackLatest(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<number | null> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await tx.exec(LEDGER);
    const { rows } = await tx.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
    );
    if (rows.length === 0) return null;
    const version = rows[0].version;
    const m = migrations.find((x) => x.version === version);
    if (!m) throw new PermanentError(`migration ${version} is applied but unknown to this build`);
    await tx.exec(m.down);
    await tx.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
    return version;
  });
}

/** Applied and pending versions, for `db:status`. */
export async function migrationStatus(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<{ applied: number[]; pending: number[] }> {
  await db.exec(LEDGER);
  const { rows } = await db.query<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  const applied = rows.map((r) => r.version);
  const pending = migrations.map((m) => m.version).filter((v) => !applied.includes(v));
  return { applied, pending };
}
