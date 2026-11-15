import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import zlib from 'node:zlib';
import pg from 'pg';
// @ts-expect-error no types published
import S3rver from 's3rver';
import { Client, PG, fixture, startApp } from './helpers.js';

/**
 * A whole library as one file: exported from one server and imported into another, self-hosted and hosted.
 * The file is untrusted when it is read, so most of this is about what an import refuses and what it leaves alone.
 */
const unpack = (buf: Buffer) => zlib.gunzipSync(buf).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pack = (lines: unknown[]) => zlib.gzipSync(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
/** An export changed by hand: `fn` gets the manifest and the rows and may change both. The counts are brought back in step unless it says not to. */
const craft = (buf: Buffer, fn: (man: any, rows: { t: string; r: any }[]) => void, recount = true) => {
  const [man, ...rows] = unpack(buf); fn(man, rows);
  if (recount) { for (const k of Object.keys(man.counts)) man.counts[k] = 0; for (const r of rows) man.counts[r.t] = (man.counts[r.t] ?? 0) + 1; }
  return pack([man, ...rows]);
};
const send = async (c: { raw: Client['raw'] }, buf: Buffer, query = '') => {
  const fd = new FormData(); fd.set('file', new Blob([buf]), 'library.jsonl.gz');
  const res = await c.raw('POST', '/api/admin/import' + query, { body: fd });
  return { status: res.status, data: await res.json() as any };
};
const snap = async (pool: pg.Pool) => (await pool.query(`select (select count(*) from items) i, (select count(*) from users) u, (select count(*) from stories) s, (select count(*) from tags) t, (select count(*) from sessions) se,
  (select count(*) from comments) c, (select count(*) from faces) f, (select md5(string_agg(id::text, ',' order by id)) from items) h, (select md5(string_agg(id::text || coalesce(password_hash, ''), ',' order by id)) from users) uh`)).rows[0];
const RECIPE = { adj: { contrast: 30 }, geo: { rot: 0, flipH: true, flipV: false, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } }, curve: [0, 0.25, 0.5, 0.75, 1] };
const tsx = path.join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');
/** Run one of the command line programs. Not spawnSync: the stand-in bucket lives in this process and has to answer meanwhile. */
const cli = (file: string, args: string[], env: Record<string, string>) => new Promise<{ code: number | null; out: string }>((resolve) => {
  const child = spawn(tsx, [path.join(import.meta.dirname, '..', 'src', 'server', file), ...args], { env: { ...process.env, LOG_LEVEL: 'warn', PUBLIC_URL: 'http://library.example', ...env } });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const t = setTimeout(() => child.kill('SIGKILL'), 120000);
  child.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
});

