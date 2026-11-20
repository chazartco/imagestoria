import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { cluster, forgetGroups, groupsOf, type Face } from '../src/server/ai/faces.js';
import { Client, FakeWorker, fixture, startApp } from './helpers.js';

/** Phase 3, stage 4: people. A fake worker posts faces, and people name them. */
describe('people in the pictures', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let owner: Client, editor: Client, viewer: Client, life: string, studio: string, w: FakeWorker;
  const ids: Record<string, string> = {};
  const MODEL = { name: 'test-faces', version: '1' };
  /** A face embedding: mostly along one direction (who it is), with a little of another (this particular picture). */
  const fv = (who: number, shot = 0, amount = 0.2) => { const f = new Float32Array(64); f[who] = 1; if (shot) f[shot] = amount; return Buffer.from(f.buffer).toString('base64'); };
  const MARIA = 0, JUAN = 1, STRANGER = 2, OLDER = 5;
  const face = (who: number, shot: number, x = 0.1, quality = 0.8, amount = 0.2) => ({ box: [x, 0.2, 0.2, 0.3], score: 0.9, quality, vector: fv(who, shot, amount) });
  const queue: Record<string, unknown[]> = {};
  /** Let the worker read whatever is waiting, answering each picture with the faces set for it in `queue`. */
  const read = async () => { let n = 0; for (let k = 0; k < 20; k++) { const got = await w.work((item: any) => ({ w: 1000, h: 800, faces: queue[item.id] ?? [] }), ['faces'], MODEL); if (!got.length && k > 2) break; n += got.length; if (!got.length) await new Promise((r) => setTimeout(r, 150)); } return n; };
  const over = async (who = owner, space = life) => (await who.get(`/api/faces/overview?space=${space}`)).data;
  const review = async () => (await owner.get(`/api/faces/review?space=${life}`)).data;
  const item = async (id: string, who = owner) => (await who.get('/api/index')).data.items.find((i: any) => i.id === id);
  const facesOf = async (id: string, who = owner) => (await who.get(`/api/items/${id}/faces`)).data.faces as any[];
  const copyOf = async (src: string) => { const r = await owner.post(`/api/items/${src}/copies`, { recipe: { adj: { exposure: 10 + Object.keys(ids).length }, geo: { rot: 0, flipH: false, flipV: false, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } }, curve: [0, 0.25, 0.5, 0.75, 1] } }); assert.equal(r.status, 200, JSON.stringify(r.data)); await owner.settled(); return r.data.id as string; };
  const person = async (name: string) => (await over()).people.find((p: any) => p.name === name);

  before(async () => {
    app = await startApp('ai_test_people', { AI_TASKS: 'faces', FACE_AUTO_MIN_CONFIRMED: '3' });
    owner = new Client(app.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
    const spaces = (await owner.get('/api/bootstrap')).data.spaces; life = spaces[0].id; studio = spaces[1].id;
    const join = async (who: string, role: string) => { const inv = await owner.post('/api/people/invite', { who, role, spaceIds: [life, studio] }), c = new Client(app.base); await c.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: who.split('@')[0], email: who, password: 'a long enough password' }); return c; };
    editor = await join('eva@example.com', 'editor'); viewer = await join('vera@example.com', 'viewer');
    for (const f of ['seaside.jpg', 'sideways.jpg', 'plain.png', 'iphone.heic', 'clip.mp4']) ids[f] = (await owner.upload(fixture(f), life)).data.id;
    await owner.settled(60000);
    w = new FakeWorker(app.base, (await owner.post('/api/admin/workers', { name: 'Tower' })).data.token);
  });
  after(async () => { await app.stop(); });

  it('is off until the owner turns it on for a space, and only the owner can', async () => {
    assert.deepEqual((await owner.get('/api/bootstrap')).data.spaces.map((s: any) => s.people), [false, false]);
    const o = await over(); assert.deepEqual([o.on, o.people, o.groups, o.counts, o.mayAdmin], [false, [], [], null, true]);
    assert.deepEqual((await w.claim(['faces'])).data.items, [], 'nothing is handed out while it is off');
    assert.equal((await owner.get(`/api/faces/review?space=${life}`)).status, 409);
    assert.equal((await viewer.get(`/api/faces/overview?space=${life}`)).status, 403);
    assert.equal((await editor.get(`/api/faces/overview?space=${life}`)).data.mayAdmin, false);
    assert.equal((await editor.post('/api/faces/settings', { space: life, on: true })).status, 403);
    assert.equal((await owner.post('/api/faces/settings', { space: life, on: true })).status, 200);
    assert.deepEqual((await owner.get('/api/bootstrap')).data.spaces.map((s: any) => s.people), [true, false]);
    // every photo in that space is now in line. Videos are not, and nor is anything in the other space.
    const waiting = (await app.ctx.db.execute(sql`select item_id as id from ai_tasks where task = 'faces' and status = 'queued'`)).rows.map((r: any) => r.id).sort();
    assert.deepEqual(waiting, [ids['seaside.jpg'], ids['sideways.jpg'], ids['plain.png'], ids['iphone.heic']].sort());
    assert.equal((await over()).counts.waiting, 4);
  });

  it('takes the faces a worker found, and never gives an embedding back', async () => {
    const got = (await w.claim(['faces'], 1)).data.items[0];
    const send = (data: unknown) => w.results([{ itemId: got.id, task: 'faces', model: MODEL, data }]);
    assert.match((await send({ w: 10, h: 10, faces: [{ box: [0, 0, 2, 1], score: 1, quality: 1, vector: fv(0) }] })).data.refused[0].reason, /not in the agreed shape/);
    assert.match((await send({ w: 10, h: 10, faces: [{ box: [0, 0, 1, 1], score: 1, quality: 1, vector: Buffer.alloc(40).toString('base64') }] })).data.refused[0].reason, /not a list of 32-bit numbers/);
    assert.match((await send({ w: 10, h: 10, faces: [{ box: [0, 0, 1, 1], score: 1, quality: 1, vector: Buffer.alloc(256).toString('base64') }] })).data.refused[0].reason, /all zeros/);
    await w.release([got.id]);
    queue[ids['seaside.jpg']!] = [face(MARIA, 10, 0.1, 0.9), face(JUAN, 20, 0.6)];
    queue[ids['sideways.jpg']!] = [face(MARIA, 11), face(STRANGER, 30, 0.6, 0.3)];
    queue[ids['plain.png']!] = [face(MARIA, 12), face(JUAN, 21, 0.6)];
    queue[ids['iphone.heic']!] = [face(MARIA, 13)];
    assert.equal(await read(), 4);
    const o = await over();
    assert.deepEqual(o.counts, { faces: 7, named: 0, auto: 0, suggested: 0, unsorted: 7, ignored: 0, waiting: 0 });
    // grouped by likeness, the largest group first, and the face seen once on its own
    assert.deepEqual(o.groups.map((g: any) => g.n), [4, 2]); assert.equal(o.singles.length, 1);
    assert.deepEqual(o.groups[0].faces.map((f: any) => f.item).sort(), [ids['seaside.jpg'], ids['sideways.jpg'], ids['plain.png'], ids['iphone.heic']].sort());
    assert.equal(o.groups[0].faces[0].item, ids['seaside.jpg'], 'the best likeness leads its group');
    for (const url of [`/api/faces/overview?space=${life}`, `/api/faces/review?space=${life}`, `/api/items/${ids['seaside.jpg']}/faces`, '/api/index']) assert.ok(!/"vec"|"vector"|"embedding"/.test(JSON.stringify((await owner.get(url)).data)), url);
    // a face is shown as a detail cut from the picture, to the people who may see it
    const crop = await owner.raw('GET', `/api/faces/${o.groups[0].faces[0].id}/crop`); assert.equal(crop.status, 200); assert.equal(crop.headers.get('content-type'), 'image/webp');
    assert.equal(Buffer.from(await crop.arrayBuffer()).subarray(8, 12).toString(), 'WEBP');
    assert.equal((await viewer.raw('GET', `/api/faces/${o.groups[0].faces[0].id}/crop`)).status, 403);
  });

  it('names a whole group at once, and shows the name only to the owner and editors', async () => {
    const o = await over(), g = o.groups[0].faces.map((f: any) => f.id);
    assert.equal((await viewer.post('/api/faces/name', { faceIds: g, name: 'Maria' })).status, 403);
    assert.match((await owner.post('/api/faces/name', { faceIds: g, name: ' ' })).data.error, /Type a name/);
    // one face is left out of the group before naming
    const made = await editor.post('/api/faces/name', { faceIds: g.slice(0, 3), name: 'Maria' }); assert.equal(made.status, 200);
    const after1 = await over(); assert.deepEqual(after1.people.map((p: any) => [p.name, p.n, p.auto, p.looks]), [['Maria', 3, 0, 1]]);
    // the one left out is now a suggestion: it looks like someone who has a name
    assert.deepEqual([after1.counts.named, after1.counts.suggested], [3, 1]);
    const sug = (await review()).suggested; assert.equal(sug.length, 1); assert.deepEqual([sug[0].id, sug[0].person, sug[0].score > 0.9], [g[3], made.data.id, true]);
    // typing the same name again, in any case, is the same person
    assert.equal((await owner.post('/api/faces/name', { faceIds: [g[3]], name: 'MARIA' })).data.id, made.data.id);
    assert.equal((await over()).people.length, 1);
    // the library: owner and editor get the person on the item and their name. A viewer gets neither.
    for (const who of [owner, editor]) { const idx = (await who.get('/api/index')).data; assert.deepEqual(idx.items.find((i: any) => i.id === ids['seaside.jpg']).people, [made.data.id]); assert.deepEqual(idx.persons, { [made.data.id]: 'Maria' }); }
    const seen = (await viewer.get('/api/index')).data; assert.deepEqual(seen.persons, {}); assert.ok(seen.items.every((i: any) => !i.people || !i.people.length));
    assert.deepEqual(await facesOf(ids['seaside.jpg']!, viewer), []);
    const boxes = await facesOf(ids['seaside.jpg']!); assert.deepEqual(boxes.map((f) => [f.person, f.status, f.box.map((n: number) => Math.round(n * 10) / 10)]), [[made.data.id, 'confirmed', [0.1, 0.2, 0.2, 0.3]], [null, 'unsorted', [0.6, 0.2, 0.2, 0.3]]]);
    // the other group becomes a second person
    const juan = (await over()).groups[0].faces.map((f: any) => f.id); assert.equal(juan.length, 2);
    assert.equal((await owner.post('/api/faces/name', { faceIds: juan, name: 'Juan' })).status, 200);
  });

  it('suggests a name for a new face, takes a no for an answer, and never asks the same thing twice', async () => {
    ids['copy1'] = await copyOf(ids['seaside.jpg']!);
    queue[ids['copy1']] = [face(MARIA, 14), face(JUAN, 22, 0.6)];
    assert.equal(await read(), 1);
    const maria = await person('Maria'), juan = await person('Juan');
    let sug = (await review()).suggested;
    assert.deepEqual(sug.map((s: any) => s.person).sort(), [maria.id, juan.id].sort());
    assert.deepEqual((await facesOf(ids['copy1'])).map((f) => [f.status, f.suggested]), [['suggested', maria.id], ['suggested', juan.id]]);
    assert.deepEqual((await item(ids['copy1'])).people, [], 'a suggestion is not a name');
    // no: it is not Juan. The face goes back to unsorted and Juan is not offered for it again, however often faces are matched.
    const notJuan = sug.find((s: any) => s.person === juan.id);
    assert.equal((await viewer.post('/api/faces/reject', { faceIds: [notJuan.id] })).status, 403);
    assert.equal((await owner.post('/api/faces/reject', { faceIds: [notJuan.id] })).status, 200);
    await owner.post('/api/faces/settings', { auto: { on: false, threshold: 0.6 } });
    assert.deepEqual((await review()).suggested.map((s: any) => s.person), [maria.id]);
    assert.equal((await over()).singles.some((f: any) => f.id === notJuan.id), true, 'it waits to be named');
    // yes: it is Maria
    sug = (await review()).suggested;
    assert.equal((await owner.post('/api/faces/name', { faceIds: [sug[0].id], personId: maria.id })).status, 200);
    assert.deepEqual((await item(ids['copy1'])).people, [maria.id]);
    assert.equal((await person('Maria')).n, 5);
    // a face that is set aside is not asked about again, and can be brought back
    assert.equal((await owner.post('/api/faces/ignore', { faceIds: [notJuan.id], as: 'ignored' })).status, 200);
    let o = await over(); assert.deepEqual([o.counts.ignored, o.singles.some((f: any) => f.id === notJuan.id)], [1, false]);
    assert.ok(!(await facesOf(ids['copy1'])).some((f) => f.id === notJuan.id), 'and it is not outlined in the viewer');
    await owner.post('/api/faces/ignore', { faceIds: [notJuan.id], as: 'unsorted' });
    o = await over(); assert.equal(o.counts.ignored, 0);
  });

  it('shows how automatic naming would have done before it is turned on', async () => {
    const n = (await owner.get(`/api/faces/numbers?space=${life}`)).data;
    assert.deepEqual([n.faces, n.people, n.minConfirmed], [7, 2, 3]);
    // Maria has five confirmed faces: each is named right from the other four. Juan has two: too few to name automatically.
    assert.deepEqual(n.rows.find((r: any) => r.threshold === 0.6), { threshold: 0.6, right: 5, wrong: 0, asked: 2 });
    assert.deepEqual(n.rows.map((r: any) => r.threshold), [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75]);
    assert.equal((await viewer.get(`/api/faces/numbers?space=${life}`)).status, 403);
    const o = await over(); assert.deepEqual([o.auto, o.threshold], [false, 0.6], 'off until the owner chooses');
  });

  it('names without asking only when it is sure, marks it as automatic, and gets more careful after an undo', async () => {
    assert.equal((await editor.post('/api/faces/settings', { auto: { on: true, threshold: 0.7 } })).status, 403);
    assert.equal((await owner.post('/api/faces/settings', { auto: { on: true, threshold: 0.7 } })).status, 200);
    const maria = await person('Maria'), juan = await person('Juan');
    ids['copy2'] = await copyOf(ids['seaside.jpg']!);
    // four faces: clearly Maria; clearly Juan (who has too few confirmed faces); halfway between the two; and Maria, but not alike enough
    const between = (() => { const f = new Float32Array(64); f[MARIA] = 1; f[JUAN] = 1; return { box: [0.5, 0.5, 0.1, 0.1], score: 0.9, quality: 0.5, vector: Buffer.from(f.buffer).toString('base64') }; })();
    queue[ids['copy2']] = [face(MARIA, 15, 0.05), { ...face(JUAN, 23, 0.3), box: [0.3, 0.1, 0.1, 0.1] }, between, { ...face(MARIA, 40, 0.7, 0.8, 1.2), box: [0.8, 0.5, 0.1, 0.1] }];
    assert.equal(await read(), 1);
    const fs = await facesOf(ids['copy2']);
    // once Maria is named in the picture she is not offered for another face in it: a person is in a picture once
    assert.deepEqual(fs.map((f) => [f.status, f.person, f.suggested]), [['auto', maria.id, null], ['suggested', null, juan.id], ['suggested', null, juan.id], ['unsorted', null, null]]);
    assert.deepEqual((await item(ids['copy2'])).people, [maria.id]);
    const r = await review(); assert.deepEqual(r.auto.map((a: any) => [a.id, a.person, a.score > 0.9, typeof a.at]), [[fs[0]!.id, maria.id, true, 'number']]);
    assert.deepEqual([(await person('Maria')).n, (await person('Maria')).auto], [6, 1]);
    // an automatic name does not count as evidence for the next one: only what a person confirmed does
    assert.equal((await owner.get(`/api/faces/numbers?space=${life}`)).data.faces, 7);
    // undo: the name comes off, that person is not offered for this face again, and automatic naming is stricter about them
    assert.equal((await owner.post('/api/faces/reject', { faceIds: [fs[0]!.id] })).status, 200);
    assert.deepEqual((await facesOf(ids['copy2']))[0], { id: fs[0]!.id, box: (await facesOf(ids['copy2']))[0]!.box, person: null, suggested: null, status: 'unsorted', score: null });
    assert.deepEqual((await item(ids['copy2'])).people, []);
    assert.equal((await person('Maria')).strict, 1);
    // 0.96 alike used to be enough at 0.7. One more undo away it still is. A bar raised past it is not.
    await app.ctx.db.execute(sql`update persons set strict = 9 where id = ${maria.id}::uuid`);
    ids['copy3'] = await copyOf(ids['seaside.jpg']!); queue[ids['copy3']] = [face(MARIA, 16)];
    await read();
    assert.deepEqual((await facesOf(ids['copy3'])).map((f) => [f.status, f.suggested]), [['suggested', maria.id]], 'asked, not assumed');
    await app.ctx.db.execute(sql`update persons set strict = 1 where id = ${maria.id}::uuid`);
    // a person confirming an automatic name makes it theirs
    await owner.post('/api/faces/settings', { auto: { on: true, threshold: 0.7 } });
    const now = await facesOf(ids['copy3']); assert.equal(now[0]!.status, 'auto');
    await owner.post('/api/faces/name', { faceIds: [now[0]!.id], personId: maria.id });
    assert.equal((await facesOf(ids['copy3']))[0]!.status, 'confirmed');
  });

  it('keeps several looks of one person, so a child at three and at thirteen is one person', async () => {
    const maria = await person('Maria');
    ids['copy4'] = await copyOf(ids['seaside.jpg']!); queue[ids['copy4']] = [face(OLDER, 50)];
    ids['copy4b'] = await copyOf(ids['seaside.jpg']!); queue[ids['copy4b']] = [{ ...face(OLDER, 51), box: [0.5, 0.5, 0.2, 0.2] }];
    await read();
    const fs = [...await facesOf(ids['copy4']), ...await facesOf(ids['copy4b'])]; assert.deepEqual(fs.map((f) => f.status), ['unsorted', 'unsorted'], 'nothing like her is known yet');
    await owner.post('/api/faces/name', { faceIds: [fs[0]!.id], personId: maria.id });
    assert.equal((await person('Maria')).looks, 2);
    // the face of the new look in another picture is now recognised as her (and named, since automatic naming is on), and the old look still is
    assert.deepEqual([...await facesOf(ids['copy4']), ...await facesOf(ids['copy4b'])].map((f) => [f.status, f.suggested ?? f.person]).sort(), [['auto', maria.id], ['confirmed', maria.id]].sort());
    ids['copy5'] = await copyOf(ids['seaside.jpg']!); queue[ids['copy5']] = [face(MARIA, 18)]; await read();
    assert.deepEqual((await facesOf(ids['copy5'])).map((f) => [f.status, f.person]), [['auto', maria.id]]);
  });

  it('keeps what a person decided when a picture is read again', async () => {
    const before = await facesOf(ids['seaside.jpg']!), maria = await person('Maria');
    // a newer model finds the first face a little to one side, misses the second, and finds a new one
    queue[ids['seaside.jpg']!] = [{ ...face(MARIA, 17, 0.12), box: [0.12, 0.21, 0.2, 0.3] }, { ...face(STRANGER, 31), box: [0.4, 0.6, 0.1, 0.1] }];
    await owner.post('/api/admin/workers/redo', { task: 'faces' });
    Object.keys(queue).forEach((k) => { if (k !== ids['seaside.jpg']) delete queue[k]; });
    const all = (await owner.get('/api/index')).data.items.filter((i: any) => i.kind === 'photo').length;
    assert.equal((await w.claim(['faces'], 64)).data.items.length, all);
    assert.equal((await w.results([{ itemId: ids['seaside.jpg'], task: 'faces', model: { name: 'new-faces', version: '2' }, data: { w: 1000, h: 800, faces: queue[ids['seaside.jpg']!] } }])).data.accepted, 1);
    const now = await facesOf(ids['seaside.jpg']!);
    assert.equal(now.length, 3);
    const kept = now.find((f) => f.id === before[0]!.id)!; assert.deepEqual([kept.person, kept.status, Math.round(kept.box[0] * 100)], [maria.id, 'confirmed', 12], 'the same face, still Maria, in its new place');
    assert.ok(now.some((f) => f.id === before[1]!.id && f.status === 'confirmed'), 'a face a person named is not dropped because a model missed it');
    assert.ok(now.some((f) => f.status === 'unsorted' && Math.round(f.box[0] * 10) === 4), 'and the new face is waiting');
  });

  it('merges, renames and forgets people', async () => {
    const maria = await person('Maria'), juan = await person('Juan');
    assert.equal((await owner.json('PATCH', `/api/persons/${juan.id}`, { name: 'maria' })).status, 409);
    assert.equal((await viewer.json('PATCH', `/api/persons/${juan.id}`, { name: 'John' })).status, 403);
    assert.equal((await editor.json('PATCH', `/api/persons/${juan.id}`, { name: 'Juan Carlos' })).status, 200);
    assert.equal((await owner.get('/api/index')).data.persons[juan.id], 'Juan Carlos');
    // they turn out to be one person
    assert.match((await owner.post(`/api/persons/${juan.id}/merge`, { into: juan.id })).data.error, /Choose another person/);
    const total = maria.n + juan.n, together = (await owner.get('/api/index')).data.items.filter((i: any) => i.people.includes(maria.id) && i.people.includes(juan.id)).length;
    assert.ok(together > 0, 'they are side by side in some pictures');
    assert.equal((await owner.post(`/api/persons/${juan.id}/merge`, { into: maria.id })).status, 200);
    // every face of both is hers now, except where the two stood in one picture: there one face keeps the name and the other waits to be named
    const o = await over(); assert.equal(o.people.length, 1); assert.equal(o.people[0].name, 'Maria'); assert.equal(o.people[0].n, total - together);
    assert.ok((await owner.get('/api/index')).data.items.every((i: any) => new Set(i.people).size === i.people.length));
    const merged = o.people[0].n;
    assert.ok(!(juan.id in (await owner.get('/api/index')).data.persons));
    // forgetting a person deletes the name and the face data of every face that carried it
    const facesBefore = o.counts.faces;
    assert.equal((await editor.json('DELETE', `/api/persons/${maria.id}`)).status, 200);
    const gone = await over(); assert.deepEqual([gone.people, gone.counts.faces, gone.counts.named], [[], facesBefore - merged, 0]);
    assert.equal((await app.ctx.db.execute(sql`select count(*)::int as n from faces where person_id is not null or suggested_id is not null`)).rows[0]!.n, 0);
    assert.deepEqual((await item(ids['seaside.jpg']!)).people, []);
  });

  it('stores a face once, and lets a person be in a picture once', async () => {
    const { sameSpot, tidyFaces } = await import('../src/server/ai/faces.js');
    assert.equal(sameSpot([0.1, 0.1, 0.2, 0.3], [0.12, 0.15, 0.08, 0.2]), true, 'a part of a face inside the whole face');
    assert.equal(sameSpot([0.1, 0.1, 0.2, 0.3], [0.6, 0.1, 0.2, 0.3]), false);
    const X = ids['iphone.heic']!, db = app.ctx.db;
    const rowsOf = async () => (await db.execute(sql`select id, x, w, status, person_id as person from faces where item_id = ${X}::uuid order by x, w desc`)).rows as any[];
    Object.keys(queue).forEach((k) => delete queue[k]); queue[X] = [face(8, 60, 0.1)];
    await owner.post('/api/admin/workers/redo', { task: 'faces' }); await read();
    const first = (await rowsOf())[0]; assert.ok(first, 'the picture has a face');
    const tidy = (await owner.post('/api/faces/name', { faceIds: [first.id], name: 'Tidy' })).data; assert.equal(tidy.also, 0);
    // what an older worker left behind: the same face again in part, and a second face in the picture with the same name
    const copy = (dx: number, k: number) => db.execute(sql`insert into faces (item_id, x, y, w, h, score, quality, vec, model, person_id, status) select item_id, x + ${dx}, y + ${k === 1 ? 0 : 0.03}, w * ${k}, h * ${k}, score, quality - 0.1, vec, model, person_id, status from faces where id = ${first.id}::uuid`);
    await copy(0.02, 0.5); await copy(0.5, 1); assert.equal((await rowsOf()).filter((r) => r.person === tidy.id).length, 3);
    assert.deepEqual(await tidyFaces(db, { items: [X] }), { same: 1, apart: 1, items: 1 });
    let now = await rowsOf(); assert.deepEqual(now.filter((r) => r.person === tidy.id).map((r) => r.id), [first.id], 'the first one keeps the name');
    const far = now.find((r) => r.x > first.x + 0.4); assert.deepEqual([far.status, far.person], ['also', null]); assert.equal(now.some((r) => r.w < first.w * 0.9), false, 'the part is gone');
    assert.equal((await db.execute(sql`select suggested_id as p from faces where id = ${far.id}::uuid`)).rows[0]!.p, tidy.id, 'who it is, is remembered');
    const waiting = async () => { const o = await over(); return [...o.singles, ...o.groups.flatMap((g: any) => g.faces)].map((f: any) => f.id); };
    assert.ok(!(await waiting()).includes(far.id), 'and it is not among the faces to name');
    assert.deepEqual(await tidyFaces(db, { items: [X] }), { same: 0, apart: 0, items: 0 }, 'a second run finds nothing');
    assert.equal((await facesOf(X)).filter((f) => f.person === tidy.id).length, 1);
    // naming a second face as someone already tagged in the picture: the tag stays where it was, the face is remembered
    // as them, the page is told, and nothing comes back to be named. Doing it again changes nothing.
    await db.execute(sql`update faces set status = 'unsorted', suggested_id = null where id = ${far.id}::uuid`);
    assert.ok((await waiting()).includes(far.id));
    for (const _ of [1, 2]) {
      const again = (await owner.post('/api/faces/name', { faceIds: [far.id], personId: tidy.id })).data; assert.deepEqual([again.also, again.name], [1, 'Tidy']);
      now = await rowsOf(); assert.deepEqual(now.filter((r) => r.person === tidy.id).map((r) => r.id), [first.id]); assert.equal(now.find((r) => r.id === far.id).status, 'also');
      assert.ok(!(await waiting()).includes(far.id) && !(await waiting()).includes(first.id), 'neither face bounces back');
    }
    // two faces of one picture named together: one tag
    const both = (await owner.post('/api/faces/name', { faceIds: [first.id, far.id], personId: tidy.id })).data; assert.equal(both.also, 1);
    assert.equal((await rowsOf()).filter((r) => r.person === tidy.id).length, 1); assert.equal((await facesOf(X)).filter((f) => f.id === far.id).length, 0, 'the viewer shows one chip');
    // a worker that hands in one face twice, whole and in part, has it stored once
    await owner.post('/api/admin/workers/redo', { task: 'faces' });
    const before = (await rowsOf()).length;
    queue[X] = [{ box: [0.05, 0.6, 0.2, 0.3], score: 0.9, quality: 0.8, vector: fv(9, 40) }, { box: [0.07, 0.65, 0.08, 0.2], score: 0.8, quality: 0.5, vector: fv(9, 41) }];
    await read();
    const added = (await rowsOf()).filter((r) => Math.abs(r.x - 0.05) < 0.03); assert.equal(added.length, 1); assert.ok(Math.abs(added[0].w - 0.2) < 0.001, 'the whole face is the one kept');
    assert.ok((await rowsOf()).length <= before + 1);
  });

  it('leaves people behind when a picture moves, and deletes everything when recognition is turned off', async () => {
    const left = (await over()).counts.faces; assert.ok(left > 0);
    const some = (await over()).singles[0] ?? (await over()).groups[0].faces[0];
    await owner.post('/api/faces/name', { faceIds: [some.id], name: 'Rosa' });
    // moved to a space where recognition is off: its face data goes
    const here = (await app.ctx.db.execute(sql`select count(*)::int as n from faces where item_id = ${some.item}::uuid`)).rows[0]!.n as number;
    await owner.post('/api/items/bulk', { ids: [some.item], action: 'move', spaceId: studio });
    assert.equal((await app.ctx.db.execute(sql`select count(*)::int as n from faces where item_id = ${some.item}::uuid`)).rows[0]!.n, 0);
    assert.equal((await over()).counts.faces, left - here);
    assert.equal((await over(owner, studio)).on, false);
    // off for the space: faces, names, answers and waiting work are all deleted, and the pictures are untouched
    const pictures = (await owner.get('/api/index')).data.items.length;
    assert.equal((await owner.post('/api/faces/settings', { space: life, on: false })).status, 200);
    const count = async (t: string) => (await app.ctx.db.execute(sql.raw(`select count(*)::int as n from ${t}`))).rows[0]!.n;
    assert.deepEqual([await count('faces'), await count('persons'), await count('face_rejections'), await count(`ai_tasks where task = 'faces'`)], [0, 0, 0, 0]);
    assert.equal((await owner.get('/api/index')).data.items.length, pictures);
    assert.deepEqual((await owner.get('/api/index')).data.persons, {});
    // on again, then off everywhere at once
    await owner.post('/api/faces/settings', { space: life, on: true }); await owner.post('/api/faces/settings', { space: studio, on: true });
    queue[ids['sideways.jpg']!] = [face(MARIA, 11)]; await read();
    assert.ok((await count('faces')) > 0);
    assert.equal((await editor.post('/api/faces/settings', { wipe: true })).status, 403);
    assert.equal((await owner.post('/api/faces/settings', { wipe: true })).status, 200);
    assert.deepEqual([await count('faces'), await count('persons'), await count(`ai_tasks where task = 'faces'`), await count(`settings where key = 'faces:auto'`)], [0, 0, 0, 0]);
    assert.deepEqual((await owner.get('/api/bootstrap')).data.spaces.map((s: any) => s.people), [false, false]);
  });
});

