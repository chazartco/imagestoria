import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { loadUser } from './auth/core.js';
import type { Config } from './config.js';
import { type Ctx, HttpError } from './context.js';
import type { Db } from './db/index.js';
import { startWorker } from './jobs.js';
import { createMailer } from './mail.js';
import { registerAdmin } from './routes/admin.js';
import { registerAuth } from './routes/auth.js';
import { registerItems } from './routes/items.js';
import { registerLuts } from './routes/luts.js';
import { registerMusic } from './routes/music.js';
import { registerShare } from './routes/share.js';
import { registerStories } from './routes/stories.js';
import { registerWorker } from './routes/worker.js';
import { registerSearch } from './routes/search.js';
import { registerFaces } from './routes/faces.js';
import { registerPlaces } from './routes/places.js';
import { EmbedIndex, makeTextEmbedder } from './ai/embed.js';
import type { Storage } from './storage/index.js';
import { startBackupSchedule } from './backup.js';
import { startTrashPass } from './trash.js';

export async function buildApp(cfg: Config, db: Db, storage: Storage): Promise<{ app: FastifyInstance; ctx: Ctx; worker: ReturnType<typeof startWorker> }> {
  const app = Fastify({ logger: { level: cfg.LOG_LEVEL }, trustProxy: cfg.TRUST_PROXY, bodyLimit: 2 << 20 });
  const ctx = { cfg, db, storage, mail: createMailer(cfg), log: app.log, kick: () => {} } as Ctx;
  const text = makeTextEmbedder(ctx);
  ctx.embeds = new EmbedIndex(ctx); ctx.embedText = cfg.EMBED_TEXT ? text.embed : null; ctx.textStatus = text.status;
  const worker = startWorker(ctx, cfg.INGEST_CONCURRENCY);
  ctx.kick = () => worker.kick();
  const stopTrashPass = startTrashPass(ctx), stopBackups = startBackupSchedule(ctx);

  await app.register(cookie);
  await app.register(compress, { global: true, threshold: 2048 });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10 } });

  app.addHook('onClose', async () => { stopTrashPass(); stopBackups(); });
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'same-origin').header('x-frame-options', 'DENY');
    if (!req.url.startsWith('/api/')) return;
    // A worker on the owner's machine is not a browser: it signs in with its own token on every request, and is nobody anywhere else.
    if (req.url.startsWith('/api/worker/')) return;
    // Changes must come from our own page. Browsers will not let another site add this header
    // to a request without asking first, and this app never grants that permission.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-afterimage'] !== '1') {
      return reply.code(403).send({ error: 'This request did not come from the ImageStoria page.' });
    }
    req.user = await loadUser(ctx, req);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues[0]?.message ?? 'That request is not valid.' });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: `That file is larger than the ${cfg.MAX_UPLOAD_MB} MB limit.` });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'Something went wrong on the server. The details are in its log.' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  registerAuth(app, ctx);
  registerItems(app, ctx);
  registerStories(app, ctx);
  registerShare(app, ctx);
  registerMusic(app, ctx);
  registerLuts(app, ctx);
  registerAdmin(app, ctx);
  registerWorker(app, ctx);
  registerSearch(app, ctx);
  registerFaces(app, ctx);
  registerPlaces(app, ctx);
  app.all('/api/*', async (_req, reply) => reply.code(404).send({ error: 'No such endpoint.' }));

  // The front end: plain files built by scripts/build-web.mjs.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webRoot = [path.resolve(here, '../web'), path.resolve(here, '../../dist/web')].find((p) => fs.existsSync(path.join(p, 'assets', 'app.js')));
  if (webRoot) {
    // Map tiles normally come over https. A tile server on plain http (one on your own network) is allowed by name.
    const plainMapHosts = [...new Set([cfg.MAP_STYLE_DARK, cfg.MAP_STYLE_LIGHT, cfg.MAP_STYLE_FALLBACK].filter((u) => u.startsWith('http://')).map((u) => new URL(u).origin))].join(' ');
    // The same for a bucket reached over plain http (MinIO on your own network). DigitalOcean Spaces and AWS are https.
    let plainBucket = '';
    if (cfg.STORAGE_DRIVER === 's3' && cfg.S3_ENDPOINT.startsWith('http://')) { const u = new URL(cfg.S3_ENDPOINT); plainBucket = `${u.origin} http://*.${u.host}`; }
    const csp = ["default-src 'self'", `img-src 'self' data: blob: https: ${plainMapHosts} ${plainBucket}`.replace(/\s+/g, ' ').trim(), `media-src 'self' blob: https: ${plainBucket}`.trim(), "style-src 'self' 'unsafe-inline'", "script-src 'self'", 'worker-src blob:', "child-src blob:", `connect-src 'self' https: ${plainMapHosts}`.trim(), "font-src 'self' data:", "manifest-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"].join('; ');
    await app.register(fastifyStatic, {
      root: webRoot,
      setHeaders(res, file) {
        if (file.endsWith('index.html')) res.header('cache-control', 'no-cache').header('content-security-policy', csp);
        else res.header('cache-control', 'public, max-age=3600');
        if (file.endsWith('.webmanifest')) res.header('content-type', 'application/manifest+json; charset=utf-8');
      },
    });
    app.setNotFoundHandler((req, reply) => (req.method === 'GET' && !req.url.startsWith('/api/') ? reply.header('content-security-policy', csp).header('cache-control', 'no-cache').sendFile('index.html') : reply.code(404).send({ error: 'Not found.' })));
  } else {
    app.log.warn('No built front end found. Run "npm run build:web".');
  }
  return { app, ctx, worker };
}
