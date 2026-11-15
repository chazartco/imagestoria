import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { hashPassword, logActivity, need, needCap, needSpace } from '../auth/core.js';
import { type Ctx, bad, forbidden, notFound } from '../context.js';
import { schema } from '../db/index.js';
import { REEL_SIZES } from '../media/reel.js';
import { sendStored } from './items.js';
import { musicExists } from './music.js';

const uuid = z.string().uuid();
const { stories, storyItems, storySections, storyLinks, reels, items } = schema;

export function registerStories(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  /** Owner and editors read every story in their spaces. Everyone else reads the ones shared with them. */
  const canRead = (req: FastifyRequest, s: typeof stories.$inferSelect) => {
    const me = need(req);
    return me.spaceIds.includes(s.spaceId) && (me.role === 'owner' || me.role === 'editor' || s.sharedWith.includes(me.id) || s.createdBy === me.id);
  };
  async function load(req: FastifyRequest, id: string) {
    const [s] = await db.select().from(stories).where(eq(stories.id, uuid.parse(id)));
    if (!s || !canRead(req, s)) throw notFound('That story is gone.');
    return s;
  }
  /** Owners and editors of the space may change any story in it. So may whoever made it, while they may still edit. */
  const canChange = (req: FastifyRequest, s: typeof stories.$inferSelect) => {
    const me = req.user!;
    return me.spaceIds.includes(s.spaceId) && (me.role === 'owner' || me.role === 'editor' || (me.caps.edit && s.createdBy === me.id));
  };
  const cleanGroups = (g: string[]) => [...new Map(g.map((x) => x.trim().replace(/\s+/g, ' ').slice(0, 40)).filter(Boolean).map((x) => [x.toLowerCase(), x])).values()].slice(0, 20);

  /**
   * Each story with the ids of its pictures.
   * A story with no sections arranges itself: the page orders its pictures by date and splits them into parts.
   * A story with sections comes back with them, and "ids" follows the author's order.
   * Pictures in the trash are left out everywhere, so a deleted cover picture simply drops out.
   */
  app.get('/api/stories', async (req) => {
    const me = need(req);
    if (!me.spaceIds.length) return { stories: [] };
    const all = await db.select().from(stories).where(inArray(stories.spaceId, me.spaceIds)).orderBy(desc(stories.createdAt));
    const mine = all.filter((s) => canRead(req, s));
    if (!mine.length) return { stories: [] };
    const storyIds = mine.map((s) => s.id);
    const links = await db.select({ storyId: storyItems.storyId, itemId: storyItems.itemId, sectionId: storyItems.sectionId, position: storyItems.position })
      .from(storyItems).innerJoin(items, eq(items.id, storyItems.itemId)).where(and(inArray(storyItems.storyId, storyIds), isNull(items.deletedAt))).orderBy(asc(storyItems.position));
    const secs = await db.select().from(storySections).where(inArray(storySections.storyId, storyIds)).orderBy(asc(storySections.position));
    return {
      stories: mine.map((s) => {
        const own = links.filter((l) => l.storyId === s.id), live = new Set(own.map((l) => l.itemId));
        const mySecs = secs.filter((x) => x.storyId === s.id);
        let sections: { title: string; text: string; ids: string[] }[] | null = null, ids = own.map((l) => l.itemId);
        if (mySecs.length) {
          sections = mySecs.map((x) => ({ title: x.title, text: x.text, ids: own.filter((l) => l.sectionId === x.id).map((l) => l.itemId) }));
          // A picture with no section (its section could not be matched) goes to the end rather than vanishing.
          const placed = new Set(sections.flatMap((x) => x.ids)), loose = ids.filter((i) => !placed.has(i));
          if (loose.length) sections[sections.length - 1]!.ids.push(...loose);
          sections = sections.filter((x) => x.ids.length);
          if (!sections.length) sections = null; else ids = sections.flatMap((x) => x.ids);
        }
        const chosen = (s.coverIds.length ? s.coverIds : s.coverItemId ? [s.coverItemId] : []).filter((c) => live.has(c));
        return { id: s.id, space: s.spaceId, title: s.title, intro: s.intro, cover: chosen[0] ?? null, covers: chosen, notes: s.notes, sections, shared: s.sharedWith, groups: s.groups, music: s.music, by: s.createdBy, made: s.createdAt.getTime(), ids, public: s.public, featured: s.featured, slug: s.slug };
      }),
    };
  });

  app.post('/api/stories', async (req) => {
    const me = needCap(req, 'edit');
    const b = z.object({ title: z.string().trim().min(1).max(200), spaceId: uuid, ids: z.array(uuid).min(1).max(2000), cover: uuid.optional(), groups: z.array(z.string().max(60)).max(20).optional() }).parse(req.body);
    needSpace(req, b.spaceId);
    const ok = await db.select({ id: items.id }).from(items).where(and(inArray(items.id, b.ids), eq(items.spaceId, b.spaceId), isNull(items.deletedAt)));
    if (!ok.length) throw bad('None of those items are in this space.');
    const ids = ok.map((r) => r.id);
    const cover = b.cover && ids.includes(b.cover) ? b.cover : ids[0]!;
    const [s] = await db.insert(stories).values({ title: b.title, spaceId: b.spaceId, createdBy: me.id, coverItemId: cover, coverIds: [cover], groups: cleanGroups(b.groups ?? []) }).returning();
    await db.insert(storyItems).values(ids.map((itemId) => ({ storyId: s!.id, itemId })));
    await logActivity(ctx, me, `made the story “${b.title}”`);
    return { id: s!.id };
  });

  const section = z.object({ title: z.string().max(200).default(''), text: z.string().max(8000).default(''), ids: z.array(uuid).min(1).max(2000) });
  app.patch('/api/stories/:id', async (req) => {
    const s = await load(req, (req.params as any).id);
    if (!canChange(req, s)) throw forbidden();
    const b = z.object({
      title: z.string().trim().min(1).max(200).optional(), intro: z.string().max(5000).optional(), cover: uuid.optional(),
      /** One to four pictures of this story, in the order they should show. */
      covers: z.array(uuid).min(1).max(4).optional(),
      notes: z.record(z.string().max(60), z.string().max(8000)).optional(), shared: z.array(uuid).max(500).optional(),
      groups: z.array(z.string().max(60)).max(20).optional(), music: z.string().max(80).nullable().optional(),
      /** The whole structure, as the author arranged it. null goes back to arranging by date. */
      sections: z.array(section).min(1).max(300).nullable().optional(),
      /** Pictures to take out of the story. They stay in the library. */
      remove: z.array(uuid).min(1).max(2000).optional(),
      /** Pictures to put into the story, from the same space. This is how a removal is undone. */
      add: z.array(uuid).min(1).max(2000).optional(),
    }).parse(req.body);
    const had = (await db.select({ itemId: storyItems.itemId }).from(storyItems).where(eq(storyItems.storyId, s.id))).map((r) => r.itemId);
    let adding: string[] = [];
    if (b.add) {
      const ok = await db.select({ id: items.id }).from(items).where(and(inArray(items.id, b.add), eq(items.spaceId, s.spaceId), isNull(items.deletedAt)));
      adding = ok.map((r) => r.id).filter((id) => !had.includes(id));
    }
    const gone = new Set(b.remove ?? []);
    // What the story holds once this request is done. Everything below is checked against that.
    const mine = [...had, ...adding].filter((id) => !gone.has(id));
    if (b.remove) {
      const live = await db.select({ id: items.id }).from(items).where(and(inArray(items.id, mine.length ? mine : ['00000000-0000-0000-0000-000000000000']), isNull(items.deletedAt)));
      if (!live.length) throw bad('A story needs at least one picture. Delete the story to remove them all.');
    }
    const set: Partial<typeof stories.$inferInsert> = {};
    if (b.title !== undefined) set.title = b.title;
    if (b.intro !== undefined) set.intro = b.intro;
    const covers = b.covers ?? (b.cover ? [b.cover] : undefined);
    if (covers) {
      if (new Set(covers).size !== covers.length || covers.some((c) => !mine.includes(c))) throw bad('A cover is made of pictures from the story itself, each one once.');
      set.coverIds = covers; set.coverItemId = covers[0]!;
    }
    if (b.notes !== undefined) set.notes = { ...s.notes, ...b.notes };
    if (b.shared !== undefined) set.sharedWith = b.shared;
    if (b.groups !== undefined) set.groups = cleanGroups(b.groups);
    if (b.music !== undefined) { if (b.music && !(await musicExists(ctx, b.music))) throw bad('That track is gone. Choose another one.'); set.music = b.music || null; }
    if (b.sections) {
      const listed = b.sections.flatMap((x) => x.ids);
      if (new Set(listed).size !== listed.length || listed.some((i) => !mine.includes(i))) throw bad('That arrangement does not match the pictures in the story. Reload the page and try again.');
    }
    // A picture that leaves the story leaves its cover too.
    if (gone.size && !covers) {
      const kept = s.coverIds.filter((c) => !gone.has(c));
      if (kept.length !== s.coverIds.length || (s.coverItemId && gone.has(s.coverItemId))) { set.coverIds = kept; set.coverItemId = kept[0] ?? null; }
    }
    await db.transaction(async (tx) => {
      if (adding.length) {
        // Into the last section when the story has sections, so a picture is never left without one.
        const [lastSec] = await tx.select({ id: storySections.id }).from(storySections).where(eq(storySections.storyId, s.id)).orderBy(desc(storySections.position)).limit(1);
        await tx.insert(storyItems).values(adding.map((itemId, n) => ({ storyId: s.id, itemId, sectionId: lastSec?.id ?? null, position: lastSec ? 200000 + n : 0 }))).onConflictDoNothing();
      }
      if (gone.size) {
        await tx.delete(storyItems).where(and(eq(storyItems.storyId, s.id), inArray(storyItems.itemId, [...gone])));
        // A section with nothing left in it goes too.
        await tx.execute(sql`delete from story_sections ss where ss.story_id = ${s.id}::uuid and not exists (select 1 from story_items si where si.section_id = ss.id)`);
      }
      if (Object.keys(set).length) await tx.update(stories).set(set).where(eq(stories.id, s.id));
      if (b.sections === undefined) return;
      // The page always sends the whole arrangement, so it is replaced as a whole. The author's notes
      // for the automatic parts stay in stories.notes and come back if the story returns to automatic.
      await tx.delete(storySections).where(eq(storySections.storyId, s.id));
      await tx.update(storyItems).set({ sectionId: null, position: 0 }).where(eq(storyItems.storyId, s.id));
      if (b.sections === null) return;
      const made = await tx.insert(storySections).values(b.sections.map((x, k) => ({ storyId: s.id, position: k, title: x.title.trim(), text: x.text }))).returning({ id: storySections.id, position: storySections.position });
      const idAt = new Map(made.map((m) => [m.position, m.id]));
      const rows = b.sections.flatMap((x, k) => x.ids.map((item, n) => ({ item, sid: idAt.get(k)!, pos: n })));
      // Pictures the page did not list (they are in the trash, so it cannot see them) go to the end of the last section.
      const last = b.sections.length - 1, listed = new Set(rows.map((r) => r.item));
      mine.filter((i) => !listed.has(i)).forEach((item, n) => rows.push({ item, sid: idAt.get(last)!, pos: 100000 + n }));
      for (let i = 0; i < rows.length; i += 1000) {
        const values = sql.join(rows.slice(i, i + 1000).map((r) => sql`(${r.item}::uuid, ${r.sid}::uuid, ${r.pos}::int)`), sql`, `);
        await tx.execute(sql`update story_items si set section_id = v.sid, position = v.pos from (values ${values}) as v(item, sid, pos) where si.story_id = ${s.id}::uuid and si.item_id = v.item`);
      }
    });
    return { ok: true };
  });

  /**
   * Who can read this story, for the people who may change it: every person, whether they can open
   * the story's space, whether they always read it (owners and editors), and whether it is shared with them.
   */
  app.get('/api/stories/:id/access', async (req) => {
    const s = await load(req, (req.params as any).id);
    if (!canChange(req, s)) throw forbidden();
    const people = await db.select().from(schema.users);
    const members = await db.select().from(schema.spaceMembers).where(eq(schema.spaceMembers.spaceId, s.spaceId));
    return {
      people: people.filter((u) => u.status !== 'disabled').map((u) => {
        const inSpace = u.role === 'owner' || members.some((m) => m.userId === u.id);
        return { id: u.id, name: u.name, color: u.color, role: u.role, pending: u.status === 'pending', inSpace, always: inSpace && (u.role === 'owner' || u.role === 'editor'), shared: s.sharedWith.includes(u.id) };
      }),
      links: (await db.select().from(storyLinks).where(eq(storyLinks.storyId, s.id)).orderBy(asc(storyLinks.createdAt))).map(publicLink),
      published: published(s), mayPublish: req.user!.caps.publish,
    };
  });

  /* ---------- publishing: the story on the library's public page ---------- */

  const published = (s: typeof stories.$inferSelect) => ({ public: s.public, featured: s.featured, allowDownload: s.publicDownload, slug: s.slug, url: s.slug ? `${ctx.cfg.PUBLIC_URL}/p/${s.slug}` : null });
  const slugOf = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  /**
   * Publish a story, or change how it is published. Owners always may. An editor may when the owner turned
   * "Publish stories" on for them. Publishing never makes or changes a share link.
   */
  app.patch('/api/stories/:id/public', async (req) => {
    const me = needCap(req, 'publish');
    const s = await load(req, (req.params as any).id);
    if (!canChange(req, s)) throw forbidden();
    const b = z.object({ public: z.boolean().optional(), featured: z.boolean().optional(), allowDownload: z.boolean().optional(), slug: z.string().trim().min(1).max(120).optional() }).parse(req.body ?? {});
    const on = b.public ?? s.public;
    if (b.featured && !on) throw bad('Publish the story before you feature it.');
    const taken = async (slug: string) => (await db.select({ id: stories.id }).from(stories).where(and(eq(stories.slug, slug), sql`${stories.id} <> ${s.id}::uuid`))).length > 0;
    let slug = s.slug;
    if (b.slug !== undefined) {
      const want = slugOf(b.slug);
      if (!want) throw bad('Use letters and numbers for the address.');
      if (want !== s.slug && (await taken(want))) throw bad('Another story already uses that address. Choose a different one.');
      slug = want;
    }
    // The address is made from the title the first time the story is published, and then stays as it is.
    if (on && !slug) { const base = slugOf(s.title) || 'story'; slug = base; for (let i = 2; await taken(slug); i++) slug = `${base}-${i}`; }
    const set = { public: on, featured: on ? b.featured ?? s.featured : false, publicDownload: b.allowDownload ?? s.publicDownload, slug };
    try {
      await db.transaction(async (tx) => {
        // At most one featured story in the library: this one statement sets it here and clears it everywhere else.
        if (set.featured && !s.featured) await tx.execute(sql`update stories set featured = (id = ${s.id}::uuid) where featured or id = ${s.id}::uuid`);
        await tx.update(stories).set(set).where(eq(stories.id, s.id));
      });
    } catch (e: any) {
      if ((e?.code ?? e?.cause?.code) === '23505') throw bad('Another story already uses that address. Choose a different one.');
      throw e;
    }
    if (on !== s.public) await logActivity(ctx, me, on ? `published the story “${s.title}” on the public page` : `took the story “${s.title}” off the public page`);
    return published({ ...s, ...set });
  });

  /* ---------- reels: the story as a video file ---------- */

  const publicReel = (r: typeof reels.$inferSelect) => ({ id: r.id, story: r.storyId, title: r.title, covers: r.coverIds, count: r.itemIds.length, by: r.createdBy, format: r.format, music: r.music, secondsPerPhoto: r.secondsPerPhoto, status: r.status, progress: r.progress, error: r.error, bytes: r.bytes, seconds: r.duration, made: r.createdAt.getTime() });
  app.get('/api/stories/:id/reels', async (req) => {
    const s = await load(req, (req.params as any).id);
    return { reels: (await db.select().from(reels).where(eq(reels.storyId, s.id)).orderBy(desc(reels.createdAt))).map(publicReel), sizes: REEL_SIZES, videoMaxSeconds: ctx.cfg.REEL_VIDEO_MAX_SECONDS, maxItems: ctx.cfg.REEL_MAX_ITEMS };
  });
  /** Ask for a reel. It is made in the background, and the list above says how far along it is. */
  app.post('/api/stories/:id/reels', async (req) => {
    const s = await load(req, (req.params as any).id);
    if (!canChange(req, s)) throw forbidden();
    const b = z.object({ format: z.enum(['9:16', '16:9']), music: z.string().max(80).nullable().optional(), secondsPerPhoto: z.number().min(1.5).max(10).default(3.5) }).parse(req.body);
    const music = b.music === undefined ? s.music : b.music || null;
    if (music && !(await musicExists(ctx, music))) throw bad('That track is gone. Choose another one.');
    const waiting = await db.select({ id: reels.id }).from(reels).where(and(eq(reels.storyId, s.id), inArray(reels.status, ['queued', 'running'])));
    if (waiting.length >= 2) throw bad('Two reels of this story are already being made. Wait for one of them to finish.');
    const [r] = await db.insert(reels).values({ storyId: s.id, format: b.format, music, secondsPerPhoto: b.secondsPerPhoto, createdBy: req.user!.id }).returning();
    await db.insert(schema.jobs).values({ type: 'reel', payload: { reelId: r!.id } });
    ctx.kick();
    await logActivity(ctx, req.user!, `made a ${b.format} reel of the story “${s.title}”`);
    return publicReel(r!);
  });
  /**
   * Reels made straight from pictures chosen in the library, with no story behind them.
   * They belong to a space. Whoever may see the space may watch them. Owners and editors of the space, and whoever
   * made the reel while they may still edit, may delete them.
   */
  app.post('/api/reels', async (req) => {
    const me = needCap(req, 'edit');
    const b = z.object({ ids: z.array(uuid).min(1).max(ctx.cfg.REEL_MAX_ITEMS, `A reel takes up to ${ctx.cfg.REEL_MAX_ITEMS} items.`), covers: z.array(uuid).max(4).default([]), title: z.string().trim().max(120).default(''),
      format: z.enum(['9:16', '16:9']), music: z.string().max(80).nullable().optional(), secondsPerPhoto: z.number().min(1.5).max(10).default(3.5) }).parse(req.body);
    const ids = [...new Set(b.ids)];
    const rows = await db.select({ id: items.id, spaceId: items.spaceId, status: items.status }).from(items).where(and(inArray(items.id, ids), isNull(items.deletedAt)));
    if (rows.length !== ids.length) throw bad('Some of those pictures are gone. Choose again.');
    const spaceId = rows[0]!.spaceId;
    if (rows.some((r) => r.spaceId !== spaceId)) throw bad('A reel is made from the pictures of one space.');
    needSpace(req, spaceId);
    if (rows.some((r) => r.status !== 'ready')) throw bad('Some of those are still being processed. Try again in a moment.');
    const covers = [...new Set(b.covers)]; if (covers.some((c) => !ids.includes(c))) throw bad('The cover pictures must be among the pictures of the reel.');
    const music = b.music || null;
    if (music && !(await musicExists(ctx, music))) throw bad('That track is gone. Choose another one.');
    const waiting = await db.select({ id: reels.id }).from(reels).where(and(isNull(reels.storyId), eq(reels.createdBy, me.id), inArray(reels.status, ['queued', 'running'])));
    if (waiting.length >= 3) throw bad('Three of your reels are already being made. Wait for one of them to finish.');
    const [r] = await db.insert(reels).values({ storyId: null, spaceId, itemIds: ids, coverIds: covers, title: b.title, format: b.format, music, secondsPerPhoto: b.secondsPerPhoto, createdBy: me.id }).returning();
    await db.insert(schema.jobs).values({ type: 'reel', payload: { reelId: r!.id } });
    ctx.kick();
    await logActivity(ctx, me, `made a ${b.format} reel ${b.title ? `“${b.title}” ` : ''}from ${ids.length} ${ids.length === 1 ? 'item' : 'items'} in the library`);
    return publicReel(r!);
  });

  /** Every reel of one space that this person may watch: the ones made from stories they can read, and the ones made from the library. */
  app.get('/api/reels', async (req) => {
    const spaceId = uuid.parse((req.query as any).space); needSpace(req, spaceId);
    const readable = (await db.select().from(stories).where(eq(stories.spaceId, spaceId))).filter((s) => canRead(req, s)), byId = new Map(readable.map((s) => [s.id, s]));
    const all = await db.select().from(reels).where(or(eq(reels.spaceId, spaceId), readable.length ? inArray(reels.storyId, readable.map((s) => s.id)) : sql`false`)).orderBy(desc(reels.createdAt));
    const counts = readable.length ? await db.select({ storyId: storyItems.storyId, n: sql<number>`count(*)::int` }).from(storyItems).innerJoin(items, eq(items.id, storyItems.itemId)).where(and(inArray(storyItems.storyId, readable.map((s) => s.id)), isNull(items.deletedAt))).groupBy(storyItems.storyId) : [];
    return {
      reels: all.map((r) => {
        const s = r.storyId ? byId.get(r.storyId) : null, mayDelete = s ? canChange(req, s) : canDrop(req, r);
        return { ...publicReel(r), title: s ? s.title : r.title, covers: s ? [...s.coverIds, s.coverItemId].filter((x): x is string => !!x).filter((x, i, a) => a.indexOf(x) === i).slice(0, 4) : r.coverIds, first: s ? null : r.itemIds[0] ?? null,
          count: s ? counts.find((c) => c.storyId === s.id)?.n ?? 0 : r.itemIds.length, from: s ? 'story' : 'library', mayDelete };
      }),
      sizes: REEL_SIZES, videoMaxSeconds: ctx.cfg.REEL_VIDEO_MAX_SECONDS, maxItems: ctx.cfg.REEL_MAX_ITEMS,
    };
  });
  const canDrop = (req: FastifyRequest, r: typeof reels.$inferSelect) => { const me = req.user!; return !!r.spaceId && me.spaceIds.includes(r.spaceId) && (me.role === 'owner' || me.role === 'editor' || (me.caps.edit && r.createdBy === me.id)); };

  async function loadReel(req: FastifyRequest, id: string) {
    const [r] = await db.select().from(reels).where(eq(reels.id, uuid.parse(id)));
    if (!r) throw notFound('That reel is gone.');
    if (r.storyId) return { r, s: await load(req, r.storyId) };
    if (!r.spaceId) throw notFound('That reel is gone.');
    needSpace(req, r.spaceId);
    return { r, s: null };
  }
  app.get('/api/reels/:id/file', async (req: FastifyRequest, reply: FastifyReply) => {
    const { r, s } = await loadReel(req, (req.params as any).id);
    if (r.status !== 'ready' || !r.key) throw notFound('This reel is not ready yet.');
    const download = (req.query as any).download === '1';
    if (download) needCap(req, 'download');
    const name = `${(s ? s.title : r.title).replace(/[^\w .()-]+/g, ' ').trim().slice(0, 80) || (s ? 'story' : 'Reel')} ${r.format.replace(':', 'x')}.mp4`;
    return sendStored(ctx, req, reply, r.key, 'video/mp4', download ? name : undefined, false);
  });
  app.delete('/api/reels/:id', async (req) => {
    const { r, s } = await loadReel(req, (req.params as any).id);
    if (s ? !canChange(req, s) : !canDrop(req, r)) throw forbidden();
    if (r.key) await ctx.storage.remove([r.key]);
    await db.delete(reels).where(eq(reels.id, r.id));
    return { ok: true };
  });

  /* ---------- public links: the one way in without signing in ---------- */

  const publicLink = (l: typeof storyLinks.$inferSelect) => ({
    id: l.id, label: l.label, url: `${ctx.cfg.PUBLIC_URL}/s/${l.token}`, allowDownload: l.allowDownload, allowAdd: l.allowAdd,
    hasPassword: Boolean(l.passwordHash), uses: l.uses, lastUsed: l.lastUsedAt?.getTime() ?? null, made: l.createdAt.getTime(),
  });
  const linkBody = z.object({
    label: z.string().trim().max(80).optional(), allowDownload: z.boolean().optional(), allowAdd: z.boolean().optional(),
    /** A password to ask for, or null to stop asking. */
    password: z.string().min(4, 'Use at least 4 characters for a link password.').max(200).nullable().optional(),
  });
  /** A story can have several links, each with its own options. */
  app.post('/api/stories/:id/links', async (req) => {
    const s = await load(req, (req.params as any).id);
    if (!canChange(req, s)) throw forbidden();
    const b = linkBody.parse(req.body ?? {});
    const n = (await db.select({ id: storyLinks.id }).from(storyLinks).where(eq(storyLinks.storyId, s.id))).length;
    if (n >= 50) throw bad('This story already has 50 links. Delete one you no longer need first.');
    const [l] = await db.insert(storyLinks).values({
      storyId: s.id, token: crypto.randomBytes(24).toString('base64url'), label: b.label || `Link ${n + 1}`, allowDownload: b.allowDownload ?? false, allowAdd: b.allowAdd ?? false,
      passwordHash: b.password ? await hashPassword(b.password) : null, createdBy: req.user!.id,
    }).returning();
    await logActivity(ctx, req.user!, `made a public link to the story “${s.title}”`);
    return publicLink(l!);
  });
  async function loadLink(req: FastifyRequest, id: string) {
    const [l] = await db.select().from(storyLinks).where(eq(storyLinks.id, uuid.parse(id)));
    if (!l) throw notFound('That link is gone.');
    const s = await load(req, l.storyId);
    if (!canChange(req, s)) throw forbidden();
    return { l, s };
  }
  app.patch('/api/story-links/:id', async (req) => {
    const { l } = await loadLink(req, (req.params as any).id);
    const b = linkBody.parse(req.body ?? {});
    const set: Partial<typeof storyLinks.$inferInsert> = {};
    if (b.label !== undefined) set.label = b.label || l.label;
    if (b.allowDownload !== undefined) set.allowDownload = b.allowDownload;
    if (b.allowAdd !== undefined) set.allowAdd = b.allowAdd;
    if (b.password !== undefined) set.passwordHash = b.password ? await hashPassword(b.password) : null;
    const [n] = Object.keys(set).length ? await db.update(storyLinks).set(set).where(eq(storyLinks.id, l.id)).returning() : [l];
    return publicLink(n!);
  });
  /** Deleting a link ends it at once, for everyone who has it. */
  app.delete('/api/story-links/:id', async (req) => {
    const { l, s } = await loadLink(req, (req.params as any).id);
    await db.delete(storyLinks).where(eq(storyLinks.id, l.id));
    await logActivity(ctx, req.user!, `ended a public link to the story “${s.title}”`);
    return { ok: true };
  });

  app.delete('/api/stories/:id', async (req) => {
    const s = await load(req, (req.params as any).id);
    if (!canChange(req, s)) throw forbidden();
    const files = (await db.select({ key: reels.key }).from(reels).where(eq(reels.storyId, s.id))).map((r) => r.key).filter((k): k is string => Boolean(k));
    if (files.length) await ctx.storage.remove(files);
    await db.delete(stories).where(eq(stories.id, s.id));
    return { ok: true };
  });
}
