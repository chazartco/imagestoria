import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context.js';

/**
 * Search by meaning. A worker turns every picture into a list of numbers (an embedding) with an image and text model.
 * This server turns the words someone types into numbers with the text half of the same model, on its own CPU,
 * and the closest pictures are the answer. No picture and no query leaves the owner's machines.
 *
 * The numbers are kept exactly in Postgres (item_embeddings, 4 bytes each). For searching they are held in memory
 * as one byte each, which costs under a megabyte per thousand pictures and changes the ranking by nothing that matters.
 * At tens of thousands of items a plain scan takes a few milliseconds, so there is no vector extension to install.
 */

export class ResultError extends Error {}

const shape = z.object({ dim: z.number().int().min(16).max(4096), vector: z.string().min(16).max(40000) });

/** Read a worker's embedding: base64 of little-endian 32-bit floats. It comes back with length 1. */
export function readVector(data: unknown): Float32Array {
  const d = shape.parse(data);
  const buf = Buffer.from(d.vector, 'base64');
  if (buf.length !== d.dim * 4) throw new ResultError(`The embedding should hold ${d.dim} numbers and holds ${buf.length / 4}.`);
  const v = new Float32Array(d.dim);
  let norm = 0;
  for (let i = 0; i < d.dim; i++) { const x = buf.readFloatLE(i * 4); if (!Number.isFinite(x)) throw new ResultError('The embedding holds something that is not a number.'); v[i] = x; norm += x * x; }
  norm = Math.sqrt(norm);
  if (!(norm > 1e-6)) throw new ResultError('The embedding is all zeros.');
  for (let i = 0; i < d.dim; i++) v[i]! /= norm;
  return v;
}
export const toBytes = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const small = (v: Float32Array) => { const o = new Int8Array(v.length); for (let i = 0; i < v.length; i++) o[i] = Math.max(-127, Math.min(127, Math.round(v[i]! * 127))); return o; };

/** Two pictures this alike are the same picture saved twice, whenever each says it was taken. */
const SAME = 0.992;

interface Entry { v: Int8Array; space: string; t: number; copyOf: string | null; w: number }

/** Every embedding for the model in use, in memory. It catches up with the database before each use, reading only what is new. */
export class EmbedIndex {
  private items = new Map<string, Entry>();
  private seen = '1970-01-01T00:00:00Z';
  private busy: Promise<void> | null = null;
  constructor(private ctx: Ctx) {}

