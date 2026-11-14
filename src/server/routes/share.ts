import crypto from 'node:crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifyPassword } from '../auth/core.js';
import { type Ctx, HttpError, bad, forbidden, notFound } from '../context.js';
import { schema } from '../db/index.js';
import { receiveUpload, sendStored } from './items.js';
import { MUSIC_VERSION, musicFile } from './music.js';

const { stories, storyItems, storySections, storyLinks, items } = schema;

/**
 * What a visitor with a public link may do. Nobody is signed in here: the link itself is the permission,
 * and it reaches one story and nothing else. Every answer is built from the story's own pictures only.
 *
 *   GET  /api/share/:token                    the story, or { locked: true } when the link asks for a password
 *   POST /api/share/:token/unlock             { password }
 *   GET  /api/share/:token/files/:id/:kind    thumb, display, and for videos the file to play. Originals only if the link allows downloads.
 *   POST /api/share/:token/upload             add a photo or video to the story, if the link allows it
 */
export function registerShare(app: FastifyInstance, ctx: Ctx) {
  const { db, cfg } = ctx;

  async function find(token: string) {
    if (!/^[\w-]{16,80}$/.test(token)) throw notFound('This link does not work. It may have been turned off.');
    const [l] = await db.select().from(storyLinks).where(eq(storyLinks.token, token));
    const [s] = l ? await db.select().from(stories).where(eq(stories.id, l.storyId)) : [];
    if (!l || !s) throw notFound('This link does not work. It may have been turned off.');
    return { l, s };
  }
  /** The proof that a visitor typed the password: it changes when the password does, so old proofs stop working. */
  const proof = (l: typeof storyLinks.$inferSelect) => crypto.createHash('sha256').update(`${l.token}:${l.passwordHash}`).digest('base64url');
  const cookieName = (l: typeof storyLinks.$inferSelect) => `afterimage_share_${l.id.slice(0, 8)}`;
  const open = (req: FastifyRequest, l: typeof storyLinks.$inferSelect) => !l.passwordHash || req.cookies[cookieName(l)] === proof(l);
  async function enter(req: FastifyRequest) {
    const found = await find((req.params as any).token);
    if (!open(req, found.l)) throw new HttpError(401, 'This story is protected by a password.');
    return found;
  }

  app.get('/api/share/:token', async (req) => {
    const { l, s } = await find((req.params as any).token);
    if (!open(req, l)) return { locked: true };
    const rows = (await db.execute(sql`
      select i.id, i.kind, i.status, i.play_status as play, i.width as w, i.height as h, i.duration, to_char(i.taken_at, 'YYYY-MM-DD"T"HH24:MI:SS') as d,
             i.title, i.palette, i.place_id as place, i.file_name as "fileName", si.section_id as "sectionId", si.position
      from story_items si join items i on i.id = si.item_id
      where si.story_id = ${s.id}::uuid and i.deleted_at is null and i.status = 'ready' order by si.position`)).rows as any[];
    const live = new Set(rows.map((r) => r.id as string));
    const secs = await db.select().from(storySections).where(eq(storySections.storyId, s.id)).orderBy(asc(storySections.position));
    let sections: { title: string; text: string; ids: string[] }[] | null = null;
    if (secs.length) {
      sections = secs.map((x) => ({ title: x.title, text: x.text, ids: rows.filter((r) => r.sectionId === x.id).map((r) => r.id as string) }));
      const placed = new Set(sections.flatMap((x) => x.ids)), loose = rows.map((r) => r.id as string).filter((i) => !placed.has(i));
      if (loose.length) sections[sections.length - 1]!.ids.push(...loose);
      sections = sections.filter((x) => x.ids.length);
      if (!sections.length) sections = null;
    }
    const placeIds = [...new Set(rows.map((r) => r.place).filter(Boolean))] as string[];
    const places: Record<string, { name: string; region: string; lat: number; lng: number }> = {};
    if (placeIds.length) for (const p of await db.select().from(schema.places)) if (placeIds.includes(p.id)) places[p.id] = { name: p.name, region: p.region, lat: p.lat, lng: p.lng };
    const covers = (s.coverIds.length ? s.coverIds : s.coverItemId ? [s.coverItemId] : []).filter((c) => live.has(c));
    await db.update(storyLinks).set({ uses: sql`${storyLinks.uses} + 1`, lastUsedAt: new Date() }).where(eq(storyLinks.id, l.id));
    return {
      can: { download: l.allowDownload, add: l.allowAdd }, musicVersion: MUSIC_VERSION,
      limits: { maxUploadMb: cfg.MAX_UPLOAD_MB, displayLongEdge: cfg.DISPLAY_LONG_EDGE, thumbHeight: cfg.THUMB_HEIGHT },
      story: { title: s.title, intro: s.intro, cover: covers[0] ?? null, covers, notes: s.notes, sections, music: s.music, ids: sections ? sections.flatMap((x) => x.ids) : rows.map((r) => r.id) },
      // Only what a reader needs. No tags, comments, likes, camera details or exact coordinates, and a file name only when downloads are allowed.
      items: rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, play: r.play, w: r.w, h: r.h, duration: r.duration, d: r.d, title: r.title, palette: r.palette, place: r.place, fileName: l.allowDownload ? r.fileName : r.kind === 'video' ? 'video' : 'photo' })),
      places: Object.fromEntries(Object.entries(places).map(([k, p]) => [k, { name: p.name, region: p.region, lat: Math.round(p.lat * 10) / 10, lng: Math.round(p.lng * 10) / 10 }])),
    };
  });

  app.post('/api/share/:token/unlock', { config: { rateLimit: { max: 12, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const { l } = await find((req.params as any).token);
    const b = z.object({ password: z.string().max(200) }).parse(req.body);
    if (!l.passwordHash) return { ok: true };
    if (!(await verifyPassword(l.passwordHash, b.password))) throw new HttpError(401, 'That is not the password for this story.');
    reply.setCookie(cookieName(l), proof(l), { path: '/', httpOnly: true, sameSite: 'lax', secure: cfg.secureCookies, maxAge: 30 * 86400 });
    return { ok: true };
  });

  app.get('/api/share/:token/files/:id/:kind', async (req: FastifyRequest, reply: FastifyReply) => {
    const { l, s } = await enter(req);
    const { id, kind } = req.params as { id: string; kind: string };
    const q = req.query as { download?: string };
    if (!z.string().uuid().safeParse(id).success) throw notFound();
    // The picture must be one of this story's own. Anything else in the library does not exist as far as a link is concerned.
    const [row] = await db.select({ it: items }).from(storyItems).innerJoin(items, eq(items.id, storyItems.itemId)).where(and(eq(storyItems.storyId, s.id), eq(storyItems.itemId, id), isNull(items.deletedAt)));
    if (!row) throw notFound('That picture is not part of this story.');
    const it = row.it, download = q.download === '1';
    if (download && !l.allowDownload) throw forbidden('This link does not allow downloads.');
    let key: string | null, type: string;
    if (kind === 'thumb') { key = it.thumbKey; type = 'image/webp'; }
    else if (kind === 'display') { key = it.displayKey; type = 'image/webp'; }
    else if (kind === 'full' || kind === 'orig') {
      // A video has to be fetched to be played. A photo's original is only handed over when the link allows downloads.
      if (it.kind !== 'video' && !l.allowDownload) throw forbidden('This link does not allow the original files.');
      key = kind === 'full' ? it.fullKey ?? it.origKey : it.origKey; type = kind === 'full' && it.fullKey ? 'image/webp' : it.mime;
    } else if (kind === 'play' && it.kind === 'video') { key = it.playKey ?? it.origKey; type = it.playKey ? 'video/mp4' : it.mime; }
    else throw notFound();
    if (!key) throw new HttpError(404, 'This copy is not ready yet.');
    return sendStored(ctx, req, reply, key, type, download ? it.fileName : undefined, false);
  });

  /** The story's music, for the visitor's slideshow. */
  app.get('/api/share/:token/music', async (req: FastifyRequest, reply: FastifyReply) => {
    const { s } = await enter(req);
    if (!s.music) throw notFound('This story has no music.');
    const f = await musicFile(ctx, s.music);
    return sendStored(ctx, req, reply, f.key, f.type, undefined, false);
  });

  /** A visitor adds their own photo or video. It joins the story's space and the end of the story. */
  app.post('/api/share/:token/upload', { config: { rateLimit: { max: 200, timeWindow: '1 hour' } } }, async (req) => {
    const { l, s } = await enter(req);
    if (!l.allowAdd) throw forbidden('This link does not allow adding pictures.');
    const r = await receiveUpload(ctx, req, null, () => s.spaceId);
    const [it] = await db.select({ spaceId: items.spaceId }).from(items).where(eq(items.id, r.id));
    // A file the library already has is not stored twice. If it lives in this story's space it simply joins the story.
    if (!it || it.spaceId !== s.spaceId) throw bad('That file could not be added to this story.');
    const [lastSec] = await db.select({ id: storySections.id }).from(storySections).where(eq(storySections.storyId, s.id)).orderBy(desc(storySections.position)).limit(1);
    const [{ n }] = (await db.select({ n: sql<number>`coalesce(max(${storyItems.position}), 0)::int` }).from(storyItems).where(eq(storyItems.storyId, s.id))) as [{ n: number }];
    await db.insert(storyItems).values({ storyId: s.id, itemId: r.id, sectionId: lastSec?.id ?? null, position: lastSec ? n + 1 : 0 }).onConflictDoNothing();
    await db.insert(schema.activity).values({ userId: null, who: l.label ? `A visitor (${l.label})` : 'A visitor', text: `added a file to the story “${s.title}” through a public link` });
    return { id: r.id, duplicate: r.duplicate ?? false };
  });
}
