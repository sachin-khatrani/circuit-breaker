/**
 * The headless bot player shared by the harness and the load test: a real Socket.IO client
 * running the browser's netcode (clock sync, adaptive input lead, tick-stamped inputs,
 * prediction with replay on every snapshot) and driving with the autopilot. Each bot has its
 * own simulated latency and jitter, and counts what it sees for the checks and the reports.
 */
import {
  abilityCost,
  autopilotInput,
  ClockSync,
  createInput,
  createRacerRow,
  createRemoteSample,
  encodeInputPacket,
  EV,
  GRID_ZERO,
  INPUT_REDUNDANCY,
  INPUT_SEND_INTERVAL,
  InputLead,
  packInputFrame,
  Predictor,
  PROTOCOL_VERSION,
  RemoteDelay,
  remoteDelayMs,
  RemoteTrack,
  TICK_RATE,
  Track,
  unpackRacerRow,
  type AbilityId,
  type Ack,
  type AutopilotOptions,
  type EventsMessage,
  type InputFrame,
  type PlayerInput,
  type ProfileResponse,
  type RaceEvent,
  type RaceRating,
  type RaceResults,
  type RaceStartInfo,
  type RacerRow,
  type RoomState,
  type SeatGrant,
  type SnapshotMessage,
  type TicketResponse,
} from '@circuit-breaker/shared';
import { createHistogram, performance, type RecordableHistogram } from 'node:perf_hooks';
import { io, type Socket } from 'socket.io-client';
import type { SocketLimits } from '../src/net/socketServer';

export const TICK_MS = 1000 / TICK_RATE;
export const track = new Track(GRID_ZERO);
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const now = () => performance.now();

/**
 * Socket limits for a test server whose every client runs on this machine: the per-address
 * limits are meant for real players' addresses, and here every bot shares 127.0.0.1.
 */
export const LOCAL_LIMITS: Partial<SocketLimits> = {
  maxConnections: 10_000,
  maxConnectionsPerAddress: 10_000,
  connectBurst: 10_000,
  connectsPerMinute: 600_000,
  createsPerMinute: 10_000,
};

// --- Measurements ------------------------------------------------------------------------------

/** p50, p99 and max of a histogram recorded in microseconds, in milliseconds. */
export interface SpreadMs {
  count: number;
  p50: number;
  p99: number;
  max: number;
}

export function spreadMs(h: RecordableHistogram, scale = 1000): SpreadMs {
  if (h.count === 0) return { count: 0, p50: 0, p99: 0, max: 0 };
  const round = (v: number) => Math.round((v / scale) * 100) / 100;
  return {
    count: h.count,
    p50: round(h.percentile(50)),
    p99: round(h.percentile(99)),
    max: round(h.max),
  };
}

/**
 * What a group of bots measured from the client side (the load test): when snapshots
 * arrived, how old they were, clock-ping round trips, and anything that went wrong.
 */
export class BotStats {
  /** Time between two snapshots of one race at one bot (us). */
  readonly snapshotGap = createHistogram();
  /** Server tick time to arrival at the bot: the server's lateness, sending, the network (us). */
  readonly snapshotAge = createHistogram();
  /** Clock ping (an acknowledged request) round trips (us). */
  readonly ackRtt = createHistogram();
  /** Sizes of one snapshot in ten, as JSON (bytes). */
  readonly snapshotBytes = createHistogram();
  snapshots = 0;
  disconnects = 0;
  connectErrors = 0;
  races = 0;
  corrections = 0;
  maxCorrection = 0;

  reset(): void {
    for (const h of [this.snapshotGap, this.snapshotAge, this.ackRtt, this.snapshotBytes]) {
      h.reset();
    }
    this.snapshots = 0;
    this.disconnects = 0;
    this.connectErrors = 0;
    this.races = 0;
    this.corrections = 0;
    this.maxCorrection = 0;
  }
}

const us = (ms: number) => Math.max(1, Math.round(ms * 1000));

// --- Simulated network -------------------------------------------------------------------------

