import {
  classifyRacers,
  compareGrid,
  compareSession,
  createInput,
  decodeInputPacket,
  EV,
  INPUT_TIMEOUT_TICKS,
  isVehicleChoice,
  MAX_INPUT_LEAD_TICKS,
  MAX_LAPS,
  MAX_PLAYERS,
  MIN_LAPS,
  MIN_PLAYERS,
  NICKNAME_MAX,
  packCells,
  packCourse,
  packPredictedState,
  packRacerRow,
  PLAYER_COLORS,
  RACE_START_DELAY_MS,
  racePoints,
  RaceSimulation,
  raceStats,
  RECONNECT_GRACE_MS,
  TICK_RATE,
  unpackInputFrame,
  type AbilityRecord,
  type EventsMessage,
  type InputFrame,
  type LobbyPlayer,
  type RaceEvent,
  type RaceRating,
  type RaceResultEntry,
  type RaceResults,
  type RaceStartInfo,
  type RoomPhase,
  type RoomState,
  type SnapshotMessage,
  type Track,
} from '@circuit-breaker/shared';
import { randomUUID } from 'node:crypto';
import type { Metrics } from '../metrics';
import { TokenBucket } from '../net/rateLimit';
import type { CompletedRace, RaceRatingSink, SeatProfile } from '../ranking/types';
import { newPlayerId, newSessionToken } from './ids';

/** Where one player's messages go. The socket layer implements it; tests fake it. */
export interface Peer {
  /** Reliable, in order. */
  send(event: string, payload: unknown): void;
  /** May be dropped when the connection is congested (snapshots: a newer one follows). */
  sendVolatile(event: string, payload: unknown): void;
  /** Ends this connection (the seat was resumed elsewhere, or abuse). */
  close(reason: string): void;
}

export interface RoomOptions {
  laps?: number;
  /** Snapshots per second (the simulation always runs at 60 Hz). */
  snapshotRate?: number;
  /** How long a dropped player keeps their seat (ms). */
  graceMs?: number;
  /** Where finished races go to be rated (none: every race is unrated). */
  ranking?: RaceRatingSink;
  /** Wall clock for the times stored with a rated race (tests may fix it). */
  wallClock?: () => Date;
  /** Tick timing and snapshot counts go here (`/metrics`). */
  metrics?: Metrics;
}

/** A car a player asks for: indices into PLAYER_COLORS and VEHICLE_STYLES. */
export interface VehicleChoice {
  color: number;
  style: number;
}

const TICK_MS = 1000 / TICK_RATE;
const NEUTRAL: InputFrame = [0, 0, 0, 0];
/** A race nobody can finish (everyone parked) is called after this long per lap. */
const MAX_SECONDS_PER_LAP = 180;
/** Ticks run in one update at most when catching up after a stall. */
const MAX_CATCH_UP_TICKS = 600;
/** Input packets per second (the client sends ~30) and burst. */
const INPUT_RATE = 45;
const INPUT_BURST = 40;
/** The answer to a request made for a race that is already over (a stale screen). */
const STALE = 'That was for an earlier race. Try again.';
/**
 * Refused ability presses kept in a race's record, per car. Every press that works is kept
 * (cooldowns bound those), but refusals cost nothing to make: without a cap, one player
 * tapping a key on cooldown grew the results every player receives without limit.
 */
const MAX_REFUSALS_RECORDED = 20;
/** One snapshot in this many is measured (as JSON) for `/metrics`. */
const SNAPSHOT_SAMPLE_EVERY = 50;
/**
 * Events the clients need from the server: race outcomes, track changes and other players'
 * visible moments. Everyone in the room gets these.
 */
const PUBLIC_EVENTS = new Set<RaceEvent['type']>([
  'checkpoint',
  'lap',
  'finish',
  'retired',
  'raceFinished',
  'respawn',
  'cell',
  'boost',
  'boostPad',
  'launchBoost',
  'driftEnd',
  'wallHit',
  'ability',
  'shortcut',
  'gate',
  'overdriveEnd',
]);
/** Events only the player they are about goes to (a refused ability is nobody else's business). */
const PRIVATE_EVENTS = new Set<RaceEvent['type']>(['abilityDenied']);

