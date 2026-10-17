import { fileURLToPath } from 'node:url';
import type { SslMode } from './db/db';

const production = process.env.NODE_ENV === 'production';

// Development reads the repository's .env (git-ignored) if there is one; production gets its
// settings from the platform's environment.
if (!production) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  } catch {
    // no .env: defaults
  }
}

function numberFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function logFormat(raw: string | undefined): 'json' | 'text' {
  if (raw === 'json' || raw === 'text') return raw;
  return production ? 'json' : 'text';
}

function sslMode(raw: string | undefined): SslMode {
  return raw === 'require' || raw === 'no-verify' || raw === 'off' ? raw : 'auto';
}

export const config = {
  port: numberFromEnv('PORT', 3001, 1, 65535),
  // Local development stays on loopback; containers and LAN play need every interface.
  host: process.env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
  production,
  /** Snapshots per second sent to each player (the simulation always runs at 60 Hz). */
  snapshotRate: numberFromEnv('SNAPSHOT_RATE', 20, 5, 60),
  /** Seconds a dropped player keeps their seat. */
  reconnectGraceSeconds: numberFromEnv('RECONNECT_GRACE', 30, 5, 300),
  maxRooms: numberFromEnv('MAX_ROOMS', 500, 1, 10_000),
  /** Open Socket.IO connections the process accepts, in total and from one address. */
  maxConnections: numberFromEnv('MAX_CONNECTIONS', 1000, 1, 100_000),
  maxConnectionsPerAddress: numberFromEnv('MAX_CONNECTIONS_PER_IP', 32, 1, 10_000),
  /** `json` (one object per line) or `text`; JSON by default in production. */
  logFormat: logFormat(process.env.LOG_FORMAT),
  /** Bearer token for `/metrics` from outside this machine (unset: loopback only). */
  metricsToken: process.env.METRICS_TOKEN || undefined,
  /** Allowed browser origin for a client served elsewhere (same-origin needs nothing). */
  corsOrigin: process.env.CORS_ORIGIN || undefined,
  /** PostgreSQL for profiles and the leaderboard; unset means ranking is off. Server only. */
  databaseUrl: process.env.DATABASE_URL || undefined,
  databaseSsl: sslMode(process.env.DATABASE_SSL),
  dbPoolMax: numberFromEnv('DB_POOL_MAX', 5, 1, 50),
  /** `auto` applies pending migrations at boot; `off` leaves them to `db:migrate`. */
  dbMigrate: process.env.DB_MIGRATE === 'off' ? ('off' as const) : ('auto' as const),
  /** Proxies in front of the server that set X-Forwarded-For/-Proto (Render, Railway: 1). */
  trustProxyHops: numberFromEnv('TRUST_PROXY', 0, 0, 5),
  /** Secure cookies: `auto` when the browser came over HTTPS. */
  cookieSecure:
    process.env.COOKIE_SECURE === '1'
      ? true
      : process.env.COOKIE_SECURE === '0'
        ? false
        : ('auto' as const),
  /** The built client, served in production (from the bundle at apps/server/dist). */
  clientDist:
    process.env.CLIENT_DIST ?? fileURLToPath(new URL('../../client/dist/', import.meta.url)),
};