/** One direction of a link: in order (like TCP), each message delayed by base + jitter. */
export class Delay {
  private last = 0;
  constructor(
    private readonly base: number,
    private readonly jitter: number,
  ) {}
  run(fn: () => void): void {
    // No simulated delay: deliver now (a zero timeout would still wait for a timer tick).
    if (this.base === 0 && this.jitter === 0) {
      fn();
      return;
    }
    const at = Math.max(this.last, now() + this.base + Math.random() * this.jitter);
    this.last = at;
    setTimeout(fn, at - now());
  }
}

// --- Bot player -------------------------------------------------------------------------------

export interface BotOptions {
  rttMs: number;
  jitterMs?: number;
  autopilot?: AutopilotOptions;
  /** Abilities this bot uses (once each): it decides from its own predicted car. */
  abilities?: { shortcut?: boolean; gate?: boolean; overdrive?: boolean };
  /**
   * The address this bot claims to come from (X-Forwarded-For), for a test server started
   * with TRUST_PROXY=1: every bot then counts as its own player for the per-address limits.
   */
  address?: string;
  /** Where to record client-side measurements (the load test). */
  stats?: BotStats;
  /** Keep every snapshot's track state by tick (the abilities scenario compares them). */
  recordCourse?: boolean;
  /**
   * Draw the other cars as the browser does (interpolated a little in the past) and count
   * how each frame went: the network scenarios' measure of smooth remote cars.
   */
  remoteView?: boolean;
}

export class Bot {
  socket: Socket | null = null;
  readonly clock = new ClockSync();
  readonly lead = new InputLead();
  playerId = '';
  token = '';
  room: RoomState | null = null;
  race: RaceStartInfo | null = null;
  raceStarts = 0;
  predictor: Predictor | null = null;
  results: RaceResults | null = null;
  /** Prediction re-bases that moved the car, and the largest (m). */
  corrections = 0;
  maxCorrection = 0;
  /** Input ticks the server had to guess for this player (sum of snapshot `m`). */
  missed = 0;
  snapshots = 0;
  maxRows = 0;
  /** The server's latest row for this bot's car. */
  myRow: RacerRow | null = null;
  /** Every player id this bot has heard of, from room states, rows and events. */
  readonly seenIds = new Set<string>();
  /** Track state (packed) of every snapshot received, by server tick. */
  readonly courseByTick = new Map<number, string>();
  /** Ability events this bot was told about (public ones, and its own refusals). */
  readonly abilityEvents: RaceEvent[] = [];
  /** Snapshots and events that named another race than the one this bot is in (dropped). */
  staleMessages = 0;
  /** The persistent profile (ranking scenario): its id, session cookie and a seat ticket. */
  profileId: string | null = null;
  cookie: string | null = null;
  ticket: string | null = null;
  /** Every race rating the server told this bot about, in order. */
  readonly ratings: RaceRating[] = [];
  /**
   * Remote cars per drawn frame (with `remoteView`): snapshots on both sides of the render
   * time (smooth), a short guess past the newest one, or none for too long (the car stops).
   */
  readonly remoteFrames = { interpolated: 0, extrapolated: 0, held: 0 };
  private readonly remoteTracks = new Map<string, RemoteTrack>();
  private readonly remoteSample = createRemoteSample();
  private readonly remoteDelay = new RemoteDelay();
  private lastDrawn = 0;
  private readonly used = new Set<AbilityId>();
  readonly autopilot: AutopilotOptions;
  private readonly up: Delay;
  private readonly down: Delay;
  private readonly pending: SnapshotMessage[] = [];
  private readonly input = createInput();
  private pinger: ReturnType<typeof setInterval> | null = null;
  private lastSent = 0;
  private lastSnapshotTick = 0;
  private lastUpdate = now();
  private synced = false;
  private slotIds = new Map<number, string>();
  private lastSnapshotAt = 0;

  constructor(
    readonly name: string,
    readonly options: BotOptions,
  ) {
    const half = options.rttMs / 2;
    const jitter = (options.jitterMs ?? 0) / 2;
    this.up = new Delay(half, jitter);
    this.down = new Delay(half, jitter);
    this.autopilot = options.autopilot ?? { boost: true, racingLine: true };
  }

  private get headers(): Record<string, string> {
    return this.options.address ? { 'x-forwarded-for': this.options.address } : {};
  }

