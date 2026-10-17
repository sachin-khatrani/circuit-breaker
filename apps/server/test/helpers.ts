import {
  autopilotInput,
  createInput,
  encodeInputPacket,
  GRID_ZERO,
  packInputFrame,
  TICK_RATE,
  Track,
  type InputFrame,
} from '@circuit-breaker/shared';
import type { RaceRatingSink } from '../src/ranking/types';
import type { Peer, Room, Seat } from '../src/rooms/Room';
import { RoomManager, type SeatRef } from '../src/rooms/RoomManager';

export const track = new Track(GRID_ZERO);
export const TICK_MS = 1000 / TICK_RATE;

/** A connection that records everything sent to it. */
export class FakePeer implements Peer {
  readonly messages: { event: string; payload: unknown }[] = [];
  closed: string | null = null;
  send(event: string, payload: unknown): void {
    this.messages.push({ event, payload });
  }
  sendVolatile(event: string, payload: unknown): void {
    this.messages.push({ event, payload });
  }
  close(reason: string): void {
    this.closed = reason;
  }
  all<T>(event: string): T[] {
    return this.messages.filter((m) => m.event === event).map((m) => m.payload as T);
  }
  last<T>(event: string): T | undefined {
    return this.all<T>(event).at(-1);
  }
  clear(): void {
    this.messages.length = 0;
  }
}

export class ManualClock {
  t = 1000;
  readonly now = () => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export function setup(
  options: {
    graceMs?: number;
    maxRooms?: number;
    snapshotRate?: number;
    ranking?: RaceRatingSink;
  } = {},
) {
  const clock = new ManualClock();
  const manager = new RoomManager(track, clock.now, { snapshotRate: 20, ...options });
  return { clock, manager };
}

export function seatRef(ref: SeatRef | string): SeatRef {
  if (typeof ref === 'string') throw new Error(`expected a seat, got "${ref}"`);
  return ref;
}

/** A room with `count` players (the first is the host), each with its own fake connection. */
export function roomWith(manager: RoomManager, count: number) {
  const peers = Array.from({ length: count }, () => new FakePeer());
  const host = seatRef(manager.create('Host', peers[0]));
  const refs = [host];
  for (let i = 1; i < count; i++)
    refs.push(seatRef(manager.join(host.room.code, `P${i}`, peers[i])));
  return { room: host.room, refs, peers, seats: refs.map((r) => r.seat) };
}

/** Everyone ready, host starts. */
export function startRace(room: Room, seats: Seat[]): void {
  for (const seat of seats.slice(1)) room.setReady(seat, true);
  const error = room.start(seats[0]);
  if (error) throw new Error(error);
}

const input = createInput();
const calls = new WeakMap<Room, number>();

/**
 * Drives the given seats with the shared autopilot through the same input path a socket
 * uses (encoded packets, validation, rate limit): every other call, frames for the next
 * `lead` ticks, which stays under the input rate limit like the real client.
 */
export function sendBotInputs(room: Room, seats: Seat[], lead = 3): void {
  const race = room.currentRace;
  if (!race || race.results) return;
  const sim = race.sim;
  const n = (calls.get(room) ?? 0) + 1;
  calls.set(room, n);
  if (n % 2 !== 0) return;
  for (const [i, seat] of seats.entries()) {
    const racer = sim.getRacer(seat.id);
    if (!racer || racer.retired) continue;
    autopilotInput(
      track,
      racer.vehicle,
      { boost: true, racingLine: true, lane: (i % 3) - 1, course: sim.course, tick: sim.tick },
      input,
    );
    if (sim.phase === 'countdown') input.throttle = sim.goTick - sim.tick <= 15 ? 1 : 0;
    const frame: InputFrame = packInputFrame(input);
    const frames = Array.from({ length: lead }, () => frame);
    room.receiveInput(seat, encodeInputPacket(race.info.raceId, sim.tick + 1, frames));
  }
}

/** Advances the clock one tick at a time, driving `drivers`, until `done` or a time limit. */
export function runUntil(
  clock: ManualClock,
  manager: RoomManager,
  room: Room,
  drivers: Seat[],
  done: () => boolean,
  maxSeconds = 600,
): void {
  for (let i = 0; i < maxSeconds * TICK_RATE && !done(); i++) {
    sendBotInputs(room, drivers);
    clock.advance(TICK_MS);
    manager.update();
  }
}