/** The groups of unnamed faces are kept in memory between questions, so naming one group does not mean grouping the rest again. */
describe('the groups of unnamed faces, kept between questions', () => {
  const mk = (id: string, who: number, shot: number, quality = 0.8): Face => { const v = new Float32Array(64); v[who] = 1; v[shot] = 0.2; return { id, item: 'item-' + id, v, person: null, status: 'unsorted', quality, model: 'm', suggested: null }; };
  const shape = (gs: { faces: Face[] }[]) => gs.map((g) => g.faces.map((f) => f.id).sort().join(' ')).sort();
  const NEAR = 0.45;

  it('gives the groups a fresh pass would, drops a named face, takes it back, and places a new face among its own', async () => {
    forgetGroups();
    let all = [mk('a1', 0, 10, 0.9), mk('a2', 0, 11), mk('a3', 0, 12), mk('b1', 1, 13), mk('b2', 1, 14), mk('c1', 2, 15)];
    let loads = 0; const ask = async () => shape((await groupsOf('space-1', async () => { loads++; return all; }, NEAR)).groups);
    assert.deepEqual(await ask(), ['a1 a2 a3', 'b1 b2', 'c1']);
    assert.deepEqual(await ask(), shape(cluster(all, NEAR)), 'the same groups as working them out from nothing');
    // a face a person named is no longer waiting: it leaves its group and the others stay where they were
    const named = (id: string) => { all = all.map((f) => (f.id === id ? { ...f, status: 'confirmed', person: 'p1' } : f)); };
    named('a1'); assert.deepEqual(await ask(), ['a2 a3', 'b1 b2', 'c1']);
    // the name is taken back: the face returns to the group it was in
    all = all.map((f) => (f.id === 'a1' ? { ...f, status: 'unsorted', person: null } : f)); assert.deepEqual(await ask(), ['a1 a2 a3', 'b1 b2', 'c1']);
    // a new picture is read: its face joins the people it looks like, and a stranger starts a group
    all = [...all, mk('b3', 1, 16), mk('d1', 3, 17)]; assert.deepEqual(await ask(), ['a1 a2 a3', 'b1 b2 b3', 'c1', 'd1']);
    // a whole group is named: it is gone, and a face of it that comes back later is placed afresh
    named('c1'); assert.deepEqual(await ask(), ['a1 a2 a3', 'b1 b2 b3', 'd1']);
    all = all.map((f) => (f.id === 'c1' ? { ...f, status: 'unsorted', person: null } : f)); assert.deepEqual(await ask(), ['a1 a2 a3', 'b1 b2 b3', 'c1', 'd1']);
    assert.equal(loads, 7, 'every question reads the faces as they are now');
  });

  it('starts again when a face it was made from is gone, keeps spaces apart, and answers two questions at once', async () => {
    forgetGroups();
    let all = [mk('a1', 0, 10, 0.9), mk('a2', 0, 11), mk('b1', 1, 13)];
    const ask = async (space = 'space-1', list = () => all) => shape((await groupsOf(space, async () => list(), NEAR)).groups);
    assert.deepEqual(await ask(), ['a1 a2', 'b1']);
    // a picture is deleted: nothing made from its face is kept, and the rest is grouped from nothing
    all = all.filter((f) => f.id !== 'a1'); assert.deepEqual(await ask(), ['a2', 'b1']);
    assert.deepEqual(await ask(), shape(cluster(all, NEAR)));
    // another space has its own faces and its own groups
    const theirs = [mk('z1', 0, 10), mk('z2', 0, 11)];
    assert.deepEqual(await ask('space-2', () => theirs), ['z1 z2']); assert.deepEqual(await ask(), ['a2', 'b1']);
    // two people open the page at the same moment
    const both = await Promise.all([ask(), ask()]); assert.deepEqual(both[0], both[1]); assert.deepEqual(both[0], ['a2', 'b1']);
    // a question that fails leaves nothing half made behind
    await assert.rejects(groupsOf('space-1', async () => { throw new Error('the database is away'); }, NEAR)); assert.deepEqual(await ask(), ['a2', 'b1']);
    // turned off: what was kept is thrown away
    forgetGroups('space-1'); all = []; assert.deepEqual(await ask(), []);
  });
});
