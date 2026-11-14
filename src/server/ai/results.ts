import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { schema } from '../db/index.js';
import type { Task } from './tasks.js';
import { SCENES } from '../../shared/scenes.js';
import { ResultError, readVector, toBytes } from './embed.js';
import { applyFaces } from './faces.js';
import { applyPlace } from '../routes/places.js';

type Tx = Parameters<Parameters<Ctx['db']['transaction']>[0]>[0];
export interface Model { name: string; version: string }
/** Stores what a worker found for one item and one task. It throws a ZodError when the result is not in the agreed shape. */
type Apply = (ctx: Ctx, tx: Tx, itemId: string, data: unknown, model: Model) => Promise<void>;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const captionShape = z.object({
  caption: z.string().max(2000).transform(clean),
  scene: z.string().max(60).transform((s) => clean(s).toLowerCase()).nullable().optional(),
  objects: z.array(z.object({ label: z.string().min(1).max(60).transform((s) => clean(s).toLowerCase()), confidence: z.number().min(0).max(1) })).max(80).default([]),
  text: z.string().max(4000).transform(clean).optional(),
});

/**
 * A person's correction always wins. A caption or scene someone corrected is left alone, a label someone removed
 * stays removed, and a label someone added stays theirs. Everything else is replaced by the new reading.
 */
const caption: Apply = async (_ctx, tx, itemId, data) => {
  const d = captionShape.parse(data);
  const [it] = await tx.select({ locked: schema.items.aiLocked }).from(schema.items).where(eq(schema.items.id, itemId));
  const locked = it?.locked ?? [], scene = d.scene ? ((SCENES as string[]).includes(d.scene) ? d.scene : 'other') : null;
  await tx.update(schema.items).set({ ...(locked.includes('caption') ? {} : { aiCaption: d.caption || null }), ...(locked.includes('scene') ? {} : { aiScene: scene }), aiText: d.text || null, updatedAt: new Date() }).where(eq(schema.items.id, itemId));
  await tx.delete(schema.itemLabels).where(and(eq(schema.itemLabels.itemId, itemId), eq(schema.itemLabels.source, 'ai'), eq(schema.itemLabels.removed, false)));
  // the same thing named twice keeps its higher confidence
  const best = new Map<string, number>();
  for (const o of d.objects) if (o.label) best.set(o.label, Math.max(best.get(o.label) ?? 0, o.confidence));
  if (best.size) await tx.insert(schema.itemLabels).values([...best].map(([label, confidence]) => ({ itemId, label, confidence }))).onConflictDoNothing();
};

/** An embedding is only useful beside others from the same model, so one from a different model is refused with the reason. */
const embed: Apply = async (ctx, tx, itemId, data, model) => {
  if (model.name !== ctx.cfg.EMBED_MODEL) throw new ResultError(`This site searches with ${ctx.cfg.EMBED_MODEL}. Set the same model under [embed] in the worker's config, or change EMBED_MODEL on the site.`);
  const v = readVector(data);
  await tx.insert(schema.itemEmbeddings).values({ itemId, model: model.name, dim: v.length, vec: toBytes(v) })
    .onConflictDoUpdate({ target: schema.itemEmbeddings.itemId, set: { model: model.name, dim: v.length, vec: toBytes(v), updatedAt: new Date() } });
};

export const APPLY: Partial<Record<Task, Apply>> = { caption, embed, faces: applyFaces, place: applyPlace };

/** Mark one claimed task done and store what was found, in one step. False when this worker no longer holds the task. */
export async function finishTask(ctx: Ctx, workerId: string, itemId: string, task: Task, data: unknown, model: Model) {
  return ctx.db.transaction(async (tx) => {
    const held = await tx.execute(sql`select 1 from ai_tasks where item_id = ${itemId}::uuid and task = ${task} and status = 'claimed' and worker_id = ${workerId}::uuid for update`);
    if (!held.rows.length) return false;
    await APPLY[task]!(ctx, tx, itemId, data, model);
    await tx.update(schema.aiTasks).set({ status: 'done', model: model.name, modelVersion: model.version, error: null, doneAt: new Date(), leaseUntil: null })
      .where(and(eq(schema.aiTasks.itemId, itemId), eq(schema.aiTasks.task, task)));
    return true;
  });
}

/** A worker could not do a task. It goes back in line, or is marked failed once it has been tried enough. */
export async function failTask(ctx: Ctx, workerId: string, itemId: string, task: Task, error: string) {
  const r = await ctx.db.execute(sql`
    update ai_tasks set status = case when attempts >= ${ctx.cfg.AI_MAX_ATTEMPTS} then 'failed' else 'queued' end, error = ${error.slice(0, 500)}, worker_id = null, lease_until = null
    where item_id = ${itemId}::uuid and task = ${task} and status = 'claimed' and worker_id = ${workerId}::uuid`);
  return (r.rowCount ?? 0) > 0;
}