export interface Seat {
  readonly id: string;
  readonly token: string;
  readonly name: string;
  /** Index into PLAYER_COLORS (no two seats share one) and into VEHICLE_STYLES. */
  color: number;
  style: number;
  /** Join order: breaks ties in the session standings, and decides who becomes host next. */
  readonly order: number;
  /** Ready for the next race: in the lobby, or on the results screen. */
  ready: boolean;
  /** Session score: points, races scored and wins since the session began. */
  points: number;
  races: number;
  wins: number;
  peer: Peer | null;
  /** Server time the connection dropped; null while connected. */
  droppedAt: number | null;
  readonly inputBucket: TokenBucket;
  /** Input frames received for upcoming ticks of the current race. */
  inputs: Map<number, InputFrame>;
  lastFrame: InputFrame;
  lastFrameTick: number;
  /** Newest tick an input frame has arrived for. */
  newestTick: number;
  /** Ticks with no input since the last snapshot. */
  missed: number;
  /** Frames that arrived after their tick had run, and packets refused as malformed. */
  late: number;
  malformed: number;
  /** Input packets for another race (sent for one that has already ended). */
  stale: number;
  /** The persistent profile this seat races for (from a server ticket), or null. */
  profile: SeatProfile | null;
}

type Phase = 'lobby' | 'countdown' | 'racing' | 'finished' | 'results';

interface RaceRun {
  readonly info: RaceStartInfo;
  readonly sim: RaceSimulation;
  readonly racerIds: ReadonlySet<string>;
  readonly maxTick: number;
  /** Every ability press of the race, as judged by the server (for the results). */
  readonly abilities: AbilityRecord[];
  /** Refused presses recorded so far, per car (see MAX_REFUSALS_RECORDED). */
  readonly refusals: Map<string, number>;
  /** The session the race counts for, and its number in that session (1, 2, …). */
  readonly sessionId: number;
  readonly raceNumber: number;
  /** Its points have been added to the session (it happens once, when the results are made). */
  scored: boolean;
  results: RaceResults | null;
  /** Random id of the race: the key that keeps its global rating from being applied twice. */
  readonly uid: string;
  readonly startedAt: Date;
  /** The profile each car raced for, fixed at the start (a player who leaves stays rated). */
  readonly profiles: ReadonlyMap<string, SeatProfile | null>;
  /** Its global rating, as the ranking service last reported it. */
  rating: RaceRating | null;
}

/**
 * One room: seats, lobby rules, the authoritative race, and the session score. Every race
 * outcome (positions, laps, Energy, finish order, results, points) comes out of the shared
 * RaceSimulation running here; players only ever contribute input frames for ticks that have
 * not run yet, and lobby requests the room checks against its own state.
 */
export class Room {
  readonly seats: Seat[] = [];
  hostId = '';
  laps: number;
  raceId = 0;
  /** The session: races and points since the room opened, or since the host started anew. */
  sessionId = 1;
  sessionRaces = 0;
  /** Called when a seat is gone for good (left, or its grace period ran out). */
  onSeatRemoved: (seat: Seat) => void = () => {};
  private phase: Phase = 'lobby';
  private race: RaceRun | null = null;
  private joined = 0;
  private readonly snapshotEvery: number;
  private readonly graceMs: number;
  private readonly ranking: RaceRatingSink | undefined;
  private readonly wallClock: () => Date;
  private readonly metrics: Metrics | undefined;
  private snapshotsSent = 0;
  private readonly scratch = createInput();

