import {
  NICKNAME_CHANGES_PER_DAY,
  RATING_RULES,
  type RaceStats,
  type RatedRacer,
  type RatingChange,
} from '@circuit-breaker/shared';
import type { Db, Queryable } from '../db/db';
import { PermanentError } from '../db/errors';

/** A profile row, as the store reads it. */
export interface PlayerRow {
  id: string;
  nickname: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  rating: number;
  peakRating: number;
  races: number;
  finished: number;
  wins: number;
  podiums: number;
  bestLapMs: number | null;
  lastRaceAt: Date | null;
  hasRecovery: boolean;
  nameWindowStart: Date | null;
  nameChanges: number;
}

export interface RankedPlayer extends PlayerRow {
  rank: number;
}

export interface HistoryRow {
  raceId: string;
  completedAt: Date;
  laps: number;
  position: number;
  fieldSize: number;
  finished: boolean;
  dnfReason: 'left' | 'racing' | null;
  totalTimeMs: number | null;
  bestLapMs: number | null;
  ratingBefore: number;
  ratingDelta: number;
  ratingAfter: number;
}

/** One rated player's result in a race to store (the server's numbers, never a client's). */
export interface RaceRecordEntry {
  playerId: string;
  position: number;
  finished: boolean;
  dnfReason: 'left' | 'racing' | null;
  /** Seconds, from the simulation. */
  time: number | null;
  bestLap: number | null;
  stats: RaceStats;
}

export interface RaceRecord {
  /** The race's UUID: the idempotency key. */
  id: string;
  roomCode: string;
  sessionId: number;
  raceNumber: number;
  trackId: string;
  laps: number;
  fieldSize: number;
  startedAt: Date;
  completedAt: Date;
  entries: RaceRecordEntry[];
}

export type RateFn = (
  racers: RatedRacer[],
  shared: (a: string, b: string) => number,
) => RatingChange[];

export interface AppliedRace {
  /** The race had already been stored: nothing was applied again. */
  duplicate: boolean;
  /** Per player id. */
  changes: RatingChange[];
}

export interface RenameOutcome {
  player: PlayerRow;
  changed: boolean;
  /** Set when the change was refused for the daily limit: when it opens again. */
  blockedUntil: Date | null;
}

export interface StoreHooks {
  /** Tests only: runs inside a race's transaction, just before COMMIT. */
  beforeCommit?: (raceId: string) => void | Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A session and its profile are marked active at most this often (it saves a write a request). */
const TOUCH_EVERY_MS = 5 * 60 * 1000;

const columns = (t: string) =>
  `${t}.id, ${t}.nickname, ${t}.created_at, ${t}.last_active_at, ${t}.rating, ${t}.peak_rating,
   ${t}.races, ${t}.finished, ${t}.wins, ${t}.podiums, ${t}.best_lap_ms, ${t}.last_race_at,
   ${t}.recovery_hash IS NOT NULL AS has_recovery, ${t}.name_window_start, ${t}.name_changes`;

/**
 * The leaderboard order as one row: rating, then wins (both higher first, so negated), then
 * the older profile, then the id. Rows compare as tuples, so the order is total, and the
 * `players_rank` index (migration 2) holds exactly this row: "players ahead of me" is one
 * index range, and a page is a walk along it.
 */
const ORDER_KEY = (t: string) => `(-${t}.rating, -${t}.wins, ${t}.created_at, ${t}.id)`;
const ORDER_BY = (t: string) => `ORDER BY -${t}.rating, -${t}.wins, ${t}.created_at, ${t}.id`;
/** Players `p` ahead of `me`. */
const AHEAD = `${ORDER_KEY('p')} < ${ORDER_KEY('me')}`;
const LEADERBOARD_ORDER = ORDER_BY('p');

type Row = Record<string, unknown>;

const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));

function toPlayer(r: Row): PlayerRow {
  return {
    id: String(r.id),
    nickname: (r.nickname as string | null) ?? null,
    createdAt: date(r.created_at),
    lastActiveAt: date(r.last_active_at),
    rating: Number(r.rating),
    peakRating: Number(r.peak_rating),
    races: Number(r.races),
    finished: Number(r.finished),
    wins: Number(r.wins),
    podiums: Number(r.podiums),
    bestLapMs: r.best_lap_ms === null ? null : Number(r.best_lap_ms),
    lastRaceAt: r.last_race_at === null ? null : date(r.last_race_at),
    hasRecovery: Boolean(r.has_recovery),
    nameWindowStart: r.name_window_start === null ? null : date(r.name_window_start),
    nameChanges: Number(r.name_changes),
  };
}

const ms = (seconds: number | null) => (seconds === null ? null : Math.round(seconds * 1000));

