import { randomBytes } from 'node:crypto';
import { createPgDb, type Db, type Queryable } from '../src/db/db';
import { migrate } from '../src/db/migrations';
import { createPgliteDb } from '../src/db/pglite';

export interface TestDb {
  db: Db;
  /** Closes the database and throws its data away. */
  drop(): Promise<void>;
}

export interface TestDatabase {
  name: 'pglite' | 'postgres';
  /** A fresh, migrated, empty database (no migrations when `bare`). */
  open(options?: { bare?: boolean }): Promise<TestDb>;
}

/** One PGlite per test file (it takes a second or two to start); each test gets a schema. */
let sharedPglite: Promise<Db> | null = null;

const pglite: TestDatabase = {
  name: 'pglite',
  async open(options = {}) {
    const base = await (sharedPglite ??= createPgliteDb());
    // Tests in a file run one at a time, so the single session's search_path is theirs.
    const schema = `cb_test_${randomBytes(6).toString('hex')}`;
    await base.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    // Code under test may close its database: here that must not end the shared instance.
    const db: Db = { ...base, close: async () => {} };
    if (!options.bare) await migrate(db);
    return {
      db,
      drop: () => base.exec(`DROP SCHEMA ${schema} CASCADE; SET search_path TO public`),
    };
  },
};

/**
 * A real PostgreSQL server, when TEST_DATABASE_URL names one. Each database the tests open is
 * a new schema with a random name, dropped afterwards, so the tests never see (or touch) any
 * other data in that database. It must not be the server's own DATABASE_URL.
 */
function postgres(url: string): TestDatabase {
  if (url === process.env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must not be the DATABASE_URL the server uses.');
  }
  return {
    name: 'postgres',
    async open(options = {}) {
      const schema = `cb_test_${randomBytes(6).toString('hex')}`;
      const admin = createPgDb({ connectionString: url, max: 1 });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const scoped = new URL(url);
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      const db = createPgDb({ connectionString: scoped.toString(), max: 10 });
      if (!options.bare) await migrate(db);
      return {
        db,
        async drop() {
          // The schema goes even if closing the pool fails.
          try {
            await db.close();
          } finally {
            await admin.query(`DROP SCHEMA ${schema} CASCADE`);
            await admin.close();
          }
        },
      };
    },
  };
}

/** PGlite always (real SQL, in process); PostgreSQL too when TEST_DATABASE_URL is set. */
export const TEST_DATABASES: TestDatabase[] = [
  pglite,
  ...(process.env.TEST_DATABASE_URL ? [postgres(process.env.TEST_DATABASE_URL)] : []),
];

/**
 * A database that fails like an unreachable server until `heal()` (and again after `break()`):
 * every query and transaction throws a connection error, as pg does when the database is
 * down. Used to test that games go on and nothing half-applies.
 */
export class FlakyDb implements Db {
  down = false;
  constructor(private readonly inner: Db) {}
  break(): void {
    this.down = true;
  }
  heal(): void {
    this.down = false;
  }
  private check(): void {
    if (this.down) {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
        code: 'ECONNREFUSED',
      });
    }
  }
  async query<R = Record<string, unknown>>(text: string, params?: unknown[]) {
    this.check();
    return this.inner.query<R>(text, params);
  }
  async exec(script: string) {
    this.check();
    return this.inner.exec(script);
  }
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    this.check();
    return this.inner.transaction(fn);
  }
  close() {
    return this.inner.close();
  }
}
