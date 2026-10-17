import {
  encodeInputPacket,
  EV,
  PROTOCOL_VERSION,
  type Ack,
  type EventsMessage,
  type RaceResults,
  type RaceStartInfo,
  type RoomState,
  type SeatGrant,
  type SnapshotMessage,
} from '@circuit-breaker/shared';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../src/log';
import { Metrics } from '../src/metrics';
import { attachSocketServer, type SocketOptions } from '../src/net/socketServer';
import { Room } from '../src/rooms/Room';
import { RoomManager } from '../src/rooms/RoomManager';
import { track } from './helpers';

interface Running {
  url: string;
  port: number;
  manager: RoomManager;
  metrics: Metrics;
}

const servers: HttpServer[] = [];
const managers: RoomManager[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  for (const m of managers.splice(0)) m.stop();
  await Promise.all(servers.splice(0).map((h) => new Promise((r) => h.close(r))));
});

async function serve(options: SocketOptions = {}, graceMs = 4000): Promise<Running> {
  const now = () => performance.now();
  const metrics = new Metrics();
  const manager = new RoomManager(track, now, { graceMs, log: silentLogger, metrics });
  const http = createServer();
  attachSocketServer(http, manager, now, { log: silentLogger, metrics, ...options });
  manager.start(4);
  managers.push(manager);
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, manager, metrics };
}

