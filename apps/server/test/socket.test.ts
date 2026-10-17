import {
  encodeInputPacket,
  EV,
  GRID_ZERO,
  PROTOCOL_VERSION,
  Track,
  unpackRacerRow,
  createRacerRow,
  type Ack,
  type RaceStartInfo,
  type RoomState,
  type SeatGrant,
  type SnapshotMessage,
} from '@circuit-breaker/shared';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachSocketServer } from '../src/net/socketServer';
import { RoomManager } from '../src/rooms/RoomManager';

let http: HttpServer;
let url = '';
let manager: RoomManager;
const sockets: Socket[] = [];

beforeAll(async () => {
  manager = new RoomManager(new Track(GRID_ZERO), () => performance.now(), { graceMs: 4000 });
  http = createServer();
  attachSocketServer(http, manager, () => performance.now());
  manager.start(4);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  manager.stop();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

async function client(): Promise<Socket> {
  const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

const request = <T>(socket: Socket, event: string, payload: unknown = {}) =>
  socket.timeout(3000).emitWithAck(event, payload) as Promise<Ack<T>>;

function next<T>(socket: Socket, event: string, test: (v: T) => boolean = () => true, ms = 8000) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, on);
      reject(new Error(`no ${event} within ${ms} ms`));
    }, ms);
    const on = (value: T) => {
      if (!test(value)) return;
      clearTimeout(timer);
      socket.off(event, on);
      resolve(value);
    };
    socket.on(event, on);
  });
}

async function seated(name: string, code?: string) {
  const socket = await client();
  const ack = code
    ? await request<SeatGrant>(socket, EV.join, { code, name, version: PROTOCOL_VERSION })
    : await request<SeatGrant>(socket, EV.create, { name, version: PROTOCOL_VERSION });
  if (!ack.ok) throw new Error(ack.error);
  return { socket, grant: ack.data };
}

