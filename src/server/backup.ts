import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { schema } from './db/index.js';

const { settings, activity } = schema;

/**
 * Backups of the database.
 *
 * Everything that is not a file lives in Postgres: titles, tags, comments, stories, people, edits. A backup is one
 * pg_dump in the custom format (compressed, restored with pg_restore), written to the same storage the app uses,
 * under backups/. It covers the database only. The pictures and videos need a second copy of their own.
 *
 * With BACKUP_PASSPHRASE set the dump is encrypted before it is stored, because it holds password hashes and
 * token hashes. The form is the one `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256` writes, so a backup
 * can be opened with openssl alone, without this app:
 *   "Salted__", eight bytes of salt, then AES-256-CBC with the key and IV taken from PBKDF2-HMAC-SHA256.
 *
 * What has been made is remembered in the settings table (there is no listing of storage to ask):
 *   backup:list     [{ key, at, bytes, encrypted }], newest first
 *   backup:failure  { at, reason } for the last run that failed, cleared by the next one that works
 */
export const BACKUP_ITER = 600_000;
const LOCK = 7_241_953; // any fixed number: the name of the Postgres advisory lock that makes backups take turns
export interface BackupEntry { key: string; at: number; bytes: number; encrypted: boolean }

const getSetting = async <T>(ctx: Ctx, key: string): Promise<T | null> => ((await ctx.db.select().from(settings).where(eq(settings.key, key)))[0]?.value as T) ?? null;
const putSetting = (ctx: Ctx, key: string, value: unknown) => ctx.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });

function keyAndIv(passphrase: string, salt: Buffer) { const k = crypto.pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, BACKUP_ITER, 48, 'sha256'); return { key: k.subarray(0, 32), iv: k.subarray(32, 48) }; }
/** A stream that encrypts what passes through it, in the form openssl reads. */
function encryptor(passphrase: string): Transform {
  const salt = crypto.randomBytes(8), { key, iv } = keyAndIv(passphrase, salt), c = crypto.createCipheriv('aes-256-cbc', key, iv);
  let first = true;
  return new Transform({
    transform(chunk, _e, cb) { const out = c.update(chunk); cb(null, first ? ((first = false), Buffer.concat([Buffer.from('Salted__'), salt, out])) : out); },
    flush(cb) { const end = c.final(); cb(null, first ? Buffer.concat([Buffer.from('Salted__'), salt, end]) : end); },
  });
}
/** Open an encrypted backup. For the command line and for tests; the same as openssl enc -d. */
export async function decryptBackup(src: string, dest: string, passphrase: string) {
  const fd = await fsp.open(src, 'r'), head = Buffer.alloc(16); await fd.read(head, 0, 16, 0); await fd.close();
  if (head.subarray(0, 8).toString('latin1') !== 'Salted__') throw new Error('That file is not an encrypted backup from this app.');
  const { key, iv } = keyAndIv(passphrase, head.subarray(8, 16));
  try { await pipeline(fs.createReadStream(src, { start: 16 }), crypto.createDecipheriv('aes-256-cbc', key, iv), fs.createWriteStream(dest)); }
  catch (e: any) { await fsp.rm(dest, { force: true }); throw new Error(/bad decrypt|wrong final block/i.test(String(e?.message)) ? 'The passphrase is wrong, or the file is damaged.' : String(e?.message ?? e)); }
}

