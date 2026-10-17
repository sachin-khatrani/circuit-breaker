import type { RaceRating, RaceStats } from '@circuit-breaker/shared';

/**
 * The persistent profile a room seat races for, as the ranking service vouched for it when
 * the seat was taken (from a single-use ticket; never from anything the client claimed).
 */
export interface SeatProfile {
  id: string;
  tag: string;
  /** Rating and rated races when the seat was taken (or last rated): for display only. */
  rating: number;
  races: number;
}

/** One car in a finished race, in classification order, with its seat's profile at the start. */
export interface CompletedRaceEntry {
  seatId: string;
  profileId: string | null;
  position: number;
  finished: boolean;
  dnfReason: 'left' | 'racing' | null;
  /** Seconds, from the server's simulation. */
  totalTime: number | null;
  bestLap: number | null;
  stats: RaceStats;
}

/** A finished race as the room hands it to the ranking service: authoritative, server-made. */
export interface CompletedRace {
  /** Random, made when the race started: the idempotency key of its rating. */
  uid: string;
  /** The room's own race number (what clients know the race by). */
  raceId: number;
  roomCode: string;
  sessionId: number;
  raceNumber: number;
  trackId: string;
  laps: number;
  startedAt: Date;
  completedAt: Date;
  entries: CompletedRaceEntry[];
}

/**
 * What a room needs from the ranking: whether races can be rated at all, and a place to hand
 * a finished race. `submit` answers at once (pending, or unrated and why) and calls `notify`
 * again whenever the rating's state changes (rated, retrying, failed).
 */
export interface RaceRatingSink {
  readonly enabled: boolean;
  submit(race: CompletedRace, notify: (rating: RaceRating) => void): RaceRating;
}
