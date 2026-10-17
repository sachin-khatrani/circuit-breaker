import { config } from './config';
import { createPgDb } from './db/db';
import { migrate, migrationStatus, rollbackLatest } from './db/migrations';

/**
 * Database chores, separate from the game server: `status`, `migrate`, and `rollback
 * --confirm` (undoes the newest migration, which drops its tables: back up first). Uses the
 * same DATABASE_URL and DATABASE_SSL as the server.
 *   development: npm run db:migrate -w @circuit-breaker/server
 *   production:  node apps/server/dist/dbcli.js migrate
 */
const [command, flag] = process.argv.slice(2);

if (!config.databaseUrl) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}
const db = createPgDb({ connectionString: config.databaseUrl, ssl: config.databaseSsl, max: 1 });

try {
  if (command === 'migrate') {
    const applied = await migrate(db);
    console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Up to date.');
  } else if (command === 'rollback') {
    if (flag !== '--confirm') {
      console.error('This drops the newest migration and its data. Run with --confirm.');
      process.exitCode = 2;
    } else {
      const version = await rollbackLatest(db);
      console.log(version === null ? 'Nothing to roll back.' : `Rolled back ${version}.`);
    }
  } else if (command === 'status') {
    const { applied, pending } = await migrationStatus(db);
    console.log(
      `Applied: ${applied.join(', ') || 'none'}. Pending: ${pending.join(', ') || 'none'}.`,
    );
  } else {
    console.error('Usage: dbcli migrate | status | rollback --confirm');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`Failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