  async refresh(): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = (async (): Promise<void> => {
      const model = this.ctx.cfg.EMBED_MODEL;
      const rows = await this.ctx.db.execute(sql`
        select e.item_id as id, e.vec, to_char(e.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, i.space_id as space,
          extract(epoch from i.taken_at)::float8 as t, i.copy_of as "copyOf", i.width as w
        from item_embeddings e join items i on i.id = e.item_id
        where e.model = ${model} and e.updated_at > ${this.seen}::timestamptz order by e.updated_at`);
      for (const r of rows.rows as any[]) {
        const b: Buffer = r.vec;
        this.items.set(r.id, { v: small(new Float32Array(b.buffer, b.byteOffset, b.length / 4)), space: r.space, t: Number(r.t), copyOf: r.copyOf, w: r.w });
        this.seen = r.at;
      }
      // what has gone to the trash, moved to another space, or been given another date, since
      const live = await this.ctx.db.execute(sql`select i.id, i.space_id as space, extract(epoch from i.taken_at)::float8 as t from items i join item_embeddings e on e.item_id = i.id where i.deleted_at is null and e.model = ${model}`);
      const now = new Map((live.rows as any[]).map((r) => [r.id as string, r]));
      for (const [id, e] of this.items) { const r = now.get(id); if (!r) this.items.delete(id); else { e.space = r.space; e.t = Number(r.t); } }
      // and what has come back from the trash
      if ([...now.keys()].some((id) => !this.items.has(id))) { this.seen = '1970-01-01T00:00:00Z'; this.busy = null; return this.refresh(); }
    })().finally(() => { this.busy = null; });
    return this.busy;
  }
  get size() { return this.items.size; }
  has(id: string) { return this.items.has(id); }
  inSpace(space: string) { const out: [string, Entry][] = []; for (const kv of this.items) if (kv[1].space === space) out.push(kv); return out; }

  /** The items of a space closest to a query, best first. Scores are cosine similarities, from -1 to 1. */
  nearest(q: Float32Array | Int8Array, space: string, limit: number, skip?: (id: string, e: Entry) => boolean) {
    const qs = q instanceof Int8Array ? q : small(q), scale = 1 / (127 * 127), out: [string, number][] = [];
    for (const [id, e] of this.items) {
      if (e.space !== space || (skip && skip(id, e))) continue;
      const v = e.v; let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i]! * qs[i]!;
      out.push([id, dot * scale]);
    }
    out.sort((a, b) => b[1] - a[1]);
    return out.slice(0, limit);
  }
  vector(id: string) { return this.items.get(id) ?? null; }

  /**
   * Near duplicates: bursts and re-exports. Nothing is compared with everything, so this stays quick at any size.
   *
   * A burst is found in time order. The first picture of a group is its leader, and a later picture joins only if it
   * looks like the leader and follows the group's last picture closely in time. Comparing with the leader, not with the
   * neighbour, is what stops a long sequence that changes a little with each frame from becoming one enormous group.
   *
   * A re-export is the same picture saved twice, whatever date each carries. Those are found along a few fixed directions
   * through the numbers, where pictures that are the same always land side by side.
   *
   * An edited copy made here is left out altogether. It is meant to look like its original, and is never offered for the trash.
   */
  duplicates(space: string) {
    const { DUPLICATE_SIMILARITY: near, DUPLICATE_MINUTES: minutes } = this.ctx.cfg, same = Math.max(near, SAME), win = minutes * 60;
    const list = this.inSpace(space).filter(([, e]) => !e.copyOf).sort((a, b) => a[1].t - b[1].t || (a[0] < b[0] ? -1 : 1));
    const scale = 1 / (127 * 127);
    const cos = (a: Int8Array, b: Int8Array) => { let dot = 0; for (let k = 0; k < a.length; k++) dot += a[k]! * b[k]!; return dot * scale; };
    const group = new Array<number>(list.length).fill(-1), groups: number[][] = [];
    let open: number[] = [];   // groups whose last picture is recent enough for another to follow it
    for (let i = 0; i < list.length; i++) {
      const e = list[i]![1];
      open = open.filter((g) => e.t - list[groups[g]![groups[g]!.length - 1]!]![1].t <= win);
      let best = -1, top = near;
      for (const g of open.slice(-12)) { const s = cos(e.v, list[groups[g]![0]!]![1].v); if (s >= top) { top = s; best = g; } }
      if (best < 0) { best = groups.length; groups.push([]); open.push(best); }
      groups[best]!.push(i); group[i] = best;
    }
    const parent = groups.map((_, g) => g);
    const find = (g: number): number => { while (parent[g] !== g) { parent[g] = parent[parent[g]!]!; g = parent[g]!; } return g; };
    const dim = list[0]?.[1].v.length ?? 0;
    for (let p = 0; p < 4 && list.length > 1; p++) {
      // a fixed direction: the same every time, so the answer does not change from one look to the next
      const dir = new Int8Array(dim); let seed = 0x9e3779b9 ^ (p * 0x85ebca6b);
      for (let k = 0; k < dim; k++) { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + k) | 0; dir[k] = (seed >>> 16) & 1 ? 1 : -1; }
      const along = list.map(([, e], i) => { let d = 0; for (let k = 0; k < dim; k++) d += e.v[k]! * dir[k]!; return [d, i] as [number, number]; }).sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < along.length; i++) for (let j = i + 1; j < along.length && j <= i + 12; j++) {
        const a = along[i]![1], b = along[j]![1];
        if (find(group[a]!) !== find(group[b]!) && cos(list[a]![1].v, list[b]![1].v) >= same) parent[find(group[b]!)] = find(group[a]!);
      }
    }
    const out = new Map<number, string[]>();
    list.forEach(([id], i) => { const r = find(group[i]!); out.set(r, [...(out.get(r) ?? []), id]); });
    return [...out.values()].filter((g) => g.length > 1);
  }
}

