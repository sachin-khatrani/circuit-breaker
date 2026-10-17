import {
  EV,
  isVehicleChoice,
  normalizeRoomCode,
  PROTOCOL_VERSION,
  sanitizeNickname,
  type Ack,
  type SeatGrant,
} from '@circuit-breaker/shared';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { logger, newErrorId, type Logger } from '../log';
import type { Metrics, RefusalReason } from '../metrics';
import type { SeatProfile } from '../ranking/types';
import type { Peer, VehicleChoice } from '../rooms/Room';
import type { RoomManager, SeatRef } from '../rooms/RoomManager';
import { clientAddress } from './clientAddress';
import { fromOwnPage } from './origin';
import { BucketMap, TokenBucket } from './rateLimit';

/** Limits on what connections may do. Every one can be raised (the load harness does). */
export interface SocketLimits {
  /** Open connections in total, and from one address. */
  maxConnections: number;
  maxConnectionsPerAddress: number;
  /** New connections one address may open at once, then per minute. */
  connectBurst: number;
  connectsPerMinute: number;
  /** Messages one connection may send, of every kind: a burst, then this many a second. */
  messageBurst: number;
  messagesPerSecond: number;
  /**
   * A connection with this many messages refused within ABUSE_WINDOW_S is dropped. A window,
   * not a lifetime count: a real player's occasional burst (catching up after a stall) must
   * never add up to a disconnect over a long session; a flood reaches it within a second.
   */
  abuseLimit: number;
  /** The largest message accepted (bytes); a bigger one closes the connection. */
  maxMessageBytes: number;
  /** Rooms one address may create per minute. */
  createsPerMinute: number;
}

/**
 * Defaults. A playing client sends about 31 messages a second (inputs every other tick and a
 * clock ping) and its largest message is a few hundred bytes, so these leave it plenty of room.
 */
export const SOCKET_LIMITS: SocketLimits = {
  maxConnections: 1000,
  maxConnectionsPerAddress: 32,
  connectBurst: 32,
  connectsPerMinute: 64,
  messageBurst: 120,
  messagesPerSecond: 60,
  abuseLimit: 300,
  maxMessageBytes: 4096,
  createsPerMinute: 6,
};

export interface SocketOptions {
  /** Allowed browser origin for cross-origin clients; same-origin needs nothing. */
  corsOrigin?: string;
  /** Proxies in front of the server that set X-Forwarded-For (see clientAddress). */
  trustProxyHops?: number;
  /**
   * Turns a seat request's ticket into the profile it was issued for (single use). The
   * profile never comes from anything else the client sends.
   */
  redeemTicket?: (ticket: unknown) => SeatProfile | null;
  limits?: Partial<SocketLimits>;
  metrics?: Metrics;
  log?: Logger;
  /** False while the server shuts down: no new connections or seats. */
  accepting?: () => boolean;
}

/** Lobby requests per connection: a burst of 20, then 10 per second. */
const REQUEST_BURST = 20;
const REQUEST_RATE = 10;
/** A connection with this many refused or malformed input packets within the window is dropped. */
const INPUT_ABUSE_LIMIT = 400;
/** The window of both abuse limits (seconds). */
const ABUSE_WINDOW_S = 10;
/** Engine connections waiting for their Socket.IO handshake are closed after this long. */
const CONNECT_TIMEOUT_MS = 10_000;
/**
 * A connection with this many messages waiting to be written is congested: its snapshots
 * are skipped until it catches up (at 20 snapshots a second, about 0.4 s behind).
 */
const SNAPSHOT_BACKLOG = 8;

type Reply<T> = (result: Ack<T>) => void;

