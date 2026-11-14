import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { emptyTrash } from '../src/server/trash.js';
import { Client, fixture, startApp } from './helpers.js';

/** The refinements made after Phase 2 (docs/prompts/01-refinements.md), group B: library housekeeping. */
describe('library housekeeping', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let owner: Client, viewer: Client, life: string;
  const item = async (id: string) => (await owner.get('/api/index')).data.items.find((i: any) => i.id === id);
  const placeName = async (id: string) => { const d = (await owner.get('/api/index')).data; const it = d.items.find((i: any) => i.id === id); return it.place ? d.places[it.place].name : null; };
  let gps: string, bare: string;

  before(async () => {
    app = await startApp('ai_test_refine');
    owner = new Client(app.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
    life = (await owner.get('/api/bootstrap')).data.spaces[0].id;
    // someone who may look but not change anything
    const inv = await owner.post('/api/people/invite', { who: 'maria@example.com', role: 'viewer', spaceIds: [life] });
    viewer = new Client(app.base);
    const token = new URL(inv.data.link).searchParams.get('invite');
    assert.equal((await viewer.post('/api/auth/accept-invite', { token, name: 'Maria', email: 'maria@example.com', password: 'a long enough password' })).status, 200);
    gps = (await owner.upload(fixture('seaside.jpg'), life)).data.id;
    bare = (await owner.upload(fixture('plain.png'), life)).data.id;
    await owner.settled();
  });
  after(async () => { await app.stop(); });

  it('records where a location came from', async () => {
    assert.equal((await item(gps)).locSrc, 'exif');
    assert.equal((await item(bare)).locSrc, null);
    assert.equal((await item(bare)).lat, null);
  });

  it('finds towns by name from its own list, for signed-in people only', async () => {
    const r = await owner.get('/api/places/search?q=' + encodeURIComponent('valencia'));
    assert.equal(r.status, 200);
    assert.ok(r.data.places.length > 1 && r.data.places.length <= 12);
    assert.ok(r.data.places.every((p: any) => /valencia/i.test(p.name) && Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.region));
    assert.ok(r.data.places[0].population >= r.data.places[1].population, 'the larger place comes first');
    assert.equal((await owner.get('/api/places/search?q=' + encodeURIComponent('Bogotá'))).data.places[0].name, 'Bogotá');
    assert.equal((await owner.get('/api/places/search?q=bogota')).data.places[0].name, 'Bogotá', 'accents are not needed');
    assert.deepEqual((await owner.get('/api/places/search?q=x')).data.places, []);
    assert.equal((await new Client(app.base).get('/api/places/search?q=tokyo')).status, 401);
  });

  it('sets a location on many items at once, leaving alone the ones that have one unless told otherwise', async () => {
    const tokyo = { lat: 35.6762, lng: 139.6503 };
    const some = await owner.post('/api/items/bulk', { ids: [gps, bare], action: 'locate', ...tokyo });
    assert.deepEqual([some.status, some.data.n], [200, 1], '"only the ones without a location" is the default');
    const b = await item(bare);
    assert.deepEqual([b.lat, b.lng, b.locSrc, await placeName(bare)], [tokyo.lat, tokyo.lng, 'manual', 'Tokyo']);
    const g = await item(gps);
    assert.deepEqual([g.locSrc, await placeName(gps)], ['exif', 'Valencia'], 'the camera\'s own location was not touched');

    const all = await owner.post('/api/items/bulk', { ids: [gps, bare], action: 'locate', lat: 40.4168, lng: -3.7038, only: 'all' });
    assert.equal(all.data.n, 2);
    assert.deepEqual([(await item(gps)).locSrc, await placeName(gps), await placeName(bare)], ['manual', 'Madrid', 'Madrid']);

    assert.equal((await owner.post('/api/items/bulk', { ids: [gps], action: 'locate' })).status, 400, 'a location needs coordinates');
    assert.equal((await owner.post('/api/items/bulk', { ids: [gps], action: 'locate', lat: 95, lng: 0 })).status, 400);
  });

  it('removes the location from a selection', async () => {
    const r = await owner.post('/api/items/bulk', { ids: [gps, bare], action: 'unlocate' });
    assert.equal(r.data.n, 2);
    const g = await item(gps);
    assert.deepEqual([g.lat, g.lng, g.place, g.locSrc], [null, null, null, null]);
    assert.equal((await owner.post('/api/items/bulk', { ids: [gps, bare], action: 'unlocate' })).data.n, 0);
  });

  it('marks a location set on one item as set by hand', async () => {
    assert.equal((await owner.json('PATCH', `/api/items/${gps}`, { lat: 39.4699, lng: -0.3763 })).status, 200);
    assert.deepEqual([(await item(gps)).locSrc, await placeName(gps)], ['manual', 'Valencia']);
    assert.equal((await owner.json('PATCH', `/api/items/${gps}`, { lat: 24.1 })).status, 400, 'half a location is refused');
    await owner.json('PATCH', `/api/items/${gps}`, { lat: null, lng: null });
    assert.equal((await item(gps)).locSrc, null);
  });

  it('refuses to set or remove a location for someone who may not tag', async () => {
    assert.equal((await viewer.post('/api/items/bulk', { ids: [bare], action: 'locate', lat: 1, lng: 1 })).status, 403);
    assert.equal((await viewer.post('/api/items/bulk', { ids: [bare], action: 'unlocate' })).status, 403);
    assert.equal((await item(bare)).lat, null);
  });

  it('records where a date came from, and can find the files whose date is not the camera\'s', async () => {
    assert.deepEqual([(await item(gps)).dateSrc, (await item(gps)).d], ['exif', '2026-08-14T17:42:10']);
    // plain.png has no date of its own: it took the file's last-modified time, in the uploader's time zone
    assert.deepEqual([(await item(bare)).dateSrc, (await item(bare)).d], ['file', '2024-01-02T05:00:00']);
  });

  it('shifts the dates of a selection by an amount, and the opposite shift undoes it exactly', async () => {
    const keysBefore = (await owner.get(`/api/items/${gps}`)).data.keys;
    const r = await owner.post('/api/items/bulk', { ids: [gps, bare], action: 'shiftdate', minutes: 7 * 60 + 5 });
    assert.deepEqual([r.status, r.data.n], [200, 2]);
    assert.deepEqual([(await item(gps)).d, (await item(bare)).d], ['2026-08-15T00:47:10', '2024-01-02T12:05:00'], 'wall-clock arithmetic, over midnight');
    assert.deepEqual([(await item(gps)).dateSrc, (await item(bare)).dateSrc], ['exif', 'file'], 'a corrected date keeps its source');
    assert.deepEqual((await owner.get(`/api/items/${gps}`)).data.keys, keysBefore, 'no file is moved');
    await owner.post('/api/items/bulk', { ids: [gps, bare], action: 'shiftdate', minutes: -(7 * 60 + 5) });
    assert.deepEqual([(await item(gps)).d, (await item(bare)).d], ['2026-08-14T17:42:10', '2024-01-02T05:00:00']);
    // a day is exactly a day on the clock, whatever the server's own time zone does
    await owner.post('/api/items/bulk', { ids: [gps], action: 'shiftdate', minutes: 1440 });
    assert.equal((await item(gps)).d, '2026-08-15T17:42:10');
    await owner.post('/api/items/bulk', { ids: [gps], action: 'shiftdate', minutes: -1440 });
    assert.equal((await owner.post('/api/items/bulk', { ids: [gps], action: 'shiftdate', minutes: 0 })).status, 400);
    assert.equal((await owner.post('/api/items/bulk', { ids: [gps], action: 'shiftdate', minutes: 1.5 })).status, 400);
    assert.equal((await viewer.post('/api/items/bulk', { ids: [gps], action: 'shiftdate', minutes: 60 })).status, 403);
    assert.equal((await item(gps)).d, '2026-08-14T17:42:10');
  });

  it('gives a selection one date, and marks it as set by hand', async () => {
    assert.equal((await viewer.post('/api/items/bulk', { ids: [bare], action: 'setdate', d: '1987-06-14T15:30' })).status, 403);
    assert.equal((await owner.post('/api/items/bulk', { ids: [bare], action: 'setdate', d: 'last summer' })).status, 400);
    assert.equal((await owner.post('/api/items/bulk', { ids: [bare], action: 'setdate' })).status, 400);
    const r = await owner.post('/api/items/bulk', { ids: [bare], action: 'setdate', d: '1987-06-14T15:30' });
    assert.deepEqual([r.status, r.data.n], [200, 1]);
    assert.deepEqual([(await item(bare)).d, (await item(bare)).dateSrc], ['1987-06-14T15:30:00', 'manual']);
    assert.equal((await item(gps)).dateSrc, 'exif');
    await owner.json('PATCH', `/api/items/${gps}`, { d: '2026-08-14T17:42:10' });
    assert.equal((await item(gps)).dateSrc, 'manual', 'a date typed in the viewer is set by hand too');
  });

  it('shows the owner what is in the trash, and nobody else', async () => {
    await owner.upload(fixture('clip.mp4'), life); await owner.settled(); // something else that stays in the library
    assert.equal((await owner.post('/api/items/bulk', { ids: [gps, bare], action: 'delete' })).data.n, 2);
    const t = (await owner.get('/api/trash')).data;
    assert.equal(t.days, 0);
    assert.deepEqual(t.items.map((i: any) => i.id).sort(), [gps, bare].sort());
    for (const i of t.items) assert.ok(i.w > 0 && i.h > 0 && i.bytes > 0 && i.deletedAt > Date.now() - 60000 && i.twin === false && i.palette.length, JSON.stringify(i));
    // the owner's trash view may show the small copies, and nothing else of a trashed item is served
    assert.deepEqual(await Promise.all(['thumb', 'display', 'full', 'orig'].map(async (k) => (await owner.raw('GET', `/api/files/${gps}/${k}`)).status)), [200, 200, 404, 404]);
    assert.deepEqual(await Promise.all(['thumb', 'display'].map(async (k) => (await viewer.raw('GET', `/api/files/${gps}/${k}`)).status)), [404, 404], 'someone who is not an owner cannot fetch a trashed picture');
    assert.equal((await new Client(app.base).raw('GET', `/api/files/${gps}/thumb`)).status, 401);
    assert.deepEqual([(await viewer.get('/api/trash')).status, (await viewer.post('/api/trash/restore', { ids: [gps] })).status, (await viewer.post('/api/trash/empty', { ids: [gps] })).status], [403, 403, 403]);
  });

  it('puts back or deletes for good only the items that were chosen', async () => {
    const back = await owner.post('/api/trash/restore', { ids: [gps] });
    assert.deepEqual([back.data.restored, back.data.skipped], [1, 0]);
    assert.ok(await item(gps), 'it is in the library again');
    assert.deepEqual((await owner.get('/api/trash')).data.items.map((i: any) => i.id), [bare]);
    // the same file is added again while its first copy waits in the trash: that one cannot come back, and the list says so
    const again = (await owner.upload(fixture('plain.png'), life)).data.id; await owner.settled();
    await owner.post('/api/items/bulk', { ids: [gps], action: 'delete' });
    assert.deepEqual((await owner.get('/api/trash')).data.items.map((i: any) => [i.id, i.twin]).sort(), [[bare, true], [gps, false]].sort(), 'only the one whose file is back is marked');
    await owner.post('/api/trash/restore', { ids: [gps] });
    assert.deepEqual((await owner.post('/api/trash/restore', { ids: [bare] })).data, { ok: true, restored: 0, skipped: 1 });
    const keys = (await app.pool.query('select orig_key, thumb_key from items where id = $1', [bare])).rows[0];
    const onDisk = (k: string) => fs.existsSync(path.join(app.dataDir, 'media', k));
    assert.ok(onDisk(keys.orig_key) && onDisk(keys.thumb_key));
    assert.equal((await owner.post('/api/trash/empty', { ids: [gps] })).data.n, 0, 'an item that is not in the trash is never deleted this way');
    const gone = await owner.post('/api/trash/empty', { ids: [bare] });
    assert.ok(gone.data.n === 1 && gone.data.bytes > 0);
    assert.ok(!onDisk(keys.orig_key) && !onDisk(keys.thumb_key), 'its files are removed');
    assert.deepEqual((await owner.get('/api/trash')).data.items, []);
    assert.ok(await item(gps) && await item(again), 'the library is untouched');
    bare = again;
  });

  it('removes what has been in the trash longer than TRASH_DAYS, and only that', async () => {
    assert.equal(loadConfig({ TRASH_DAYS: '30' }).TRASH_DAYS, 30);
    assert.equal(loadConfig({}).TRASH_DAYS, 0, 'never, unless it is set');
    const old = (await owner.upload(fixture('sideways.jpg'), life)).data.id; await owner.settled();
    await owner.post('/api/items/bulk', { ids: [old, bare], action: 'delete' });
    await app.pool.query(`update items set deleted_at = now() - interval '31 days' where id = $1`, [old]);
    const r = await emptyTrash(app.ctx, { before: new Date(Date.now() - 30 * 86400_000) });
    assert.equal(r.n, 1);
    assert.deepEqual((await owner.get('/api/trash')).data.items.map((i: any) => i.id), [bare], 'the one deleted today stays');
    await owner.post('/api/trash/restore');
    assert.equal((await owner.get('/api/admin/overview')).data.trash.days, 0);
  });

  it('sets a location on a few thousand items in one request', async () => {
    const N = 3000;
    await app.pool.query(
      `insert into items (space_id, file_name, sha256, taken_at, orig_key, status)
       select $1::uuid, 'scan-' || n || '.jpg', 'many-' || n, timestamp '2001-01-01' + n * interval '1 minute', 'originals/x/' || n, 'ready' from generate_series(1, $2::int) n`, [life, N]);
    const ids = (await app.pool.query(`select id from items where sha256 like 'many-%'`)).rows.map((r) => r.id as string);
    assert.equal(ids.length, N);
    const t0 = Date.now();
    const r = await owner.post('/api/items/bulk', { ids, action: 'locate', lat: 38.967, lng: -0.183 });
    assert.deepEqual([r.status, r.data.n], [200, N]);
    assert.ok(Date.now() - t0 < 10000, `it took ${Date.now() - t0} ms`);
    const { rows } = await app.pool.query(`select count(*)::int n, count(distinct place_id)::int places from items where sha256 like 'many-%' and location_source = 'manual' and lat = 38.967`);
    assert.deepEqual(rows[0], { n: N, places: 1 });
    await app.pool.query(`delete from items where sha256 like 'many-%'`);
  });
});
