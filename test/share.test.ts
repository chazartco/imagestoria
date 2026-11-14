import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client, fixture, startApp } from './helpers.js';

/** Public links to a story: the one way into the app without signing in. */
describe('public story links', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let owner: Client, viewer: Client, life: string, story: string;
  let a: string, b: string, outside: string;
  const visitor = () => new Client(app.base); // nobody: no session at all
  const tokenOf = (url: string) => new URL(url).pathname.split('/').pop()!;
  const mk = async (body: unknown = {}) => (await owner.post(`/api/stories/${story}/links`, body)).data;

  before(async () => {
    app = await startApp('ai_test_share');
    owner = new Client(app.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
    life = (await owner.get('/api/bootstrap')).data.spaces[0].id;
    [a, b, outside] = await Promise.all(['seaside.jpg', 'clip.mp4', 'plain.png'].map(async (f) => (await owner.upload(fixture(f), life)).data.id)) as [string, string, string];
    await owner.settled();
    await owner.json('PATCH', `/api/items/${a}`, { title: 'The bay', desc: 'a private note' });
    await owner.post(`/api/items/${a}/tags`, { add: ['secret-tag'] });
    story = (await owner.post('/api/stories', { title: 'For friends', spaceId: life, ids: [a, b] })).data.id;
    await owner.json('PATCH', `/api/stories/${story}`, { intro: 'Hello, friends.' });
    const inv = await owner.post('/api/people/invite', { who: 'maria@example.com', role: 'viewer', spaceIds: [life] });
    viewer = new Client(app.base);
    await viewer.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: 'Maria', email: 'maria@example.com', password: 'a long enough password' });
  });
  after(async () => { await app.stop(); });

  it('lets someone with the link read the story without signing in, and nothing else', async () => {
    const link = await mk();
    assert.match(link.url, /^http:\/\/127\.0\.0\.1:\d+\/s\/[\w-]{24,}$/);
    assert.deepEqual([link.label, link.allowDownload, link.allowAdd, link.hasPassword, link.uses], ['Link 1', false, false, false, 0]);
    const v = visitor(), t = tokenOf(link.url);
    const r = await v.get(`/api/share/${t}`);
    assert.equal(r.status, 200);
    assert.deepEqual([r.data.story.title, r.data.story.intro, r.data.can], ['For friends', 'Hello, friends.', { download: false, add: false }]);
    assert.deepEqual(r.data.items.map((i: any) => i.id).sort(), [a, b].sort(), 'only the pictures of this story');
    const pic = r.data.items.find((i: any) => i.id === a);
    assert.deepEqual([pic.title, pic.fileName, pic.w > 0], ['The bay', 'photo', true], 'the real file name is not given away without downloads');
    assert.ok(!JSON.stringify(r.data).includes('secret-tag') && !JSON.stringify(r.data).includes('a private note') && !('lat' in pic), 'no tags, descriptions or coordinates');
    // the small copies, and a video's file so it can play
    assert.deepEqual(await Promise.all([[a, 'thumb'], [a, 'display'], [b, 'orig'], [b, 'thumb']].map(async ([id, k]) => (await v.raw('GET', `/api/share/${t}/files/${id}/${k}`)).status)), [200, 200, 200, 200]);
    // not a photo's original, not a download, not a picture from outside the story, not the rest of the app
    assert.deepEqual(await Promise.all([`files/${a}/orig`, `files/${a}/full`, `files/${a}/display?download=1`, `files/${outside}/thumb`, `files/${a}/nonsense`].map(async (p) => (await v.raw('GET', `/api/share/${t}/${p}`)).status)), [403, 403, 403, 404, 404]);
    assert.deepEqual([(await v.get('/api/index')).status, (await v.get('/api/stories')).status, (await v.raw('GET', `/api/files/${a}/thumb`)).status], [401, 401, 401]);
    assert.equal((await v.post(`/api/share/${t}/upload`)).status, 403, 'adding is off for this link');
    assert.equal((await visitor().get('/api/share/not-a-real-token-at-all-0000')).status, 404);
    const seen = (await owner.get(`/api/stories/${story}/access`)).data.links[0];
    assert.ok(seen.uses === 1 && seen.lastUsed > Date.now() - 60000, 'the owner can see the link was opened');
  });

  it('keeps several links for one story, each with its own options', async () => {
    const dl = await mk({ label: 'Family, with downloads', allowDownload: true });
    const links = (await owner.get(`/api/stories/${story}/access`)).data.links;
    assert.deepEqual(links.map((l: any) => [l.label, l.allowDownload]), [['Link 1', false], ['Family, with downloads', true]]);
    const v = visitor(), t = tokenOf(dl.url);
    const r = await v.get(`/api/share/${t}`);
    assert.deepEqual([r.data.can, r.data.items.find((i: any) => i.id === a).fileName], [{ download: true, add: false }, 'seaside.jpg']);
    const file = await v.raw('GET', `/api/share/${t}/files/${a}/orig?download=1`);
    assert.equal(file.status, 200); assert.match(file.headers.get('content-disposition') ?? '', /attachment; filename\*=UTF-8''seaside\.jpg/);
    assert.equal(Buffer.from(await file.arrayBuffer()).length, fs.statSync(fixture('seaside.jpg')).size, 'the original, byte for byte');
    // the first link is still view only
    assert.equal((await v.raw('GET', `/api/share/${tokenOf(links[0].url)}/files/${a}/orig`)).status, 403);
    // options can be changed afterwards
    assert.equal((await owner.json('PATCH', `/api/story-links/${dl.id}`, { allowDownload: false, label: 'Family' })).data.allowDownload, false);
    assert.equal((await v.raw('GET', `/api/share/${t}/files/${a}/orig?download=1`)).status, 403);
  });

  it('asks for a password when the link has one', async () => {
    const link = await mk({ label: 'Locked', password: 'tacos al pastor' });
    assert.equal(link.hasPassword, true);
    assert.equal((await owner.post(`/api/stories/${story}/links`, { password: 'abc' })).status, 400, 'a very short password is refused');
    const v = visitor(), t = tokenOf(link.url);
    assert.deepEqual((await v.get(`/api/share/${t}`)).data, { locked: true }, 'nothing about the story is given before the password');
    assert.equal((await v.raw('GET', `/api/share/${t}/files/${a}/thumb`)).status, 401);
    assert.equal((await v.post(`/api/share/${t}/unlock`, { password: 'wrong' })).status, 401);
    assert.equal((await v.post(`/api/share/${t}/unlock`, { password: 'tacos al pastor' })).status, 200);
    assert.equal((await v.get(`/api/share/${t}`)).data.story.title, 'For friends');
    assert.equal((await v.raw('GET', `/api/share/${t}/files/${a}/thumb`)).status, 200);
    assert.equal((await visitor().raw('GET', `/api/share/${t}/files/${a}/thumb`)).status, 401, 'another visitor still has to type it');
    // a new password locks out whoever knew the old one. Removing it opens the link.
    await owner.json('PATCH', `/api/story-links/${link.id}`, { password: 'new password' });
    assert.deepEqual((await v.get(`/api/share/${t}`)).data, { locked: true });
    assert.equal((await owner.json('PATCH', `/api/story-links/${link.id}`, { password: null })).data.hasPassword, false);
    assert.equal((await visitor().get(`/api/share/${t}`)).data.story.title, 'For friends');
  });

  it('lets a visitor add their own photos when the link allows it', async () => {
    const link = await mk({ label: 'Add yours', allowAdd: true });
    const v = visitor(), t = tokenOf(link.url);
    assert.equal((await v.get(`/api/share/${t}`)).data.can.add, true);
    const fd = new FormData(); fd.set('lastModified', String(Date.UTC(2024, 5, 1, 12))); fd.set('tzOffset', '0');
    fd.set('file', new Blob([fs.readFileSync(fixture('sideways.jpg'))]), 'sideways.jpg');
    const up = await v.raw('POST', `/api/share/${t}/upload`, { body: fd });
    assert.equal(up.status, 200); const added = (await up.json() as any).id;
    await owner.settled();
    const row = (await owner.get('/api/index')).data.items.find((i: any) => i.id === added);
    assert.deepEqual([row.space, row.status, row.fileName], [life, 'ready', 'sideways.jpg'], 'it is a normal item in the story\'s space');
    assert.ok((await owner.get('/api/stories')).data.stories.find((s: any) => s.id === story).ids.includes(added), 'and part of the story');
    assert.ok((await v.get(`/api/share/${t}`)).data.items.some((i: any) => i.id === added), 'the visitor sees it too');
    // not a photo: refused. And the visitor still cannot do anything else.
    const bad = new FormData(); bad.set('file', new Blob(['hello']), 'notes.txt');
    assert.equal((await v.raw('POST', `/api/share/${t}/upload`, { body: bad })).status, 415);
    assert.deepEqual([(await v.json('PATCH', `/api/stories/${story}`, { title: 'hacked' })).status, (await v.post('/api/items/bulk', { ids: [added], action: 'delete' })).status], [401, 401]);
    assert.ok((await owner.get('/api/admin/overview')).data.activity.some((x: any) => /A visitor \(Add yours\)/.test(x.who) && /through a public link/.test(x.text)));
  });

  it('is made and ended only by people who may change the story, and a deleted link stops at once', async () => {
    assert.equal((await viewer.post(`/api/stories/${story}/links`, {})).status, 404, 'a viewer the story is not shared with cannot even see it');
    await owner.json('PATCH', `/api/stories/${story}`, { shared: [(await viewer.get('/api/me')).data.id] });
    const links = (await owner.get(`/api/stories/${story}/access`)).data.links;
    assert.deepEqual([(await viewer.post(`/api/stories/${story}/links`, {})).status, (await viewer.get(`/api/stories/${story}/access`)).status, (await viewer.json('PATCH', `/api/story-links/${links[0].id}`, { allowDownload: true })).status, (await viewer.json('DELETE', `/api/story-links/${links[0].id}`)).status], [403, 403, 403, 403]);
    const t = tokenOf(links[0].url), v = visitor();
    assert.equal((await v.get(`/api/share/${t}`)).status, 200);
    assert.equal((await owner.json('DELETE', `/api/story-links/${links[0].id}`)).status, 200);
    assert.deepEqual([(await v.get(`/api/share/${t}`)).status, (await v.raw('GET', `/api/share/${t}/files/${a}/thumb`)).status], [404, 404]);
    assert.match((await v.get(`/api/share/${t}`)).data.error, /may have been turned off/);
    // a picture taken out of the story, or put in the trash, is gone from every link
    const other = tokenOf(links[1].url);
    await owner.json('PATCH', `/api/stories/${story}`, { remove: [b] });
    assert.equal((await v.raw('GET', `/api/share/${other}/files/${b}/thumb`)).status, 404);
    await owner.post('/api/items/bulk', { ids: [a], action: 'delete' });
    assert.equal((await v.raw('GET', `/api/share/${other}/files/${a}/thumb`)).status, 404);
    await owner.post('/api/trash/restore');
    // deleting the story ends its links too
    await owner.json('DELETE', `/api/stories/${story}`);
    assert.equal((await v.get(`/api/share/${other}`)).status, 404);
    assert.equal((await app.pool.query('select count(*)::int n from story_links')).rows[0].n, 0);
    assert.ok(fs.existsSync(path.join(app.dataDir, 'media')), 'the files themselves are untouched');
  });
});