describe('over real Socket.IO connections', () => {
  it('creates and joins rooms, validating every payload', async () => {
    const host = await seated('Nova');
    expect(host.grant.room.players[0]).toMatchObject({ name: 'Nova', host: true });
    const stateSeen = next<RoomState>(host.socket, EV.room, (s) => s.players.length === 2);
    const guest = await seated('Zed', host.grant.room.code.toLowerCase());
    expect((await stateSeen).players.map((p) => p.name)).toEqual(['Nova', 'Zed']);
    expect(guest.grant.token).not.toBe(host.grant.token);

    const other = await client();
    const refused = async (event: string, payload: unknown, pattern?: RegExp) => {
      const result = await request(other, event, payload);
      expect(result.ok).toBe(false);
      if (pattern && !result.ok) expect(result.error).toMatch(pattern);
    };
    await refused(EV.join, { code: 'ABCDEF', name: 'X', version: PROTOCOL_VERSION }, /No room/);
    await refused(EV.join, { code: 'bad', name: 'X', version: PROTOCOL_VERSION }, /6 letters/);
    await refused(EV.join, { code: host.grant.room.code, name: 'X', version: 999 }, /out of date/);
    await refused(EV.join, 'not an object');
    await refused(EV.start, {}, /not in a room/);
    await refused(EV.resume, { token: 'x'.repeat(32), version: PROTOCOL_VERSION }, /expired/);
    // A seated connection cannot take a second seat, and only the host may start.
    const again = await request(guest.socket, EV.create, {
      name: 'Again',
      version: PROTOCOL_VERSION,
    });
    expect(again.ok).toBe(false);
    const start = await request(guest.socket, EV.start, { raceId: 0 });
    expect(!start.ok && start.error).toMatch(/host/);
  });

  it('starts both players on one server timestamp and drives only the sender’s car', async () => {
    const host = await seated('Ace');
    const guest = await seated('Bee', host.grant.room.code);
    expect(await request(guest.socket, EV.ready, { ready: true, raceId: 0 })).toEqual({
      ok: true,
      data: null,
    });
    const starts = [
      next<RaceStartInfo>(host.socket, EV.raceStart),
      next<RaceStartInfo>(guest.socket, EV.raceStart),
    ];
    expect(await request(host.socket, EV.start, { raceId: 0 })).toEqual({ ok: true, data: null });
    const [a, b] = await Promise.all(starts);
    expect(a).toEqual(b);
    expect(a.racers.map((r) => r.slot)).toEqual([0, 1]);
    // Snapshots carry each player's own full car, and rows for both.
    const snap = await next<SnapshotMessage>(guest.socket, EV.snapshot, (s) => s.me !== undefined);
    expect(snap.r).toHaveLength(2);

    // After GO, the guest holds full throttle (tick-stamped frames ahead of the server).
    await next<SnapshotMessage>(guest.socket, EV.snapshot, (s) => s.t > a.goTick + 10, 9000);
    let tick = 0;
    const throttle = setInterval(() => {
      tick = Math.max(tick, latest.t + 4);
      guest.socket.emit(
        EV.input,
        encodeInputPacket(
          a.raceId,
          tick,
          Array.from({ length: 6 }, () => [100, 0, 0, 0]),
        ),
      );
      tick += 2;
    }, 33);
    let latest = snap;
    guest.socket.on(EV.snapshot, (s: SnapshotMessage) => (latest = s));
    await new Promise((r) => setTimeout(r, 1500));
    clearInterval(throttle);
    const rows = latest.r.map((raw) => unpackRacerRow(raw, createRacerRow()));
    const mine = rows.find((r) => r.slot === 1)!;
    const theirs = rows.find((r) => r.slot === 0)!;
    expect(Math.hypot(mine.vx, mine.vz)).toBeGreaterThan(15);
    expect(Math.hypot(theirs.vx, theirs.vz)).toBeLessThan(1);
  }, 20000);

  it('resumes a dropped seat with its token, without duplicating it', async () => {
    const host = await seated('Host');
    const guest = await seated('Guest', host.grant.room.code);
    const dropped = next<RoomState>(host.socket, EV.room, (s) =>
      s.players.some((p) => !p.connected),
    );
    guest.socket.disconnect();
    expect((await dropped).players).toHaveLength(2);
    const again = await client();
    const back = next<RoomState>(host.socket, EV.room, (s) => s.players.every((p) => p.connected));
    const ack = await request<SeatGrant>(again, EV.resume, {
      token: guest.grant.token,
      version: PROTOCOL_VERSION,
    });
    expect(ack.ok && ack.data.playerId).toBe(guest.grant.playerId);
    expect((await back).players).toHaveLength(2);
  });

  it('ignores forged server events and keeps rooms apart', async () => {
    const one = await seated('One');
    const two = await seated('Two');
    let leaked = false;
    two.socket.on(EV.room, (s: RoomState) => {
      if (s.code === one.grant.room.code) leaked = true;
    });
    // A client "announcing" results, laps or room state is just ignored by the server.
    one.socket.emit(EV.results, { winnerId: one.grant.playerId });
    one.socket.emit(EV.events, { t: 1, e: [{ type: 'lap', racerId: one.grant.playerId }] });
    one.socket.emit(EV.input, 'garbage');
    await request(one.socket, EV.laps, { laps: 2 });
    const pong = (await one.socket.timeout(2000).emitWithAck(EV.ping, 123)) as {
      t0: number;
      now: number;
    };
    expect(pong.t0).toBe(123);
    expect(typeof pong.now).toBe('number');
    await new Promise((r) => setTimeout(r, 200));
    expect(leaked).toBe(false);
    expect(manager.rooms.get(one.grant.room.code)?.laps).toBe(2);
    expect(manager.rooms.get(two.grant.room.code)?.laps).toBe(3);
  });

  it('checks lobby requests on the wire: race ids, car choices, and no forged scores', async () => {
    const host = await seated('Host');
    const guest = await seated('Guest', host.grant.room.code);
    const room = manager.rooms.get(host.grant.room.code)!;
    const hostSeat = room.seatById(host.grant.playerId)!;
    const guestSeat = room.seatById(guest.grant.playerId)!;
    // Lobby and results requests must name the race their screen showed.
    expect(await request(guest.socket, EV.ready, { ready: true })).toEqual({
      ok: false,
      error: 'Bad request.',
    });
    const stale = await request(guest.socket, EV.ready, { ready: true, raceId: 7 });
    expect(!stale.ok && stale.error).toMatch(/earlier race/);
    expect(await request(host.socket, EV.start, { raceId: '0' })).toMatchObject({ ok: false });
    // Car choices: only real colours and styles, only free colours, only one's own car.
    for (const bad of [
      { color: 99, style: 0 },
      { color: 1, style: 7 },
      { color: '1', style: 0 },
    ]) {
      expect((await request(guest.socket, EV.vehicle, bad)).ok).toBe(false);
    }
    const taken = await request(guest.socket, EV.vehicle, { color: hostSeat.color, style: 0 });
    expect(!taken.ok && taken.error).toMatch(/Another player/);
    const own = await request(guest.socket, EV.vehicle, {
      color: 4,
      style: 2,
      id: host.grant.playerId,
    });
    expect(own.ok).toBe(true);
    expect([guestSeat.color, guestSeat.style]).toEqual([4, 2]);
    expect([hostSeat.color, hostSeat.style]).toEqual([0, 0]);
    // A new session is the host's call; scores a client makes up are not even listened to.
    expect((await request(guest.socket, EV.newSession)).ok).toBe(false);
    guest.socket.emit(EV.results, { raceId: 1, entries: [{ id: guestSeat.id, points: 100 }] });
    guest.socket.emit('session:points', { id: guestSeat.id, points: 999 });
    await new Promise((r) => setTimeout(r, 150));
    expect([guestSeat.points, guestSeat.races, room.sessionRaces]).toEqual([0, 0, 0]);
  });
});
