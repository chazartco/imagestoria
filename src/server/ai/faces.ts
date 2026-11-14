import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { schema } from '../db/index.js';
import { ResultError } from './embed.js';

/**
 * People in the pictures. A worker posts every face it finds with its place in the picture, a quality score and an
 * embedding: numbers that are close for two pictures of the same face. Everything else happens here.
 *
 *  1. Faces nobody has named are grouped by likeness, for a person to name a whole group at once.
 *  2. A new face close to someone already named becomes a suggestion to confirm or reject.
 *  3. With automatic naming on, a face is named without asking only when the person has enough confirmed faces,
 *     the likeness is above a strict threshold, and the next closest person is clearly further away.
 *
 * Embeddings are biometric data. They are stored in the faces table and nowhere else, they are never sent to a browser
 * or written to a log, and they are deleted with the item, with the person, or all at once from the settings page.
 * People belong to one space. A person named in one space is never suggested in another.
 */

const { faces, persons, faceRejections, items, spaces } = schema;
type Tx = Parameters<Parameters<Ctx['db']['transaction']>[0]>[0];
type Db = Ctx['db'] | Tx;

export interface AutoSetting { on: boolean; threshold: number }
export async function autoSetting(ctx: Ctx, db: Db = ctx.db): Promise<AutoSetting> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'faces:auto'));
  const v = (row?.value ?? {}) as Partial<AutoSetting>;
  return { on: v.on === true, threshold: typeof v.threshold === 'number' ? v.threshold : ctx.cfg.FACE_AUTO };
}

/* ---------- the faces of one space, in memory while they are being compared ---------- */

export interface Face { id: string; item: string; v: Float32Array; person: string | null; status: string; quality: number; model: string; suggested: string | null }
const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

export async function loadFaces(db: Db, spaceId: string): Promise<Face[]> {
  const rows = await db.execute(sql`
    select f.id, f.item_id as item, f.vec, f.person_id as person, f.status, f.quality, f.model, f.suggested_id as suggested
    from faces f join items i on i.id = f.item_id where i.space_id = ${spaceId}::uuid and i.deleted_at is null`);
  return (rows.rows as any[]).map((r) => {
    const b: Buffer = r.vec, v = new Float32Array(b.length / 4);
    for (let i = 0; i < v.length; i++) v[i] = b.readFloatLE(i * 4);
    return { id: r.id, item: r.item, v, person: r.person, status: r.status, quality: r.quality, model: r.model, suggested: r.suggested };
  });
}

/**
 * Leader clustering: each face joins the first group whose middle it is close enough to, or starts a group.
 * The best likenesses go first, so the middles are set by good faces and not by blurred ones.
 */
export function cluster(list: Face[], near: number) {
  const groups: { mid: Float32Array; sum: Float32Array; faces: Face[]; model: string }[] = [];
  for (const f of [...list].sort((a, b) => b.quality - a.quality)) {
    let best = -1, top = near;
    for (let g = 0; g < groups.length; g++) { if (groups[g]!.model !== f.model) continue; const s = dot(groups[g]!.mid, f.v); if (s >= top) { top = s; best = g; } }
    if (best < 0) { groups.push({ mid: f.v, sum: Float32Array.from(f.v), faces: [f], model: f.model }); continue; }
    const g = groups[best]!; g.faces.push(f);
    let n = 0; for (let i = 0; i < g.sum.length; i++) { g.sum[i]! += f.v[i]!; n += g.sum[i]! * g.sum[i]!; }
    n = Math.sqrt(n) || 1; g.mid = g.sum.map((x) => x / n);
  }
  return groups;
}

/**
 * What a person looks like: a handful of faces from each of the distinct looks they have had. A child at three and at
 * thirteen is one person with two looks, and both stay represented however many pictures there are of the later one.
 */
export function references(list: Face[], cfg: Ctx['cfg']) {
  const by = new Map<string, Face[]>();
  for (const f of list) if (f.person && f.status === 'confirmed') by.set(f.person, [...(by.get(f.person) ?? []), f]);
  const out = new Map<string, { refs: Face[]; looks: number; confirmed: number }>();
  for (const [p, fs] of by) { const looks = cluster(fs, cfg.FACE_LOOK); out.set(p, { refs: looks.flatMap((g) => g.faces.slice(0, 8)), looks: looks.length, confirmed: fs.length }); }
  return out;
}

