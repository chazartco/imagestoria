import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { Client, fixture, startApp } from './helpers.js';

describe('library, files, edits, people', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let owner: Client, life: string, studio: string;

  before(async () => { app = await startApp('ai_test_api'); owner = new Client(app.base); });
  after(async () => { await app.stop(); });

  it('starts empty and lets the first person become the owner', async () => {
    const b = await owner.get('/api/bootstrap');
    assert.equal(b.data.setupNeeded, true);
    assert.equal(b.data.me, null);
    assert.equal((await owner.get('/api/index')).status, 401);
    const weak = await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'short' });
    assert.equal(weak.status, 400);
    const ok = await owner.post('/api/setup', { name: 'Chaz', email: 'Chaz@Example.com', password: 'correct horse battery' });
    assert.equal(ok.status, 200);
    const again = await new Client(app.base).post('/api/setup', { name: 'Eve', email: 'eve@example.com', password: 'correct horse battery' });
    assert.equal(again.status, 409);
    const me = (await owner.get('/api/bootstrap')).data;
    assert.equal(me.me.role, 'owner');
    assert.deepEqual(me.spaces.map((s: any) => s.name), ['Life', 'Studio']);
    [life, studio] = me.spaces.map((s: any) => s.id);
  });

  it('refuses changes that do not come from its own page', async () => {
    const res = await fetch(app.base + '/api/auth/logout', { method: 'POST', headers: { cookie: [...owner.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(res.status, 403);
  });

  it('signs in with the right password only', async () => {
    const c = new Client(app.base);
    assert.equal((await c.post('/api/auth/login', { email: 'chaz@example.com', password: 'wrong wrong wrong' })).status, 401);
    assert.equal((await c.post('/api/auth/login', { email: 'CHAZ@example.com', password: 'correct horse battery' })).status, 200);
    assert.equal((await c.get('/api/me')).data.name, 'Chaz');
    await c.post('/api/auth/logout');
    assert.equal((await c.get('/api/me')).status, 401);
  });

  it('reads date, place and camera from an upload and makes the WebP copies', async () => {
    const up = await owner.upload(fixture('seaside.jpg'), life);
    assert.equal(up.status, 200, JSON.stringify(up.data));
    const idx = await owner.settled();
    const it0 = idx.items.find((i: any) => i.id === up.data.id);
    assert.equal(it0.status, 'ready', it0.error);
    assert.equal(it0.d, '2026-08-14T17:42:10', 'the camera clock time is kept as is');
    assert.equal(it0.w, 3000); assert.equal(it0.h, 2000);
    assert.equal(it0.cam, 'FUJIFILM X-T5'); assert.equal(it0.shutter, '1/500'); assert.equal(it0.iso, 200);
    assert.ok(Math.abs(it0.lat - 39.47) < 1e-3 && Math.abs(it0.lng + 0.375) < 1e-3);
    assert.equal(idx.places[it0.place].name, 'Valencia');
    assert.equal(it0.palette.length, 5);
    for (const [kind, maxSide] of [['thumb', 540], ['display', 1600]] as const) {
      const res = await owner.raw('GET', `/api/files/${it0.id}/${kind}`);
      assert.equal(res.status, 200);
      const m = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
      assert.equal(m.format, 'webp');
      assert.equal(Math.max(m.width!, m.height!), maxSide);
      assert.ok(Math.abs(m.width! / m.height! - 1.5) < 0.01, 'the copy keeps the full shape, nothing cropped');
    }
    const orig = await owner.raw('GET', `/api/files/${it0.id}/orig`);
    assert.equal(Buffer.from(await orig.arrayBuffer()).length, fs.statSync(fixture('seaside.jpg')).size, 'the original is stored byte for byte');
    const part = await owner.raw('GET', `/api/files/${it0.id}/orig`, { headers: { range: 'bytes=0-99' } });
    assert.equal(part.status, 206); assert.equal((await part.arrayBuffer()).byteLength, 100);
    const dl = await owner.raw('GET', `/api/files/${it0.id}/orig?download=1`);
    assert.match(dl.headers.get('content-disposition') ?? '', /attachment; filename\*=UTF-8''seaside\.jpg/);
  });

  it('skips a file it already has', async () => {
    const up = await owner.upload(fixture('seaside.jpg'), life);
    assert.equal(up.data.duplicate, true);
    assert.equal((await owner.get('/api/index')).data.items.length, 1);
  });

  it('turns a sideways phone photo upright, opens HEIC, and takes a poster from a video', async () => {
    const a = await owner.upload(fixture('sideways.jpg'), life), b = await owner.upload(fixture('iphone.heic'), life), c = await owner.upload(fixture('clip.mp4'), life), d = await owner.upload(fixture('plain.png'), studio);
    const idx = await owner.settled(60000);
    const by = (id: string) => idx.items.find((i: any) => i.id === id);
    assert.equal(by(a.data.id).w, 1200); assert.equal(by(a.data.id).h, 1600);
    assert.equal(by(a.data.id).cam, 'iPhone 15 Pro');
    const heic = by(b.data.id);
    assert.equal(heic.status, 'ready', heic.error);
    assert.equal(heic.w, 2016); assert.equal(heic.d, '2026-02-13T08:05:00'); assert.equal(heic.hasFull, true);
    assert.equal(idx.places[heic.place].name, 'Loreto');
    const full = await sharp(Buffer.from(await (await owner.raw('GET', `/api/files/${heic.id}/full`)).arrayBuffer())).metadata();
    assert.equal(full.format, 'webp'); assert.equal(full.width, 2016);
    const vid = by(c.data.id);
    assert.equal(vid.kind, 'video'); assert.equal(vid.status, 'ready', vid.error); assert.equal(vid.w, 640); assert.equal(Math.round(vid.duration), 3);
    assert.equal((await owner.raw('GET', `/api/files/${vid.id}/thumb`)).status, 200);
    const png = by(d.data.id);
    assert.equal(png.d, '2024-01-02T05:00:00', 'with no camera date, the file date in the uploader\'s own time zone is used');
    assert.equal(png.space, studio);
    const notMedia = path.join(app.dataDir, 'notes.txt'); fs.writeFileSync(notMedia, 'hello');
    assert.equal((await owner.upload(notMedia, life)).status, 415);
  });

  it('keeps titles, tags, likes and comments, and reports only what changed', async () => {
    const before = (await owner.get('/api/index')).data;
    const id = before.items.find((i: any) => i.fileName === 'seaside.jpg').id;
    await new Promise((r) => setTimeout(r, 2100));
    const mark = Date.now();
    assert.equal((await owner.json('PATCH', `/api/items/${id}`, { title: 'Last light on the bay', desc: 'From the café.' })).status, 200);
    await owner.post(`/api/items/${id}/tags`, { add: ['Print Candidate', 'portfolio'] });
    await owner.post(`/api/items/${id}/tags`, { remove: ['portfolio'] });
    await owner.json('PUT', `/api/items/${id}/like`);
    const cm = await owner.post(`/api/items/${id}/comments`, { text: 'This one belongs on a wall.' });
    assert.equal(cm.status, 200);
    const delta = (await owner.get(`/api/index?since=${mark}`)).data;
    assert.equal(delta.items.length, 1);
    const it0 = delta.items[0];
    assert.equal(it0.title, 'Last light on the bay'); assert.deepEqual(it0.tags, ['print candidate']); assert.equal(it0.likes.length, 1); assert.equal(it0.nc, 1);
    const detail = (await owner.get(`/api/items/${id}`)).data;
    assert.equal(detail.comments[0].text, 'This one belongs on a wall.');
    await owner.json('DELETE', `/api/comments/${cm.data.id}`);
    await owner.json('DELETE', `/api/items/${id}/like`);
    const now = (await owner.get('/api/index')).data.items.find((i: any) => i.id === id);
    assert.equal(now.nc, 0); assert.equal(now.likes.length, 0);
  });

  it('renders an edit from the full-size original as a separate copy', async () => {
    const id = (await owner.get('/api/index')).data.items.find((i: any) => i.fileName === 'seaside.jpg').id;
    const empty = await owner.post(`/api/items/${id}/copies`, { recipe: { adj: {}, geo: { rot: 0, flipH: false, flipV: false, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } }, curve: [0, 0.25, 0.5, 0.75, 1] } });
    assert.equal(empty.status, 400);
    const recipe = { adj: { exposure: 40, saturation: -100, vignette: 30, clarity: 20 }, geo: { rot: 1, flipH: false, flipV: false, straighten: 0, crop: { x: 0.25, y: 0, w: 0.5, h: 0.5 } }, curve: [0, 0.2, 0.5, 0.8, 1], look: 'Silver' };
    const made = await owner.post(`/api/items/${id}/copies`, { recipe });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    const idx = await owner.settled(60000);
    const copy = idx.items.find((i: any) => i.id === made.data.id);
    assert.equal(copy.status, 'ready', copy.error);
    assert.equal(copy.copyOf, id); assert.equal(copy.title, 'Last light on the bay (edit)');
    // 3000x2000 turned a quarter is 2000x3000; half of each side is 1000x1500.
    assert.equal(copy.w, 1000); assert.equal(copy.h, 1500);
    const px = await sharp(Buffer.from(await (await owner.raw('GET', `/api/files/${copy.id}/orig`)).arrayBuffer())).resize(8, 8).raw().toBuffer();
    assert.ok(Math.abs(px[0]! - px[1]!) <= 3 && Math.abs(px[1]! - px[2]!) <= 3, 'saturation -100 gives a gray picture');
    assert.deepEqual((await owner.get(`/api/items/${copy.id}`)).data.recipe.look, 'Silver');
    const src = idx.items.find((i: any) => i.id === id);
    assert.equal(src.w, 3000, 'the original is untouched');
  });

  it('renders a version 2 recipe: channel curves, the color mixer and intensity', async () => {
    const id = (await owner.get('/api/index')).data.items.find((i: any) => i.fileName === 'plain.png').id;
    const geo = { rot: 0, flipH: false, flipV: false, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } }, flat = [0, 0.25, 0.5, 0.75, 1];
    const mean = async (item: string) => { const s = await sharp(Buffer.from(await (await owner.raw('GET', `/api/files/${item}/orig`)).arrayBuffer())).removeAlpha().stats(); return s.channels.map((c) => c.mean); };
    const post = (recipe: any) => owner.post(`/api/items/${id}/copies`, { recipe });
    // refused: a version this server does not know, and a channel curve with the wrong number of points
    assert.equal((await post({ v: 3, adj: { matte: 20 }, geo, curve: flat })).status, 400);
    assert.equal((await post({ v: 2, adj: { matte: 20 }, geo, curve: flat, curves: { r: [0, 1], g: flat, b: flat } })).status, 400);
    assert.equal((await post({ v: 2, adj: { matte: 20, amount: 0 }, geo, curve: flat })).status, 400, 'a look at no intensity changes nothing');
    const made = await post({ v: 2, adj: { amount: 100 }, geo, curve: flat, curves: { r: [0, 0.4, 0.7, 0.9, 1], g: flat, b: flat }, look: 'Custom' });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    const halfway = await post({ v: 2, adj: { amount: 50 }, geo, curve: flat, curves: { r: [0, 0.4, 0.7, 0.9, 1], g: flat, b: flat } });
    const idx = await owner.settled(60000), copy = idx.items.find((i: any) => i.id === made.data.id);
    assert.equal(copy.status, 'ready', copy.error);
    const [a, b, c] = [await mean(id), await mean(made.data.id), await mean(halfway.data.id)];
    assert.ok(b[0]! > a[0]! + 8 && Math.abs(b[1]! - a[1]!) < 2 && Math.abs(b[2]! - a[2]!) < 2, `only red is lifted: ${a} to ${b}`);
    assert.ok(Math.abs(c[0]! - (a[0]! + b[0]!) / 2) < 2, 'half intensity is halfway');
    assert.equal((await owner.get(`/api/items/${made.data.id}`)).data.recipe.v, 2);
    const gone = [made.data.id, halfway.data.id]; await owner.post('/api/items/bulk', { ids: gone, action: 'delete' }); await owner.post('/api/trash/empty', { ids: gone });
  });

  it('invites people, limits them to their role and their spaces', async () => {
    const inv = await owner.post('/api/people/invite', { who: 'june@example.com', role: 'viewer', spaceIds: [life] });
    assert.equal(inv.status, 200);
    const token = new URL(inv.data.link).searchParams.get('invite')!;
    const june = new Client(app.base);
    assert.equal((await june.get(`/api/auth/link/${token}`)).data.role, 'viewer');
    assert.equal((await june.post('/api/auth/accept-invite', { token, name: 'June Park', email: 'june@example.com', password: 'a long enough password' })).status, 200);
    assert.equal((await june.post('/api/auth/accept-invite', { token, name: 'x', email: 'x@example.com', password: 'a long enough password' })).status, 404, 'an invite works once');
    const idx = (await june.get('/api/index')).data;
    assert.ok(idx.items.length > 0 && idx.items.every((i: any) => i.space === life), 'she sees Life only');
    const studioItem = (await owner.get('/api/index')).data.items.find((i: any) => i.space === studio).id;
    assert.equal((await june.raw('GET', `/api/files/${studioItem}/thumb`)).status, 403);
    const lifeItem = idx.items[0].id;
    assert.equal((await june.upload(fixture('plain.png'), life)).status, 403);
    assert.equal((await june.post(`/api/items/${lifeItem}/comments`, { text: 'hi' })).status, 403);
    assert.equal((await june.json('PATCH', `/api/items/${lifeItem}`, { title: 'mine now' })).status, 403);
    assert.equal((await june.raw('GET', `/api/files/${lifeItem}/orig?download=1`)).status, 403);
    assert.equal((await june.json('PUT', `/api/items/${lifeItem}/like`)).status, 200, 'anyone who can see a photo can like it');
    assert.equal((await june.get('/api/people')).status, 403);
    assert.equal((await june.post('/api/items/bulk', { ids: [lifeItem], action: 'delete' })).status, 403);
    // The owner lets June comment, and moves her up to editor later.
    const people = (await owner.get('/api/people')).data.people;
    const j = people.find((p: any) => p.name === 'June Park');
    await owner.json('PATCH', `/api/people/${j.id}`, { caps: { comment: true } });
    assert.equal((await june.post(`/api/items/${lifeItem}/comments`, { text: 'Where was this?' })).status, 200);
    await owner.json('PATCH', `/api/people/${j.id}`, { status: 'disabled' });
    assert.equal((await june.get('/api/index')).status, 401, 'a disabled person is signed out at once');
    assert.equal((await owner.json('PATCH', `/api/people/${(await owner.get('/api/me')).data.id}`, { role: 'viewer' })).status, 400, 'the last owner cannot be demoted');
  });

  it('keeps stories private to the people they are shared with', async () => {
    const ids = (await owner.get('/api/index')).data.items.filter((i: any) => i.space === life).map((i: any) => i.id);
    const made = await owner.post('/api/stories', { title: 'Road trip to Loreto', spaceId: life, ids });
    assert.equal(made.status, 200);
    await owner.json('PATCH', `/api/stories/${made.data.id}`, { intro: 'Five days north.', notes: { 'Fri Feb 13 2026': 'We left early.' } });
    const inv = await owner.post('/api/people/invite', { who: 'tomas@example.com', role: 'commenter', spaceIds: [life] });
    const t = new Client(app.base);
    await t.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: 'Tomás', email: 'tomas@example.com', password: 'a long enough password' });
    assert.equal((await t.get('/api/stories')).data.stories.length, 0);
    await owner.json('PATCH', `/api/stories/${made.data.id}`, { shared: [(await t.get('/api/me')).data.id] });
    const seen = (await t.get('/api/stories')).data.stories;
    assert.equal(seen.length, 1); assert.equal(seen[0].intro, 'Five days north.'); assert.equal(seen[0].ids.length, ids.length);
    assert.equal((await t.json('DELETE', `/api/stories/${made.data.id}`)).status, 403);
  });

  it('moves deletions to the trash and removes the files only when it is emptied', async () => {
    const idx = (await owner.get('/api/index')).data;
    const victim = idx.items.find((i: any) => i.fileName === 'plain.png');
    const detail = (await owner.get(`/api/items/${victim.id}`)).data;
    const onDisk = (k: string) => fs.existsSync(path.join(app.dataDir, 'media', k));
    assert.ok(onDisk(detail.keys.orig) && onDisk(detail.keys.thumb));
    await new Promise((r) => setTimeout(r, 2100));
    const mark = Date.now();
    assert.equal((await owner.post('/api/items/bulk', { ids: [victim.id], action: 'delete' })).data.n, 1);
    assert.deepEqual((await owner.get(`/api/index?since=${mark}`)).data.removed, [victim.id]);
    assert.ok(onDisk(detail.keys.orig), 'still on disk while in the trash');
    assert.equal((await owner.get('/api/trash')).data.items.length, 1);
    await owner.post('/api/trash/restore');
    assert.ok((await owner.get('/api/index')).data.items.some((i: any) => i.id === victim.id));
    await owner.post('/api/items/bulk', { ids: [victim.id], action: 'delete' });
    assert.equal((await owner.post('/api/trash/empty')).data.n, 1);
    assert.ok(!onDisk(detail.keys.orig) && !onDisk(detail.keys.thumb) && !onDisk(detail.keys.display));
    const o = (await owner.get('/api/admin/overview')).data;
    assert.equal(o.trash.n, 0); assert.ok(o.storage.orig > 0 && o.activity.length > 0);
  });

  it('lets the owner add, rename and remove spaces', async () => {
    const made = await owner.post('/api/spaces', { name: 'Client Work', kind: 'studio' });
    assert.equal(made.data.slug, 'client-work');
    await owner.json('PATCH', `/api/spaces/${made.data.id}`, { name: 'Commissions' });
    assert.ok((await owner.get('/api/bootstrap')).data.spaces.some((s: any) => s.name === 'Commissions'));
    assert.equal((await owner.json('DELETE', `/api/spaces/${life}`)).status, 409, 'a space with items in it cannot be removed');
    // the order of the tabs is the owner's, and a new space goes last
    const names = async () => (await owner.get('/api/bootstrap')).data.spaces.map((s: any) => s.name);
    assert.deepEqual(await names(), ['Life', 'Studio', 'Commissions']);
    assert.equal((await owner.post('/api/spaces/order', { ids: [made.data.id, studio, life] })).status, 200);
    assert.deepEqual(await names(), ['Commissions', 'Studio', 'Life']);
    await owner.post('/api/spaces', { name: 'Family' });
    assert.deepEqual(await names(), ['Commissions', 'Studio', 'Life', 'Family']);
    assert.equal((await owner.post('/api/spaces/order', { ids: [life, life] })).status, 400);
    assert.equal((await owner.post('/api/spaces/order', { ids: [life, '00000000-0000-4000-8000-000000000000'] })).status, 400);
    assert.equal((await owner.post('/api/spaces/order', { ids: [life] })).status, 200, 'the ones left out keep their order after it');
    assert.deepEqual(await names(), ['Life', 'Commissions', 'Studio', 'Family']);
    assert.equal((await owner.json('DELETE', `/api/spaces/${made.data.id}`)).status, 200);
    await owner.post('/api/spaces/order', { ids: [life, studio] });
  });
  it('keeps a twin in the trash when the same file is already back in the library, and answers 404 for a file missing from storage', async () => {
    const before = (await owner.get('/api/index')).data.items.length;
    const first = (await owner.upload(fixture('plain.png'), life)).data;
    const a = first.id ?? (await owner.get('/api/index')).data.items.find((i: any) => i.fileName === 'plain.png').id;
    await owner.settled();
    await owner.post('/api/items/bulk', { ids: [a], action: 'delete' });
    const again = (await owner.upload(fixture('plain.png'), life)).data;
    assert.ok(again.id && !again.duplicate, 'a deleted file can be uploaded again');
    await owner.settled();
    const r = (await owner.post('/api/trash/restore')).data;
    assert.deepEqual([r.restored, r.skipped], [0, 1]);
    assert.equal((await owner.get('/api/trash')).data.items.length, 1);
    await owner.post('/api/trash/empty');
    assert.ok((await owner.get('/api/index')).data.items.length >= before);
    const keys = (await owner.get(`/api/items/${again.id}`)).data.keys;
    fs.rmSync(path.join(app.dataDir, 'media', keys.thumb));
    assert.equal((await owner.raw('GET', `/api/files/${again.id}/thumb`)).status, 404);
    assert.equal((await owner.raw('GET', `/api/files/${again.id}/display`)).status, 200);
  });
});
