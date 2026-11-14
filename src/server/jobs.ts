import { eq, sql } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { schema } from './db/index.js';
import { ingestItem, renderCopy } from './media/ingest.js';
import { makePlayCopy } from './media/playcopy.js';
import { renderReel } from './media/reel.js';
import { queueTasks } from './ai/tasks.js';

/**
 * Background work, kept in the jobs table so nothing is lost if the app restarts mid-upload.
 * A few loops in this same process claim one job at a time with SKIP LOCKED.
 */
export function startWorker(ctx: Ctx, concurrency: number) {
  let stopped = false;
  const wakers = new Set<() => void>();
  const sleep = (ms: number) => new Promise<void>((r) => { const w = () => { clearTimeout(t); wakers.delete(w); r(); }; const t = setTimeout(w, ms); wakers.add(w); });

  async function claim() {
    const res = await ctx.db.execute(sql`
      update jobs set status = 'running', started_at = now(), attempts = attempts + 1
      where id = (select id from jobs where status = 'queued' and type <> 'playcopy' order by created_at limit 1 for update skip locked)
      returning id, type, item_id as "itemId", payload, attempts`);
    return (res.rows[0] as { id: string; type: string; itemId: string | null; payload: any; attempts: number } | undefined) ?? null;
  }

  /**
   * Playable copies of videos can take minutes each, so they never share a lane with photos.
   * One is taken only when nothing else is waiting or running, and only when no other copy is being made,
   * here or in another app container.
   */
  async function claimCopy() {
    const res = await ctx.db.execute(sql`
      update jobs set status = 'running', started_at = now(), attempts = attempts + 1
      where id = (select id from jobs where status = 'queued' and type = 'playcopy'
          and not exists (select 1 from jobs o where o.type <> 'playcopy' and o.status in ('queued', 'running'))
          and not exists (select 1 from jobs o where o.type = 'playcopy' and o.status = 'running')
        order by created_at limit 1 for update skip locked)
      returning id, item_id as "itemId"`);
    return (res.rows[0] as { id: string; itemId: string | null } | undefined) ?? null;
  }
  async function copyLoop() {
    while (!stopped) {
      let job: Awaited<ReturnType<typeof claimCopy>> = null;
      try { job = await claimCopy(); } catch (e) { ctx.log.error({ err: e }, 'could not claim a video copy'); }
      if (!job) { await sleep(5000); continue; }
      // makePlayCopy never throws: a copy that cannot be made is noted on the item, and the item itself stays as it was.
      if (job.itemId) await makePlayCopy(ctx, job.itemId).catch((e) => ctx.log.error({ err: e }, 'video copy'));
      await ctx.db.update(schema.jobs).set({ status: 'done', finishedAt: new Date(), error: null }).where(eq(schema.jobs.id, job.id)).catch(() => {});
    }
  }

  async function loop() {
    while (!stopped) {
      let job: Awaited<ReturnType<typeof claim>> = null;
      try { job = await claim(); } catch (e) { ctx.log.error({ err: e }, 'could not claim a job'); }
      if (!job) { await sleep(4000); continue; }
      try {
        if (job.type === 'ingest' && job.itemId) await ingestItem(ctx, job.itemId, job.payload ?? {});
        else if (job.type === 'render' && job.itemId) await renderCopy(ctx, job.itemId, job.payload ?? {});
        else if (job.type === 'reel' && job.payload?.reelId) await renderReel(ctx, job.payload.reelId);
        await ctx.db.update(schema.jobs).set({ status: 'done', finishedAt: new Date(), error: null }).where(eq(schema.jobs.id, job.id));
        // a new upload or a saved copy joins the line for the workers that read pictures
        if ((job.type === 'ingest' || job.type === 'render') && job.itemId) await queueTasks(ctx, [job.itemId]).catch((e) => ctx.log.error({ err: e }, 'could not queue work for the workers'));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.log.warn({ err: e, job: job.id, type: job.type }, 'job failed');
        const final = job.attempts >= 3;
        await ctx.db.update(schema.jobs).set({ status: final ? 'failed' : 'queued', error: msg, finishedAt: final ? new Date() : null }).where(eq(schema.jobs.id, job.id));
        if (final && job.itemId) await ctx.db.update(schema.items).set({ status: 'failed', error: msg.slice(0, 500), updatedAt: new Date() }).where(eq(schema.items.id, job.itemId));
      }
    }
  }

  // Anything left "running" belonged to a process that stopped: put it back in line.
  const ready = ctx.db.execute(sql`update jobs set status = 'queued' where status = 'running'`).then(() => { for (let i = 0; i < Math.max(1, concurrency); i++) void loop(); void copyLoop(); });
  return {
    ready,
    kick() { for (const w of [...wakers]) w(); },
    stop() { stopped = true; for (const w of [...wakers]) w(); },
  };
}
