import { MUSIC_VERSION } from './music.js';
import crypto from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  endSession,
  findToken,
  hashPassword,
  logActivity,
  need,
  pickColor,
  startSession,
  toSessionUser,
  avatarVersion,
  useToken,
  userCount,
  verifyPassword,
} from '../auth/core.js';
import { type Ctx, HttpError, bad } from '../context.js';
import sharp from 'sharp';
import { sendStored } from './items.js';
import { schema } from '../db/index.js';

const OIDC_COOKIE = 'afterimage_oidc';
const password = z.string().min(10, 'Use at least 10 characters.').max(200);

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}
let discovery: { at: number; doc: Discovery } | null = null;

async function discover(ctx: Ctx): Promise<Discovery> {
  if (discovery && Date.now() - discovery.at < 10 * 60_000) return discovery.doc;
  const res = await fetch(`${ctx.cfg.OIDC_ISSUER}/.well-known/openid-configuration`);
  if (!res.ok) throw new HttpError(502, `${ctx.cfg.OIDC_NAME} sign-in is not reachable right now.`);
  const doc = (await res.json()) as Discovery;
  discovery = { at: Date.now(), doc };
  return doc;
}

/** First run: the two spaces every new library starts with. They can be renamed or added to later. */
export async function ensureDefaultSpaces(ctx: Ctx) {
  const n = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(schema.spaces);
  if ((n[0]?.n ?? 0) > 0) return;
  await ctx.db.insert(schema.spaces).values([
    { slug: 'life', name: 'Life', kind: 'life', position: 0 },
    { slug: 'studio', name: 'Studio', kind: 'studio', position: 1 },
  ]);
}

export async function publicSpaces(ctx: Ctx, ids: string[]) {
  const all = await ctx.db.select().from(schema.spaces).orderBy(asc(schema.spaces.position), asc(schema.spaces.name));
  return all.filter((s) => ids.includes(s.id)).map((s) => ({ id: s.id, slug: s.slug, name: s.name, kind: s.kind, people: s.people }));
}

