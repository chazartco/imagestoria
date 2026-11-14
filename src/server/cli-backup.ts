/**
 * Backups from the command line.
 *
 *   npm run backup                              make one now
 *   npm run backup -- open <file.enc> <out>     decrypt a backup with BACKUP_PASSPHRASE, ready for pg_restore
 *
 * In Docker: docker compose exec app npm run backup
 */
import { decryptBackup, runBackup } from './backup.js';
import { loadConfig } from './config.js';
import type { Ctx } from './context.js';
import { openDb } from './db/index.js';
import { createStorage } from './storage/index.js';

const cfg = loadConfig(), [cmd, src, dest] = process.argv.slice(2);
if (cmd === 'open') {
  if (!src || !dest) { console.error('Give the encrypted file and where to write the opened one. For example: npm run backup -- open afterimage-20260101-033000.dump.enc afterimage.dump'); process.exit(2); }
  if (!cfg.BACKUP_PASSPHRASE) { console.error('BACKUP_PASSPHRASE is not set, so there is nothing to open the file with.'); process.exit(2); }
  try { await decryptBackup(src, dest, cfg.BACKUP_PASSPHRASE); console.log(`Opened. Restore it with: pg_restore --clean --if-exists --no-owner -d <database> ${dest}`); }
  catch (e: any) { console.error(e.message); process.exit(1); }
} else if (cmd) { console.error(`"${cmd}" is not something this command does. Run it with nothing to back up now, or with "open".`); process.exit(2); }
else {
  const { db, pool } = openDb(cfg.DATABASE_URL), storage = createStorage(cfg);
  const log = { info() {}, warn: console.warn, error: console.error };
  try {
    const r = await runBackup({ cfg, db, storage, log, kick() {} } as unknown as Ctx, 'the command line');
    if ('busy' in r) { console.error('A backup is already running.'); process.exitCode = 1; }
    else if (!r.ok) { console.error(`The backup failed. ${r.reason}`); process.exitCode = 1; }
    else console.log(`Backed up: ${r.entry.key}, ${(r.entry.bytes / 1048576).toFixed(1)} MB${r.entry.encrypted ? ', encrypted' : ''}.`);
  } finally { await pool.end(); }
}
