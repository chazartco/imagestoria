import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import pg from 'pg';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { openDb, prepareDb } from '../src/server/db/index.js';
import { createStorage } from '../src/server/storage/index.js';

export const PG = process.env.TEST_PG ?? 'postgres://postgres@127.0.0.1:54329';
export const fixture = (name: string) => path.join(import.meta.dirname, 'fixtures', name);

/** A fresh database and a running app on a random port. */
export async function startApp(name: string, env: Record<string, string> = {}) {
  const admin = new pg.Client({ connectionString: `${PG}/postgres` });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const dataDir = path.join(import.meta.dirname, 'tmp', name);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });
  const cfg = loadConfig({ DATABASE_URL: `${PG}/${name}`, DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'warn', PUBLIC_URL: 'http://127.0.0.1:0', ...env });
  const { db, pool } = openDb(cfg.DATABASE_URL);
  await prepareDb(db, pool, () => {});
  const storage = createStorage(cfg);
  await storage.check();
  const { app, worker, ctx } = await buildApp(cfg, db, storage);
  await worker.ready;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port as number;
  // The public address is only known once the port is: sign-in redirects are built from it.
  (cfg as any).PUBLIC_URL = `http://127.0.0.1:${port}`;
  return { base: `http://127.0.0.1:${port}`, cfg, ctx, dataDir, pool, async stop() { worker.stop(); await app.close(); await pool.end(); } };
}

/** A browser-like client that keeps its cookies. */
export class Client {
  jar = new Map<string, string>();
  constructor(public base: string) {}
  private headers(extra: Record<string, string> = {}) {
    return { 'x-afterimage': '1', cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '), ...extra };
  }
  private keep(res: Response) {
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv!.indexOf('='); const k = kv!.slice(0, i), v = kv!.slice(i + 1); if (v) this.jar.set(k, v); else this.jar.delete(k); }
  }
  async raw(method: string, url: string, init: RequestInit = {}) {
    const res = await fetch(url.startsWith('http') ? url : this.base + url, { method, redirect: 'manual', ...init, headers: this.headers((init.headers as any) ?? {}) });
    this.keep(res);
    return res;
  }
  async json(method: string, url: string, body?: unknown) {
    const res = await this.raw(method, url, body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const text = await res.text();
    let data: any = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, res };
  }
  get = (url: string) => this.json('GET', url);
  post = (url: string, body: unknown = {}) => this.json('POST', url, body);
  async upload(file: string, space: string, extra: Record<string, string> = {}) {
    const fd = new FormData();
    fd.set('space', space); fd.set('lastModified', String(Date.UTC(2024, 0, 2, 12, 0, 0))); fd.set('tzOffset', '420');
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    fd.set('file', new Blob([fs.readFileSync(file)]), path.basename(file));
    const res = await this.raw('POST', '/api/upload', { body: fd });
    return { status: res.status, data: await res.json() as any };
  }
  /** Wait until every item has finished processing, then return the index. */
  async settled(timeoutMs = 30000) {
    const t0 = Date.now();
    for (;;) {
      const { data } = await this.get('/api/index');
      if (data.items.every((i: any) => i.status !== 'processing')) return data;
      if (Date.now() - t0 > timeoutMs) throw new Error('items never finished processing: ' + JSON.stringify(data.items.filter((i: any) => i.status === 'processing').map((i: any) => i.fileName)));
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/**
 * A stand-in for the program on the owner's GPU machine. It speaks to the site exactly as the real worker does:
 * a bearer token, no cookies and no x-afterimage header.
 */
export class FakeWorker {
  constructor(public base: string, public token: string) {}
  async call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(url.startsWith('http') ? url : this.base + url, { method, redirect: 'manual', headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const buf = Buffer.from(await res.arrayBuffer());
    let data: any = null; try { data = JSON.parse(buf.toString()); } catch { data = buf; }
    return { status: res.status, data, res };
  }
  claim = (tasks: string[] = ['caption'], want = 8) => this.call('POST', '/api/worker/claim', { tasks, want });
  results = (results: unknown[]) => this.call('POST', '/api/worker/results', { results });
  heartbeat = (info: Record<string, unknown> = {}) => this.call('POST', '/api/worker/heartbeat', info);
  release = (itemIds: string[]) => this.call('POST', '/api/worker/release', { itemIds });
  /** Claim, "read" every item with `read`, and hand the results in. Returns the ids it worked on. */
  async work(read: (item: any, task: string) => unknown, tasks: string[] = ['caption'], model = { name: 'fake-vision', version: '1' }) {
    const got = (await this.claim(tasks)).data.items as any[];
    if (!got.length) return [];
    const r = await this.results(got.flatMap((it) => it.tasks.map((task: string) => ({ itemId: it.id, task, model, data: read(it, task) }))));
    if (r.status !== 200 || r.data.refused.length) throw new Error('results refused: ' + JSON.stringify(r.data));
    return got.map((it) => it.id as string);
  }
}

/** A stand-in OpenID provider that signs in whoever `current` says. */
export async function mockOidc() {
  const state = { current: { sub: 'sp-1', name: 'Chaz', preferred_username: 'chaz', email: 'chaz@example.com', email_verified: true } as Record<string, unknown>, codes: new Map<string, { challenge: string; claims: Record<string, unknown> }>() };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (code: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const self = `http://127.0.0.1:${(server.address() as any).port}`;
    if (url.pathname === '/.well-known/openid-configuration') return send(200, { issuer: self, authorization_endpoint: `${self}/oauth/authorize`, token_endpoint: `${self}/api/oauth/token`, userinfo_endpoint: `${self}/api/oauth/userinfo` });
    if (url.pathname === '/oauth/authorize') {
      if (url.searchParams.get('code_challenge_method') !== 'S256') return send(400, { error: 'pkce required' });
      const code = 'code-' + Math.random().toString(36).slice(2);
      state.codes.set(code, { challenge: url.searchParams.get('code_challenge')!, claims: { ...state.current } });
      return send(302, '', { location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}` });
    }
    if (url.pathname === '/api/oauth/token') {
      let body = ''; for await (const c of req) body += c;
      const p = new URLSearchParams(body), entry = state.codes.get(p.get('code') ?? '');
      const crypto = await import('node:crypto');
      if (!entry || crypto.createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') !== entry.challenge || p.get('client_secret') !== 'shh') return send(400, { error: 'invalid_grant' });
      state.codes.delete(p.get('code')!);
      return send(200, { access_token: 'at-' + Buffer.from(JSON.stringify(entry.claims)).toString('base64url'), token_type: 'Bearer' });
    }
    if (url.pathname === '/api/oauth/userinfo') {
      const tok = String(req.headers.authorization ?? '').replace(/^Bearer at-/, '');
      try { return send(200, JSON.parse(Buffer.from(tok, 'base64url').toString())); } catch { return send(401, { error: 'invalid_token' }); }
    }
    send(404, { error: 'nope' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { issuer: `http://127.0.0.1:${(server.address() as any).port}`, state, stop: () => new Promise((r) => server.close(r)) };
}
