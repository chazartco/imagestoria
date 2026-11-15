import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Ctx, HttpError, forbidden } from '../context.js';
import { schema } from '../db/index.js';

export const SESSION_COOKIE = 'afterimage_session';

export type Cap = 'upload' | 'edit' | 'tag' | 'comment' | 'download' | 'publish' | 'del' | 'admin';
export const ROLES = ['owner', 'editor', 'commenter', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
/** What each role can do before any per-person switches. Liking is open to everyone who can sign in. */
export const ROLE_CAPS: Record<Role, Partial<Record<Cap, boolean>>> = {
  owner: { upload: true, edit: true, tag: true, comment: true, download: true, publish: true, del: true, admin: true },
  editor: { upload: true, edit: true, tag: true, comment: true, download: true },
  commenter: { comment: true, download: true },
  viewer: {},
};
/** Switches the owner may flip per person. Deleting and administration stay with the owner. */
export const ADJUSTABLE: Cap[] = ['upload', 'edit', 'tag', 'comment', 'download'];

export interface SessionUser {
  id: string;
  name: string;
  email: string | null;
  handle: string | null;
  role: Role;
  color: string;
  /** Changes whenever the profile picture does, so a browser fetches the new one. Empty when there is none. */
  avatar: string | null;
  caps: Record<Cap, boolean>;
  /** Spaces this person may open. The owner may open all of them. */
  spaceIds: string[];
  hasPassword: boolean;
  oidcLinked: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const avatarVersion = (key: string | null | undefined) => (key ? key.replace(/^.*-|\.webp$/g, '') : null);
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
export const hashPassword = (pw: string) => hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (h: string, pw: string) => verify(h, pw).catch(() => false);

export function effectiveCaps(role: Role, overrides: Record<string, boolean> | null | undefined): Record<Cap, boolean> {
  const base = ROLE_CAPS[role] ?? {};
  const out = {} as Record<Cap, boolean>;
  for (const c of ['upload', 'edit', 'tag', 'comment', 'download', 'publish', 'del', 'admin'] as Cap[]) out[c] = Boolean(base[c]);
  if (role !== 'owner' && overrides) for (const c of ADJUSTABLE) if (c in overrides) out[c] = Boolean(overrides[c]);
  // Publishing stories to the public page: owners always, an editor only when the owner switched it on for them, nobody else ever.
  if (role === 'editor' && overrides?.publish === true) out.publish = true;
  return out;
}

export async function spaceIdsFor(ctx: Ctx, userId: string, role: string): Promise<string[]> {
  if (role === 'owner') {
    const all = await ctx.db.select({ id: schema.spaces.id }).from(schema.spaces);
    return all.map((s) => s.id);
  }
  const rows = await ctx.db.select({ id: schema.spaceMembers.spaceId }).from(schema.spaceMembers).where(eq(schema.spaceMembers.userId, userId));
  return rows.map((r) => r.id);
}

export async function toSessionUser(ctx: Ctx, u: typeof schema.users.$inferSelect): Promise<SessionUser> {
  const role = (ROLES as readonly string[]).includes(u.role) ? (u.role as Role) : 'viewer';
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    handle: u.handle,
    role,
    color: u.color,
    avatar: avatarVersion(u.avatarKey),
    caps: effectiveCaps(role, u.caps),
    spaceIds: await spaceIdsFor(ctx, u.id, role),
    hasPassword: Boolean(u.passwordHash),
    oidcLinked: Boolean(u.oidcSubject),
  };
}

export async function startSession(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, userId: string) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + ctx.cfg.SESSION_DAYS * 86400_000);
  await ctx.db.insert(schema.sessions).values({ tokenHash: hashToken(token), userId, expiresAt, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) });
  await ctx.db.update(schema.users).set({ lastSeenAt: new Date() }).where(eq(schema.users.id, userId));
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.cfg.secureCookies, expires: expiresAt });
}

export async function endSession(ctx: Ctx, req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await ctx.db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token)));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Resolve the signed-in person for a request, if any. */
export async function loadUser(ctx: Ctx, req: FastifyRequest): Promise<SessionUser | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const rows = await ctx.db
    .select({ user: schema.users, seen: schema.users.lastSeenAt })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, hashToken(token)), gt(schema.sessions.expiresAt, new Date()), eq(schema.users.status, 'active')))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Touch "last seen" at most every few minutes so ordinary browsing does not write on every request.
  if (!row.seen || Date.now() - row.seen.getTime() > 5 * 60_000) {
    await ctx.db.update(schema.users).set({ lastSeenAt: new Date() }).where(eq(schema.users.id, row.user.id));
  }
  return toSessionUser(ctx, row.user);
}

export function need(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, 'Sign in first.');
  return req.user;
}
export function needCap(req: FastifyRequest, cap: Cap): SessionUser {
  const u = need(req);
  if (!u.caps[cap]) throw forbidden();
  return u;
}
export function needSpace(req: FastifyRequest, spaceId: string): SessionUser {
  const u = need(req);
  if (!u.spaceIds.includes(spaceId)) throw forbidden('You do not have access to this space.');
  return u;
}

/** One-time link (invite or password reset). Returns the plain token that goes in the link. */
export async function issueToken(ctx: Ctx, kind: 'invite' | 'reset', userId: string, days: number) {
  const token = newToken();
  await ctx.db.delete(schema.tokens).where(and(eq(schema.tokens.userId, userId), eq(schema.tokens.kind, kind)));
  await ctx.db.insert(schema.tokens).values({ tokenHash: hashToken(token), kind, userId, expiresAt: new Date(Date.now() + days * 86400_000) });
  return token;
}
export async function findToken(ctx: Ctx, kind: 'invite' | 'reset', token: string) {
  const rows = await ctx.db
    .select({ t: schema.tokens, user: schema.users })
    .from(schema.tokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.tokens.userId))
    .where(and(eq(schema.tokens.tokenHash, hashToken(token)), eq(schema.tokens.kind, kind), isNull(schema.tokens.usedAt), gt(schema.tokens.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}
export async function useToken(ctx: Ctx, token: string) {
  await ctx.db.update(schema.tokens).set({ usedAt: new Date() }).where(eq(schema.tokens.tokenHash, hashToken(token)));
}

export async function userCount(ctx: Ctx) {
  const r = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(schema.users);
  return r[0]?.n ?? 0;
}

export async function logActivity(ctx: Ctx, user: { id: string; name: string } | null, text: string) {
  await ctx.db.insert(schema.activity).values({ userId: user?.id ?? null, who: user?.name ?? 'System', text });
}

const COLORS = ['#ffb224', '#57a55a', '#e36aa5', '#34b3a8', '#8a5bd1', '#3f7fe0', '#ee8a2f', '#d6453d'];
export const pickColor = (n: number) => COLORS[n % COLORS.length]!;
