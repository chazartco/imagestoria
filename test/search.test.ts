import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { Client, FakeWorker, fixture, startApp } from './helpers.js';

/** Phase 3, stage 3: search by meaning, "More like this" and near duplicates, all from embeddings a worker posts. */
describe('search by meaning', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let owner: Client, viewer: Client, life: string, studio: string, w: FakeWorker;
  const ids: Record<string, string> = {};
  const MODEL = { name: 'test-embed', version: '1' };
  /** A 16-number embedding from its first few numbers, as a worker sends it. */
  const vec = (...n: number[]) => { const f = new Float32Array(16); n.forEach((x, i) => { f[i] = x; }); return { dim: 16, vector: Buffer.from(f.buffer).toString('base64') }; };
  const V: Record<string, number[]> = { 'seaside.jpg': [1], 'sideways.jpg': [0.97, 0.2431], 'plain.png': [0, 0, 0, 1], 'iphone.heic': [0.96, 0, 0.28], 'clip.mp4': [0, 0, 0, 0, 1] };
  const search = (q: string, space = life, who = owner) => who.get(`/api/search?q=${encodeURIComponent(q)}&space=${space}`);
  const name = (id: string) => Object.keys(ids).find((k) => ids[k] === id);

  before(async () => {
    app = await startApp('ai_test_search', { EMBED_MODEL: 'test-embed', AI_TASKS: 'embed', SEARCH_MEANING_FLOOR: '0.05', SEARCH_MEANING_SPREAD: '0.05', SIMILAR_FLOOR: '0.6', DUPLICATE_SIMILARITY: '0.95', DUPLICATE_MINUTES: '10' });
    // the words someone types, turned into numbers by a stand-in for the text half of the model
    const words: Record<string, number[]> = { boat: [1], wall: [0, 0, 0, 1], nothing: [0, 0, 0, 0, 0, 0, 1] };
    app.ctx.embedText = async (q) => { const f = new Float32Array(16); (words[q.toLowerCase()] ?? [0, 0, 0, 0, 0, 0, 0, 1]).forEach((x, i) => { f[i] = x; }); return f; };
    owner = new Client(app.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
    const spaces = (await owner.get('/api/bootstrap')).data.spaces; life = spaces[0].id; studio = spaces[1].id;
    const inv = await owner.post('/api/people/invite', { who: 'maria@example.com', role: 'viewer', spaceIds: [studio] });
    viewer = new Client(app.base);
    await viewer.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: 'Maria', email: 'maria@example.com', password: 'a long enough password' });
    for (const f of Object.keys(V)) ids[f] = (await owner.upload(fixture(f), life)).data.id;
    await owner.settled(60000);
    w = new FakeWorker(app.base, (await owner.post('/api/admin/workers', { name: 'Tower' })).data.token);
  });
  after(async () => { await app.stop(); });

  it('answers with nothing, and says why, before a worker has read anything', async () => {
    assert.deepEqual((await search('boat')).data, { state: 'empty', note: '', results: [] });
    assert.deepEqual((await owner.get(`/api/items/${ids['seaside.jpg']}/similar`)).data, { state: 'none', ids: [] });
    assert.deepEqual((await owner.get(`/api/duplicates?space=${life}`)).data, { groups: [] });
  });

  it('takes an embedding only in the agreed shape, and only from the model the site searches with', async () => {
    let got: any[] = [];
    for (const t0 = Date.now(); got.length < 5 && Date.now() - t0 < 10000;) { got.push(...(await w.claim(['embed'], 8)).data.items); if (got.length < 5) await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(got.length, 5); assert.deepEqual(got[0].tasks, ['embed']);
    assert.equal((await w.heartbeat()).data.embedModel, 'test-embed');
    const a = ids['seaside.jpg']!, send = (data: unknown, model = MODEL) => w.results([{ itemId: a, task: 'embed', model, data }]);
    assert.match((await send(vec(1), { name: 'other-model', version: '1' })).data.refused[0].reason, /This site searches with test-embed\. Set the same model under \[embed\]/);
    assert.match((await send({ dim: 16, vector: Buffer.alloc(60).toString('base64') })).data.refused[0].reason, /should hold 16 numbers and holds 15/);
    assert.match((await send(vec())).data.refused[0].reason, /all zeros/);
    assert.match((await send(vec(NaN, 1))).data.refused[0].reason, /not a number/);
    assert.match((await send({ vector: 'x' })).data.refused[0].reason, /not in the agreed shape/);
    // a good one is stored with length 1, whatever length it arrived with
    assert.equal((await send(vec(5))).data.accepted, 1);
    const row = (await app.ctx.db.execute(sql`select model, dim, vec from item_embeddings where item_id = ${a}::uuid`)).rows[0] as any;
    assert.deepEqual([row.model, row.dim, row.vec.length, row.vec.readFloatLE(0)], ['test-embed', 16, 64, 1]);
    const rest = Object.keys(V).filter((f) => f !== 'seaside.jpg').map((f) => ({ itemId: ids[f], task: 'embed', model: MODEL, data: vec(...V[f]!) }));
    assert.equal((await w.results(rest)).data.accepted, 4);
  });

  it('finds pictures by what they show, best first, and leaves out what does not fit', async () => {
    const r = await search('Boat');
    assert.equal(r.data.state, 'ok');
    assert.deepEqual(r.data.results.map((x: any) => [name(x[0]), Math.round(x[1] * 100) / 100]), [['seaside.jpg', 1], ['sideways.jpg', 0.97], ['iphone.heic', 0.96]]);
    assert.deepEqual((await search('wall')).data.results.map((x: any) => name(x[0])), ['plain.png']);
    assert.deepEqual((await search('nothing')).data.results, [], 'nothing is close enough to count');
    // a space is its own world, and so is a person's access
    assert.deepEqual((await search('boat', studio)).data, { state: 'empty', note: '', results: [] });
    assert.equal((await search('boat', life, viewer)).status, 403);
    assert.equal((await new Client(app.base).get(`/api/search?q=boat&space=${life}`)).status, 401);
    assert.equal((await search('', life)).status, 400);
    // an item that moves to another space is found there and no longer here
    await owner.post('/api/items/bulk', { ids: [ids['sideways.jpg']], action: 'move', spaceId: studio });
    assert.deepEqual((await search('boat')).data.results.map((x: any) => name(x[0])), ['seaside.jpg', 'iphone.heic']);
    assert.deepEqual((await search('boat', studio, viewer)).data.results.map((x: any) => name(x[0])), ['sideways.jpg']);
    await owner.post('/api/items/bulk', { ids: [ids['sideways.jpg']], action: 'move', spaceId: life });
  });

  it('says so when the text model is off, still loading or broken, and the page carries on', async () => {
    const real = app.ctx.embedText;
    app.ctx.embedText = null;
    assert.deepEqual((await search('boat')).data, { state: 'off', note: '', results: [] });
    app.ctx.embedText = async () => { throw new Error('no such file'); };
    const failed = (await search('boat')).data; assert.equal(failed.state, 'failed'); assert.match(failed.note, /not working on this server/);
    app.ctx.embedText = real;
  });

  it('offers more like this from what the pictures look like, never an edited copy of the same picture', async () => {
    const sim = async (f: string, who = owner) => (await who.get(`/api/items/${ids[f]}/similar`)).data;
    assert.deepEqual((await sim('seaside.jpg')).ids.map(name), ['sideways.jpg', 'iphone.heic']);
    assert.deepEqual(await sim('plain.png'), { state: 'ok', ids: [] }, 'nothing looks like a plain wall');
    assert.equal((await viewer.get(`/api/items/${ids['seaside.jpg']}/similar`)).status, 403);
    const copy = await owner.post(`/api/items/${ids['seaside.jpg']}/copies`, { recipe: { adj: { exposure: 20 }, geo: { rot: 0, flipH: false, flipV: false, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } }, curve: [0, 0.25, 0.5, 0.75, 1] } });
    await owner.settled(); ids['copy'] = copy.data.id;
    let got: any[] = []; for (const t0 = Date.now(); !got.length && Date.now() - t0 < 10000;) { got = (await w.claim(['embed'], 8)).data.items; if (!got.length) await new Promise((r) => setTimeout(r, 100)); }
    assert.deepEqual(got.map((g) => g.id), [copy.data.id], 'the saved copy put itself in line');
    await w.results([{ itemId: copy.data.id, task: 'embed', model: MODEL, data: vec(0.999, 0.04) }]);
    assert.deepEqual((await sim('seaside.jpg')).ids.map(name), ['sideways.jpg', 'iphone.heic']);
    assert.deepEqual((await sim('copy')).ids.map(name), ['sideways.jpg', 'iphone.heic'], 'and the copy is not offered its own original');
  });

  it('groups near duplicates taken together, and removes nothing by itself', async () => {
    const at = (f: string, d: string) => owner.json('PATCH', `/api/items/${ids[f]}`, { d });
    await at('seaside.jpg', '2024-01-02T12:00:00'); await at('sideways.jpg', '2024-01-02T12:05:00'); await at('iphone.heic', '2024-03-01T09:00:00'); await at('plain.png', '2024-01-02T12:01:00'); await at('clip.mp4', '2024-01-02T12:02:00');
    await app.ctx.db.execute(sql`update items set taken_at = '2024-01-02T12:00:00' where id = ${ids['copy']}::uuid`);
    const groups = async (space = life) => ((await owner.get(`/api/duplicates?space=${space}`)).data.groups as string[][]).map((g) => g.map(name).sort());
    // two that look alike within ten minutes are a group. One that looks alike months later is not. An edited copy is not a duplicate of its original.
    assert.deepEqual(await groups(), [['seaside.jpg', 'sideways.jpg']]);
    // a re-export: the same picture to the last detail, whatever its date says
    await w.claim(['embed']); await owner.post('/api/admin/workers/redo', { task: 'embed' });
    const again = (await w.claim(['embed'], 8)).data.items.find((i: any) => i.id === ids['iphone.heic']);
    assert.ok(again); await w.results([{ itemId: again.id, task: 'embed', model: MODEL, data: vec(0.97, 0.2431, 0.002) }]);
    assert.deepEqual(await groups(), [['iphone.heic', 'seaside.jpg', 'sideways.jpg']]);
    assert.equal((await viewer.get(`/api/duplicates?space=${life}`)).status, 403);
    assert.deepEqual(await groups(studio), []);
    assert.equal((await owner.get('/api/index')).data.items.length, 6, 'finding duplicates deleted nothing');
    // one of them goes to the trash: what is left was taken months apart and is only alike, so the group is gone. Search no longer finds it either
    await owner.post('/api/items/bulk', { ids: [ids['sideways.jpg']], action: 'delete' });
    assert.deepEqual(await groups(), []);
    assert.ok(!(await search('boat')).data.results.some((x: any) => x[0] === ids['sideways.jpg']));
    // and comes back with it
    await owner.post('/api/trash/restore', { ids: [ids['sideways.jpg']] });
    assert.deepEqual(await groups(), [['iphone.heic', 'seaside.jpg', 'sideways.jpg']]);
  });

  it('never hands an embedding to a browser', async () => {
    for (const url of ['/api/index', `/api/items/${ids['seaside.jpg']}`, `/api/search?q=boat&space=${life}`, `/api/items/${ids['seaside.jpg']}/similar`, `/api/duplicates?space=${life}`]) {
      const body = JSON.stringify((await owner.get(url)).data); assert.ok(!/"vec"|"vector"|"embedding"/.test(body), url);
    }
  });
});
