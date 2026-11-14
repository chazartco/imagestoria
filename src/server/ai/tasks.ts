import { sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../context.js';

/**
 * What a worker on the owner's own machine can be asked to do with an item. Each is tracked on its own
 * (the ai_tasks table), so a task added later, or done again with a better model, leaves the others alone.
 */
export const TASKS = ['caption', 'embed', 'faces', 'place'] as const;
export type Task = (typeof TASKS)[number];

/** Which items a task applies to, as a condition on `items i`. */
const APPLIES: Record<Task, SQL> = {
  caption: sql`true`,
  embed: sql`true`,
  faces: sql`i.kind = 'photo' and exists (select 1 from spaces s where s.id = i.space_id and s.people)`,
  place: sql`i.lat is null and i.kind = 'photo'`,
};
/** The tasks this server can take results for, less any the operator left out of AI_TASKS. */
const BUILT: Task[] = ['caption', 'embed', 'faces', 'place'];
export const liveTasks = (ctx: Ctx): Task[] => BUILT.filter((t) => ctx.cfg.AI_TASKS.includes(t));
export const isLive = (ctx: Ctx, t: string): t is Task => (liveTasks(ctx) as string[]).includes(t);

const idList = (ids: string[]) => sql`(${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`;

/**
 * Keep items.ai_status in step with the tasks: done once the picture has been read (its caption task),
 * queued while anything is waiting or being worked on, none otherwise. The page reads this one word.
 */
export async function syncAiStatus(ctx: Ctx, ids?: string[]) {
  if (ids && !ids.length) return;
  await ctx.db.execute(sql`
    update items i set ai_status = s.st, updated_at = now()
    from (select i2.id,
        case when exists (select 1 from ai_tasks t where t.item_id = i2.id and t.task = 'caption' and t.status = 'done') then 'done'
             when exists (select 1 from ai_tasks t where t.item_id = i2.id and t.status in ('queued', 'claimed')) then 'queued'
             else 'none' end as st
      from items i2 ${ids ? sql`where i2.id in ${idList(ids)}` : sql``}) s
    where s.id = i.id and i.ai_status <> s.st`);
}

/**
 * Put items in line for every task that applies to them and that they are not in line for yet.
 * With no ids it looks at the whole library, which is how items from before a task existed join its line.
 */
export async function queueTasks(ctx: Ctx, ids?: string[], only?: Task[]) {
  if (ids && !ids.length) return 0;
  let n = 0;
  for (const task of (only ?? liveTasks(ctx)).filter((t) => isLive(ctx, t))) {
    const r = await ctx.db.execute(sql`
      insert into ai_tasks (item_id, task)
      select i.id, ${task} from items i
      where i.status = 'ready' and i.deleted_at is null and (${APPLIES[task]}) ${ids ? sql`and i.id in ${idList(ids)}` : sql``}
      on conflict do nothing`);
    n += r.rowCount ?? 0;
  }
  if (n) await syncAiStatus(ctx, ids);
  return n;
}

/** "Read everything again": every item goes back in line for one task. What was read before stays until the new result replaces it. */
export async function redoTask(ctx: Ctx, task: Task) {
  // what the task no longer applies to drops out first: a picture that has been given a location needs no guess at one
  await ctx.db.execute(sql`delete from ai_tasks t using items i where i.id = t.item_id and t.task = ${task} and not (${APPLIES[task]})`);
  await queueTasks(ctx, undefined, [task]);
  const r = await ctx.db.execute(sql`update ai_tasks set status = 'queued', attempts = 0, error = null, worker_id = null, lease_until = null, queued_at = now() where task = ${task} and status <> 'queued'`);
  await syncAiStatus(ctx);
  return r.rowCount ?? 0;
}

/** Claims whose lease ran out go back in line. After too many tries a task is marked failed, so one bad file cannot circle for ever. */
export async function sweepLeases(ctx: Ctx) {
  const r = await ctx.db.execute(sql`
    update ai_tasks set status = case when attempts >= ${ctx.cfg.AI_MAX_ATTEMPTS} then 'failed' else 'queued' end,
      error = case when attempts >= ${ctx.cfg.AI_MAX_ATTEMPTS} then 'No worker finished this in time.' else error end, worker_id = null, lease_until = null
    where status = 'claimed' and lease_until < now() returning item_id as id, status`);
  const failed = r.rows.filter((x: any) => x.status === 'failed').map((x: any) => x.id as string);
  if (failed.length) await syncAiStatus(ctx, failed);
}

/**
 * Hand a worker up to `want` items, with the tasks it asked for that are waiting on each.
 * An item goes to one worker at a time: the item rows are locked with SKIP LOCKED while they are picked,
 * and an item another worker is holding is passed over.
 */
export async function claimItems(ctx: Ctx, workerId: string, tasks: Task[], want: number) {
  await sweepLeases(ctx);
  const list = sql`array[${sql.join(tasks.map((t) => sql`${t}`), sql`, `)}]::text[]`;
  const r = await ctx.db.execute(sql`
    with picked as (
      select i.id from items i
      where i.deleted_at is null and i.status = 'ready'
        and exists (select 1 from ai_tasks t where t.item_id = i.id and t.status = 'queued' and t.task = any(${list}))
        and not exists (select 1 from ai_tasks t where t.item_id = i.id and t.status = 'claimed' and t.worker_id is distinct from ${workerId}::uuid)
      order by i.added_at desc, i.id limit ${want} for no key update of i skip locked)
    update ai_tasks t set status = 'claimed', worker_id = ${workerId}::uuid, lease_until = now() + make_interval(mins => ${ctx.cfg.AI_LEASE_MINUTES}), attempts = t.attempts + 1, error = null
    from picked where t.item_id = picked.id and t.status = 'queued' and t.task = any(${list})
    returning t.item_id as id, t.task`);
  const by = new Map<string, Task[]>();
  for (const row of r.rows as { id: string; task: Task }[]) by.set(row.id, [...(by.get(row.id) ?? []), row.task]);
  if (by.size) await syncAiStatus(ctx, [...by.keys()]);
  return by;
}

/** How much is waiting, being worked on, done and failed, per task. Trashed items are left out. */
export async function taskCounts(ctx: Ctx) {
  const r = await ctx.db.execute(sql`
    select t.task, count(*) filter (where t.status = 'queued')::int as waiting, count(*) filter (where t.status = 'claimed')::int as claimed,
      count(*) filter (where t.status = 'done')::int as done, count(*) filter (where t.status = 'failed')::int as failed
    from ai_tasks t join items i on i.id = t.item_id where i.deleted_at is null group by t.task`);
  const rows = r.rows as { task: string; waiting: number; claimed: number; done: number; failed: number }[];
  return liveTasks(ctx).map((task) => rows.find((x) => x.task === task) ?? { task, waiting: 0, claimed: 0, done: 0, failed: 0 });
}
