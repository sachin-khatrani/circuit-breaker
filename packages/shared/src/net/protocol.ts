import type { AbilityDenial, AbilityId } from '../sim/course';
import type { RaceEvent } from '../sim/events';

/**
 * The multiplayer wire protocol shared by client and server: constants, room and race message
 * shapes, and the small validators both sides use. Clients only ever send *intent* (lobby
 * actions and inputs); every race outcome is computed by the server.
 */

/** Bumped whenever messages change shape; a mismatched client is refused at join. */
export const PROTOCOL_VERSION = 4;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const MIN_LAPS = 1;
export const MAX_LAPS = 5;

/** Room codes: unambiguous letters and digits (no 0/O, 1/I/L). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const NICKNAME_MAX = 16;

/**
 * Default server → client snapshot rate (Hz); a server may run another (it announces its rate
 * in RaceStartInfo). The simulation itself always ticks at 60 Hz.
 */
export const SNAPSHOT_RATE = 20;
/** The client sends its inputs every N ticks, each packet repeating the last few frames. */
export const INPUT_SEND_INTERVAL = 2;
export const INPUT_REDUNDANCY = 6;
export const MAX_FRAMES_PER_PACKET = 12;
/** Inputs may arrive at most this far ahead of the server's tick (2 s). */
export const MAX_INPUT_LEAD_TICKS = 120;
/** With no input for this long, the server stops repeating the last one and coasts the car. */
export const INPUT_TIMEOUT_TICKS = 15;
/** A disconnected player keeps their seat (and car) for this long. */
export const RECONNECT_GRACE_MS = 30_000;
/** The race starts this long after the host presses Start (time for the message to arrive). */
export const RACE_START_DELAY_MS = 600;

/** One neon colour per seat, distinct from each other and from the track's hazard amber. */
export const PLAYER_COLORS = [
  '#19e6ff',
  '#ff2bd6',
  '#c6ff3a',
  '#ff8a1f',
  '#8a5cff',
  '#ff3b4f',
  '#eaf6ff',
  '#2bff9e',
] as const;

/** Names of the colours, in PLAYER_COLORS order (for labels and screen readers). */
export const PLAYER_COLOR_NAMES = [
  'Cyan',
  'Magenta',
  'Lime',
  'Orange',
  'Violet',
  'Red',
  'White',
  'Mint',
] as const;

/**
 * Body styles a player can pick: purely cosmetic (the same car underneath, the same physics),
 * so a style never changes how a car drives.
 */
export const VEHICLE_STYLES = ['Dart', 'Apex', 'Brute'] as const;

