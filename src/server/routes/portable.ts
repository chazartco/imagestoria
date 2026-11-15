import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { needCap, startSession } from '../auth/core.js';
import { type Ctx, HttpError, bad, notFound } from '../context.js';
import { exportKey, exportName, exportState, importLibrary, runExport } from '../portable.js';
import { sendStored } from './items.js';

/**
 * Moving a whole library: the owner makes an export, downloads it, and imports it somewhere else (portable.ts).
 *
 *   GET  /api/admin/exports                 what has been made, and whether one is being made now
 *   POST /api/admin/export                  make one, into the library's own storage under exports/
 *   GET  /api/admin/exports/:name           download one
 *   POST /api/admin/import                  a multipart upload of an export file. ?replace=1&confirm=replace for a library that has pictures
 *   POST /api/admin/import/from-storage     { name, replace, confirm }: a file already under exports/ in this library's storage
 */
export function registerPortable(app: FastifyInstance, ctx: Ctx) {
  const { cfg } = ctx;

  app.get('/api/admin/exports', async (req) => { needCap(req, 'admin'); return exportState(ctx); });

  app.post('/api/admin/export', async (req) => {
    const me = needCap(req, 'admin');
    const b = z.object({ wait: z.boolean().default(false) }).parse(req.body ?? {});
    const run = runExport(ctx, me.name);
    // A large library takes minutes, so the answer does not wait for it: the page asks how it is going. A caller that wants to wait says so.
    const first = b.wait ? await run : await Promise.race([run, new Promise<null>((r) => setTimeout(() => r(null), 400))]);
    if (first && 'busy' in first) throw new HttpError(409, 'An export or an import is already running. Look again in a minute.');
    if (first && !first.ok) throw new HttpError(500, `The export failed. ${first.reason}`);
    if (!first) run.catch((e) => ctx.log.error({ err: e }, 'the export failed'));
    return { started: true, ...(await exportState(ctx)) };
  });

  app.get('/api/admin/exports/:name', async (req: FastifyRequest, reply: FastifyReply) => {
    needCap(req, 'admin');
    const name = exportName((req.params as { name: string }).name);
    if (!(await ctx.storage.exists(exportKey(name)))) throw notFound('That export is gone. Make a new one.');
    return sendStored(ctx, req, reply, exportKey(name), 'application/gzip', name, true);
  });

  /** A library that has pictures is only replaced when the person typed the word. */
  async function mayReplace(replace: boolean, confirm: string) {
    const n = (await ctx.db.execute('select count(*)::int as n from items')).rows[0]!.n as number;
    if (!n) return false;
    if (!replace || confirm.trim().toLowerCase() !== 'replace') throw new HttpError(409, `This library already has ${n} ${n === 1 ? 'item' : 'items'}. Importing replaces everything in it. Type the word replace to go on.`);
    return true;
  }
  async function load(req: FastifyRequest, reply: FastifyReply, file: string, replace: boolean) {
    const me = req.user!;
    const r = await importLibrary(ctx, file, { replace, by: { id: me.id, name: me.name } });
    // Every session ended with the old library. The person who did this stays signed in.
    if (r.userId) await startSession(ctx, req, reply, r.userId);
    return { ok: true, items: r.items, filesChecked: r.filesChecked, filesFound: r.filesFound, sentence: r.sentence, backup: r.backup };
  }

  app.post('/api/admin/import', async (req, reply) => {
    needCap(req, 'admin');
    const query = req.query as { replace?: string; confirm?: string };
    const replace = await mayReplace(query.replace === '1', String(query.confirm ?? ''));
    if (!req.isMultipart()) throw bad('Choose an export file to import.');
    await fsp.mkdir(cfg.tmpDir, { recursive: true });
    const tmp = path.join(cfg.tmpDir, `import-${crypto.randomBytes(8).toString('hex')}.gz`);
    try {
      const part = await req.file();
      if (!part) throw bad('No file arrived.');
      await pipeline(part.file, fs.createWriteStream(tmp));
      if (part.file.truncated) throw new HttpError(413, `That file is larger than the ${cfg.MAX_UPLOAD_MB} MB limit. Put it in the exports folder of this library's storage and import it from there.`);
      return await load(req, reply, tmp, replace);
    } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
  });

  app.post('/api/admin/import/from-storage', async (req, reply) => {
    needCap(req, 'admin');
    const b = z.object({ name: z.string().max(200), replace: z.boolean().default(false), confirm: z.string().max(40).default('') }).parse(req.body);
    const name = exportName(b.name), replace = await mayReplace(b.replace, b.confirm);
    if (!(await ctx.storage.exists(exportKey(name)))) throw notFound(`There is no file called ${name} in the exports folder of this library's storage.`);
    await fsp.mkdir(cfg.tmpDir, { recursive: true });
    const tmp = path.join(cfg.tmpDir, `import-${crypto.randomBytes(8).toString('hex')}.gz`);
    try {
      await ctx.storage.toFile(exportKey(name), tmp);
      return await load(req, reply, tmp, replace);
    } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
  });
}
