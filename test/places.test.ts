import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { geocode, importPlaceNames, spotFor } from '../src/server/media/spots.js';
import { Client, FakeWorker, fixture, startApp } from './helpers.js';

/** Phase 3, stage 5: places finer than the town, and suggested locations for pictures that have none. */
describe('places beyond GPS', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let owner: Client, viewer: Client, life: string, w: FakeWorker;
  const ids: Record<string, string> = {};
  let lat = 0, lng = 0;
  const item = async (id: string, who = owner) => (await who.get('/api/index')).data.items.find((i: any) => i.id === id);
  const sugg = async (who = owner) => (await who.get(`/api/place-suggestions?space=${life}`)).data.suggestions as any[];
  /** A point so many metres north and east of the test picture. */
  const off = (north: number, east: number) => [lat + north / 111320, lng + east / (111320 * Math.cos(lat * Math.PI / 180))];
  /** One line of the GeoNames file: id, name, ascii name, other names, lat, lng, class, code, country. */
  const row = (id: number, name: string, cls: string, code: string, at: number[], alt = '') => [id, name, name, alt, at[0]!.toFixed(6), at[1]!.toFixed(6), cls, code, 'ES', '', '', '', '', '', '0', '', '', 'Europe/Madrid', '2024-01-01'].join('\t');
  const file = (name: string, lines: string[]) => { const p = path.join(app.dataDir, name); fs.writeFileSync(p, lines.join('\n') + '\n'); return p; };
  /** The same lines inside a zip, as GeoNames ships them: one deflated entry. */
  const zip = (name: string, lines: string[]) => {
    const body = zlib.deflateRawSync(Buffer.from(lines.join('\n') + '\n')), inner = Buffer.from('allCountries.txt'), head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(8, 8); head.writeUInt32LE(body.length, 18); head.writeUInt16LE(inner.length, 26);
    const p = path.join(app.dataDir, name); fs.writeFileSync(p, Buffer.concat([head, inner, body, Buffer.from('PK\x01\x02 the rest of a zip, which is not needed')])); return p;
  };

  before(async () => {
    app = await startApp('ai_test_places', { AI_TASKS: 'place', PLACE_NEARBY_MINUTES: '10' });
    owner = new Client(app.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
    life = (await owner.get('/api/bootstrap')).data.spaces[0].id;
    const inv = await owner.post('/api/people/invite', { who: 'vera@example.com', role: 'viewer', spaceIds: [life] }); viewer = new Client(app.base);
    await viewer.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: 'Vera', email: 'vera@example.com', password: 'a long enough password' });
    for (const f of ['seaside.jpg', 'plain.png', 'sideways.jpg', 'iphone.heic']) ids[f] = (await owner.upload(fixture(f), life)).data.id;
    await owner.settled(60000);
    const it0 = await item(ids['seaside.jpg']!); lat = it0.lat; lng = it0.lng; assert.ok(lat && lng, 'the test picture carries a location');
    w = new FakeWorker(app.base, (await owner.post('/api/admin/workers', { name: 'Tower' })).data.token);
  });
  after(async () => { await app.stop(); });

  it('names only the town until place data is loaded', async () => {
    const it0 = await item(ids['seaside.jpg']!); assert.deepEqual([it0.spot, it0.spotKind, typeof it0.place], [null, null, 'string']);
    assert.deepEqual(await owner.get('/api/admin/places').then((r) => [r.data.rows, r.data.at, r.data.busy]), [0, null, null]);
    assert.equal((await viewer.get('/api/admin/places')).status, 403);
    assert.equal(await spotFor(app.ctx, lat, lng), null);
  });

  it('loads place names from the GeoNames file, keeping only kinds of place worth naming a picture after', async () => {
    const lines = [
      row(1, 'Playa de la Malvarrosa', 'T', 'BCH', off(300, 0), 'Malvarrosa Beach,Malvarrosa,マルバロサ'), row(2, 'Parque Central', 'L', 'PRK', off(0, 100)),
      row(3, 'El Esterito', 'P', 'PPLX', off(-900, 0)), row(4, 'Rancho Viejo', 'S', 'FRM', off(10, 10)), row(5, 'Arroyo Seco', 'H', 'STM', off(5, 5)),
      row(6, 'Golfo de Valencia', 'H', 'BAY', off(1500, 0)), row(7, 'Faro Viejo', 'S', 'LTHSE', off(5000, 0)), row(8, 'Valencia', 'P', 'PPLC', off(0, 0)),
    ];
    const r = await importPlaceNames(app.ctx, file('places.txt', lines));
    assert.deepEqual([r.kept, r.seen, r.renamed], [5, 8, 1], 'the farm, the stream and the city itself are left out, and the located picture is named again');
    const rows = (await app.ctx.db.execute(sql`select id, name, kind, alt from place_names order by id`)).rows as any[];
    assert.deepEqual(rows.map((x) => [x.id, x.kind]), [[1, 'beach'], [2, 'park'], [3, 'neighborhood'], [6, 'water'], [7, 'landmark']]);
    assert.equal(rows[0].alt, '|playa de la malvarrosa|malvarrosa beach|malvarrosa|', 'other names in Latin letters are kept for looking a place up');
    // a beach 300 m away is tried before a park 100 m away: the order is landmark, beach, park, and each has its own reach
    assert.deepEqual(await spotFor(app.ctx, lat, lng), { name: 'Playa de la Malvarrosa', kind: 'beach', metres: 300 });
    const it0 = await item(ids['seaside.jpg']!); assert.deepEqual([it0.spot, it0.spotKind], ['Playa de la Malvarrosa', 'beach']);
    const st = (await owner.get('/api/admin/places')).data; assert.deepEqual([st.rows, typeof st.at, st.busy, st.error], [5, 'number', null, null]);
    // out of reach of the beach and the park, the neighbourhood is the finest name there is. Further still, the bay. Far away, nothing.
    assert.deepEqual((await spotFor(app.ctx, ...(off(-600, 0) as [number, number])))!.name, 'El Esterito');
    assert.deepEqual((await spotFor(app.ctx, ...(off(1900, 900) as [number, number])))!.name, 'Golfo de Valencia');
    assert.equal(await spotFor(app.ctx, ...(off(40000, 40000) as [number, number])), null);
  });

  it('reads the zip as GeoNames ships it, replaces the names in one go, and names the library again on request', async () => {
    const r = await importPlaceNames(app.ctx, zip('places.zip', [row(11, 'Paseo Marítimo', 'S', 'PIER', off(40, 0), 'Valencia Seafront'), row(12, 'Playa de la Malvarrosa', 'T', 'BCH', off(300, 0), 'Malvarrosa Beach')]));
    assert.deepEqual([r.kept, r.seen, r.renamed], [2, 2, 1]);
    assert.deepEqual(await item(ids['seaside.jpg']!).then((i) => [i.spot, i.spotKind]), ['Paseo Marítimo', 'landmark'], 'a landmark 40 m away now comes first');
    // a file that is not the list of places changes nothing
    await assert.rejects(importPlaceNames(app.ctx, file('junk.txt', ['hello', 'world'])), /No place names were found/);
    await assert.rejects(importPlaceNames(app.ctx, file('junk.zip', ['not a zip'])), /not a zip/);
    assert.equal((await owner.get('/api/admin/places')).data.rows, 2);
    assert.match((await owner.get('/api/admin/places')).data.error, /not a zip/);
    // moving a picture names it again at once, and taking its location away takes the name away
    const [a, b] = off(310, 0);
    await owner.json('PATCH', `/api/items/${ids['seaside.jpg']}`, { lat: a, lng: b });
    assert.deepEqual(await item(ids['seaside.jpg']!).then((i) => [i.spot, i.locSrc]), ['Playa de la Malvarrosa', 'manual']);
    await owner.post('/api/items/bulk', { ids: [ids['seaside.jpg']], action: 'unlocate' });
    assert.deepEqual(await item(ids['seaside.jpg']!).then((i) => [i.spot, i.spotKind, i.lat]), [null, null, null]);
    await owner.post('/api/items/bulk', { ids: [ids['seaside.jpg']], action: 'locate', lat, lng, only: 'all' });
    assert.equal((await item(ids['seaside.jpg']!)).spot, 'Paseo Marítimo');
    await app.ctx.db.execute(sql`update items set spot = 'Old name' where id = ${ids['seaside.jpg']}::uuid`);
    assert.equal((await viewer.post('/api/admin/places/rename')).status, 403);
    assert.deepEqual((await owner.post('/api/admin/places/rename')).data, { n: 1 });
    assert.equal((await item(ids['seaside.jpg']!)).spot, 'Paseo Marítimo');
  });

  it('turns a place someone named into a point, from the data held here', async () => {
    const near = (p: any, at: number[]) => p && Math.abs(p.lat - at[0]!) < 1e-4 && Math.abs(p.lng - at[1]!) < 1e-4;
    assert.ok(near(await geocode(app.ctx, 'Playa de la Malvarrosa, Valencia, Spain'), off(300, 0)));
    const other = await geocode(app.ctx, 'Malvarrosa Beach, Valencia'); assert.ok(near(other, off(300, 0)) && other!.exact, 'found under another name it goes by, near the Valencia this library has pictures of');
    // a place that is not in the data falls back to its town, and says it is only the town
    const town = await geocode(app.ctx, 'Hotel Central, Gandia, Spain'); assert.ok(town && !town.exact && Math.abs(town.lat - 38.97) < 0.2);
    assert.equal(await geocode(app.ctx, 'Xyzzy Plugh'), null);
  });

  it('suggests the location of a picture taken minutes away by the same camera, and never stores it until a person accepts', async () => {
    const [a, b, c] = [ids['plain.png']!, ids['sideways.jpg']!, ids['iphone.heic']!];
    // three pictures with no location: two from the same camera as the located one (2 and 30 minutes later), one from another camera
    await app.ctx.db.execute(sql`update items set lat = null, lng = null, place_id = null, spot = null, location_source = null where id in (${a}::uuid, ${b}::uuid, ${c}::uuid)`);
    await app.ctx.db.execute(sql`update items set camera = 'Fuji X100V', taken_at = '2024-05-01 10:00:00' where id = ${ids['seaside.jpg']}::uuid`);
    await app.ctx.db.execute(sql`update items set camera = 'Fuji X100V', taken_at = '2024-05-01 10:02:00' where id = ${a}::uuid`);
    await app.ctx.db.execute(sql`update items set camera = 'Fuji X100V', taken_at = '2024-05-01 10:30:00' where id = ${b}::uuid`);
    await app.ctx.db.execute(sql`update items set camera = 'iPhone 15', taken_at = '2024-05-01 10:01:00' where id = ${c}::uuid`);
    const s = await sugg();
    assert.deepEqual(s.map((x) => [x.item, x.source, x.name, x.from]), [[a, 'nearby', 'Paseo Marítimo', ids['seaside.jpg']]]);
    assert.ok(Math.abs(s[0].lat - lat) < 1e-9 && s[0].confidence > 0.8 && s[0].confidence < 0.9); assert.match(s[0].why, /The same camera took a picture there 2 minutes before or after\./);
    assert.deepEqual(await item(a).then((i) => [i.lat, i.locSrc]), [null, null], 'a suggestion is not a location');
    assert.equal((await sugg(viewer)).length, 1, 'anyone who can open the space sees it');
    assert.equal((await viewer.post('/api/place-suggestions/accept', { items: [{ id: a, source: 'nearby' }] })).status, 403, 'and only someone who may set locations accepts it');
    // accepted: the location is recorded as having come from a suggestion, and the place is named like any other
    const ok = await owner.post('/api/place-suggestions/accept', { items: [{ id: a, source: 'nearby' }, { id: c, source: 'nearby' }] });
    assert.deepEqual(ok.data, { ok: true, n: 1, skipped: [c] }, 'one that was never suggested is skipped, not invented');
    const got = await item(a); assert.deepEqual([got.lat, got.lng, got.locSrc, got.spot], [lat, lng, 'suggested', 'Paseo Marítimo']);
    assert.deepEqual(await sugg(), []);
    // an accepted suggestion is not passed on as if a camera had recorded it
    await app.ctx.db.execute(sql`update items set taken_at = '2024-05-01 10:04:00' where id = ${b}::uuid`);
    await app.ctx.db.execute(sql`update items set taken_at = '2024-05-01 09:00:00' where id = ${ids['seaside.jpg']}::uuid`);
    assert.deepEqual(await sugg(), [], 'the only located picture nearby in time got its place from a suggestion');
    await app.ctx.db.execute(sql`update items set taken_at = '2024-05-01 10:00:00' where id = ${ids['seaside.jpg']}::uuid`);
    assert.deepEqual((await sugg()).map((x) => x.item), [b]);
    // rejected: it is not suggested again
    assert.equal((await viewer.post('/api/place-suggestions/reject', { items: [{ id: b, source: 'nearby' }] })).status, 403);
    assert.equal((await owner.post('/api/place-suggestions/reject', { items: [{ id: b, source: 'nearby' }] })).status, 200);
    assert.deepEqual(await sugg(), []);
  });

  it('shows a place a vision model recognised as a suggestion, and keeps a no', async () => {
    const [b, c] = [ids['sideways.jpg']!, ids['iphone.heic']!];
    await owner.post('/api/admin/workers/redo', { task: 'place' });
    const got = (await w.claim(['place'], 8)).data.items;
    assert.deepEqual(got.map((g: any) => g.id).sort(), [b, c].sort(), 'only pictures with no location are asked about');
    const send = (id: string, data: unknown) => w.results([{ itemId: id, task: 'place', model: { name: 'fake-vision', version: '1' }, data }]);
    assert.equal((await send(b, { place: 'Malvarrosa Beach, Valencia, Spain', kind: 'beach', confidence: 0.82, why: 'The mushroom rock.' })).data.accepted, 1);
    assert.equal((await send(c, { place: 'A beach somewhere', kind: 'beach', confidence: 0.3, why: 'Sand.' })).data.accepted, 1);
    let s = await sugg();
    assert.deepEqual(s.map((x) => [x.item, x.source, x.name, x.confidence, x.why]), [[b, 'vision', 'Malvarrosa Beach, Valencia, Spain', 0.82, 'The mushroom rock.']], 'a guess the model is not sure of is not shown');
    assert.ok(Math.abs(s[0].lat - off(300, 0)[0]!) < 1e-4);
    // no: and reading the picture again does not bring the same guess back
    await owner.post('/api/place-suggestions/reject', { items: [{ id: b, source: 'vision' }] }); assert.deepEqual(await sugg(), []);
    await owner.post('/api/admin/workers/redo', { task: 'place' }); await w.claim(['place'], 8);
    await send(b, { place: 'malvarrosa beach, valencia, spain', kind: 'beach', confidence: 0.9, why: 'Again.' }); assert.deepEqual(await sugg(), []);
    // a different place for the same picture is a new suggestion. A place that is not on the map here is still shown, without a point.
    await owner.post('/api/admin/workers/redo', { task: 'place' }); await w.claim(['place'], 8);
    await send(b, { place: 'Paseo Marítimo, Valencia', kind: 'landmark', confidence: 0.7, why: 'The boardwalk.' });
    await send(c, { place: 'Xyzzy Plugh', kind: 'landmark', confidence: 0.9, why: 'A sign.' });
    s = await sugg(); assert.deepEqual(s.map((x) => [x.item, x.name, x.lat == null]).sort(), [[b, 'Paseo Marítimo, Valencia', false], [c, 'Xyzzy Plugh', true]].sort());
    const r = await owner.post('/api/place-suggestions/accept', { items: s.map((x) => ({ id: x.item, source: x.source })) });
    assert.deepEqual([r.data.n, r.data.skipped], [1, [c]], 'the one with no point cannot be accepted as it stands');
    const it1 = await item(b); assert.deepEqual([it1.locSrc, it1.spot, Math.abs(it1.lat - off(40, 0)[0]!) < 1e-4], ['suggested', 'Paseo Marítimo', true]);
    // a picture that has a location is not asked about, and a late answer for it changes nothing
    await owner.post('/api/admin/workers/redo', { task: 'place' });
    assert.deepEqual((await w.claim(['place'], 8)).data.items.map((g: any) => g.id), [c]);
    await owner.json('PATCH', `/api/items/${c}`, { lat, lng });
    assert.equal((await send(c, { place: 'Eiffel Tower, Paris', kind: 'landmark', confidence: 0.99, why: 'Iron.' })).data.accepted, 1);
    assert.deepEqual(await sugg(), []); assert.equal((await item(c)).locSrc, 'manual');
    assert.equal((await app.ctx.db.execute(sql`select count(*)::int as n from ai_tasks where task = 'place' and status = 'queued'`)).rows[0]!.n, 0);
  });
});