  constructor(
    readonly code: string,
    private readonly track: Track,
    private readonly now: () => number,
    options: RoomOptions = {},
  ) {
    this.laps = clampLaps(options.laps ?? track.defaultLaps);
    this.snapshotEvery = Math.max(1, Math.round(TICK_RATE / (options.snapshotRate ?? 20)));
    this.graceMs = options.graceMs ?? RECONNECT_GRACE_MS;
    this.ranking = options.ranking;
    this.wallClock = options.wallClock ?? (() => new Date());
    this.metrics = options.metrics;
  }

  get isEmpty(): boolean {
    return this.seats.length === 0;
  }

  get currentRace(): Readonly<RaceRun> | null {
    return this.race;
  }

  get publicPhase(): RoomPhase {
    if (this.phase === 'lobby') return this.canStart() ? 'ready' : 'waiting';
    return this.phase;
  }

  /** A race is on (counting down, running, or waiting for the last cars): no lobby changes. */
  private get raceRunning(): boolean {
    return this.phase === 'countdown' || this.phase === 'racing' || this.phase === 'finished';
  }

  seatById(id: string): Seat | undefined {
    return this.seats.find((s) => s.id === id);
  }

  state(): RoomState {
    const race = this.race;
    const live = race !== null && race.results === null;
    const ranks = this.sessionRanks();
    return {
      code: this.code,
      phase: this.publicPhase,
      hostId: this.hostId,
      laps: this.laps,
      raceId: this.raceId,
      sessionId: this.sessionId,
      sessionRaces: this.sessionRaces,
      players: this.seats.map((s): LobbyPlayer => ({
        id: s.id,
        name: s.name,
        color: s.color,
        style: s.style,
        ready: s.ready,
        connected: s.peer !== null,
        host: s.id === this.hostId,
        racing: live && race.racerIds.has(s.id) && !race.sim.getRacer(s.id)?.retired,
        graceUntil: s.droppedAt === null ? null : s.droppedAt + this.graceMs,
        points: s.points,
        races: s.races,
        wins: s.wins,
        rank: ranks.get(s.id) ?? 0,
        profileId: s.profile?.id ?? null,
        tag: s.profile?.tag ?? null,
        rating: s.profile?.rating ?? null,
      })),
      ranking: this.ranking?.enabled ?? false,
    };
  }

  // --- Seats --------------------------------------------------------------------------------

  /**
   * A new player. `vehicle` is what they would like to drive: they get that colour if nobody
   * else has it (else the first free one), and the style if it is a real one. `profile` is the
   * persistent profile a server ticket vouched for. Null when full.
   */
  addSeat(
    name: string,
    peer: Peer,
    vehicle?: VehicleChoice,
    profile: SeatProfile | null = null,
  ): Seat | null {
    if (this.seats.length >= MAX_PLAYERS) return null;
    const used = new Set(this.seats.map((s) => s.color));
    const wanted = vehicle && isVehicleChoice(vehicle.color, vehicle.style) ? vehicle : null;
    let color = wanted && !used.has(wanted.color) ? wanted.color : 0;
    while (used.has(color) && color < PLAYER_COLORS.length) color++;
    let id = newPlayerId();
    while (this.seatById(id)) id = newPlayerId();
    const seat: Seat = {
      id,
      token: newSessionToken(),
      name: this.uniqueName(name),
      color,
      style: wanted?.style ?? 0,
      order: this.joined++,
      ready: false,
      points: 0,
      races: 0,
      wins: 0,
      peer,
      droppedAt: null,
      inputBucket: new TokenBucket(INPUT_BURST, INPUT_RATE, this.now()),
      inputs: new Map(),
      lastFrame: NEUTRAL,
      lastFrameTick: 0,
      newestTick: 0,
      missed: 0,
      late: 0,
      malformed: 0,
      stale: 0,
      profile,
    };
    this.seats.push(seat);
    this.hostId ||= seat.id;
    this.broadcastState();
    this.sendRaceTo(seat);
    return seat;
  }

