import pg from 'pg';
import { logger } from '../log';

/** One query's answer: the rows, and how many rows it touched. */
export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

/** Anything that runs a query: the database itself, or one transaction on it. */
export interface Queryable {
  /** One statement, with `$1`-style parameters. */
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
  /** A script of several statements, without parameters (migrations). */
  exec(script: string): Promise<void>;
}

/**
 * What the ranking store needs from PostgreSQL: queries, transactions that commit whole or
 * roll back whole, and a way to close. `pg` implements it in production; tests run the same
 * SQL on PGlite (see pglite.ts).
 */
export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type SslMode = 'auto' | 'require' | 'no-verify' | 'off';

export interface PgOptions {
  connectionString: string;
  /** `auto` leaves TLS to the URL's `sslmode`; the others decide it whatever the URL says. */
  ssl?: SslMode;
  /** Connections the pool may hold. */
  max?: number;
  /** Per statement, enforced by PostgreSQL (ms). */
  statementTimeoutMs?: number;
  /** To open a connection (ms). */
  connectTimeoutMs?: number;
}

/** The URL and TLS settings `pg` should use for an SSL mode. */
function sslSettings(url: string, mode: SslMode): { url: string; ssl?: pg.PoolConfig['ssl'] } {
  if (mode === 'auto') return { url };
  // An explicit mode wins, so the URL's own sslmode must not override it.
  const parsed = new URL(url);
  parsed.searchParams.delete('sslmode');
  const ssl = mode === 'off' ? false : { rejectUnauthorized: mode === 'require' };
  return { url: parsed.toString(), ssl };
}

/** The production database: a `pg` pool with timeouts, so a slow database cannot hang a request. */
export function createPgDb(options: PgOptions): Db {
  const { url, ssl } = sslSettings(options.connectionString, options.ssl ?? 'auto');
  const statementTimeout = options.statementTimeoutMs ?? 5000;
  const pool = new pg.Pool({
    connectionString: url,
    ...(ssl === undefined ? {} : { ssl }),
    max: options.max ?? 5,
    connectionTimeoutMillis: options.connectTimeoutMs ?? 5000,
    idleTimeoutMillis: 30_000,
    statement_timeout: statementTimeout,
    // The client gives up a little after the server would have.
    query_timeout: statementTimeout + 1000,
    application_name: 'circuit-breaker',
    keepAlive: true,
  });
  // An idle connection that breaks (the database restarted) must not crash the game server.
  pool.on('error', (error) => logger.warn('db', 'idle connection lost', { reason: error.message }));

  const wrap = (runner: pg.Pool | pg.PoolClient): Queryable => ({
    async query<R>(text: string, params?: unknown[]) {
      const result = await runner.query(text, params);
      return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
    },
    async exec(script: string) {
      // Without parameters, pg uses the simple protocol, which runs several statements.
      await runner.query(script);
    },
  });

  let closed: Promise<void> | null = null;
  return {
    ...wrap(pool),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // The connection itself failed: throw it away rather than reuse it.
          broken = rollbackError as Error;
        }
        throw error;
      } finally {
        client.release(broken);
      }
    },
    // Closing twice (shutdown racing a test's clean-up) is harmless.
    close: () => (closed ??= pool.end()),
  };
}
