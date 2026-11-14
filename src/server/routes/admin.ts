import { backupState, runBackup } from '../backup.js';
import { playCopyCounts, queueMissingPlayCopies } from '../media/playcopy.js';
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ADJUSTABLE, ROLES, avatarVersion, effectiveCaps, issueToken, logActivity, needCap, pickColor, type Role } from '../auth/core.js';
import { type Ctx, HttpError, bad, notFound } from '../context.js';
import { schema } from '../db/index.js';
import { inviteMail, resetMail } from '../mail.js';

const uuid = z.string().uuid();
const { users, spaces, spaceMembers, items } = schema;
const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'space';

export function registerAdmin(app: FastifyInstance, ctx: Ctx) {
  const { db, cfg } = ctx;
  const link = (kind: 'invite' | 'reset', token: string) => `${cfg.PUBLIC_URL}/?${kind}=${token}`;
  const INVITE_DAYS = 14, RESET_DAYS = 2;
  /**
   * Email a link when mail is on and the person has an address. The answer says what happened, and the caller
   * always still gets the link itself: making an invite must never fail because its email did.
   * null means nothing was tried (mail is off, or there is no address, as with an invite by handle).
   */
  async function mailLink(kind: 'invite' | 'reset', u: { email: string | null; name: string; role: string }, url: string, inviter: string) {
    if (!ctx.mail.enabled || !u.email) return null;
    const msg = kind === 'invite' ? inviteMail(cfg, { to: u.email, link: url, inviter, role: u.role, validDays: INVITE_DAYS }) : resetMail(cfg, { to: u.email, link: url, name: u.name, validDays: RESET_DAYS });
    const r = await ctx.mail.send(msg);
    if (!r.ok) ctx.log.warn({ kind, reason: r.error }, 'an email could not be sent');
    return r.ok ? { sent: true as const, to: u.email } : { sent: false as const, to: u.email, error: r.error };
  }

  async function setSpaces(userId: string, spaceIds: string[]) {
    await db.delete(spaceMembers).where(eq(spaceMembers.userId, userId));
    if (spaceIds.length) await db.insert(spaceMembers).values(spaceIds.map((spaceId) => ({ spaceId, userId }))).onConflictDoNothing();
  }

  app.get('/api/people', async (req) => {
    needCap(req, 'admin');
    const all = await db.select().from(users).orderBy(asc(users.createdAt));
    const mem = await db.select().from(spaceMembers);
    const allSpaces = await db.select({ id: spaces.id }).from(spaces);
    return {
      people: all.map((u) => ({
        id: u.id, name: u.name, email: u.email, handle: u.handle, role: u.role, color: u.color, status: u.status, avatar: avatarVersion(u.avatarKey),
        caps: effectiveCaps(u.role as Role, u.caps), hasPassword: Boolean(u.passwordHash), oidcLinked: Boolean(u.oidcSubject),
        spaces: u.role === 'owner' ? allSpaces.map((s) => s.id) : mem.filter((m) => m.userId === u.id).map((m) => m.spaceId),
        last: u.lastSeenAt?.getTime() ?? null,
      })),
    };
  });

  /** Add someone. They exist as "pending" until they follow the link (or sign in with the matching SolPersona handle). */
  app.post('/api/people/invite', async (req) => {
    const me = needCap(req, 'admin');
    const b = z.object({ who: z.string().trim().min(1).max(200), role: z.enum(['editor', 'commenter', 'viewer']), spaceIds: z.array(uuid).max(100) }).parse(req.body);
    const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.who);
    const handle = isEmail ? null : '@' + b.who.replace(/^@/, '');
    const email = isEmail ? b.who.toLowerCase() : null;
    if (email) { const clash = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`); if (clash.length) throw bad('Someone here already uses that email.'); }
    const n = (await db.select({ n: sql<number>`count(*)::int` }).from(users))[0]!.n;
    const name = (isEmail ? b.who.split('@')[0]! : b.who.replace(/^@/, '')).replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const [u] = await db.insert(users).values({ name, email, handle, role: b.role, status: 'pending', color: pickColor(n) }).returning();
    await setSpaces(u!.id, b.spaceIds);
    const url = link('invite', await issueToken(ctx, 'invite', u!.id, INVITE_DAYS));
    await logActivity(ctx, me, `invited ${b.who} as ${b.role}`);
    return { id: u!.id, link: url, mail: await mailLink('invite', u!, url, me.name) };
  });

  app.post('/api/people/:id/link', async (req) => {
    const me = needCap(req, 'admin');
    const [u] = await db.select().from(users).where(eq(users.id, uuid.parse((req.params as any).id)));
    if (!u) throw notFound();
    const kind = u.status === 'pending' ? 'invite' : 'reset';
    if (kind === 'reset' && !cfg.LOCAL_AUTH) throw bad('Local passwords are turned off.');
    const url = link(kind, await issueToken(ctx, kind, u.id, kind === 'invite' ? INVITE_DAYS : RESET_DAYS));
    return { kind, link: url, mail: await mailLink(kind, u, url, me.name) };
  });

  app.patch('/api/people/:id', async (req) => {
    const me = needCap(req, 'admin');
    const [u] = await db.select().from(users).where(eq(users.id, uuid.parse((req.params as any).id)));
    if (!u) throw notFound();
    const b = z.object({ name: z.string().trim().min(1).max(80).optional(), role: z.enum(ROLES).optional(), caps: z.record(z.string(), z.boolean()).optional(), spaceIds: z.array(uuid).optional(), status: z.enum(['active', 'disabled']).optional() }).parse(req.body);
    if (u.role === 'owner' && (b.role && b.role !== 'owner' || b.status === 'disabled')) {
      const owners = await db.select({ id: users.id }).from(users).where(and(eq(users.role, 'owner'), eq(users.status, 'active'), ne(users.id, u.id)));
      if (!owners.length) throw bad('A library needs at least one owner.');
    }
    const set: Partial<typeof users.$inferInsert> = {};
    if (b.name) set.name = b.name;
    if (b.role && b.role !== u.role) { set.role = b.role; set.caps = {}; }
    if (b.caps) { const next: Record<string, boolean> = { ...(set.caps ?? u.caps) }; for (const c of ADJUSTABLE) if (c in b.caps) next[c] = b.caps[c]!; set.caps = next; }
    if (b.status && u.status !== 'pending') set.status = b.status;
    if (Object.keys(set).length) await db.update(users).set(set).where(eq(users.id, u.id));
    if (b.spaceIds) await setSpaces(u.id, b.spaceIds);
    if (b.status === 'disabled') await db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id));
    if (b.role && b.role !== u.role) await logActivity(ctx, me, `changed ${u.name} to ${b.role}`);
    return { ok: true };
  });

  app.delete('/api/people/:id', async (req) => {
    const me = needCap(req, 'admin');
    const [u] = await db.select().from(users).where(eq(users.id, uuid.parse((req.params as any).id)));
    if (!u) throw notFound();
    if (u.id === me.id) throw bad('You cannot remove yourself.');
    if (u.role === 'owner') throw bad('Change this person to another role before removing them.');
    await db.delete(users).where(eq(users.id, u.id));
    await logActivity(ctx, me, `removed ${u.name}`);
    return { ok: true };
  });

  /* ---------- spaces ---------- */

  app.post('/api/spaces', async (req) => {
    const me = needCap(req, 'admin');
    const b = z.object({ name: z.string().trim().min(1).max(60), kind: z.enum(['life', 'studio']).default('life') }).parse(req.body);
    let slug = slugify(b.name);
    const taken = new Set((await db.select({ slug: spaces.slug }).from(spaces)).map((s) => s.slug));
    for (let i = 2; taken.has(slug); i++) slug = `${slugify(b.name)}-${i}`;
    // A new space goes after the last one, wherever the owner has dragged the others.
    const last = (await db.select({ p: sql<number>`coalesce(max(${spaces.position}), -1)::int` }).from(spaces))[0]!.p;
    const [s] = await db.insert(spaces).values({ name: b.name, kind: b.kind, slug, position: last + 1 }).returning();
    await logActivity(ctx, me, `added the space “${b.name}”`);
    return { id: s!.id, slug: s!.slug, name: s!.name, kind: s!.kind };
  });
  /** The order of the tabs. Takes every space id, in the order wanted. */
  app.post('/api/spaces/order', async (req) => {
    needCap(req, 'admin');
    const b = z.object({ ids: z.array(uuid).min(1).max(500) }).parse(req.body);
    const all = (await db.select({ id: spaces.id }).from(spaces).orderBy(asc(spaces.position), asc(spaces.name))).map((s) => s.id);
    if (new Set(b.ids).size !== b.ids.length || b.ids.some((id) => !all.includes(id))) throw bad('That list of spaces does not match the ones that exist. Reload the page and try again.');
    // Any space the list left out (added a moment ago in another tab) keeps its place after the listed ones.
    const order = [...b.ids, ...all.filter((id) => !b.ids.includes(id))];
    await db.transaction(async (tx) => { for (let i = 0; i < order.length; i++) await tx.update(spaces).set({ position: i }).where(eq(spaces.id, order[i]!)); });
    return { ok: true };
  });
  app.patch('/api/spaces/:id', async (req) => {
    needCap(req, 'admin');
    const b = z.object({ name: z.string().trim().min(1).max(60).optional(), kind: z.enum(['life', 'studio']).optional() }).parse(req.body);
    await db.update(spaces).set(b).where(eq(spaces.id, uuid.parse((req.params as any).id)));
    return { ok: true };
  });
  app.delete('/api/spaces/:id', async (req) => {
    needCap(req, 'admin');
    const id = uuid.parse((req.params as any).id);
    const n = (await db.select({ n: sql<number>`count(*)::int` }).from(items).where(eq(items.spaceId, id)))[0]!.n;
    if (n) throw new HttpError(409, 'Move or delete the items in this space first, and empty the trash.');
    if ((await db.select({ id: spaces.id }).from(spaces)).length <= 1) throw bad('A library needs at least one space.');
    await db.delete(spaces).where(eq(spaces.id, id));
    return { ok: true };
  });

  /** Back up the database now. Owners only. Answers when the backup is done, which takes seconds for most libraries. */
  app.post('/api/admin/backup', async (req) => {
    const me = needCap(req, 'admin');
    const r = await runBackup(ctx, me.name);
    if ('busy' in r) throw new HttpError(409, 'A backup is already running. Look again in a minute.');
    if (!r.ok) throw new HttpError(500, `The backup failed. ${r.reason}`);
    return { ...(await backupState(ctx)) };
  });

  /** Make playable copies for videos already in the library: the ones never looked at, and the ones that failed. */
  app.post('/api/admin/video-copies', async (req) => {
    const me = needCap(req, 'admin');
    if (cfg.VIDEO_COPY === 'never') throw bad('Video copies are turned off in the settings (VIDEO_COPY=never).');
    const n = await queueMissingPlayCopies(ctx);
    if (n) await logActivity(ctx, me, `asked for playable copies of ${n} ${n === 1 ? 'video' : 'videos'}`);
    return { n };
  });

  /* ---------- overview for the settings page ---------- */

  app.get('/api/admin/overview', async (req) => {
    needCap(req, 'admin');
    const [tot] = await db.select({ n: sql<number>`count(*)::int`, orig: sql<number>`coalesce(sum(${items.bytesOrig}),0)::float8`, disp: sql<number>`coalesce(sum(${items.bytesDisplay}),0)::float8`, thumb: sql<number>`coalesce(sum(${items.bytesThumb}),0)::float8`, full: sql<number>`coalesce(sum(${items.bytesFull}),0)::float8`, play: sql<number>`coalesce(sum(${items.bytesPlay}),0)::float8` }).from(items).where(isNull(items.deletedAt));
    const [trash] = await db.select({ n: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${items.bytesOrig} + ${items.bytesDisplay} + ${items.bytesThumb} + ${items.bytesFull} + ${items.bytesPlay}),0)::float8` }).from(items).where(sql`${items.deletedAt} is not null`);
    const [work] = await db.select({ waiting: sql<number>`count(*) filter (where status in ('queued','running'))::int`, failed: sql<number>`count(*) filter (where status = 'failed')::int` }).from(schema.jobs);
    const act = await db.select().from(schema.activity).orderBy(desc(schema.activity.createdAt)).limit(40);
    return {
      storage: { driver: cfg.STORAGE_DRIVER, bucket: cfg.STORAGE_DRIVER === 's3' ? cfg.S3_BUCKET : null, items: tot!.n, orig: tot!.orig, disp: tot!.disp, thumb: tot!.thumb, full: tot!.full, play: tot!.play },
      video: await playCopyCounts(ctx), backup: await backupState(ctx),
      trash: { ...trash!, days: cfg.TRASH_DAYS }, work: work!,
      auth: { local: cfg.LOCAL_AUTH, oidc: cfg.oidcEnabled ? cfg.OIDC_NAME : null },
      mail: { on: ctx.mail.enabled, from: ctx.mail.from },
      activity: act.map((a) => ({ who: a.who, text: a.text, t: a.createdAt.getTime() })),
    };
  });
}