  /** The player is back (resumed with their token): this connection now controls the seat. */
  attach(seat: Seat, peer: Peer): void {
    const old = seat.peer;
    seat.peer = peer;
    seat.droppedAt = null;
    if (old && old !== peer) old.close('This seat was resumed in another window.');
    this.broadcastState();
    this.sendRaceTo(seat);
  }

  /** The connection dropped. The seat (and its car) is kept for the grace period. */
  detach(seat: Seat, peer: Peer): void {
    if (seat.peer !== peer) return;
    seat.peer = null;
    seat.droppedAt = this.now();
    this.broadcastState();
  }

  /**
   * The player left (or never came back): their car retires and the host moves on. Their
   * session points go with the seat: a player who comes back by code starts again from zero.
   */
  removeSeat(seat: Seat): void {
    const index = this.seats.indexOf(seat);
    if (index < 0) return;
    this.seats.splice(index, 1);
    seat.peer = null;
    const race = this.race;
    if (race && race.results === null && race.racerIds.has(seat.id)) race.sim.retire(seat.id);
    // The last player is gone and the room closes with them: a race that is over (every car
    // finished or retired) gets its results now, so a finish already made still counts.
    if (race && race.results === null && this.seats.length === 0 && race.sim.phase === 'finished') {
      this.finishRace(race);
    }
    if (this.hostId === seat.id) this.hostId = this.nextHost();
    this.onSeatRemoved(seat);
    this.broadcastState();
  }

  // --- Lobby actions (each returns an error message, or null when done) ----------------------
  // `raceId` is the race the player's screen was showing when they asked: a request made on a
  // screen that is out of date (the room has raced since) is refused instead of applied.

  /** Ready (or not) for the next race: in the lobby, or on the results screen. */
  setReady(seat: Seat, ready: boolean, raceId?: number): string | null {
    if (raceId !== undefined && raceId !== this.raceId) return STALE;
    if (this.phase !== 'lobby' && this.phase !== 'results') {
      return 'You can only change ready status in the lobby or after a race.';
    }
    // A repeated request changes nothing (and tells nobody).
    if (seat.ready === ready) return null;
    seat.ready = ready;
    this.broadcastState();
    return null;
  }

  /** The player's own colour and body style. Colours are unique; changes wait for the race. */
  setVehicle(seat: Seat, color: number, style: number): string | null {
    if (this.raceRunning) return 'You can change your car between races.';
    if (!isVehicleChoice(color, style)) return 'That car is not available.';
    if (this.seats.some((s) => s !== seat && s.color === color)) {
      return 'Another player has that colour.';
    }
    if (seat.color === color && seat.style === style) return null;
    seat.color = color;
    seat.style = style;
    this.broadcastState();
    return null;
  }

  setLaps(seat: Seat, laps: number): string | null {
    if (seat.id !== this.hostId) return 'Only the host can change the race length.';
    if (this.phase !== 'lobby') return 'The race length can only change in the lobby.';
    this.laps = clampLaps(laps);
    this.broadcastState();
    return null;
  }

  /** Host only, from the lobby. The host's Start counts as their own ready. */
  start(seat: Seat, raceId?: number): string | null {
    if (seat.id !== this.hostId) return 'Only the host can start the race.';
    if (raceId !== undefined && raceId !== this.raceId) return STALE;
    if (this.phase !== 'lobby') return 'A race is already running.';
    return this.launch(seat);
  }

  /** Host only, from the results: the next race, with everyone ready for it. */
  restart(seat: Seat, raceId?: number): string | null {
    if (seat.id !== this.hostId) return 'Only the host can start the next race.';
    if (raceId !== undefined && raceId !== this.raceId) return STALE;
    if (this.raceRunning) return 'A race is already running.';
    if (this.phase !== 'results') return 'Start the race from the lobby.';
    return this.launch(seat);
  }

