import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Db, Queryable, QueryResult } from './db';

/**
 * PostgreSQL compiled to WebAssembly, in this process: the tests and the harness run the
 * ranking store's real SQL on it without a database server. Never used in production (the
 * production server only imports db.ts). It runs one query at a time, so concurrent
 * transactions queue here; the tests that need real concurrency also run against PostgreSQL
 * (TEST_DATABASE_URL).
 */
export async function createPgliteDb(): Promise<Db> {
  const db = await PGlite.create();
  const wrap = (runner: PGlite | Transaction): Queryable => ({
    async query<R>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
      const result = await runner.query<R>(text, params);
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length,
      };
    },
    async exec(script: string) {
      await runner.exec(script);
    },
  });
  return {
    ...wrap(db),
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx))),
    close: () => db.close(),
  };
}
