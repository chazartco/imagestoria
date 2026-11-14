import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export { schema };

export function openDb(url: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}

/** Wait for Postgres (it may still be starting next to us in docker compose), then apply migrations. */
export async function prepareDb(db: Db, pool: pg.Pool, log: (m: string) => void) {
  let lastErr: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      await pool.query('select 1');
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      log(`Waiting for the database (${i + 1}/30)`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (lastErr) throw lastErr;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/server/db in development, dist/server/db when built: the drizzle folder is three levels up either way.
  await migrate(db, { migrationsFolder: path.resolve(here, '../../../drizzle') });
}
