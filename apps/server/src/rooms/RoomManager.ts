import { MAX_PLAYERS, type Track } from '@circuit-breaker/shared';
import { logger, newErrorId, type Logger } from '../log';
import type { SeatProfile } from '../ranking/types';
import { newRoomCode } from './ids';
import { Room, type Peer, type RoomOptions, type Seat, type VehicleChoice } from './Room';

export interface SeatRef {
  room: Room;
  seat: Seat;
}

export interface ManagerOptions extends RoomOptions {
  /** Most rooms the process will hold at once. */
  maxRooms?: number;
  log?: Logger;
}

/** Rooms, seats and races right now (for `/metrics` and `/ready`). */
export interface ManagerStats {
  rooms: number;
  racing: number;
  seats: number;
  connectedSeats: number;
}

/**
 * All rooms of the process: codes, the secret-token → seat map used to resume after a drop,
 * the one seat each profile holds, one shared loop that advances every room, and clean-up of
 * empty rooms. A room that fails is closed on its own; the others carry on.
 */
export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly sessions = new Map<string, SeatRef>();
  /** The seat each persistent profile races in: one at a time (see `seat`). */
  private readonly profileSeats = new Map<string, SeatRef>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly log: Logger;

  constructor(
    private readonly track: Track,
    private readonly now: () => number,
    private readonly options: ManagerOptions = {},
  ) {
    this.log = options.log ?? logger;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Profiles seated right now (each in exactly one seat). */
  get profileCount(): number {
    return this.profileSeats.size;
  }

  stats(): ManagerStats {
    let racing = 0;
    let seats = 0;
    let connectedSeats = 0;
    for (const room of this.rooms.values()) {
      if (room.currentRace && room.currentRace.results === null) racing++;
      seats += room.seats.length;
      for (const seat of room.seats) if (seat.peer) connectedSeats++;
    }
    return { rooms: this.rooms.size, racing, seats, connectedSeats };
  }

  /** A new room with this player as host. */
  create(
    name: string,
    peer: Peer,
    vehicle?: VehicleChoice,
    profile: SeatProfile | null = null,
  ): SeatRef | string {
    if (this.rooms.size >= (this.options.maxRooms ?? 500)) {
      return 'The server is full right now. Try again in a minute.';
    }
    let code = newRoomCode();
    for (let i = 0; this.rooms.has(code); i++) {
      if (i > 50) return 'Could not create a room. Try again.';
      code = newRoomCode();
    }
    const room = new Room(code, this.track, this.now, this.options);
    room.onSeatRemoved = (seat) => this.forget(room, seat);
    this.rooms.set(code, room);
    const ref = this.seat(room, name, peer, vehicle, profile);
    if (!ref) {
      this.rooms.delete(code);
      return 'Could not create a room. Try again.';
    }
    return ref;
  }

  join(
    code: string,
    name: string,
    peer: Peer,
    vehicle?: VehicleChoice,
    profile: SeatProfile | null = null,
  ): SeatRef | string {
    const room = this.rooms.get(code);
    if (!room) return 'No room with that code. Check the code or ask for a new invite.';
    if (room.seats.length >= MAX_PLAYERS) return 'That room is full (8 players).';
    return this.seat(room, name, peer, vehicle, profile) ?? 'That room is full (8 players).';
  }

  /** Back after a drop: the token is the only proof. The old connection, if any, is closed. */
  resume(token: string, peer: Peer): SeatRef | string {
    const ref = this.sessions.get(token);
    if (!ref || !this.rooms.has(ref.room.code))
      return 'That session has expired. Join the room again.';
    ref.room.attach(ref.seat, peer);
    return ref;
  }

  /** The player left on purpose: their seat is freed at once. */
  leave(ref: SeatRef): void {
    ref.room.removeSeat(ref.seat);
  }

  /** The connection behind a seat dropped: the seat waits for a resume. */
  drop(ref: SeatRef, peer: Peer): void {
    ref.room.detach(ref.seat, peer);
  }

  /** Advances every room; called from the loop (and directly by tests). */
  update(): void {
    for (const room of this.rooms.values()) {
      try {
        room.update();
      } catch (error) {
        this.fail(room, error);
      }
    }
  }

  /** Starts the shared loop. A short interval plus each room's own clock keeps ticks exact. */
  start(intervalMs = 4): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.update(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Shutting down: every connected player is told why and disconnected. */
  closeAll(reason: string): void {
    for (const room of this.rooms.values()) {
      for (const seat of room.seats) {
        try {
          seat.peer?.close(reason);
        } catch {
          // The connection is going anyway.
        }
      }
    }
  }

  /**
   * Seats a player. A persistent profile races in one seat at a time: if it is still seated
   * and connected somewhere (another tab or device), this seat is unrated; a seat it left
   * behind (its connection dropped, the seat still held) is given up once this one exists,
   * as if the player had left it.
   */
  private seat(
    room: Room,
    name: string,
    peer: Peer,
    vehicle: VehicleChoice | undefined,
    profile: SeatProfile | null,
  ): SeatRef | null {
    const held = profile ? this.profileSeats.get(profile.id) : undefined;
    const live = held !== undefined && held.seat.peer !== null;
    const seat = room.addSeat(name, peer, vehicle, live ? null : profile);
    if (!seat) return null;
    const ref = { room, seat };
    this.sessions.set(seat.token, ref);
    if (seat.profile) {
      if (held) this.leave(held);
      this.profileSeats.set(seat.profile.id, ref);
    }
    return ref;
  }

  private forget(room: Room, seat: Seat): void {
    this.sessions.delete(seat.token);
    const id = seat.profile?.id;
    if (id && this.profileSeats.get(id)?.seat === seat) this.profileSeats.delete(id);
    if (room.isEmpty) this.rooms.delete(room.code);
  }

  /**
   * A room whose update threw is closed: its players are told, with an error id that matches
   * the log line, and every other room carries on.
   */
  private fail(room: Room, error: unknown): void {
    const errorId = newErrorId();
    this.log.error('room', 'room failed and was closed', { room: room.code, errorId, error });
    if (this.options.metrics) this.options.metrics.roomErrors++;
    this.rooms.delete(room.code);
    for (const seat of room.seats) {
      this.sessions.delete(seat.token);
      const id = seat.profile?.id;
      if (id && this.profileSeats.get(id)?.seat === seat) this.profileSeats.delete(id);
      try {
        seat.peer?.close(
          `This room hit a server error and was closed (error ${errorId}). Create a new room to play on.`,
        );
      } catch {
        // The connection is going anyway.
      }
    }
  }
}