/** The people a face is most like, closest first. `skip` leaves one face out of the references: the face itself, when checking the numbers. */
export function nearest(f: Face, refs: ReturnType<typeof references>, rejected: Set<string> | undefined, skip?: string) {
  const out: { person: string; score: number }[] = [];
  for (const [person, r] of refs) {
    if (rejected?.has(person)) continue;
    let best = -1;
    for (const o of r.refs) if (o.id !== skip && o.model === f.model) { const s = dot(f.v, o.v); if (s > best) best = s; }
    if (best > -1) out.push({ person, score: best });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Look again at every face in a space that nobody has decided on, after a new picture was read or a person answered a
 * question. A face becomes automatic, suggested, or stays unsorted.
 */
export async function matchFaces(ctx: Ctx, db: Db, spaceId: string) {
  const { cfg } = ctx, all = await loadFaces(db, spaceId), refs = references(all, cfg), auto = await autoSetting(ctx, db);
  const open = all.filter((f) => f.status === 'unsorted' || f.status === 'suggested');
  if (!open.length) return;
  const rej = new Map<string, Set<string>>();
  for (const r of await db.select().from(faceRejections).where(inArray(faceRejections.faceId, open.map((f) => f.id)))) rej.set(r.faceId, (rej.get(r.faceId) ?? new Set()).add(r.personId));
  const strict = new Map((await db.select({ id: persons.id, strict: persons.strict }).from(persons).where(eq(persons.spaceId, spaceId))).map((p) => [p.id, p.strict]));
  const touched = new Set<string>();
  // a person is in a picture once: whoever is already named in it is not offered for another face there
  const inItem = new Map<string, Set<string>>();
  for (const f of all) if (f.person && (f.status === 'confirmed' || f.status === 'auto')) inItem.set(f.item, (inItem.get(f.item) ?? new Set()).add(f.person));
  for (const f of open) {
    const taken = inItem.get(f.item);
    const near = nearest(f, refs, rej.get(f.id)).filter((n) => !taken?.has(n.person)), a = near[0], b = near[1];
    let status = 'unsorted', person: string | null = null, suggested: string | null = null, confidence: number | null = null;
    if (a && a.score >= cfg.FACE_SUGGEST) {
      status = 'suggested'; suggested = a.person; confidence = a.score;
      const need = auto.threshold + (strict.get(a.person) ?? 0) * cfg.FACE_STRICT_STEP;
      if (auto.on && refs.get(a.person)!.confirmed >= cfg.FACE_AUTO_MIN_CONFIRMED && a.score >= need && a.score - (b?.score ?? 0) >= cfg.FACE_GAP) { status = 'auto'; person = a.person; suggested = null; inItem.set(f.item, (taken ?? new Set()).add(a.person)); }
    }
    if (status === f.status && suggested === f.suggested && person === f.person) continue;
    await db.update(faces).set({ status, personId: person, suggestedId: suggested, confidence: confidence == null ? null : Math.round(confidence * 1000) / 1000, decidedAt: status === 'auto' ? new Date() : null, decidedBy: null }).where(eq(faces.id, f.id));
    if (status === 'auto' || f.status === 'auto') touched.add(f.item);
  }
  if (touched.size) await db.update(items).set({ updatedAt: new Date() }).where(inArray(items.id, [...touched]));
}

/**
 * "How often would automatic naming have been right?" Each confirmed face is taken out in turn and named again from
 * the others, at several thresholds. The owner reads the table and picks the threshold.
 */
export function numbers(all: Face[], cfg: Ctx['cfg']) {
  const refs = references(all, cfg), known = all.filter((f) => f.person && f.status === 'confirmed');
  const tries = known.map((f) => {
    const near = nearest(f, refs, undefined, f.id), a = near[0], b = near[1];
    // with this face taken out, does its person still have enough confirmed faces to be named automatically?
    const enough = a ? refs.get(a.person)!.confirmed - (a.person === f.person ? 1 : 0) >= cfg.FACE_AUTO_MIN_CONFIRMED : false;
    return { right: a?.person === f.person, score: a?.score ?? 0, gap: (a?.score ?? 0) - (b?.score ?? 0), enough };
  });
  const rows = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75].map((t) => {
    let right = 0, wrong = 0;
    for (const x of tries) if (x.enough && x.score >= t && x.gap >= cfg.FACE_GAP) { if (x.right) right++; else wrong++; }
    return { threshold: t, right, wrong, asked: tries.length - right - wrong };
  });
  return { faces: tries.length, people: refs.size, minConfirmed: cfg.FACE_AUTO_MIN_CONFIRMED, gap: cfg.FACE_GAP, rows };
}

/* ---------- what a worker hands in ---------- */

const shape = z.object({
  w: z.number().positive(), h: z.number().positive(),
  faces: z.array(z.object({
    box: z.array(z.number().min(0).max(1)).length(4), score: z.number().min(0).max(1), quality: z.number().min(0).max(1),
    vector: z.string().min(16).max(20000),
  })).max(100),
});
const overlap = (a: number[], b: number[]) => {
  const x1 = Math.max(a[0]!, b[0]!), y1 = Math.max(a[1]!, b[1]!), x2 = Math.min(a[0]! + a[2]!, b[0]! + b[2]!), y2 = Math.min(a[1]! + a[3]!, b[1]! + b[3]!);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1), union = a[2]! * a[3]! + b[2]! * b[3]! - inter;
  return union > 0 ? inter / union : 0;
};

