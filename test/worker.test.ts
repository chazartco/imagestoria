import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { Client, FakeWorker, fixture, startApp } from './helpers.js';

/** Phase 3, stage 1: the door for workers. A fake worker drives the whole cycle. */
describe('workers', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let owner: Client, viewer: Client, life: string, w: FakeWorker, wId: string;
  const ids: Record<string, string> = {};
  const item = async (id: string) => (await owner.get('/api/index')).data.items.find((i: any) => i.id === id);
  const state = async () => (await owner.get('/api/admin/workers')).data;
  const counts = async (task = 'caption') => (await state()).tasks.find((t: any) => t.task === task);
  const until = async (ok: () => Promise<boolean>, what: string) => { for (const t0 = Date.now(); !(await ok());) { if (Date.now() - t0 > 15000) throw new Error('never: ' + what); await new Promise((r) => setTimeout(r, 100)); } };
  const seen = (it: any) => ({ caption: `A picture ${it.w} wide.`, scene: 'Beach', objects: [{ label: 'Boat', confidence: 0.9 }, { label: 'boat', confidence: 0.4 }, { label: 'sea', confidence: 0.7 }], text: 'HARBOR  CAFE' });
  const mkWorker = async (name: string) => { const r = await owner.post('/api/admin/workers', { name }); assert.equal(r.status, 200); return { id: r.data.id as string, worker: new FakeWorker(app.base, r.data.token) }; };

  before(async () => {
    app = await startApp('ai_test_worker', { AI_LEASE_MINUTES: '10', AI_TASKS: 'caption' });
    owner = new Client(app.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
    life = (await owner.get('/api/bootstrap')).data.spaces[0].id;
    const inv = await owner.post('/api/people/invite', { who: 'maria@example.com', role: 'editor', spaceIds: [life] });
    viewer = new Client(app.base);
    assert.equal((await viewer.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: 'Maria', email: 'maria@example.com', password: 'a long enough password' })).status, 200);
    for (const f of ['seaside.jpg', 'plain.png', 'sideways.jpg']) ids[f] = (await owner.upload(fixture(f), life)).data.id;
    await owner.settled();
  });
  after(async () => { await app.stop(); });

  it('puts every new upload in line, and says so on the item', async () => {
    await until(async () => (await counts()).waiting === 3, 'three items waiting');
    assert.equal((await item(ids['seaside.jpg']!)).aiStatus, 'queued');
    assert.deepEqual(await counts(), { task: 'caption', waiting: 3, claimed: 0, done: 0, failed: 0 });
  });

  it('makes a token the owner sees once, and only the owner can make one', async () => {
    assert.equal((await viewer.post('/api/admin/workers', { name: 'Mine' })).status, 403);
    assert.equal((await viewer.get('/api/admin/workers')).status, 403);
    assert.match((await owner.post('/api/admin/workers', { name: '  ' })).data.error, /Give the machine a name/);
    const made = await owner.post('/api/admin/workers', { name: 'Tower' });
    assert.match(made.data.token, /^aiw_[\w-]{43}$/);
    w = new FakeWorker(app.base, made.data.token); wId = made.data.id;
    // only a hash is kept, and no route gives the token back
    const rows = await app.ctx.db.execute(sql`select token_hash from workers`);
    assert.ok(rows.rows.every((r: any) => /^[0-9a-f]{64}$/.test(r.token_hash) && !made.data.token.includes(r.token_hash)));
    assert.ok(!JSON.stringify((await state()).workers).includes(made.data.token.slice(4)));
    assert.deepEqual((await state()).workers.map((x: any) => [x.name, x.paused, x.last, x.holding]), [['Tower', false, null, 0]]);
  });

  it('lets a token do its four things and nothing else', async () => {
    // no header from the page is needed, but a token is
    assert.equal((await new FakeWorker(app.base, 'aiw_nope').claim()).status, 401);
    assert.equal((await fetch(app.base + '/api/worker/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"tasks":["caption"]}' })).status, 401);
    assert.equal((await w.heartbeat({ host: 'tower', gpu: 'RTX 3060, 12 GB', os: 'Linux', doing: 'starting', version: '0.1', models: { caption: 'fake-vision' } })).status, 200);
    // a token is nobody on every other route: reading and changing are both refused
    for (const url of ['/api/index', '/api/bootstrap', '/api/people', '/api/stories', `/api/items/${ids['seaside.jpg']}`, `/api/files/${ids['seaside.jpg']}/display`, `/api/files/${ids['seaside.jpg']}/orig`, '/api/admin/overview', '/api/admin/workers', '/api/trash', '/api/reels?space=' + life, '/api/luts', '/api/music']) {
      const r = await w.call('GET', url);
      if (url === '/api/bootstrap') assert.equal(r.data.me, null, 'the token signs nobody in');
      else assert.equal(r.status, 401, url);
    }
    for (const [m, url, body] of [['POST', `/api/items/${ids['seaside.jpg']}/comments`, { text: 'hi' }], ['PATCH', `/api/items/${ids['seaside.jpg']}`, { title: 'x' }], ['POST', '/api/items/bulk', { ids: [ids['seaside.jpg']], action: 'delete' }], ['POST', '/api/admin/workers', { name: 'Another' }], ['POST', '/api/stories', { title: 'x', space: life }]] as const) {
      assert.equal((await w.call(m, url, body)).status, 403, 'without the page header: ' + url);
      assert.equal((await w.call(m, url, body, { 'x-afterimage': '1' })).status, 401, 'with it: ' + url);
    }
    // a signed-in person is not a worker either
    assert.equal((await owner.post('/api/worker/claim', { tasks: ['caption'] })).status, 401);
    // and a file is refused until the item has been claimed
    assert.equal((await w.call('GET', `/api/worker/files/${ids['seaside.jpg']}/display`)).status, 403);
    const s = (await state()).workers[0];
    assert.deepEqual([s.info.host, s.info.gpu, s.info.doing, s.info.models.caption], ['tower', 'RTX 3060, 12 GB', 'starting', 'fake-vision']); assert.ok(Date.now() - s.last < 5000);
  });

  it('hands out a batch once, with files the worker can fetch', async () => {
    const other = (await mkWorker('Laptop')).worker;
    const [a, b] = await Promise.all([w.claim(['caption', 'no-such-task'], 2), other.claim(['caption'], 2)]);
    const got = [...a.data.items, ...b.data.items].map((i: any) => i.id);
    assert.equal(got.length, 3); assert.equal(new Set(got).size, 3, 'no item went to both');
    assert.equal(a.data.leaseSeconds, 600); assert.deepEqual(a.data.tasks, ['caption']);
    assert.deepEqual((await w.claim()).data.items, [], 'nothing left');
    assert.deepEqual(await counts(), { task: 'caption', waiting: 0, claimed: 3, done: 0, failed: 0 });
    const mine = a.data.items[0], theirs = b.data.items[0];
    assert.deepEqual(Object.keys(mine).sort(), ['duration', 'files', 'h', 'id', 'kind', 'lat', 'lng', 'mime', 'tasks', 'w']); assert.deepEqual(mine.tasks, ['caption']);
    assert.equal(mine.files.display, `/api/worker/files/${mine.id}/display`);
    const pic = await w.call('GET', mine.files.display); assert.equal(pic.status, 200); assert.equal(pic.res.headers.get('content-type'), 'image/webp'); assert.ok(pic.data.length > 500);
    assert.equal((await w.call('GET', mine.files.orig)).status, 200);
    assert.equal((await w.call('GET', `/api/worker/files/${mine.id}/thumb`)).status, 404);
    assert.equal((await w.call('GET', theirs.files.display)).status, 403, 'an item another worker holds');
    // the other machine never answers. Its lease runs out and its items come back
    await app.ctx.db.execute(sql`update ai_tasks set lease_until = now() - interval '1 second' where worker_id <> ${wId}::uuid`);
    assert.equal((await other.call('GET', theirs.files.display)).status, 403, 'a claim that ran out opens nothing');
    const again = (await w.claim(['caption'], 8)).data.items.map((i: any) => i.id);
    assert.deepEqual(again.sort(), b.data.items.map((i: any) => i.id).sort());
    // its late answer is refused, because someone else holds the item now
    const late = await other.results([{ itemId: theirs.id, task: 'caption', model: { name: 'm', version: '1' }, data: seen(theirs) }]);
    assert.deepEqual([late.status, late.data.accepted], [200, 0]); assert.match(late.data.refused[0].reason, /does not hold that task/);
    assert.equal((await item(theirs.id)).aiCaption, null);
    assert.equal((await state()).workers.find((x: any) => x.name === 'Tower').holding, 3);
  });

  it('takes results one by one, records the model, and fills the page', async () => {
    const [a, b, c] = [ids['seaside.jpg']!, ids['plain.png']!, ids['sideways.jpg']!];
    const r = await w.results([
      { itemId: a, task: 'caption', model: { name: 'fake-vision', version: '2026-11' }, data: seen({ w: 1 }) },
      { itemId: b, task: 'caption', model: { name: 'fake-vision', version: '2026-11' }, data: { caption: 5, objects: 'boat' } },
      { itemId: c, task: 'caption', data: seen({ w: 3 }) },
      { itemId: c, task: 'faces', model: { name: 'x', version: '1' }, data: {} },
      { itemId: '00000000-0000-4000-8000-000000000000', task: 'caption', model: { name: 'x', version: '1' }, data: seen({ w: 0 }) },
    ]);
    assert.equal(r.status, 200); assert.equal(r.data.accepted, 1);
    assert.deepEqual(r.data.refused.map((x: any) => [x.itemId, x.task, x.reason.replace(/:.*/, '')]), [[b, 'caption', 'The result is not in the agreed shape'], [c, 'caption', 'A result must say which model produced it.'], [c, 'faces', 'This server does not take results for that task.'], ['00000000-0000-4000-8000-000000000000', 'caption', 'This worker does not hold that task. Its claim may have run out.']]);
    const it1 = await item(a);
    assert.deepEqual([it1.aiStatus, it1.aiScene, it1.aiCaption], ['done', 'beach', 'A picture 1 wide.']);
    assert.deepEqual(it1.labels, [['boat', 0.9, 'ai'], ['sea', 0.7, 'ai']], 'lower case, and the same thing twice keeps its higher confidence');
    const row = (await app.ctx.db.execute(sql`select status, model, model_version as v, done_at is not null as done, (select ai_text from items where id = ${a}::uuid) as text from ai_tasks where item_id = ${a}::uuid`)).rows[0] as any;
    assert.deepEqual([row.status, row.model, row.v, row.done, row.text], ['done', 'fake-vision', '2026-11', true, 'HARBOR CAFE']);
    assert.equal((await item(b)).aiStatus, 'queued', 'a refused answer leaves the task with the worker');
    // a second answer for a finished task is refused
    assert.equal((await w.results([{ itemId: a, task: 'caption', model: { name: 'x', version: '1' }, data: seen({ w: 9 }) }])).data.accepted, 0);
    assert.equal((await w.results([{ itemId: c, task: 'caption', model: { name: 'fake-vision', version: '2026-11' }, data: { caption: 'Sideways.', scene: null, objects: [] } }])).data.accepted, 1);
    assert.deepEqual(await counts(), { task: 'caption', waiting: 0, claimed: 1, done: 2, failed: 0 });
  });

  it('tries a task that a worker could not do again, three times in all', async () => {
    const b = ids['plain.png']!;
    await app.ctx.db.execute(sql`update ai_tasks set attempts = 1 where item_id = ${b}::uuid`);
    assert.equal((await w.results([{ itemId: b, task: 'caption', error: 'The model gave no JSON.' }])).data.accepted, 1);
    assert.deepEqual(await counts(), { task: 'caption', waiting: 1, claimed: 0, done: 2, failed: 0 });
    for (const n of [2, 3]) {
      assert.deepEqual((await w.claim()).data.items.map((i: any) => i.id), [b], 'try ' + n);
      await w.results([{ itemId: b, task: 'caption', error: 'The model gave no JSON.' }]);
    }
    assert.deepEqual(await counts(), { task: 'caption', waiting: 0, claimed: 0, done: 2, failed: 1 });
    assert.deepEqual((await w.claim()).data.items, []); assert.equal((await item(b)).aiStatus, 'none');
    const row = (await app.ctx.db.execute(sql`select attempts, error from ai_tasks where item_id = ${b}::uuid`)).rows[0] as any;
    assert.deepEqual([row.attempts, row.error], [3, 'The model gave no JSON.']);
    // a lease that runs out three times ends the same way
    await app.ctx.db.execute(sql`update ai_tasks set status = 'queued', attempts = 2, error = null where item_id = ${b}::uuid`);
    assert.equal((await w.claim()).data.items.length, 1);
    await app.ctx.db.execute(sql`update ai_tasks set lease_until = now() - interval '1 second' where item_id = ${b}::uuid`);
    assert.deepEqual((await w.claim()).data.items, []);
    assert.equal((await app.ctx.db.execute(sql`select error from ai_tasks where item_id = ${b}::uuid`)).rows[0]!.error, 'No worker finished this in time.');
  });

  it('reads everything again when asked, keeping what was read until the new answer arrives', async () => {
    assert.equal((await viewer.post('/api/admin/workers/redo', { task: 'caption' })).status, 403);
    assert.match((await owner.post('/api/admin/workers/redo', { task: 'faces' })).data.error, /does not do that task yet/);
    assert.equal((await owner.post('/api/admin/workers/redo', { task: 'caption' })).data.n, 3);
    assert.deepEqual(await counts(), { task: 'caption', waiting: 3, claimed: 0, done: 0, failed: 0 });
    const a = await item(ids['seaside.jpg']!); assert.deepEqual([a.aiStatus, a.aiCaption], ['queued', 'A picture 1 wide.']);
    // a worker that is stopping gives back what it holds, and that does not count as a try
    const borrowed = (await w.claim(['caption'], 2)).data.items.map((i: any) => i.id);
    assert.deepEqual((await w.release([...borrowed, ids['seaside.jpg']!])).data, { released: 2 });
    assert.deepEqual([(await counts()).waiting, (await counts()).claimed], [3, 0]);
    assert.equal((await app.ctx.db.execute(sql`select max(attempts)::int as n from ai_tasks`)).rows[0]!.n, 0);
    // a heartbeat keeps a slow worker's claims alive
    assert.equal((await w.claim(['caption'], 1)).data.items.length, 1);
    await app.ctx.db.execute(sql`update ai_tasks set lease_until = now() + interval '5 seconds' where status = 'claimed'`);
    const hb = await w.heartbeat({ doing: 'caption, 1 item' }); assert.deepEqual([hb.data.paused, hb.data.waiting.caption, hb.data.name], [false, 2, 'Tower']);
    assert.ok(Number((await app.ctx.db.execute(sql`select extract(epoch from lease_until - now()) as s from ai_tasks where status = 'claimed'`)).rows[0]!.s) > 500);
    const done = [...(await w.work((it) => ({ caption: 'Second reading.', scene: 'city street', objects: [{ label: 'car', confidence: 0.8 }] }), ['caption'], { name: 'better-vision', version: '2' }))];
    assert.equal(done.length, 2, 'the two still waiting');
    const first = (await owner.get('/api/index')).data.items.find((i: any) => done.includes(i.id));
    assert.deepEqual([first.aiStatus, first.aiCaption, first.aiScene, first.labels], ['done', 'Second reading.', 'city street', [['car', 0.8, 'ai']]], 'the old labels are replaced, not added to');
    assert.equal((await app.ctx.db.execute(sql`select count(*)::int as n from ai_tasks where model = 'better-vision' and model_version = '2'`)).rows[0]!.n, 2);
  });

  it('lets a person correct what the worker said, and a second reading never undoes it', async () => {
    const hb = await w.heartbeat(); assert.ok(hb.data.scenes.includes('beach') && hb.data.scenes.includes('other') && hb.data.scenes.length > 20, 'the worker is told the list of scenes');
    // settle everything first, with one reading for every item
    await owner.post('/api/admin/workers/redo', { task: 'caption' });
    const read = () => ({ caption: 'A boat on the sea.', scene: 'Somewhere odd', objects: [{ label: 'boat', confidence: 0.9 }, { label: 'dog', confidence: 0.6 }, { label: 'sea', confidence: 0.5 }], text: 'no entry' });
    assert.equal((await w.work(read)).length, 3);
    const id = ids['seaside.jpg']!, fix = (body: unknown, who = owner) => who.json('PATCH', `/api/items/${id}/ai`, body);
    let it = await item(id);
    assert.deepEqual([it.aiScene, it.aiText, it.aiLocked, it.labels.map((l: any) => l[0])], ['other', 'no entry', [], ['boat', 'dog', 'sea']], 'a scene that is not on the list is filed under other');
    // who may: someone who can tag, in that space
    const inv = await owner.post('/api/people/invite', { who: 'vera@example.com', role: 'viewer', spaceIds: [life] }), looker = new Client(app.base);
    await looker.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: 'Vera', email: 'vera@example.com', password: 'a long enough password' });
    assert.equal((await fix({ caption: 'x' }, looker)).status, 403);
    assert.match((await fix({ scene: 'moon base' })).data.error, /Choose a scene from the list/);
    assert.equal((await fix({ caption: '  Our boat,   the Marlin. ', scene: 'coast', remove: ['Dog'], add: ['Marlin', 'sea'] }, viewer)).status, 200, 'an editor may');
    it = await item(id);
    assert.deepEqual([it.aiCaption, it.aiScene, [...it.aiLocked].sort()], ['Our boat, the Marlin.', 'coast', ['caption', 'scene']]);
    assert.deepEqual(it.labels, [['marlin', 1, 'person'], ['sea', 1, 'person'], ['boat', 0.9, 'ai']], 'what a person added is theirs, and what they removed is gone');
    // the library is read again by a different model: the corrections stand, everything else is replaced
    await owner.post('/api/admin/workers/redo', { task: 'caption' });
    await w.work(() => ({ caption: 'A small vessel at anchor.', scene: 'beach', objects: [{ label: 'dog', confidence: 0.99 }, { label: 'sea', confidence: 0.4 }, { label: 'mast', confidence: 0.7 }], text: 'private' }), ['caption'], { name: 'other-vision', version: '9' });
    it = await item(id);
    assert.deepEqual([it.aiCaption, it.aiScene, it.aiText], ['Our boat, the Marlin.', 'coast', 'private']);
    assert.deepEqual(it.labels, [['marlin', 1, 'person'], ['sea', 1, 'person'], ['mast', 0.7, 'ai']], 'the removed label did not come back, and the old machine labels were replaced');
    const untouched = await item(ids['sideways.jpg']!); assert.deepEqual([untouched.aiCaption, untouched.aiScene, untouched.labels.map((l: any) => l[0])], ['A small vessel at anchor.', 'beach', ['dog', 'mast', 'sea']]);
    // a person can clear a caption or a scene, and bring back a label they removed
    assert.equal((await fix({ caption: '', scene: null, add: ['dog'] })).status, 200);
    it = await item(id); assert.deepEqual([it.aiCaption, it.aiScene, it.labels[0]], [null, null, ['dog', 1, 'person']]);
  });

  it('pauses one machine, and leaves trashed items out', async () => {
    assert.equal((await owner.json('PATCH', `/api/admin/workers/${wId}`, { paused: true })).status, 200);
    await owner.post('/api/admin/workers/redo', { task: 'caption' });
    const r = await w.claim(); assert.deepEqual([r.data.paused, r.data.items], [true, []]);
    assert.equal((await w.heartbeat()).data.paused, true);
    await owner.json('PATCH', `/api/admin/workers/${wId}`, { paused: false, name: 'Tower Two' });
    assert.equal((await state()).workers.find((x: any) => x.id === wId).name, 'Tower Two');
    // an item in the trash is not handed out, and is not counted as waiting
    await owner.post('/api/items/bulk', { ids: [ids['sideways.jpg']], action: 'delete' });
    assert.equal((await counts()).waiting, 2);
    const got = (await w.claim()).data.items.map((i: any) => i.id);
    assert.ok(got.length === 2 && !got.includes(ids['sideways.jpg']));
    // trashed while a worker holds it: the file is refused, and emptying the trash drops its work
    await owner.post('/api/items/bulk', { ids: [ids['plain.png']], action: 'delete' });
    assert.equal((await w.call('GET', `/api/worker/files/${ids['plain.png']}/display`)).status, 404);
    await owner.post('/api/trash/empty');
    assert.equal((await app.ctx.db.execute(sql`select count(*)::int as n from ai_tasks`)).rows[0]!.n, 1);
    assert.equal((await w.results([{ itemId: ids['plain.png'], task: 'caption', model: { name: 'm', version: '1' }, data: { caption: 'Gone.' } }])).data.accepted, 0);
  });

  it('queues a saved copy by itself', async () => {
    const src = ids['seaside.jpg']!;
    const copy = await owner.post(`/api/items/${src}/copies`, { recipe: { adj: { exposure: 20 }, geo: { rot: 0, flipH: false, flipV: false, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } }, curve: [0, 0.25, 0.5, 0.75, 1] } });
    assert.equal(copy.status, 200, JSON.stringify(copy.data)); await owner.settled();
    await until(async () => (await item(copy.data.id)).aiStatus === 'queued', 'the copy is in line');
  });

  it('refuses a revoked token at once and puts its work back', async () => {
    assert.equal((await counts()).claimed, 1);
    assert.equal((await viewer.json('DELETE', `/api/admin/workers/${wId}`)).status, 403);
    assert.equal((await owner.json('DELETE', `/api/admin/workers/${wId}`)).status, 200);
    for (const r of [await w.claim(), await w.heartbeat(), await w.results([{ itemId: ids['seaside.jpg'], task: 'caption', error: 'x' }]), await w.call('GET', `/api/worker/files/${ids['seaside.jpg']}/display`)]) { assert.equal(r.status, 401); assert.match(r.data.error, /revoked/); }
    assert.deepEqual([(await counts()).claimed, (await counts()).waiting], [0, 2]);
    assert.ok(!(await state()).workers.some((x: any) => x.id === wId));
    assert.equal((await owner.json('DELETE', `/api/admin/workers/${wId}`)).status, 404);
    // the site works the same with no worker at all
    assert.equal((await owner.get('/api/index')).status, 200);
  });
});
