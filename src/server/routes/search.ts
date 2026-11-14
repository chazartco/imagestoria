import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { needSpace } from '../auth/core.js';
import type { Ctx } from '../context.js';
import { itemFor } from './items.js';

const uuid = z.string().uuid();

/**
 * Search by meaning, "More like this" and near duplicates. All three read the embeddings a worker made.
 * With no worker, or before it has got that far, each answers with nothing and says why, and the page carries on as before.
 */
export function registerSearch(app: FastifyInstance, ctx: Ctx) {
  const { cfg } = ctx;

  /** Pictures in one space that fit a phrase, best first. The page shows them under its own exact matches. */
  app.get('/api/search', async (req) => {
    const q = z.object({ q: z.string().trim().min(1).max(300), space: uuid }).parse(req.query);
    needSpace(req, q.space);
    const none = (state: string, note = '') => ({ state, note, results: [] as [string, number][] });
    if (!ctx.embedText) return none('off');
    await ctx.embeds.refresh();
    if (!ctx.embeds.inSpace(q.space).length) return none('empty');
    let v: Float32Array;
    try { v = await Promise.race([ctx.embedText(q.q), new Promise<never>((_, no) => setTimeout(() => no(new Error('loading')), 8000))]); }
    catch (e) {
      const st = ctx.textStatus();
      if (st.state === 'loading' || (e instanceof Error && e.message === 'loading')) return none('loading', 'Search by meaning is getting ready. The first search after a restart takes a little while. Try again in a moment.');
      return none('failed', 'Search by meaning is not working on this server. The reason is in its log.');
    }
    // Keep what is close to the best match and clearly above the level of pictures that have nothing to do with the words.
    const top = ctx.embeds.nearest(v, q.space, cfg.SEARCH_MEANING_MAX);
    const best = top[0]?.[1] ?? 0;
    const results = top.filter(([, s]) => s >= cfg.SEARCH_MEANING_FLOOR && s >= best - cfg.SEARCH_MEANING_SPREAD).map(([id, s]) => [id, Math.round(s * 1000) / 1000] as [string, number]);
    return { state: 'ok', note: '', results };
  });

  /** "More like this": the pictures in the same space that look most like one picture. */
  app.get('/api/items/:id/similar', async (req) => {
    const it = await itemFor(ctx, req, (req.params as any).id);
    await ctx.embeds.refresh();
    const me = ctx.embeds.vector(it.id);
    if (!me) return { state: 'none', ids: [] };
    const root = it.copyOf ?? it.id;
    // its own copies, and the original it was made from, are not "more like this": they are this
    const near = ctx.embeds.nearest(me.v, it.spaceId, 12, (id, e) => id === it.id || id === root || e.copyOf === root);
    return { state: 'ok', ids: near.filter(([, s]) => s >= cfg.SIMILAR_FLOOR).map(([id]) => id) };
  });

  /** Groups of near duplicates in one space. Nothing is ever removed here: the page offers, and a person decides. */
  app.get('/api/duplicates', async (req) => {
    const q = z.object({ space: uuid }).parse(req.query);
    needSpace(req, q.space);
    await ctx.embeds.refresh();
    return { groups: ctx.embeds.duplicates(q.space) };
  });
}