/**
 * Two boxes on the same face: they share much of their area, or most of the smaller one is inside the other. A detector
 * that looks at a picture whole and again in parts finds a face once whole and once cut by the edge of a part.
 */
export const sameSpot = (a: number[], b: number[]) => {
  const x1 = Math.max(a[0]!, b[0]!), y1 = Math.max(a[1]!, b[1]!), x2 = Math.min(a[0]! + a[2]!, b[0]! + b[2]!), y2 = Math.min(a[1]! + a[3]!, b[1]! + b[3]!);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1), small = Math.min(a[2]! * a[3]!, b[2]! * b[3]!), union = a[2]! * a[3]! + b[2]! * b[3]! - inter;
  return inter > 0 && (inter / union >= 0.4 || inter / small >= 0.6);
};
const RANK: Record<string, number> = { confirmed: 5, auto: 4, suggested: 3, unsorted: 2, also: 1, ignored: 1, notface: 1 };

/**
 * One face is one row, and a person is in a picture once.
 *
 *  - Two rows on the same spot are one face found twice. The better one stays (a person's answer first, then quality)
 *    and the other is deleted. Two different named people on one spot are left alone: faces do sit close together.
 *  - Two faces apart from each other with the same name (a mirror, a picture on the wall, the same face found in two
 *    places) are one tag. The one already there keeps the name. The other is remembered as that person with the status
 *    "also": it carries no tag, it is not asked about again, and who it is stays in suggested_id.
 *
 * `prefer` are the faces a person has just named. Where the person was already tagged in the picture, the tag stays
 * where it was and the face just named becomes the "also" one.
 */
export async function tidyFaces(db: Db, opts: { items?: string[]; prefer?: string[] } = {}) {
  if (opts.items && !opts.items.length) return { same: 0, apart: 0, items: 0 };
  const where = opts.items ? sql`where item_id in (${sql.join([...new Set(opts.items)].map((i) => sql`${i}::uuid`), sql`, `)})` : sql``;
  const rows = (await db.execute(sql`select id, item_id as item, x, y, w, h, quality, status, person_id as person from faces ${where}`)).rows as { id: string; item: string; x: number; y: number; w: number; h: number; quality: number; status: string; person: string | null }[];
  const prefer = new Set(opts.prefer ?? []), by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.item, [...(by.get(r.item) ?? []), r]);
  const drop: string[] = [], back: { id: string; person: string }[] = [], touched = new Set<string>();
  for (const [item, list] of by) {
    if (list.length < 2) continue;
    list.sort((a, b) => (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0) || Number(prefer.has(a.id)) - Number(prefer.has(b.id)) || b.quality - a.quality || b.w * b.h - a.w * a.h);
    const kept: typeof rows = [];
    for (const f of list) {
      // the name goes first, so a face that gives it up is then judged as the unnamed face it now is
      const was = f.person; if (was && kept.some((k) => k.person === was)) f.person = null;
      if (kept.some((k) => sameSpot([f.x, f.y, f.w, f.h], [k.x, k.y, k.w, k.h]) && !(f.person && k.person && f.person !== k.person))) { drop.push(f.id); touched.add(item); continue; }
      if (was && !f.person) { back.push({ id: f.id, person: was }); touched.add(item); }
      kept.push(f);
    }
  }
  const list = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
  if (drop.length) {
    await db.execute(sql`update persons set cover_face_id = null where cover_face_id in (${list(drop)})`);
    await db.delete(faces).where(inArray(faces.id, drop));
  }
  for (const b of back) await db.update(faces).set({ personId: null, suggestedId: b.person, confidence: null, status: 'also' }).where(eq(faces.id, b.id));
  if (touched.size) await db.update(items).set({ updatedAt: new Date() }).where(inArray(items.id, [...touched]));
  return { same: drop.length, apart: back.length, items: touched.size };
}

/**
 * Store the faces of one picture. When a picture is read again, a face that is still where it was keeps whatever a person
 * decided about it. A face a person decided on is never dropped because a newer model did not find it.
 */
