import crypto from 'node:crypto';
import path from 'node:path';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { need, needCap } from '../auth/core.js';
import { type Ctx, HttpError, bad, notFound } from '../context.js';
import { schema } from '../db/index.js';
import { CubeError, MAX_CUBE_SIZE, parseCube } from '../media/cube.js';

const { luts, items } = schema;
const MAX_CUBE_MB = 24;

/**
 * Looks of your own: 3D lookup tables loaded from .cube files. One list for the whole library.
 * The file is read and checked once, on upload, and kept as plain 32-bit numbers, which is what the develop code
 * takes in the browser and on the server (src/shared/develop.js).
 *
 * Removing one takes it off the list. If any copy was made with it, its numbers are kept, so that copy can still be
 * rendered again and opened in the editor. They are deleted with the row only when nothing uses them.
 */
export async function lutData(ctx: Ctx, id: string): Promise<{ n: number; data: Float32Array }> {
  const [l] = z.string().uuid().safeParse(id).success ? await ctx.db.select().from(luts).where(eq(luts.id, id)) : [];
  if (!l) throw notFound('The look this copy was made with is gone.');
  const chunks: Buffer[] = []; for await (const c of (await ctx.storage.open(l.key)).stream) chunks.push(c as Buffer);
  const buf = Buffer.concat(chunks);
  if (buf.length !== l.size ** 3 * 12) throw new Error('The stored table for this look is damaged.');
  return { n: l.size, data: new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)) };
}
export async function lutExists(ctx: Ctx, id: string): Promise<boolean> {
  return (await ctx.db.select({ id: luts.id }).from(luts).where(eq(luts.id, id))).length > 0;
}

export function registerLuts(app: FastifyInstance, ctx: Ctx) {
  const { db, storage } = ctx;
  const row = (l: typeof luts.$inferSelect) => ({ id: l.id, name: l.name, size: l.size, by: l.addedBy });

  app.get('/api/luts', async (req) => {
    need(req);
    return { luts: (await db.select().from(luts).where(isNull(luts.removedAt)).orderBy(asc(luts.name))).map(row), maxSize: MAX_CUBE_SIZE, maxMb: MAX_CUBE_MB };
  });

  /** The numbers of one table, for the editor's preview. Also answers for a removed one that a copy still uses. */
  app.get('/api/luts/:id/data', async (req: FastifyRequest, reply: FastifyReply) => {
    need(req);
    const [l] = await db.select().from(luts).where(eq(luts.id, z.string().uuid().parse((req.params as any).id)));
    if (!l) throw notFound('That look is gone.');
    const f = await storage.open(l.key);
    return reply.header('content-type', 'application/octet-stream').header('x-lut-size', String(l.size)).header('cache-control', 'private, max-age=31536000, immutable').send(f.stream);
  });

  app.post('/api/luts', async (req) => {
    const me = needCap(req, 'edit');
    let file: { name: string; buf: Buffer } | null = null;
    for await (const part of req.parts({ limits: { fileSize: MAX_CUBE_MB * 1024 * 1024 } })) {
      if (part.type === 'field' || file) { if (part.type !== 'field') part.file.resume(); continue; }
      const buf = await part.toBuffer().catch(() => null);
      if (!buf || part.file.truncated) throw new HttpError(413, `That file is larger than the ${MAX_CUBE_MB} MB limit for a .cube file.`);
      file = { name: path.basename(part.filename || 'look.cube'), buf };
    }
    if (!file) throw bad('No file arrived.');
    if (!/\.cube$/i.test(file.name)) throw new HttpError(415, 'That is not a .cube file. Looks of your own are loaded from files that end in .cube.');
    let cube: ReturnType<typeof parseCube>;
    try { cube = parseCube(file.buf.toString('utf8')); } catch (e) { if (e instanceof CubeError) throw new HttpError(415, e.message); throw e; }
    const bin = Buffer.from(cube.data.buffer, cube.data.byteOffset, cube.data.byteLength), sha = crypto.createHash('sha256').update(bin).digest('hex');
    const [same] = await db.select().from(luts).where(and(eq(luts.sha, sha), isNull(luts.removedAt)));
    if (same) throw new HttpError(409, `That table is already here, as “${same.name}”.`);
    const id = crypto.randomUUID(), key = `luts/${id}.f32`;
    const name = (file.name.replace(/\.cube$/i, '').replace(/[_]+/g, ' ').trim() || cube.title || 'Untitled').slice(0, 60);
    await storage.putBuffer(key, bin, 'application/octet-stream');
    const [made] = await db.insert(luts).values({ id, name, size: cube.size, sha, key, addedBy: me.id }).returning();
    return row(made!);
  });

  app.patch('/api/luts/:id', async (req) => {
    needCap(req, 'edit');
    const { name } = z.object({ name: z.string().trim().min(1, 'Give the look a name.').max(60) }).parse(req.body);
    const [l] = await db.update(luts).set({ name }).where(and(eq(luts.id, z.string().uuid().parse((req.params as any).id)), isNull(luts.removedAt))).returning();
    if (!l) throw notFound('That look is gone.');
    return row(l);
  });

  app.delete('/api/luts/:id', async (req) => {
    needCap(req, 'edit');
    const [l] = await db.select().from(luts).where(and(eq(luts.id, z.string().uuid().parse((req.params as any).id)), isNull(luts.removedAt)));
    if (!l) throw notFound('That look is already gone.');
    // Copies in the trash count too: they can be put back.
    const used = (await db.select({ n: sql<number>`count(*)::int` }).from(items).where(sql`${items.recipe}->>'lut' = ${l.id}`))[0]!.n;
    if (used) await db.update(luts).set({ removedAt: new Date() }).where(eq(luts.id, l.id));
    else { await storage.remove([l.key]); await db.delete(luts).where(eq(luts.id, l.id)); }
    return { ok: true, kept: used };
  });
}