/* ---------- the text half, on this server's CPU ---------- */

export type TextEmbedder = (text: string) => Promise<Float32Array>;
export interface TextState { state: 'off' | 'idle' | 'loading' | 'ready' | 'failed'; error?: string; ms?: number }

/**
 * Loads the text half of the model with ONNX Runtime the first time someone searches. The files are fetched once from
 * Hugging Face into DATA_DIR/models (about 320 MB for the default model) and read from there afterwards. To run with no
 * outside connection at all, put the files there yourself: see the README.
 */
export function makeTextEmbedder(ctx: Ctx): { embed: TextEmbedder; status: () => TextState } {
  const { cfg } = ctx;
  let st: TextState = { state: cfg.EMBED_TEXT ? 'idle' : 'off' };
  let ready: Promise<(text: string) => Promise<Float32Array>> | null = null, drop: (() => Promise<unknown>) | null = null, idle: NodeJS.Timeout | null = null;
  const cache = new Map<string, Float32Array>();
  // The model holds most of a gigabyte of memory. After a quiet spell it is let go, and loaded again on the next search.
  const rest = () => {
    if (idle) clearTimeout(idle);
    if (!(cfg.EMBED_TEXT_IDLE_MINUTES > 0)) return;
    idle = setTimeout(() => { const d = drop; ready = null; drop = null; st = { state: 'idle' }; void d?.().catch(() => {}); ctx.log.info('the text model for search by meaning was let go after a quiet spell'); }, cfg.EMBED_TEXT_IDLE_MINUTES * 60_000);
    idle.unref();
  };
  const load = async () => {
    const t0 = Date.now();
    const tf = await import('@huggingface/transformers');
    const dir = path.join(cfg.DATA_DIR, 'models');
    fs.mkdirSync(dir, { recursive: true });
    tf.env.cacheDir = dir; tf.env.localModelPath = dir; tf.env.allowLocalModels = true; tf.env.allowRemoteModels = true;
    const tokenizer = await tf.AutoTokenizer.from_pretrained(cfg.EMBED_MODEL);
    // SigLIP models and CLIP models keep their text half under different names
    const kind: any = /clip/i.test(cfg.EMBED_MODEL) && !/siglip/i.test(cfg.EMBED_MODEL) ? tf.CLIPTextModelWithProjection : tf.SiglipTextModel;
    const model = await kind.from_pretrained(cfg.EMBED_MODEL, { dtype: cfg.EMBED_TEXT_DTYPE, session_options: { enableCpuMemArena: false, enableMemPattern: false, intraOpNumThreads: 2 } });
    drop = () => model.dispose();
    ctx.log.info({ model: cfg.EMBED_MODEL, ms: Date.now() - t0 }, 'the text model for search by meaning is loaded');
    return async (text: string) => {
      // The model was trained on lower-case text padded to 64 tokens, and it matters.
      const inputs = tokenizer([text.toLowerCase()], { padding: 'max_length', max_length: 64, truncation: true });
      const out: any = await model(inputs);
      const data = (out.pooler_output ?? out.text_embeds).data as Float32Array, v = new Float32Array(data.length);
      let n = 0; for (let i = 0; i < data.length; i++) n += data[i]! * data[i]!;
      n = Math.sqrt(n) || 1; for (let i = 0; i < data.length; i++) v[i] = data[i]! / n;
      return v;
    };
  };
  return {
    status: () => st,
    async embed(text) {
      if (!cfg.EMBED_TEXT) throw new Error('Search by meaning is turned off (EMBED_TEXT=false).');
      const key = text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 300);
      const hit = cache.get(key); if (hit) return hit;
      if (!ready) { st = { state: 'loading' }; ready = load(); ready.then(() => { st = { state: 'ready' }; }, (e) => { st = { state: 'failed', error: e instanceof Error ? e.message : String(e) }; ready = null; ctx.log.error({ err: e }, 'the text model for search by meaning could not be loaded'); }); }
      const run = await ready, t0 = Date.now(), v = await run(key);
      st = { state: 'ready', ms: Date.now() - t0 }; rest();
      cache.set(key, v); if (cache.size > 200) cache.delete(cache.keys().next().value!);
      return v;
    },
  };
}