function client(
  url: string,
  options: { origin?: string; transports?: string[] } = {},
): Promise<Socket> {
  const socket = connect(url, {
    transports: options.transports ?? ['websocket'],
    forceNew: true,
    reconnection: false,
    extraHeaders: options.origin ? { origin: options.origin } : {},
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const refusedConnection = (url: string, options: Parameters<typeof client>[1] = {}) =>
  client(url, options).then(
    () => false,
    () => true,
  );

const request = <T = null>(socket: Socket, event: string, payload?: unknown) =>
  socket.timeout(3000).emitWithAck(event, payload) as Promise<Ack<T>>;

async function seated(url: string, name: string, code?: string) {
  const socket = await client(url);
  const ack = code
    ? await request<SeatGrant>(socket, EV.join, { code, name, version: PROTOCOL_VERSION })
    : await request<SeatGrant>(socket, EV.create, { name, version: PROTOCOL_VERSION });
  if (!ack.ok) throw new Error(ack.error);
  return { socket, grant: ack.data };
}

const disconnection = (socket: Socket, ms = 3000) =>
  new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('still connected'), ms);
    socket.once('disconnect', (reason) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the front door under abuse', () => {
  it('drops a connection that floods messages of any kind; other players are untouched', async () => {
    const s = await serve();
    const player = await seated(s.url, 'Player');
    const attacker = await client(s.url);
    const dropped = disconnection(attacker);
    for (let i = 0; i < 2000; i++) attacker.emit('anything', i);
    expect(await dropped).toBe('io server disconnect');
    expect(s.metrics.abuseDisconnects).toBe(1);
    expect(s.metrics.messagesRefused).toBeGreaterThan(300);
    // The player was never affected.
    expect(player.socket.connected).toBe(true);
    expect((await request(player.socket, EV.laps, { laps: 2 })).ok).toBe(true);
  });

  it('counts input sent outside a race too: a lobby flood is dropped', async () => {
    const s = await serve();
    const flooder = await seated(s.url, 'Flood');
    const dropped = disconnection(flooder.socket);
    for (let i = 0; i < 2000; i++) {
      flooder.socket.emit(EV.input, encodeInputPacket(1, 1, [[100, 0, 0, 0]]));
    }
    expect(await dropped).toBe('io server disconnect');
    // The seat is held for a resume like any dropped seat, and the room is still there.
    expect(s.manager.rooms.get(flooder.grant.room.code)?.seats).toHaveLength(1);
  });

  it('closes a connection that sends a message over the size limit', async () => {
    const s = await serve();
    const socket = await client(s.url);
    const dropped = disconnection(socket);
    socket.emit(EV.create, { name: 'x'.repeat(5000), version: PROTOCOL_VERSION });
    expect(await dropped).toBe('transport close');
    expect(s.manager.rooms.size).toBe(0);
  });

  it('speaks WebSocket only', async () => {
    const s = await serve();
    expect(await refusedConnection(s.url, { transports: ['polling'] })).toBe(true);
    expect(await refusedConnection(s.url)).toBe(false);
  });

  it("refuses another site's pages, and lets its own page and non-browser clients in", async () => {
    const s = await serve({ corsOrigin: 'https://client.example' });
    expect(await refusedConnection(s.url, { origin: 'https://evil.example' })).toBe(true);
    expect(await refusedConnection(s.url, { origin: 'null' })).toBe(true);
    expect(await refusedConnection(s.url, { origin: `http://127.0.0.1:${s.port}` })).toBe(false);
    expect(await refusedConnection(s.url, { origin: 'https://client.example' })).toBe(false);
    expect(await refusedConnection(s.url)).toBe(false);
    expect(s.metrics.connectionsRefused.origin).toBe(2);
  });

  it('caps connections per address and in total, and how fast an address may open them', async () => {
    const perAddress = await serve({ limits: { maxConnectionsPerAddress: 4 } });
    const four = await Promise.all([1, 2, 3, 4].map(() => client(perAddress.url)));
    expect(await refusedConnection(perAddress.url)).toBe(true);
    four[0].disconnect();
    await sleep(100);
    expect(await refusedConnection(perAddress.url)).toBe(false);
    expect(perAddress.metrics.connectionsRefused.address).toBe(1);

    const total = await serve({ limits: { maxConnections: 2 } });
    await client(total.url);
    await client(total.url);
    expect(await refusedConnection(total.url)).toBe(true);
    expect(total.metrics.connectionsRefused.total).toBe(1);

    const churn = await serve({ limits: { connectBurst: 3, connectsPerMinute: 1 } });
    for (let i = 0; i < 3; i++) (await client(churn.url)).disconnect();
    expect(await refusedConnection(churn.url)).toBe(true);
    expect(churn.metrics.connectionsRefused.rate).toBe(1);
  });

  it('refuses new connections and seats while the server shuts down', async () => {
    let open = true;
    const s = await serve({ accepting: () => open });
    const early = await client(s.url);
    open = false;
    expect(await refusedConnection(s.url)).toBe(true);
    const ack = await request(early, EV.create, { name: 'Late', version: PROTOCOL_VERSION });
    expect(!ack.ok && ack.error).toMatch(/restarting/);
  });

  it('answers a failing handler with an error id and keeps serving', async () => {
    const s = await serve();
    const host = await seated(s.url, 'Host');
    vi.spyOn(s.manager, 'join').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const guest = await client(s.url);
    const ack = await request(guest, EV.join, {
      code: host.grant.room.code,
      name: 'Guest',
      version: PROTOCOL_VERSION,
    });
    expect(!ack.ok && ack.error).toMatch(
      /^Something went wrong on the server \(error [0-9A-Z]{8}\)\.$/,
    );
    expect(s.metrics.handlerErrors).toBe(1);
    // A throw inside the input handler is caught too (it would otherwise end the process).
    const receive = vi.spyOn(Room.prototype, 'receiveInput').mockImplementation(() => {
      throw new Error('input boom');
    });
    host.socket.emit(EV.input, encodeInputPacket(0, 1, [[0, 0, 0, 0]]));
    await sleep(100);
    receive.mockRestore();
    expect(s.metrics.handlerErrors).toBe(2);
    const again = await request(guest, EV.join, {
      code: host.grant.room.code,
      name: 'Guest',
      version: PROTOCOL_VERSION,
    });
    expect(again.ok).toBe(true);
    expect(host.socket.connected).toBe(true);
  });
});

describe('server authority over the wire', () => {
  it('checks the seat, the host and the phase of every lobby request', async () => {
    const s = await serve();
    const host = await seated(s.url, 'Host');
    const guest = await seated(s.url, 'Guest', host.grant.room.code);
    const room = s.manager.rooms.get(host.grant.room.code)!;
    for (const [event, payload] of [
      [EV.laps, { laps: 2 }],
      [EV.start, { raceId: 0 }],
      [EV.restart, { raceId: 0 }],
      [EV.toLobby, { raceId: 0 }],
      [EV.newSession, {}],
    ] as const) {
      const ack = await request(guest.socket, event, payload);
      expect(!ack.ok && ack.error, event).toMatch(/Only the host/);
    }
    // A connection without a seat can do none of it.
    const stranger = await client(s.url);
    for (const event of [EV.ready, EV.vehicle, EV.laps, EV.start, EV.restart, EV.toLobby]) {
      const ack = await request(stranger, event, { raceId: 0, ready: true, laps: 2 });
      expect(!ack.ok && ack.error, event).toBe('You are not in a room.');
    }
    // Host requests outside their phase are refused too.
    expect((await request(host.socket, EV.restart, { raceId: 0 })).ok).toBe(false);
    expect((await request(host.socket, EV.toLobby, { raceId: 0 })).ok).toBe(false);
    expect(room.laps).toBe(3);
    expect(room.publicPhase).toBe('waiting');
  });

  it('refuses malformed payloads on every event and stays consistent', async () => {
    const s = await serve();
    const host = await seated(s.url, 'Host');
    const room = s.manager.rooms.get(host.grant.room.code)!;
    const junk: unknown[] = [
      undefined,
      null,
      42,
      'text',
      [],
      [1, 2, 3],
      { raceId: -1 },
      { raceId: 1.5 },
      { raceId: '0' },
      { raceId: 0, ready: 'yes' },
      { laps: 'many' },
      { laps: 1.5 },
      { color: -1, style: 0 },
      { color: 1, style: 99 },
      { code: 12345, name: {} },
      { token: { $ne: '' } },
      { a: { b: { c: { d: { e: {} } } } } },
    ];
    const events = [EV.create, EV.join, EV.resume, EV.ready, EV.vehicle, EV.laps, EV.start];
    // Several connections, so the per-connection request budget is not what answers.
    for (const [i, event] of events.entries()) {
      const caller = i < 3 ? await client(s.url) : host.socket;
      for (const payload of junk) {
        const ack = await request<unknown>(caller, event, payload);
        // Whatever the junk, the answer is a well-formed refusal (or a harmless no-op).
        expect(typeof ack.ok).toBe('boolean');
        if (!ack.ok) expect(ack.error.length).toBeGreaterThan(0);
      }
      // The host's connection answers four events: let its request budget refill.
      if (caller === host.socket) await sleep(1800);
    }
    expect(s.manager.rooms.size).toBe(1);
    expect(room.seats).toHaveLength(1);
    expect(room.laps).toBe(3);
    expect(room.seats[0].color).toBe(0);
    expect(room.publicPhase).toBe('waiting');
    expect(s.metrics.handlerErrors).toBe(0);
    // A name that is not text becomes the default name, never markup or an object.
    const odd = await client(s.url);
    const made = await request<SeatGrant>(odd, EV.create, {
      name: { $gt: '' },
      version: PROTOCOL_VERSION,
    });
    expect(made.ok && made.data.room.players[0].name).toBe('Racer');
  }, 30_000);

  it("never sends a seat's token to anyone but its owner", async () => {
    const s = await serve();
    const host = await seated(s.url, 'Host');
    const seen: string[] = [];
    const guestSocket = await client(s.url);
    guestSocket.onAny((event: string, payload: unknown) =>
      seen.push(`${event} ${JSON.stringify(payload)}`),
    );
    const ack = await request<SeatGrant>(guestSocket, EV.join, {
      code: host.grant.room.code,
      name: 'Guest',
      version: PROTOCOL_VERSION,
    });
    expect(ack.ok).toBe(true);
    await request(guestSocket, EV.ready, { ready: true, raceId: 0 });
    await request(host.socket, EV.start, { raceId: 0 });
    await sleep(1500);
    expect(seen.some((line) => line.startsWith(EV.raceStart))).toBe(true);
    expect(seen.some((line) => line.startsWith(EV.snapshot))).toBe(true);
    for (const line of seen) expect(line).not.toContain(host.grant.token);
    // And the room state lists no secret of any seat.
    const state = s.manager.rooms.get(host.grant.room.code)!.state();
    expect(JSON.stringify(state)).not.toContain(host.grant.token);
    expect(Object.keys(state.players[0]).sort()).not.toContain('token');
  });

  it('refuses a seat token once the seat is gone: left, or its grace period over', async () => {
    const s = await serve({}, 400);
    const host = await seated(s.url, 'Host');
    const leaver = await seated(s.url, 'Leaver', host.grant.room.code);
    await request(leaver.socket, EV.leave);
    const again = await client(s.url);
    const afterLeave = await request(again, EV.resume, {
      token: leaver.grant.token,
      version: PROTOCOL_VERSION,
    });
    expect(!afterLeave.ok && afterLeave.error).toMatch(/expired/);

    const dropper = await seated(s.url, 'Dropper', host.grant.room.code);
    dropper.socket.disconnect();
    await sleep(900);
    const late = await client(s.url);
    const afterGrace = await request(late, EV.resume, {
      token: dropper.grant.token,
      version: PROTOCOL_VERSION,
    });
    expect(!afterGrace.ok && afterGrace.error).toMatch(/expired/);
    expect(s.manager.rooms.get(host.grant.room.code)!.seats).toHaveLength(1);
    expect(s.manager.sessionCount).toBe(1);
  });

  it('resumes a seat for one connection only, never as a second seat', async () => {
    const s = await serve();
    const host = await seated(s.url, 'Host');
    const guest = await seated(s.url, 'Guest', host.grant.room.code);
    const [a, b] = await Promise.all([client(s.url), client(s.url)]);
    const kicked: string[] = [];
    for (const socket of [guest.socket, a, b]) {
      socket.on(EV.kicked, (p: { reason: string }) => kicked.push(p.reason));
    }
    const resume = { token: guest.grant.token, version: PROTOCOL_VERSION };
    const [ra, rb] = await Promise.all([
      request<SeatGrant>(a, EV.resume, resume),
      request<SeatGrant>(b, EV.resume, resume),
    ]);
    expect(ra.ok && rb.ok).toBe(true);
    await sleep(200);
    const room = s.manager.rooms.get(host.grant.room.code)!;
    expect(room.seats).toHaveLength(2);
    // The original connection and one of the two resumers were closed: one controls the seat.
    expect(kicked).toHaveLength(2);
    expect([a.connected, b.connected].filter(Boolean)).toHaveLength(1);
    // A seated connection cannot take another seat, or someone else's.
    const live = a.connected ? a : b;
    expect((await request(live, EV.create, { name: 'X', version: PROTOCOL_VERSION })).ok).toBe(
      false,
    );
    const steal = await request(live, EV.resume, {
      token: host.grant.token,
      version: PROTOCOL_VERSION,
    });
    expect(!steal.ok && steal.error).toMatch(/already in a room/);
  });

  it('joining by room code never takes over a player: same name, a new seat', async () => {
    const s = await serve();
    const host = await seated(s.url, 'Nova');
    const copy = await seated(s.url, 'Nova', host.grant.room.code);
    expect(copy.grant.playerId).not.toBe(host.grant.playerId);
    expect(copy.grant.token).not.toBe(host.grant.token);
    const names = copy.grant.room.players.map((p) => p.name);
    expect(names).toEqual(['Nova', 'Nova 2']);
    expect(copy.grant.room.hostId).toBe(host.grant.playerId);
    expect((await request(copy.socket, EV.start, { raceId: 0 })).ok).toBe(false);
  });
});

describe('abuse limits over a long session', () => {
  it('never drops a player whose catch-up bursts add up; still drops a flood', async () => {
    // A clock the test moves: the limits refill only as fast as it says.
    let t = 1000;
    const now = () => t;
    const metrics = new Metrics();
    const manager = new RoomManager(track, now, { log: silentLogger, metrics });
    const http = createServer();
    attachSocketServer(http, manager, now, { log: silentLogger, metrics });
    managers.push(manager);
    servers.push(http);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const host = await seated(url, 'Host');
    const guest = await seated(url, 'Guest', host.grant.room.code);
    await request(guest.socket, EV.ready, { ready: true, raceId: 0 });
    await request(host.socket, EV.start, { raceId: 0 });
    const seat = manager.rooms.get(host.grant.room.code)!.seatById(guest.grant.playerId)!;
    const burst = (n: number) => {
      for (let i = 0; i < n; i++) {
        guest.socket.emit(EV.input, encodeInputPacket(1, 10 + i, [[100, 0, 0, 0]]));
      }
    };
    // Six times, a burst like a client catching up after a stall, three seconds apart.
    for (let i = 0; i < 6; i++) {
      burst(150);
      await sleep(250);
      t += 3000;
    }
    // Over 400 refused in all (the old lifetime limit), yet never more than the window allows.
    expect(seat.inputBucket.refused).toBeGreaterThan(400);
    expect(guest.socket.connected).toBe(true);
    expect(metrics.abuseDisconnects).toBe(0);
    // A flood within one window is still dropped.
    const dropped = disconnection(guest.socket);
    burst(3000);
    expect(await dropped).toBe('io server disconnect');
    expect(metrics.abuseDisconnects).toBe(1);
  });
});

describe('snapshot delivery', () => {
  it('delivers a snapshot sent right behind another message; skips them only when congested', async () => {
    const s = await serve();
    const host = await seated(s.url, 'Host');
    const peer = [...s.manager.rooms.values()][0].seats[0].peer!;
    const got = { event: 0, snap: 0 };
    host.socket.on('test:event', () => got.event++);
    host.socket.on('test:snap', () => got.snap++);
    // A tick that sends an event and then a snapshot, twenty times: every snapshot arrives.
    // (Socket.IO's volatile flag dropped nearly all of these: the event was still being written.)
    for (let i = 0; i < 20; i++) {
      peer.send('test:event', i);
      peer.sendVolatile('test:snap', i);
      await sleep(5);
    }
    await sleep(200);
    expect(got).toEqual({ event: 20, snap: 20 });
    expect(s.metrics.snapshotsDiscarded.total).toBe(0);
    // Forty at once is a backlog: once eight messages wait, the rest are skipped and counted.
    for (let i = 0; i < 40; i++) peer.sendVolatile('test:snap', i);
    await sleep(200);
    expect(got.snap - 20).toBeLessThan(12);
    expect(s.metrics.snapshotsDiscarded.total).toBe(40 - (got.snap - 20));
  });
});

describe('rooms side by side over the wire', () => {
  it('keeps rooms of 2, 4 and 8 players apart: states, starts, snapshots and events', async () => {
    const s = await serve();
    const sizes = [2, 4, 8];
    const rooms = await Promise.all(
      sizes.map(async (size, r) => {
        const host = await seated(s.url, `R${r}H`);
        const players = [host];
        for (let i = 1; i < size; i++) {
          players.push(await seated(s.url, `R${r}P${i}`, host.grant.room.code));
        }
        return { code: host.grant.room.code, players };
      }),
    );
    const seen = rooms.map(() => ({
      states: [] as RoomState[],
      starts: [] as RaceStartInfo[],
      snaps: [] as SnapshotMessage[],
      events: [] as EventsMessage[],
      results: [] as RaceResults[],
    }));
    rooms.forEach((room, r) => {
      for (const p of room.players) {
        p.socket.on(EV.room, (m: RoomState) => seen[r].states.push(m));
        p.socket.on(EV.raceStart, (m: RaceStartInfo) => seen[r].starts.push(m));
        p.socket.on(EV.snapshot, (m: SnapshotMessage) => seen[r].snaps.push(m));
        p.socket.on(EV.events, (m: EventsMessage) => seen[r].events.push(m));
        p.socket.on(EV.results, (m: RaceResults) => seen[r].results.push(m));
      }
    });
    for (const room of rooms) {
      for (const p of room.players.slice(1)) {
        expect((await request(p.socket, EV.ready, { ready: true, raceId: 0 })).ok).toBe(true);
      }
      expect((await request(room.players[0].socket, EV.start, { raceId: 0 })).ok).toBe(true);
    }
    await sleep(6000);
    rooms.forEach((room, r) => {
      const ids = new Set(room.players.map((p) => p.grant.playerId));
      const own = seen[r];
      expect(own.states.every((m) => m.code === room.code)).toBe(true);
      expect(own.states.every((m) => m.players.every((p) => ids.has(p.id)))).toBe(true);
      expect(own.starts).toHaveLength(room.players.length);
      expect(own.starts.every((m) => m.racers.every((x) => ids.has(x.id)))).toBe(true);
      expect(own.snaps.length).toBeGreaterThan(room.players.length * 20);
      expect(own.snaps.every((m) => m.r.length === room.players.length)).toBe(true);
      for (const m of own.events) {
        for (const e of m.e) if ('racerId' in e) expect(ids.has(e.racerId)).toBe(true);
      }
    });
  }, 30_000);
});
