import {
  NICKNAME_CHANGES_PER_DAY,
  profileTag,
  rateRace,
  sanitizeNickname,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type OwnProfile,
  type PlayerResponse,
  type PublicProfile,
  type RaceHistoryEntry,
  type RaceRating,
  type RecoveryCodeResponse,
  type SearchResponse,
  type TicketResponse,
} from '@circuit-breaker/shared';
import { describeDbError, isPermanentFailure } from '../db/errors';
import { migrate } from '../db/migrations';
import {
  hashSecret,
  isProfileId,
  isSessionToken,
  newProfileId,
  newRecoveryCode,
  newSessionToken,
  newTicket,
  normalizeRecoveryCode,
} from './identity';
import type { HistoryRow, PlayerRow, RankedPlayer, RankingStore, RaceRecord } from './store';
import type { CompletedRace, CompletedRaceEntry, RaceRatingSink, SeatProfile } from './types';

/** A refusal the API turns into an HTTP status and a message for the player. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RankingOptions {
  /** Wall clock (tests move it). */
  now?: () => Date;
  /** Waits between attempts to write a race (ms); the last one repeats. */
  retryDelaysMs?: readonly number[];
  /** A race's rating is given up this long after the race finished (ms). */
  retryForMs?: number;
  /** Run pending migrations when started (else they must already be applied). */
  migrateOnStart?: boolean;
  /** Retry the first connection (and migrations) this often while the database is away. */
  startRetryMs?: number;
  /** Log lines, written `[scope] message`, with a level for the ones worth attention. */
  log?: (line: string, level?: 'info' | 'warn' | 'error') => void;
}

export interface RankingHealth {
  enabled: boolean;
  database: 'off' | 'starting' | 'ok' | 'down';
  /** Rated races waiting for the database. */
  pending: number;
}

/** Results for a player's own reply: their profile, and their nickname change, if any. */
export interface RenameResult {
  player: OwnProfile;
  changed: boolean;
  /** Why the nickname did not change (the daily limit), else null. */
  note: string | null;
}

interface Job {
  race: CompletedRace;
  rated: CompletedRaceEntry[];
  unrated: { id: string; reason: string }[];
  notify: (rating: RaceRating) => void;
  attempts: number;
  giveUpAt: number;
}

const TICKET_TTL_MS = 60_000;
const MAX_TICKETS = 20_000;
/** Races that may wait for the database at once; past this a race's rating is not kept. */
const MAX_QUEUE = 1000;
const LEADERBOARD_MAX_LIMIT = 50;
const LEADERBOARD_MAX_OFFSET = 10_000;
const SEARCH_LIMIT = 20;
const HISTORY_LIMIT = 10;

const UNAVAILABLE = 'Rankings are unavailable right now. Races still work.';
const OFF = 'Global ranking is not set up on this server.';
export const NO_PROFILE = 'No profile on this browser yet.';

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

/**
 * Persistent profiles, the leaderboard and race ratings. The HTTP API calls it for profiles
 * and the leaderboard; rooms hand it finished races (RaceRatingSink). Rating writes go through
 * one queue, in the order races finished, and are retried while the database is away; a
 * rating is reported to the room only once the database has committed it.
 */
export class RankingService implements RaceRatingSink {
  readonly enabled: boolean;
  private ready = false;
  private database: RankingHealth['database'];
  private readonly tickets = new Map<string, { profile: SeatProfile; expires: number }>();
  private ticketsSweptAt = 0;
  private readonly queue: Job[] = [];
  private working: Promise<void> | null = null;
  private closing = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;
  private readonly retryDelays: readonly number[];
  private readonly retryForMs: number;
  private readonly log: (line: string, level?: 'info' | 'warn' | 'error') => void;

