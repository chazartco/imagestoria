import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { lutExists } from './luts.js';
import { SCENES } from '../../shared/scenes.js';
import { facesMoved } from '../ai/faces.js';
import { peopleSpaces } from './faces.js';
import { whereFor } from '../media/spots.js';
import { recipeIsEmpty } from '../../shared/develop.js';
import { logActivity, need, needCap, needSpace, type SessionUser } from '../auth/core.js';
import { type Ctx, HttpError, bad, forbidden, notFound } from '../context.js';
import { schema } from '../db/index.js';
import { searchPlaces } from '../media/geo.js';
import { emptyTrash, restoreTrash } from '../trash.js';
import { queueTasks } from '../ai/tasks.js';
import { isMediaName, isVideoName, keysFor, mimeFor, placeIdFor, sha256File, wall, wallFromEpoch } from '../media/ingest.js';

const uuid = z.string().uuid();
const { items } = schema;
/** A wall-clock moment as the page sends it: no time zone, seconds optional. */
const WALL = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?$/;
function parseWall(d: string) {
  const m = WALL.exec(d)!;
  const out = wall(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  if (Number.isNaN(out.getTime()) || +m[1]! < 1800 || +m[1]! > 2200) throw bad('That date is not one a camera could have written.');
  return out;
}

/** Raise this when a row of the index gains, loses or changes a field: browsers that kept the old list then load it again. */
const INDEX_SHAPE = 1;
/** The compact row the grid, filters, map and timeline all work from. */
const INDEX_SQL = sql`
  i.id, i.space_id as "space", i.kind, i.status, i.error, i.file_name as "fileName", i.mime,
  i.width as w, i.height as h, i.duration,
  to_char(i.taken_at, 'YYYY-MM-DD"T"HH24:MI:SS') as d, i.date_source as "dateSrc",
  (extract(epoch from i.added_at) * 1000)::bigint as added,
  (extract(epoch from i.updated_at) * 1000)::bigint as v,
  i.title, i.description as "desc", i.lat, i.lng, i.place_id as place, i.location_source as "locSrc", i.spot, i.spot_kind as "spotKind",
  i.camera as cam, i.lens, i.iso, i.shutter, i.fnum, i.focal, i.palette, i.series,
  i.copy_of as "copyOf", (i.full_key is not null) as "hasFull", i.play_status as "play", i.play_error as "playError",
  i.bytes_orig as "bOrig", i.bytes_display as "bDisp", i.bytes_thumb as "bThumb",
  i.ai_status as "aiStatus", i.ai_scene as "aiScene", i.ai_caption as "aiCaption", i.ai_text as "aiText", i.ai_locked as "aiLocked",
  coalesce((select array_agg(t.name order by t.name) from item_tags it join tags t on t.id = it.tag_id where it.item_id = i.id), '{}') as tags,
  coalesce((select array_agg(l.user_id order by l.created_at) from likes l where l.item_id = i.id), '{}') as likes,
  (select count(*) from comments c where c.item_id = i.id)::int as nc,
  coalesce((select json_agg(json_build_array(il.label, il.confidence, il.source) order by il.confidence desc, il.label) from item_labels il where il.item_id = i.id and not il.removed), '[]'::json) as labels`;

export async function getItem(ctx: Ctx, id: string) {
  const [it] = await ctx.db.select().from(items).where(and(eq(items.id, id), isNull(items.deletedAt)));
  if (!it) throw notFound('That item is gone.');
  return it;
}
/** Load an item and make sure this person may see it. */
export async function itemFor(ctx: Ctx, req: FastifyRequest, id: string) {
  const it = await getItem(ctx, uuid.parse(id));
  needSpace(req, it.spaceId);
  return it;
}
const touch = (ctx: Ctx, ids: string[]) => (ids.length ? ctx.db.update(items).set({ updatedAt: new Date() }).where(inArray(items.id, ids)) : Promise.resolve());

async function setTags(ctx: Ctx, ids: string[], names: string[], mode: 'add' | 'remove') {
  const clean = [...new Set(names.map((n) => n.trim().toLowerCase().slice(0, 60)).filter(Boolean))];
  if (!clean.length || !ids.length) return;
  if (mode === 'add') {
    await ctx.db.insert(schema.tags).values(clean.map((name) => ({ name }))).onConflictDoNothing();
    const rows = await ctx.db.select().from(schema.tags).where(inArray(schema.tags.name, clean));
    await ctx.db.insert(schema.itemTags).values(ids.flatMap((itemId) => rows.map((t) => ({ itemId, tagId: t.id })))).onConflictDoNothing();
  } else {
    const rows = await ctx.db.select().from(schema.tags).where(inArray(schema.tags.name, clean));
    if (rows.length) await ctx.db.delete(schema.itemTags).where(and(inArray(schema.itemTags.itemId, ids), inArray(schema.itemTags.tagId, rows.map((r) => r.id))));
  }
  await touch(ctx, ids);
}

/**
 * Take one uploaded file: store the original untouched, make the item, and queue the rest.
 * spaceFor decides which space it goes to, and refuses by throwing. addedBy is empty for a visitor
 * who adds to a story through a public link.
 */
export async function receiveUpload(ctx: Ctx, req: FastifyRequest, addedBy: string | null, spaceFor: (fields: Record<string, string>) => string | Promise<string>): Promise<{ id: string; duplicate?: true }> {
  const { db, cfg, storage } = ctx;
  await fsp.mkdir(cfg.tmpDir, { recursive: true });
  const fields: Record<string, string> = {};
  let saved: { tmp: string; name: string; bytes: number } | null = null;
  for await (const part of req.parts()) {
    if (part.type === 'field') { fields[part.fieldname] = String(part.value); continue; }
    if (saved) { part.file.resume(); continue; }
    const name = path.basename(part.filename || 'upload');
    const tmp = path.join(cfg.tmpDir, `up-${crypto.randomBytes(8).toString('hex')}${path.extname(name).toLowerCase()}`);
    await pipeline(part.file, fs.createWriteStream(tmp));
    if (part.file.truncated) { await fsp.rm(tmp, { force: true }); throw new HttpError(413, `That file is larger than the ${cfg.MAX_UPLOAD_MB} MB limit.`); }
    saved = { tmp, name, bytes: (await fsp.stat(tmp)).size };
  }
  if (!saved) throw bad('No file arrived.');
  const cleanup = () => fsp.rm(saved!.tmp, { force: true });
  try {
    if (!isMediaName(saved.name)) throw new HttpError(415, 'Only photos and videos can be added.');
    const spaceId = await spaceFor(fields);
    const sha = await sha256File(saved.tmp);
    const dup = await db.select({ id: items.id }).from(items).where(and(eq(items.sha256, sha), isNull(items.deletedAt), isNull(items.copyOf))).limit(1);
    if (dup[0]) { await cleanup(); return { duplicate: true, id: dup[0].id }; }
    const lastModified = Number(fields.lastModified), tz = Number(fields.tzOffset);
    const fallback = Number.isFinite(lastModified) && lastModified > 0 ? wallFromEpoch(lastModified, Number.isFinite(tz) ? tz : 0) : wallFromEpoch(Date.now(), 0);
    const id = crypto.randomUUID();
    const keys = keysFor(id, fallback, saved.name);
    const mime = mimeFor(saved.name);
    await storage.putFile(keys.orig, saved.tmp, mime);
    await db.insert(items).values({ id, spaceId, kind: isVideoName(saved.name) ? 'video' : 'photo', fileName: saved.name, mime, sha256: sha, takenAt: fallback, addedBy, origKey: keys.orig, bytesOrig: saved.bytes });
    await db.insert(schema.jobs).values({ type: 'ingest', itemId: id, payload: { tmpPath: saved.tmp, fallbackTakenAt: fallback.toISOString() } });
    ctx.kick();
    return { id };
  } catch (e) { await cleanup(); throw e; }
}

/** Answer with a stored file: a signed link to the bucket when there is one, otherwise the bytes themselves, with ranges for video. */
export async function sendStored(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, key: string, type: string, downloadName: string | undefined, proxy: boolean) {
  const { cfg, storage } = ctx;
  if (!proxy) {
    const url = await storage.signedUrl(key, { downloadName, contentType: type });
    if (url) return reply.header('cache-control', `private, max-age=${Math.floor(cfg.S3_URL_TTL_SECONDS / 2)}`).redirect(url);
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  const range = m && (m[1] || m[2]) ? { start: m[1] ? Number(m[1]) : 0, end: m[2] ? Number(m[2]) : undefined } : undefined;
  let f: Awaited<ReturnType<typeof storage.open>>;
  try { f = await storage.open(key, range); }
  catch (e: any) {
    // A row whose file is gone from the disk or the bucket is a missing file, not a broken server.
    if (e?.code === 'ENOENT' || e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) throw new HttpError(404, 'This file is missing from storage.');
    throw e;
  }
  reply.header('content-type', type).header('accept-ranges', 'bytes').header('content-length', f.length)
    .header('cache-control', 'private, max-age=31536000, immutable').header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox");
  if (downloadName) reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
  if (range) reply.code(206).header('content-range', `bytes ${f.start}-${f.end}/${f.total}`);
  return reply.send(f.stream);
}

export function registerItems(app: FastifyInstance, ctx: Ctx) {
  const { db, cfg, storage } = ctx;

  /**
   * Everything in the spaces this person can open, or only what changed since a moment.
   * The page keeps this list in memory and filters it locally, which is what makes search,
   * the timeline and the map respond instantly.
   */
  app.get('/api/index', async (req) => {
    const me = need(req);
    const q = z.object({ since: z.coerce.number().optional(), key: z.string().max(80).optional(), check: z.string().max(4).optional() }).parse(req.query);
    if (!me.spaceIds.length) return { now: Date.now(), key: '', full: !q.since, items: [], removed: [], places: {}, persons: {} };
    const spaceList = sql.join(me.spaceIds.map((s) => sql`${s}::uuid`), sql`, `);
    const now = Date.now();
    // People in the pictures are sent only for the spaces where this person may see them (see routes/faces.ts).
    const seen = await peopleSpaces(ctx, me);
    // A browser may keep the list between visits and ask only for what changed (src/web/js/api.js). The key names what
    // the list was made for: this person, the spaces they may open, the spaces whose people they may see, and the shape
    // of a row. When the browser's key is not this one, "what changed" would not be enough, so it gets everything.
    const key = crypto.createHash('sha256').update(JSON.stringify([INDEX_SHAPE, me.id, [...me.spaceIds].sort(), [...seen].sort()])).digest('base64url').slice(0, 32);
    const full = !q.since || (q.key !== undefined && q.key !== key);
    const since = full ? null : new Date(q.since! - 2000);
    const PEOPLE = seen.length ? sql`, case when i.space_id in (${sql.join(seen.map((s) => sql`${s}::uuid`), sql`, `)}) then coalesce((select array_agg(distinct f.person_id) from faces f where f.item_id = i.id and f.person_id is not null and f.status in ('confirmed', 'auto')), '{}') else '{}' end as people` : sql``;
    const names: Record<string, string> = {};
    if (seen.length) for (const p of await db.select({ id: schema.persons.id, name: schema.persons.name }).from(schema.persons).where(inArray(schema.persons.spaceId, seen))) names[p.id] = p.name;
    const rows = await db.execute(sql`select ${INDEX_SQL}${PEOPLE} from items i where i.space_id in (${spaceList}) and i.deleted_at is null ${since ? sql`and i.updated_at > ${since.toISOString()}::timestamptz` : sql``} order by i.taken_at desc, i.added_at, i.id`);
    const removed = since
      ? (await db.execute(sql`select id from items where deleted_at is not null and updated_at > ${since.toISOString()}::timestamptz`)).rows.map((r: any) => r.id)
      : [];
    const places: Record<string, { name: string; region: string; lat: number; lng: number }> = {};
    for (const p of await db.select().from(schema.places)) places[p.id] = { name: p.name, region: p.region, lat: p.lat, lng: p.lng };
    // check=1: three numbers that say exactly what this person's list holds now (how many items, which, and each one's
    // last change). A browser that kept the list compares them with its own, and loads everything again if they differ.
    let sums: { n: number; ids: number; vs: number } | undefined;
    if (q.check) {
      const [c] = (await db.execute(sql`select count(*)::int as n, coalesce(sum(('x' || substr(i.id::text, 1, 8))::bit(32)::bigint), 0)::text as ids,
        coalesce(sum((extract(epoch from i.updated_at) * 1000)::bigint % 1000000007), 0)::text as vs from items i where i.space_id in (${spaceList}) and i.deleted_at is null`)).rows as any[];
      sums = { n: c.n, ids: Number(c.ids), vs: Number(c.vs) };
    }
    return { now, key, full, sums, items: rows.rows.map((r: any) => ({ ...r, added: Number(r.added), v: Number(r.v), bOrig: Number(r.bOrig), bDisp: Number(r.bDisp), bThumb: Number(r.bThumb) })), removed, places, persons: names };
  });

  /** One item with the parts the grid does not need: comments, the edit recipe, its copies. */
  app.get('/api/items/:id', async (req) => {
    const it = await itemFor(ctx, req, (req.params as any).id);
    const cs = await db.select().from(schema.comments).where(eq(schema.comments.itemId, it.id)).orderBy(asc(schema.comments.createdAt));
    return {
      id: it.id, recipe: it.recipe, bytesFull: it.bytesFull,
      keys: { orig: it.origKey, display: it.displayKey, thumb: it.thumbKey, full: it.fullKey },
      comments: cs.map((c) => ({ id: c.id, user: c.userId, text: c.body, t: c.createdAt.getTime() })),
    };
  });

  app.patch('/api/items/:id', async (req) => {
    needCap(req, 'tag');
    const it = await itemFor(ctx, req, (req.params as any).id);
    const b = z.object({
      title: z.string().max(300).optional(), desc: z.string().max(5000).optional(), series: z.string().max(120).nullable().optional(),
      lat: z.number().min(-90).max(90).nullable().optional(), lng: z.number().min(-180).max(180).nullable().optional(),
      d: z.string().regex(WALL).optional(),
    }).parse(req.body);
    const set: Partial<typeof items.$inferInsert> = { updatedAt: new Date() };
    if (b.title !== undefined) set.title = b.title;
    if (b.desc !== undefined) set.description = b.desc;
    if (b.series !== undefined) set.series = b.series || null;
    if (b.d) { set.takenAt = parseWall(b.d); set.dateSource = 'manual'; }
    if (b.lat !== undefined || b.lng !== undefined) {
      const lat = b.lat ?? null, lng = b.lng ?? null;
      if ((lat == null) !== (lng == null)) throw bad('A location needs both a latitude and a longitude.');
      set.lat = lat; set.lng = lng; Object.assign(set, await whereFor(ctx, lat, lng)); set.locationSource = lat == null ? null : 'manual';
    }
    await db.update(items).set(set).where(eq(items.id, it.id));
    // with a location there is nothing left to guess, and without one the workers may guess again
    if (set.lat !== undefined) { if (set.lat == null) await queueTasks(ctx, [it.id]); else await db.execute(sql`delete from ai_tasks where task = 'place' and status = 'queued' and item_id = ${it.id}::uuid`); }
    return { ok: true };
  });

  /**
   * Correct what a worker read from a picture. Whatever a person sets here is theirs from then on:
   * reading the picture again never overwrites it and never brings back a label they removed.
   */
  app.patch('/api/items/:id/ai', async (req) => {
    needCap(req, 'tag');
    const it = await itemFor(ctx, req, (req.params as any).id);
    const name = z.string().trim().toLowerCase().min(1).max(60);
    const b = z.object({
      caption: z.string().trim().max(2000).optional(),
      scene: z.string().refine((s) => (SCENES as string[]).includes(s), 'Choose a scene from the list.').nullable().optional(),
      add: z.array(name).max(20).optional(), remove: z.array(name).max(50).optional(),
    }).parse(req.body);
    const locked = new Set(it.aiLocked), set: Partial<typeof items.$inferInsert> = { updatedAt: new Date() };
    if (b.caption !== undefined) { set.aiCaption = b.caption.replace(/\s+/g, ' ') || null; locked.add('caption'); }
    if (b.scene !== undefined) { set.aiScene = b.scene; locked.add('scene'); }
    set.aiLocked = [...locked];
    await db.transaction(async (tx) => {
      if (b.remove?.length) await tx.insert(schema.itemLabels).values(b.remove.map((label) => ({ itemId: it.id, label, source: 'person', removed: true })))
        .onConflictDoUpdate({ target: [schema.itemLabels.itemId, schema.itemLabels.label], set: { removed: true } });
      if (b.add?.length) await tx.insert(schema.itemLabels).values(b.add.map((label) => ({ itemId: it.id, label, confidence: 1, source: 'person', removed: false })))
        .onConflictDoUpdate({ target: [schema.itemLabels.itemId, schema.itemLabels.label], set: { removed: false, source: 'person', confidence: 1 } });
      await tx.update(items).set(set).where(eq(items.id, it.id));
    });
    return { ok: true };
  });

  app.post('/api/items/:id/tags', async (req) => {
    needCap(req, 'tag');
    const it = await itemFor(ctx, req, (req.params as any).id);
    const b = z.object({ add: z.array(z.string()).max(50).optional(), remove: z.array(z.string()).max(50).optional() }).parse(req.body);
    if (b.add?.length) await setTags(ctx, [it.id], b.add, 'add');
    if (b.remove?.length) await setTags(ctx, [it.id], b.remove, 'remove');
    return { ok: true };
  });

  /** Anyone who can see an item can like it. */
  app.put('/api/items/:id/like', async (req) => {
    const it = await itemFor(ctx, req, (req.params as any).id);
    await db.insert(schema.likes).values({ itemId: it.id, userId: req.user!.id }).onConflictDoNothing();
    await touch(ctx, [it.id]);
    return { ok: true };
  });
  app.delete('/api/items/:id/like', async (req) => {
    const it = await itemFor(ctx, req, (req.params as any).id);
    await db.delete(schema.likes).where(and(eq(schema.likes.itemId, it.id), eq(schema.likes.userId, req.user!.id)));
    await touch(ctx, [it.id]);
    return { ok: true };
  });

  app.post('/api/items/:id/comments', async (req) => {
    const me = needCap(req, 'comment');
    const it = await itemFor(ctx, req, (req.params as any).id);
    const b = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body);
    const [c] = await db.insert(schema.comments).values({ itemId: it.id, userId: me.id, body: b.text }).returning();
    await touch(ctx, [it.id]);
    await logActivity(ctx, me, `commented on “${it.title || it.fileName}”`);
    return { id: c!.id, user: me.id, text: c!.body, t: c!.createdAt.getTime() };
  });
  app.delete('/api/comments/:id', async (req) => {
    const me = need(req);
    const [c] = await db.select().from(schema.comments).where(eq(schema.comments.id, uuid.parse((req.params as any).id)));
    if (!c) throw notFound();
    if (c.userId !== me.id && !me.caps.admin) throw forbidden('You can only delete your own comments.');
    await db.delete(schema.comments).where(eq(schema.comments.id, c.id));
    await touch(ctx, [c.itemId]);
    return { ok: true };
  });

  /** One action on many items at once. */
  app.post('/api/items/bulk', async (req) => {
    const me = need(req);
    const b = z.object({
      ids: z.array(uuid).min(1).max(5000), action: z.enum(['tag', 'untag', 'like', 'unlike', 'move', 'delete', 'locate', 'unlocate', 'shiftdate', 'setdate']), tags: z.array(z.string()).optional(), spaceId: uuid.optional(),
      minutes: z.number().int().min(-52_704_000).max(52_704_000).optional(), d: z.string().regex(WALL).optional(),
      lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), only: z.enum(['missing', 'all']).optional(),
    }).parse(req.body);
    const rows = await db.select({ id: items.id, spaceId: items.spaceId, lat: items.lat }).from(items).where(and(inArray(items.id, b.ids), isNull(items.deletedAt)));
    const mine = rows.filter((r) => me.spaceIds.includes(r.spaceId));
    let ids = mine.map((r) => r.id);
    if (!ids.length) return { ok: true, n: 0 };
    if (b.action === 'locate') {
      needCap(req, 'tag');
      if (b.lat == null || b.lng == null) throw bad('Choose a place on the map first.');
      // "missing" leaves alone whatever already has a location, so a camera's own GPS is never overwritten by accident.
      if (b.only !== 'all') ids = mine.filter((r) => r.lat == null).map((r) => r.id);
      if (ids.length) await db.update(items).set({ lat: b.lat, lng: b.lng, ...(await whereFor(ctx, b.lat, b.lng)), locationSource: 'manual', updatedAt: new Date() }).where(inArray(items.id, ids));
      if (ids.length) await db.execute(sql`delete from ai_tasks where task = 'place' and status = 'queued' and item_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`);
      if (ids.length) await logActivity(ctx, me, `set the location of ${ids.length} item${ids.length === 1 ? '' : 's'}`);
      return { ok: true, n: ids.length };
    }
    if (b.action === 'shiftdate') {
      needCap(req, 'tag');
      if (!b.minutes) throw bad('Say how far to move the dates.');
      // Plain arithmetic on the wall-clock time. The source stays what it was: a corrected camera date is still the camera's.
      await db.update(items).set({ takenAt: sql`${items.takenAt} + ${b.minutes} * interval '1 minute'`, updatedAt: new Date() }).where(inArray(items.id, ids));
      await logActivity(ctx, me, `moved the date of ${ids.length} item${ids.length === 1 ? '' : 's'} by ${b.minutes} minutes`);
      return { ok: true, n: ids.length };
    }
    if (b.action === 'setdate') {
      needCap(req, 'tag');
      if (!b.d) throw bad('Choose a date and time.');
      await db.update(items).set({ takenAt: parseWall(b.d), dateSource: 'manual', updatedAt: new Date() }).where(inArray(items.id, ids));
      await logActivity(ctx, me, `set the date of ${ids.length} item${ids.length === 1 ? '' : 's'}`);
      return { ok: true, n: ids.length };
    }
    if (b.action === 'unlocate') {
      needCap(req, 'tag');
      ids = mine.filter((r) => r.lat != null).map((r) => r.id);
      if (ids.length) await db.update(items).set({ lat: null, lng: null, placeId: null, spot: null, spotKind: null, locationSource: null, updatedAt: new Date() }).where(inArray(items.id, ids));
      if (ids.length) await queueTasks(ctx, ids);
      if (ids.length) await logActivity(ctx, me, `removed the location of ${ids.length} item${ids.length === 1 ? '' : 's'}`);
      return { ok: true, n: ids.length };
    }
    if (b.action === 'tag' || b.action === 'untag') { needCap(req, 'tag'); await setTags(ctx, ids, b.tags ?? [], b.action === 'tag' ? 'add' : 'remove'); }
    else if (b.action === 'like') { await db.insert(schema.likes).values(ids.map((itemId) => ({ itemId, userId: me.id }))).onConflictDoNothing(); await touch(ctx, ids); }
    else if (b.action === 'unlike') { await db.delete(schema.likes).where(and(inArray(schema.likes.itemId, ids), eq(schema.likes.userId, me.id))); await touch(ctx, ids); }
    else if (b.action === 'move') {
      needCap(req, 'admin');
      if (!b.spaceId || !me.spaceIds.includes(b.spaceId)) throw bad('Pick a space to move to.');
      await db.update(items).set({ spaceId: b.spaceId, updatedAt: new Date() }).where(inArray(items.id, ids));
      await facesMoved(ctx, ids, b.spaceId);
      await queueTasks(ctx, ids);
      await logActivity(ctx, me, `moved ${ids.length} item${ids.length === 1 ? '' : 's'} to another space`);
    } else if (b.action === 'delete') {
      needCap(req, 'del');
      // Deleted items go to the trash first. Their files are only removed when the trash is emptied.
      await db.update(items).set({ deletedAt: new Date(), updatedAt: new Date() }).where(inArray(items.id, ids));
      await logActivity(ctx, me, `moved ${ids.length} item${ids.length === 1 ? '' : 's'} to the trash`);
    }
    return { ok: true, n: ids.length };
  });

  /** Towns and cities by name, from the data that ships with the app. Nothing is asked of an outside service. */
  app.get('/api/places/search', async (req) => {
    need(req);
    const q = z.object({ q: z.string().max(80).default('') }).parse(req.query);
    return { places: searchPlaces(q.q) };
  });

  /* ---------- uploads ---------- */

  app.post('/api/upload', async (req) => {
    const me = needCap(req, 'upload');
    return receiveUpload(ctx, req, me.id, (fields) => { const spaceId = uuid.parse(fields.space); needSpace(req, spaceId); return spaceId; });
  });

  /** Save an edit as a new item. The original is never changed. */
  app.post('/api/items/:id/copies', async (req) => {
    const me = needCap(req, 'edit');
    const src = await itemFor(ctx, req, (req.params as any).id);
    if (src.kind !== 'photo') throw bad('Only photos can be edited.');
    const num = z.number().finite();
    const five = z.array(num.min(0).max(1)).length(5);
    const recipe = z.object({
      v: z.union([z.literal(1), z.literal(2)]).optional(), curves: z.object({ r: five, g: five, b: five }).optional(), lut: z.string().uuid().optional(),
      adj: z.record(z.string(), num.min(-360).max(360)),
      geo: z.object({ rot: z.number().int().min(0).max(3), flipH: z.boolean(), flipV: z.boolean(), straighten: num.min(-45).max(45), crop: z.object({ x: num.min(0).max(1), y: num.min(0).max(1), w: num.min(0.01).max(1), h: num.min(0.01).max(1) }), aspect: z.string().max(20).optional() }),
      curve: z.array(num.min(0).max(1)).length(5), look: z.string().max(40).optional(),
    }).parse((req.body as any)?.recipe);
    if (recipeIsEmpty(recipe)) throw bad('Nothing was changed, so there is nothing to save.');
    if (recipe.lut && (recipe.v !== 2 || !(await lutExists(ctx, recipe.lut)))) throw bad('The look this edit uses is gone. Choose another look and save again.');
    // A copy of a copy starts again from the first original, so quality never degrades.
    const root = src.copyOf ? await getItem(ctx, src.copyOf).catch(() => src) : src;
    const n = (await db.select({ n: sql<number>`count(*)::int` }).from(items).where(eq(items.copyOf, root.id)))[0]!.n + 1;
    const base = root.fileName.replace(/\.\w+$/, '');
    const id = crypto.randomUUID();
    const fileName = `${base}-edit${n > 1 ? n : ''}.jpg`;
    const keys = keysFor(id, root.takenAt, fileName);
    await db.insert(items).values({
      id, spaceId: root.spaceId, kind: 'photo', fileName, mime: 'image/jpeg', sha256: `pending-${id}`, takenAt: root.takenAt, addedBy: me.id,
      title: (root.title || base) + (n > 1 ? ` (edit ${n})` : ' (edit)'), description: '', lat: root.lat, lng: root.lng, placeId: root.placeId, spot: root.spot, spotKind: root.spotKind, locationSource: root.locationSource, dateSource: root.dateSource,
      camera: root.camera, lens: root.lens, iso: root.iso, shutter: root.shutter, fnum: root.fnum, focal: root.focal, series: root.series,
      copyOf: root.id, recipe, origKey: keys.orig, width: root.width, height: root.height, palette: root.palette,
    });
    await db.insert(schema.jobs).values({ type: 'render', itemId: id, payload: { sourceId: root.id } });
    ctx.kick();
    await logActivity(ctx, me, `saved an edited copy of “${root.title || root.fileName}”`);
    return { id };
  });

  /* ---------- files ---------- */

  const TYPES = { thumb: 'image/webp', display: 'image/webp', full: 'image/webp' } as const;
  app.get('/api/files/:id/:kind', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id, kind } = req.params as { id: string; kind: string };
    const q = req.query as { download?: string; proxy?: string };
    // Trashed items are gone for everyone, except that an owner looking at the trash sees their thumbnails and display copies.
    const [it] = await db.select().from(items).where(eq(items.id, uuid.parse(id)));
    if (!it) throw notFound('That item is gone.');
    if (it.deletedAt) { need(req); if (!req.user!.caps.admin || (kind !== 'thumb' && kind !== 'display')) throw notFound('That item is gone.'); }
    else needSpace(req, it.spaceId);
    let key: string | null, type: string;
    if (kind === 'thumb') { key = it.thumbKey; type = TYPES.thumb; }
    else if (kind === 'display') { key = it.displayKey; type = TYPES.display; }
    else if (kind === 'full') { key = it.fullKey ?? it.origKey; type = it.fullKey ? TYPES.full : it.mime; }
    else if (kind === 'orig') { key = it.origKey; type = it.mime; }
    // what a video element plays: the copy made for browsers when there is one, the original when there is not
    else if (kind === 'play') { key = it.playKey ?? it.origKey; type = it.playKey ? 'video/mp4' : it.mime; }
    else throw notFound();
    if (!key) throw new HttpError(404, 'This copy is not ready yet.');
    const download = q.download === '1';
    if (download) needCap(req, 'download');
    return sendStored(ctx, req, reply, key, type, download ? it.fileName : undefined, q.proxy === '1');
  });

  /* ---------- trash ---------- */

  app.get('/api/trash', async (req) => {
    needCap(req, 'admin');
    const rows = await db.select({
      id: items.id, fileName: items.fileName, title: items.title, kind: items.kind, status: items.status, w: items.width, h: items.height, palette: items.palette,
      deletedAt: items.deletedAt, bytes: sql<number>`(${items.bytesOrig} + ${items.bytesDisplay} + ${items.bytesThumb} + ${items.bytesFull} + ${items.bytesPlay})::float8`,
      sha: items.sha256, copyOf: items.copyOf,
    }).from(items).where(isNotNull(items.deletedAt)).orderBy(desc(items.deletedAt));
    // "twin": the same file is already back in the library, so this one cannot be put back (see restoreTrash).
    const shas = [...new Set(rows.filter((r) => !r.copyOf).map((r) => r.sha))];
    const back = new Set<string>();
    for (let i = 0; i < shas.length; i += 2000) for (const r of await db.select({ sha: items.sha256 }).from(items).where(and(inArray(items.sha256, shas.slice(i, i + 2000)), isNull(items.deletedAt), isNull(items.copyOf)))) back.add(r.sha);
    return { days: cfg.TRASH_DAYS, items: rows.map(({ sha, copyOf, ...r }) => ({ ...r, deletedAt: r.deletedAt!.getTime(), twin: !copyOf && back.has(sha) })) };
  });
  const someIds = z.object({ ids: z.array(uuid).min(1).max(5000).optional() });
  app.post('/api/trash/restore', async (req) => {
    needCap(req, 'admin');
    const b = someIds.parse(req.body ?? {});
    return { ok: true, ...(await restoreTrash(ctx, b.ids)) };
  });
  app.post('/api/trash/empty', async (req) => {
    const me = needCap(req, 'admin');
    const b = someIds.parse(req.body ?? {});
    const r = await emptyTrash(ctx, { ids: b.ids });
    await logActivity(ctx, me, b.ids ? `deleted ${r.n} item${r.n === 1 ? '' : 's'} from the trash for good` : `emptied the trash (${r.n} item${r.n === 1 ? '' : 's'})`);
    return { ok: true, n: r.n, bytes: r.bytes };
  });
}

export type { SessionUser };
