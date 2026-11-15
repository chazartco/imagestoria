import crypto from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { logActivity, needCap } from '../auth/core.js';
import { type Ctx, HttpError, bad, notFound } from '../context.js';
import { schema } from '../db/index.js';
import { sendStored } from './items.js';
import { sendStoryFile, sendStoryMusic, visitorStory } from './share.js';

const { stories, storyItems, items, settings } = schema;
type Story = typeof stories.$inferSelect;

/**
 * Published stories: the second and last way into a library without signing in (the first is a share link).
 * A story its owner, or an editor the owner allowed, has published can be read by anyone at the library's own
 * address. Everything here answers with exactly what a share link answers with (visitorStory, sendStoryFile in
 * share.ts), for published stories only, and for nothing else in the library.
 *
 *   GET /api/public                                   the front page: the featured story open, the others as covers
 *   GET /api/public/stories/:slug                     one published story
 *   GET /api/public/stories/:slug/files/:id/:kind     thumb, display, a video's file. Originals only if the story allows downloads.
 *   GET /api/public/stories/:slug/music
 *   GET /robots.txt
 *   GET, PUT /api/admin/public                        the owner's settings for the page
 *
 * The pages themselves (/p and /p/<slug>) are served by app.ts, with what publicHead gives for their <head>.
 */
const SITE = 'public:site';
const NONE = 'There is no public story at this address.';
const NOINDEX = 'noindex, nofollow';
export interface PublicSite { title: string; line: string; index: boolean; logo: string }
const site = z.object({ title: z.string().trim().max(120).default(''), line: z.string().trim().max(300).default(''), index: z.boolean().default(false), logo: z.string().max(200).default('') });
/** Where the page finds the logo. The address changes with the picture, so a browser never shows an old one. */
const logoUrl = (key: string) => (key ? `/api/public/logo?v=${key.replace(/^.*-|\.webp$/g, '')}` : null);

const cache = new WeakMap<Ctx, { at: number; v: PublicSite }>();
export async function publicSite(ctx: Ctx): Promise<PublicSite> {
  const hit = cache.get(ctx);
  if (hit && Date.now() - hit.at < 5000) return hit.v;
  const [row] = await ctx.db.select().from(settings).where(eq(settings.key, SITE));
  const r = site.safeParse(row?.value ?? {}), v = r.success ? r.data : site.parse({});
  cache.set(ctx, { at: Date.now(), v });
  return v;
}