describe('export and import of a whole library', () => {
  let a: Awaited<ReturnType<typeof startApp>>, b: Awaited<ReturnType<typeof startApp>>;
  let owner: Client, maria: Client, ownerB: Client, life: string;
  let heic: string, sea: string, clip: string, copy: string, story: string, person: string, linkToken: string, exported: Buffer, exportName: string;
  const vec = Buffer.from(new Float32Array([0.6, 0.8, 0, 0, 0, 0, 0, 0]).buffer), faceVec = Buffer.from(new Float32Array(64).fill(0.125).buffer);

  /** What the API says about a library, in a shape two servers can be compared by. */
  const reads = async (c: Client) => {
    const index = (await c.get('/api/index')).data, stories = (await c.get('/api/stories')).data.stories;
    const access = (await c.get(`/api/stories/${story}/access`)).data;
    return {
      items: index.items.slice().sort((x: any, y: any) => x.id.localeCompare(y.id)), stories,
      detail: await Promise.all([heic, sea, clip, copy].map(async (id) => (await c.get(`/api/items/${id}`)).data)),
      people: (await c.get('/api/people')).data.people.map((u: any) => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, caps: u.caps, spaces: u.spaces })).sort((x: any, y: any) => x.id.localeCompare(y.id)),
      links: access.links.map((l: any) => ({ ...l, url: new URL(l.url).pathname, uses: 0, lastUsed: null })), published: { ...access.published, url: new URL(access.published.url).pathname },
      faces: (await c.get(`/api/items/${sea}/faces`)).data, persons: (await c.get(`/api/faces/overview?space=${life}`)).data.people,
      spaces: (await c.get('/api/bootstrap')).data.spaces,
    };
  };
  const db = async (app: { pool: pg.Pool }, q: string) => (await app.pool.query(q)).rows;

  before(async () => {
    a = await startApp('ai_test_export_a');
    owner = new Client(a.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
    life = (await owner.get('/api/bootstrap')).data.spaces[0].id;
    const inv = await owner.post('/api/people/invite', { who: 'maria@example.com', role: 'editor', spaceIds: [life] });
    maria = new Client(a.base);
    await maria.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: 'Maria', email: 'maria@example.com', password: 'a long enough password' });
    [heic, sea, clip] = await Promise.all(['iphone.heic', 'seaside.jpg', 'clip.mp4'].map(async (f) => (await owner.upload(fixture(f), life)).data.id)) as [string, string, string];
    await owner.settled(60000);
    copy = (await owner.post(`/api/items/${sea}/copies`, { recipe: RECIPE })).data.id;
    await owner.settled(60000);
    // a date typed by a person, to the second, with no time zone: it must come back exactly
    await owner.json('PATCH', `/api/items/${sea}`, { title: 'The bay', desc: 'A note about the bay', d: '2019-03-04T05:06:07', lat: 20.6534, lng: -105.2253 });
    await owner.post(`/api/items/${sea}/tags`, { add: ['coast', `'); drop table items; --`] });
    await owner.json('PUT', `/api/items/${sea}/like`); await maria.json('PUT', `/api/items/${heic}/like`);
    await maria.post(`/api/items/${sea}/comments`, { text: 'What a morning.' });
    story = (await owner.post('/api/stories', { title: 'The coast road', spaceId: life, ids: [heic, sea, clip], groups: ['Road trips'] })).data.id;
    await owner.json('PATCH', `/api/stories/${story}`, { intro: 'Three days south.', covers: [sea, heic], sections: [{ title: 'Day one', text: 'We left early.', ids: [sea, clip] }, { title: 'Day two', text: '', ids: [heic] }] });
    linkToken = new URL((await owner.post(`/api/stories/${story}/links`, { label: 'Family', password: 'tacos al pastor', allowDownload: true })).data.url).pathname.split('/').pop()!;
    assert.equal((await owner.json('PATCH', `/api/stories/${story}/public`, { public: true, featured: true })).status, 200);
    await owner.json('PUT', '/api/admin/public', { title: 'Chaz’s stories', line: 'From the road.', logo: null });
    // what the machines read, put in place the way a worker leaves it: a caption a person then corrected, an embedding, a person with a named face
    await a.pool.query(`update items set ai_caption = 'A beach.', ai_scene = 'beach', ai_status = 'done' where id = $1`, [sea]);
    await a.pool.query(`insert into ai_tasks (item_id, task, status, model, model_version, done_at) values ($1, 'caption', 'done', 'fake-vision', '1', now()), ($2, 'embed', 'claimed', null, null, null)
      on conflict (item_id, task) do update set status = excluded.status, model = excluded.model, model_version = excluded.model_version, done_at = excluded.done_at`, [sea, heic]);
    await owner.json('PATCH', `/api/items/${sea}/ai`, { caption: 'The bay at first light.', add: ['boat'], remove: ['umbrella'] });
    await a.pool.query(`insert into item_embeddings (item_id, model, dim, vec) values ($1, 'test-embed', 8, $2)`, [sea, vec]);
    await a.pool.query(`update spaces set people = true where id = $1`, [life]);
    person = (await a.pool.query(`insert into persons (space_id, name) values ($1, 'Abuela') returning id`, [life])).rows[0].id;
    const face = (await a.pool.query(`insert into faces (item_id, x, y, w, h, score, quality, vec, model, person_id, status) values ($1, 0.1, 0.2, 0.2, 0.3, 0.9, 0.8, $2, 'test-faces', $3, 'confirmed') returning id`, [sea, faceVec, person])).rows[0].id;
    await a.pool.query(`update persons set cover_face_id = $1 where id = $2`, [face, person]);
    await a.pool.query(`insert into place_suggestions (item_id, source, name, lat, lng, confidence, why, model) values ($1, 'vision', 'Mismaloya', 20.53, -105.29, 0.7, 'the arches', 'fake-vision')`, [heic]);
    // things that must stay behind: a worker and its token, a provider key sealed with this server's secret, this server's bookkeeping
    await owner.post('/api/admin/workers', { name: 'Tower' });
    await a.pool.query(`insert into settings (key, value) values ('cloudai', $1), ('backup:list', $2), ('cloud:owner', $3), ('faces:auto', $4)`,
      [JSON.stringify({ on: true, provider: 'anthropic', model: 'a-model', key: 'sealed-with-the-old-secret', keyHint: 'abcd', dailyLimit: 40 }), JSON.stringify([{ key: 'backups/old.dump', at: 1, bytes: 1, encrypted: false }]), JSON.stringify({ userId: heic }), JSON.stringify({ on: false })]);
    b = await startApp('ai_test_export_b');
    ownerB = new Client(b.base);
    await ownerB.post('/api/setup', { name: 'Chaz at home', email: 'chaz@example.com', password: 'the password on the new server' });
  });
  after(async () => { await a.stop(); await b.stop(); });

  it('lets only the owner export and import, on every route', async () => {
    const nobody = new Client(a.base), fd = () => { const f = new FormData(); f.set('file', new Blob(['x']), 'x.gz'); return f; };
    for (const [who, want] of [[maria, 403], [nobody, 401]] as const) {
      assert.deepEqual([
        (await who.get('/api/admin/exports')).status, (await who.post('/api/admin/export', {})).status, (await who.raw('GET', '/api/admin/exports/imagestoria-library-x.jsonl.gz')).status,
        (await who.raw('POST', '/api/admin/import', { body: fd() })).status, (await who.post('/api/admin/import/from-storage', { name: 'x.jsonl.gz' })).status,
      ], [want, want, want, want, want]);
    }
    assert.equal((await db(a, `select count(*)::int n from settings where key like 'export:%'`))[0].n, 0, 'and nothing was started');
  });

  it('makes an export into the library’s own storage, lists it, and hands it over as a download', async () => {
    const made = await owner.post('/api/admin/export', { wait: true });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    assert.equal(made.data.state.running, false); assert.equal(made.data.list.length, 1);
    exportName = made.data.list[0].name;
    assert.match(exportName, /^imagestoria-library-\d{8}-\d{6}\.jsonl\.gz$/); assert.equal(made.data.list[0].items, 4);
    assert.ok(fs.existsSync(path.join(a.dataDir, 'media', 'exports', exportName)), 'under exports/ in the storage');
    const res = await owner.raw('GET', `/api/admin/exports/${exportName}`);
    assert.equal(res.status, 200); assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''imagestoria-library-/);
    exported = Buffer.from(await res.arrayBuffer());
    assert.equal((await owner.raw('GET', '/api/admin/exports/..%2F..%2Fsecrets')).status, 400, 'a name is a name, never a path');
    assert.equal((await owner.raw('GET', '/api/admin/exports/nothing-here.gz')).status, 404);
    assert.ok((await owner.get('/api/admin/overview')).data.activity.some((x: any) => /exported the library/.test(x.text)));

    const [man, ...rows] = unpack(exported);
    assert.deepEqual([man.format, man.version, man.storage, man.counts.items, man.counts.users], ['imagestoria-library', 1, { driver: 'local' }, 4, 2]);
    assert.match(man.schema, /^\d{4}_/); assert.match(man.app, /^\d+\.\d+/); assert.ok(Date.parse(man.exportedAt) > Date.now() - 60000);
    const tables = [...new Set(rows.map((r) => r.t))];
    for (const t of ['sessions', 'tokens', 'jobs', 'workers', 'place_names']) assert.ok(!tables.includes(t), `${t} stays behind`);
    assert.ok(tables.indexOf('users') < tables.indexOf('items') && tables.indexOf('items') < tables.indexOf('story_items') && tables.indexOf('persons') < tables.indexOf('faces'), 'in an order that satisfies foreign keys');
    const text = JSON.stringify(rows);
    assert.ok(!text.includes('sealed-with-the-old-secret') && !text.includes('backups/old.dump') && !text.includes('cloud:owner'), 'no sealed key and none of this server’s bookkeeping');
    assert.deepEqual(rows.filter((r) => r.t === 'settings').map((r) => r.r.key).sort(), ['cloudai', 'faces:auto', 'public:site']);
    const ai = rows.find((r) => r.t === 'settings' && r.r.key === 'cloudai')!.r.value;
    assert.deepEqual([ai.on, ai.key, ai.keyHint, ai.model, ai.dailyLimit], [false, null, null, 'a-model', 40], 'the provider settings travel switched off, without the key');
    assert.equal(rows.find((r) => r.t === 'items' && r.r.id === sea)!.r.taken_at, '2019-03-04T05:06:07.000000', 'taken_at is written without a zone');
    assert.equal(rows.find((r) => r.t === 'item_embeddings')!.r.vec, vec.toString('base64'));
    assert.ok(rows.filter((r) => r.t === 'ai_tasks').every((r) => r.r.worker_id === null && r.r.status !== 'claimed'), 'work a machine was holding goes back in line');
    assert.ok(rows.filter((r) => r.t === 'users').every((r) => typeof r.r.password_hash === 'string'), 'password hashes travel, so members can still sign in');

    // the newest three are kept
    for (let i = 0; i < 3; i++) assert.equal((await owner.post('/api/admin/export', { wait: true })).status, 200);
    const list = (await owner.get('/api/admin/exports')).data.list;
    assert.equal(list.length, 3); assert.ok(!list.some((x: any) => x.name === exportName));
    assert.deepEqual(fs.readdirSync(path.join(a.dataDir, 'media', 'exports')).sort(), list.map((x: any) => x.name).sort());
  });

  it('brings everything across to a fresh library, and says whether the files are there', async () => {
    const other = new Client(b.base);
    assert.equal((await other.post('/api/auth/login', { email: 'chaz@example.com', password: 'the password on the new server' })).status, 200);
    // without the pictures: every row arrives, and the answer says the files are not there
    const bare = await send(ownerB, exported);
    assert.equal(bare.status, 200, JSON.stringify(bare.data));
    assert.deepEqual([bare.data.items, bare.data.filesChecked, bare.data.filesFound, bare.data.backup], [4, 4, 0, null]);
    assert.equal(bare.data.sentence, '4 of 4 files checked are missing. Copy the pictures into this library’s storage, then they will appear.');
    // every session ended, and the person who imported is still signed in
    assert.deepEqual([(await other.get('/api/index')).status, (await ownerB.get('/api/index')).status], [401, 200]);
    assert.equal((await db(b, 'select count(*)::int n from sessions'))[0].n, 1);

    // with the pictures copied over (the library now has items, so it is a replace)
    fs.cpSync(path.join(a.dataDir, 'media'), path.join(b.dataDir, 'media'), { recursive: true });
    const full = await send(ownerB, exported, '?replace=1&confirm=replace');
    assert.equal(full.status, 200, JSON.stringify(full.data));
    assert.equal(full.data.sentence, 'All 4 files checked are in this library’s storage.');
    assert.deepEqual(await reads(ownerB), await reads(owner), 'everything reads back the same through the API');
    const want = await reads(owner);
    assert.deepEqual([want.items.length, want.detail[3].recipe.adj.contrast, want.detail[1].comments.length, want.faces.faces.length, want.persons[0].name, want.stories[0].sections.length, want.stories[0].covers], [4, 30, 1, 1, 'Abuela', 2, [sea, heic]], 'and there was something to compare');
    const seaB = want.items.find((i: any) => i.id === sea);
    assert.deepEqual([seaB.aiCaption, seaB.aiLocked, seaB.tags.slice().sort(), seaB.likes.length], ['The bay at first light.', ['caption'], [`'); drop table items; --`, 'coast'], 1], 'a tag that looks like SQL is only ever a tag');
    for (const q of [`select id, taken_at::text, added_at::text, updated_at::text from items order by id`, `select item_id, model, dim, encode(vec, 'hex') v, updated_at::text from item_embeddings`, `select item_id, encode(vec, 'hex') v, person_id, status from faces`,
      `select item_id, label, confidence, source, removed from item_labels order by label`, `select item_id, source, name, lat, lng, confidence, why, model, status from place_suggestions`, `select who, text, created_at::text from activity where text not like '%imported%' and text not like '%backed up%' and text not like '%exported%' order by created_at, text`]) {
      assert.deepEqual(await db(b, q), await db(a, q), q);
    }
    assert.equal((await db(b, `select taken_at::text t from items where id = '${sea}'`))[0].t, '2019-03-04 05:06:07');

    // what stays behind is not there
    assert.deepEqual((await db(b, `select (select count(*)::int from workers) w, (select count(*)::int from tokens) t, (select count(*)::int from jobs) j, (select count(*)::int from sessions) s`))[0], { w: 0, t: 0, j: 0, s: 1 });
    assert.deepEqual((await db(b, `select key from settings where key in ('backup:list', 'cloud:owner', 'cloudai', 'faces:auto', 'public:site') order by key`)).map((r) => r.key), ['backup:list', 'cloudai', 'faces:auto', 'public:site'], 'backup:list is this server’s own, from the backup made before replacing');
    assert.ok(!JSON.stringify(await db(b, `select value from settings`)).includes('sealed-with-the-old-secret'));
    assert.deepEqual((await db(b, `select value->>'on' o, value->>'key' k from settings where key = 'cloudai'`))[0], { o: 'false', k: null });
    assert.deepEqual((await db(b, `select status, worker_id from ai_tasks where task = 'embed'`))[0], { status: 'queued', worker_id: null });

    // people come across as they were. The one who imported keeps the password of this server.
    const login = async (email: string, password: string) => (await new Client(b.base).post('/api/auth/login', { email, password })).status;
    assert.deepEqual([await login('maria@example.com', 'a long enough password'), await login('chaz@example.com', 'the password on the new server'), await login('chaz@example.com', 'correct horse battery')], [200, 200, 401]);
    assert.equal((await ownerB.get('/api/bootstrap')).data.me.role, 'owner');

    // the share link still opens, with its password, and the published story is still public at its address
    const v = new Client(b.base);
    assert.deepEqual((await v.get(`/api/share/${linkToken}`)).data, { locked: true });
    assert.equal((await v.post(`/api/share/${linkToken}/unlock`, { password: 'tacos al pastor' })).status, 200);
    assert.equal((await v.get(`/api/share/${linkToken}`)).data.story.title, 'The coast road');
    assert.equal((await v.raw('GET', `/api/share/${linkToken}/files/${sea}/thumb`)).status, 200);
    const front = (await new Client(b.base).get('/api/public')).data;
    assert.deepEqual([front.slug, front.featured, front.site, front.story.title], ['the-coast-road', true, { title: 'Chaz’s stories', line: 'From the road.', logo: null }, 'The coast road'], 'the public flags, the address and the page settings came along');
  });

  it('asks for the typed word before replacing a library, and backs its database up first', async () => {
    const before = await snap(b.pool);
    for (const q of ['', '?replace=1', '?replace=1&confirm=yes', '?confirm=replace']) {
      const r = await send(ownerB, exported, q);
      assert.equal(r.status, 409, q); assert.match(r.data.error, /already has 4 items\. Importing replaces everything in it\. Type the word replace to go on\./);
    }
    assert.equal((await ownerB.post('/api/admin/import/from-storage', { name: exportName, replace: true, confirm: 'no' })).status, 409);
    assert.deepEqual(await snap(b.pool), before);
    const n = (await ownerB.get('/api/admin/overview')).data.backup.count;
    // the file is already under exports/ in this library's storage (it was copied with the pictures): import it from there
    const list = fs.readdirSync(path.join(b.dataDir, 'media', 'exports'));
    const r = await ownerB.post('/api/admin/import/from-storage', { name: list[0], replace: true, confirm: 'Replace' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.data.backup, /^backups\/afterimage-\d{8}-\d{6}\.dump$/);
    assert.ok(fs.statSync(path.join(b.dataDir, 'media', r.data.backup)).size > 200, 'the backup is a real file');
    assert.equal((await ownerB.get('/api/admin/overview')).data.backup.count, n + 1);
    assert.equal((await ownerB.post('/api/admin/import/from-storage', { name: 'not-there.jsonl.gz', replace: true, confirm: 'replace' })).status, 404);
    assert.equal((await ownerB.post('/api/admin/import/from-storage', { name: '../backups/x', replace: true, confirm: 'replace' })).status, 400);
  });

  it('refuses a file that is not an export it knows, and leaves the library exactly as it was', async () => {
    const before = await snap(b.pool), ok = '?replace=1&confirm=replace';
    const userRow = unpack(exported).find((r) => r.t === 'users').r;
    const cases: [string, Buffer, RegExp][] = [
      ['plain text', Buffer.from('these are not the bytes you are looking for\n'), /not an ImageStoria library export/],
      ['gzip of something else', pack([{ hello: 'world' }, { t: 'items', r: {} }]), /not an ImageStoria library export/],
      ['a newer schema', craft(exported, (m) => { m.schema = '9999_from_the_future'; }), /made by a newer ImageStoria\. Update this server first\./],
      ['a newer format', craft(exported, (m) => { m.version = 2; }), /made by a newer ImageStoria/],
      ['an unknown table', craft(exported, (_m, rows) => { rows.push({ t: 'pg_authid', r: { rolname: 'x' } }); }), /a table this server does not know \(pg_authid\)/],
      ['a table outside the list: sessions', craft(exported, (_m, rows) => { rows.push({ t: 'sessions', r: { token_hash: 'a'.repeat(64), user_id: userRow.id, expires_at: '2099-01-01T00:00:00.000000Z' } }); }), /a table this server does not know \(sessions\)/],
      ['a table outside the list: workers', craft(exported, (_m, rows) => { rows.push({ t: 'workers', r: { name: 'Mine', token_hash: 'b'.repeat(64) } }); }), /a table this server does not know \(workers\)/],
      ['a table outside the list, named only in a row', craft(exported, (_m, rows) => { rows.push({ t: 'jobs', r: { type: 'ingest' } }); }, false), /a table this server does not know \(jobs\)/],
      ['an unknown column', craft(exported, (_m, rows) => { rows.find((r) => r.t === 'users')!.r.is_admin = true; }), /a column this server does not know \(users\.is_admin\)/],
      ['a column name that is SQL', craft(exported, (_m, rows) => { rows.find((r) => r.t === 'tags')!.r['name") values (1); drop table items; --'] = 'x'; }), /a column this server does not know/],
      ['a value of the wrong kind', craft(exported, (_m, rows) => { rows.find((r) => r.t === 'items')!.r.id = `x'; drop table items; --`; }), /a value this server cannot read \(items\.id\)/],
      ['a truncated file', exported.subarray(0, Math.floor(exported.length * 0.6)), /not complete or is damaged/],
      ['rows missing from the end', craft(exported, (_m, rows) => { rows.splice(-5); }, false), /not complete or is damaged/],
    ];
    for (const [name, file, want] of cases) {
      const r = await send(ownerB, file, ok);
      assert.equal(r.status, 400, `${name}: ${JSON.stringify(r.data)}`); assert.match(r.data.error, want, name);
      assert.deepEqual(await snap(b.pool), before, `${name}: nothing changed`);
    }
    assert.equal((await ownerB.get('/api/index')).data.items.length, 4, 'and the same session still works');
    assert.equal((await db(b, `select count(*)::int n from pg_tables where tablename = 'items'`))[0].n, 1);
  });

  it('leaves the old library whole when an import fails half way', async () => {
    const before = await snap(b.pool);
    // Every line is well formed, so the check passes. The last row cannot exist beside the first: the database refuses it after the library was emptied.
    const twice = craft(exported, (_m, rows) => { rows.splice(rows.findLastIndex((r) => r.t === 'tags') + 1, 0, { t: 'tags', r: { ...rows.find((r) => r.t === 'tags')!.r } }); });
    const r = await send(ownerB, twice, '?replace=1&confirm=replace');
    assert.equal(r.status, 400, JSON.stringify(r.data)); assert.match(r.data.error, /could not be loaded, so nothing was changed\. The database refused a row of tags/);
    assert.deepEqual(await snap(b.pool), before);
    // a row that points at something that is not there (a comment on no picture) is refused the same way, however late it comes
    const orphan = craft(exported, (_m, rows) => { rows.find((r) => r.t === 'comments')!.r.item_id = 'bbbbbbbb-0000-4000-8000-000000000002'; });
    const r2 = await send(ownerB, orphan, '?replace=1&confirm=replace');
    assert.equal(r2.status, 400, JSON.stringify(r2.data)); assert.match(r2.data.error, /nothing was changed\. The database refused a row of comments/);
    assert.deepEqual(await snap(b.pool), before);
    assert.deepEqual(await reads(ownerB), await reads(owner), 'it still reads the same as the library it came from');
  });

  it('exports and imports from the command line', async () => {
    const file = path.join(a.dataDir, 'tmp', 'cli.jsonl.gz');
    const out = await cli('cli-export.ts', ['export', file], { DATABASE_URL: `${PG}/ai_test_export_a`, DATA_DIR: a.dataDir });
    assert.equal(out.code, 0, out.out); assert.match(out.out, /Exported 4 items to .*cli\.jsonl\.gz\. The pictures themselves are not in it/);
    assert.equal(unpack(fs.readFileSync(file))[0].counts.items, 4);
    const admin = new pg.Client({ connectionString: `${PG}/postgres` });
    await admin.connect(); await admin.query('drop database if exists ai_test_export_c with (force)'); await admin.query('create database ai_test_export_c'); await admin.end();
    const dataDir = path.join(import.meta.dirname, 'tmp', 'ai_test_export_c');
    fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });
    const env = { DATABASE_URL: `${PG}/ai_test_export_c`, DATA_DIR: dataDir };
    // an owner who has no password (one who came from the hosted service) is given a link to choose one
    const noPassword = path.join(dataDir, 'tmp', 'hosted.jsonl.gz');
    fs.writeFileSync(noPassword, craft(fs.readFileSync(file), (_m, rows) => { for (const x of rows) if (x.t === 'users' && x.r.role === 'owner') x.r.password_hash = null; }));
    const first = await cli('cli-export.ts', ['import', noPassword], env);
    assert.equal(first.code, 0, first.out); assert.match(first.out, /Imported 4 items\. 4 of 4 files checked are missing\./);
    assert.match(first.out, /Chaz is the owner and has no password on this server\. This link lets them choose one, once, within 2 days: http:\/\/library\.example\/\?reset=[\w-]{20,}/);
    const c = new pg.Pool({ connectionString: env.DATABASE_URL });
    try {
      assert.deepEqual((await c.query(`select (select count(*)::int from items) i, (select count(*)::int from stories) s, (select count(*)::int from tokens where kind = 'reset') t`)).rows[0], { i: 4, s: 1, t: 1 });
      const again = await cli('cli-export.ts', ['import', file], env);
      assert.equal(again.code, 1, again.out); assert.match(again.out, /already has pictures/);
      assert.equal((await c.query('select count(*)::int n from items')).rows[0].n, 4);
    } finally { await c.end(); }
    const wrong = await cli('cli-export.ts', ['frobnicate'], env);
    assert.equal(wrong.code, 2); assert.match(wrong.out, /Say what to do and with which file/);
  });

  it('copies the media folder to a bucket and back, skipping what is already there', async () => {
    const dir = path.join(import.meta.dirname, 'tmp', 's3-export');
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const s3 = new S3rver({ port: 0, address: '127.0.0.1', silent: true, directory: dir, configureBuckets: [{ name: 'moved' }] });
    const port = (await s3.run()).port;
    try {
      const bucket = { S3_ENDPOINT: `http://127.0.0.1:${port}`, S3_BUCKET: 'moved', S3_ACCESS_KEY_ID: 'S3RVER', S3_SECRET_ACCESS_KEY: 'S3RVER', S3_FORCE_PATH_STYLE: 'true', S3_PREFIX: 'library' };
      const local = fs.readdirSync(path.join(a.dataDir, 'media'), { recursive: true }).map(String).filter((f) => fs.statSync(path.join(a.dataDir, 'media', f)).isFile());
      assert.ok(local.length >= 12, 'originals, copies, thumbnails and the exports');
      const push = await cli('cli-media.ts', ['push'], { ...bucket, DATA_DIR: a.dataDir });
      assert.equal(push.code, 0, push.out); assert.match(push.out, new RegExp(`${local.length} copied \\([\\d.]+ MB\\), 0 already there`)); assert.match(push.out, /Done\. Everything under .* is in the bucket moved under library\//);
      const inBucket = fs.readdirSync(path.join(dir, 'moved'), { recursive: true }).map(String).filter((f) => f.endsWith('._S3rver_object'));
      assert.equal(inBucket.length, local.length); assert.ok(inBucket.every((f) => f.startsWith('library')) && inBucket.some((f) => f.includes('originals')) && inBucket.some((f) => f.includes('thumbs')));
      // run again: nothing is copied twice. Change one file and only that one goes.
      assert.match((await cli('cli-media.ts', ['push'], { ...bucket, DATA_DIR: a.dataDir })).out, new RegExp(`0 copied \\(0\\.0 MB\\), ${local.length} already there`));
      fs.writeFileSync(path.join(a.dataDir, 'media', 'exports', 'note.txt'), 'a new file');
      assert.match((await cli('cli-media.ts', ['push'], { ...bucket, DATA_DIR: a.dataDir })).out, new RegExp(`1 copied \\(0\\.0 MB\\), ${local.length} already there`));
      // and back, into an empty folder
      const home = path.join(import.meta.dirname, 'tmp', 'ai_test_export_pull');
      fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true });
      const pull = await cli('cli-media.ts', ['pull'], { ...bucket, DATA_DIR: home });
      assert.equal(pull.code, 0, pull.out); assert.match(pull.out, new RegExp(`${local.length + 1} copied`));
      for (const f of local) assert.equal(fs.statSync(path.join(home, 'media', f)).size, fs.statSync(path.join(a.dataDir, 'media', f)).size, f);
      assert.match((await cli('cli-media.ts', ['pull'], { ...bucket, DATA_DIR: home })).out, new RegExp(`0 copied \\(0\\.0 MB\\), ${local.length + 1} already there`));
      const none = await cli('cli-media.ts', ['push'], { DATA_DIR: a.dataDir, S3_BUCKET: '' });
      assert.equal(none.code, 2); assert.match(none.out, /Set S3_BUCKET/);
    } finally { await s3.close(); }
  });
});
