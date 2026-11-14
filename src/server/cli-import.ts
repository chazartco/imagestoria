/**
 * Bring a folder of photos and videos into the library without going through the browser.
 * The files are copied into storage. The folder itself is only read, never changed.
 *
 *   docker compose exec app node dist/server/cli-import.js /import --space life
 *
 * The running app notices the new items within a few seconds and makes their display copies and thumbnails.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { loadConfig } from './config.js';
import { type Db, openDb, schema } from './db/index.js';
import { isMediaName, isVideoName, keysFor, mimeFor, sha256File, wallFromEpoch } from './media/ingest.js';
import { type Storage, createStorage } from './storage/index.js';

export interface ImportResult { added: number; skipped: number; failed: number; ignored: number }

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

export async function importFolder(db: Db, storage: Storage, dir: string, opts: { space?: string; dryRun?: boolean; say?: (line: string) => void } = {}): Promise<ImportResult> {
  const say = opts.say ?? (() => {});
  const spaces = await db.select().from(schema.spaces).orderBy(asc(schema.spaces.position));
  const space = opts.space ? spaces.find((s) => s.slug === opts.space || s.name.toLowerCase() === opts.space!.toLowerCase()) : spaces[0];
  if (!space) throw new Error(opts.space ? `There is no space called "${opts.space}". Spaces: ${spaces.map((s) => s.slug).join(', ') || 'none yet'}.` : 'Set up the library in the browser first, so there is a space to import into.');
  const [owner] = await db.select().from(schema.users).where(and(eq(schema.users.role, 'owner'), eq(schema.users.status, 'active'))).orderBy(asc(schema.users.createdAt)).limit(1);
  if (!owner) throw new Error('Set up the library in the browser first, so the import has an owner.');
  const out: ImportResult = { added: 0, skipped: 0, failed: 0, ignored: 0 };
  for await (const file of walk(dir)) {
    const name = path.basename(file);
    if (!isMediaName(name)) { out.ignored++; continue; }
    try {
      const sha = await sha256File(file);
      const dup = await db.select({ id: schema.items.id }).from(schema.items).where(and(eq(schema.items.sha256, sha), isNull(schema.items.deletedAt), isNull(schema.items.copyOf))).limit(1);
      if (dup[0]) { out.skipped++; continue; }
      if (opts.dryRun) { out.added++; say(`would add ${file}`); continue; }
      const st = await fsp.stat(file);
      // Until the file's own date is read, it is filed under the day it was last changed.
      const fallback = wallFromEpoch(st.mtimeMs, new Date(st.mtimeMs).getTimezoneOffset());
      const id = crypto.randomUUID();
      const keys = keysFor(id, fallback, name);
      const mime = mimeFor(name);
      await storage.putFile(keys.orig, file, mime);
      await db.insert(schema.items).values({ id, spaceId: space.id, kind: isVideoName(name) ? 'video' : 'photo', fileName: name, mime, sha256: sha, takenAt: fallback, addedBy: owner.id, origKey: keys.orig, bytesOrig: st.size });
      await db.insert(schema.jobs).values({ type: 'ingest', itemId: id, payload: { fallbackTakenAt: fallback.toISOString() } });
      out.added++;
      if (out.added % 25 === 0) say(`${out.added} added so far`);
    } catch (e) {
      out.failed++;
      say(`could not add ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  if (!dir) {
    console.error('Usage: node dist/server/cli-import.js <folder> [--space <name>] [--dry-run]');
    process.exit(2);
  }
  const cfg = loadConfig();
  const { db, pool } = openDb(cfg.DATABASE_URL);
  const storage = createStorage(cfg);
  try {
    await storage.check();
    const r = await importFolder(db, storage, path.resolve(dir), { space: flag('space'), dryRun: args.includes('--dry-run'), say: (l) => console.log(l) });
    console.log(`${args.includes('--dry-run') ? 'Would add' : 'Added'} ${r.added}. Already in the library: ${r.skipped}. Not photos or videos: ${r.ignored}. Failed: ${r.failed}.`);
    if (r.added && !args.includes('--dry-run')) console.log('The running app is now making display copies and thumbnails. Watch them arrive in the browser.');
    process.exitCode = r.failed ? 1 : 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