/** A colour and style a player may pick: both must be indices into the lists above. */
export function isVehicleChoice(color: unknown, style: unknown): boolean {
  const index = (v: unknown, length: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < length;
  return index(color, PLAYER_COLORS.length) && index(style, VEHICLE_STYLES.length);
}

/**
 * Lobby: `waiting` until at least two players are ready, then `ready` (the host may start).
 * A race runs `countdown` → `racing` → `finished` (first car home, the rest get a grace
 * period) → `results`.
 */
export type RoomPhase = 'waiting' | 'ready' | 'countdown' | 'racing' | 'finished' | 'results';

export interface LobbyPlayer {
  id: string;
  name: string;
  /** Index into PLAYER_COLORS: unique within the room. */
  color: number;
  /** Index into VEHICLE_STYLES. */
  style: number;
  /** Ready for the next race (in the lobby, or on the results screen). */
  ready: boolean;
  connected: boolean;
  host: boolean;
  /** Has a car in the race that is running now. */
  racing: boolean;
  /**
   * Server time (ms) at which a disconnected player's seat is given up; null while connected.
   */
  graceUntil: number | null;
  /** Session points, races scored and wins so far, and the rank they give (1 = leader). */
  points: number;
  races: number;
  wins: number;
  rank: number;
  /**
   * The persistent profile racing in this seat (see ranking/types), its tag and its global
   * rating when the seat was taken or last rated; all null for a seat without a profile.
   */
  profileId: string | null;
  tag: string | null;
  rating: number | null;
}

export interface RoomState {
  code: string;
  phase: RoomPhase;
  hostId: string;
  laps: number;
  players: LobbyPlayer[];
  /** Increases with every race started in this room. */
  raceId: number;
  /** Increases each time the host starts a new session (points back to zero). */
  sessionId: number;
  /** Races completed (and scored) in the current session. */
  sessionRaces: number;
  /** This server rates races for the global leaderboard (it has a database). */
  ranking: boolean;
}

export interface RaceRacerInfo {
  id: string;
  name: string;
  color: number;
  style: number;
  /** Grid slot (0 = pole). */
  slot: number;
}

export interface RaceStartInfo {
  raceId: number;
  trackId: string;
  laps: number;
  tickRate: number;
  /** Server clock (ms) at which tick 0 begins. */
  startTime: number;
  goTick: number;
  startEnergy: number;
  /** Snapshots per second this server sends: sets how far in the past other cars are drawn. */
  snapshotRate: number;
  racers: RaceRacerInfo[];
}

/** A racer's own numbers from one race, counted by the server's simulation. */
export interface RaceStats {
  /** Boost bursts fired. */
  boosts: number;
  /** Ability uses (each worked: refused presses are not counted). */
  overdrives: number;
  shortcuts: number;
  gateShifts: number;
  /** Times the car drove into the shortcut. */
  shortcutRuns: number;
  /** Energy earned from cells, drifts and speed lanes (whole units). */
  energy: number;
  /** Time spent drifting (s, one decimal). */
  driftSeconds: number;
  /** Top speed reached (m/s, one decimal). */
  topSpeed: number;
  wallHits: number;
}

export interface RaceResultEntry {
  id: string;
  name: string;
  color: number;
  style: number;
  /** Grid slot the car started from (the tie-breaker of exactly equal results). */
  slot: number;
  /** Final position, 1-based. */
  position: number;
  finished: boolean;
  /** Did not finish: left the race or ran out of time. */
  dnf: boolean;
  /** Why not: `left` the race (or never came back), or still `racing` when it was called. */
  dnfReason: 'left' | 'racing' | null;
  totalTime: number | null;
  bestLap: number | null;
  lapTimes: number[];
  /** Points this race gave (see the scoring table), and the session total and rank after it. */
  points: number;
  sessionPoints: number;
  /** 0 when the player is no longer in the room. */
  sessionRank: number;
  stats: RaceStats;
}

/** One ability press of a race, as the server judged it. */
export interface AbilityRecord {
  /** Race time of the press (s). */
  time: number;
  racerId: string;
  name: string;
  ability: AbilityId;
  ok: boolean;
  /** Why it did nothing (null when it worked). */
  reason: AbilityDenial | null;
  /**
   * What the track became: a shortcut opening from and until (race seconds); a gate switch
   * taking effect (`from`) with the lane it opened (0 left, 1 right). Null otherwise.
   */
  from: number | null;
  until: number | null;
  lane: number | null;
}

export interface RaceResults {
  raceId: number;
  /** The session the race was scored in, and its number in that session (1, 2, …). */
  sessionId: number;
  raceNumber: number;
  laps: number;
  winnerId: string | null;
  entries: RaceResultEntry[];
  /** Every ability press of the race, in order. */
  abilities: AbilityRecord[];
}

/**
 * A snapshot, sent to each player at the server's snapshot rate. Rows are the same for everyone; `me`, `b`
 * and `m` are only in the copy sent to a player whose car is in the race.
 */
export interface SnapshotMessage {
  /** The race it belongs to: a client drops anything from another race. */
  id: number;
  /** Server tick this state belongs to (after that tick ran). */
  t: number;
  /** One packed row per racer (see packRacerRow). */
  r: number[][];
  /** Inactive Energy cells: [id, respawnTick, …]. */
  c: number[];
  /** The changeable track (shortcut and gate) as of tick `t` (see packCourse). */
  k: number[];
  /** The recipient's own car, complete, for re-basing its prediction. */
  me?: number[];
  /** Ticks between the recipient's newest input the server holds and `t` (its cushion). */
  b?: number;
  /** Ticks since the last snapshot on which the server had no input from the recipient. */
  m?: number;
}

/** Race events of one server tick, delivered reliably. */
export interface EventsMessage {
  /** The race they belong to (see SnapshotMessage.id). */
  id: number;
  t: number;
  e: RaceEvent[];
}

/** What every acknowledged request answers. */
export type Ack<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

/** A seat in a room: the private token resumes it after a connection drop. */
export interface SeatGrant {
  playerId: string;
  token: string;
  room: RoomState;
}

/** Socket.IO event names. */
export const EV = {
  // client → server
  create: 'room:create',
  join: 'room:join',
  resume: 'room:resume',
  leave: 'room:leave',
  ready: 'room:ready',
  laps: 'room:laps',
  vehicle: 'room:vehicle',
  start: 'room:start',
  restart: 'race:restart',
  toLobby: 'race:lobby',
  newSession: 'session:new',
  input: 'input',
  ping: 'clock:ping',
  // server → client
  room: 'room:state',
  raceStart: 'race:start',
  snapshot: 'race:snap',
  events: 'race:events',
  results: 'race:results',
  /** The race's global rating: pending, then rated (or unrated, or not saved). */
  rating: 'race:rating',
  kicked: 'room:closed',
} as const;

/** Nicknames: printable, trimmed, at most NICKNAME_MAX characters; empty becomes null. */
export function sanitizeNickname(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Letters and numbers from any script, spaces and a few separators. No markup, no control
  // characters, no zero-width tricks.
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} ._\-'!?]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NICKNAME_MAX)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Upper-cases and strips a typed room code; null when it cannot be a valid code. */
export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}