  /** Host only, from the results: everyone back to the lobby, ready flags cleared. */
  toLobby(seat: Seat, raceId?: number): string | null {
    if (seat.id !== this.hostId) return 'Only the host can return the room to the lobby.';
    if (raceId !== undefined && raceId !== this.raceId) return STALE;
    if (this.phase !== 'results') return 'The race is not over yet.';
    this.phase = 'lobby';
    this.race = null;
    for (const s of this.seats) s.ready = false;
    this.broadcastState();
    return null;
  }

  /** Host only, from the lobby: a new session, with everyone's points back to zero. */
  newSession(seat: Seat): string | null {
    if (seat.id !== this.hostId) return 'Only the host can start a new session.';
    if (this.phase !== 'lobby') return 'Start a new session from the lobby.';
    this.sessionId++;
    this.sessionRaces = 0;
    for (const s of this.seats) {
      s.points = 0;
      s.races = 0;
      s.wins = 0;
    }
    this.broadcastState();
    return null;
  }

  // --- Inputs -----------------------------------------------------------------------------

  /**
   * An input packet from this seat's own connection. Frames are kept for ticks that have not
   * run yet (at most MAX_INPUT_LEAD_TICKS ahead) of the race the packet names; anything for a
   * past tick or another race, malformed, or over the rate limit is ignored. One frame per
   * tick: the first copy wins.
   */
  receiveInput(seat: Seat, raw: unknown): void {
    const race = this.race;
    if (!race || race.results !== null || !race.racerIds.has(seat.id)) return;
    if (!seat.inputBucket.take(this.now())) return;
    const packet = decodeInputPacket(raw);
    if (!packet) {
      seat.malformed++;
      return;
    }
    if (packet.raceId !== race.info.raceId) {
      seat.stale++;
      return;
    }
    const current = race.sim.tick;
    packet.frames.forEach((frame, i) => {
      const tick = packet.firstTick + i;
      if (tick <= current) {
        seat.late++;
        return;
      }
      if (tick > current + MAX_INPUT_LEAD_TICKS) return;
      if (!seat.inputs.has(tick)) seat.inputs.set(tick, frame);
      if (tick > seat.newestTick) seat.newestTick = tick;
    });
  }

  // --- The loop -----------------------------------------------------------------------------

  /** Advances the room to the current time: grace periods, then any due race ticks. */
  update(): void {
    const now = this.now();
    for (const seat of [...this.seats]) {
      if (seat.droppedAt !== null && now - seat.droppedAt > this.graceMs) this.removeSeat(seat);
    }
    const race = this.race;
    if (!race || race.results !== null) return;
    const due = Math.floor((now - race.info.startTime) / TICK_MS);
    const target = Math.min(due, race.sim.tick + MAX_CATCH_UP_TICKS);
    while (race.sim.tick < target && race.results === null) {
      // How long after its due time this tick runs: the server's own timing under load.
      this.metrics?.tickLateness.record(now - race.info.startTime - (race.sim.tick + 1) * TICK_MS);
      this.metrics?.ticks.add();
      this.stepRace(race);
    }
  }

  /**
   * The host's start (from the lobby or the results): the host counts as ready, and everyone
   * connected and ready races. A disconnected player is left off the grid.
   */
  private launch(host: Seat): string | null {
    host.ready = true;
    const field = this.seats.filter((s) => s.peer !== null && s.ready);
    if (field.length < MIN_PLAYERS) {
      this.broadcastState();
      return `At least ${MIN_PLAYERS} connected players must be ready.`;
    }
    this.beginRace(field);
    return null;
  }