  constructor(
    private readonly store: RankingStore | null,
    private readonly options: RankingOptions = {},
  ) {
    this.enabled = store !== null;
    this.database = this.enabled ? 'starting' : 'off';
    this.now = options.now ?? (() => new Date());
    this.retryDelays = options.retryDelaysMs ?? [2000, 5000, 10_000, 20_000, 30_000, 60_000];
    this.retryForMs = options.retryForMs ?? 10 * 60_000;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /**
   * Connects (and migrates, if asked). While the database cannot be reached it keeps trying
   * in the background: the game runs meanwhile, with ranking unavailable.
   */
  async start(): Promise<void> {
    if (!this.store || this.ready || this.closing) return;
    try {
      if (this.options.migrateOnStart ?? true) {
        const applied = await migrate(this.store.db);
        this.log(
          `[db] migrations: ${applied.length > 0 ? `applied ${applied.join(', ')}` : 'up to date'}`,
        );
      } else {
        await this.store.ping();
      }
      this.ready = true;
      this.database = 'ok';
      this.pingTimer ??= setInterval(() => void this.ping(), 30_000);
      this.pingTimer.unref?.();
      void this.work();
    } catch (error) {
      this.database = 'down';
      if (isPermanentFailure(error)) {
        this.log(`[db] ranking disabled: ${describeDbError(error)}`, 'error');
        return;
      }
      const wait = this.options.startRetryMs ?? 15_000;
      this.log(
        `[db] not reachable (${describeDbError(error)}); retrying in ${wait / 1000} s`,
        'warn',
      );
      this.startTimer = setTimeout(() => void this.start(), wait);
      this.startTimer.unref?.();
    }
  }

  health(): RankingHealth {
    return { enabled: this.enabled, database: this.database, pending: this.queue.length };
  }

  /** Stops taking work, waits up to `timeoutMs` for the write in flight, closes the pool. */
  async close(timeoutMs = 5000): Promise<void> {
    this.closing = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.working) {
      await Promise.race([this.working, new Promise((r) => setTimeout(r, timeoutMs))]);
    }
    if (this.queue.length > 0) {
      this.log(
        `[ranking] shutting down with ${this.queue.length} race rating(s) not saved: ` +
          this.queue.map((j) => j.race.uid).join(', '),
        'error',
      );
    }
    await this.store?.db.close();
  }

  // --- Profiles (for the HTTP API) --------------------------------------------------------------

  /** The browser's own profile, or null when its cookie names none. */
  async me(token: string | null): Promise<OwnProfile | null> {
    const store = this.store_();
    const player = await this.bySession(store, token);
    return player ? this.own(player) : null;
  }

  /**
   * A profile for this browser: the one its cookie already names, or a new one with a new
   * session token (the caller sets the cookie). `nickname` names a new profile.
   */
  async createIdentity(
    token: string | null,
    nickname: unknown,
  ): Promise<{ token: string; created: boolean; player: OwnProfile }> {
    const store = this.store_();
    const existing = await this.bySession(store, token);
    if (existing && token) return { token, created: false, player: await this.own(existing) };
    const fresh = newSessionToken();
    const player = await this.guard(() =>
      store.createPlayer(newProfileId(), sanitizeNickname(nickname), hashSecret(fresh), this.now()),
    );
    return { token: fresh, created: true, player: await this.own(player) };
  }

  /**
   * Signs this browser into the profile a recovery code belongs to. The browser's previous
   * session (another profile, or the same one) ends.
   */
  async recover(
    token: string | null,
    rawCode: unknown,
  ): Promise<{ token: string; player: OwnProfile }> {
    const store = this.store_();
    const code = normalizeRecoveryCode(rawCode);
    if (!code) throw new ApiFailure(400, 'A recovery code is 20 letters and digits.');
    const player = await this.guard(() => store.playerByRecovery(hashSecret(code)));
    if (!player) throw new ApiFailure(400, 'That recovery code is not valid.');
    const fresh = newSessionToken();
    await this.guard(async () => {
      if (isSessionToken(token)) await store.deleteSession(hashSecret(token));
      await store.addSession(player.id, hashSecret(fresh), this.now());
    });
    return { token: fresh, player: await this.own(player) };
  }

  /**
   * A new recovery code for the browser's profile, shown once. The old code stops working and
   * every other browser signed into the profile is signed out.
   */
  async newRecoveryCode(token: string | null): Promise<RecoveryCodeResponse> {
    const store = this.store_();
    const player = await this.requireSession(store, token);
    const code = newRecoveryCode();
    const updated = await this.guard(() =>
      store.replaceRecovery(
        player.id,
        hashSecret(normalizeRecoveryCode(code)!),
        hashSecret(token!),
        this.now(),
      ),
    );
    return { code, player: await this.own(updated) };
  }

  async rename(token: string | null, rawName: unknown): Promise<RenameResult> {
    const store = this.store_();
    const player = await this.requireSession(store, token);
    const nickname = sanitizeNickname(rawName);
    if (!nickname) throw new ApiFailure(400, 'Use letters or numbers for a nickname.');
    const renamed = await this.renamePlayer(store, player, nickname);
    return { player: await this.own(renamed.row), changed: renamed.changed, note: renamed.note };
  }

