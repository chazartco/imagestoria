import { and, desc, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { schema } from './db/index.js';

const { items } = schema;

/**
 * Put trashed items back in the library: all of them, or only the ones named.
 * One at a time, because a file that was deleted and then uploaded again has a twin in the library,
 * and the same file may not be in the library twice. Those stay in the trash.
 */
export async function restoreTrash(ctx: Ctx, ids?: string[]) {
  const rows = await ctx.db.select({ id: items.id, sha: items.sha256, copyOf: items.copyOf }).from(items)
    .where(and(isNotNull(items.deletedAt), ids ? inArray(items.id, ids) : undefined)).orderBy(desc(items.deletedAt));
  let restored = 0, skipped = 0;
  for (const r of rows) {
    if (!r.copyOf) {
      const twin = await ctx.db.select({ id: items.id }).from(items).where(and(eq(items.sha256, r.sha), isNull(items.deletedAt), isNull(items.copyOf))).limit(1);
      if (twin.length) { skipped++; continue; }
    }
    await ctx.db.update(items).set({ deletedAt: null, updatedAt: new Date() }).where(eq(items.id, r.id));
    restored++;
  }
  return { restored, skipped };
}

/** Remove trashed items and their files for good: all of them, only the ones named, or only those deleted before a moment. */
export async function emptyTrash(ctx: Ctx, opts: { ids?: string[]; before?: Date } = {}) {
  const rows = await ctx.db.select().from(items)
    .where(and(isNotNull(items.deletedAt), opts.ids ? inArray(items.id, opts.ids) : undefined, opts.before ? lt(items.deletedAt, opts.before) : undefined));
  if (!rows.length) return { n: 0, bytes: 0 };
  const keys = rows.flatMap((r) => [r.origKey, r.displayKey, r.thumbKey, r.fullKey, r.playKey].filter((k): k is string => Boolean(k)));
  await ctx.storage.remove(keys);
  for (let i = 0; i < rows.length; i += 1000) await ctx.db.delete(items).where(inArray(items.id, rows.slice(i, i + 1000).map((r) => r.id)));
  return { n: rows.length, bytes: rows.reduce((a, r) => a + r.bytesOrig + r.bytesDisplay + r.bytesThumb + r.bytesFull + r.bytesPlay, 0) };
}

/**
 * With TRASH_DAYS set, whatever has been in the trash longer than that is removed for good.
 * Runs a little after start and then once a day. Returns a function that stops it.
 */
export function startTrashPass(ctx: Ctx): () => void {
  const days = ctx.cfg.TRASH_DAYS;
  if (!(days > 0)) return () => {};
  const pass = async () => {
    try {
      const r = await emptyTrash(ctx, { before: new Date(Date.now() - days * 86400_000) });
      if (r.n) {
        await ctx.db.insert(schema.activity).values({ userId: null, who: 'ImageStoria', text: `removed ${r.n} item${r.n === 1 ? '' : 's'} that had been in the trash for more than ${days} day${days === 1 ? '' : 's'}` });
        ctx.log.info({ items: r.n, bytes: r.bytes }, 'old trash removed');
      }
    } catch (e) { ctx.log.error({ err: e }, 'the trash pass failed'); }
  };
  const first = setTimeout(pass, 60_000), daily = setInterval(pass, 86400_000);
  first.unref(); daily.unref();
  return () => { clearTimeout(first); clearInterval(daily); };
}
