import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { eq, getTableColumns, getTableName } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgTable } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { EmbedIndex } from './ai/embed.js';
import { runBackup } from './backup.js';
import { type Ctx, HttpError } from './context.js';
import { type Db, schema } from './db/index.js';

/**
 * A whole library as one file, so that a person can move between the hosted service and a server of their own.
 *
 * Not a database dump: a dump can carry any SQL, and must never be restored on a server that other libraries share.
 * This file is written and read by the app itself. It is gzip. The first line is a manifest, and every line after it
 * is one row: { "t": "<table>", "r": { "<column>": value } }. Rows come in an order that satisfies foreign keys.
 * Times are ISO strings (taken_at has no zone and is written without one), and bytes are base64.
 *
 * It holds what the database holds, not the pictures: those are files in storage and move by themselves
 * (see "Moving a library" in the README).
 *
 * An export is untrusted when it is read. Tables and columns are matched against the lists below, which come from
 * this server's own schema and never from the file, and every value is sent to the database as a parameter.
 * Loading happens in one transaction: it either all arrives or the library is exactly as it was.
 */
export const FORMAT = 'imagestoria-library', VERSION = 1;
const LOCK = 7_241_954; // the Postgres advisory lock that makes exports and imports take turns
const MAX_LINE = 16 << 20;
const KEEP = 3;

const T = schema;
/** What an export holds, in an order that satisfies foreign keys. Everything else is left out, always. */
const TABLES: PgTable[] = [T.spaces, T.users, T.spaceMembers, T.places, T.tags, T.items, T.itemTags, T.likes, T.comments, T.stories, T.storySections, T.storyItems, T.storyLinks,
  T.luts, T.musicTracks, T.reels, T.itemLabels, T.itemEmbeddings, T.persons, T.faces, T.faceRejections, T.placeSuggestions, T.aiTasks, T.activity, T.settings];
/**
 * The settings that are the library's own. The rest stay behind: backup:list and backup:failure (this server's
 * bookkeeping), cloud:owner and cloudai:usage (the hosted service's own: who the subscriber is, today's count), places:data (the place
 * names are not carried), export:list and export:state.
 */
const SETTINGS = ['faces:auto', 'public:site', 'cloudai'];
/** The same list as SQL. The names are ours, written above, never anything from a file. */
const OWN_SETTINGS = ` where key in (${SETTINGS.map((k) => `'${k}'`).join(', ')})`;

interface Spec { name: string; cols: Map<string, string> }
const SPECS: Spec[] = TABLES.map((t) => ({ name: getTableName(t), cols: new Map(Object.values(getTableColumns(t)).map((c) => [c.name, c.getSQLType()])) }));
const SPEC = new Map(SPECS.map((s) => [s.name, s]));
export const PORTABLE_TABLES = SPECS.map((s) => s.name);

const refuse = (msg: string, status = 400) => new HttpError(status, msg);
const NOT_EXPORT = 'That file is not an ImageStoria library export.';
const BROKEN = 'That export is not complete or is damaged. Make the export again.';

