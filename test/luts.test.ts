import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { parseCube } from '../src/server/media/cube.js';
import { ADJ2, CURVE0, develop2 } from '../src/shared/develop.js';
import { Client, fixture, startApp } from './helpers.js';

/** The text of a .cube file of n points a side, made from a function of the color. */
export function cubeText(n: number, f: (r: number, g: number, b: number) => number[], head = '') {
  const rows: string[] = [];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) rows.push(f(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => v.toFixed(6)).join(' '));
  return `# made for a test\nTITLE "Test table"\n${head}LUT_3D_SIZE ${n}\n\n${rows.join('\n')}\n`;
}
const invert = (r: number, g: number, b: number) => [1 - r, 1 - g, 1 - b];

describe('.cube files', () => {
  it('are read into a table, red changing fastest', () => {
    const c = parseCube(cubeText(3, (r, g, b) => [r, g * 0.5, b * 0.25]));
    assert.equal(c.size, 3); assert.equal(c.title, 'Test table'); assert.equal(c.data.length, 81);
    assert.deepEqual([...c.data.slice(3, 6)].map((v) => +v.toFixed(3)), [0.5, 0, 0], 'the second color has only more red');
    assert.deepEqual([...c.data.slice(78, 81)].map((v) => +v.toFixed(3)), [1, 0.5, 0.25]);
    // Windows line ends, tabs and a wider range are all fine
    const wide = parseCube(cubeText(2, (r, g, b) => [r * 2, g * 2, b * 2], 'DOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n').replace(/\n/g, '\r\n').replace(/ /g, '\t'));
    assert.deepEqual([...wide.data.slice(21, 24)], [1, 1, 1]);
  });

  it('are refused with a sentence that says what is wrong', () => {
    const says = (text: string, re: RegExp) => assert.throws(() => parseCube(text), (e: Error) => { assert.match(e.message, re); assert.ok(!/undefined|NaN/.test(e.message)); return true; });
    says('', /empty/);
    says('just some words\n', /not part of a \.cube file/);
    says('0 0 0\n1 1 1\n', /no LUT_3D_SIZE line/);
    says('LUT_1D_SIZE 16\n0 0 0\n', /1D table/);
    says('LUT_3D_SIZE 99\n', /99 points a side. The largest this app takes is 65/);
    says('LUT_3D_SIZE two\n', /one whole number/);
    says(cubeText(3, invert).split('\n').slice(0, -5).join('\n'), /needs 27 colors, and it has 23/);
    says(cubeText(2, invert) + '0 0 0\n', /more colors than a table of 2 points a side holds/);
    says(cubeText(2, invert).replace('1.000000 1.000000 1.000000', '1.0 abc 1.0'), /Line \d+ should be a color: three numbers/);
    says(cubeText(2, invert).replace('1.000000 1.000000 1.000000', '1.0 1.0'), /three numbers/);
    says(cubeText(2, invert, 'DOMAIN_MIN 1 1 1\nDOMAIN_MAX 0 0 0\n'), /runs backward/);
    says('LUT_3D_SIZE 2\n0 0 0\n\u0000\u0001', /plain text/);
  });

  it('are applied between the points of the table without bending a straight table', () => {
    const one = (rgb: number[], lut: any, A: Record<string, number> = {}) => [...develop2({ src: new Uint8ClampedArray([...rgb, 255]), blur: new Uint8ClampedArray([...rgb, 255]), out: new Uint8ClampedArray(4), w: 1, h: 1 }, { ...ADJ2, ...A }, CURVE0, null, lut)].slice(0, 3);
    const table = (n: number, f: (r: number, g: number, b: number) => number[]) => { const c = parseCube(cubeText(n, f)); return { n: c.size, data: c.data }; };
    // a table that changes nothing changes nothing, at any size, for colors on and between its points
    for (const n of [2, 5, 17, 33]) for (const c of [[0, 0, 0], [255, 255, 255], [13, 200, 77], [250, 3, 128], [91, 92, 93], [200, 100, 50], [50, 100, 200], [100, 50, 200], [100, 200, 50], [200, 50, 100]]) assert.deepEqual(one(c, table(n, (r, g, b) => [r, g, b])), c, `size ${n}, color ${c}`);
    assert.deepEqual(one([10, 100, 250], table(9, invert)), [245, 155, 5]);
    assert.deepEqual(one([40, 80, 160], table(7, (r, g, b) => [b, r, g])), [160, 40, 80], 'the channels are not mixed up');
    // it comes after the sliders, and the intensity blends it like the rest
    assert.deepEqual(one([100, 100, 100], table(9, invert), { exposure: 50 }), [55, 55, 55]);
    assert.deepEqual(one([10, 100, 250], table(9, invert), { amount: 50 }), [128, 128, 128]);
  });
});