/** Escapes LIKE's wildcards in user text. */
const likePrefix = (text: string) => `${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Every read and write of profiles, sessions and rated races: plain SQL over a Db. Writes that
 * touch more than one row run in one transaction. The store trusts its callers to have
 * validated input; the database's constraints are the last line.
 */
export class RankingStore {
  constructor(
    readonly db: Db,
    private readonly hooks: StoreHooks = {},
  ) {}

  // --- Identity -----------------------------------------------------------------------------

  /** A new profile, with the session of the browser that asked for it. */
  async createPlayer(
    id: string,
    nickname: string | null,
    tokenHash: string,
    now: Date,
  ): Promise<PlayerRow> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO players AS p (id, nickname, created_at, last_active_at)
         VALUES ($1, $2, $3, $3) RETURNING ${columns('p')}`,
        [id, nickname, now],
      );
      await tx.query(
        `INSERT INTO player_sessions (token_hash, player_id, created_at, last_seen_at)
         VALUES ($1, $2, $3, $3)`,
        [tokenHash, id, now],
      );
      return toPlayer(rows[0]);
    });
  }

  /** The profile a browser's session belongs to, or null; marks both as active. */
  async playerBySession(tokenHash: string, now: Date): Promise<PlayerRow | null> {
    const { rows } = await this.db.query(
      `SELECT ${columns('p')}, s.last_seen_at AS session_seen
       FROM player_sessions s JOIN players p ON p.id = s.player_id
       WHERE s.token_hash = $1`,
      [tokenHash],
    );
    if (rows.length === 0) return null;
    const player = toPlayer(rows[0]);
    if (now.getTime() - date(rows[0].session_seen).getTime() > TOUCH_EVERY_MS) {
      await this.db.query('UPDATE player_sessions SET last_seen_at = $2 WHERE token_hash = $1', [
        tokenHash,
        now,
      ]);
      await this.touch(player.id, now);
      if (now > player.lastActiveAt) player.lastActiveAt = now;
    }
    return player;
  }

  async addSession(playerId: string, tokenHash: string, now: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO player_sessions (token_hash, player_id, created_at, last_seen_at)
       VALUES ($1, $2, $3, $3)`,
      [tokenHash, playerId, now],
    );
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.query('DELETE FROM player_sessions WHERE token_hash = $1', [tokenHash]);
  }

  async playerByRecovery(codeHash: string): Promise<PlayerRow | null> {
    const { rows } = await this.db.query(
      `SELECT ${columns('p')} FROM players p WHERE p.recovery_hash = $1`,
      [codeHash],
    );
    return rows.length === 0 ? null : toPlayer(rows[0]);
  }

  /**
   * A new recovery code (only its hash) replaces the old one, and every other browser's
   * session ends: a copied old code, or a browser signed in with it, stops working.
   */
  async replaceRecovery(
    playerId: string,
    codeHash: string,
    keepTokenHash: string,
    now: Date,
  ): Promise<PlayerRow> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE players p SET recovery_hash = $2, recovery_created_at = $3
         WHERE p.id = $1 RETURNING ${columns('p')}`,
        [playerId, codeHash, now],
      );
      await tx.query('DELETE FROM player_sessions WHERE player_id = $1 AND token_hash <> $2', [
        playerId,
        keepTokenHash,
      ]);
      if (rows.length === 0) throw new Error('profile not found');
      return toPlayer(rows[0]);
    });
  }

  /**
   * Renames a profile. Naming one that has no name is free; after that, `perDay` changes in a
   * rolling 24-hour window that starts at the first change. The row is locked, so two renames
   * at once cannot both slip under the limit.
   */
  async rename(
    playerId: string,
    nickname: string,
    now: Date,
    perDay = NICKNAME_CHANGES_PER_DAY,
  ): Promise<RenameOutcome> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${columns('p')} FROM players p WHERE p.id = $1 FOR UPDATE`,
        [playerId],
      );
      if (rows.length === 0) throw new Error('profile not found');
      const player = toPlayer(rows[0]);
      if (player.nickname === nickname) return { player, changed: false, blockedUntil: null };
      let windowStart = player.nameWindowStart;
      let changes = player.nameChanges;
      if (player.nickname !== null) {
        const open = windowStart !== null && now.getTime() - windowStart.getTime() < DAY_MS;
        if (!open) {
          windowStart = now;
          changes = 0;
        }
        if (changes >= perDay) {
          return {
            player,
            changed: false,
            blockedUntil: new Date(windowStart!.getTime() + DAY_MS),
          };
        }
        changes += 1;
      }
      const updated = await tx.query(
        `UPDATE players p SET nickname = $2, name_window_start = $3, name_changes = $4
         WHERE p.id = $1 RETURNING ${columns('p')}`,
        [playerId, nickname, windowStart, changes],
      );
      return { player: toPlayer(updated.rows[0]), changed: true, blockedUntil: null };
    });
  }

  async touch(playerId: string, now: Date): Promise<void> {
    await this.db.query(
      'UPDATE players SET last_active_at = greatest(last_active_at, $2) WHERE id = $1',
      [playerId, now],
    );
  }

  // --- Reads ----------------------------------------------------------------------------------

  async player(id: string): Promise<PlayerRow | null> {
    const { rows } = await this.db.query(`SELECT ${columns('p')} FROM players p WHERE p.id = $1`, [
      id,
    ]);
    return rows.length === 0 ? null : toPlayer(rows[0]);
  }

  /** Place on the leaderboard (1 = top); null for a profile without a rated race. */
  async rankOf(id: string, q: Queryable = this.db): Promise<number | null> {
    const { rows } = await q.query<{ rank: number; races: number }>(
      `SELECT me.races, (SELECT count(*)::int + 1 FROM players p
                         WHERE p.races > 0 AND (${AHEAD})) AS rank
       FROM players me WHERE me.id = $1`,
      [id],
    );
    if (rows.length === 0 || Number(rows[0].races) === 0) return null;
    return Number(rows[0].rank);
  }

  /** One page of the leaderboard, ranked in order, and how many profiles are on it. */
  async leaderboard(
    offset: number,
    limit: number,
  ): Promise<{ total: number; rows: RankedPlayer[] }> {
    const total = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM players WHERE races > 0',
    );
    const { rows } = await this.db.query(
      `SELECT ${columns('p')} FROM players p WHERE p.races > 0
       ${LEADERBOARD_ORDER} LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return {
      total: Number(total.rows[0].n),
      rows: rows.map((r, i) => ({ ...toPlayer(r), rank: offset + i + 1 })),
    };
  }

  /**
   * Ranked profiles whose nickname starts with `prefix` (any case). The matches come from the
   * name index first (a prefix range); the best `limit` of them are ranked together, in one
   * walk along the leaderboard index up to the last of them. (Left to itself, the planner
   * walked the whole leaderboard testing every name, then counted each result's rank anew.)
   */
  async search(prefix: string, limit: number): Promise<RankedPlayer[]> {
    const { rows } = await this.db.query(
      `WITH hits AS MATERIALIZED (
         SELECT ${columns('me')} FROM players me
         WHERE me.races > 0 AND lower(me.nickname) LIKE lower($1) ESCAPE '\\'
       ),
       best AS MATERIALIZED (SELECT * FROM hits h ${ORDER_BY('h')} LIMIT $2),
       last AS (SELECT * FROM best b ORDER BY -b.rating DESC, -b.wins DESC, b.created_at DESC,
                b.id DESC LIMIT 1),
       ranked AS (
         SELECT p.id, row_number() OVER (${ORDER_BY('p')}) AS rank
         FROM last JOIN players p ON p.races > 0 AND ${ORDER_KEY('p')} <= ${ORDER_KEY('last')}
       )
       SELECT best.*, ranked.rank FROM best JOIN ranked ON ranked.id = best.id
       ${ORDER_BY('best')}`,
      [likePrefix(prefix), limit],
    );
    return rows.map((r) => ({ ...toPlayer(r), rank: Number(r.rank) }));
  }

  /** A profile's most recent rated races, newest first. */
  async history(playerId: string, limit: number): Promise<HistoryRow[]> {
    const { rows } = await this.db.query(
      `SELECT r.race_id, r.completed_at, rr.laps, r.position, rr.field_size, r.finished,
              r.dnf_reason, r.total_time_ms, r.best_lap_ms, r.rating_before, r.rating_delta,
              r.rating_after
       FROM race_results r JOIN rated_races rr ON rr.id = r.race_id
       WHERE r.player_id = $1 ORDER BY r.completed_at DESC, r.race_id LIMIT $2`,
      [playerId, limit],
    );
    return rows.map((r) => ({
      raceId: String(r.race_id),
      completedAt: date(r.completed_at),
      laps: Number(r.laps),
      position: Number(r.position),
      fieldSize: Number(r.field_size),
      finished: Boolean(r.finished),
      dnfReason: (r.dnf_reason as 'left' | 'racing' | null) ?? null,
      totalTimeMs: r.total_time_ms === null ? null : Number(r.total_time_ms),
      bestLapMs: r.best_lap_ms === null ? null : Number(r.best_lap_ms),
      ratingBefore: Number(r.rating_before),
      ratingDelta: Number(r.rating_delta),
      ratingAfter: Number(r.rating_after),
    }));
  }

  // --- Races ----------------------------------------------------------------------------------

  /**
   * Stores one rated race and applies it to its players, all in one transaction, at most once:
   * the race id is the primary key of `rated_races`, so a second write of the same race finds
   * it and returns the changes stored the first time. The players' rows are locked in id
   * order, so races finishing at the same moment queue instead of overwriting each other.
   * `rate` computes the changes from the locked ratings.
   */
  async applyRace(race: RaceRecord, rate: RateFn): Promise<AppliedRace> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO rated_races (id, room_code, session_id, race_number, track_id, laps,
                                  field_size, rated_players, started_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [
          race.id,
          race.roomCode,
          race.sessionId,
          race.raceNumber,
          race.trackId,
          race.laps,
          race.fieldSize,
          race.entries.length,
          race.startedAt,
          race.completedAt,
        ],
      );
      if (inserted.rows.length === 0) {
        return { duplicate: true, changes: await this.storedChanges(tx, race.id) };
      }

      const ids = race.entries.map((e) => e.playerId).sort();
      const locked = await tx.query<{ id: string; rating: number; races: number }>(
        `SELECT id, rating, races FROM players WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
        [ids],
      );
      if (locked.rows.length !== ids.length)
        throw new PermanentError('a rated player has no profile');
      const current = new Map(locked.rows.map((r) => [r.id, r]));

      // Rated races each pair already had together in the rematch window (see RATING_RULES).
      const since = new Date(race.completedAt.getTime() - RATING_RULES.rematchWindowHours * 3.6e6);
      const pairs = await tx.query<{ a: string; b: string; n: number }>(
        `SELECT x.player_id AS a, y.player_id AS b, count(*)::int AS n
         FROM race_results x
         JOIN race_results y ON y.race_id = x.race_id AND y.player_id > x.player_id
         WHERE x.player_id = ANY($1::text[]) AND y.player_id = ANY($1::text[])
           AND x.completed_at > $2
         GROUP BY x.player_id, y.player_id`,
        [ids, since],
      );
      const shared = new Map(pairs.rows.map((r) => [`${r.a} ${r.b}`, Number(r.n)]));
      const sharedRaces = (a: string, b: string) =>
        shared.get(a < b ? `${a} ${b}` : `${b} ${a}`) ?? 0;

      const changes = rate(
        race.entries.map((e) => {
          const row = current.get(e.playerId)!;
          return {
            id: e.playerId,
            rating: Number(row.rating),
            races: Number(row.races),
            finished: e.finished,
            time: e.time,
            dnfReason: e.dnfReason,
          };
        }),
        sharedRaces,
      );
      const byPlayer = new Map(changes.map((c) => [c.id, c]));

      const values: unknown[] = [];
      const tuples: string[] = [];
      for (const e of race.entries) {
        const change = byPlayer.get(e.playerId)!;
        const won = e.finished && e.position === 1;
        const podium = e.finished && e.position <= 3;
        await tx.query(
          `UPDATE players SET rating = $2, peak_rating = greatest(peak_rating, $2),
             races = races + 1, finished = finished + $3, wins = wins + $4,
             podiums = podiums + $5, best_lap_ms = least(best_lap_ms, $6::int),
             last_race_at = $7, last_active_at = greatest(last_active_at, $7)
           WHERE id = $1`,
          [
            e.playerId,
            change.after,
            e.finished ? 1 : 0,
            won ? 1 : 0,
            podium ? 1 : 0,
            ms(e.bestLap),
            race.completedAt,
          ],
        );
        const row = [
          race.id,
          e.playerId,
          e.position,
          e.finished,
          e.finished ? null : e.dnfReason,
          e.finished ? ms(e.time) : null,
          ms(e.bestLap),
          change.before,
          change.delta,
          change.after,
          JSON.stringify(e.stats),
          race.completedAt,
        ];
        const at = values.length;
        tuples.push(
          `(${row.map((_, i) => `$${at + i + 1}${i === 10 ? '::jsonb' : ''}`).join(', ')})`,
        );
        values.push(...row);
      }
      await tx.query(
        `INSERT INTO race_results (race_id, player_id, position, finished, dnf_reason,
           total_time_ms, best_lap_ms, rating_before, rating_delta, rating_after, stats,
           completed_at)
         VALUES ${tuples.join(', ')}`,
        values,
      );
      await this.hooks.beforeCommit?.(race.id);
      return { duplicate: false, changes };
    });
  }

  /** The changes a stored race applied (for a duplicate write). */
  private async storedChanges(q: Queryable, raceId: string): Promise<RatingChange[]> {
    const { rows } = await q.query<Row>(
      `SELECT player_id, rating_before, rating_delta, rating_after
       FROM race_results WHERE race_id = $1 ORDER BY player_id`,
      [raceId],
    );
    return rows.map((r) => ({
      id: String(r.player_id),
      before: Number(r.rating_before),
      delta: Number(r.rating_delta),
      after: Number(r.rating_after),
    }));
  }

  /** Database reachable? (`/health`) */
  async ping(): Promise<void> {
    await this.db.query('SELECT 1');
  }
}