  async connect(url: string): Promise<void> {
    const socket = io(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: this.headers,
    });
    this.socket = socket;
    const stats = this.options.stats;
    const deliver =
      <T>(fn: (value: T) => void) =>
      (value: T) =>
        this.down.run(() => {
          if (this.socket === socket) fn(value);
        });
    socket.on(
      EV.room,
      deliver((s: RoomState) => this.onRoom(s)),
    );
    socket.on(
      EV.raceStart,
      deliver((s: RaceStartInfo) => this.onRaceStart(s)),
    );
    socket.on(
      EV.snapshot,
      deliver((s: SnapshotMessage) => this.onSnapshot(s)),
    );
    socket.on(
      EV.events,
      deliver((m: EventsMessage) => this.onEvents(m)),
    );
    socket.on(
      EV.results,
      deliver((r: RaceResults) => {
        this.results = r;
        if (stats && r.entries.some((e) => e.id === this.playerId)) stats.races++;
      }),
    );
    socket.on(
      EV.rating,
      deliver((r: RaceRating) => this.ratings.push(r)),
    );
    // A disconnect the bot did not ask for (drop() forgets the socket first).
    socket.on('disconnect', () => {
      if (stats && this.socket === socket) stats.disconnects++;
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (error) => {
        if (stats) stats.connectErrors++;
        reject(error);
      });
    });
    for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 80);
    this.pinger = setInterval(() => this.ping(), 500);
  }

  /** The connection drops (no goodbye: the server only sees the socket close). */
  drop(): void {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
    this.socket?.disconnect();
    this.socket = null;
  }

  request<T = null>(event: string, payload: unknown = {}): Promise<Ack<T>> {
    const socket = this.socket;
    if (!socket) return Promise.resolve({ ok: false, error: 'not connected' });
    return new Promise((resolve) => {
      this.up.run(() => {
        socket
          .timeout(8000)
          .emitWithAck(event, payload)
          .then(
            (reply: Ack<T>) => this.down.run(() => resolve(reply)),
            () => resolve({ ok: false, error: 'timeout' }),
          );
      });
    });
  }

  async seat(event: string, payload: Record<string, unknown>): Promise<SeatGrant> {
    const ack = await this.request<SeatGrant>(event, { ...payload, version: PROTOCOL_VERSION });
    if (!ack.ok) throw new Error(`${this.name}: ${event} refused: ${ack.error}`);
    this.playerId = ack.data.playerId;
    this.token = ack.data.token;
    this.onRoom(ack.data.room);
    // A race announced before this answer (resuming mid-race) can start now.
    if (this.race && !this.predictor) this.onRaceStart(this.race);
    return ack.data;
  }

  create = () => this.seat(EV.create, { name: this.name, ...this.ticketField() });
  join = (code: string) => this.seat(EV.join, { code, name: this.name, ...this.ticketField() });

  /** A ticket goes with one seat request only. */
  private ticketField(): { ticket?: string } {
    const ticket = this.ticket;
    this.ticket = null;
    return ticket ? { ticket } : {};
  }

  /** A profile over the HTTP API (as a browser makes one), and a ticket for the next seat. */
  async profile(url: string): Promise<void> {
    const post = (path: string, body: unknown) =>
      fetch(url + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.headers,
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        body: JSON.stringify(body),
      });
    const made = await post('/api/identity', { nickname: this.name });
    this.cookie = /^(cb_player=[^;]+)/.exec(made.headers.get('set-cookie') ?? '')?.[1] ?? null;
    this.profileId = ((await made.json()) as ProfileResponse).player.id;
    const pass = await post('/api/me/ticket', { nickname: this.name });
    this.ticket = ((await pass.json()) as TicketResponse).ticket;
  }
  resume = () => this.seat(EV.resume, { token: this.token });

  /** What a browser does after a rated race: reloads its profile and the leaderboard. */
  async refreshProfile(url: string): Promise<boolean> {
    const get = (path: string) =>
      fetch(url + path, {
        headers: { ...this.headers, ...(this.cookie ? { cookie: this.cookie } : {}) },
      });
    const [me, board] = await Promise.all([get('/api/me'), get('/api/leaderboard?limit=25')]);
    await Promise.all([me.text(), board.text()]);
    return me.ok && board.ok;
  }

  /** Called every few milliseconds: re-base on snapshots, predict, send inputs. */
  update(): void {
    const t = now();
    this.clock.update(t - this.lastUpdate);
    this.lastUpdate = t;
    const predictor = this.predictor;
    const race = this.race;
    if (!predictor || !race || this.results?.raceId === race.raceId) return;
    for (const snapshot of this.pending) {
      this.lastSnapshotTick = Math.max(this.lastSnapshotTick, snapshot.t);
      const rec = predictor.reconcile(snapshot.t, snapshot.me, snapshot.c, snapshot.k);
      if (rec) {
        this.synced = true;
        if (rec.error > 0.001) {
          this.corrections++;
          this.maxCorrection = Math.max(this.maxCorrection, rec.error);
          const stats = this.options.stats;
          if (stats) {
            stats.corrections++;
            stats.maxCorrection = Math.max(stats.maxCorrection, rec.error);
          }
        }
      }
      this.lead.feedback(snapshot.b ?? 0, snapshot.m ?? 0, t, this.clock.rtt);
    }
    this.pending.length = 0;
    if (this.options.remoteView) this.drawRemotes(race, t);
    if (!this.synced || !this.socket) return;
    // No snapshot for a second beyond the lead: the link is down, stop driving blind.
    if (predictor.tick - this.lastSnapshotTick > this.lead.lead + 60) return;
    const target = Math.floor(
      (this.clock.serverNow(t) - race.startTime) / TICK_MS + this.lead.lead,
    );
    for (let steps = 0; predictor.tick < target && steps < 12; steps++) {
      const r = predictor.racer;
      const sim = predictor.sim;
      const options = r.finished ? { pace: 0.75, racingLine: true } : this.autopilot;
      const input = autopilotInput(
        track,
        r.vehicle,
        {
          ...options,
          course: sim.course,
          tick: sim.tick,
          shortcut: this.options.abilities?.shortcut,
        },
        this.input,
      );
      // Throttle in the last quarter second of the countdown: the launch boost.
      if (sim.phase === 'countdown') input.throttle = sim.goTick - sim.tick < 15 ? 1 : 0;
      if (sim.phase === 'racing' && r.started && !r.finished) this.chooseAbilities(input);
      predictor.step(input);
      this.sendInputs();
    }
  }

  /** The browser's remote-car rendering (see OnlineRace.updateRemotes), counted per frame. */
  private drawRemotes(race: RaceStartInfo, t: number): void {
    const target = remoteDelayMs(race.snapshotRate, this.clock.rtt, this.clock.jitter);
    const delayMs = this.remoteDelay.update(target, this.lastDrawn > 0 ? t - this.lastDrawn : 0);
    this.lastDrawn = t;
    const renderTick = (this.clock.serverNow(t) - race.startTime - delayMs) / TICK_MS;
    if (renderTick < race.goTick) return;
    for (const track of this.remoteTracks.values()) {
      const result = track.sample(renderTick, this.remoteSample, 9);
      if (result !== 'none') this.remoteFrames[result]++;
    }
  }

  /**
   * The bot's plan: open the shortcut 150-300 m before it, shift the gate early in the lap,
   * fire Overdrive on the main straight. Each once, when the Energy is there.
   */
  private chooseAbilities(input: PlayerInput): void {
    const plan = this.options.abilities;
    const predictor = this.predictor;
    if (!plan || !predictor) return;
    const v = predictor.racer.vehicle;
    const sim = predictor.sim;
    const want = (id: AbilityId, when: boolean) => {
      if (!when || this.used.has(id) || v.energy < abilityCost(sim.rules, id)) return;
      input[id] = true;
      this.used.add(id);
    };
    const toEntry = track.distanceAhead(v.trackS, track.branches[0].entryMainS);
    want('shortcut', plan.shortcut === true && v.road === 0 && toEntry > 150 && toEntry < 300);
    want('gate', plan.gate === true && sim.raceTime > 4);
    want('overdrive', plan.overdrive === true && v.road === 0 && v.trackS > 60 && v.trackS < 200);
  }

  private sendInputs(): void {
    const predictor = this.predictor;
    const socket = this.socket;
    if (!predictor || !socket) return;
    const tick = predictor.tick;
    if (tick - this.lastSent < INPUT_SEND_INTERVAL) return;
    const first = Math.max(1, tick - INPUT_REDUNDANCY + 1);
    const frames: InputFrame[] = [];
    for (let k = first; k <= tick; k++) {
      const input = predictor.inputFor(k);
      frames.push(input ? packInputFrame(input) : [0, 0, 0, 0]);
    }
    const packet = encodeInputPacket(this.race?.raceId ?? 0, first, frames);
    this.up.run(() => socket.emit(EV.input, packet));
    this.lastSent = tick;
  }

  private ping(): void {
    const socket = this.socket;
    if (!socket) return;
    const sent = now();
    this.up.run(() => {
      socket
        .timeout(4000)
        .emitWithAck(EV.ping, sent)
        .then(
          (reply: { t0: number; now: number }) =>
            this.down.run(() => {
              const at = now();
              this.clock.addSample(reply.t0, reply.now, at);
              this.options.stats?.ackRtt.record(us(at - sent));
            }),
          () => {},
        );
    });
  }

  private onRoom(state: RoomState): void {
    this.room = state;
    for (const p of state.players) this.seenIds.add(p.id);
  }

  private onRaceStart(info: RaceStartInfo): void {
    this.raceStarts++;
    const same = this.race?.raceId === info.raceId && this.race.startTime === info.startTime;
    this.race = info;
    this.slotIds = new Map(info.racers.map((r) => [r.slot, r.id]));
    for (const r of info.racers) this.seenIds.add(r.id);
    if (!this.playerId) return;
    if (same && this.predictor) return; // resumed: the next snapshot re-bases the car
    // Snapshots still queued are from the race that ended: replayed into this race's predictor
    // they would move it to that race's last tick, and the bot would stop sending inputs.
    this.pending.length = 0;
    this.remoteTracks.clear();
    if (!info.racers.some((r) => r.id === this.playerId)) {
      this.predictor = null;
      return;
    }
    this.predictor = new Predictor(track, info, this.playerId);
    this.lead.fromRtt(this.clock.rtt || this.options.rttMs, this.clock.jitter, TICK_MS);
    this.synced = (this.clock.serverNow(now()) - info.startTime) / TICK_MS < 90;
    this.lastSent = 0;
    this.lastSnapshotTick = 0;
    this.lastSnapshotAt = 0;
    this.results = null;
  }

  private onSnapshot(snapshot: SnapshotMessage): void {
    // Anything from another race (an older one) is dropped, as the browser client does.
    if (snapshot.id !== this.race?.raceId) {
      this.staleMessages++;
      return;
    }
    this.snapshots++;
    const stats = this.options.stats;
    if (stats) {
      const at = now();
      stats.snapshots++;
      if (this.lastSnapshotAt > 0) stats.snapshotGap.record(us(at - this.lastSnapshotAt));
      this.lastSnapshotAt = at;
      if (this.clock.samples > 0) {
        stats.snapshotAge.record(
          us(this.clock.serverNow(at) - (this.race.startTime + snapshot.t * TICK_MS)),
        );
      }
      if (stats.snapshots % 10 === 0) stats.snapshotBytes.record(JSON.stringify(snapshot).length);
    }
    if (this.options.recordCourse !== false) {
      this.courseByTick.set(snapshot.t, JSON.stringify(snapshot.k));
    }
    this.maxRows = Math.max(this.maxRows, snapshot.r.length);
    for (const raw of snapshot.r) {
      const row = unpackRacerRow(raw, createRacerRow());
      const id = this.slotIds.get(row.slot);
      if (id) this.seenIds.add(id);
      if (id === this.playerId) this.myRow = row;
      else if (id && this.options.remoteView) {
        let remote = this.remoteTracks.get(id);
        if (!remote) this.remoteTracks.set(id, (remote = new RemoteTrack()));
        remote.push(snapshot.t, row);
      }
    }
    if (snapshot.me) {
      this.missed += snapshot.m ?? 0;
      this.pending.push(snapshot);
    }
  }

  private onEvents(message: EventsMessage): void {
    if (message.id !== this.race?.raceId) {
      this.staleMessages++;
      return;
    }
    for (const event of message.e) {
      if ('racerId' in event) this.seenIds.add(event.racerId);
      if (event.type === 'ability' || event.type === 'abilityDenied')
        this.abilityEvents.push(event);
    }
  }
}
