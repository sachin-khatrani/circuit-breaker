import { PROTOCOL_VERSION } from '@circuit-breaker/shared';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Metrics } from './metrics';
import type { RankingService } from './ranking/service';
import type { RoomManager } from './rooms/RoomManager';
import type { SmokeReport } from './smoke';

export interface OpsOptions {
  manager: RoomManager;
  ranking: RankingService;
  metrics: Metrics;
  /** Open Socket.IO connections. */
  connections: () => number;
  maxRooms: number;
  maxConnections: number;
  /** False while shutting down. */
  accepting: () => boolean;
  smoke: SmokeReport;
  /** Bearer token for `/metrics`; unset, only requests from this machine get them. */
  metricsToken?: string;
}

const MB = 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const digest = (text: string) => createHash('sha256').update(text).digest();

/**
 * Operational endpoints. None of them returns a player's data, a token, an environment value
 * or a stack trace.
 *
 * * `/health` (and `/healthz`): liveness. 200 while the process runs, with a summary.
 * * `/ready`: readiness. 503 while shutting down or if the simulation failed its boot check;
 *   otherwise 200 with each dependency's state. The database is optional (races run unrated
 *   without it), so a database outage is reported as `degraded`, not as unready.
 * * `/metrics`: counters and timings of the last 10 seconds, for the load harness and
 *   operators: with `METRICS_TOKEN` as a bearer token, or from this machine when unset.
 */
export function createOpsHandler(options: OpsOptions) {
  const { manager, ranking, metrics } = options;
  const token = options.metricsToken ? digest(`Bearer ${options.metricsToken}`) : null;

  function metricsAllowed(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (token) return typeof header === 'string' && timingSafeEqual(digest(header), token);
    // No token configured: only a caller on this machine, not one relayed by a proxy.
    const remote = req.socket.remoteAddress ?? '';
    const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    return local && req.headers['x-forwarded-for'] === undefined;
  }

  function readiness() {
    const database = ranking.health();
    const stats = manager.stats();
    const accepting = options.accepting();
    const simulation = options.smoke.finished ? 'ok' : 'failed';
    const degraded: string[] = [];
    if (database.enabled && database.database !== 'ok') degraded.push('database');
    if (stats.rooms >= options.maxRooms) degraded.push('rooms full');
    if (options.connections() >= options.maxConnections) degraded.push('connections full');
    return {
      ready: accepting && simulation === 'ok',
      status: !accepting
        ? 'draining'
        : simulation !== 'ok'
          ? 'failed'
          : degraded.length > 0
            ? 'degraded'
            : 'ok',
      degraded,
      checks: {
        simulation,
        accepting,
        database: database.database,
        pendingRatings: database.pending,
        rooms: { open: stats.rooms, max: options.maxRooms },
        connections: { open: options.connections(), max: options.maxConnections },
        eventLoopDelayMs: metrics.loopDelay.read().p99,
      },
    };
  }

  function report() {
    const memory = process.memoryUsage();
    return {
      uptimeSeconds: Math.round(process.uptime()),
      accepting: options.accepting(),
      process: {
        ...metrics.process(),
        rssMB: Math.round(memory.rss / MB),
        heapUsedMB: Math.round(memory.heapUsed / MB),
        loopDelayMs: metrics.loopDelay.read(),
      },
      rooms: { ...manager.stats(), max: options.maxRooms, profilesSeated: manager.profileCount },
      connections: {
        open: options.connections(),
        max: options.maxConnections,
        accepted: metrics.connectionsAccepted,
        refused: metrics.connectionsRefused,
        disconnects: metrics.disconnects,
      },
      messages: {
        inPerSecond: metrics.messagesIn.rate(),
        inTotal: metrics.messagesIn.total,
        refused: metrics.messagesRefused,
        abuseDisconnects: metrics.abuseDisconnects,
        handlerErrors: metrics.handlerErrors,
      },
      simulation: {
        ticksPerSecond: metrics.ticks.rate(),
        tickLateMs: metrics.tickLateness.read(),
        roomErrors: metrics.roomErrors,
      },
      snapshots: {
        perSecond: metrics.snapshots.rate(),
        discardedPerSecond: metrics.snapshotsDiscarded.rate(),
        bytes: metrics.snapshotBytes.read(),
      },
      network: { bytesOutPerSecond: metrics.bytesOut.rate() },
      database: {
        ...ranking.health(),
        queries: metrics.dbQueries,
        errors: metrics.dbErrors,
        latencyMs: metrics.dbLatency.read(),
        seatTickets: ranking.ticketCount,
      },
      api: {
        requests: metrics.apiRequests,
        status4xx: metrics.api4xx,
        status5xx: metrics.api5xx,
        latencyMs: metrics.apiLatency.read(),
      },
    };
  }

  return function handleOps(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/health' || path === '/healthz') {
      const stats = manager.stats();
      json(res, 200, {
        status: options.accepting() ? 'ok' : 'draining',
        protocol: PROTOCOL_VERSION,
        uptimeSeconds: Math.round(process.uptime()),
        rooms: stats.rooms,
        players: manager.sessionCount,
        ranking: ranking.health(),
        sim: options.smoke,
      });
      return true;
    }
    if (path === '/ready') {
      const body = readiness();
      json(res, body.ready ? 200 : 503, body);
      return true;
    }
    if (path === '/metrics') {
      if (!metricsAllowed(req)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return true;
      }
      json(res, 200, report());
      return true;
    }
    return false;
  };
}