  /**
   * A single-use pass for the next room seat, and the nickname typed for that room made the
   * profile's (within the daily limit). Expires in a minute.
   */
  async issueTicket(token: string | null, rawName: unknown): Promise<TicketResponse> {
    const store = this.store_();
    let player = await this.requireSession(store, token);
    let nicknameNote: string | null = null;
    const nickname = sanitizeNickname(rawName);
    if (nickname && nickname !== player.nickname) {
      const renamed = await this.renamePlayer(store, player, nickname);
      nicknameNote = renamed.note;
      player = renamed.row;
    }
    const now = Date.now();
    if (this.tickets.size >= MAX_TICKETS || now - this.ticketsSweptAt > TICKET_TTL_MS) {
      this.sweepTickets(now);
    }
    if (this.tickets.size >= MAX_TICKETS) throw new ApiFailure(503, UNAVAILABLE);
    const ticket = newTicket();
    this.tickets.set(ticket, {
      profile: {
        id: player.id,
        tag: profileTag(player.id),
        rating: player.rating,
        races: player.races,
      },
      expires: now + TICKET_TTL_MS,
    });
    return { ticket, player: await this.own(player), nicknameNote };
  }

  /** The profile a seat request's ticket stands for; a ticket works once, for a minute. */
  redeemTicket(ticket: unknown): SeatProfile | null {
    if (typeof ticket !== 'string' || ticket.length > 64) return null;
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    this.tickets.delete(ticket);
    return entry.expires > Date.now() ? entry.profile : null;
  }

  // --- Leaderboard (public) --------------------------------------------------------------------

  async leaderboard(rawOffset: unknown, rawLimit: unknown): Promise<LeaderboardResponse> {
    const store = this.store_();
    const offset = Number(rawOffset ?? 0);
    const limit = Number(rawLimit ?? 25);
    if (!Number.isInteger(offset) || offset < 0 || offset > LEADERBOARD_MAX_OFFSET) {
      throw new ApiFailure(400, 'Bad offset.');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > LEADERBOARD_MAX_LIMIT) {
      throw new ApiFailure(400, `Ask for 1 to ${LEADERBOARD_MAX_LIMIT} rows.`);
    }
    const page = await this.guard(() => store.leaderboard(offset, limit));
    return { total: page.total, offset, entries: page.rows.map(entry) };
  }

  async search(rawQuery: unknown): Promise<SearchResponse> {
    const store = this.store_();
    const query = sanitizeNickname(rawQuery);
    if (!query) return { entries: [] };
    const rows = await this.guard(() => store.search(query, SEARCH_LIMIT));
    return { entries: rows.map(entry) };
  }

  async player(id: unknown): Promise<PlayerResponse> {
    const store = this.store_();
    if (!isProfileId(id)) throw new ApiFailure(404, 'No such player.');
    const row = await this.guard(() => store.player(id));
    if (!row) throw new ApiFailure(404, 'No such player.');
    const [profile, recent] = await this.guard(() =>
      Promise.all([this.publicProfile(row), store.history(id, HISTORY_LIMIT)]),
    );
    return { player: profile, recent: recent.map(historyEntry) };
  }

  // --- Races (RaceRatingSink) ------------------------------------------------------------------

  /**
   * Hands over a finished race. Answers at once: `pending` when it will be rated (the write
   * is queued), else `unrated` and why. `notify` hears every later change.
   */
  submit(race: CompletedRace, notify: (rating: RaceRating) => void): RaceRating {
    const base: RaceRating = {
      raceId: race.raceId,
      status: 'unrated',
      reason: null,
      entries: [],
      unrated: [],
    };
    if (!this.enabled) return { ...base, reason: 'Unrated: global ranking is off on this server.' };
    const cars = new Map<string, number>();
    for (const e of race.entries) {
      if (e.profileId) cars.set(e.profileId, (cars.get(e.profileId) ?? 0) + 1);
    }
    const rated: CompletedRaceEntry[] = [];
    const unrated: { id: string; reason: string }[] = [];
    for (const e of race.entries) {
      if (!e.profileId) unrated.push({ id: e.seatId, reason: 'No profile' });
      else if ((cars.get(e.profileId) ?? 0) > 1) {
        unrated.push({ id: e.seatId, reason: 'One profile, two cars' });
      } else rated.push(e);
    }
    if (rated.length < 2) {
      return { ...base, reason: 'Unrated: a rated race needs 2 players with profiles.', unrated };
    }
    if (!rated.some((e) => e.finished)) {
      return { ...base, reason: 'Unrated: no rated player finished.', unrated };
    }
    if (this.closing || this.queue.length >= MAX_QUEUE) {
      this.log(`[ranking] race ${race.uid} not rated: the queue is full or closing`, 'warn');
      return {
        ...base,
        status: 'failed',
        reason: 'Rating not saved: the server is busy.',
        unrated,
      };
    }
    this.queue.push({
      race,
      rated,
      unrated,
      notify,
      attempts: 0,
      giveUpAt: Date.now() + this.retryForMs,
    });
    void this.work();
    return { ...base, status: 'pending', unrated };
  }

