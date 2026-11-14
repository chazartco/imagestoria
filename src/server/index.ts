import fsp from 'node:fs/promises';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb, prepareDb } from './db/index.js';
import { createStorage } from './storage/index.js';

const cfg = loadConfig();
const { db, pool } = openDb(cfg.DATABASE_URL);
await prepareDb(db, pool, (m) => console.log(m));
await fsp.mkdir(cfg.tmpDir, { recursive: true });
const storage = createStorage(cfg);
await storage.check();

const { app, worker } = await buildApp(cfg, db, storage);
await worker.ready;
await app.listen({ port: cfg.PORT, host: cfg.HOST });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    worker.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
