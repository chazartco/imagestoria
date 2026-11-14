import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
// @ts-expect-error no types published
import S3rver from 's3rver';
import { Client, FakeWorker, fixture, startApp } from './helpers.js';

describe('S3-compatible storage (the DigitalOcean Spaces path)', () => {
  let s3: any, app: Awaited<ReturnType<typeof startApp>>, owner: Client, port: number;
  const dir = path.join(import.meta.dirname, 'tmp', 's3');
  before(async () => {
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    s3 = new S3rver({ port: 0, address: '127.0.0.1', silent: true, directory: dir, configureBuckets: [{ name: 'afterimage' }] });
    port = (await s3.run()).port;
    app = await startApp('ai_test_s3', { STORAGE_DRIVER: 's3', S3_ENDPOINT: `http://127.0.0.1:${port}`, S3_BUCKET: 'afterimage', S3_ACCESS_KEY_ID: 'S3RVER', S3_SECRET_ACCESS_KEY: 'S3RVER', S3_FORCE_PATH_STYLE: 'true', S3_PREFIX: 'library' });
    owner = new Client(app.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
  });
  after(async () => { await app.stop(); await s3.close(); });

  it('stores the original and both copies in the bucket, under the prefix', async () => {
    const life = (await owner.get('/api/bootstrap')).data.spaces[0].id;
    const up = await owner.upload(fixture('seaside.jpg'), life);
    assert.equal(up.status, 200, JSON.stringify(up.data));
    const it0 = (await owner.settled()).items[0];
    assert.equal(it0.status, 'ready', it0.error);
    const keys = (await owner.get(`/api/items/${it0.id}`)).data.keys;
    assert.match(keys.orig, /^originals\/2024\/01\/.+\/seaside\.jpg$/);
    const stored = fs.readdirSync(path.join(dir, 'afterimage'), { recursive: true }).map(String).filter((f) => f.includes('library'));
    assert.ok(stored.some((f) => f.includes('originals')) && stored.some((f) => f.includes('thumbs')) && stored.some((f) => f.includes('display')), stored.join('\n'));
  });

  it('hands the browser a signed link instead of streaming the file itself', async () => {
    const it0 = (await owner.get('/api/index')).data.items[0];
    const res = await owner.raw('GET', `/api/files/${it0.id}/thumb`);
    assert.equal(res.status, 302);
    const url = res.headers.get('location')!;
    assert.match(url, /X-Amz-Signature=/);
    const direct = await fetch(url);
    assert.equal(direct.status, 200);
    assert.equal(Buffer.from(await direct.arrayBuffer()).subarray(8, 12).toString(), 'WEBP');
  });

  it('can also stream through the app, which the editor needs for pixel access', async () => {
    const it0 = (await owner.get('/api/index')).data.items[0];
    const res = await owner.raw('GET', `/api/files/${it0.id}/display?proxy=1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/webp');
    const part = await owner.raw('GET', `/api/files/${it0.id}/orig?proxy=1`, { headers: { range: 'bytes=10-19' } });
    assert.equal(part.status, 206); assert.equal((await part.arrayBuffer()).byteLength, 10);
  });

  it('gives a worker signed links, so it fetches from the bucket and not through the app', async () => {
    const made = await owner.post('/api/admin/workers', { name: 'Tower' }), w = new FakeWorker(app.base, made.data.token);
    let got: any[] = [];
    for (const t0 = Date.now(); !got.length && Date.now() - t0 < 10000;) { got = (await w.claim()).data.items; if (!got.length) await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(got.length, 1);
    for (const kind of ['display', 'orig']) {
      assert.match(got[0].files[kind], /^http:\/\/127\.0\.0\.1:\d+\/afterimage\/library\/.*X-Amz-Signature=/, kind);
      // fetched with no token at all: the signature in the link is what opens it
      const direct = await fetch(got[0].files[kind]); assert.equal(direct.status, 200); assert.ok((await direct.arrayBuffer()).byteLength > 500);
    }
    assert.equal((await w.results([{ itemId: got[0].id, task: 'caption', model: { name: 'fake', version: '1' }, data: { caption: 'A bay.', scene: 'beach', objects: [] } }])).data.accepted, 1);
  });

  it('renders an edited copy from an original that lives in the bucket, and deletes from the bucket', async () => {
    const it0 = (await owner.get('/api/index')).data.items[0];
    const made = await owner.post(`/api/items/${it0.id}/copies`, { recipe: { adj: { contrast: 30 }, geo: { rot: 0, flipH: true, flipV: false, straighten: 5, crop: { x: 0, y: 0, w: 1, h: 1 } }, curve: [0, 0.25, 0.5, 0.75, 1] } });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    const copy = (await owner.settled(60000)).items.find((i: any) => i.id === made.data.id);
    assert.equal(copy.status, 'ready', copy.error);
    assert.ok(copy.w < 3000 && copy.w > 2500 && Math.abs(copy.w / copy.h - 1.5) < 0.01, `straightening trims the edges and keeps the shape (${copy.w}x${copy.h})`);
    await owner.post('/api/items/bulk', { ids: [it0.id, copy.id], action: 'delete' });
    await owner.post('/api/trash/empty');
    const left = fs.readdirSync(path.join(dir, 'afterimage'), { recursive: true }).map(String).filter((f) => /originals|thumbs|display/.test(f) && f.endsWith('._S3rver_object'));
    assert.equal(left.length, 0, left.join('\n'));
  });
});
