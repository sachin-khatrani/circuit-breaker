import { GRID_ZERO, Track } from '@circuit-breaker/shared';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { createApi } from './api/http';
import { config } from './config';
import { createPgDb } from './db/db';
import { logger, newErrorId, setLogFormat } from './log';
import { Metrics, timedDb } from './metrics';
import { attachSocketServer } from './net/socketServer';
import { createOpsHandler } from './ops';
import { RankingService } from './ranking/service';
import { RankingStore } from './ranking/store';
import { RoomManager } from './rooms/RoomManager';
import { runSmokeRace } from './smoke';
import { createStaticHandler } from './static';

setLogFormat(config.logFormat);
const metrics = new Metrics();
metrics.start();

// The shared race simulation must run here before anything else: it is what makes the server
// authoritative. The smoke lap proves it on every boot and measures its cost per tick.
const smoke = runSmokeRace();
logger.info('sim', 'smoke race', { ...smoke });
if (!smoke.finished) logger.error('sim', 'smoke race did not finish; check the track definition');

// Profiles, ratings and the leaderboard live in PostgreSQL. Without DATABASE_URL the game runs
// exactly as before with ranking off; while the database is unreachable it runs unrated.
const ranking = new RankingService(
  config.databaseUrl
    ? new RankingStore(
        timedDb(
          createPgDb({
            connectionString: config.databaseUrl,
            ssl: config.databaseSsl,
            max: config.dbPoolMax,
          }),
          metrics,
        ),
      )
    : null,
  {
    migrateOnStart: config.dbMigrate === 'auto',
    log: (line, level) => logger.line(line, level),
  },
);
if (ranking.enabled) void ranking.start();
else logger.info('db', 'DATABASE_URL is not set: profiles, ratings and the leaderboard are off');

let stopping = false;
const accepting = () => !stopping;
const now = () => performance.now();
const manager = new RoomManager(new Track(GRID_ZERO), now, {
  snapshotRate: config.snapshotRate,
  graceMs: config.reconnectGraceSeconds * 1000,
  maxRooms: config.maxRooms,
  ranking,
  metrics,
});
const api = createApi(ranking, {
  corsOrigin: config.corsOrigin,
  trustProxyHops: config.trustProxyHops,
  cookieSecure: config.cookieSecure,
  metrics,
});
const serveStatic = config.production ? createStaticHandler(config.clientDist) : () => false;

let proxyWarned = false;
const server = createServer((req, res) => {
  // Behind a proxy without TRUST_PROXY every player looks like the proxy to the rate limits.
  if (!proxyWarned && config.trustProxyHops === 0 && req.headers['x-forwarded-for']) {
    proxyWarned = true;
    logger.warn(
      'net',
      'requests carry X-Forwarded-For but TRUST_PROXY is 0: per-address limits see the proxy, ' +
        'not the players. Set TRUST_PROXY to the number of proxies (Render, Railway: 1).',
    );
  }
  if (ops(req, res)) return;
  // Before the static files: their page fallback would answer any path.
  if (api(req, res)) return;
  if (serveStatic(req, res)) return;
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const io = attachSocketServer(server, manager, now, {
  corsOrigin: config.corsOrigin,
  trustProxyHops: config.trustProxyHops,
  redeemTicket: (ticket) => ranking.redeemTicket(ticket),
  limits: {
    maxConnections: config.maxConnections,
    maxConnectionsPerAddress: config.maxConnectionsPerAddress,
    connectBurst: config.maxConnectionsPerAddress,
    connectsPerMinute: config.maxConnectionsPerAddress * 2,
  },
  metrics,
  accepting,
});
const ops = createOpsHandler({
  manager,
  ranking,
  metrics,
  connections: () => io.engine.clientsCount,
  maxRooms: config.maxRooms,
  maxConnections: config.maxConnections,
  accepting,
  smoke,
  metricsToken: config.metricsToken,
});
manager.start();

server.listen(config.port, config.host, () => {
  logger.info('http', `listening on http://${config.host}:${config.port}`);
  logger.info('net', 'Socket.IO ready', {
    simulationHz: 60,
    snapshotHz: config.snapshotRate,
    reconnectGraceSeconds: config.reconnectGraceSeconds,
    maxConnections: config.maxConnections,
    maxConnectionsPerAddress: config.maxConnectionsPerAddress,
    maxRooms: config.maxRooms,
  });
  if (config.production) logger.info('http', `serving the client from ${config.clientDist}`);
});

/**
 * Stops once: new connections and seats are refused (and `/ready` says so), every player is
 * told the server is restarting, rating writes in flight get a few seconds to commit, then
 * the pool closes and the process exits.
 */
function shutdown(why: string, code = 0): void {
  if (stopping) return;
  stopping = true;
  logger.info('server', 'shutting down', { why });
  manager.stop();
  manager.closeAll('The server is restarting. Reload the page in a minute to play again.');
  void io.close();
  server.close();
  server.closeIdleConnections();
  metrics.stop();
  void ranking.close(5000).finally(() => process.exit(code));
  setTimeout(() => process.exit(code), 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// A parent process (the shutdown test) can ask too: Windows cannot send a child SIGTERM.
// Only a process started with an IPC channel has one; a deployed server never does.
if (process.send) {
  process.on('message', (message) => {
    if (message === 'shutdown') shutdown('IPC request');
  });
}
// Rooms and socket handlers catch their own failures; anything that still escapes leaves the
// process in an unknown state, so it is logged and the server restarts cleanly.
process.on('uncaughtException', (error) => {
  logger.error('process', 'uncaught exception', { errorId: newErrorId(), error });
  shutdown('uncaught exception', 1);
});
// A promise nobody handled is logged; it does not stop the races in other rooms.
process.on('unhandledRejection', (reason) => {
  metrics.handlerErrors++;
  logger.error('process', 'unhandled promise rejection', { errorId: newErrorId(), error: reason });
});