export function registerAuth(app: FastifyInstance, ctx: Ctx) {
  const { db, cfg } = ctx;
  const redirectUri = () => `${cfg.PUBLIC_URL}/api/auth/oidc/callback`;

  /** Everything the page needs to decide what to show first. */
  app.get('/api/bootstrap', async (req) => {
    const setupNeeded = (await userCount(ctx)) === 0;
    const base = {
      setupNeeded,
      auth: { local: cfg.LOCAL_AUTH, oidc: cfg.oidcEnabled ? { name: cfg.OIDC_NAME } : null },
      map: { dark: cfg.MAP_STYLE_DARK, light: cfg.MAP_STYLE_LIGHT, fallback: cfg.MAP_STYLE_FALLBACK },
      limits: { maxUploadMb: cfg.MAX_UPLOAD_MB, displayLongEdge: cfg.DISPLAY_LONG_EDGE, thumbHeight: cfg.THUMB_HEIGHT },
      storage: cfg.STORAGE_DRIVER,
      musicVersion: MUSIC_VERSION,
    };
    if (!req.user) return { ...base, me: null };
    const people = await db
      .select({ id: schema.users.id, name: schema.users.name, handle: schema.users.handle, color: schema.users.color, role: schema.users.role, status: schema.users.status, avatarKey: schema.users.avatarKey })
      .from(schema.users);
    return { ...base, me: req.user, spaces: await publicSpaces(ctx, req.user.spaceIds), people: people.map(({ avatarKey, ...p }) => ({ ...p, avatar: avatarVersion(avatarKey) })) };
  });

  app.post('/api/setup', async (req, reply) => {
    if (!cfg.LOCAL_AUTH) throw bad(`Local accounts are turned off. Sign in with ${cfg.OIDC_NAME} to become the owner.`);
    if ((await userCount(ctx)) > 0) throw new HttpError(409, 'This library already has an owner.');
    const body = z.object({ name: z.string().trim().min(1).max(80), email: z.string().trim().email().max(200), password }).parse(req.body);
    const [owner] = await db
      .insert(schema.users)
      .values({ name: body.name, email: body.email.toLowerCase(), passwordHash: await hashPassword(body.password), role: 'owner', color: pickColor(0) })
      .returning();
    await ensureDefaultSpaces(ctx);
    await startSession(ctx, req, reply, owner!.id);
    await logActivity(ctx, owner!, 'set up this library');
    return { ok: true };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => {
    if (!cfg.LOCAL_AUTH) throw bad('Local accounts are turned off.');
    const body = z.object({ email: z.string().trim().max(200), password: z.string().max(200) }).parse(req.body);
    const rows = await db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${body.email.toLowerCase()}`).limit(1);
    const u = rows[0];
    // Same message whether the email or the password is wrong, so the form does not reveal who has an account.
    if (!u || !u.passwordHash || u.status !== 'active' || !(await verifyPassword(u.passwordHash, body.password))) {
      throw new HttpError(401, 'That email and password do not match an account here.');
    }
    await startSession(ctx, req, reply, u.id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await endSession(ctx, req, reply);
    return { ok: true };
  });

  /** What an invite or reset link is for, so the page can greet the person by name. */
  app.get('/api/auth/link/:token', async (req) => {
    const { token } = req.params as { token: string };
    const inv = (await findToken(ctx, 'invite', token)) ?? (await findToken(ctx, 'reset', token));
    if (!inv) throw new HttpError(404, 'This link has expired or was already used. Ask the owner for a new one.');
    return { kind: inv.t.kind, name: inv.user.name, email: inv.user.email, role: inv.user.role };
  });

  /** Join with a local password from an invite link. */
  app.post('/api/auth/accept-invite', async (req, reply) => {
    if (!cfg.LOCAL_AUTH) throw bad(`Join with ${cfg.OIDC_NAME} instead.`);
    const body = z.object({ token: z.string(), name: z.string().trim().min(1).max(80), email: z.string().trim().email().max(200), password }).parse(req.body);
    const inv = await findToken(ctx, 'invite', body.token);
    if (!inv) throw new HttpError(404, 'This invite has expired or was already used.');
    const clash = await db.select({ id: schema.users.id }).from(schema.users).where(sql`lower(${schema.users.email}) = ${body.email.toLowerCase()} and ${schema.users.id} <> ${inv.user.id}`);
    if (clash.length) throw bad('Someone here already uses that email.');
    await db.update(schema.users).set({ name: body.name, email: body.email.toLowerCase(), passwordHash: await hashPassword(body.password), status: 'active' }).where(eq(schema.users.id, inv.user.id));
    await useToken(ctx, body.token);
    await startSession(ctx, req, reply, inv.user.id);
    await logActivity(ctx, { id: inv.user.id, name: body.name }, 'accepted their invite');
    return { ok: true };
  });

  app.post('/api/auth/reset', async (req, reply) => {
    const body = z.object({ token: z.string(), password }).parse(req.body);
    const t = await findToken(ctx, 'reset', body.token);
    if (!t) throw new HttpError(404, 'This reset link has expired or was already used.');
    await db.update(schema.users).set({ passwordHash: await hashPassword(body.password) }).where(eq(schema.users.id, t.user.id));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, t.user.id));
    await useToken(ctx, body.token);
    await startSession(ctx, req, reply, t.user.id);
    return { ok: true };
  });

  app.post('/api/me/password', async (req) => {
    const me = need(req);
    const body = z.object({ current: z.string().max(200).optional(), next: password }).parse(req.body);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, me.id));
    if (u!.passwordHash && !(await verifyPassword(u!.passwordHash, body.current ?? ''))) throw bad('Your current password is not right.');
    await db.update(schema.users).set({ passwordHash: await hashPassword(body.next) }).where(eq(schema.users.id, me.id));
    return { ok: true };
  });

  /* ---------- OpenID Connect (SolPersona or any other provider) ---------- */

  app.get('/api/auth/oidc/start', async (req, reply) => {
    // This address is opened by the browser itself, so problems go back to the sign-in page rather than showing raw JSON.
    if (!cfg.oidcEnabled) return reply.redirect('/?auth_error=off');
    const q = req.query as { invite?: string; link?: string };
    let d: Awaited<ReturnType<typeof discover>>;
    try { d = await discover(ctx); } catch (e) { req.log.warn({ err: e }, 'OIDC discovery failed'); return reply.redirect('/?auth_error=provider'); }
    const state = crypto.randomBytes(16).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    // The values needed to finish sign-in ride in a short-lived cookie only this browser holds.
    reply.setCookie(OIDC_COOKIE, JSON.stringify({ state, verifier, invite: q.invite ?? null, link: q.link === '1' }), {
      path: '/api/auth/oidc', httpOnly: true, sameSite: 'lax', secure: cfg.secureCookies, maxAge: 600,
    });
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({ response_type: 'code', client_id: cfg.OIDC_CLIENT_ID, redirect_uri: redirectUri(), scope: cfg.OIDC_SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    return reply.redirect(url.toString());
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const fail = (code: string) => reply.redirect(`/?auth_error=${code}`);
    if (!cfg.oidcEnabled) return fail('off');
    const q = req.query as { code?: string; state?: string; error?: string };
    let saved: { state: string; verifier: string; invite: string | null; link: boolean } | null = null;
    try { saved = JSON.parse(req.cookies[OIDC_COOKIE] ?? ''); } catch { /* handled below */ }
    reply.clearCookie(OIDC_COOKIE, { path: '/api/auth/oidc' });
    if (q.error) return fail('denied');
    if (!saved || !q.code || !q.state || q.state !== saved.state) return fail('state');

    let claims: { sub?: string; name?: string; preferred_username?: string; email?: string; email_verified?: boolean };
    try {
      const d = await discover(ctx);
      const tokenRes = await fetch(d.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: q.code, redirect_uri: redirectUri(), code_verifier: saved.verifier, client_id: cfg.OIDC_CLIENT_ID, ...(cfg.OIDC_CLIENT_SECRET ? { client_secret: cfg.OIDC_CLIENT_SECRET } : {}) }),
      });
      if (!tokenRes.ok) { ctx.log.warn({ status: tokenRes.status, body: (await tokenRes.text()).slice(0, 300) }, 'oidc token exchange failed'); return fail('exchange'); }
      const tok = (await tokenRes.json()) as { access_token?: string };
      const infoRes = await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${tok.access_token}` } });
      if (!infoRes.ok) return fail('userinfo');
      claims = (await infoRes.json()) as typeof claims;
    } catch (e) {
      ctx.log.warn({ err: e }, 'oidc callback failed');
      return fail('provider');
    }
    if (!claims.sub) return fail('userinfo');
    const displayName = claims.name || claims.preferred_username || 'New member';
    const handle = claims.preferred_username ? '@' + claims.preferred_username : null;

    // 1. Someone who has signed in this way before.
    const known = await db.select().from(schema.users).where(eq(schema.users.oidcSubject, claims.sub)).limit(1);
    if (known[0]) {
      if (known[0].status !== 'active') return fail('disabled');
      await startSession(ctx, req, reply, known[0].id);
      return reply.redirect('/');
    }
    // 2. A signed-in person connecting their existing account.
    if (saved.link && req.user) {
      await db.update(schema.users).set({ oidcSubject: claims.sub, handle: handle ?? req.user.handle }).where(eq(schema.users.id, req.user.id));
      return reply.redirect('/?linked=1');
    }
    // 3. A brand-new library: the first person in becomes the owner.
    if ((await userCount(ctx)) === 0) {
      const [owner] = await db.insert(schema.users).values({ name: displayName, email: claims.email?.toLowerCase() ?? null, handle, role: 'owner', oidcSubject: claims.sub, color: pickColor(0) }).returning();
      await ensureDefaultSpaces(ctx);
      await startSession(ctx, req, reply, owner!.id);
      await logActivity(ctx, owner!, 'set up this library');
      return reply.redirect('/');
    }
    // 4. Someone the owner invited: by the invite link they followed, or by the handle or verified email on the invite.
    let invited: typeof schema.users.$inferSelect | null = null;
    if (saved.invite) invited = (await findToken(ctx, 'invite', saved.invite))?.user ?? null;
    if (!invited && handle) {
      invited = (await db.select().from(schema.users).where(and(eq(schema.users.status, 'pending'), sql`lower(${schema.users.handle}) = ${handle.toLowerCase()}`)).limit(1))[0] ?? null;
    }
    if (!invited && claims.email && claims.email_verified) {
      invited = (await db.select().from(schema.users).where(and(eq(schema.users.status, 'pending'), sql`lower(${schema.users.email}) = ${claims.email.toLowerCase()}`)).limit(1))[0] ?? null;
    }
    if (!invited) return fail('not_invited');
    await db.update(schema.users).set({ oidcSubject: claims.sub, status: 'active', handle: handle ?? invited.handle, name: invited.name || displayName, email: invited.email ?? claims.email?.toLowerCase() ?? null }).where(eq(schema.users.id, invited.id));
    if (saved.invite) await useToken(ctx, saved.invite);
    await startSession(ctx, req, reply, invited.id);
    await logActivity(ctx, { id: invited.id, name: invited.name || displayName }, `joined with ${cfg.OIDC_NAME}`);
    return reply.redirect('/');
  });

  /**
   * A profile picture. Whatever is sent is turned upright, cut to a square from its middle and made small.
   * This is the one picture in the app that is cut: it stands for a person in a round badge, and is not part of the library.
   */
  app.post('/api/me/avatar', async (req) => {
    const me = need(req);
    let buf: Buffer | null = null;
    for await (const part of req.parts({ limits: { fileSize: 20 * 1024 * 1024 } })) {
      if (part.type === 'field' || buf) { if (part.type !== 'field') part.file.resume(); continue; }
      buf = await part.toBuffer().catch(() => null);
      if (!buf || part.file.truncated) throw new HttpError(413, 'That picture is larger than 20 MB. Choose a smaller one.');
    }
    if (!buf) throw bad('No picture arrived.');
    let out: Buffer;
    try { out = await sharp(buf).rotate().resize(256, 256, { fit: 'cover' }).webp({ quality: 86 }).toBuffer(); }
    catch { throw new HttpError(415, 'That file could not be read as a picture. Use a JPEG, PNG or WebP.'); }
    const [u] = await db.select({ old: schema.users.avatarKey }).from(schema.users).where(eq(schema.users.id, me.id));
    const key = `avatars/${me.id}-${crypto.randomBytes(6).toString('hex')}.webp`;
    await ctx.storage.putBuffer(key, out, 'image/webp');
    await db.update(schema.users).set({ avatarKey: key }).where(eq(schema.users.id, me.id));
    if (u?.old) await ctx.storage.remove([u.old]).catch(() => {});
    return { avatar: avatarVersion(key) };
  });
  app.delete('/api/me/avatar', async (req) => {
    const me = need(req);
    const [u] = await db.select({ old: schema.users.avatarKey }).from(schema.users).where(eq(schema.users.id, me.id));
    await db.update(schema.users).set({ avatarKey: null }).where(eq(schema.users.id, me.id));
    if (u?.old) await ctx.storage.remove([u.old]).catch(() => {});
    return { ok: true };
  });
  /** Anyone signed in sees the profile pictures of the people they share the library with. */
  app.get('/api/avatars/:id', async (req, reply) => {
    need(req);
    const [u] = await db.select({ key: schema.users.avatarKey }).from(schema.users).where(eq(schema.users.id, z.string().uuid().parse((req.params as any).id)));
    if (!u?.key) throw new HttpError(404, 'This person has no profile picture.');
    return sendStored(ctx, req, reply, u.key, 'image/webp', undefined, true);
  });

  app.get('/api/me', async (req) => {
    const me = need(req);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, me.id));
    return toSessionUser(ctx, u!);
  });
}
