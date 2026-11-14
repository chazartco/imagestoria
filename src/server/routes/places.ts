import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logActivity, needCap, needSpace } from '../auth/core.js';
import { type Ctx, HttpError, bad } from '../context.js';
import { schema } from '../db/index.js';
import { geocode, importPlaceNames, placeDataState, renameAll, whereFor } from '../media/spots.js';
import { ResultError } from '../ai/embed.js';

const uuid = z.string().uuid();
const { items, placeSuggestions } = schema;
type Tx = Parameters<Parameters<Ctx['db']['transaction']>[0]>[0];

/**
 * Where a picture with no location might have been taken. Two sources:
 *  - "vision": a worker's vision model recognised the place in the picture.
 *  - "nearby": the same camera took a picture a few minutes away that does have a location.
 * A suggestion is never stored as the location. It becomes one only when a person accepts it, and the item then says
 * its location was "suggested". A suggestion a person rejected is not made again.
 */

const placeShape = z.object({ place: z.string().max(200), kind: z.string().max(30).optional(), confidence: z.number().min(0).max(1), why: z.string().max(300).optional() });

/** Store what a vision model said about where a picture was taken. Only for a picture that still has no location. */
export async function applyPlace(ctx: Ctx, tx: Tx, itemId: string, data: unknown, model: { name: string; version: string }) {
  const d = placeShape.parse(data), name = d.place.replace(/\s+/g, ' ').trim();
  const [it] = await tx.select({ lat: items.lat }).from(items).where(eq(items.id, itemId));
  if (!it) throw new ResultError('That item is gone.');
  const [old] = await tx.select().from(placeSuggestions).where(and(eq(placeSuggestions.itemId, itemId), eq(placeSuggestions.source, 'vision')));
  // a person said no to this very place: a second reading does not bring it back
  if (old?.status === 'rejected' && old.name.toLowerCase() === name.toLowerCase()) return;
  if (it.lat != null || !name || d.confidence < ctx.cfg.PLACE_SUGGEST_MIN) { if (old && old.status === 'open') await tx.delete(placeSuggestions).where(and(eq(placeSuggestions.itemId, itemId), eq(placeSuggestions.source, 'vision'))); return; }
  const pt = await geocode(ctx, name);
  // A place that cannot be found on the map held here is still worth showing: the person may know where it is.
  const row = { itemId, source: 'vision', name, lat: pt?.lat ?? null, lng: pt?.lng ?? null, confidence: Math.round(d.confidence * (pt && !pt.exact ? 0.8 : 1) * 100) / 100, why: d.why ?? '', model: model.name, status: 'open', fromItem: null };
  await tx.insert(placeSuggestions).values(row).onConflictDoUpdate({ target: [placeSuggestions.itemId, placeSuggestions.source], set: row });
}

interface Suggestion { item: string; source: 'vision' | 'nearby'; name: string; lat: number | null; lng: number | null; confidence: number; why: string; from: string | null }

/** Every open suggestion in a space. Those from nearby pictures are worked out fresh each time, so they follow every change. */
export async function suggestions(ctx: Ctx, spaceId: string, only?: string[]): Promise<Suggestion[]> {
  const mins = ctx.cfg.PLACE_NEARBY_MINUTES, idf = only?.length ? sql`and i.id in (${sql.join(only.map((i) => sql`${i}::uuid`), sql`, `)})` : sql``;
  const vis = await ctx.db.execute(sql`
    select s.item_id as item, s.name, s.lat, s.lng, s.confidence, s.why from place_suggestions s join items i on i.id = s.item_id
    where s.source = 'vision' and s.status = 'open' and i.space_id = ${spaceId}::uuid and i.deleted_at is null and i.lat is null ${idf}`);
  const near = mins > 0 ? await ctx.db.execute(sql`
    select i.id as item, n.id as "from", n.lat, n.lng, n.gap, coalesce(n.spot, p.name, 'the same place') as name
    from items i join lateral (
      select o.id, o.lat, o.lng, o.spot, o.place_id, abs(extract(epoch from (o.taken_at - i.taken_at))) as gap from items o
      where o.space_id = i.space_id and o.deleted_at is null and o.lat is not null and o.camera = i.camera and o.location_source in ('exif', 'manual')
        and o.taken_at between i.taken_at - make_interval(mins => ${mins}) and i.taken_at + make_interval(mins => ${mins})
      order by abs(extract(epoch from (o.taken_at - i.taken_at))) limit 1) n on true
    left join places p on p.id = n.place_id
    where i.space_id = ${spaceId}::uuid and i.deleted_at is null and i.lat is null and i.camera is not null and i.status = 'ready' ${idf}
      and not exists (select 1 from place_suggestions r where r.item_id = i.id and r.source = 'nearby' and r.status = 'rejected')`) : { rows: [] };
  const out: Suggestion[] = [];
  for (const r of near.rows as any[]) {
    const gap = Number(r.gap), m = Math.round(gap / 60);
    out.push({ item: r.item, source: 'nearby', name: r.name, lat: r.lat, lng: r.lng, from: r.from, confidence: Math.round((0.95 - 0.45 * gap / (mins * 60)) * 100) / 100, why: m < 1 ? 'The same camera took a picture there within a minute.' : `The same camera took a picture there ${m} ${m === 1 ? 'minute' : 'minutes'} before or after.` });
  }
  const have = new Set(out.map((s) => s.item));
  // a picture taken minutes from a known spot is surer than a guess from looking, so the nearby one wins when both exist
  for (const r of vis.rows as any[]) if (!have.has(r.item)) out.push({ item: r.item, source: 'vision', name: r.name, lat: r.lat, lng: r.lng, confidence: r.confidence, why: r.why, from: null });
  return out;
}