describe('looks of your own', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let owner: Client, viewer: Client, photo: string, tmp: string;
  const upload = async (who: Client, name: string, text: string | Buffer) => { const fd = new FormData(); fd.set('file', new Blob([text]), name); const r = await who.raw('POST', '/api/luts', { body: fd }); return { status: r.status, data: await r.json() as any }; };
  const geo = { rot: 0, flipH: false, flipV: false, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } }, flat = [0, 0.25, 0.5, 0.75, 1];
  const mean = async (id: string) => (await sharp(Buffer.from(await (await owner.raw('GET', `/api/files/${id}/orig`)).arrayBuffer())).removeAlpha().stats()).channels.map((c) => c.mean);

  before(async () => {
    app = await startApp('ai_test_luts'); tmp = path.join(app.dataDir, 'tmp'); fs.mkdirSync(tmp, { recursive: true });
    owner = new Client(app.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
    const life = (await owner.get('/api/bootstrap')).data.spaces[0].id;
    photo = (await owner.upload(fixture('seaside.jpg'), life)).data.id; await owner.settled();
    const inv = await owner.post('/api/people/invite', { who: 'maria@example.com', role: 'viewer', spaceIds: [life] });
    viewer = new Client(app.base);
    await viewer.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: 'Maria', email: 'maria@example.com', password: 'a long enough password' });
  });
  after(async () => { await app.stop(); });

  it('are loaded from .cube files, and nothing else', async () => {
    assert.equal((await new Client(app.base).get('/api/luts')).status, 401);
    assert.deepEqual((await owner.get('/api/luts')).data.luts, []);
    const up = await upload(owner, 'Upside_down.cube', cubeText(17, invert));
    assert.equal(up.status, 200, JSON.stringify(up.data)); assert.deepEqual([up.data.name, up.data.size], ['Upside down', 17]);
    assert.deepEqual((await owner.get('/api/luts')).data.luts.map((l: any) => l.name), ['Upside down']);
    // refused, each with its reason
    const no = async (name: string, text: string | Buffer, status: number, re: RegExp) => { const r = await upload(owner, name, text); assert.equal(r.status, status, JSON.stringify(r.data)); assert.match(r.data.error, re); };
    await no('look.txt', cubeText(2, invert), 415, /not a \.cube file/);
    await no('photo.cube', fs.readFileSync(fixture('seaside.jpg')), 415, /plain text|not part of a \.cube file/);
    await no('short.cube', cubeText(3, invert).split('\n').slice(0, -4).join('\n'), 415, /cut short/);
    await no('big.cube', 'LUT_3D_SIZE 128\n', 415, /largest this app takes is 65/);
    await no('again.cube', cubeText(17, invert), 409, /already here, as “Upside down”/);
    // someone who may not edit can use the list, and cannot change it
    assert.equal((await viewer.get('/api/luts')).data.luts.length, 1);
    assert.deepEqual([(await upload(viewer, 'mine.cube', cubeText(2, invert))).status, (await viewer.json('PATCH', `/api/luts/${up.data.id}`, { name: 'x' })).status, (await viewer.json('DELETE', `/api/luts/${up.data.id}`)).status], [403, 403, 403]);
    assert.equal((await owner.get('/api/luts')).data.luts.length, 1);
  });

  it('can be named, and hand their numbers to the editor', async () => {
    const id = (await owner.get('/api/luts')).data.luts[0].id;
    assert.equal((await owner.json('PATCH', `/api/luts/${id}`, { name: '  ' })).status, 400);
    assert.equal((await owner.json('PATCH', `/api/luts/${id}`, { name: 'Negative' })).data.name, 'Negative');
    const res = await owner.raw('GET', `/api/luts/${id}/data`), f = new Float32Array(await res.arrayBuffer());
    assert.equal(res.headers.get('x-lut-size'), '17'); assert.equal(f.length, 17 ** 3 * 3); assert.deepEqual([f[0], f[1], f[2], f[f.length - 1]], [1, 1, 1, 0]);
    assert.equal((await new Client(app.base).raw('GET', `/api/luts/${id}/data`)).status, 401);
  });

  it('render in a saved copy, with the sliders and the intensity, and the copy outlives the look', async () => {
    const id = (await owner.get('/api/luts')).data.luts[0].id;
    const post = (recipe: any) => owner.post(`/api/items/${photo}/copies`, { recipe });
    assert.equal((await post({ v: 2, adj: {}, geo, curve: flat, lut: '00000000-0000-4000-8000-000000000000' })).status, 400, 'a look that does not exist');
    assert.equal((await post({ adj: {}, geo, curve: flat, lut: id })).status, 400, 'a version 1 recipe has no such thing');
    const full = await post({ v: 2, adj: { amount: 100 }, geo, curve: flat, lut: id, look: 'Negative' }), half = await post({ v: 2, adj: { amount: 50 }, geo, curve: flat, lut: id });
    assert.equal(full.status, 200, JSON.stringify(full.data));
    const idx = await owner.settled(60000); for (const c of [full, half]) assert.equal(idx.items.find((i: any) => i.id === c.data.id).status, 'ready');
    const [a, b, c] = [await mean(photo), await mean(full.data.id), await mean(half.data.id)];
    a.forEach((v, i) => { assert.ok(Math.abs(b[i]! - (255 - v)) < 2, `the copy is the negative: ${a} to ${b}`); assert.ok(Math.abs(c[i]! - 127.5) < 2, `at half intensity it is flat gray: ${c}`); });
    // removing a look that copies use takes it off the list and keeps what the copies need
    const del = await owner.json('DELETE', `/api/luts/${id}`); assert.deepEqual([del.status, del.data.kept], [200, 2]);
    assert.deepEqual((await owner.get('/api/luts')).data.luts, []);
    assert.equal((await owner.raw('GET', `/api/luts/${id}/data`)).status, 200, 'the editor can still open the copy');
    assert.equal((await owner.json('DELETE', `/api/luts/${id}`)).status, 404); assert.equal((await owner.json('PATCH', `/api/luts/${id}`, { name: 'Back' })).status, 404);
    const again = await post({ v: 2, adj: { amount: 100, exposure: 10 }, geo, curve: flat, lut: id });
    assert.equal(again.status, 200); assert.equal((await owner.settled(60000)).items.find((i: any) => i.id === again.data.id).status, 'ready', 'and a copy of the copy can be made');
    // the same file can be loaded again, as a new look
    assert.equal((await upload(owner, 'Negative.cube', cubeText(17, invert))).status, 200);
  });

  it('are deleted outright when no copy uses them', async () => {
    const up = await upload(owner, 'swap.cube', cubeText(4, (r, g, b) => [b, r, g])), key = `luts/${up.data.id}.f32`, file = path.join(app.dataDir, 'media', key);
    assert.ok(fs.existsSync(file), 'its numbers are in storage');
    const del = await owner.json('DELETE', `/api/luts/${up.data.id}`); assert.equal(del.data.kept, 0);
    assert.ok(!fs.existsSync(file)); assert.equal((await owner.raw('GET', `/api/luts/${up.data.id}/data`)).status, 404);
  });
});