/** Every published story that has at least one picture to show, newest first, each with what its cover needs. */
async function published(ctx: Ctx) {
  const { db } = ctx;
  const all = await db.select().from(stories).where(and(eq(stories.public, true), isNotNull(stories.slug))).orderBy(desc(stories.createdAt)).limit(500);
  if (!all.length) return [];
  const rows = await db.select({ storyId: storyItems.storyId, id: items.id, w: items.width, h: items.height, palette: items.palette, position: storyItems.position, takenAt: items.takenAt })
    .from(storyItems).innerJoin(items, eq(items.id, storyItems.itemId))
    .where(and(inArray(storyItems.storyId, all.map((s) => s.id)), isNull(items.deletedAt), eq(items.status, 'ready')));
  return all.map((s) => {
    const own = rows.filter((r) => r.storyId === s.id).sort((a, b) => a.position - b.position || a.takenAt.getTime() - b.takenAt.getTime());
    const chosen = (s.coverIds.length ? s.coverIds : s.coverItemId ? [s.coverItemId] : []).map((c) => own.find((r) => r.id === c)).filter((r): r is (typeof own)[number] => Boolean(r));
    const covers = (chosen.length ? chosen : own.slice(0, 1)).map((r) => ({ id: r.id, w: r.w, h: r.h, palette: r.palette }));
    return { s, count: own.length, covers };
  }).filter((x) => x.count > 0);
}
export async function hasPublic(ctx: Ctx): Promise<boolean> {
  const [r] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(stories).where(and(eq(stories.public, true), isNotNull(stories.slug)));
  return (r?.n ?? 0) > 0;
}
const validSlug = (slug: string) => /^[a-z0-9][a-z0-9-]{0,79}$/.test(slug);
/** A published story by the name in its address. A private story's name finds nothing, the same as a name nobody uses. */
async function bySlug(ctx: Ctx, slug: string): Promise<Story> {
  const [s] = validSlug(slug) ? await ctx.db.select().from(stories).where(and(eq(stories.slug, slug), eq(stories.public, true))) : [];
  if (!s) throw notFound(NONE);
  return s;
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/**
 * What goes into the <head> of /p and /p/<slug>, and whether search engines are asked to stay away.
 * A preview (Open Graph) is only written when the owner lets search engines list the page.
 */
export async function publicHead(ctx: Ctx, slug: string | null): Promise<{ noindex: boolean; tags: string }> {
  // The page as built already carries <meta name="robots" content="noindex, nofollow">. app.ts takes it out only when listing is on.
  const st = await publicSite(ctx), off = { noindex: true, tags: '' };
  if (!st.index) return off;
  const list = await published(ctx);
  const open = slug === null ? list.find((x) => x.s.featured) ?? list[0] : list.find((x) => x.s.slug === slug);
  if (!open) return off;
  const base = ctx.cfg.PUBLIC_URL, url = slug === null ? `${base}/p` : `${base}/p/${open.s.slug}`;
  const title = slug === null ? st.title || open.s.title : open.s.title, about = (slug === null ? st.line || open.s.intro : open.s.intro).replace(/\s+/g, ' ').trim().slice(0, 300);
  const tags = [
    `<link rel="canonical" href="${esc(url)}">`, `<meta property="og:type" content="article">`, `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:title" content="${esc(title)}">`, about ? `<meta property="og:description" content="${esc(about)}">` : '', about ? `<meta name="description" content="${esc(about)}">` : '',
    open.covers[0] ? `<meta property="og:image" content="${esc(`${base}/p/${open.s.slug}/cover`)}">` : '', `<meta name="twitter:card" content="${open.covers[0] ? 'summary_large_image' : 'summary'}">`,
  ].filter(Boolean).join('');
  return { noindex: false, tags };
}

export function registerPublic(app: FastifyInstance, ctx: Ctx) {
  const { db, cfg } = ctx;
  // These routes are open to the world, so each address may only ask so often.
  const pages = { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, files = { config: { rateLimit: { max: 1800, timeWindow: '1 minute' } } };
  const robots = async (reply: FastifyReply) => { if (!(await publicSite(ctx)).index) reply.header('x-robots-tag', NOINDEX); };

  async function answer(open: Awaited<ReturnType<typeof published>>[number], list: Awaited<ReturnType<typeof published>>) {
    const st = await publicSite(ctx);
    return {
      site: { title: st.title, line: st.line, logo: logoUrl(st.logo) }, slug: open.s.slug, featured: open.s.featured,
      ...(await visitorStory(ctx, open.s, { download: open.s.publicDownload, add: false })),
      // The other published stories, as covers. Nothing here that the stories themselves do not give.
      others: list.filter((x) => x !== open).map((x) => ({ slug: x.s.slug, title: x.s.title, count: x.count, covers: x.covers })),
    };
  }
  app.get('/api/public', pages, async (_req, reply) => {
    await robots(reply);
    const list = await published(ctx);
    if (!list.length) throw notFound('Nothing is published here.');
    return answer(list.find((x) => x.s.featured) ?? list[0]!, list);
  });
  app.get('/api/public/stories/:slug', pages, async (req, reply) => {
    await robots(reply);
    const slug = String((req.params as { slug: string }).slug), list = await published(ctx), open = validSlug(slug) ? list.find((x) => x.s.slug === slug) : undefined;
    if (!open) throw notFound(NONE);
    return answer(open, list);
  });
  app.get('/api/public/stories/:slug/files/:id/:kind', files, async (req: FastifyRequest, reply: FastifyReply) => {
    await robots(reply);
    const { slug, id, kind } = req.params as { slug: string; id: string; kind: string };
    const s = await bySlug(ctx, slug);
    return sendStoryFile(ctx, req, reply, s, id, kind, s.publicDownload, 'This story');
  });
  app.get('/api/public/stories/:slug/music', files, async (req: FastifyRequest, reply: FastifyReply) => {
    await robots(reply);
    return sendStoryMusic(ctx, req, reply, await bySlug(ctx, (req.params as { slug: string }).slug));
  });
  /** The picture a shared link shows as its preview: the first picture of the story's cover, through the same checks as any other. */
  app.get('/p/:slug/cover', files, async (req: FastifyRequest, reply: FastifyReply) => {
    await robots(reply);
    const slug = String((req.params as { slug: string }).slug), open = validSlug(slug) ? (await published(ctx)).find((x) => x.s.slug === slug) : undefined;
    if (!open?.covers[0]) throw notFound(NONE);
    return sendStoryFile(ctx, req, reply, open.s, open.covers[0].id, 'display', false, 'This story');
  });

  /** The library's own logo at the top of its public page. It is there for anyone, and only while something is published. */
  app.get('/api/public/logo', files, async (req: FastifyRequest, reply: FastifyReply) => {
    await robots(reply);
    const st = await publicSite(ctx);
    if (!st.logo || !(await hasPublic(ctx))) throw notFound('There is no logo here.');
    return sendStored(ctx, req, reply, st.logo, 'image/webp', undefined, true);
  });

  app.get('/robots.txt', pages, async (_req, reply) => {
    const listed = (await publicSite(ctx)).index;
    return reply.type('text/plain; charset=utf-8').header('cache-control', 'no-cache').send(listed ? 'User-agent: *\nAllow: /p$\nAllow: /p/\nDisallow: /\n' : 'User-agent: *\nDisallow: /\n');
  });

  /* ---------- the owner's settings for the page ---------- */
  const state = async () => { const { logo, ...st } = await publicSite(ctx); return { ...st, logo: logoUrl(logo), ...(await counts()) }; };
  const counts = async () => ({ url: `${cfg.PUBLIC_URL}/p`, count: (await db.select({ n: sql<number>`count(*)::int` }).from(stories).where(and(eq(stories.public, true), isNotNull(stories.slug))))[0]!.n });
  app.get('/api/admin/public', async (req) => { needCap(req, 'admin'); return state(); });
  app.put('/api/admin/public', async (req) => {
    const me = needCap(req, 'admin');
    const b = z.object({ title: z.string().trim().max(120).optional(), line: z.string().trim().max(300).optional(), index: z.boolean().optional() }).parse(req.body ?? {});
    const was = await publicSite(ctx), next = { ...was, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
    await db.insert(settings).values({ key: SITE, value: next }).onConflictDoUpdate({ target: settings.key, set: { value: next } });
    cache.delete(ctx);
    if (next.index !== was.index) await logActivity(ctx, me, next.index ? 'let search engines list the public page' : 'stopped search engines listing the public page');
    return state();
  });
  /**
   * The logo: a small picture of the owner's own. It is kept whole, in its own shape, made to fit inside 480 by 240 and never
   * enlarged. It is not a library picture: it lives beside them in storage and is public while the page is.
   */
  const setLogo = async (key: string) => {
    const was = await publicSite(ctx), next = { ...was, logo: key };
    await db.insert(settings).values({ key: SITE, value: next }).onConflictDoUpdate({ target: settings.key, set: { value: next } });
    cache.delete(ctx);
    if (was.logo && was.logo !== key) await ctx.storage.remove([was.logo]).catch(() => {});
  };
  app.post('/api/admin/public/logo', async (req) => {
    const me = needCap(req, 'admin');
    let buf: Buffer | null = null;
    for await (const part of req.parts({ limits: { fileSize: 10 * 1024 * 1024 } })) {
      if (part.type === 'field' || buf) { if (part.type !== 'field') part.file.resume(); continue; }
      buf = await part.toBuffer().catch(() => null);
      if (!buf || part.file.truncated) throw new HttpError(413, 'That picture is larger than 10 MB. Choose a smaller one.');
    }
    if (!buf) throw bad('No picture arrived.');
    let out: Buffer;
    try { out = await sharp(buf, { density: 300 }).rotate().resize(480, 240, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer(); }
    catch { throw new HttpError(415, 'That file could not be read as a picture. Use a PNG, SVG, JPEG or WebP.'); }
    const key = `public/logo-${crypto.randomBytes(6).toString('hex')}.webp`;
    await ctx.storage.putBuffer(key, out, 'image/webp');
    await setLogo(key);
    await logActivity(ctx, me, 'changed the logo of the public page');
    return state();
  });
  app.delete('/api/admin/public/logo', async (req) => {
    const me = needCap(req, 'admin');
    await setLogo('');
    await logActivity(ctx, me, 'took the logo off the public page');
    return state();
  });
}
