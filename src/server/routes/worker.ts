import crypto from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { failTask, finishTask } from '../ai/results.js';
import { ResultError } from '../ai/embed.js';
import { TASKS, claimItems, isLive, liveTasks, queueTasks, redoTask, syncAiStatus, taskCounts, type Task } from '../ai/tasks.js';
import { hashToken, logActivity, needCap } from '../auth/core.js';
import { type Ctx, HttpError, bad, notFound } from '../context.js';
import { schema } from '../db/index.js';
import { sendStored } from './items.js';
import { SCENES } from '../../shared/scenes.js';

const uuid = z.string().uuid();
const { workers, aiTasks, items } = schema;
type Worker = typeof workers.$inferSelect;
const short = (max: number) => z.string().max(max).transform((s) => s.replace(/\s+/g, ' ').trim());

/**
 * The door for workers: programs on the owner's own machines that read the pictures.
 * A worker signs in with a token from the settings page, sent as "Authorization: Bearer ...".
 * It can claim work, fetch the files of items it has claimed, post results and say it is alive. Nothing else:
 * every other route asks for a signed-in person, and a token is not one.
 */
export function registerWorker(app: FastifyInstance, ctx: Ctx) {
  const { db, cfg } = ctx;

  async function needWorker(req: FastifyRequest): Promise<Worker> {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
    if (!m) throw new HttpError(401, 'Send the worker token as a bearer token.');
    const [w] = await db.select().from(workers).where(and(eq(workers.tokenHash, hashToken(m[1]!)), isNull(workers.revokedAt)));
    if (!w) throw new HttpError(401, 'This worker token is not valid. It may have been revoked.');
    if (!w.lastSeenAt || Date.now() - w.lastSeenAt.getTime() > 20_000) await db.update(workers).set({ lastSeenAt: new Date() }).where(eq(workers.id, w.id));
    return w;
  }

  /** Ask for work. Answers with items and, for each, the tasks to do and where to fetch its files. */
  app.post('/api/worker/claim', async (req) => {
    const w = await needWorker(req);
    const b = z.object({ want: z.number().int().min(1).max(64).default(8), tasks: z.array(z.string().max(30)).min(1).max(20) }).parse(req.body);
    const tasks = b.tasks.filter((t): t is Task => isLive(ctx, t));
    if (w.paused || !tasks.length) return { paused: w.paused, leaseSeconds: cfg.AI_LEASE_MINUTES * 60, tasks: liveTasks(ctx), items: [] };
    const claimed = await claimItems(ctx, w.id, tasks, b.want);
    const out = [];
    for (const [id, list] of claimed) {
      const [it] = await db.select().from(items).where(eq(items.id, id));
      if (!it) continue;
      // With a bucket the worker fetches straight from it through a signed link. Otherwise it comes back here with its token.
      const link = async (kind: 'display' | 'orig', key: string | null, type: string) => (key ? (await ctx.storage.signedUrl(key, { contentType: type })) ?? `/api/worker/files/${it.id}/${kind}` : null);
      out.push({
        id: it.id, kind: it.kind, w: it.width, h: it.height, duration: it.duration, lat: it.lat, lng: it.lng, tasks: list,
        files: { display: await link('display', it.displayKey, 'image/webp'), orig: await link('orig', it.origKey, it.mime) }, mime: it.mime,
      });
    }
    return { paused: false, leaseSeconds: cfg.AI_LEASE_MINUTES * 60, tasks: liveTasks(ctx), items: out };
  });

  /** The file of an item this worker holds a live claim on. Any other item is refused. */
  app.get('/api/worker/files/:id/:kind', async (req, reply) => {
    const w = await needWorker(req);
    const { id, kind } = req.params as { id: string; kind: string };
    const held = await db.execute(sql`select 1 from ai_tasks where item_id = ${uuid.parse(id)}::uuid and worker_id = ${w.id}::uuid and status = 'claimed' and lease_until > now() limit 1`);
    if (!held.rows.length) throw new HttpError(403, 'This worker has not claimed that item.');
    const [it] = await db.select().from(items).where(and(eq(items.id, id), isNull(items.deletedAt)));
    if (!it) throw notFound('That item is gone.');
    const key = kind === 'display' ? it.displayKey : kind === 'orig' ? it.origKey : null;
    if (!key) throw notFound();
    return sendStored(ctx, req, reply, key, kind === 'display' ? 'image/webp' : it.mime, undefined, true);
  });

  /** Give items back unread, when a worker is stopping or its model server went away. It does not count as a try. */
  app.post('/api/worker/release', async (req) => {
    const w = await needWorker(req);
    const b = z.object({ itemIds: z.array(uuid).min(1).max(500) }).parse(req.body);
    const r = await db.execute(sql`update ai_tasks set status = 'queued', worker_id = null, lease_until = null, attempts = greatest(attempts - 1, 0)
      where worker_id = ${w.id}::uuid and status = 'claimed' and item_id in (${sql.join(b.itemIds.map((i) => sql`${i}::uuid`), sql`, `)})`);
    return { released: r.rowCount ?? 0 };
  });

  /** Hand results in. Each one is taken or refused on its own, so one bad answer does not lose a batch. */
  app.post('/api/worker/results', { bodyLimit: 32 << 20 }, async (req) => {
    const w = await needWorker(req);
    const model = z.object({ name: short(120).pipe(z.string().min(1)), version: short(120).default('') });
    const b = z.object({ results: z.array(z.object({ itemId: uuid, task: z.string().max(30), model: model.optional(), data: z.unknown().optional(), error: short(500).optional() })).min(1).max(256) }).parse(req.body);
    let accepted = 0; const refused: { itemId: string; task: string; reason: string }[] = [], touched = new Set<string>();
    for (const r of b.results) {
      const no = (reason: string) => refused.push({ itemId: r.itemId, task: r.task, reason });
      if (!isLive(ctx, r.task)) { no('This server does not take results for that task.'); continue; }
      touched.add(r.itemId);
      if (r.error !== undefined) { if (await failTask(ctx, w.id, r.itemId, r.task, r.error || 'The worker gave no reason.')) accepted++; else no('This worker does not hold that task.'); continue; }
      if (!r.model) { no('A result must say which model produced it.'); continue; }
      try {
        if (await finishTask(ctx, w.id, r.itemId, r.task, r.data, r.model)) accepted++; else no('This worker does not hold that task. Its claim may have run out.');
      } catch (e) {
        if (e instanceof ResultError) { no(e.message); continue; }
        if (!(e instanceof ZodError)) throw e;
        const at = e.issues[0];
        no(`The result is not in the agreed shape: ${at?.path.join('.') ?? ''} ${at?.message ?? ''}`.trim());
      }
    }
    await syncAiStatus(ctx, [...touched]);
    return { accepted, refused };
  });

  /** "I am alive, and this is what I am." Keeps this worker's claims from running out while it is still working on them. */
  app.post('/api/worker/heartbeat', async (req) => {
    const w = await needWorker(req);
    const b = z.object({ host: short(120).optional(), os: short(120).optional(), gpu: short(200).optional(), doing: short(200).optional(), version: short(40).optional(), models: z.record(z.string().max(30), short(160)).optional() }).parse(req.body ?? {});
    await db.update(workers).set({ info: { ...b, at: Date.now() }, lastSeenAt: new Date() }).where(eq(workers.id, w.id));
    await db.execute(sql`update ai_tasks set lease_until = now() + make_interval(mins => ${cfg.AI_LEASE_MINUTES}) where worker_id = ${w.id}::uuid and status = 'claimed' and lease_until > now()`);
    return { ok: true, name: w.name, paused: w.paused, tasks: liveTasks(ctx), scenes: SCENES, embedModel: cfg.EMBED_MODEL, waiting: Object.fromEntries((await taskCounts(ctx)).map((t) => [t.task, t.waiting])) };
  });

  /* ---------- the owner's side: the Workers section of the settings page ---------- */

  app.get('/api/admin/workers', async (req) => {
    needCap(req, 'admin');
    const rows = await db.select().from(workers).where(isNull(workers.revokedAt)).orderBy(asc(workers.createdAt));
    const holding = await db.execute(sql`select worker_id as id, count(distinct item_id)::int as n from ai_tasks where status = 'claimed' and lease_until > now() group by worker_id`);
    const held = new Map((holding.rows as { id: string; n: number }[]).map((r) => [r.id, r.n]));
    return {
      workers: rows.map((w) => ({ id: w.id, name: w.name, paused: w.paused, created: w.createdAt.getTime(), last: w.lastSeenAt?.getTime() ?? null, info: w.info ?? {}, holding: held.get(w.id) ?? 0 })),
      tasks: await taskCounts(ctx), leaseMinutes: cfg.AI_LEASE_MINUTES,
    };
  });

  /** A token for one machine. This answer is the only time the token itself is shown: only its hash is kept. */
  app.post('/api/admin/workers', async (req) => {
    const me = needCap(req, 'admin');
    const b = z.object({ name: z.string().trim().min(1, 'Give the machine a name.').max(60) }).parse(req.body);
    const token = 'aiw_' + crypto.randomBytes(32).toString('base64url');
    const [w] = await db.insert(workers).values({ name: b.name, tokenHash: hashToken(token), createdBy: me.id }).returning();
    await logActivity(ctx, me, `made a worker token for “${b.name}”`);
    return { id: w!.id, name: w!.name, token };
  });

  app.patch('/api/admin/workers/:id', async (req) => {
    needCap(req, 'admin');
    const b = z.object({ name: z.string().trim().min(1).max(60).optional(), paused: z.boolean().optional() }).parse(req.body);
    const r = await db.update(workers).set(b).where(and(eq(workers.id, uuid.parse((req.params as any).id)), isNull(workers.revokedAt))).returning({ id: workers.id });
    if (!r.length) throw notFound();
    return { ok: true };
  });

  /** Revoke a token. The machine is refused from now on, and whatever it was holding goes back in line. */
  app.delete('/api/admin/workers/:id', async (req) => {
    const me = needCap(req, 'admin');
    const [w] = await db.update(workers).set({ revokedAt: new Date() }).where(and(eq(workers.id, uuid.parse((req.params as any).id)), isNull(workers.revokedAt))).returning();
    if (!w) throw notFound();
    await db.update(aiTasks).set({ status: 'queued', workerId: null, leaseUntil: null }).where(and(eq(aiTasks.workerId, w.id), eq(aiTasks.status, 'claimed')));
    await logActivity(ctx, me, `revoked the worker token for “${w.name}”`);
    return { ok: true };
  });

  /** Read everything again for one task, for when a better model is in place. */
  app.post('/api/admin/workers/redo', async (req) => {
    const me = needCap(req, 'admin');
    const b = z.object({ task: z.enum(TASKS) }).parse(req.body);
    if (!isLive(ctx, b.task)) throw bad('This server does not do that task yet.');
    const n = await redoTask(ctx, b.task as Task);
    await logActivity(ctx, me, `asked the workers to do “${b.task}” again for the whole library`);
    return { n };
  });

  // Items that were here before a task existed join its line when the app starts.
  void queueTasks(ctx).catch((e) => ctx.log.error({ err: e }, 'could not queue work for the workers'));
}