  /** Rated races waiting for the database (in order). */
  get pending(): number {
    return this.queue.length;
  }

  /** Runs the queue until it is empty: one race at a time, in the order they finished. */
  private work(): Promise<void> {
    // The reset is chained after the assignment: a run that finds nothing to do finishes
    // synchronously, and must not leave a settled promise behind as "working".
    this.working ??= this.drain().finally(() => {
      this.working = null;
      if (this.queue.length > 0 && !this.closing) void this.work();
    });
    return this.working;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.closing) {
      const job = this.queue[0];
      if (await this.attempt(job)) {
        this.queue.shift();
        continue;
      }
      const delay = this.retryDelays[Math.min(job.attempts - 1, this.retryDelays.length - 1)];
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /** One try at writing a race. True when the job is finished (saved, or given up). */
  private async attempt(job: Job): Promise<boolean> {
    const store = this.store!;
    job.attempts++;
    const { race, rated } = job;
    try {
      if (!this.ready) throw new Error('database not ready');
      const record: RaceRecord = {
        id: race.uid,
        roomCode: race.roomCode,
        sessionId: race.sessionId,
        raceNumber: race.raceNumber,
        trackId: race.trackId,
        laps: race.laps,
        fieldSize: race.entries.length,
        startedAt: race.startedAt,
        completedAt: race.completedAt,
        entries: rated.map((e) => ({
          playerId: e.profileId!,
          position: e.position,
          finished: e.finished,
          dnfReason: e.dnfReason,
          time: e.totalTime,
          bestLap: e.bestLap,
          stats: e.stats,
        })),
      };
      const applied = await store.applyRace(record, rateRace);
      this.database = 'ok';
      if (applied.duplicate) this.log(`[ranking] race ${race.uid} was already rated`);
      const byProfile = new Map(applied.changes.map((c) => [c.id, c]));
      // The rating is saved; a rank that cannot be read now is just left out.
      const ranks = await Promise.all(
        rated.map((e) => store.rankOf(e.profileId!).catch(() => null)),
      );
      this.tell(job, {
        raceId: race.raceId,
        status: 'rated',
        reason: null,
        unrated: job.unrated,
        entries: rated.map((e, i) => {
          const change = byProfile.get(e.profileId!)!;
          return {
            id: e.seatId,
            profileId: e.profileId!,
            before: change.before,
            delta: change.delta,
            after: change.after,
            rank: ranks[i],
          };
        }),
      });
      return true;
    } catch (error) {
      const permanent = isPermanentFailure(error);
      const expired = Date.now() >= job.giveUpAt;
      if (!permanent) this.database = 'down';
      if (permanent || expired) {
        this.log(
          `[ranking] race ${race.uid} NOT rated after ${job.attempts} attempt(s): ` +
            describeDbError(error),
          'error',
        );
        this.tell(job, {
          raceId: race.raceId,
          status: 'failed',
          reason: 'Rating not saved: the ranking database was unavailable.',
          entries: [],
          unrated: job.unrated,
        });
        return true;
      }
      if (job.attempts === 1) {
        this.log(
          `[ranking] race ${race.uid} waiting for the database: ${describeDbError(error)}`,
          'warn',
        );
        this.tell(job, {
          raceId: race.raceId,
          status: 'retrying',
          reason: 'Rating pending: the ranking database is unavailable. Retrying.',
          entries: [],
          unrated: job.unrated,
        });
      }
      return false;
    }
  }

  // --- Helpers ----------------------------------------------------------------------------------

  private store_(): RankingStore {
    if (!this.store) throw new ApiFailure(503, OFF);
    if (!this.ready) throw new ApiFailure(503, UNAVAILABLE);
    return this.store;
  }

  /** Runs a database call; a failure becomes "unavailable" (logged here, without details). */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.database = 'ok';
      return result;
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      this.log(`[ranking] database call failed: ${describeDbError(error)}`, 'warn');
      if (!isPermanentFailure(error)) this.database = 'down';
      throw new ApiFailure(503, UNAVAILABLE);
    }
  }

  private async bySession(store: RankingStore, token: string | null): Promise<PlayerRow | null> {
    if (!isSessionToken(token)) return null;
    return this.guard(() => store.playerBySession(hashSecret(token), this.now()));
  }

  private async requireSession(store: RankingStore, token: string | null): Promise<PlayerRow> {
    const player = await this.bySession(store, token);
    if (!player) throw new ApiFailure(401, NO_PROFILE);
    return player;
  }

  private async renamePlayer(
    store: RankingStore,
    player: PlayerRow,
    nickname: string,
  ): Promise<{ row: PlayerRow; changed: boolean; note: string | null }> {
    const outcome = await this.guard(() => store.rename(player.id, nickname, this.now()));
    const note = outcome.blockedUntil
      ? `Your leaderboard name stays “${outcome.player.nickname}”: a nickname can change ` +
        `${NICKNAME_CHANGES_PER_DAY} times a day (next change ${outcome.blockedUntil.toISOString()}).`
      : null;
    return { row: outcome.player, changed: outcome.changed, note };
  }

  private async publicProfile(row: PlayerRow): Promise<PublicProfile> {
    const rank = row.races > 0 ? await this.guard(() => this.store!.rankOf(row.id)) : null;
    return {
      id: row.id,
      tag: profileTag(row.id),
      nickname: row.nickname,
      createdAt: row.createdAt.toISOString(),
      rating: row.rating,
      peakRating: row.peakRating,
      rank,
      races: row.races,
      finished: row.finished,
      wins: row.wins,
      podiums: row.podiums,
      bestLapMs: row.bestLapMs,
      lastRaceAt: iso(row.lastRaceAt),
    };
  }

  private async own(row: PlayerRow): Promise<OwnProfile> {
    const now = this.now().getTime();
    const open =
      row.nickname !== null &&
      row.nameWindowStart !== null &&
      now - row.nameWindowStart.getTime() < 24 * 3.6e6;
    return {
      ...(await this.publicProfile(row)),
      lastActiveAt: row.lastActiveAt.toISOString(),
      hasRecoveryCode: row.hasRecovery,
      nicknameChangesLeft: open
        ? Math.max(0, NICKNAME_CHANGES_PER_DAY - row.nameChanges)
        : NICKNAME_CHANGES_PER_DAY,
      nicknameResetsAt: open
        ? new Date(row.nameWindowStart!.getTime() + 24 * 3.6e6).toISOString()
        : null,
    };
  }

  private sweepTickets(now: number): void {
    this.ticketsSweptAt = now;
    for (const [ticket, entry] of this.tickets)
      if (entry.expires <= now) this.tickets.delete(ticket);
  }

  /** Seat tickets waiting to be used (expired ones go at the next sweep). */
  get ticketCount(): number {
    return this.tickets.size;
  }

  /**
   * Tells the room about its race. The rating is already saved (or given up) when this runs,
   * so a failure in the room's handler is logged here and never mistaken for a database
   * failure (which would retry a race that is stored).
   */
  private tell(job: Job, rating: RaceRating): void {
    try {
      job.notify(rating);
    } catch (error) {
      this.log(
        `[ranking] race ${job.race.uid}: the room could not be told (${(error as Error).message})`,
        'error',
      );
    }
  }

  private async ping(): Promise<void> {
    if (!this.store || this.closing) return;
    try {
      await this.store.ping();
      this.database = 'ok';
    } catch {
      this.database = 'down';
    }
    // Retry waiting races as soon as the database is back.
    if (this.database === 'ok' && this.queue.length > 0) void this.work();
  }
}

function entry(row: RankedPlayer): LeaderboardEntry {
  return {
    rank: row.rank,
    id: row.id,
    tag: profileTag(row.id),
    nickname: row.nickname ?? 'Racer',
    rating: row.rating,
    wins: row.wins,
    podiums: row.podiums,
    races: row.races,
    finished: row.finished,
  };
}

function historyEntry(row: HistoryRow): RaceHistoryEntry {
  return {
    raceId: row.raceId,
    completedAt: row.completedAt.toISOString(),
    laps: row.laps,
    position: row.position,
    fieldSize: row.fieldSize,
    finished: row.finished,
    dnfReason: row.dnfReason,
    totalTimeMs: row.totalTimeMs,
    bestLapMs: row.bestLapMs,
    ratingBefore: row.ratingBefore,
    ratingDelta: row.ratingDelta,
    ratingAfter: row.ratingAfter,
  };
}
