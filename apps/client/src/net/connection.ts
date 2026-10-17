import {
  ClockSync,
  EV,
  PROTOCOL_VERSION,
  type Ack,
  type EventsMessage,
  type RaceRating,
  type RaceResults,
  type RaceStartInfo,
  type RoomState,
  type SeatGrant,
  type SnapshotMessage,
} from '@circuit-breaker/shared';
import { io, type Socket } from 'socket.io-client';
import type { VehiclePick } from '../game/settings';
import { SERVER_URL } from './api';

export type NetStatus = 'offline' | 'connecting' | 'online' | 'reconnecting';

export interface NetHandlers {
  room(state: RoomState): void;
  raceStart(info: RaceStartInfo): void;
  snapshot(snapshot: SnapshotMessage): void;
  events(message: EventsMessage): void;
  results(results: RaceResults): void;
  /** A race's global rating: pending, saved, or why not. */
  rating(rating: RaceRating): void;
  /** The server ended this seat (resumed elsewhere, or the seat expired). */
  closed(reason: string): void;
  status(status: NetStatus): void;
}

interface StoredSeat {
  token: string;
  code: string;
}

/** Per tab (sessionStorage), so two tabs in one browser are two players. */
const SEAT_KEY = 'circuit-breaker.seat';

const devParams = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;
/** Development aid: `?lag=120&jitter=30` adds round-trip latency (ms) to this tab's link. */
const LAG_MS = Math.max(0, Number(devParams?.get('lag') ?? 0) || 0);
const JITTER_MS = Math.max(0, Number(devParams?.get('jitter') ?? 0) || 0);

/** In-order delayed delivery, like one direction of a TCP stream with variable latency. */
class Delay {
  private last = 0;
  constructor(
    private readonly base: number,
    private readonly jitter: number,
  ) {}
  run(fn: () => void): void {
    if (this.base === 0 && this.jitter === 0) {
      fn();
      return;
    }
    const at = Math.max(this.last, performance.now() + this.base + Math.random() * this.jitter);
    this.last = at;
    setTimeout(fn, at - performance.now());
  }
}