/** What this file uses of an Engine.IO connection (the transport under a Socket.IO socket). */
interface EngineSocket {
  request: IncomingMessage;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The car a create or join asks for; anything that is not a real choice is ignored. */
const vehicleOf = (payload: Record<string, unknown>): VehicleChoice | undefined =>
  isVehicleChoice(payload.color, payload.style)
    ? { color: payload.color as number, style: payload.style as number }
    : undefined;

/** The race a lobby request was made for (see Room); null when missing or not a race id. */
const raceIdOf = (payload: Record<string, unknown>): number | null =>
  typeof payload.raceId === 'number' && Number.isInteger(payload.raceId) && payload.raceId >= 0
    ? payload.raceId
    : null;

const RESTARTING = 'The server is restarting. Try again in a minute.';

/**
 * The Socket.IO front door. Connections are admitted per address and in total, from this
 * site's pages only (browsers), WebSocket only. Every message counts against its connection's
 * budget, every payload is validated here before it reaches a room, and the seat a connection
 * controls comes from the connection itself (set when it creates, joins or resumes), never
 * from anything the client claims. A handler that fails answers with an error id and leaves
 * the process running.
 */
export function attachSocketServer(
  http: HttpServer,
  manager: RoomManager,
  now: () => number,
  options: SocketOptions = {},
): Server {
  const limits: SocketLimits = { ...SOCKET_LIMITS, ...options.limits };
  const log = options.log ?? logger;
  const metrics = options.metrics;
  const hops = options.trustProxyHops ?? 0;
  const accepting = options.accepting ?? (() => true);
  const addressOf = new WeakMap<IncomingMessage, string>();
  const open = new Map<string, number>();
  const connects = new BucketMap(limits.connectBurst, limits.connectsPerMinute / 60);
  const creates = new BucketMap(limits.createsPerMinute, limits.createsPerMinute / 60);
  const refusedSince: Record<RefusalReason, number> = {
    origin: 0,
    address: 0,
    total: 0,
    rate: 0,
    draining: 0,
  };

  const refuse = (reason: RefusalReason) => {
    refusedSince[reason]++;
    if (metrics) metrics.connectionsRefused[reason]++;
  };

  const io = new Server(http, {
    maxHttpBufferSize: limits.maxMessageBytes,
    // The client only ever uses WebSocket; long-polling sessions would only add surface.
    transports: ['websocket'],
    pingInterval: 5000,
    pingTimeout: 8000,
    connectTimeout: CONNECT_TIMEOUT_MS,
    serveClient: false,
    cors: options.corsOrigin ? { origin: options.corsOrigin, credentials: true } : undefined,
    allowRequest: (req, done) => {
      if (!accepting()) {
        refuse('draining');
        return done(RESTARTING, false);
      }
      if (!fromOwnPage(req.headers, options.corsOrigin)) {
        refuse('origin');
        return done('Connections must come from the game page.', false);
      }
      const address = clientAddress(req.headers, req.socket.remoteAddress, hops);
      if (io.engine.clientsCount >= limits.maxConnections) {
        refuse('total');
        return done('The server is full right now.', false);
      }
      if ((open.get(address) ?? 0) >= limits.maxConnectionsPerAddress) {
        refuse('address');
        return done('Too many connections from this network.', false);
      }
      if (!connects.take(address, now())) {
        refuse('rate');
        return done('Too many new connections. Wait a moment.', false);
      }
      addressOf.set(req, address);
      done(null, true);
    },
  });

  // Open connections per address, counted at the transport level (handshake or not).
  io.engine.on('connection', (raw: EngineSocket) => {
    const address = addressOf.get(raw.request) ?? 'unknown';
    open.set(address, (open.get(address) ?? 0) + 1);
    if (metrics) {
      raw.on('packetCreate', (packet: { data?: unknown }) => {
        if (typeof packet.data === 'string') metrics.bytesOut.add(packet.data.length);
      });
    }
    raw.on('close', () => {
      const left = (open.get(address) ?? 1) - 1;
      if (left > 0) open.set(address, left);
      else open.delete(address);
    });
  });

  io.on('connection', (socket: Socket) => {
    if (metrics) metrics.connectionsAccepted++;
    const address = addressOf.get(socket.request) ?? 'unknown';
    let current: SeatRef | null = null;
    const requests = new TokenBucket(REQUEST_BURST, REQUEST_RATE, now());
    const messages = new TokenBucket(limits.messageBurst, limits.messagesPerSecond, now());
    // Strikes: each refusal takes one; they come back over the window, and none left means
    // the connection is abusive (see SocketLimits.abuseLimit).
    const strikes = new TokenBucket(limits.abuseLimit, limits.abuseLimit / ABUSE_WINDOW_S, now());
    const inputStrikes = new TokenBucket(
      INPUT_ABUSE_LIMIT,
      INPUT_ABUSE_LIMIT / ABUSE_WINDOW_S,
      now(),
    );
    // Messages waiting behind the one being written: Engine.IO's write buffer.
    let queued = 0;
    socket.conn.on('packetCreate', () => queued++);
    socket.conn.on('flush', (buffer: unknown[]) => (queued -= buffer.length));
    const peer: Peer = {
      send: (event, payload) => socket.emit(event, payload),
      // A snapshot is skipped only when this connection is really behind (a newer one
      // follows). Socket.IO's volatile flag skipped one whenever the previous message was still
      // being written, even on a fast link: about 3% of snapshots in an 8-car race.
      sendVolatile: (event, payload) => {
        if (queued >= SNAPSHOT_BACKLOG) {
          metrics?.snapshotsDiscarded.add();
          return;
        }
        socket.emit(event, payload);
      },
      close: (reason) => {
        current = null;
        socket.emit(EV.kicked, { reason });
        socket.disconnect(true);
      },
    };
    const grant = (ref: SeatRef): SeatGrant => ({
      playerId: ref.seat.id,
      token: ref.seat.token,
      room: ref.room.state(),
    });

    /** Logs a handler failure with a fresh id, which is all the player is told. */
    const failed = (event: string, error: unknown): string => {
      const errorId = newErrorId();
      if (metrics) metrics.handlerErrors++;
      log.error('socket', `${event} handler failed`, { errorId, error });
      return errorId;
    };

    // Once: messages already received from a dropped connection still arrive here.
    let abusive = false;
    const abuse = (why: string) => {
      if (abusive) return;
      abusive = true;
      if (metrics) metrics.abuseDisconnects++;
      log.warn('socket', 'connection dropped for abuse', { why, address });
      socket.disconnect(true);
    };

    // Every message counts, whatever its event (unknown ones too): a connection cannot make
    // the server parse and dispatch more than its budget, and one that keeps trying is dropped.
    socket.use((_packet, next) => {
      if (abusive) return;
      metrics?.messagesIn.add();
      if (messages.take(now())) return next();
      if (metrics) metrics.messagesRefused++;
      if (!strikes.take(now())) abuse('message flood');
    });

    /** A listener that cannot throw past this point (a throw here would end the process). */
    const guard =
      <A extends unknown[]>(event: string, fn: (...args: A) => void) =>
      (...args: A) => {
        try {
          fn(...args);
        } catch (error) {
          failed(event, error);
        }
      };

    /** Wraps a request handler: ack check, rate limit, and a reply for every outcome. */
    const handle =
      <T>(event: string, fn: (payload: unknown, reply: Reply<T>) => void) =>
      (payload: unknown, ack: unknown) => {
        const reply: Reply<T> = typeof ack === 'function' ? (ack as Reply<T>) : () => {};
        if (!requests.take(now())) {
          reply({ ok: false, error: 'Too many requests. Slow down a little.' });
          return;
        }
        try {
          fn(payload, reply);
        } catch (error) {
          const errorId = failed(event, error);
          reply({ ok: false, error: `Something went wrong on the server (error ${errorId}).` });
        }
      };

    const versionOk = (payload: Record<string, unknown>) => payload.version === PROTOCOL_VERSION;
    const stale = 'This page is out of date. Reload it to play.';
    const profileOf = (payload: Record<string, unknown>): SeatProfile | null =>
      payload.ticket === undefined ? null : (options.redeemTicket?.(payload.ticket) ?? null);

    socket.on(
      EV.create,
      handle<SeatGrant>(EV.create, (payload, reply) => {
        if (!isRecord(payload)) return reply({ ok: false, error: 'Bad request.' });
        if (!versionOk(payload)) return reply({ ok: false, error: stale });
        if (current) return reply({ ok: false, error: 'You are already in a room.' });
        if (!accepting()) return reply({ ok: false, error: RESTARTING });
        if (!creates.take(address, now())) {
          return reply({ ok: false, error: 'Too many rooms created. Wait a minute.' });
        }
        const name = sanitizeNickname(payload.name) ?? 'Racer';
        const ref = manager.create(name, peer, vehicleOf(payload), profileOf(payload));
        if (typeof ref === 'string') return reply({ ok: false, error: ref });
        current = ref;
        reply({ ok: true, data: grant(ref) });
      }),
    );

    socket.on(
      EV.join,
      handle<SeatGrant>(EV.join, (payload, reply) => {
        if (!isRecord(payload)) return reply({ ok: false, error: 'Bad request.' });
        if (!versionOk(payload)) return reply({ ok: false, error: stale });
        if (current) return reply({ ok: false, error: 'You are already in a room.' });
        if (!accepting()) return reply({ ok: false, error: RESTARTING });
        const code = normalizeRoomCode(payload.code);
        if (!code) return reply({ ok: false, error: 'Room codes are 6 letters and digits.' });
        const name = sanitizeNickname(payload.name) ?? 'Racer';
        const ref = manager.join(code, name, peer, vehicleOf(payload), profileOf(payload));
        if (typeof ref === 'string') return reply({ ok: false, error: ref });
        current = ref;
        reply({ ok: true, data: grant(ref) });
      }),
    );

    socket.on(
      EV.resume,
      handle<SeatGrant>(EV.resume, (payload, reply) => {
        if (!isRecord(payload) || typeof payload.token !== 'string') {
          return reply({ ok: false, error: 'Bad request.' });
        }
        if (!versionOk(payload)) return reply({ ok: false, error: stale });
        if (payload.token.length > 64) return reply({ ok: false, error: 'Bad request.' });
        if (current && current.seat.token !== payload.token) {
          return reply({ ok: false, error: 'You are already in a room.' });
        }
        const ref = manager.resume(payload.token, peer);
        if (typeof ref === 'string') return reply({ ok: false, error: ref });
        current = ref;
        reply({ ok: true, data: grant(ref) });
      }),
    );

    socket.on(
      EV.leave,
      handle<null>(EV.leave, (_payload, reply) => {
        if (current) manager.leave(current);
        current = null;
        reply({ ok: true, data: null });
      }),
    );

    /** Requests that need a seat: run the room action, reply with its error or ok. */
    const seated = (
      event: string,
      action: (ref: SeatRef, payload: Record<string, unknown>) => string | null,
    ) =>
      handle<null>(event, (payload, reply) => {
        if (!current) return reply({ ok: false, error: 'You are not in a room.' });
        const error = action(current, isRecord(payload) ? payload : {});
        reply(error === null ? { ok: true, data: null } : { ok: false, error });
      });

    // Every request made from a lobby or results screen names the race that screen showed.
    socket.on(
      EV.ready,
      seated(EV.ready, (ref, p) => {
        const raceId = raceIdOf(p);
        if (typeof p.ready !== 'boolean' || raceId === null) return 'Bad request.';
        return ref.room.setReady(ref.seat, p.ready, raceId);
      }),
    );
    socket.on(
      EV.vehicle,
      seated(EV.vehicle, (ref, p) =>
        isVehicleChoice(p.color, p.style)
          ? ref.room.setVehicle(ref.seat, p.color as number, p.style as number)
          : 'That car is not available.',
      ),
    );
    socket.on(
      EV.laps,
      seated(EV.laps, (ref, p) =>
        typeof p.laps === 'number' && Number.isInteger(p.laps)
          ? ref.room.setLaps(ref.seat, p.laps)
          : 'Bad request.',
      ),
    );
    socket.on(
      EV.start,
      seated(EV.start, (ref, p) => {
        const raceId = raceIdOf(p);
        return raceId === null ? 'Bad request.' : ref.room.start(ref.seat, raceId);
      }),
    );
    socket.on(
      EV.restart,
      seated(EV.restart, (ref, p) => {
        const raceId = raceIdOf(p);
        return raceId === null ? 'Bad request.' : ref.room.restart(ref.seat, raceId);
      }),
    );
    socket.on(
      EV.toLobby,
      seated(EV.toLobby, (ref, p) => {
        const raceId = raceIdOf(p);
        return raceId === null ? 'Bad request.' : ref.room.toLobby(ref.seat, raceId);
      }),
    );
    socket.on(
      EV.newSession,
      seated(EV.newSession, (ref) => ref.room.newSession(ref.seat)),
    );

    socket.on(
      EV.input,
      guard(EV.input, (raw: unknown) => {
        if (!current) return;
        const seat = current.seat;
        const before = seat.inputBucket.refused + seat.malformed;
        current.room.receiveInput(seat, raw);
        const refused = seat.inputBucket.refused + seat.malformed - before;
        if (refused > 0 && !inputStrikes.take(now())) abuse('input flood');
      }),
    );

    // Clock sync: the client times the round trip and reads the server clock from the reply.
    socket.on(
      EV.ping,
      guard(EV.ping, (t0: unknown, ack: unknown) => {
        if (typeof ack !== 'function' || typeof t0 !== 'number' || !Number.isFinite(t0)) return;
        if (!requests.take(now())) return;
        (ack as (reply: { t0: number; now: number }) => void)({ t0, now: now() });
      }),
    );

    socket.on(
      'disconnect',
      guard('disconnect', (reason: string) => {
        metrics?.disconnected(reason);
        if (current) manager.drop(current, peer);
        current = null;
      }),
    );
  });

  // Forget per-address limits that have refilled, and report refusals at most once a minute
  // (a flood of refused connections must not become a flood of log lines).
  const sweep = setInterval(() => {
    connects.sweep(now());
    creates.sweep(now());
    const refused = Object.entries(refusedSince).filter(([, n]) => n > 0);
    if (refused.length > 0) {
      log.warn('socket', 'connections refused in the last minute', Object.fromEntries(refused));
      for (const key of Object.keys(refusedSince)) refusedSince[key as RefusalReason] = 0;
    }
  }, 60_000);
  sweep.unref();
  io.engine.on('close', () => clearInterval(sweep));
  return io;
}