export async function applyFaces(ctx: Ctx, tx: Tx, itemId: string, data: unknown, model: { name: string; version: string }) {
  const d = shape.parse(data);
  // a face found twice by the worker is one face: the better likeness stays
  d.faces = [...d.faces].sort((a, b) => b.quality - a.quality || b.score - a.score).reduce<typeof d.faces>((keep, f) => (keep.some((k) => sameSpot(f.box, k.box)) ? keep : [...keep, f]), []);
  const [it] = await tx.select({ space: items.spaceId, on: spaces.people }).from(items).innerJoin(spaces, eq(spaces.id, items.spaceId)).where(eq(items.id, itemId));
  if (!it?.on) throw new ResultError('People recognition is off for the space this picture is in.');
  const fresh = d.faces.map((f) => {
    const buf = Buffer.from(f.vector, 'base64');
    if (buf.length < 64 * 4 || buf.length % 4) throw new ResultError('A face embedding is not a list of 32-bit numbers.');
    const v = new Float32Array(buf.length / 4); let n = 0;
    for (let i = 0; i < v.length; i++) { const x = buf.readFloatLE(i * 4); if (!Number.isFinite(x)) throw new ResultError('A face embedding holds something that is not a number.'); v[i] = x; n += x * x; }
    n = Math.sqrt(n); if (!(n > 1e-6)) throw new ResultError('A face embedding is all zeros.');
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return { ...f, vec: Buffer.from(v.buffer, v.byteOffset, v.byteLength) };
  });
  const old = await tx.select().from(faces).where(eq(faces.itemId, itemId));
  const used = new Set<string>(), name = `${model.name}`;
  for (const f of fresh) {
    const same = old.filter((o) => !used.has(o.id)).map((o) => [o, overlap(f.box, [o.x, o.y, o.w, o.h])] as const).sort((a, b) => b[1] - a[1])[0];
    const set = { x: f.box[0]!, y: f.box[1]!, w: f.box[2]!, h: f.box[3]!, score: f.score, quality: f.quality, vec: f.vec, model: name };
    if (same && same[1] >= 0.5) { used.add(same[0].id); await tx.update(faces).set(set).where(eq(faces.id, same[0].id)); }
    else await tx.insert(faces).values({ itemId, ...set });
  }
  const gone = old.filter((o) => !used.has(o.id) && (o.status === 'unsorted' || o.status === 'suggested' || o.status === 'auto')).map((o) => o.id);
  if (gone.length) await tx.delete(faces).where(inArray(faces.id, gone));
  await tidyFaces(tx, { items: [itemId] });   // a new box may sit on a face a person already decided on
  await matchFaces(ctx, tx, it.space);
}

/* ---------- switching recognition on and off ---------- */

/** Delete every trace of faces and people in one space: the embeddings, the names, the answers, and the work waiting. */
export async function forgetSpace(ctx: Ctx, spaceId: string) {
  await ctx.db.transaction(async (tx) => {
    const ids = sql`(select id from items where space_id = ${spaceId}::uuid)`;
    await tx.execute(sql`update items set updated_at = now() where id in (select item_id from faces where item_id in ${ids} and person_id is not null)`);
    await tx.execute(sql`delete from faces where item_id in ${ids}`);
    await tx.delete(persons).where(eq(persons.spaceId, spaceId));
    await tx.execute(sql`delete from ai_tasks where task = 'faces' and item_id in ${ids}`);
  });
}

/** An item that moves to another space leaves its people behind: they belong to the space it came from. */
export async function facesMoved(ctx: Ctx, itemIds: string[], toSpace: string) {
  if (!itemIds.length) return;
  const [s] = await ctx.db.select({ on: spaces.people }).from(spaces).where(eq(spaces.id, toSpace));
  if (!s?.on) { await ctx.db.delete(faces).where(inArray(faces.itemId, itemIds)); await ctx.db.execute(sql`delete from ai_tasks where task = 'faces' and item_id in (${sql.join(itemIds.map((i) => sql`${i}::uuid`), sql`, `)})`); return; }
  await ctx.db.update(faces).set({ personId: null, suggestedId: null, confidence: null, status: 'unsorted', decidedBy: null, decidedAt: null }).where(and(inArray(faces.itemId, itemIds), inArray(faces.status, ['confirmed', 'auto', 'suggested', 'also'])));
  await ctx.db.execute(sql`delete from face_rejections where face_id in (select id from faces where item_id in (${sql.join(itemIds.map((i) => sql`${i}::uuid`), sql`, `)}))`);
  await matchFaces(ctx, ctx.db, toSpace);
}