function loadSeat(): StoredSeat | null {
  try {
    const raw = window.sessionStorage.getItem(SEAT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSeat>;
    return typeof parsed.token === 'string' && typeof parsed.code === 'string'
      ? { token: parsed.token, code: parsed.code }
      : null;
  } catch {
    return null;
  }
}

function saveSeat(seat: StoredSeat | null): void {
  try {
    if (seat) window.sessionStorage.setItem(SEAT_KEY, JSON.stringify(seat));
    else window.sessionStorage.removeItem(SEAT_KEY);
  } catch {
    // No storage: a reload simply loses the seat.
  }
}

/**
 * The game's one Socket.IO connection: lobby requests, input packets out, snapshots and events
 * in, plus the clock sync the race timeline runs on. It talks to the page's own origin (Vite
 * proxies it in development), and resumes its seat with the stored token after any drop.
 */
export class NetClient {
  readonly clock = new ClockSync();
  status: NetStatus = 'offline';
  playerId: string | null = null;
  private socket: Socket | null = null;
  private handlers: Partial<NetHandlers> = {};
  private seat: StoredSeat | null = loadSeat();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private clockWaiters: (() => void)[] = [];
  private readonly up = new Delay(LAG_MS / 2, JITTER_MS / 2);
  private readonly down = new Delay(LAG_MS / 2, JITTER_MS / 2);

  /** A seat this tab held before a reload, if any. */
  get storedSeat(): Readonly<StoredSeat> | null {
    return this.seat;
  }

  get simulatedLag(): number {
    return LAG_MS;
  }

  /** Resolves once the server clock has been measured at least once. */
  whenClockReady(): Promise<void> {
    if (this.clock.samples > 0) return Promise.resolve();
    return new Promise((resolve) => this.clockWaiters.push(resolve));
  }

  on(handlers: Partial<NetHandlers>): void {
    this.handlers = handlers;
  }

  connect(): Promise<void> {
    if (this.socket?.connected) return Promise.resolve();
    if (!this.socket) this.open();
    this.setStatus(this.seat ? 'reconnecting' : 'connecting');
    const socket = this.socket!;
    return new Promise((resolve, reject) => {
      const done = () => {
        socket.off('connect', done);
        socket.off('connect_error', fail);
        resolve();
      };
      const fail = (error: Error) => {
        socket.off('connect', done);
        socket.off('connect_error', fail);
        reject(error);
      };
      socket.on('connect', done);
      socket.on('connect_error', fail);
      socket.connect();
    });
  }

  /**
   * `vehicle` is the car this player would like (the server gives another if it is taken);
   * `ticket` ties the seat to this browser's profile (null: the seat races unrated).
   */
  async createRoom(
    name: string,
    vehicle: VehiclePick,
    ticket: string | null,
  ): Promise<Ack<SeatGrant>> {
    await this.connect();
    return this.seatRequest(EV.create, {
      name,
      ...vehicle,
      ...(ticket ? { ticket } : {}),
      version: PROTOCOL_VERSION,
    });
  }

  async joinRoom(
    code: string,
    name: string,
    vehicle: VehiclePick,
    ticket: string | null,
  ): Promise<Ack<SeatGrant>> {
    await this.connect();
    return this.seatRequest(EV.join, {
      code,
      name,
      ...vehicle,
      ...(ticket ? { ticket } : {}),
      version: PROTOCOL_VERSION,
    });
  }

  /** Takes back the seat stored in this tab (after a reload or a dropped connection). */
  async resume(): Promise<Ack<SeatGrant>> {
    const seat = this.seat;
    if (!seat) return { ok: false, error: 'No seat to resume.' };
    await this.connect();
    const result = await this.seatRequest(EV.resume, {
      token: seat.token,
      version: PROTOCOL_VERSION,
    });
    if (!result.ok) this.forgetSeat();
    return result;
  }

  async leave(): Promise<void> {
    this.forgetSeat();
    if (this.socket?.connected) await this.request(EV.leave);
  }

  // Lobby and results requests name the race the screen was showing (`raceId`): the server
  // refuses one made on a screen that is out of date.
  setReady(ready: boolean, raceId: number) {
    return this.request(EV.ready, { ready, raceId });
  }
  setLaps(laps: number) {
    return this.request(EV.laps, { laps });
  }
  setVehicle(vehicle: VehiclePick) {
    return this.request(EV.vehicle, vehicle);
  }
  start(raceId: number) {
    return this.request(EV.start, { raceId });
  }
  restart(raceId: number) {
    return this.request(EV.restart, { raceId });
  }
  toLobby(raceId: number) {
    return this.request(EV.toLobby, { raceId });
  }
  newSession() {
    return this.request(EV.newSession);
  }

  sendInput(packet: number[]): void {
    const socket = this.socket;
    if (!socket?.connected) return;
    this.up.run(() => socket.emit(EV.input, packet));
  }

  private open(): void {
    const options = {
      transports: ['websocket'],
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 400,
      reconnectionDelayMax: 2000,
      timeout: 6000,
    };
    const socket = SERVER_URL ? io(SERVER_URL, options) : io(options);
    this.socket = socket;
    const deliver =
      <T>(fn: (value: T) => void) =>
      (value: T) =>
        this.down.run(() => fn(value));
    socket.on(
      EV.room,
      deliver((s: RoomState) => this.handlers.room?.(s)),
    );
    socket.on(
      EV.raceStart,
      deliver((s: RaceStartInfo) => this.handlers.raceStart?.(s)),
    );
    socket.on(
      EV.snapshot,
      deliver((s: SnapshotMessage) => this.handlers.snapshot?.(s)),
    );
    socket.on(
      EV.events,
      deliver((s: EventsMessage) => this.handlers.events?.(s)),
    );
    socket.on(
      EV.results,
      deliver((s: RaceResults) => this.handlers.results?.(s)),
    );
    socket.on(
      EV.rating,
      deliver((s: RaceRating) => this.handlers.rating?.(s)),
    );
    socket.on(
      EV.kicked,
      deliver((p: { reason?: string }) => {
        this.forgetSeat();
        this.handlers.closed?.(p.reason ?? 'Disconnected by the server.');
      }),
    );
    socket.on('connect', () => {
      this.setStatus('online');
      this.startPings();
      // After a drop the seat is still ours for the grace period: take it back.
      if (this.seat && this.playerId) {
        void this.resume().then((result) => {
          if (!result.ok) this.handlers.closed?.(result.error);
        });
      }
    });
    socket.on('disconnect', () => {
      this.stopPings();
      this.setStatus(this.seat ? 'reconnecting' : 'offline');
    });
  }

  private async seatRequest(event: string, payload: unknown): Promise<Ack<SeatGrant>> {
    const result = await this.request<SeatGrant>(event, payload);
    if (result.ok) {
      this.playerId = result.data.playerId;
      this.seat = { token: result.data.token, code: result.data.room.code };
      saveSeat(this.seat);
    }
    return result;
  }

  private request<T = null>(event: string, payload: unknown = {}): Promise<Ack<T>> {
    const socket = this.socket;
    if (!socket?.connected) return Promise.resolve({ ok: false, error: 'Not connected.' });
    return new Promise((resolve) => {
      this.up.run(() => {
        socket
          .timeout(8000)
          .emitWithAck(event, payload)
          .then(
            (reply: Ack<T>) => this.down.run(() => resolve(reply)),
            () => resolve({ ok: false, error: 'The server did not answer.' }),
          );
      });
    });
  }

  private forgetSeat(): void {
    this.seat = null;
    this.playerId = null;
    saveSeat(null);
  }

  private startPings(): void {
    this.stopPings();
    // A quick burst for a first estimate, then one a second.
    for (let i = 0; i < 5; i++) setTimeout(() => void this.ping(), i * 120);
    this.pingTimer = setInterval(() => void this.ping(), 1000);
  }

  private stopPings(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private async ping(): Promise<void> {
    const socket = this.socket;
    if (!socket?.connected) return;
    const sent = performance.now();
    await new Promise<void>((resolve) => {
      this.up.run(() => {
        socket
          .timeout(4000)
          .emitWithAck(EV.ping, sent)
          .then(
            (reply: { t0: number; now: number }) =>
              this.down.run(() => {
                this.clock.addSample(reply.t0, reply.now, performance.now());
                for (const waiter of this.clockWaiters.splice(0)) waiter();
                resolve();
              }),
            () => resolve(),
          );
      });
    });
  }

  private setStatus(status: NetStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.status?.(status);
  }
}

export const net = new NetClient();