/** The newest migration this server knows: its number and name. An export made by a newer one is refused. */
export function schemaVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const journal = JSON.parse(fs.readFileSync(path.resolve(here, '../../drizzle/meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  return journal.entries[journal.entries.length - 1]!.tag;
}
function appVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try { return String(JSON.parse(fs.readFileSync(path.resolve(here, '../../package.json'), 'utf8')).version); } catch { return ''; }
}
const schemaNumber = (tag: unknown) => (typeof tag === 'string' && /^\d{1,6}(_|$)/.test(tag) ? parseInt(tag, 10) : NaN);

export interface Manifest { format: string; version: number; app: string; schema: string; exportedAt: string; counts: Record<string, number>; storage: { driver: string; bucket?: string; prefix?: string } }
export interface ExportEntry { name: string; key: string; at: number; bytes: number; items: number }
export interface ExportState { running: boolean; at: number; done?: number; total?: number; error?: string }
export interface ImportResult { items: number; rows: number; filesChecked: number; filesFound: number; sentence: string; backup: string | null; userId: string | null }

const getSetting = async <V>(ctx: Ctx, key: string): Promise<V | null> => ((await ctx.db.select().from(T.settings).where(eq(T.settings.key, key)))[0]?.value as V) ?? null;
const putSetting = (ctx: Ctx, key: string, value: unknown) => ctx.db.insert(T.settings).values({ key, value }).onConflictDoUpdate({ target: T.settings.key, set: { value } });
const q = (name: string) => `"${name}"`;

/* ---------- writing ---------- */

const selectExpr = (col: string, type: string) =>
  type === 'timestamp with time zone' ? `to_char(${q(col)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${q(col)}`
    : type === 'timestamp' ? `to_char(${q(col)}, 'YYYY-MM-DD"T"HH24:MI:SS.US') as ${q(col)}`
      : type === 'bytea' ? `translate(encode(${q(col)}, 'base64'), E'\\n', '') as ${q(col)}`
        : type === 'bigint' ? `${q(col)}::text as ${q(col)}` : q(col);

/** What must not travel, taken out of a row before it is written. Returns null for a row that stays behind. */
function forExport(table: string, r: Record<string, unknown>): Record<string, unknown> | null {
  if (table === 'settings') {
    if (!SETTINGS.includes(String(r.key))) return null;
    // The Cloud AI choices of a hosted library. Its key is sealed there and opens nowhere else. The other choices travel, switched off.
    if (r.key === 'cloudai') return { key: r.key, value: { ...(r.value as object), key: null, keyHint: null, on: false, stopped: null } };
  }
  // Workers stay behind: their tokens point at the old address. Work one of them was holding goes back in line.
  if (table === 'ai_tasks') return { ...r, worker_id: null, lease_until: null, status: r.status === 'claimed' ? 'queued' : r.status };
  // The job that was making a reel stays behind too.
  if (table === 'reels' && (r.status === 'queued' || r.status === 'running')) return { ...r, status: 'failed', progress: 0, error: 'This reel was not finished when the library was exported. Make it again.' };
  return r;
}

/**
 * Write the whole library to a gzip file at `dest`. Reads through one connection, inside one snapshot of the
 * database, a few hundred rows at a time, so the size of the library does not matter.
 */
export async function writeExport(ctx: Ctx, dest: string, progress?: (done: number, total: number) => void): Promise<Manifest> {
  const client: pg.PoolClient = await (ctx.db as any).$client.connect();
  const gz = zlib.createGzip({ level: 6 }), out = fs.createWriteStream(dest);
  gz.pipe(out);
  const finished = new Promise<void>((res, rej) => { out.on('finish', () => res()); out.on('error', rej); gz.on('error', rej); });
  const write = async (line: string) => { if (!gz.write(line + '\n')) await once(gz, 'drain'); };
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    const counts: Record<string, number> = {};
    for (const s of SPECS) {
      counts[s.name] = (await client.query(`select count(*)::int as n from ${q(s.name)}${s.name === 'settings' ? OWN_SETTINGS : ''}`)).rows[0].n;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0), { cfg } = ctx;
    const manifest: Manifest = { format: FORMAT, version: VERSION, app: appVersion(), schema: schemaVersion(), exportedAt: new Date().toISOString(), counts,
      storage: cfg.STORAGE_DRIVER === 's3' ? { driver: 's3', bucket: cfg.S3_BUCKET, prefix: cfg.S3_PREFIX } : { driver: 'local' } };
    await write(JSON.stringify(manifest));
    let done = 0;
    for (const s of SPECS) {
      const list = [...s.cols].map(([c, type]) => selectExpr(c, type)).join(', ');
      await client.query(`declare c no scroll cursor for select ${list} from ${q(s.name)}${s.name === 'settings' ? OWN_SETTINGS : ''}`);
      for (;;) {
        const rows = (await client.query('fetch 500 from c')).rows as Record<string, unknown>[];
        if (!rows.length) break;
        for (const r of rows) { const row = forExport(s.name, r); if (row) await write(JSON.stringify({ t: s.name, r: row })); }
        done += rows.length; progress?.(done, total);
      }
      await client.query('close c');
    }
    await client.query('commit');
    gz.end();
    await finished;
    return manifest;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    gz.destroy(); out.destroy();
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw e;
  } finally { client.release(); }
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
export const exportKey = (name: string) => `exports/${name}`;
/** A file name under exports/: letters, numbers, dots, dashes. Never a path. */
export const exportName = (name: unknown): string => {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(name) || name.includes('..')) throw refuse('That is not the name of a file in the exports folder.');
  return name;
};