  private beginRace(field: Seat[]): void {
    this.raceId++;
    const sim = new RaceSimulation(this.track, { laps: this.laps });
    // The reverse of the session standings: fewest points at the front (see compareGrid).
    const grid = [...field].sort(compareGrid);
    grid.forEach((seat, slot) => {
      sim.addRacer(seat.id, seat.name, slot);
      seat.inputs = new Map();
      seat.lastFrame = NEUTRAL;
      seat.lastFrameTick = 0;
      seat.newestTick = 0;
      seat.missed = 0;
    });
    const info: RaceStartInfo = {
      raceId: this.raceId,
      trackId: this.track.id,
      laps: this.laps,
      tickRate: TICK_RATE,
      startTime: this.now() + RACE_START_DELAY_MS,
      goTick: sim.goTick,
      startEnergy: sim.startEnergy,
      snapshotRate: TICK_RATE / this.snapshotEvery,
      racers: grid.map((s, slot) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        style: s.style,
        slot,
      })),
    };
    this.race = {
      info,
      sim,
      racerIds: new Set(grid.map((s) => s.id)),
      maxTick: sim.goTick + this.laps * MAX_SECONDS_PER_LAP * TICK_RATE,
      abilities: [],
      refusals: new Map(),
      sessionId: this.sessionId,
      raceNumber: this.sessionRaces + 1,
      scored: false,
      results: null,
      uid: randomUUID(),
      startedAt: this.wallClock(),
      profiles: new Map(grid.map((s) => [s.id, s.profile])),
      rating: null,
    };
    this.phase = 'countdown';
    this.broadcast(EV.raceStart, info);
    this.broadcastState();
  }

  private stepRace(race: RaceRun): void {
    const sim = race.sim;
    const id = race.info.raceId;
    const tick = sim.tick + 1;
    for (const racer of sim.racers) {
      if (racer.retired) continue;
      const seat = this.seatById(racer.id);
      let frame = NEUTRAL;
      if (seat) {
        const sent = seat.inputs.get(tick);
        if (sent) {
          seat.inputs.delete(tick);
          seat.lastFrame = sent;
          seat.lastFrameTick = tick;
          frame = sent;
        } else {
          // Inputs are held state, so repeating the last frame is the best guess; after a
          // while with nothing (connection gone), the car coasts instead.
          seat.missed++;
          frame = tick - seat.lastFrameTick <= INPUT_TIMEOUT_TICKS ? seat.lastFrame : NEUTRAL;
        }
      }
      sim.setInput(racer.id, unpackInputFrame(frame, this.scratch));
    }
    sim.step();
    const all = sim.drainEvents();
    this.recordAbilities(race, all);
    const events = all.filter(isPublic);
    if (events.length > 0) {
      this.broadcast(EV.events, { id, t: tick, e: events } satisfies EventsMessage);
    }
    for (const event of all) {
      if (!PRIVATE_EVENTS.has(event.type) || !('racerId' in event)) continue;
      this.seatById(event.racerId)?.peer?.send(EV.events, {
        id,
        t: tick,
        e: [event],
      } satisfies EventsMessage);
    }

    if (this.phase === 'countdown' && sim.phase !== 'countdown') this.setPhase('racing');
    if (this.phase === 'racing' && sim.racers.some((r) => r.finished)) this.setPhase('finished');
    if (tick % this.snapshotEvery === 0) this.sendSnapshots(race);
    if (sim.phase === 'finished' || tick >= race.maxTick) this.finishRace(race);
  }

  private sendSnapshots(race: RaceRun): void {
    const sim = race.sim;
    const rows = sim.racers.map((r) => packRacerRow(r, !this.seatById(r.id)?.peer));
    const cells = packCells(sim.cells);
    const course = packCourse(sim.course);
    for (const seat of this.seats) {
      if (!seat.peer) continue;
      const snapshot: SnapshotMessage = {
        id: race.info.raceId,
        t: sim.tick,
        r: rows,
        c: cells,
        k: course,
      };
      const racer = race.racerIds.has(seat.id) ? sim.getRacer(seat.id) : undefined;
      if (racer && !racer.retired) {
        snapshot.me = packPredictedState(racer);
        snapshot.b = seat.newestTick - sim.tick;
        snapshot.m = seat.missed;
      }
      seat.missed = 0;
      seat.peer.sendVolatile(EV.snapshot, snapshot);
      if (this.metrics) {
        this.metrics.snapshots.add();
        if (++this.snapshotsSent % SNAPSHOT_SAMPLE_EVERY === 0) {
          this.metrics.snapshotBytes.record(JSON.stringify(snapshot).length);
        }
      }
    }
  }

  private finishRace(race: RaceRun): void {
    this.sendSnapshots(race);
    const entries = this.classify(race);
    this.score(race, entries);
    const ranks = this.sessionRanks();
    for (const entry of entries) {
      const seat = this.seatById(entry.id);
      entry.sessionPoints = seat?.points ?? 0;
      entry.sessionRank = seat ? (ranks.get(seat.id) ?? 0) : 0;
    }
    race.results = {
      raceId: race.info.raceId,
      sessionId: race.sessionId,
      raceNumber: race.raceNumber,
      laps: race.info.laps,
      winnerId: entries[0]?.finished ? entries[0].id : null,
      entries,
      abilities: race.abilities,
    };
    this.phase = 'results';
    for (const s of this.seats) s.ready = false;
    this.broadcast(EV.results, race.results);
    this.rate(race, entries);
    this.broadcastState();
  }

  /**
   * Hands the race's authoritative classification to the ranking service (once: the race is
   * scored once) and tells the room what it said; later changes (saved, retrying, not saved)
   * arrive through `notify`.
   */
  private rate(race: RaceRun, entries: readonly RaceResultEntry[]): void {
    if (!this.ranking) return;
    const completed: CompletedRace = {
      uid: race.uid,
      raceId: race.info.raceId,
      roomCode: this.code,
      sessionId: race.sessionId,
      raceNumber: race.raceNumber,
      trackId: race.info.trackId,
      laps: race.info.laps,
      startedAt: race.startedAt,
      completedAt: this.wallClock(),
      entries: entries.map((e) => ({
        seatId: e.id,
        profileId: race.profiles.get(e.id)?.id ?? null,
        position: e.position,
        finished: e.finished,
        dnfReason: e.dnfReason,
        totalTime: e.totalTime,
        bestLap: e.bestLap,
        stats: e.stats,
      })),
    };
    const first = this.ranking.submit(completed, (rating) => this.updateRating(race, rating));
    // `notify` may already have reported something newer (a write that failed at once).
    if (race.rating === null) {
      race.rating = first;
      this.broadcast(EV.rating, first);
    }
  }

  /** The ranking service's news about a race: shown to the room, and new ratings on seats. */
  private updateRating(race: RaceRun, rating: RaceRating): void {
    race.rating = rating;
    this.broadcast(EV.rating, rating);
    if (rating.status !== 'rated') return;
    let changed = false;
    for (const entry of rating.entries) {
      for (const seat of this.seats) {
        if (seat.profile?.id !== entry.profileId) continue;
        seat.profile = { ...seat.profile, rating: entry.after, races: seat.profile.races + 1 };
        changed = true;
      }
    }
    if (changed) this.broadcastState();
  }

  /** The final classification (see classifyRacers), with each car's points and numbers. */
  private classify(race: RaceRun): RaceResultEntry[] {
    const infos = new Map(race.info.racers.map((r) => [r.id, r]));
    return classifyRacers(race.sim.racers).map((r, i): RaceResultEntry => {
      const info = infos.get(r.id);
      const position = i + 1;
      return {
        id: r.id,
        name: info?.name ?? r.name,
        color: info?.color ?? 0,
        style: info?.style ?? 0,
        slot: r.slot,
        position,
        finished: r.finished,
        dnf: !r.finished,
        dnfReason: r.finished ? null : r.retired ? 'left' : 'racing',
        totalTime: r.finishTime,
        bestLap: r.bestLapTime,
        lapTimes: [...r.lapTimes],
        points: racePoints(position, r.finished),
        sessionPoints: 0,
        sessionRank: 0,
        stats: raceStats(r.stats),
      };
    });
  }

  /**
   * Adds a race's points to the session, once: it happens when its results are made, and the
   * race is marked so nothing can add them again. Players who left are no longer scored.
   */
  private score(race: RaceRun, entries: readonly RaceResultEntry[]): void {
    if (race.scored) return;
    race.scored = true;
    if (race.sessionId !== this.sessionId) return;
    for (const entry of entries) {
      const seat = this.seatById(entry.id);
      if (!seat) continue;
      seat.points += entry.points;
      seat.races += 1;
      if (entry.position === 1 && entry.finished) seat.wins += 1;
    }
    this.sessionRaces = Math.max(this.sessionRaces, race.raceNumber);
  }

  /** Session rank of every seat (see compareSession): 1 for the leader, all distinct. */
  private sessionRanks(): Map<string, number> {
    return new Map([...this.seats].sort(compareSession).map((s, i) => [s.id, i + 1]));
  }

  /** A seat joining or coming back mid-race gets the race (and results) it needs to show. */
  private sendRaceTo(seat: Seat): void {
    const race = this.race;
    if (!seat.peer || !race) return;
    if (race.results === null) {
      seat.peer.send(EV.raceStart, race.info);
      return;
    }
    seat.peer.send(EV.results, race.results);
    if (race.rating) seat.peer.send(EV.rating, race.rating);
  }

  /** Adds this tick's ability presses (worked or refused) to the race's record. */
  private recordAbilities(race: RaceRun, events: readonly RaceEvent[]): void {
    const sim = race.sim;
    const seconds = (tick: number) => Math.round((tick - sim.goTick) * (1000 / TICK_RATE)) / 1000;
    for (const event of events) {
      if (event.type !== 'ability' && event.type !== 'abilityDenied') continue;
      if (event.type === 'abilityDenied') {
        const refused = race.refusals.get(event.racerId) ?? 0;
        if (refused >= MAX_REFUSALS_RECORDED) continue;
        race.refusals.set(event.racerId, refused + 1);
      }
      const record: AbilityRecord = {
        time: seconds(event.tick),
        racerId: event.racerId,
        name: race.info.racers.find((r) => r.id === event.racerId)?.name ?? '',
        ability: event.ability,
        ok: event.type === 'ability',
        reason: event.type === 'abilityDenied' ? event.reason : null,
        from: null,
        until: null,
        lane: null,
      };
      if (event.type === 'ability') {
        const course = sim.course;
        if (event.ability === 'shortcut') {
          record.from = seconds(course.shortcutOpenTick);
          record.until = seconds(course.shortcutCloseTick);
        } else if (event.ability === 'gate') {
          record.from = seconds(course.gateSwitchTick);
          record.lane = course.gateNextLane;
        }
      }
      race.abilities.push(record);
    }
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.broadcastState();
  }

  private canStart(): boolean {
    const field = this.seats.filter((s) => s.peer !== null && (s.ready || s.id === this.hostId));
    return field.length >= MIN_PLAYERS;
  }

  /** The longest-standing connected player, else the longest-standing one at all. */
  private nextHost(): string {
    const byOrder = [...this.seats].sort((a, b) => a.order - b.order);
    return (byOrder.find((s) => s.peer !== null) ?? byOrder[0])?.id ?? '';
  }

  private uniqueName(name: string): string {
    const taken = new Set(this.seats.map((s) => s.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) {
      const suffix = ` ${n}`;
      const candidate = name.slice(0, NICKNAME_MAX - suffix.length) + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  private broadcast(event: string, payload: unknown): void {
    for (const seat of this.seats) seat.peer?.send(event, payload);
  }

  private broadcastState(): void {
    this.broadcast(EV.room, this.state());
  }
}

function isPublic(event: RaceEvent): boolean {
  if (!PUBLIC_EVENTS.has(event.type)) return false;
  if (event.type === 'driftEnd') return event.tier > 0;
  if (event.type === 'wallHit') return event.impact > 6;
  return true;
}

function clampLaps(laps: number): number {
  return Math.min(MAX_LAPS, Math.max(MIN_LAPS, Math.round(Number.isFinite(laps) ? laps : 3)));
}