/** The database address as the settings libpq programs read from the environment. */
export function pgEnv(url: string): Record<string, string> {
  const u = new URL(url), env: Record<string, string> = { PGHOST: decodeURIComponent(u.hostname), PGPORT: u.port || '5432', PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')) };
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const ssl = u.searchParams.get('sslmode'); if (ssl) env.PGSSLMODE = ssl;
  return env;
}

const stamp = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}`;

/**
 * Make one backup now. Only one runs at a time, across every app container that shares the database:
 * a second call while one is running returns { busy: true } and does nothing.
 */
export async function runBackup(ctx: Ctx, by: string): Promise<{ busy: true } | { ok: true; entry: BackupEntry } | { ok: false; reason: string }> {
  const { cfg, storage } = ctx;
  const client = await (ctx.db as any).$client.connect();
  let locked = false;
  const tmp = path.join(cfg.tmpDir, `backup-${crypto.randomBytes(6).toString('hex')}.part`);
  try {
    locked = (await client.query('select pg_try_advisory_lock($1) as ok', [LOCK])).rows[0].ok === true;
    if (!locked) return { busy: true };
    await fsp.mkdir(cfg.tmpDir, { recursive: true });
    const before = (await getSetting<BackupEntry[]>(ctx, 'backup:list')) ?? [];
    // Names are to the second. Two backups asked for within one second would share a name, so the second one waits.
    if (before[0] && Date.now() - before[0].at < 1100) await new Promise((r) => setTimeout(r, 1100));
    const at = new Date(), encrypted = Boolean(cfg.BACKUP_PASSPHRASE), key = `backups/afterimage-${stamp(at)}.dump${encrypted ? '.enc' : ''}`;
    // The dump comes out of pg_dump as a stream and goes, encrypted or not, straight to a working file.
    // The connection string is passed in the environment, not on the command line, where other processes could read it.
    const child = spawn(cfg.PG_DUMP, ['--format=custom', '--no-owner', '--no-privileges'], { env: { ...process.env, ...pgEnv(cfg.DATABASE_URL) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let said = ''; child.stderr.on('data', (d) => { said = (said + d).slice(-2000); });
    const ended = new Promise<number>((res, rej) => { child.on('error', rej); child.on('close', (code) => res(code ?? 1)); });
    const killer = setTimeout(() => child.kill('SIGKILL'), 6 * 3600_000);
    try {
      const file = fs.createWriteStream(tmp);
      await Promise.all([encrypted ? pipeline(child.stdout, encryptor(cfg.BACKUP_PASSPHRASE), file) : pipeline(child.stdout, file), ended.then((code) => { if (code !== 0) throw new Error(said.trim().split('\n').pop() || `pg_dump stopped with code ${code}.`); })]);
    } catch (e: any) {
      if (e?.code === 'ENOENT') throw new Error(`The pg_dump program was not found (${cfg.PG_DUMP}). It comes with the PostgreSQL client and must be the same version as the database or newer.`);
      throw e;
    } finally { clearTimeout(killer); }
    const bytes = (await fsp.stat(tmp)).size;
    if (bytes < 200) throw new Error('pg_dump wrote nothing.');
    await storage.putFile(key, tmp, 'application/octet-stream');
    // Keep the newest BACKUP_KEEP and remove the rest, from the list and from storage.
    const list = [{ key, at: at.getTime(), bytes, encrypted }, ...before];
    const keep = list.slice(0, Math.max(1, cfg.BACKUP_KEEP)), drop = list.slice(keep.length);
    if (drop.length) await storage.remove(drop.map((d) => d.key)).catch((e) => ctx.log.warn({ err: e }, 'an old backup could not be removed'));
    await putSetting(ctx, 'backup:list', keep);
    await ctx.db.delete(settings).where(eq(settings.key, 'backup:failure'));
    await ctx.db.insert(activity).values({ userId: null, who: by, text: `backed up the database (${(bytes / 1048576).toFixed(1)} MB${encrypted ? ', encrypted' : ''})` });
    return { ok: true, entry: keep[0]! };
  } catch (e: any) {
    const reason = String(e?.message ?? e).slice(0, 400);
    ctx.log.error({ err: e }, 'the backup failed');
    if (locked) await putSetting(ctx, 'backup:failure', { at: Date.now(), reason }).catch(() => {});
    return { ok: false, reason };
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (locked) await client.query('select pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    client.release();
  }
}

/** For the settings page. */
export async function backupState(ctx: Ctx) {
  const { cfg } = ctx, list = (await getSetting<BackupEntry[]>(ctx, 'backup:list')) ?? [];
  return {
    schedule: cfg.BACKUP_SCHEDULE || null, keep: cfg.BACKUP_KEEP, encrypted: Boolean(cfg.BACKUP_PASSPHRASE),
    where: cfg.STORAGE_DRIVER === 's3' ? 'bucket' : 'disk', bucket: cfg.STORAGE_DRIVER === 's3' ? cfg.S3_BUCKET : null,
    last: list[0] ?? null, count: list.length, bytes: list.reduce((a, b) => a + b.bytes, 0),
    failure: await getSetting<{ at: number; reason: string }>(ctx, 'backup:failure'),
  };
}

/** Is it the minute the schedule names? "03:30" is due from 03:30:00 to 03:30:59 on the server's clock. */
export function scheduleDue(schedule: string, now: Date): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(schedule);
  return !!m && now.getHours() === Number(m[1]) && now.getMinutes() === Number(m[2]);
}

/**
 * With BACKUP_SCHEDULE set to a time of day ("03:30", on the server's clock), make a backup once a day at that time.
 * Every app container runs this. The lock in runBackup lets one through, and the others see that a backup was
 * just made and leave it.
 */
export function startBackupSchedule(ctx: Ctx): () => void {
  if (!ctx.cfg.BACKUP_SCHEDULE) return () => {};
  let doneFor = '';
  const tick = async () => {
    const now = new Date(), day = now.toDateString();
    if (!scheduleDue(ctx.cfg.BACKUP_SCHEDULE, now) || doneFor === day) return;
    doneFor = day;
    try {
      const last = ((await getSetting<BackupEntry[]>(ctx, 'backup:list')) ?? [])[0];
      if (last && Date.now() - last.at < 30 * 60_000) return; // another container got there first
      await runBackup(ctx, 'ImageStoria');
    } catch (e) { ctx.log.error({ err: e }, 'the scheduled backup could not start'); }
  };
  const t = setInterval(tick, 20_000); t.unref();
  return () => clearInterval(t);
}