async function withLock<R>(ctx: Ctx, fn: () => Promise<R>): Promise<R | { busy: true }> {
  const client: pg.PoolClient = await (ctx.db as any).$client.connect();
  let locked = false;
  try {
    locked = (await client.query('select pg_try_advisory_lock($1) as ok', [LOCK])).rows[0].ok === true;
    if (!locked) return { busy: true };
    return await fn();
  } finally {
    if (locked) await client.query('select pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    client.release();
  }
}

/**
 * Make an export into the library's own storage, under exports/. One at a time. How far along it is, and how the
 * last one ended, are kept in settings (export:state), and what has been made in export:list, newest first.
 */
export async function runExport(ctx: Ctx, by: string): Promise<{ busy: true } | { ok: true; entry: ExportEntry } | { ok: false; reason: string }> {
  const tmp = path.join(ctx.cfg.tmpDir, `export-${crypto.randomBytes(6).toString('hex')}.part`);
  const r = await withLock(ctx, async () => {
    try {
      await fsp.mkdir(ctx.cfg.tmpDir, { recursive: true });
      await putSetting(ctx, 'export:state', { running: true, at: Date.now(), done: 0, total: 0 } satisfies ExportState);
      let last = 0;
      const man = await writeExport(ctx, tmp, (done, total) => { if (Date.now() - last > 1500) { last = Date.now(); void putSetting(ctx, 'export:state', { running: true, at: Date.now(), done, total }).catch(() => {}); } });
      const before = (await getSetting<ExportEntry[]>(ctx, 'export:list')) ?? [];
      let at = new Date(), name = `imagestoria-library-${stamp(at)}.jsonl.gz`;
      if (before.some((e) => e.name === name)) { await new Promise((res) => setTimeout(res, 1100)); at = new Date(); name = `imagestoria-library-${stamp(at)}.jsonl.gz`; }
      const bytes = (await fsp.stat(tmp)).size;
      await ctx.storage.putFile(exportKey(name), tmp, 'application/gzip');
      const list = [{ name, key: exportKey(name), at: at.getTime(), bytes, items: man.counts.items ?? 0 }, ...before], keep = list.slice(0, KEEP), drop = list.slice(KEEP);
      if (drop.length) await ctx.storage.remove(drop.map((d) => d.key)).catch((e) => ctx.log.warn({ err: e }, 'an old export could not be removed'));
      await putSetting(ctx, 'export:list', keep);
      await putSetting(ctx, 'export:state', { running: false, at: Date.now() } satisfies ExportState);
      await ctx.db.insert(T.activity).values({ userId: null, who: by, text: `exported the library (${(bytes / 1048576).toFixed(1)} MB)` });
      return { ok: true as const, entry: keep[0]! };
    } catch (e: any) {
      const reason = String(e?.message ?? e).slice(0, 400);
      ctx.log.error({ err: e }, 'the export failed');
      await putSetting(ctx, 'export:state', { running: false, at: Date.now(), error: reason } satisfies ExportState).catch(() => {});
      return { ok: false as const, reason };
    } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
  });
  return r;
}

/** For the settings page. An export that says it is running while nobody holds the lock stopped with its server. */
export async function exportState(ctx: Ctx) {
  let state = await getSetting<ExportState>(ctx, 'export:state');
  if (state?.running && Date.now() - state.at > 30_000) {
    const free = await withLock(ctx, async () => true);
    if (free === true) { state = { running: false, at: state.at, error: 'The export stopped before it was finished. Start it again.' }; await putSetting(ctx, 'export:state', state); }
  }
  return { state, list: (await getSetting<ExportEntry[]>(ctx, 'export:list')) ?? [], where: ctx.cfg.STORAGE_DRIVER === 's3' ? 'bucket' : 'disk', bucket: ctx.cfg.STORAGE_DRIVER === 's3' ? ctx.cfg.S3_BUCKET : null };
}

/* ---------- reading ---------- */

/** The lines of a gzip file, one at a time, however large the file. A line longer than any row could be stops it. */
async function* lines(file: string): AsyncGenerator<string> {
  const src = fs.createReadStream(file), gz = zlib.createGunzip();
  src.on('error', (e) => gz.destroy(e));
  src.pipe(gz);
  let rest = '';
  const dec = new TextDecoder('utf-8');
  try {
    for await (const chunk of gz) {
      rest += dec.decode(chunk as Buffer, { stream: true });
      let at: number;
      while ((at = rest.indexOf('\n')) >= 0) { const line = rest.slice(0, at); rest = rest.slice(at + 1); if (line) yield line; }
      if (rest.length > MAX_LINE) throw refuse(NOT_EXPORT);
    }
    if (rest.trim()) throw refuse(BROKEN); // every line we write ends in a newline, so a tail without one was cut off
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    // zlib says what is wrong with the file: not gzip at all, or cut short
    throw refuse(e?.code === 'Z_DATA_ERROR' && /header/i.test(String(e?.message)) ? NOT_EXPORT : BROKEN);
  } finally { src.destroy(); gz.destroy(); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAMP = /^\d{4,6}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?$/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
function fits(type: string, v: unknown): boolean {
  if (v === null) return true;
  switch (type) {
    case 'uuid': return typeof v === 'string' && UUID.test(v);
    case 'text': return typeof v === 'string' && !v.includes('\u0000');
    case 'boolean': return typeof v === 'boolean';
    case 'integer': return Number.isInteger(v) && Math.abs(v as number) <= 2147483647;
    case 'bigint': return (typeof v === 'string' && /^-?\d{1,18}$/.test(v)) || Number.isSafeInteger(v);
    case 'real': case 'double precision': return typeof v === 'number' && Number.isFinite(v);
    case 'timestamp with time zone': return typeof v === 'string' && v.endsWith('Z') && STAMP.test(v.slice(0, -1));
    case 'timestamp': return typeof v === 'string' && STAMP.test(v);
    case 'bytea': return typeof v === 'string' && B64.test(v);
    case 'jsonb': return true;
    case 'text[]': return Array.isArray(v) && v.every((x) => typeof x === 'string' && !x.includes('\u0000'));
    case 'uuid[]': return Array.isArray(v) && v.every((x) => typeof x === 'string' && UUID.test(x));
    default: return false;
  }
}
const placeholder = (type: string, n: number) => (type === 'bytea' ? `decode($${n}, 'base64')` : `$${n}::${type}`);
const param = (type: string, v: unknown) => (v === null || v === undefined ? null : type === 'jsonb' ? JSON.stringify(v) : v);

function readManifest(line: string): Manifest {
  let m: any;
  try { m = JSON.parse(line); } catch { throw refuse(NOT_EXPORT); }
  if (!m || typeof m !== 'object' || m.format !== FORMAT) throw refuse(NOT_EXPORT);
  if (m.version !== VERSION) throw refuse(Number(m.version) > VERSION ? 'This export was made by a newer ImageStoria. Update this server first.' : NOT_EXPORT);
  const theirs = schemaNumber(m.schema), ours = schemaNumber(schemaVersion());
  if (!Number.isFinite(theirs) || !m.counts || typeof m.counts !== 'object') throw refuse(NOT_EXPORT);
  if (theirs > ours) throw refuse('This export was made by a newer ImageStoria. Update this server first.');
  for (const [t, n] of Object.entries(m.counts)) { if (!SPEC.has(t)) throw refuse(`This export holds a table this server does not know (${t.slice(0, 40)}). Nothing was changed.`); if (!Number.isInteger(n) || (n as number) < 0) throw refuse(NOT_EXPORT); }
  return m as Manifest;
}
function readRow(line: string): { spec: Spec; row: Record<string, unknown> } {
  let o: any;
  try { o = JSON.parse(line); } catch { throw refuse(BROKEN); }
  if (!o || typeof o !== 'object' || typeof o.t !== 'string' || !o.r || typeof o.r !== 'object' || Array.isArray(o.r)) throw refuse(BROKEN);
  const spec = SPEC.get(o.t);
  if (!spec) throw refuse(`This export holds a table this server does not know (${o.t.slice(0, 40)}). Nothing was changed.`);
  for (const [c, v] of Object.entries(o.r)) {
    const type = spec.cols.get(c);
    if (!type) throw refuse(`This export holds a column this server does not know (${spec.name}.${c.slice(0, 40)}). Nothing was changed.`);
    if (!fits(type, v)) throw refuse(`This export holds a value this server cannot read (${spec.name}.${c}). Nothing was changed.`);
  }
  return { spec, row: o.r };
}

/** Read the whole file without touching the database: is it an export, from a version we know, whole, with only tables and columns we know? */
export async function checkExport(file: string): Promise<Manifest> {
  let man: Manifest | null = null;
  const seen: Record<string, number> = {};
  for await (const line of lines(file)) {
    if (!man) { man = readManifest(line); continue; }
    const { spec } = readRow(line);
    seen[spec.name] = (seen[spec.name] ?? 0) + 1;
  }
  if (!man) throw refuse(NOT_EXPORT);
  // Rows the exporter itself leaves out (settings) can make a table shorter than its count, never longer, and every other table must match.
  for (const s of SPECS) { const want = man.counts[s.name] ?? 0, got = seen[s.name] ?? 0; if (s.name === 'settings' ? got > want : got !== want) throw refuse(BROKEN); }
  return man;
}

/** The person doing the import, as they are in this library before it is replaced. They stay able to sign in afterwards. */
export interface Importer { id: string; name: string }

/**
 * Replace this library with the one in the file. The file is checked first and nothing is changed if it fails.
 * A library that already has pictures is only replaced when `replace` is set, and a backup of its database is made first.
 * Tables are emptied and loaded in one transaction. Files in storage are not touched.
 */
export async function importLibrary(ctx: Ctx, file: string, opts: { replace: boolean; by: Importer | null }): Promise<ImportResult> {
  const man = await checkExport(file);
  const r = await withLock(ctx, async (): Promise<ImportResult> => {
    const had = (await ctx.db.execute(`select count(*)::int as n from items`)).rows[0]!.n as number;
    let backup: string | null = null;
    if (had > 0) {
      if (!opts.replace) throw refuse('This library already has pictures. Importing replaces everything in it. Confirm that you want to replace it.', 409);
      const b = await runBackup(ctx, opts.by?.name ?? 'the command line');
      if ('busy' in b) throw refuse('A backup is running, and one is needed before this library is replaced. Try again in a minute.', 409);
      if (!b.ok) throw refuse(`The backup that is made before a library is replaced failed, so nothing was changed. ${b.reason}`, 500);
      backup = b.entry.key;
    }
    const client: pg.PoolClient = await (ctx.db as any).$client.connect();
    let rows = 0, userId: string | null = null, items = 0;
    try {
      await client.query('begin');
      const tx = drizzle(client, { schema }) as unknown as Db;
      const me = opts.by ? (await client.query('select * from users where id = $1', [opts.by.id])).rows[0] ?? null : null;
      // Empty the library. Children first, so nothing is left pointing at a row that is gone. Sessions and one-time links go with the users,
      // and work in line goes with the pictures it was for. Machines that read the pictures (workers) belong to this server and stay.
      await client.query('delete from jobs');
      for (const s of [...SPECS].reverse()) if (s.name !== 'settings') await client.query(`delete from ${q(s.name)}`);
      await client.query('delete from sessions'); await client.query('delete from tokens');
      await client.query('delete from settings where key = any($1)', [SETTINGS.filter((k) => k !== 'cloudai')]);

      let batch: { spec: Spec; cols: string[]; rows: Record<string, unknown>[] } | null = null;
      const flush = async () => {
        const b = batch; batch = null;
        if (!b || !b.rows.length) return;
        const params: unknown[] = [], tuples = b.rows.map((row) => `(${b.cols.map((c) => { params.push(param(b.spec.cols.get(c)!, row[c])); return placeholder(b.spec.cols.get(c)!, params.length); }).join(', ')})`);
        // The reading with a provider that this library already set up stays as it is: an export never brings a key, and must not take one away.
        const tail = b.spec.name === 'settings' ? ' on conflict (key) do nothing' : '';
        await client.query(`insert into ${q(b.spec.name)} (${b.cols.map(q).join(', ')}) values ${tuples.join(', ')}${tail}`, params);
        rows += b.rows.length;
      };
      let first = true;
      for await (const line of lines(file)) {
        if (first) { first = false; continue; }
        const { spec, row } = readRow(line);
        let take = row;
        if (spec.name === 'settings') {
          if (!SETTINGS.includes(String(row.key)) || row.value === null || row.value === undefined) continue;
          if (row.key === 'cloudai') take = { key: 'cloudai', value: { ...(typeof row.value === 'object' ? row.value : {}), key: null, keyHint: null, on: false, stopped: null } };
        }
        if (spec.name === 'ai_tasks') take = { ...row, worker_id: null };
        const cols = Object.keys(take).sort();
        if (!batch || batch.spec !== spec || batch.cols.join() !== cols.join() || batch.rows.length >= 200) { await flush(); batch = { spec, cols, rows: [] }; }
        batch.rows.push(take);
      }
      await flush();

      if (!(await client.query('select 1 from spaces limit 1')).rowCount) throw refuse('This export has no spaces in it, so there would be nothing to open. Nothing was changed.');
      // Whoever is doing this stays an owner and keeps the password they have here, whether or not the export knows them.
      if (me) {
        const twin = me.email ? (await client.query('select id from users where lower(email) = lower($1)', [me.email])).rows[0] : null;
        if (twin) {
          await client.query(`update users set role = 'owner', status = 'active', password_hash = $2 where id = $1`, [twin.id, me.password_hash]);
          if (me.oidc_subject) { await client.query('update users set oidc_subject = null where oidc_subject = $1 and id <> $2', [me.oidc_subject, twin.id]); await client.query('update users set oidc_subject = $2 where id = $1', [twin.id, me.oidc_subject]); }
          userId = twin.id;
        } else {
          if (me.oidc_subject) await client.query('update users set oidc_subject = null where oidc_subject = $1', [me.oidc_subject]);
          await client.query(`insert into users (id, name, email, handle, password_hash, role, caps, color, avatar_key, status, oidc_subject, created_at, last_seen_at)
            values ($1, $2, $3, $4, $5, 'owner', '{}'::jsonb, $6, null, 'active', $7, $8, $9)
            on conflict (id) do update set role = 'owner', status = 'active', password_hash = excluded.password_hash`,
          [me.id, me.name, me.email, me.handle, me.password_hash, me.color, me.oidc_subject, me.created_at, me.last_seen_at]);
          userId = me.id;
        }
      }
      if (!(await client.query(`select 1 from users where role = 'owner' and status = 'active' limit 1`)).rowCount) throw refuse('This export has no owner in it, so nobody could open the library. Nothing was changed.');
      items = (await client.query('select count(*)::int as n from items where deleted_at is null')).rows[0].n;
      await client.query('insert into activity (user_id, who, text) values ($1, $2, $3)', [userId, opts.by?.name ?? 'The command line', `imported a library of ${items} ${items === 1 ? 'item' : 'items'}, exported on ${String(man.exportedAt).slice(0, 10)}`]);
      await client.query('commit');
    } catch (e: any) {
      await client.query('rollback').catch(() => {});
      if (e instanceof HttpError) throw e;
      ctx.log.error({ err: e }, 'the import failed');
      // What the database refused (a missing column an old export does not have, two rows that cannot both exist) without repeating its values.
      throw refuse(`The export could not be loaded, so nothing was changed. ${e?.code ? `The database refused a row${e.table ? ` of ${e.table}` : ''}${e.constraint ? ` (${e.constraint})` : ''}.` : ''}`.trim());
    } finally { client.release(); }
    // What was held in memory about the old library is no use now.
    if (ctx.embeds) ctx.embeds = new EmbedIndex(ctx);
    const files = await checkFiles(ctx);
    return { items, rows, ...files, backup, userId };
  });
  if ('busy' in r) throw refuse('An export or an import is already running. Look again in a minute.', 409);
  return r;
}

/** Are the pictures there? A cheap look at up to 200 originals spread across the library, never the whole of it. */
export async function checkFiles(ctx: Ctx): Promise<{ filesChecked: number; filesFound: number; sentence: string }> {
  const keys = ((await ctx.db.execute(`
    with live as (select orig_key, row_number() over (order by id) as rn, count(*) over () as n from items where deleted_at is null)
    select orig_key from live where n <= 200 or (rn - 1) % ceil(n / 200.0)::int = 0 limit 200`)).rows as { orig_key: string }[]).map((r) => r.orig_key);
  let found = 0;
  for (let i = 0; i < keys.length; i += 8) found += (await Promise.all(keys.slice(i, i + 8).map((k) => ctx.storage.exists(k).catch(() => false)))).filter(Boolean).length;
  const n = keys.length, missing = n - found;
  const sentence = !n ? 'There are no pictures in this library to check.'
    : !missing ? (n === 1 ? 'The one file checked is in this library’s storage.' : `All ${n} files checked are in this library’s storage.`)
      : `${missing} of ${n} files checked ${missing === 1 ? 'is' : 'are'} missing. Copy the pictures into this library’s storage, then they will appear.`;
  return { filesChecked: n, filesFound: found, sentence };
}
