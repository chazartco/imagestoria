import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { autoSetting, cluster, forgetSpace, loadFaces, matchFaces, numbers, references, tidyFaces } from '../ai/faces.js';
import { queueTasks } from '../ai/tasks.js';
import { logActivity, need, needCap, needSpace, type SessionUser } from '../auth/core.js';
import { type Ctx, HttpError, bad, forbidden, notFound } from '../context.js';
import { schema } from '../db/index.js';

const uuid = z.string().uuid();
const { faces, persons, faceRejections, items, spaces } = schema;
const ids = z.array(uuid).min(1).max(2000);

/** Who may see and name people: the owner and editors. Viewers and commenters never see a name, a face box or the People page. */
export const seesPeople = (u: SessionUser) => u.role === 'owner' || u.role === 'editor';
/** The spaces in which this person sees people: the ones they can open, where recognition is on. */
export async function peopleSpaces(ctx: Ctx, u: SessionUser) {
  if (!seesPeople(u) || !u.spaceIds.length) return [];
  return (await ctx.db.select({ id: spaces.id }).from(spaces).where(and(inArray(spaces.id, u.spaceIds), eq(spaces.people, true)))).map((s) => s.id);
}

export function registerFaces(app: FastifyInstance, ctx: Ctx) {
  const { db, cfg } = ctx;

  async function needPeople(req: FastifyRequest, spaceId: string) {
    const u = needSpace(req, spaceId);
    if (!seesPeople(u)) throw forbidden('Only the owner and editors can see people.');
    const [s] = await db.select().from(spaces).where(eq(spaces.id, spaceId));
    if (!s) throw notFound();
    if (!s.people) throw new HttpError(409, 'People recognition is off for this space.');
    return u;
  }
  /** Load faces by id, check they are all in one space this person may name people in, and return them. */
  async function facesFor(req: FastifyRequest, faceIds: string[]) {
    const rows = await db.select({ f: faces, space: items.spaceId }).from(faces).innerJoin(items, eq(items.id, faces.itemId)).where(inArray(faces.id, faceIds));
    if (rows.length !== new Set(faceIds).size) throw notFound('One of those faces is gone.');
    const space = rows[0]!.space;
    if (rows.some((r) => r.space !== space)) throw bad('Those faces are in different spaces.');
    const me = await needPeople(req, space);
    return { me, space, rows: rows.map((r) => r.f) };
  }
  const touch = (itemIds: string[]) => (itemIds.length ? db.update(items).set({ updatedAt: new Date() }).where(inArray(items.id, [...new Set(itemIds)])) : Promise.resolve());

  /** Everything the People page shows for one space. Faces are named by id only: no embedding ever leaves the server. */
  app.get('/api/faces/overview', async (req) => {
    const q = z.object({ space: uuid }).parse(req.query);
    const me = needSpace(req, q.space);
    if (!seesPeople(me)) throw forbidden('Only the owner and editors can see people.');
    const [s] = await db.select().from(spaces).where(eq(spaces.id, q.space));
    if (!s) throw notFound();
    const auto = await autoSetting(ctx);
    const settings = { auto: auto.on, threshold: auto.threshold, minConfirmed: cfg.FACE_AUTO_MIN_CONFIRMED, mayAdmin: me.caps.admin };
    if (!s.people) return { on: false, ...settings, people: [], groups: [], singles: [], counts: null };
    const all = await loadFaces(db, q.space), refs = references(all, cfg);
    const ps = await db.select().from(persons).where(eq(persons.spaceId, q.space)).orderBy(asc(persons.name));
    const count = (f: (x: (typeof all)[number]) => boolean) => all.filter(f).length;
    const open = all.filter((f) => f.status === 'unsorted' || f.status === 'suggested');
    const groups = cluster(open, cfg.FACE_CLUSTER).sort((a, b) => b.faces.length - a.faces.length);
    const slim = (f: (typeof all)[number]) => ({ id: f.id, item: f.item });
    const [wait] = (await db.execute(sql`select count(*)::int as n from ai_tasks t join items i on i.id = t.item_id where t.task = 'faces' and t.status in ('queued', 'claimed') and i.space_id = ${q.space}::uuid and i.deleted_at is null`)).rows as { n: number }[];
    return {
      on: true, ...settings,
      counts: { faces: all.length, named: count((f) => f.status === 'confirmed'), auto: count((f) => f.status === 'auto'), suggested: count((f) => f.status === 'suggested'), unsorted: open.length, ignored: count((f) => f.status === 'ignored' || f.status === 'notface' || f.status === 'also'), waiting: wait?.n ?? 0 },
      people: ps.map((p) => {
        const mine = all.filter((f) => f.person === p.id), best = [...mine].sort((a, b) => b.quality - a.quality)[0];
        return { id: p.id, name: p.name, n: mine.length, auto: mine.filter((f) => f.status === 'auto').length, cover: mine.some((f) => f.id === p.coverFaceId) ? p.coverFaceId : best?.id ?? null, looks: refs.get(p.id)?.looks ?? 0, strict: p.strict };
      }),
      groups: groups.filter((g) => g.faces.length > 1).slice(0, 80).map((g) => ({ n: g.faces.length, faces: g.faces.slice(0, 40).map(slim) })),
      singles: groups.filter((g) => g.faces.length === 1).slice(0, 120).map((g) => slim(g.faces[0]!)),
    };
  });

  /** Suggestions waiting for a yes or no, surest first, and the names given automatically, newest first. */
  app.get('/api/faces/review', async (req) => {
    const q = z.object({ space: uuid }).parse(req.query);
    await needPeople(req, q.space);
    const rows = await db.execute(sql`
      select f.id, f.item_id as item, f.status, coalesce(f.person_id, f.suggested_id) as person, f.confidence as score, (extract(epoch from f.decided_at) * 1000)::bigint as at
      from faces f join items i on i.id = f.item_id
      where i.space_id = ${q.space}::uuid and i.deleted_at is null and f.status in ('suggested', 'auto')
      order by f.status, case when f.status = 'auto' then extract(epoch from f.decided_at) end desc nulls last, f.confidence desc nulls last limit 600`);
    const list = (rows.rows as any[]).map((r) => ({ id: r.id, item: r.item, person: r.person, score: r.score, at: r.at == null ? null : Number(r.at), status: r.status }));
    return { suggested: list.filter((r) => r.status === 'suggested'), auto: list.filter((r) => r.status === 'auto') };
  });

  /** How often automatic naming would have been right on the faces already confirmed, at several thresholds. */
  app.get('/api/faces/numbers', async (req) => {
    const q = z.object({ space: uuid }).parse(req.query);
    await needPeople(req, q.space);
    return numbers(await loadFaces(db, q.space), cfg);
  });

  /**
   * One face, cut from the picture with a little room around it, so a person can say who it is.
   * It keeps the shape of the face's own box. This is a detail of a picture, as the editor's magnifier is, not the picture.
   */
  app.get('/api/faces/:id/crop', async (req, reply) => {
    const [row] = await db.select({ f: faces, it: items }).from(faces).innerJoin(items, eq(items.id, faces.itemId)).where(eq(faces.id, uuid.parse((req.params as any).id)));
    if (!row || row.it.deletedAt) throw notFound('That face is gone.');
    await needPeople(req, row.it.spaceId);
    if (!row.it.displayKey) throw new HttpError(404, 'This copy is not ready yet.');
    const src = await ctx.storage.open(row.it.displayKey), chunks: Buffer[] = [];
    for await (const c of src.stream) chunks.push(c as Buffer);
    const img = sharp(Buffer.concat(chunks)), meta = await img.metadata(), W = meta.width!, H = meta.height!, f = row.f, pad = 0.35;
    const x = Math.max(0, Math.round((f.x - f.w * pad) * W)), y = Math.max(0, Math.round((f.y - f.h * pad) * H));
    const w = Math.max(1, Math.min(W - x, Math.round(f.w * (1 + 2 * pad) * W))), h = Math.max(1, Math.min(H - y, Math.round(f.h * (1 + 2 * pad) * H)));
    const out = await img.extract({ left: x, top: y, width: w, height: h }).resize({ height: 200, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    return reply.header('content-type', 'image/webp').header('cache-control', 'private, max-age=86400').header('x-content-type-options', 'nosniff').send(out);
  });

  /** The faces in one picture, for the viewer: where each is and who it is. Empty for anyone who may not see people. */
  app.get('/api/items/:id/faces', async (req) => {
    const me = need(req), id = uuid.parse((req.params as any).id);
    const [it] = await db.select({ space: items.spaceId, on: spaces.people, deleted: items.deletedAt }).from(items).innerJoin(spaces, eq(spaces.id, items.spaceId)).where(eq(items.id, id));
    if (!it || it.deleted) throw notFound('That item is gone.');
    needSpace(req, it.space);
    if (!it.on || !seesPeople(me)) return { faces: [] };
    const rows = await db.select().from(faces).where(eq(faces.itemId, id)).orderBy(asc(faces.x));
    return { faces: rows.filter((f) => f.status !== 'notface' && f.status !== 'ignored' && f.status !== 'also').map((f) => ({ id: f.id, box: [f.x, f.y, f.w, f.h], person: f.personId, suggested: f.suggestedId, status: f.status, score: f.confidence })) };
  });

  /* ---------- naming ---------- */

  /** "This is Maria": name faces, making the person if the name is new in this space. Naming is always a confirmation. */
  app.post('/api/faces/name', async (req) => {
    const b = z.object({ faceIds: ids, name: z.string().trim().min(1, 'Type a name.').max(80).optional(), personId: uuid.optional() }).parse(req.body);
    if (!b.name && !b.personId) throw bad('Say who this is.');
    const { me, space, rows } = await facesFor(req, b.faceIds);
    const out = await db.transaction(async (tx) => {
      let p = b.personId ? (await tx.select().from(persons).where(and(eq(persons.id, b.personId), eq(persons.spaceId, space))))[0] : (await tx.select().from(persons).where(and(eq(persons.spaceId, space), sql`lower(${persons.name}) = ${b.name!.toLowerCase()}`)))[0];
      if (!p && b.personId) throw notFound('That person is gone.');
      if (!p) [p] = await tx.insert(persons).values({ spaceId: space, name: b.name!, createdBy: me.id }).returning();
      await tx.update(faces).set({ personId: p!.id, status: 'confirmed', suggestedId: null, decidedBy: me.id, decidedAt: new Date() }).where(inArray(faces.id, b.faceIds));
      await tx.delete(faceRejections).where(and(inArray(faceRejections.faceId, b.faceIds), eq(faceRejections.personId, p!.id)));
      // a person is in a picture once: where they were tagged already, the face just named is remembered as them and carries no second tag
      const tidy = await tidyFaces(tx, { items: rows.map((f) => f.itemId), prefer: b.faceIds });
      await matchFaces(ctx, tx, space);
      return { id: p!.id, name: p!.name, same: tidy.same, also: tidy.apart };
    });
    await touch(rows.map((f) => f.itemId));
    return out;
  });

  /**
   * "No, that is not them": a suggestion is turned down, or a name is taken off. The face will not be offered that person again.
   * Undoing a name that was given automatically also makes automatic naming more careful about that person from now on.
   */
  app.post('/api/faces/reject', async (req) => {
    const b = z.object({ faceIds: ids }).parse(req.body);
    const { space, rows } = await facesFor(req, b.faceIds);
    await db.transaction(async (tx) => {
      for (const f of rows) {
        const who = f.personId ?? f.suggestedId;
        if (!who) continue;
        await tx.insert(faceRejections).values({ faceId: f.id, personId: who }).onConflictDoNothing();
        if (f.status === 'auto') await tx.update(persons).set({ strict: sql`${persons.strict} + 1` }).where(eq(persons.id, who));
      }
      await tx.update(faces).set({ personId: null, suggestedId: null, confidence: null, status: 'unsorted', decidedBy: null, decidedAt: null }).where(inArray(faces.id, b.faceIds));
      await matchFaces(ctx, tx, space);
    });
    await touch(rows.map((f) => f.itemId));
    return { ok: true };
  });

  /** "Ignore this face" (a stranger in the background) or "not a person" (a statue, a poster). Either can be undone. */
  app.post('/api/faces/ignore', async (req) => {
    const b = z.object({ faceIds: ids, as: z.enum(['ignored', 'notface', 'unsorted']) }).parse(req.body);
    const { me, space, rows } = await facesFor(req, b.faceIds);
    await db.update(faces).set({ personId: null, suggestedId: null, confidence: null, status: b.as, decidedBy: b.as === 'unsorted' ? null : me.id, decidedAt: b.as === 'unsorted' ? null : new Date() }).where(inArray(faces.id, b.faceIds));
    if (b.as === 'unsorted') await matchFaces(ctx, db, space);
    await touch(rows.filter((f) => f.personId).map((f) => f.itemId));
    return { ok: true };
  });

  /* ---------- people ---------- */

  async function personFor(req: FastifyRequest) {
    const [p] = await db.select().from(persons).where(eq(persons.id, uuid.parse((req.params as any).id)));
    if (!p) throw notFound('That person is gone.');
    const me = await needPeople(req, p.spaceId);
    return { p, me };
  }
  const itemsOf = async (personId: string) => (await db.select({ id: faces.itemId }).from(faces).where(eq(faces.personId, personId))).map((r) => r.id);

  app.patch('/api/persons/:id', async (req) => {
    const { p } = await personFor(req);
    const b = z.object({ name: z.string().trim().min(1).max(80).optional(), cover: uuid.nullable().optional() }).parse(req.body);
    if (b.name && b.name.toLowerCase() !== p.name.toLowerCase()) {
      const clash = await db.select({ id: persons.id }).from(persons).where(and(eq(persons.spaceId, p.spaceId), sql`lower(${persons.name}) = ${b.name.toLowerCase()}`));
      if (clash.length) throw new HttpError(409, 'Someone here already has that name. Merge the two if they are the same person.');
    }
    await db.update(persons).set({ ...(b.name ? { name: b.name } : {}), ...(b.cover !== undefined ? { coverFaceId: b.cover } : {}) }).where(eq(persons.id, p.id));
    if (b.name) await touch(await itemsOf(p.id));
    return { ok: true };
  });

  /** Two people who turn out to be one: everything of this person goes to the other, and this one is removed. */
  app.post('/api/persons/:id/merge', async (req) => {
    const { p, me } = await personFor(req);
    const b = z.object({ into: uuid }).parse(req.body);
    const [to] = await db.select().from(persons).where(and(eq(persons.id, b.into), eq(persons.spaceId, p.spaceId)));
    if (!to || to.id === p.id) throw bad('Choose another person in this space to merge into.');
    const moved = await itemsOf(p.id);
    await db.transaction(async (tx) => {
      await tx.update(faces).set({ personId: to.id }).where(eq(faces.personId, p.id));
      await tx.update(faces).set({ suggestedId: to.id }).where(eq(faces.suggestedId, p.id));
      await tidyFaces(tx, { items: moved });   // the two may have been in the same picture
      await tx.execute(sql`insert into face_rejections (face_id, person_id) select face_id, ${to.id}::uuid from face_rejections where person_id = ${p.id}::uuid on conflict do nothing`);
      await tx.update(persons).set({ strict: Math.max(p.strict, to.strict) }).where(eq(persons.id, to.id));
      await tx.delete(persons).where(eq(persons.id, p.id));
      await matchFaces(ctx, tx, p.spaceId);
    });
    await touch(moved);
    await logActivity(ctx, me, `merged two people in the pictures into “${to.name}”`);
    return { ok: true };
  });

  /** Forget a person: the name goes, and so does the face data of every face that carried it. */
  app.delete('/api/persons/:id', async (req) => {
    const { p, me } = await personFor(req);
    const had = await itemsOf(p.id);
    await db.transaction(async (tx) => {
      await tx.delete(faces).where(eq(faces.personId, p.id));
      await tx.update(faces).set({ suggestedId: null, confidence: null, status: 'unsorted' }).where(eq(faces.suggestedId, p.id));
      await tx.delete(persons).where(eq(persons.id, p.id));
      await matchFaces(ctx, tx, p.spaceId);
    });
    await touch(had);
    await logActivity(ctx, me, 'removed a person from the pictures, with their face data');
    return { ok: true };
  });

  /* ---------- switches, for the owner ---------- */

  app.post('/api/faces/settings', async (req) => {
    const me = needCap(req, 'admin');
    const b = z.object({
      space: uuid.optional(), on: z.boolean().optional(),
      auto: z.object({ on: z.boolean(), threshold: z.number().min(0.3).max(0.95) }).optional(),
      wipe: z.literal(true).optional(),
    }).parse(req.body);
    if (b.wipe) {
      // Recognition off everywhere, and every embedding, name and answer deleted.
      const on = await db.select({ id: spaces.id }).from(spaces);
      for (const s of on) await forgetSpace(ctx, s.id);
      await db.update(spaces).set({ people: false });
      await db.delete(schema.settings).where(eq(schema.settings.key, 'faces:auto'));
      await logActivity(ctx, me, 'turned people recognition off and deleted all face data');
      return { ok: true };
    }
    if (b.space && b.on !== undefined) {
      const [s] = await db.select().from(spaces).where(eq(spaces.id, b.space));
      if (!s) throw notFound();
      if (b.on && !s.people) { await db.update(spaces).set({ people: true }).where(eq(spaces.id, s.id)); await queueTasks(ctx, undefined, ['faces']); await logActivity(ctx, me, `turned people recognition on for “${s.name}”`); }
      if (!b.on && s.people) { await db.update(spaces).set({ people: false }).where(eq(spaces.id, s.id)); await forgetSpace(ctx, s.id); await logActivity(ctx, me, `turned people recognition off for “${s.name}” and deleted its face data`); }
    }
    if (b.auto) {
      await db.insert(schema.settings).values({ key: 'faces:auto', value: b.auto }).onConflictDoUpdate({ target: schema.settings.key, set: { value: b.auto } });
      // turning it on, or moving the threshold, looks again at every face still waiting
      for (const s of await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.people, true))) await matchFaces(ctx, db, s.id);
      await logActivity(ctx, me, b.auto.on ? `turned automatic naming on at ${b.auto.threshold}` : 'turned automatic naming off');
    }
    return { ok: true };
  });
}
