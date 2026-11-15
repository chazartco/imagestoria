import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { Client, fixture, startApp } from './helpers.js';

/**
 * Published stories: the second way into a library without signing in. A visitor gets exactly what a share link
 * gives, for published stories only, and nothing about anything else.
 */
describe('published stories on the library’s own address', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let owner: Client, editor: Client, commenter: Client, viewer: Client, life: string;
  let a: string, b: string, c: string, outside: string, s1: string, s2: string, s3: string;
  const people: Record<string, string> = {};
  const visitor = () => new Client(app.base);
  const TITLE = 'Coast "road" <b>trip</b> & more', SLUG = 'coast-road-b-trip-b-more';
  const pub = (who: Client, story: string, body: unknown) => who.json('PATCH', `/api/stories/${story}/public`, body);
  const page = async (url: string) => { const res = await visitor().raw('GET', url); return { status: res.status, html: await res.text(), robots: res.headers.get('x-robots-tag'), csp: res.headers.get('content-security-policy'), limit: res.headers.get('x-ratelimit-limit') }; };
  const front = async () => (await visitor().get('/api/public')).data;
  const SECRETS = ['secret-tag', 'a private note', 'a private comment', 'SecretCam', 'SecretLens', 'Abuela', 'machine caption', '20.65', '105.22', 'seaside.jpg'];

  before(async () => {
    app = await startApp('ai_test_public');
    owner = new Client(app.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
    life = (await owner.get('/api/bootstrap')).data.spaces[0].id;
    const join = async (who: string, role: string) => {
      const inv = await owner.post('/api/people/invite', { who, role, spaceIds: [life] }), cl = new Client(app.base);
      await cl.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: who.split('@')[0], email: who, password: 'a long enough password' });
      people[role] = inv.data.id; return cl;
    };
    editor = await join('eva@example.com', 'editor'); commenter = await join('cora@example.com', 'commenter'); viewer = await join('vera@example.com', 'viewer');
    [a, b, c, outside] = await Promise.all(['seaside.jpg', 'clip.mp4', 'plain.png', 'sideways.jpg'].map(async (f) => (await owner.upload(fixture(f), life)).data.id)) as [string, string, string, string];
    await owner.settled(60000);
    // one picture with everything that must never leave: a tag, a description, a comment, where exactly, which camera, who is in it, what a machine said
    await owner.json('PATCH', `/api/items/${a}`, { title: 'The bay', desc: 'a private note', lat: 20.6534, lng: -105.2253 });
    await owner.post(`/api/items/${a}/tags`, { add: ['secret-tag'] });
    await owner.post(`/api/items/${a}/comments`, { text: 'a private comment' });
    await owner.json('PUT', `/api/items/${a}/like`);
    await app.pool.query(`update items set camera = 'SecretCam X', lens = 'SecretLens 50', iso = 100, ai_caption = 'machine caption words', ai_scene = 'beach' where id = $1`, [a]);
    const person = (await app.pool.query(`insert into persons (space_id, name) values ($1, 'Abuela') returning id`, [life])).rows[0].id;
    await app.pool.query(`insert into faces (item_id, x, y, w, h, vec, model, person_id, status) values ($1, 0.1, 0.1, 0.2, 0.2, $2, 'test', $3, 'confirmed')`, [a, Buffer.alloc(64, 1), person]);
    s1 = (await owner.post('/api/stories', { title: TITLE, spaceId: life, ids: [a, b] })).data.id;
    await owner.json('PATCH', `/api/stories/${s1}`, { intro: 'Three "days" south <i>of here</i>.', covers: [a], sections: [{ title: 'Day one', text: 'We left early.', ids: [a] }, { title: 'Day two', text: '', ids: [b] }] });
    s2 = (await owner.post('/api/stories', { title: 'Second story', spaceId: life, ids: [c] })).data.id;
    s3 = (await owner.post('/api/stories', { title: 'Private things', spaceId: life, ids: [outside] })).data.id;
  });
  after(async () => { await app.stop(); });

  it('publishes nothing by default: the address is the sign-in page, as it always was', async () => {
    const boot = (await visitor().get('/api/bootstrap')).data;
    assert.deepEqual([boot.me, boot.public], [null, false], 'the page shows the sign-in form');
    const none = await visitor().get('/api/public');
    assert.equal(none.status, 404); assert.deepEqual(none.data, { error: 'Nothing is published here.' });
    assert.equal((await visitor().get(`/api/public/stories/${SLUG}`)).status, 404);
    assert.equal((await visitor().raw('GET', `/api/public/stories/${SLUG}/files/${a}/thumb`)).status, 404);
    assert.deepEqual((await owner.get('/api/stories')).data.stories.map((s: any) => [s.public, s.featured, s.slug]), [[false, false, null], [false, false, null], [false, false, null]]);
    assert.deepEqual((await owner.get('/api/admin/public')).data, { title: '', line: '', index: false, logo: null, url: `${app.base}/p`, count: 0 });
    assert.equal((await visitor().raw('GET', '/robots.txt').then((r) => r.text())), 'User-agent: *\nDisallow: /\n');
    const root = await page('/');
    assert.deepEqual([root.status, root.robots, /<meta name="robots" content="noindex, nofollow">/.test(root.html)], [200, 'noindex, nofollow', true]);
    const none2 = await page('/p');
    assert.deepEqual([none2.status, none2.robots, /<meta name="robots" content="noindex, nofollow">/.test(none2.html)], [200, 'noindex, nofollow', true], '/p with nothing public is the same page, which shows the sign-in form');
  });

  it('lets the owner publish a story, and shows it to a visitor on the front page', async () => {
    const r = await pub(owner, s1, { public: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data, { public: true, featured: false, allowDownload: false, slug: SLUG, url: `${app.base}/p/${SLUG}` });
    assert.equal((await visitor().get('/api/bootstrap')).data.public, true, 'a visitor’s page now opens the public page instead of the sign-in form');
    const f = await front();
    assert.deepEqual(Object.keys(f).sort(), ['can', 'featured', 'items', 'limits', 'musicVersion', 'others', 'places', 'site', 'slug', 'story']);
    assert.deepEqual([f.slug, f.featured, f.site, f.can, f.others], [SLUG, false, { title: '', line: '', logo: null }, { download: false, add: false }, []]);
    assert.deepEqual([f.story.title, f.story.intro, f.story.sections.map((x: any) => [x.title, x.ids]), f.story.ids], [TITLE, 'Three "days" south <i>of here</i>.', [['Day one', [a]], ['Day two', [b]]], [a, b]]);
    assert.deepEqual((await visitor().get(`/api/public/stories/${SLUG}`)).data, f, 'the story’s own page is the same story');
    assert.deepEqual((await owner.get(`/api/stories/${s1}/access`)).data.published, r.data);
    assert.equal((await owner.get(`/api/stories/${s1}/access`)).data.links.length, 0, 'publishing makes no share link');
    assert.ok((await owner.get('/api/admin/overview')).data.activity.some((x: any) => /published the story/.test(x.text)));
    assert.equal((await owner.get('/api/admin/public')).data.count, 1);
  });

  it('gives a visitor exactly what a share link gives, and none of the private things', async () => {
    const f = await front(), text = JSON.stringify(f);
    for (const s of SECRETS) assert.ok(!text.includes(s), `${s} is not in what a visitor gets`);
    const pic = f.items.find((i: any) => i.id === a);
    assert.deepEqual(Object.keys(pic).sort(), ['d', 'duration', 'fileName', 'h', 'id', 'kind', 'palette', 'place', 'play', 'status', 'title', 'w']);
    for (const k of ['tags', 'desc', 'description', 'comments', 'nc', 'likes', 'lat', 'lng', 'cam', 'camera', 'lens', 'iso', 'people', 'faces', 'aiCaption', 'labels', 'keys', 'sha256', 'addedBy']) assert.ok(!(k in pic), `no ${k}`);
    assert.deepEqual([pic.title, pic.fileName], ['The bay', 'photo']);
    const place = f.places[pic.place];
    assert.ok(place, 'the picture is filed under a town');
    assert.deepEqual(Object.keys(place).sort(), ['lat', 'lng', 'name', 'region']); assert.deepEqual([Math.round(place.lat * 10) / 10, Math.round(place.lng * 10) / 10], [place.lat, place.lng], 'the town, to a tenth of a degree, never the spot');
    assert.deepEqual(Object.keys(f.story).sort(), ['cover', 'covers', 'ids', 'intro', 'music', 'notes', 'sections', 'title']);
    // the same serialiser as a share link: what the two give for the same story is the same, to the letter
    const token = new URL((await owner.post(`/api/stories/${s1}/links`, {})).data.url).pathname.split('/').pop();
    const shared = (await visitor().get(`/api/share/${token}`)).data;
    assert.deepEqual([f.story, f.items, f.places, f.can, f.limits], [shared.story, shared.items, shared.places, shared.can, shared.limits]);
    // and nothing of the app itself
    const v = visitor();
    assert.deepEqual([(await v.get('/api/index')).status, (await v.get('/api/stories')).status, (await v.raw('GET', `/api/files/${a}/thumb`)).status, (await v.get(`/api/items/${a}`)).status, (await v.get(`/api/stories/${s1}/access`)).status, (await v.get('/api/admin/public')).status], [401, 401, 401, 401, 401, 401]);
    assert.deepEqual([(await v.json('PATCH', `/api/stories/${s1}/public`, { featured: true })).status, (await v.json('PUT', '/api/admin/public', { index: true })).status], [401, 401]);
  });

  it('serves a public story’s pictures through that story only: small copies, a video to play, originals only with downloads', async () => {
    const v = visitor(), at = `/api/public/stories/${SLUG}`, st = async (p: string) => (await v.raw('GET', `${at}/${p}`)).status;
    assert.deepEqual([await st(`files/${a}/thumb`), await st(`files/${a}/display`), await st(`files/${b}/thumb`), await st(`files/${b}/orig`), await st(`files/${b}/play`)], [200, 200, 200, 200, 200]);
    assert.equal((await v.raw('GET', `${at}/files/${a}/display`)).headers.get('content-type'), 'image/webp');
    assert.deepEqual([await st(`files/${a}/orig`), await st(`files/${a}/full`), await st(`files/${a}/display?download=1`), await st(`files/${outside}/thumb`), await st(`files/${c}/thumb`), await st(`files/${a}/nonsense`), await st('files/not-an-id/thumb'), await st('music')], [403, 403, 403, 404, 404, 404, 404, 404]);
    // downloads, when the story allows them
    assert.equal((await pub(owner, s1, { allowDownload: true })).data.allowDownload, true);
    const f = await front();
    assert.deepEqual([f.can.download, f.items.find((i: any) => i.id === a).fileName], [true, 'seaside.jpg']);
    const file = await v.raw('GET', `${at}/files/${a}/orig?download=1`);
    assert.equal(file.status, 200); assert.match(file.headers.get('content-disposition') ?? '', /attachment; filename\*=UTF-8''seaside\.jpg/);
    assert.equal(Buffer.from(await file.arrayBuffer()).length, fs.statSync(fixture('seaside.jpg')).size);
    assert.equal((await pub(owner, s1, { allowDownload: false })).data.allowDownload, false);
    assert.equal(await st(`files/${a}/orig?download=1`), 403);
    // a picture in the trash is gone from the page and from the route. Back from the trash, it is back.
    await owner.post('/api/items/bulk', { ids: [a], action: 'delete' });
    assert.deepEqual([await st(`files/${a}/thumb`), (await front()).items.map((i: any) => i.id)], [404, [b]]);
    await owner.post('/api/trash/restore');
    assert.equal(await st(`files/${a}/thumb`), 200);
    // a picture taken out of the story is no longer reachable through it
    await owner.json('PATCH', `/api/stories/${s1}`, { remove: [b] });
    assert.equal(await st(`files/${b}/thumb`), 404);
    await owner.json('PATCH', `/api/stories/${s1}`, { add: [b] });
    // open to the world, so each address may only ask so often
    for (const url of ['/api/public', at, `${at}/files/${a}/thumb`, '/p', `/p/${SLUG}`, '/robots.txt']) assert.ok(Number((await v.raw('GET', url)).headers.get('x-ratelimit-limit')) >= 100, `${url} is rate limited`);
  });

  it('lets an editor publish only when the owner turned “Publish stories” on for them, and never a commenter or viewer', async () => {
    const caps = async (who: Client) => (await who.get('/api/bootstrap')).data.me.caps.publish;
    assert.deepEqual([await caps(owner), await caps(editor), await caps(commenter), await caps(viewer)], [true, false, false, false]);
    assert.deepEqual([(await pub(editor, s2, { public: true })).status, (await pub(commenter, s2, { public: true })).status, (await pub(viewer, s2, { public: true })).status], [403, 403, 403]);
    assert.deepEqual([(await pub(editor, s1, { public: false })).status, (await pub(editor, s1, { slug: 'mine-now' })).status, (await pub(editor, s1, { featured: true })).status], [403, 403, 403], 'nor change what is published');
    assert.equal((await editor.get(`/api/stories/${s2}/access`)).data.mayPublish, false);
    // only the owner grants it, and only to an editor
    assert.equal((await editor.json('PATCH', `/api/people/${people.editor}`, { caps: { publish: true } })).status, 403);
    for (const role of ['commenter', 'viewer']) {
      const r = await owner.json('PATCH', `/api/people/${people[role]}`, { caps: { publish: true } });
      assert.equal(r.status, 400, role); assert.match(r.data.error, /Only an editor can be allowed to publish stories/);
    }
    assert.deepEqual([await caps(commenter), await caps(viewer)], [false, false]);
    assert.equal((await owner.json('PATCH', `/api/people/${people.editor}`, { caps: { publish: true } })).status, 200);
    assert.equal(await caps(editor), true);
    assert.equal((await owner.get('/api/people')).data.people.find((u: any) => u.id === people.editor).caps.publish, true);
    const r = await pub(editor, s2, { public: true });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.slug, 'second-story');
    assert.equal((await editor.get(`/api/stories/${s2}/access`)).data.mayPublish, true);
    // a switch left on in the database does nothing for someone who is not an editor
    await app.pool.query(`update users set caps = '{"publish": true}'::jsonb where id = $1`, [people.viewer]);
    assert.deepEqual([await caps(viewer), (await pub(viewer, s2, { public: false })).status], [false, 403]);
    // it goes when the person stops being an editor, and does not come back by itself
    await owner.json('PATCH', `/api/people/${people.editor}`, { role: 'commenter' });
    assert.deepEqual([await caps(editor), (await pub(editor, s2, { public: false })).status], [false, 403]);
    await owner.json('PATCH', `/api/people/${people.editor}`, { role: 'editor' });
    assert.equal(await caps(editor), false);
    // the page's own settings are the owner's
    assert.deepEqual([(await editor.get('/api/admin/public')).status, (await editor.json('PUT', '/api/admin/public', { index: true })).status], [403, 403]);
    await owner.json('PATCH', `/api/people/${people.editor}`, { caps: { publish: true } });
  });

  it('shows the featured story open, or the newest when none is featured, and features one story at a time', async () => {
    let f = await front();
    assert.deepEqual([f.slug, f.featured, f.others.map((o: any) => o.slug)], ['second-story', false, [SLUG]], 'the newest, with the other one as a cover');
    assert.deepEqual(Object.keys(f.others[0]).sort(), ['count', 'covers', 'slug', 'title']); assert.deepEqual([f.others[0].title, f.others[0].count], [TITLE, 2]);
    assert.deepEqual(Object.keys(f.others[0].covers[0]).sort(), ['h', 'id', 'palette', 'w']); assert.equal(f.others[0].covers[0].id, a);
    assert.equal((await visitor().raw('GET', `/api/public/stories/${SLUG}/files/${a}/display`)).status, 200, 'a cover is fetched through its own story');
    assert.equal((await pub(owner, s1, { featured: true })).data.featured, true);
    f = await front(); assert.deepEqual([f.slug, f.featured, f.others.map((o: any) => o.slug)], [SLUG, true, ['second-story']]);
    assert.equal((await pub(editor, s2, { featured: true })).data.featured, true);
    assert.deepEqual((await owner.get('/api/stories')).data.stories.filter((s: any) => s.featured).map((s: any) => s.id), [s2], 'featuring one clears the other');
    assert.equal((await app.pool.query('select count(*)::int n from stories where featured')).rows[0].n, 1);
    assert.equal((await front()).slug, 'second-story');
    // a story is published before it is featured, and stops being featured when it stops being public
    const no = await pub(owner, s3, { featured: true });
    assert.equal(no.status, 400); assert.match(no.data.error, /Publish the story before you feature it/);
    assert.deepEqual((await pub(owner, s2, { public: false })).data, { public: false, featured: false, allowDownload: false, slug: 'second-story', url: `${app.base}/p/second-story` });
    f = await front(); assert.deepEqual([f.slug, f.featured, f.others], [SLUG, false, []]);
    assert.equal((await pub(owner, s2, { public: true })).data.slug, 'second-story', 'published again at the same address');
  });

  it('makes the address from the title once, keeps it when the title changes, and lets it be edited', async () => {
    await owner.json('PATCH', `/api/stories/${s2}`, { title: 'A different title now' });
    assert.equal((await visitor().get('/api/public/stories/second-story')).data.story.title, 'A different title now');
    const r = await pub(owner, s2, { slug: '  Été à la Plage!  ' });
    assert.deepEqual([r.status, r.data.slug, r.data.url], [200, 'ete-a-la-plage', `${app.base}/p/ete-a-la-plage`]);
    assert.deepEqual([(await visitor().get('/api/public/stories/ete-a-la-plage')).status, (await visitor().get('/api/public/stories/second-story')).status], [200, 404]);
    const clash = await pub(owner, s2, { slug: SLUG });
    assert.equal(clash.status, 400); assert.match(clash.data.error, /Another story already uses that address/);
    const junk = await pub(owner, s2, { slug: '!!! ???' });
    assert.equal(junk.status, 400); assert.match(junk.data.error, /Use letters and numbers/);
    assert.equal((await pub(owner, s2, { slug: 'ete-a-la-plage' })).status, 200, 'its own address again is not a clash');
    // two stories with the same title get two addresses
    const twin = (await owner.post('/api/stories', { title: TITLE, spaceId: life, ids: [c] })).data.id, third = (await owner.post('/api/stories', { title: TITLE, spaceId: life, ids: [c] })).data.id;
    assert.deepEqual([(await pub(owner, twin, { public: true })).data.slug, (await pub(owner, third, { public: true })).data.slug], [`${SLUG}-2`, `${SLUG}-3`]);
    // a title with nothing to make an address from still gets one
    const odd = (await owner.post('/api/stories', { title: '¡¡¡ ???', spaceId: life, ids: [c] })).data.id;
    assert.equal((await pub(owner, odd, { public: true })).data.slug, 'story');
    for (const id of [twin, third, odd]) await owner.json('DELETE', `/api/stories/${id}`);
    assert.equal((await visitor().get(`/api/public/stories/${SLUG}-2`)).status, 404, 'a deleted story is gone from the public page');
  });

  it('says nothing about a private story, and ends access the moment a story is unpublished', async () => {
    const v = visitor(), unknown = await v.get('/api/public/stories/never-existed');
    assert.equal(unknown.status, 404);
    // never published: its title as an address, its id, and its picture all find nothing, in the same words as a name nobody uses
    for (const url of ['/api/public/stories/private-things', `/api/public/stories/${s3}`]) { const r = await v.get(url); assert.deepEqual([r.status, r.data], [404, unknown.data], url); }
    assert.equal((await v.raw('GET', `/api/public/stories/private-things/files/${outside}/thumb`)).status, 404);
    assert.ok(!JSON.stringify(await front()).includes('Private things') && !JSON.stringify(await front()).includes(outside));
    // published, then unpublished: the address is kept for the author, and finds nothing for a visitor
    assert.equal((await pub(owner, s3, { public: true })).data.slug, 'private-things');
    assert.deepEqual([(await v.get('/api/public/stories/private-things')).status, (await v.raw('GET', `/api/public/stories/private-things/files/${outside}/thumb`)).status, (await v.raw('GET', '/p/private-things/cover')).status], [200, 200, 200]);
    assert.equal((await pub(owner, s3, { public: false })).data.slug, 'private-things');
    const gone = await v.get('/api/public/stories/private-things');
    assert.deepEqual([gone.status, gone.data], [404, unknown.data]);
    assert.deepEqual([(await v.raw('GET', `/api/public/stories/private-things/files/${outside}/thumb`)).status, (await v.raw('GET', `/api/public/stories/private-things/files/${outside}/display`)).status, (await v.raw('GET', '/p/private-things/cover')).status, (await v.raw('GET', '/api/public/stories/private-things/music')).status], [404, 404, 404, 404]);
    // the page for such an address is the ordinary page, which then shows the front page: nothing in it about the story
    const pg = await page('/p/private-things');
    assert.equal(pg.status, 200); assert.ok(!pg.html.includes('Private things') && !pg.html.includes('og:title'));
    // with nothing public at all the address is the sign-in page again
    for (const s of [s1, s2]) await pub(owner, s, { public: false });
    assert.deepEqual([(await v.get('/api/public')).status, (await v.get('/api/bootstrap')).data.public, (await v.raw('GET', `/api/public/stories/${SLUG}/files/${a}/thumb`)).status], [404, false, 404]);
    for (const s of [s1, s2]) await pub(owner, s, { public: true });
  });

  it('lets the owner put a name and a small logo of their own at the top of the page, the logo whole and never enlarged', async () => {
    const sharp = (await import('sharp')).default, fsx = await import('node:fs');
    const send = async (who: Client, file: Buffer, name: string) => { const fd = new FormData(); fd.set('file', new Blob([file]), name); const res = await who.raw('POST', '/api/admin/public/logo', { body: fd }); return { status: res.status, data: await res.json() as any }; };
    assert.equal((await front()).site.logo, null, 'no logo until one is chosen');
    assert.equal((await visitor().raw('GET', '/api/public/logo')).status, 404);
    // a wide picture, larger than the limit: it comes out smaller, in the same shape
    const wide = await sharp({ create: { width: 1200, height: 300, channels: 4, background: { r: 255, g: 178, b: 36, alpha: 1 } } }).png().toBuffer();
    for (const who of [editor, commenter, viewer]) assert.equal((await send(who, wide, 'logo.png')).status, 403);
    assert.equal((await visitor().raw('POST', '/api/admin/public/logo', { body: new FormData() })).status, 401);
    const saved = await send(owner, wide, 'logo.png');
    assert.equal(saved.status, 200); assert.match(saved.data.logo, /^\/api\/public\/logo\?v=[0-9a-f]+$/);
    await owner.json('PUT', '/api/admin/public', { title: 'Chaz' });
    const f1 = await front();
    assert.equal(f1.site.title, 'Chaz'); assert.equal(f1.site.logo, saved.data.logo);
    const got = await visitor().raw('GET', f1.site.logo);
    assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/webp');
    const m1 = await sharp(Buffer.from(await got.arrayBuffer())).metadata();
    assert.deepEqual([m1.width, m1.height], [480, 120], 'made to fit, in its own shape, nothing cut off');
    // a small one is not blown up, and the old file is gone from storage
    const small = await sharp({ create: { width: 64, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const again = await send(owner, small, 'small.png');
    assert.notEqual(again.data.logo, saved.data.logo);
    const m2 = await sharp(Buffer.from(await (await visitor().raw('GET', again.data.logo)).arrayBuffer())).metadata();
    assert.deepEqual([m2.width, m2.height], [64, 40]);
    assert.equal(fsx.readdirSync(`${app.dataDir}/media/public`).length, 1, 'one logo file, the newest');
    // not a picture
    const junk = await send(owner, Buffer.from('not a picture'), 'x.png');
    assert.equal(junk.status, 415); assert.match(junk.data.error, /could not be read as a picture/);
    assert.equal((await front()).site.logo, again.data.logo, 'and the logo is as it was');
    // the storage key is never told to anyone
    assert.ok(!JSON.stringify([await front(), (await owner.get('/api/admin/public')).data]).includes('public/logo-'));
    // removed
    assert.equal((await owner.json('DELETE', '/api/admin/public/logo')).status, 200);
    assert.equal((await front()).site.logo, null);
    assert.equal((await visitor().raw('GET', '/api/public/logo')).status, 404);
    assert.equal(fsx.readdirSync(`${app.dataDir}/media/public`).length, 0);
    await owner.json('PUT', '/api/admin/public', { title: '' });
  });

  it('asks search engines to stay away unless the owner lets them in, and only then gives a link a preview', async () => {
    const v = visitor(), tag = async (url: string) => (await v.raw('GET', url)).headers.get('x-robots-tag');
    assert.deepEqual([await tag('/api/public'), await tag(`/api/public/stories/${SLUG}`), await tag(`/api/public/stories/${SLUG}/files/${a}/thumb`), await tag('/p'), await tag(`/p/${SLUG}`), await tag('/')], Array(6).fill('noindex, nofollow'));
    let pg = await page(`/p/${SLUG}`);
    assert.equal(pg.status, 200); assert.match(pg.html, /<meta name="robots" content="noindex, nofollow">/); assert.ok(!pg.html.includes('og:') && !pg.html.includes('Coast'),'no preview, and nothing about the story in the page itself');
    assert.match(pg.csp ?? '', /script-src 'self'/); assert.match(pg.csp ?? '', /default-src 'self'/);
    assert.equal(await (await v.raw('GET', '/robots.txt')).text(), 'User-agent: *\nDisallow: /\n');

    const on = await owner.json('PUT', '/api/admin/public', { title: 'Chaz’s <stories>', line: 'From "the" road.', index: true });
    assert.deepEqual(on.data, { title: 'Chaz’s <stories>', line: 'From "the" road.', index: true, logo: null, url: `${app.base}/p`, count: 2 });
    assert.equal(await (await v.raw('GET', '/robots.txt')).text(), 'User-agent: *\nAllow: /p$\nAllow: /p/\nDisallow: /\n');
    assert.deepEqual([await tag('/api/public'), await tag('/p'), await tag(`/p/${SLUG}`), await tag('/')], [null, null, null, 'noindex, nofollow'], 'the app itself is never listed');
    pg = await page(`/p/${SLUG}`);
    assert.ok(!pg.html.includes('name="robots"'));
    assert.ok(pg.html.includes(`<meta property="og:title" content="Coast &quot;road&quot; &lt;b&gt;trip&lt;/b&gt; &amp; more">`), 'the title, escaped');
    assert.ok(pg.html.includes(`<meta property="og:description" content="Three &quot;days&quot; south &lt;i&gt;of here&lt;/i&gt;.">`));
    assert.ok(pg.html.includes(`<meta property="og:image" content="${app.base}/p/${SLUG}/cover">`) && pg.html.includes(`<link rel="canonical" href="${app.base}/p/${SLUG}">`));
    assert.ok(!pg.html.includes('<b>trip') && !pg.html.includes('"road"') && !pg.html.includes('<i>of here'), 'nothing from the story reaches the page as markup');
    assert.match(pg.csp ?? '', /script-src 'self'/);
    const cover = await v.raw('GET', `/p/${SLUG}/cover`);
    assert.deepEqual([cover.status, cover.headers.get('content-type')], [200, 'image/webp']);
    const home = await page('/p');
    assert.ok(home.html.includes(`<meta property="og:title" content="Chaz’s &lt;stories&gt;">`) && home.html.includes(`<meta property="og:description" content="From &quot;the&quot; road.">`) && home.html.includes(`<meta property="og:url" content="${app.base}/p">`));
    assert.deepEqual((await front()).site, { title: 'Chaz’s <stories>', line: 'From "the" road.', logo: null });
    // an address with no public story behind it gets no preview and stays unlisted, listing on or not
    const none = await page('/p/private-things');
    assert.ok(none.html.includes('name="robots" content="noindex, nofollow"') && !none.html.includes('og:') && none.robots === 'noindex, nofollow');
    assert.equal((await owner.json('PUT', '/api/admin/public', { index: false })).data.index, false);
    assert.deepEqual([await tag('/p'), (await page('/p')).html.includes('og:')], ['noindex, nofollow', false]);
  });
});
