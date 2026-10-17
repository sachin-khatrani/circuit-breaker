/**
 * The shapes of the ranking API (`/api/…`) and of the rating a race gets, shared by the
 * server that produces them and the client that shows them. Secrets never appear here: the
 * session token travels only in an HTTP-only cookie.
 */

/** Characters of a profile id shown beside its name, so two "Nova"s can be told apart. */
export const PROFILE_TAG_LENGTH = 4;

export function profileTag(id: string): string {
  return id.slice(0, PROFILE_TAG_LENGTH).toUpperCase();
}

/** Nickname changes allowed in a rolling window (naming a profile the first time is free). */
export const NICKNAME_CHANGES_PER_DAY = 5;

/** A profile as anyone may see it. Times are ISO strings. */
export interface PublicProfile {
  id: string;
  tag: string;
  nickname: string | null;
  createdAt: string;
  rating: number;
  peakRating: number;
  /** Place on the global leaderboard; null before the first rated race. */
  rank: number | null;
  /** Rated races, rated races finished, wins and podiums (top three). */
  races: number;
  finished: number;
  wins: number;
  podiums: number;
  /** Fastest lap in a rated race (ms). */
  bestLapMs: number | null;
  lastRaceAt: string | null;
}

/** The owner's own view of their profile: a little more than the public one. */
export interface OwnProfile extends PublicProfile {
  lastActiveAt: string;
  hasRecoveryCode: boolean;
  /** Nickname changes left in the current window, and when the window resets (null: open). */
  nicknameChangesLeft: number;
  nicknameResetsAt: string | null;
}

/** One finished rated race in a profile's history. */
export interface RaceHistoryEntry {
  raceId: string;
  completedAt: string;
  laps: number;
  /** Place in the race's full classification, and the number of cars in it. */
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

export interface LeaderboardEntry {
  rank: number;
  id: string;
  tag: string;
  nickname: string;
  rating: number;
  wins: number;
  podiums: number;
  races: number;
  finished: number;
}

// --- API responses ---------------------------------------------------------------------------

/** `GET /api/me`: whether this server ranks races at all, and this browser's profile. */
export interface MeResponse {
  ranking: boolean;
  player: OwnProfile | null;
}

/** `POST /api/identity`, `POST /api/identity/recover`, `POST /api/me/nickname`. */
export interface ProfileResponse {
  player: OwnProfile;
}

/** `POST /api/me/ticket`: a single-use pass that binds the next room seat to this profile. */
export interface TicketResponse {
  ticket: string;
  player: OwnProfile;
  /** When the typed nickname could not become the profile's name, why (else null). */
  nicknameNote: string | null;
}

/** `POST /api/me/recovery-code`: shown once, never stored in a readable form. */
export interface RecoveryCodeResponse {
  code: string;
  player: OwnProfile;
}

/** `GET /api/leaderboard?offset=&limit=` */
export interface LeaderboardResponse {
  total: number;
  offset: number;
  entries: LeaderboardEntry[];
}

/** `GET /api/leaderboard/search?q=` */
export interface SearchResponse {
  entries: LeaderboardEntry[];
}

/** `GET /api/players/:id` */
export interface PlayerResponse {
  player: PublicProfile;
  recent: RaceHistoryEntry[];
}

/** Every failed API call answers `{ error }` with an HTTP error status. */
export interface ApiError {
  error: string;
  /** False when this server has no ranking at all (no database configured). */
  ranking?: boolean;
}

// --- A race's rating (sent to the room over Socket.IO) ---------------------------------------

/**
 * `pending` while the database write is on its way, `retrying` when it failed and is being
 * retried, `rated` once committed, `unrated` when the race does not count, `failed` when the
 * write was given up (nothing was saved).
 */
export type RaceRatingStatus = 'pending' | 'retrying' | 'rated' | 'unrated' | 'failed';

export interface RatingResultEntry {
  /** The seat (room player id) the car belonged to. */
  id: string;
  profileId: string;
  before: number;
  delta: number;
  after: number;
  /** Global rank after the race; null when it could not be read. */
  rank: number | null;
}

export interface RaceRating {
  /** The room's race id (see RaceResults.raceId). */
  raceId: number;
  status: RaceRatingStatus;
  /** Why the race is unrated, or why its rating is late or lost; null when rated. */
  reason: string | null;
  /** The rated cars' changes (only once `rated`). */
  entries: RatingResultEntry[];
  /** Cars in the race that are not rated in it, with the reason. */
  unrated: { id: string; reason: string }[];
}
