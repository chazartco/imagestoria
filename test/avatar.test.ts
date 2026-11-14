import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { Client, fixture, startApp } from './helpers.js';

describe('profile pictures', () => {
  let app: Awaited<ReturnType<typeof startApp>>, owner: Client, viewer: Client, me: string;
  const send = async (who: Client, file: string, name = path.basename(file)) => { const fd = new FormData(); fd.set('file', new Blob([fs.readFileSync(file)]), name); const res = await who.raw('POST', '/api/me/avatar', { body: fd }); return { status: res.status, data: await res.json() as any }; };
  before(async () => {
    app = await startApp('ai_test_avatar');
    owner = new Client(app.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
    const b = (await owner.get('/api/bootstrap')).data; me = b.me.id;
    const inv = await owner.post('/api/people/invite', { who: 'vera@example.com', role: 'viewer', spaceIds: [b.spaces[0].id] }); viewer = new Client(app.base);
    await viewer.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: 'Vera', email: 'vera@example.com', password: 'a long enough password' });
  });
  after(async () => { await app.stop(); });

  it('starts with none', async () => {
    const b = (await owner.get('/api/bootstrap')).data; assert.equal(b.me.avatar, null); assert.ok(b.people.every((p: any) => p.avatar === null && !('avatarKey' in p)));
    assert.equal((await owner.raw('GET', `/api/avatars/${me}`)).status, 404);
  });

  it('keeps a small square copy of the picture a person sends, turned upright', async () => {
    const r = await send(owner, fixture('sideways.jpg')); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.avatar, /^[0-9a-f]{12}$/);
    const pic = await owner.raw('GET', `/api/avatars/${me}`); assert.equal(pic.status, 200); assert.equal(pic.headers.get('content-type'), 'image/webp');
    const meta = await sharp(Buffer.from(await pic.arrayBuffer())).metadata(); assert.deepEqual([meta.width, meta.height, meta.format], [256, 256, 'webp']);
    // everyone signed in sees it beside that person's name, and nobody else does
    for (const who of [owner, viewer]) assert.equal((await who.get('/api/bootstrap')).data.people.find((p: any) => p.id === me).avatar, r.data.avatar);
    assert.equal((await owner.get('/api/people')).data.people.find((p: any) => p.id === me).avatar, r.data.avatar);
    assert.equal((await viewer.raw('GET', `/api/avatars/${me}`)).status, 200);
    assert.equal((await new Client(app.base).raw('GET', `/api/avatars/${me}`)).status, 401);
    assert.equal((await new Client(app.base).raw('POST', '/api/me/avatar', { body: new FormData() })).status, 401);
  });

  it('replaces the old file with the new one, and refuses what is not a picture', async () => {
    const dir = path.join(app.dataDir, 'media', 'avatars'), first = fs.readdirSync(dir);
    assert.equal(first.length, 1);
    const r = await send(owner, fixture('seaside.jpg')); assert.equal(r.status, 200);
    const now = fs.readdirSync(dir); assert.equal(now.length, 1); assert.notEqual(now[0], first[0]);
    const bad = await send(owner, fixture('clip.mp4')); assert.equal(bad.status, 415); assert.match(bad.data.error, /could not be read as a picture/);
    assert.equal((await owner.get('/api/me')).data.avatar, r.data.avatar, 'a refused file changes nothing');
    // one person cannot set another's: the route only ever touches the person who is signed in
    await send(viewer, fixture('plain.png')); assert.equal((await owner.get('/api/me')).data.avatar, r.data.avatar); assert.equal(fs.readdirSync(dir).length, 2);
  });

  it('is removed on request, file and all', async () => {
    assert.equal((await owner.json('DELETE', '/api/me/avatar')).status, 200);
    assert.equal((await owner.get('/api/me')).data.avatar, null); assert.equal((await owner.raw('GET', `/api/avatars/${me}`)).status, 404);
    assert.equal(fs.readdirSync(path.join(app.dataDir, 'media', 'avatars')).length, 1, 'only the other person\'s is left');
  });
});
