import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, mockOidc, startApp } from './helpers.js';

/** Follow the sign-in redirects the way a browser would, keeping cookies per site. */
async function signIn(c: Client, query = '') {
  const start = await c.raw('GET', `/api/auth/oidc/start${query}`);
  assert.equal(start.status, 302);
  const provider = await fetch(start.headers.get('location')!, { redirect: 'manual' });
  assert.equal(provider.status, 302, await provider.text());
  const back = await c.raw('GET', provider.headers.get('location')!);
  assert.equal(back.status, 302);
  return back.headers.get('location')!;
}

describe('sign-in with SolPersona (OpenID Connect)', () => {
  let app: Awaited<ReturnType<typeof startApp>>, idp: Awaited<ReturnType<typeof mockOidc>>;
  before(async () => {
    idp = await mockOidc();
    app = await startApp('ai_test_oidc', { OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'afterimage', OIDC_CLIENT_SECRET: 'shh', LOCAL_AUTH: 'false' });
  });
  after(async () => { await app.stop(); await idp.stop(); });

  it('offers only SolPersona when local accounts are off', async () => {
    const b = (await new Client(app.base).get('/api/bootstrap')).data;
    assert.deepEqual(b.auth, { local: false, oidc: { name: 'SolPersona' } });
    assert.equal((await new Client(app.base).post('/api/setup', { name: 'x', email: 'x@example.com', password: 'a long enough password' })).status, 400);
  });

  it('makes the first person to sign in the owner', async () => {
    const chaz = new Client(app.base);
    assert.equal(await signIn(chaz), '/');
    const me = (await chaz.get('/api/me')).data;
    assert.equal(me.role, 'owner'); assert.equal(me.handle, '@chaz'); assert.equal(me.oidcLinked, true);
    assert.equal((await chaz.get('/api/bootstrap')).data.spaces.length, 2);
  });

  it('recognises the same person next time', async () => {
    const again = new Client(app.base);
    assert.equal(await signIn(again), '/');
    assert.equal((await again.get('/api/me')).data.role, 'owner');
  });

  it('turns away someone who was not invited', async () => {
    idp.state.current = { sub: 'sp-2', name: 'Stranger', preferred_username: 'stranger', email: 's@example.com', email_verified: true };
    const s = new Client(app.base);
    assert.equal(await signIn(s), '/?auth_error=not_invited');
    assert.equal((await s.get('/api/me')).status, 401);
  });

  it('lets in someone invited by their SolPersona handle, with the role the owner chose', async () => {
    idp.state.current = { sub: 'sp-1', name: 'Chaz', preferred_username: 'chaz' };
    const chaz = new Client(app.base); await signIn(chaz);
    const life = (await chaz.get('/api/bootstrap')).data.spaces[0].id;
    assert.equal((await chaz.post('/api/people/invite', { who: '@AnaReyes', role: 'editor', spaceIds: [life] })).status, 200);
    idp.state.current = { sub: 'sp-3', name: 'Ana Reyes', preferred_username: 'anareyes' };
    const ana = new Client(app.base);
    assert.equal(await signIn(ana), '/');
    const me = (await ana.get('/api/me')).data;
    assert.equal(me.role, 'editor'); assert.deepEqual(me.spaceIds, [life]); assert.equal(me.caps.upload, true); assert.equal(me.caps.admin, false);
  });

  it('lets in someone who follows an invite link, whatever their handle is', async () => {
    idp.state.current = { sub: 'sp-1', name: 'Chaz', preferred_username: 'chaz' };
    const chaz = new Client(app.base); await signIn(chaz);
    const inv = await chaz.post('/api/people/invite', { who: 'marco@example.com', role: 'commenter', spaceIds: [] });
    const token = new URL(inv.data.link).searchParams.get('invite')!;
    idp.state.current = { sub: 'sp-4', name: 'Marco Ibarra', preferred_username: 'marcoi' };
    const marco = new Client(app.base);
    assert.equal(await signIn(marco, `?invite=${token}`), '/');
    assert.equal((await marco.get('/api/me')).data.role, 'commenter');
  });

  it('rejects a callback that does not match the request that started it', async () => {
    const c = new Client(app.base);
    await c.raw('GET', '/api/auth/oidc/start');
    const back = await c.raw('GET', '/api/auth/oidc/callback?code=whatever&state=forged');
    assert.equal(back.headers.get('location'), '/?auth_error=state');
  });
});
