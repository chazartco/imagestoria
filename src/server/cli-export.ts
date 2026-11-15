/**
 * A whole library as one file, from the command line (see portable.ts and "Moving a library" in the README).
 *
 *   npm run library:export -- <file>               write this library to a file
 *   npm run library:import -- <file> [--replace]   load a file into this library. --replace is needed when it already has pictures
 *
 * In Docker: docker compose exec app npm run library:export -- /data/library.jsonl.gz
 * The file holds the database, not the pictures. Stop the app before an import, or sign in again after it.
 */
import { issueToken } from './auth/core.js';
import { loadConfig } from './config.js';
import type { Ctx } from './context.js';
import { openDb, prepareDb } from './db/index.js';
import { importLibrary, writeExport } from './portable.js';
import { createStorage } from './storage/index.js';

const [cmd, file, ...rest] = process.argv.slice(2);
if ((cmd !== 'export' && cmd !== 'import') || !file) {
  console.error('Say what to do and with which file. For example: npm run library:export -- library.jsonl.gz, or npm run library:import -- library.jsonl.gz --replace');
  process.exit(2);
}
const cfg = loadConfig(), { db, pool } = openDb(cfg.DATABASE_URL), storage = createStorage(cfg);
const ctx = { cfg, db, storage, log: { info() {}, warn: console.warn, error() {} }, kick() {} } as unknown as Ctx;
try {
  await prepareDb(db, pool, (m) => console.log(m));
  if (cmd === 'export') {
    const man = await writeExport(ctx, file);
    const n = man.counts.items ?? 0;
    console.log(`Exported ${n} ${n === 1 ? 'item' : 'items'} to ${file}. The pictures themselves are not in it: they stay in ${cfg.STORAGE_DRIVER === 's3' ? `the bucket ${cfg.S3_BUCKET}` : cfg.mediaDir}.`);
  } else {
    const r = await importLibrary(ctx, file, { replace: rest.includes('--replace'), by: null });
    console.log(`Imported ${r.items} ${r.items === 1 ? 'item' : 'items'}. ${r.sentence}${r.backup ? ` The library that was here before is backed up in ${r.backup}.` : ''}`);
    // An owner who came from the hosted service has no password here. Give them a way in.
    const owners = (await pool.query(`select id, name, password_hash, oidc_subject from users where role = 'owner' and status = 'active' order by created_at`)).rows;
    if (owners.length && !owners.some((o) => o.password_hash || o.oidc_subject)) {
      console.log(`${owners[0].name} is the owner and has no password on this server. This link lets them choose one, once, within 2 days: ${cfg.PUBLIC_URL}/?reset=${await issueToken(ctx, 'reset', owners[0].id, 2)}`);
    }
  }
} catch (e: any) { console.error(e?.message ?? String(e)); process.exitCode = 1; }
finally { await pool.end(); }