export function registerPlaces(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const pick = z.object({ items: z.array(z.object({ id: uuid, source: z.enum(['vision', 'nearby']) })).min(1).max(2000) });

  app.get('/api/place-suggestions', async (req) => {
    const q = z.object({ space: uuid }).parse(req.query);
    needSpace(req, q.space);
    return { suggestions: await suggestions(ctx, q.space) };
  });

  /** Accept suggestions: each becomes the item's location, marked as having come from a suggestion. The server looks the place up again: the page only says which. */
  app.post('/api/place-suggestions/accept', async (req) => {
    const me = needCap(req, 'tag');
    const b = pick.parse(req.body);
    const rows = await db.select({ id: items.id, space: items.spaceId }).from(items).where(and(inArray(items.id, b.items.map((x) => x.id)), sql`${items.deletedAt} is null`));
    if (rows.length !== new Set(b.items.map((x) => x.id)).size) throw new HttpError(404, 'One of those items is gone.');
    const spaces = [...new Set(rows.map((r) => r.space))];
    for (const s of spaces) needSpace(req, s);
    const open = new Map<string, Suggestion>();
    for (const s of spaces) for (const x of await suggestions(ctx, s, rows.filter((r) => r.space === s).map((r) => r.id))) open.set(x.item + ':' + x.source, x);
    let n = 0; const skipped: string[] = [];
    for (const x of b.items) {
      const s = open.get(x.id + ':' + x.source);
      if (!s || s.lat == null || s.lng == null) { skipped.push(x.id); continue; }
      await db.update(items).set({ lat: s.lat, lng: s.lng, ...(await whereFor(ctx, s.lat, s.lng)), locationSource: 'suggested', updatedAt: new Date() }).where(eq(items.id, x.id));
      await db.delete(placeSuggestions).where(eq(placeSuggestions.itemId, x.id));
      await db.execute(sql`delete from ai_tasks where task = 'place' and status = 'queued' and item_id = ${x.id}::uuid`);
      n++;
    }
    if (n) await logActivity(ctx, me, `accepted a suggested location for ${n} item${n === 1 ? '' : 's'}`);
    return { ok: true, n, skipped };
  });

  /** Reject suggestions. They are not made again. */
  app.post('/api/place-suggestions/reject', async (req) => {
    needCap(req, 'tag');
    const b = pick.parse(req.body);
    const rows = await db.select({ id: items.id, space: items.spaceId }).from(items).where(inArray(items.id, b.items.map((x) => x.id)));
    for (const s of new Set(rows.map((r) => r.space))) needSpace(req, s);
    const ok = new Set(rows.map((r) => r.id));
    for (const x of b.items) {
      if (!ok.has(x.id)) continue;
      await db.insert(placeSuggestions).values({ itemId: x.id, source: x.source, name: '', status: 'rejected' })
        .onConflictDoUpdate({ target: [placeSuggestions.itemId, placeSuggestions.source], set: { status: 'rejected' } });
    }
    await db.update(items).set({ updatedAt: new Date() }).where(inArray(items.id, [...ok]));
    return { ok: true };
  });

  /* ---------- the owner's side: the place names themselves ---------- */

  app.get('/api/admin/places', async (req) => { needCap(req, 'admin'); return placeDataState(ctx); });

  /** Fetch the place names (or read a file already on the server) and name every located picture again. Runs in the background. */
  app.post('/api/admin/places/fetch', async (req) => {
    const me = needCap(req, 'admin');
    const st = await placeDataState(ctx);
    if (st.busy) throw new HttpError(409, 'Place data is already being fetched.');
    void importPlaceNames(ctx, undefined, (m) => ctx.log.info(m)).then((r) => logActivity(ctx, me, `fetched ${r.kept.toLocaleString('en')} place names and named ${r.renamed} items again`), (e) => ctx.log.error({ err: e }, 'place names could not be fetched'));
    return { ok: true };
  });

  /** Name the place of every located picture again from the data already here. */
  app.post('/api/admin/places/rename', async (req) => {
    const me = needCap(req, 'admin');
    if ((await placeDataState(ctx)).busy) throw bad('Wait until the place data has finished loading.');
    const n = await renameAll(ctx);
    await logActivity(ctx, me, `named the places of the library again (${n} changed)`);
    return { n };
  });
}
