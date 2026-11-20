/**
 * Browser test: drives the real page in headless Chrome against a real server and database.
 *
 *   npm i -D playwright            (once; it is not a dependency of the app)
 *   npm run test:e2e
 *
 * Settings: TEST_PG (Postgres address, as for npm test), CHROME (path to a Chrome or Chromium binary,
 * otherwise Playwright's own), PLAYWRIGHT (path to the module, when it is installed somewhere else),
 * E2E_SHOTS=1 (save screenshots to test/shots).
 */
import { developRecipe } from '../src/shared/develop.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error no types published
import S3rver from 's3rver';
import { FakeWorker, fixture, mockOidc, startApp } from './helpers.ts';
import { sql } from 'drizzle-orm';
import { importPlaceNames } from '../src/server/media/spots.ts';

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const here = import.meta.dirname;
const shots = path.join(here, 'shots');
const photos = path.join(here, 'tmp', 'photos');
const PASSWORD = 'correct horse battery';

execFileSync(process.execPath, ['scripts/build-web.mjs'], { cwd: path.join(here, '..'), stdio: 'inherit' });
fs.rmSync(photos, { recursive: true, force: true });
execFileSync(path.join(here, '..', 'node_modules', '.bin', 'tsx'), [path.join(here, 'make-photos.mts'), photos, '14'], { stdio: 'inherit' });
if (process.env.E2E_SHOTS) fs.mkdirSync(shots, { recursive: true });
// A map style with no outside addresses, so the map can finish loading without the internet.
const stylePath = path.join(here, '..', 'dist', 'web', 'assets', 'e2e-style.json');
fs.writeFileSync(stylePath, JSON.stringify({ version: 8, sources: { box: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-112, 22], [-108, 26]] } } } }, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#17181a' } }, { id: 'line', type: 'line', source: 'box', paint: { 'line-color': '#4d7dff' } }] }));

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results: [string, string | null][] = [];
const trouble: string[] = [];
let expectRefusals = false;

async function newPage(viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.addInitScript(`if (!window.__folded) try { localStorage.setItem('afterimage.facetsOpen', '["year","place","spot","person","scene","thing","color","tag","cam","series"]'); } catch (e) { }`);
  page.on('pageerror', (e: Error) => trouble.push('page error: ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error' && !/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|status of 40[13]/.test(m.text()) && !(expectRefusals && /status of 4[0-9][0-9]/.test(m.text()))) trouble.push('console: ' + m.text()); });
  page.on('response', (r: any) => { if (r.status() === 503) return; /* a page still open while its server is being stopped */ if (r.status() >= 500 || (r.status() >= 400 && !expectRefusals && !/\/api\/auth\/login/.test(r.url()))) trouble.push(`HTTP ${r.status()} ${r.url()}`); });
  return page;
}
// E2E_ONLY=looks runs the setup and upload steps and then only the steps with that word in their name.
// Later steps lean on what earlier ones left behind, so a step run this way can fail for that reason alone.
const only = (process.env.E2E_ONLY || '').toLowerCase(); let stepNo = 0;
async function step(name: string, fn: () => Promise<void>) {
  if (only && ++stepNo > 2 && !name.toLowerCase().includes(only)) return;
  const t0 = Date.now();
  try { await fn(); results.push([name, null]); console.log(`  ok  ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); }
  catch (e) { results.push([name, e instanceof Error ? e.message : String(e)]); console.log('  FAIL ' + name + '\n       ' + (e instanceof Error ? e.message.split('\n').slice(0, 12).join('\n       ') : e)); }
}
// People and settings is a board of cards. This opens the window behind one of them.
const card = async (p: any, key: string) => { await S(p, 'Admin.closeModal()'); await p.click(`#v-admin [data-card="${key}"]`); await p.waitForSelector(`#adModal[data-key="${key}"]`); };
const shot = async (page: any, name: string) => { if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(shots, name + '.png') }); };
// The page forbids eval, as it should. These helpers hand the browser a real function built from the expression,
// which the browser's debugging channel runs without going through the page's own script rules.
const inPage = (expr: string) => new Function('return (' + expr + ')') as () => unknown;
const S = (page: any, expr: string) => page.evaluate(inPage(expr));
const until = (page: any, expr: string, timeout = 30000) => page.waitForFunction(inPage(expr), null, { timeout }).catch((e: Error) => { throw new Error(`waited ${timeout} ms for: ${expr}. ${e.message.split(/\n/)[0]}`); });
/** Every modal closes from its top right corner: the X must sit within reach of that corner of its box. */
const closeIsTopRight = async (page: any, x: string, box: string) => {
  const [b, m] = [await page.locator(x).boundingBox(), await page.locator(box).boundingBox()];
  assert.ok(b && m, `${x} and ${box} are on screen`);
  const dx = m.x + m.width - (b.x + b.width), dy = b.y - m.y;
  assert.ok(dx >= 0 && dx <= 30 && dy >= 0 && dy <= 40, `${x} sits in the top right corner of ${box} (${Math.round(dx)} from the right, ${Math.round(dy)} from the top)`);
};
const settled = (page: any, n: number) => until(page, `S.items.length >= ${n} && S.items.every(i => i.status !== "processing")`, 90000);

/* ---------- 1. Local accounts, local disk: the whole journey ---------- */
console.log('Local sign-in, files on disk');
const app = await startApp('ai_e2e', { MAP_STYLE_DARK: '/assets/e2e-style.json', FACE_AUTO_MIN_CONFIRMED: '2', DUPLICATE_SIMILARITY: '0.95', SIMILAR_FLOOR: '0.6', SEARCH_MEANING_FLOOR: '0.05', SEARCH_MEANING_SPREAD: '0.05' });
const page = await newPage();
let inviteLink = '';

await step('first visit shows the setup screen, and setup opens an empty library with Life and Studio', async () => {
  await page.goto(app.base); await page.waitForSelector('#gateCard h1');
  assert.equal(await page.textContent('#gateCard h1'), 'Set up your library');
  assert.ok(!(await page.textContent('#gateCard')).includes('null'));
  await shot(page, '01-setup');
  await page.fill('#gateCard input[autocomplete=name]', 'Chaz'); await page.fill('#gateCard input[type=email]', 'owner@example.com'); await page.fill('#gateCard input[type=password]', PASSWORD);
  await page.click('#gateCard button[type=submit]'); await page.waitForSelector('#app:not([hidden])');
  assert.deepEqual(await page.$$eval('.spaces button', (b: any[]) => b.map((x) => x.textContent)), ['Life', 'Studio']);
  await page.waitForSelector('#emptyAdd:not([hidden])');
});

await step('uploads photos, an iPhone HEIC and a video through the page, and they all become viewable', async () => {
  await page.click('#btnUpload'); await page.waitForSelector('#upload:not([hidden])');
  await closeIsTopRight(page, '#upClose', '#upload .sheet-box');
  const files = fs.readdirSync(photos).map((f) => path.join(photos, f));
  // hold the uploads at the door, to see the list while it works
  const held: (() => void)[] = []; let seen = 0, holding = true; const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await page.route('**/api/upload', async (r: any) => { seen++; if (holding) await new Promise<void>((go) => held.push(go)); await r.continue(); });
  await page.setInputFiles('#upFiles', [...files, fixture('iphone.heic'), fixture('clip.mp4'), fixture('sideways.jpg'), fixture('plain.png')]);
  const order = () => page.evaluate(() => [...document.querySelectorAll('#upList .up-row')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((r) => (/Uploading|Storing/.test(r.querySelector('.up-st')!.textContent!) ? 'send' : /Waiting/.test(r.querySelector('.up-st')!.textContent!) ? 'wait' : 'done')));
  await until(page, 'document.querySelectorAll("#upList .up-row.run").length === 2'); while (seen < 2) await sleep(50);
  // the two that are travelling are on top, the rest wait under them, and a line says how far it is
  assert.deepEqual(await order(), ['send', 'send', ...Array(16).fill('wait')]);
  assert.equal(await page.textContent('#upProgress'), '0 of 18 files done. Sending 2 now.');
  assert.equal(await page.isVisible('#upload .up-steps'), false, 'the notes make room for the list while it works');
  // one arrives: it goes to the bottom, and the next one waiting takes its place on top
  held.shift()!(); await page.waitForSelector('#upList .up-row.done'); while (seen < 3) await sleep(50);
  await until(page, 'document.querySelectorAll("#upList .up-row.run:not(.done)").length === 2');
  assert.deepEqual(await order(), ['send', 'send', ...Array(15).fill('wait'), 'done']);
  assert.match((await page.textContent('#upProgress'))!, /^1 of 18 files done\./);
  holding = false; held.splice(0).forEach((go) => go());
  // when the last one is in, the sheet closes by itself and the list is cleared for next time
  await page.waitForSelector('#upload', { state: 'hidden' }); await page.unroute('**/api/upload');
  assert.equal(await page.locator('#upList .up-row').count(), 0);
  await page.waitForSelector('.toast:has-text("Added 18 files")');
  await settled(page, 18);
  assert.deepEqual(await S(page, 'S.items.filter(i => i.status !== "ready").map(i => i.fileName + ": " + i.error)'), []);
  assert.ok((await S(page, 'Object.values(PLACES).map(p => p.name)')).includes('Valencia'), 'GPS was turned into a place name');
  // the same files again are recognised and skipped
  await page.click('#btnUpload'); await page.setInputFiles('#upFiles', [files[0]!, fixture('iphone.heic')]);
  await page.waitForSelector('.toast:has-text("Those files are already in the library.")'); await page.waitForSelector('#upload', { state: 'hidden' });
  assert.equal(await S(page, 'S.items.length'), 18);
  // a file that fails keeps the sheet open, with the failed file above the finished one
  await page.route('**/api/upload', (r: any) => ((r.request().postDataBuffer() || Buffer.alloc(0)).includes('plain.png') ? r.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"This file could not be stored."}' }) : r.continue()));
  expectRefusals = true; await page.click('#btnUpload'); await page.setInputFiles('#upFiles', [files[0]!, fixture('plain.png')]);
  await page.waitForSelector('#upList .up-row.err'); await until(page, 'document.querySelectorAll("#upList .up-row.skip").length === 1');
  assert.equal(await page.textContent('#upProgress'), '1 file could not be added. The reason is next to each one.'); assert.equal(await page.isVisible('#upload'), true);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#upList .up-row')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((r) => r.querySelector('.up-st')!.textContent)), ['This file could not be stored.', 'Already in the library, skipped']);
  await page.waitForTimeout(100); expectRefusals = false; await page.unroute('**/api/upload'); await page.click('#upClose');
  // opening it again starts with an empty list
  await page.click('#btnUpload'); assert.equal(await page.locator('#upList .up-row').count(), 0); assert.equal(await page.isVisible('#upProgress'), false); await page.click('#upClose');
});

await step('stories are suggested from the days of a long run, and dragging a picture of the page is not an upload', async () => {
  // 120 pictures over four days in a row. One story holding nearly all of them does not hide the days. A story about one day hides that day.
  const got = await S(page, `(() => { const keep = [S.items, S.stories], day = 86400000, t0 = Date.UTC(2024, 4, 1, 12), base = S.items.find(i => i.space === S.space && i.status === 'ready' && !i.copyOf);
    S.items = Array.from({ length: 120 }, (_, k) => ({ ...base, id: 'x' + k, date: t0 + Math.floor(k / 30) * day + k * 60000 }));
    S.stories = [{ id: 's', space: S.space, ids: S.items.slice(0, 110).map(i => i.id) }]; const all = Stories.suggestions().map(g => g.items.length);
    S.stories = [{ id: 's', space: S.space, ids: S.items.slice(0, 30).map(i => i.id) }]; const one = Stories.suggestions().map(g => g.items.length);
    S.items = keep[0]; S.stories = keep[1]; return [all, one]; })()`);
  assert.deepEqual(got, [[30, 30, 30, 30], [30, 30, 30]]);
  // a picture dragged from the page carries a file with it. Dropping it on the page must not add it to the library.
  await page.waitForSelector('#grid .tile');
  await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'crop.webp', { type: 'image/webp' })); const t = document.querySelector('#grid .tile')!; t.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); for (const k of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(k, { bubbles: true, cancelable: true, dataTransfer: dt })); t.dispatchEvent(new DragEvent('dragend', { bubbles: true })); });
  await page.waitForTimeout(150); assert.ok(await page.isHidden('#upload') && await page.isHidden('#dropzone')); assert.equal(await S(page, '[Upload.queue.length, Upload.active, S.items.length].join()'), '0,0,18');
  // a file from outside still shows the drop zone
  await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.png', { type: 'image/png' })); document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt })); });
  assert.ok(await page.isVisible('#dropzone')); await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.png', { type: 'image/png' })); document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: dt })); }); assert.ok(await page.isHidden('#dropzone'));
});

await step('the grid never crops: every tile has its photo\'s own shape, and there is no "Load more" button', async () => {
  await page.selectOption('#selSort', 'new'); await page.waitForSelector('#grid .tile img.in');
  const off = await S(page, `[...document.querySelectorAll('#grid .tile')].map(t => { const it = S.byId.get(t.dataset.id), r = t.getBoundingClientRect(); return [it.fileName, r.width / r.height / it.ar]; }).filter(x => Math.abs(x[1] - 1) > 0.02)`);
  assert.deepEqual(off, []);
  assert.deepEqual(await page.evaluate(() => [...new Set([...document.querySelectorAll('img, video')].map((i) => getComputedStyle(i).objectFit))]), ['contain']);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => /load more/i.test(b.textContent || '')).length), 0);
  // the grid runs to the edge of the page, with its scrollbar there, and the pictures have the same margin on both sides
  const edge = await page.evaluate(() => { const sc = document.querySelector('#gridScroll')!, r = sc.getBoundingClientRect(), ts = [...document.querySelectorAll('#grid .tile')].map((t) => t.getBoundingClientRect()); return { gap: innerWidth - r.right, l: Math.min(...ts.map((t) => t.left)) - r.left, r: r.right - Math.max(...ts.map((t) => t.right)) }; });
  assert.equal(edge.gap, 0, 'nothing between the grid and the edge of the page'); assert.ok(Math.abs(edge.l - edge.r) <= 4, `the pictures are in the middle: ${edge.l} px on the left, ${edge.r} px on the right`);
  const heic = await S(page, 'S.items.find(i => i.fileName === "iphone.heic").id');
  assert.equal(await page.evaluate(async (id: string) => (await fetch(`/api/files/${id}/full`)).headers.get('content-type'), heic), 'image/webp', 'HEIC is shown through a full-size WebP');
  await shot(page, '02-grid');
});

await step('a sideways phone photo is shown upright, at its real shape', async () => {
  assert.deepEqual(await S(page, '(i => [i.w, i.h])(S.items.find(i => i.fileName === "sideways.jpg"))'), [1200, 1600]);
});

await step('the viewer saves a title, description, tag, comment and like, and they survive a reload', async () => {
  const id = await S(page, 'S.items.find(i => i.fileName === "IMG_1000.jpg").id');
  await S(page, `Viewer.open("${id}")`); await page.waitForSelector('#viewer:not([hidden])');
  await page.fill('.vi-title', 'Morning at the café'); await page.fill('.vi-desc', 'First light, nobody around.');
  await page.fill('.taginp', 'Sunrise'); await page.press('.taginp', 'Enter');
  await page.fill('.cmt-new textarea', 'Love this one.'); await page.click('.cmt-new button'); await page.waitForSelector('.cmt-t');
  await page.keyboard.press('f');
  const fr = await page.locator('#vwFrame').boundingBox();
  await page.mouse.move(fr.x + fr.width / 2, fr.y + fr.height / 2); await page.waitForSelector('#loupe.show');
  await shot(page, '03-viewer');
  await page.keyboard.press('Escape'); await page.waitForTimeout(900);
  // The browser keeps the list between visits. A reload asks only for what changed since, with the numbers that prove the list is whole.
  const asked: string[] = [], note = (r: any) => { if (r.url().includes('/api/index')) asked.push(new URL(r.url()).search); }; page.on('request', note);
  await page.reload(); await page.waitForSelector('#grid .tile');
  assert.deepEqual(await S(page, `(i => [i.title, i.desc, i.tags, i.nc, i.fav])(S.byId.get("${id}"))`), ['Morning at the café', 'First light, nobody around.', ['sunrise'], 1, true]);
  page.off('request', note);
  assert.ok(asked.length > 0 && asked.every((q) => /[?&]since=\d+/.test(q)) && /check=1/.test(asked[0]!), `the reload asked only for what changed: ${JSON.stringify(asked)}`);
  await until(page, 'Kept.read(S.me.id).then(r => !!r && r.rows.length === S.items.length && r.meta.at === Sync.at)', 5000);
  // a list that has drifted is noticed: with one row quietly missing from what the browser kept, the next visit loads everything again
  const lost = await S(page, `S.items.find(i => i.id !== "${id}" && i.kind === "photo").id`), order = await S(page, 'S.items.map(i => i.id).join()');
  await S(page, `Kept.tx('readwrite', items => { items.delete("${lost}"); })`);
  asked.length = 0; page.on('request', note);
  await page.reload(); await page.waitForSelector('#grid .tile'); page.off('request', note);
  assert.equal(await S(page, `S.byId.has("${lost}")`), true); assert.ok(asked.some((q) => q === ''), `everything was loaded again: ${JSON.stringify(asked)}`);
  // and the next visit starts from the kept list again, in the order the server gives it
  await until(page, 'Kept.read(S.me.id).then(r => !!r && r.rows.length === S.items.length && r.meta.at === Sync.at)', 5000);
  asked.length = 0; page.on('request', note);
  await page.reload(); await page.waitForSelector('#grid .tile'); page.off('request', note);
  assert.ok(asked.every((q) => /[?&]since=\d+/.test(q)), JSON.stringify(asked)); assert.equal(await S(page, 'S.items.map(i => i.id).join()'), order);
});

await step('the viewer is a modal at 90% of the screen, zooms into the original in place, and folds its details away', async () => {
  const id = await S(page, 'S.items.find(i => i.fileName === "IMG_1000.jpg").id');
  await S(page, `Viewer.open("${id}")`); await page.waitForSelector('#viewer:not([hidden])');
  const box = await page.locator('#vwBox').boundingBox();
  assert.deepEqual([Math.round(box.width), Math.round(box.height), Math.round(box.x), Math.round(box.y)], [1296, 810, 72, 45], 'the modal is 90% of a 1440 by 900 screen, centered');
  assert.equal(await page.$('#zoom'), null, 'there is no second overlay');
  await closeIsTopRight(page, '#vwClose', '#vwBox');
  await shot(page, '03b-modal');
  // Z zooms into the original inside the frame, Esc once comes back to the fitted picture
  await page.keyboard.press('z'); await page.waitForSelector('#vwZoom:not([hidden])');
  await page.waitForFunction(() => /\/full$/.test((document.querySelector('#zmImg') as HTMLImageElement).src) && (document.querySelector('#zmLoad') as HTMLElement).hidden);
  assert.match(await page.textContent('#zmInfo'), /1,600 × 1,067, 100%/);
  const zr = await page.locator('#vwZoom').boundingBox();
  assert.ok(zr.x >= box.x - 1 && zr.y >= box.y - 1 && zr.x + zr.width <= box.x + box.width + 1 && zr.y + zr.height <= box.y + box.height + 1, 'the zoomed picture stays inside the modal');
  await shot(page, '03c-zoomed');
  await page.click('#vwZoom [data-z=in]'); assert.match(await page.textContent('#zmInfo'), /140%/);
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(() => [(document.querySelector('#vwZoom') as HTMLElement).hidden, (document.querySelector('#viewer') as HTMLElement).hidden]), [true, false], 'Esc once leaves the zoom, not the viewer');
  // a click on the picture zooms, a second click comes back, without moving the pointer in between
  const fr = await page.locator('#vwFrame').boundingBox(), cx = fr.x + fr.width / 2, cy = fr.y + fr.height / 2;
  await page.mouse.click(cx, cy); await page.waitForSelector('#vwZoom:not([hidden])');
  await page.mouse.click(cx, cy); await page.waitForSelector('#vwZoom', { state: 'hidden' });
  await page.mouse.click(cx, cy); await page.waitForSelector('#vwZoom:not([hidden])');
  // dragging moves the picture and does not count as a click
  const x0 = await S(page, 'Zoom.x'); await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 60, cy + 20, { steps: 4 }); await page.mouse.up();
  assert.equal(await S(page, 'Zoom.x') - x0, 60); assert.equal(await page.evaluate(() => (document.querySelector('#vwZoom') as HTMLElement).hidden), false);
  await page.mouse.wheel(0, 3000); await until(page, 'Zoom.s === Zoom.fit', 5000); // the wheel never shrinks it below the fitted size
  // arrows still step, and stepping leaves the zoom
  const [fwd, back] = await S(page, 'Viewer.idx < Viewer.list.length - 1') ? ['ArrowRight', 'ArrowLeft'] : ['ArrowLeft', 'ArrowRight'];
  await page.keyboard.press(fwd); assert.equal(await page.evaluate(() => (document.querySelector('#vwZoom') as HTMLElement).hidden), true, 'stepping leaves the zoom');
  assert.notEqual(await S(page, 'Viewer.item.id'), id); await page.keyboard.press(back); assert.equal(await S(page, 'Viewer.item.id'), id);
  // the details fold away, the picture gets the room, and the choice is remembered
  const w0 = (await page.locator('#vwFrame').boundingBox()).width;
  await page.click('#vwFold'); assert.equal(await page.isVisible('#vwInfo'), false); await shot(page, '03d-folded');
  await closeIsTopRight(page, '#vwClose', '#vwBox');
  assert.ok(await page.evaluate(() => { const x = document.querySelector('#vwClose')!.getBoundingClientRect(); return [...document.querySelectorAll('.vw-top button')].every((b) => b.getBoundingClientRect().right <= x.left); }), 'no other button sits under the X');
  assert.ok((await page.locator('#vwFrame').boundingBox()).width > w0 + 300);
  await page.keyboard.press('Escape'); await page.waitForSelector('#viewer', { state: 'hidden' });
  await S(page, `Viewer.open("${id}")`); assert.equal(await page.isVisible('#vwInfo'), false, 'still folded when opened again');
  await page.click('#vwFold'); assert.equal(await page.isVisible('#vwInfo'), true, 'unfolded again'); await page.waitForSelector('.vi-title');
  // the dimmed library around the modal closes it
  await page.mouse.click(20, 20); await page.waitForSelector('#viewer', { state: 'hidden' });
});

await step('a video plays when opened, Space pauses it, the volume is remembered, and leaving stops it', async () => {
  const vid = await S(page, 'S.items.find(i => i.kind === "video").id'), other = await S(page, 'S.items.find(i => i.fileName === "IMG_1000.jpg").id');
  const open = () => S(page, `Viewer.open("${vid}", [S.byId.get("${vid}"), S.byId.get("${other}")])`);
  const state = () => page.evaluate(() => { const v = document.querySelector('#vwVideo') as HTMLVideoElement; return { paused: v.paused, muted: v.muted, src: v.getAttribute('src'), unmute: !(document.querySelector('#vwUnmute') as HTMLElement).hidden }; });
  await open(); await page.waitForFunction(() => { const v = document.querySelector('#vwVideo') as HTMLVideoElement; return !v.paused && v.currentTime > 0; });
  // the player asks for the "play" kind: the copy made for browsers when there is one, the original when there is not
  assert.match((await state()).src ?? '', /\/api\/files\/[0-9a-f-]+\/play$/); assert.equal(await page.isVisible('#vwPlayNote'), false);
  // while a copy is still being made the viewer says so and offers the original
  await page.evaluate(() => { const w = window as any; w.eval('Viewer.item.play = "making"; Viewer.playNote(Viewer.item, true)'); });
  assert.match(await page.textContent('#vwPlayNote') ?? '', /A copy that plays in every browser is being made/); assert.ok(await page.isVisible('#vwPlayNote button:has-text("Download the original")'));
  await page.evaluate(() => { const w = window as any; w.eval('Viewer.item.play = "none"; Viewer.playNote(Viewer.item, true)'); }); assert.equal(await page.isVisible('#vwPlayNote'), false);
  assert.deepEqual([(await state()).muted, (await state()).unmute], [false, false], 'it plays with sound');
  await page.keyboard.press(' '); assert.equal((await state()).paused, true);
  await page.keyboard.press(' '); await page.waitForFunction(() => !(document.querySelector('#vwVideo') as HTMLVideoElement).paused);
  await page.evaluate(() => { (document.querySelector('#vwVideo') as HTMLVideoElement).volume = 0.4; }); await until(page, 'localStorage.getItem("afterimage.volume") === "0.4"');
  await page.keyboard.press('ArrowRight'); assert.deepEqual(await state(), { paused: true, muted: false, src: null, unmute: false }, 'stepping away stops it');
  await page.keyboard.press('ArrowLeft'); await page.waitForFunction(() => !(document.querySelector('#vwVideo') as HTMLVideoElement).paused);
  assert.equal(await page.evaluate(() => (document.querySelector('#vwVideo') as HTMLVideoElement).volume), 0.4, 'the last volume is used again');
  await page.keyboard.press('Escape'); assert.deepEqual([(await state()).paused, (await state()).src], [true, null], 'closing stops it');
  // a browser that refuses sound: it starts silent and offers the sound
  await page.evaluate(() => { const P = HTMLMediaElement.prototype as any; P._play = P.play; P.play = function () { return this.muted ? P._play.call(this) : Promise.reject(new DOMException('refused', 'NotAllowedError')); }; });
  await open(); await page.waitForSelector('#vwUnmute:not([hidden])'); await page.waitForFunction(() => !(document.querySelector('#vwVideo') as HTMLVideoElement).paused);
  assert.equal((await state()).muted, true); assert.equal(await page.evaluate(() => localStorage.getItem('afterimage.muted')), '0', 'a forced silence is not remembered as a choice');
  await page.click('#vwUnmute'); assert.deepEqual([(await state()).muted, (await state()).unmute], [false, false]);
  await page.evaluate(() => { const P = HTMLMediaElement.prototype as any; P.play = P._play; delete P._play; });
  await page.keyboard.press('Escape'); await page.waitForSelector('#viewer', { state: 'hidden' });
});

await step('a location is set for a whole selection from one dialog: search, coordinates, known places and the map', async () => {
  await S(page, 'Lib.toggle("flag", "noloc")'); const n = await S(page, 'Lib.list.length'); assert.ok(n >= 3, 'some test files carry no location');
  await page.evaluate(() => (document.activeElement as HTMLElement).blur()); await page.keyboard.press('Control+a');
  await page.click('#bulk [data-bulk=location]'); await page.waitForSelector('.loc-box');
  await closeIsTopRight(page, '#locClose', '.loc-box');
  assert.equal(await page.isDisabled('#locApply'), true, 'nothing to apply until a place is chosen');
  assert.equal(await page.$('#locScope'), null, 'no question about existing locations when none of the selection has one');
  // search runs on the server's own list of towns
  await page.fill('#locSearch', 'gandia'); await page.waitForSelector('.loc-hit'); await page.click('.loc-hit >> nth=0');
  assert.equal(await page.isDisabled('#locApply'), false); assert.match(await page.textContent('#locStatus'), /Gandia/);
  // a place the library already has
  await page.click('#locKnown .chip >> nth=0'); const known = await S(page, 'LocDialog.pt.label'); assert.ok(known && !/^-?\d/.test(known));
  // a click on the map drops the pin
  await until(page, 'LocDialog.map && LocDialog.map.loaded()', 20000);
  const mb = await page.locator('#locMap').boundingBox(); const before = await S(page, 'LocDialog.pt.lat');
  await page.mouse.click(mb.x + mb.width / 2 + 60, mb.y + mb.height / 2 + 50); await until(page, `LocDialog.pt.lat !== ${before}`, 5000);
  assert.equal(await page.inputValue('#locCoords'), await S(page, 'LocDialog.coords(LocDialog.pt.lat, LocDialog.pt.lng)'));
  assert.equal(await page.locator('#locMap .maplibregl-marker').count(), 1, 'one pin');
  await shot(page, '03e-location');
  // typed coordinates, then apply to the whole selection in one request
  await page.fill('#locCoords', 'nowhere'); await page.press('#locCoords', 'Enter'); await page.waitForSelector('.toast:has-text("latitude")');
  await page.fill('#locCoords', '39.4699, -0.3763'); await page.press('#locCoords', 'Enter');
  const sent: string[] = []; const spy = (r: any) => { if (r.url().endsWith('/api/items/bulk')) sent.push(r.postData()); }; page.on('request', spy);
  await page.click('#locApply'); await page.waitForSelector('.loc-box', { state: 'detached' });
  await until(page, `S.items.filter(i => i.locSrc === "manual" && i.place && PLACES[i.place].name === "Valencia").length === ${n}`);
  page.off('request', spy); assert.equal(sent.length, 1, 'one request for the whole selection');
  assert.match(await page.textContent('#libCount'), /^0 of/, 'nothing is left without a location');
  await S(page, 'Lib.clear()');
  // a selection that already has locations: it says how many, and offers "only the ones without" or "all"
  await page.keyboard.press('Control+a'); await page.click('#bulk [data-bulk=location]'); await page.waitForSelector('#locScope');
  assert.match(await page.textContent('#locScope'), /18 items of these already have a location/);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#locScope input')].map((i: any) => [i.value, i.checked, i.disabled])), [['missing', false, true], ['all', true, false]]);
  assert.match(await page.textContent('#locRecent'), /Valencia/, 'the last location used is offered at the top');
  await page.keyboard.press('Escape'); await page.waitForSelector('.loc-box', { state: 'detached' }); await page.keyboard.press('Escape');
  // the viewer uses the same dialog for one item, and can remove the location after a confirmation
  const one = await S(page, 'S.items.find(i => i.locSrc === "manual").id');
  await S(page, `Viewer.open("${one}")`); await page.click('#viLocate'); await page.waitForSelector('.loc-box');
  assert.equal(await page.isDisabled('#locApply'), true, 'the pin starts on the item, with nothing to save yet');
  await page.click('#locRemove'); await page.click('#locRemoveYes'); await until(page, `S.byId.get("${one}").lat === null`);
  await page.waitForSelector('#viLocate:has-text("Set location")');
  await page.click('#viLocate'); await page.click('#locRecent .chip >> nth=0'); await page.click('#locApply');
  await until(page, `S.byId.get("${one}").lat === 39.4699`); await page.waitForSelector('.vi-row:has-text("set by hand")');
  await page.keyboard.press('Escape'); await page.waitForSelector('#viewer', { state: 'hidden' });
});

await step('the date of a selection is shifted with an example and an undo, or set to one date after a confirmation', async () => {
  await S(page, 'Lib.toggle("flag", "filedate")'); assert.ok(await S(page, 'Lib.list.length') >= 1, 'a file with no date of its own is found by the quick filter');
  await S(page, 'Lib.clear()'); const n = await S(page, 'Lib.list.length');
  await page.evaluate(() => (document.activeElement as HTMLElement).blur()); await page.keyboard.press('Control+a');
  const dates = () => S(page, 'Lib.selected().map(i => i.date).sort()'); const before = await dates();
  const onServer = () => page.evaluate(async () => { const r = await (await fetch('/api/index')).json(); return r.items.map((i: any) => i.d).sort(); });
  const server0 = await onServer();
  await page.click('#bulk [data-bulk=date]'); await page.waitForSelector('.dt-box'); await closeIsTopRight(page, '#dtClose', '.dt-box');
  assert.equal(await page.isDisabled('#dtApply'), true, 'nothing to apply until an amount is given');
  await page.fill('#dtHours', '7'); await page.fill('#dtMins', '5');
  const ex = await page.textContent('#dtExample'); assert.match(ex, /^.+ was .+ at \d+:\d\d [ap]m and becomes .+ at \d+:\d\d [ap]m\.$/);
  assert.equal(ex, await S(page, '(s => `${s.title || s.fileName} was ${DateDialog.say(s.date)} and becomes ${DateDialog.say(DateDialog.shifted(s.date, 425))}.`)(DateDialog.items.reduce((a, b) => b.date < a.date ? b : a))'));
  await shot(page, '03f-date');
  await page.click('#dtApply'); await page.waitForSelector(`.toast:has-text("Moved ${n} items 7 hours and 5 minutes later")`);
  assert.deepEqual(await dates(), before.map((t: number) => t + 425 * 60000));
  assert.notDeepEqual(await onServer(), server0, 'the server moved them too');
  await page.click('.toast .linkbtn:has-text("Undo")'); await page.waitForSelector('.toast:has-text("back where they were")');
  assert.deepEqual(await dates(), before); assert.deepEqual(await onServer(), server0, 'undo is exact');
  // one date for all of them: asks first, because their own dates are replaced
  await S(page, 'S.sel.clear(), S.items.filter(i => i.dateSrc === "file" || i.kind === "video").forEach(i => S.sel.add(i.id)), Bus.emit("sel")');
  const m = await S(page, 'S.sel.size'); assert.ok(m >= 2);
  await page.click('#bulk [data-bulk=date]'); await page.click('.dt-seg [data-m=set]'); await page.fill('#dtWhen', '1987-06-14T15:30');
  assert.match(await page.textContent('#dtExample'), /becomes June 14, 1987 at 3:30 pm\.$/);
  await page.click('#dtApply'); await page.waitForSelector('#dtYes'); assert.equal(new Set(await dates()).size > 1, true, 'nothing changes before the confirmation');
  await page.click('#dtYes'); await page.waitForSelector('.dt-box', { state: 'detached' });
  await until(page, `S.items.filter(i => i.dateSrc === "manual" && new Date(i.date).getFullYear() === 1987).length === ${m}`);
  await page.keyboard.press('Escape'); await S(page, 'Lib.toggle("flag", "filedate")');
  assert.match(await page.textContent('#libCount'), /^0 of/, 'none of them count as "date not from the camera" any more');
  await S(page, 'Lib.clear()');
});

await step('search and filters narrow the grid instantly', async () => {
  await page.fill('#lensInput', 'cafe'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  assert.match(await page.textContent('#libCount'), /^1 of 18/);
  await S(page, 'Lib.clear()');
  await S(page, 'Lib.toggle("flag", "video")'); assert.match(await page.textContent('#libCount'), /^1 of 18/);
  await S(page, 'Lib.clear()');
});

await step('editing saves a new copy rendered by the server, and the original is untouched', async () => {
  const id = await S(page, 'S.items.find(i => i.fileName === "IMG_1000.jpg").id');
  const before = await page.evaluate(async (id: string) => { const b = await (await fetch(`/api/files/${id}/orig?proxy=1`)).arrayBuffer(); return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].join(); }, id);
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await S(page, `Viewer.open("${id}")`); await page.waitForSelector('#viewer:not([hidden])'); await page.keyboard.press('e');
  await page.waitForSelector('#edAdjust input[data-k=saturation]'); await page.waitForSelector('#edBusy', { state: 'hidden' });
  // the editor is a modal of the same size and place as the viewer
  const [eb, vb] = [await page.locator('#edBox').boundingBox(), await page.locator('#vwBox').boundingBox()];
  assert.deepEqual([eb.x, eb.y, eb.width, eb.height], [vb.x, vb.y, vb.width, vb.height]);
  await closeIsTopRight(page, '#edCancel', '#edBox');
  await page.evaluate(() => { for (const [k, v] of [['saturation', -100], ['contrast', 40]] as const) { const i = document.querySelector(`#edAdjust input[data-k=${k}]`) as HTMLInputElement; i.value = String(v); i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); } });
  // the magnifier shows the edited result, cut from the full-size file
  const spread = () => page.evaluate(() => { const c = document.querySelector('#edLoupe') as HTMLCanvasElement, d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; let m = 0, seen = 0; for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue; seen++; m = Math.max(m, Math.max(d[i]!, d[i + 1]!, d[i + 2]!) - Math.min(d[i]!, d[i + 1]!, d[i + 2]!)); } return seen ? m : -1; });
  const cb = await page.locator('#edCanvas').boundingBox(), mx = cb.x + cb.width * 0.3, my = cb.y + cb.height * 0.3;
  await page.mouse.move(mx, my); await page.waitForSelector('#edLoupe.show'); await until(page, 'Editor.loupeDetail === "full"');
  assert.match(await S(page, 'Editor.full.src'), /\/full\?proxy=1$/);
  const gray = await spread(); assert.ok(gray >= 0 && gray < 4, 'the magnifier shows the black and white result, spread ' + gray);
  await page.keyboard.down('b'); assert.ok(await spread() > 40, 'holding B shows the untouched patch in the magnifier'); await page.keyboard.up('b'); assert.ok(await spread() < 4);
  await shot(page, '04b-magnifier');
  const m0 = await S(page, 'Editor.mag'); await page.mouse.wheel(0, -300); assert.ok(await S(page, 'Editor.mag') > m0, 'the wheel changes its strength');
  await page.click('#edLoupeBtn'); await page.mouse.move(mx + 5, my); assert.equal(await page.isVisible('#edLoupe'), false, 'the button turns it off');
  await page.click('#edLoupeBtn'); await page.mouse.move(mx, my); await page.waitForSelector('#edLoupe.show');
  // holding the Before button brings the magnifier back where it was, untouched
  const bb = await page.locator('#edBefore').boundingBox(); await page.mouse.move(bb.x + 10, bb.y + 10); assert.equal(await page.isVisible('#edLoupe'), false);
  await page.mouse.down(); assert.equal(await page.isVisible('#edLoupe'), true); assert.ok(await spread() > 40); await page.mouse.up(); assert.equal(await page.isVisible('#edLoupe'), false);
  await page.click('.ed-tabs [data-tab=crop]');
  // it is off while the crop frame is being dragged
  await page.mouse.move(mx, my); await page.waitForSelector('#edLoupe.show'); await page.mouse.down(); await page.mouse.move(mx + 30, my + 10, { steps: 3 }); assert.equal(await page.isVisible('#edLoupe'), false); await page.mouse.up();
  await page.mouse.move(mx, my); await page.waitForSelector('#edLoupe.show');
  await page.click('#edAspects .chip:has-text("1:1")');
  assert.equal(await page.textContent('#cropSize'), '1067 × 1067');
  await shot(page, '04-editor');
  await page.click('#edSave');
  await until(page, 'S.items.some(i => i.copyOf && i.status === "ready")', 40000);
  const copy = await S(page, '(c => ({ w: c.w, h: c.h, file: c.fileName, palette: c.palette, of: c.copyOf }))(S.items.find(i => i.copyOf))');
  assert.deepEqual([copy.w, copy.h, copy.file, copy.of], [1067, 1067, 'IMG_1000-edit.jpg', id]);
  assert.ok(copy.palette.every((c: string) => { const n = parseInt(c.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; return Math.max(r, g, b) - Math.min(r, g, b) < 12; }), 'the saved copy is black and white: ' + copy.palette);
  const after = await page.evaluate(async (id: string) => { const b = await (await fetch(`/api/files/${id}/orig?proxy=1`)).arrayBuffer(); return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].join(); }, id);
  assert.equal(after, before, 'original bytes are identical after the edit');
  await until(page, 'Viewer.item && !!Viewer.item.copyOf');
  await page.keyboard.press('Escape');
});

await step('the editor grades: channel curves, a color mixer, three-way grading, matte and intensity, and the page develops exactly as the server does', async () => {
  const id = await S(page, 'S.items.find(i => i.fileName === "IMG_1001.jpg").id');
  await S(page, `Viewer.open("${id}")`); await page.waitForSelector('#viewer:not([hidden])'); await page.keyboard.press('e');
  await page.waitForSelector('#edAdjust input[data-k=matte]'); await page.waitForSelector('#edBusy', { state: 'hidden' });
  const set = (k: string, v: number) => page.evaluate(([k, v]: [string, number]) => { const i = document.querySelector(`#edAdjust input[data-k=${k}]`) as HTMLInputElement; i.value = String(v); i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); }, [k, v] as [string, number]);
  const mean = () => page.evaluate(() => { const c = document.querySelector('#edCanvas') as HTMLCanvasElement, d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; const m = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) { m[0] += d[i]!; m[1] += d[i + 1]!; m[2] += d[i + 2]!; } return m.map((v) => v / (d.length / 4)); });
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const plain = await mean();
  // every new control has a slider in the Adjust tab
  for (const k of ['amount', 'mdHue', 'mdAmt', 'balance', 'matte', 'mxH0', 'mxS0', 'mxL0']) assert.ok(await page.$(`#edAdjust input[data-k=${k}]`), 'a slider for ' + k);
  // the mixer: eight ranges, three sliders for the chosen one, and a mark on a range that has been changed
  assert.equal(await page.locator('#edMix .mixdot').count(), 8);
  await page.click('#edMix .mixdot[title=Blue]'); assert.ok(await page.$('#edAdjust input[data-k=mxS5]')); assert.equal(await page.$('#edAdjust input[data-k=mxS0]'), null);
  await set('mxS5', -80); assert.equal(await page.locator('#edMix .mixdot.set').count(), 1); assert.equal(await S(page, 'Editor.adj.mxS5'), -80);
  // the curve has four channels, and a point dragged on Red moves only red
  await page.click('#edCurveCh .chip:has-text("Red")');
  const cv = await page.locator('#edCurve').boundingBox(); await page.locator('#edCurve').scrollIntoViewIfNeeded(); const c2 = await page.locator('#edCurve').boundingBox();
  await page.mouse.move(c2.x + c2.width / 2, c2.y + c2.height / 2); await page.mouse.down(); await page.mouse.move(c2.x + c2.width / 2, c2.y + c2.height * 0.25, { steps: 4 }); await page.mouse.up(); void cv;
  assert.ok(await S(page, 'Editor.curves.r[2]') > 0.65, 'the red curve moved'); assert.deepEqual(await S(page, '[Editor.curve[2], Editor.curves.g[2]]'), [0.5, 0.5]);
  await settle(); const red = await mean(); assert.ok(red[0]! > plain[0]! + 12, `the preview is redder: ${plain} to ${red}`);
  // intensity blends all of it back toward the untouched picture
  await set('matte', 60); await set('mdAmt', 40); await set('amount', 50); await settle(); const half = await mean();
  await set('amount', 0); await settle(); const none = await mean();
  none.forEach((v, i) => assert.ok(Math.abs(v - plain[i]!) < 0.5, 'at no intensity the picture is untouched'));
  assert.ok(half[0]! > plain[0]! + 4 && half[0]! < red[0]! + 20);
  assert.deepEqual(await S(page, '[Editor.recipe().v, Object.keys(Editor.recipe().curves).join("")]'), [2, 'rgb']);
  // undo takes back the channel curve too
  await set('amount', 100); await shot(page, '04c-grading');
  // the same code on both sides: a fixed picture and recipe, developed in the page and in this process
  const recipe = { v: 2, adj: { exposure: 8, contrast: 14, shadows: 20, vibrance: 20, clarity: 15, shHue: 200, shAmt: 30, mdHue: 30, mdAmt: 25, hlHue: 45, hlAmt: 20, balance: -20, matte: 35, fade: 6, vignette: 30, grain: 10, amount: 85, mxH1: 30, mxS3: -45, mxL5: -30, mxH5: -40, mxS7: 25 }, curve: [0.01, 0.22, 0.5, 0.8, 0.99], curves: { r: [0, 0.27, 0.52, 0.76, 1], g: [0, 0.25, 0.5, 0.75, 1], b: [0.04, 0.26, 0.48, 0.72, 0.96] } };
  const here = (() => { const w = 160, h = 120, src = new Uint8ClampedArray(w * h * 4), blur = new Uint8ClampedArray(w * h * 4); for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) { src[i] = (x * 255) / w; src[i + 1] = (y * 255) / h; src[i + 2] = ((x * 7 + y * 13) % 256); src[i + 3] = 255; blur[i] = (src[i]! + 128) >> 1; blur[i + 1] = (src[i + 1]! + 128) >> 1; blur[i + 2] = (src[i + 2]! + 128) >> 1; blur[i + 3] = 255; } return [...developRecipe({ src, blur, out: new Uint8ClampedArray(src.length), w, h }, recipe, null)]; })();
  const there: number[] = await page.evaluate((recipe: any) => { const w = 160, h = 120, src = new Uint8ClampedArray(w * h * 4), blur = new Uint8ClampedArray(w * h * 4); for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) { src[i] = (x * 255) / w; src[i + 1] = (y * 255) / h; src[i + 2] = ((x * 7 + y * 13) % 256); src[i + 3] = 255; blur[i] = (src[i]! + 128) >> 1; blur[i + 1] = (src[i + 1]! + 128) >> 1; blur[i + 2] = (src[i + 2]! + 128) >> 1; blur[i + 3] = 255; } return [...(window as any).developRecipe({ src, blur, out: new Uint8ClampedArray(src.length), w, h }, recipe, null)]; }, recipe);
  assert.equal(there.length, here.length); let worst = 0, changed = 0; for (let i = 0; i < here.length; i++) { worst = Math.max(worst, Math.abs(here[i]! - there[i]!)); }
  for (let i = 0; i < here.length; i += 4) if (Math.abs(here[i]! - (i / 4 % 160) * 255 / 160) > 6) changed++;
  assert.ok(worst <= 1, 'the page and the server develop the same pixels, worst difference ' + worst); assert.ok(changed > 5000, 'and the recipe really did something');
  await page.click('#edCancel'); await page.keyboard.press('Escape');
});

await step('the Looks tab has folding groups, a search box, favorites, recently used looks, an intensity slider, and shows a look when the pointer rests on it', async () => {
  const id = await S(page, 'S.items.find(i => i.fileName === "IMG_1001.jpg").id');
  await S(page, `Viewer.open("${id}")`); await page.waitForSelector('#viewer:not([hidden])'); await page.keyboard.press('e');
  await page.waitForSelector('#edAdjust input[data-k=matte]'); await page.waitForSelector('#edBusy', { state: 'hidden' });
  await page.click('.ed-tabs [data-tab=looks]'); await page.waitForSelector('#edLooks .look-head');
  // every group starts closed, and with no favorites yet nothing is open
  assert.deepEqual(await page.$$eval('#edLooks .look-head', (h: HTMLElement[]) => [...new Set(h.map((x) => x.getAttribute('aria-expanded')))]), ['false']);
  assert.equal(await page.locator('#edLooks .look:visible').count(), 0);
  await page.click('#edLooks .look-group[data-g="Cinematic"] .look-head'); await page.waitForSelector('#edLooks .look[data-look="Big screen"]');
  const total = await page.locator('#edLooks .look').count();
  assert.ok(total >= 60 && total <= 80, 'looks: ' + total);
  assert.deepEqual(await page.$$eval('#edLooks .look-group', (g: HTMLElement[]) => g.length), 11);
  assert.equal(await page.textContent('#edLooks .look-group .look-head span:nth-child(2)'), 'Cinematic');
  // only the previews on screen are drawn
  await until(page, 'document.querySelectorAll("#edLooks canvas[data-drawn]").length > 0');
  const drawn = await page.locator('#edLooks canvas[data-drawn]').count(); assert.ok(drawn < total / 2, `${drawn} of ${total} previews drawn before any scrolling`);
  // a preview has the shape of the picture, so nothing is cut off
  const [cw, ch, ar] = await S(page, '(c => [c.width, c.height, Editor.work.width / Editor.work.height])(document.querySelector("#edLooks canvas"))'); assert.ok(Math.abs(cw / ch - ar) < 0.02);
  const mean = () => page.evaluate(() => { const c = document.querySelector('#edCanvas') as HTMLCanvasElement, d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; const m = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) { m[0] += d[i]!; m[1] += d[i + 1]!; m[2] += d[i + 2]!; } return m.map((v) => v / (d.length / 4)); });
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const differs = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
  const plain = await mean();
  // resting the pointer on a look shows it on the main picture and chooses nothing
  await page.hover('#edLooks .look[data-look="Big screen"] .look-pick'); await settle(); const hovered = await mean();
  assert.ok(differs(hovered, plain) > 3, `the picture shows the look: ${plain} to ${hovered}`); assert.equal(await S(page, 'Editor.look'), 'Original'); assert.equal(await S(page, 'Editor.adj.contrast'), 0);
  await page.hover('#edLookFind'); await settle(); assert.ok(differs(await mean(), plain) < 0.5, 'and it goes back when the pointer leaves');
  // choosing one
  await page.click('#edLooks .look[data-look="Big screen"] .look-pick'); await settle();
  assert.equal(await S(page, 'Editor.look'), 'Big screen'); assert.ok(await page.$('#edLooks .look.on[data-look="Big screen"]')); assert.ok(differs(await mean(), hovered) < 0.5, 'what the pointer showed is what you get');
  // intensity
  await page.evaluate(() => { const i = document.querySelector('#edLookAmt') as HTMLInputElement; i.value = '50'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); }); await settle();
  const half = await mean(); assert.equal(await S(page, 'Editor.adj.amount'), 50); assert.equal(await S(page, 'Editor.look'), 'Big screen', 'still the same look');
  half.forEach((v, i) => assert.ok(Math.abs(v - (plain[i]! + hovered[i]!) / 2) < 1.5, 'half the look'));
  assert.equal(await page.inputValue('#edAdjust input[data-k=amount]'), '50', 'the Adjust tab has the same slider');
  // a group folds, and stays folded
  await page.click('#edLooks .look-group[data-g="Cinematic"] .look-head'); assert.equal(await page.isVisible('#edLooks .look[data-look="Big screen"]'), false);
  // favorites and recently used go to the top
  await page.click('#edLooks .look-group[data-g="Moody"] .look-head'); await page.click('#edLooks .look[data-look="Slate"] .look-fav');
  assert.deepEqual(await page.$$eval('#edLooks .look-group', (g: HTMLElement[]) => g.slice(0, 3).map((x) => x.dataset.g)), ['fav', 'recent', 'Cinematic']);
  assert.deepEqual(await page.$$eval('#edLooks .look-group[data-g=fav] .look', (l: HTMLElement[]) => l.map((x) => x.dataset.look)), ['Slate']);
  assert.deepEqual(await page.$$eval('#edLooks .look-group[data-g=recent] .look', (l: HTMLElement[]) => l.map((x) => x.dataset.look)), ['Big screen']);
  assert.equal(await page.isVisible('#edLooks .look-group[data-g="Cinematic"] .looks'), false, 'Cinematic is still folded');
  // leaving the tab and coming back closes everything but Favorites
  await page.click('.ed-tabs [data-tab=adjust]'); await page.click('.ed-tabs [data-tab=looks]'); await page.waitForSelector('#edLooks .look-group[data-g=fav] .look');
  assert.deepEqual(await page.$$eval('#edLooks .look-head[aria-expanded=true]', (h: HTMLElement[]) => h.map((x) => (x.parentNode as HTMLElement).dataset.g)), ['fav']);
  assert.deepEqual(await page.$$eval('#edLooks .look', (l: HTMLElement[]) => l.filter((x) => x.offsetParent).map((x) => x.dataset.look)), ['Slate'], 'only the favorite shows');
  // search by the name of a look or of a group
  await page.fill('#edLookFind', 'slate'); assert.deepEqual(await page.$$eval('#edLooks .look', (l: HTMLElement[]) => l.map((x) => x.dataset.look)), ['Slate']);
  await page.fill('#edLookFind', 'black and'); assert.deepEqual(await page.$$eval('#edLooks .look-group', (g: HTMLElement[]) => g.map((x) => x.dataset.g)), ['Black and white']);
  await page.fill('#edLookFind', 'zzz'); assert.match(await page.textContent('#edLookList'), /No look is called/);
  await page.fill('#edLookFind', ''); await shot(page, '04d-looks');
  await page.click('#edLooks .look-none'); assert.equal(await S(page, 'Editor.look'), 'Original'); await settle(); assert.ok(differs(await mean(), plain) < 0.5);
  await page.click('#edLooks .look-group[data-g="Cinematic"] .look-head'); await page.click('#edLooks .look[data-look="Slate"] .look-fav');
  await page.click('#edCancel'); await page.keyboard.press('Escape');
});

await step('a .cube file becomes a look of your own: it previews, takes the sliders and the intensity, and can be renamed and removed', async () => {
  const id = await S(page, 'S.items.find(i => i.fileName === "IMG_1001.jpg").id');
  await S(page, `Viewer.open("${id}")`); await page.waitForSelector('#viewer:not([hidden])'); await page.keyboard.press('e');
  await page.waitForSelector('#edAdjust input[data-k=matte]'); await page.waitForSelector('#edBusy', { state: 'hidden' });
  await page.click('.ed-tabs [data-tab=looks]'); await page.waitForSelector('#edLooks .look-add');
  const mean = () => page.evaluate(() => { const c = document.querySelector('#edCanvas') as HTMLCanvasElement, d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; const m = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) { m[0] += d[i]!; m[1] += d[i + 1]!; m[2] += d[i + 2]!; } return m.map((v) => v / (d.length / 4)); });
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const plain = await mean();
  // a file that is not a table is refused with its reason
  expectRefusals = true; await page.setInputFiles('#edCubeFile', { name: 'broken.cube', mimeType: 'text/plain', buffer: Buffer.from('LUT_3D_SIZE 3\n0 0 0\n1 1 1\n') });
  await page.waitForSelector('.toast:has-text("cut short")'); await page.waitForTimeout(100); expectRefusals = false; assert.equal(await page.locator('#edLooks .look.mine').count(), 0);
  // a negative: every color turned over, so it is easy to tell it was applied
  const n = 9, rows: string[] = []; for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) rows.push([1 - r / (n - 1), 1 - g / (n - 1), 1 - b / (n - 1)].join(' '));
  await page.setInputFiles('#edCubeFile', { name: 'My_negative.cube', mimeType: 'text/plain', buffer: Buffer.from(`LUT_3D_SIZE ${n}\n${rows.join('\n')}\n`) });
  await page.waitForSelector('#edLooks .look-group[data-g=mine] .look.mine'); assert.equal(await page.inputValue('#edLooks .look.mine .look-rename'), 'My negative');
  await page.locator('#edLooks .look.mine').scrollIntoViewIfNeeded(); await until(page, '!!document.querySelector("#edLooks .look.mine canvas[data-drawn]")');
  await page.click('#edLooks .look.mine .look-pick'); await until(page, '!!Editor.lut'); await settle();
  const neg = await mean(); neg.forEach((v, i) => assert.ok(Math.abs(v - (255 - plain[i]!)) < 1.5, `the preview is the negative: ${plain} to ${neg}`));
  assert.deepEqual(await S(page, '[Editor.look, Editor.recipe().lut === Editor.myLuts[0].id, Editor.recipe().v]'), ['My negative', true, 2]); assert.ok(await page.$('#edLooks .look.mine.on'));
  // the intensity and the sliders work on top of it
  await page.evaluate(() => { const i = document.querySelector('#edLookAmt') as HTMLInputElement; i.value = '50'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); }); await settle();
  (await mean()).forEach((v) => assert.ok(Math.abs(v - 127.5) < 1.5, 'half a negative is flat gray'));
  assert.ok(await S(page, '!!Editor.lut && Editor.look === "My negative"'), 'moving a slider does not drop the table');
  // undo and redo carry it
  await page.click('#edUndo'); await page.click('#edUndo'); assert.equal(await S(page, 'Editor.lut'), null); await page.click('#edRedo'); assert.ok(await S(page, '!!Editor.lut'));
  // choosing one of the built-in looks lets go of it
  await page.click('#edLooks .look-group[data-g="Moody"] .look-head'); await page.click(`#edLooks .look-group[data-g="Moody"] .look[data-look="Slate"] .look-pick`); assert.equal(await S(page, 'Editor.lut'), null); assert.equal(await S(page, 'Editor.recipe().lut'), undefined);
  // a look of your own can be a favorite: it then also stands in the Favorites group at the top, and stays there after the name changes
  await page.click('#edLooks .look-group[data-g=mine] .look.mine .look-fav');
  assert.deepEqual(await page.$$eval('#edLooks .look-group[data-g=fav] .look', (l: HTMLElement[]) => l.map((x) => x.dataset.look)), ['My negative']);
  assert.equal(await page.locator('#edLooks .look.mine .look-fav.on').count(), 2, 'starred in both places');
  await page.click('#edLooks .look-group[data-g=fav] .look.mine .look-pick'); await until(page, '!!Editor.lut'); assert.equal(await S(page, 'Editor.look'), 'My negative'); await page.click(`#edLooks .look-group[data-g="Moody"] .look[data-look="Slate"] .look-pick`);
  await page.locator('#edLooks .look-group[data-g=mine] .look.mine').scrollIntoViewIfNeeded();
  // rename in place, then remove
  await page.fill('#edLooks .look-group[data-g=mine] .look-rename', 'Turned over'); await page.locator('#edLooks .look-group[data-g=mine] .look-rename').blur();
  await until(page, 'Editor.myLuts[0].name === "Turned over"'); assert.deepEqual(await page.$$eval('#edLooks .look-group[data-g=fav] .look', (l: HTMLElement[]) => l.map((x) => x.dataset.look)), ['Turned over']);
  await page.fill('#edLookFind', 'turned'); assert.equal(await page.locator('#edLooks .look').count(), 1); await page.fill('#edLookFind', '');
  await shot(page, '04e-my-looks');
  await page.click('#edLooks .look-group[data-g=mine] .look-remove'); await until(page, 'Editor.myLuts.length === 0'); assert.equal(await page.locator('#edLooks .look.mine').count(), 0);
  assert.equal(await page.locator('#edLooks .look-group[data-g=fav]').count(), 0, 'and it leaves the favorites with it');
  assert.deepEqual(await page.evaluate(async () => (await (await fetch('/api/luts')).json()).luts), []);
  await page.click('#edCancel'); await page.keyboard.press('Escape');
});

await step('the map draws pins with thumbnail bundles, and the map library runs under the page\'s security policy', async () => {
  await page.click('.views [data-view=map]');
  await until(page, 'MapView.eng && MapView.eng.map.loaded()', 20000);
  await page.waitForSelector('.mk .mk-th img.in');
  assert.ok((await page.$$eval('.mk', (m: any[]) => m.length)) >= 1);
  assert.match(await page.textContent('#mapCount'), /items? in this part of the map/);
  assert.ok(await S(page, 'MapView.eng.map.queryRenderedFeatures({ layers: ["line"] }).length') > 0, 'vector data went through the map worker');
  await shot(page, '05-map');
  await page.click('#mapToLib'); assert.match(await page.textContent('#libCount'), /of 19/);
  await S(page, 'Lib.clear()');
});

await step('selecting several photos allows tagging and making a story, which can be written and played', async () => {
  await page.hover('#grid .tile >> nth=3'); await page.click('#grid .tile >> nth=3 >> .tick');
  await page.keyboard.down('Shift'); await page.click('#grid .tile >> nth=8 >> .tick', { force: true }); await page.keyboard.up('Shift');
  assert.equal(await page.textContent('#bulkCount'), '6 items selected');
  await page.click('#bulk [data-bulk=tag]'); await page.fill('.tagpop input', 'coast'); await page.keyboard.press('Enter');
  await until(page, 'S.items.filter(i => i.tags.includes("coast")).length === 6');
  await page.click('#bulk [data-bulk=story]'); await page.fill('.tagpop input', 'A week by the sea'); await page.click('.tagpop .btn.primary');
  await page.waitForSelector('#reader:not([hidden]) .rd-row img.in');
  await page.fill('.rd-intro', 'Six photographs from the first week.');
  await closeIsTopRight(page, '.rd-bar .modal-x', '#reader');
  assert.deepEqual(await page.evaluate(() => [...new Set([...document.querySelectorAll('#reader img')].map((i) => getComputedStyle(i).objectFit))]), ['contain']);
  await shot(page, '06-story');
  await page.click('.rd-bar .btn.primary'); await page.waitForSelector('#player:not([hidden]) #plImg.in');
  await closeIsTopRight(page, '#plClose', '#player');
  // the slideshow: the picture is whole, up to 2% from each edge, over a blurred copy of itself at 40%, with words and controls on their own panel at the bottom right
  const [rImg, rPanel, rCtl] = await page.evaluate(() => ['#plImg', '#plPanel', '#plPlay'].map((q) => { const b = document.querySelector(q)!.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; }));
  const pl = { img: rImg, panel: rPanel, ctl: rCtl, ...(await page.evaluate(() => ({ W: innerWidth, H: innerHeight, opacity: getComputedStyle(document.querySelector('#plBg')!).opacity, blur: getComputedStyle(document.querySelector('#plBg')!).filter, bgImg: getComputedStyle(document.querySelector('#plBg')!).backgroundImage, panelBg: getComputedStyle(document.querySelector('#plPanel')!).backgroundColor, fit: getComputedStyle(document.querySelector('#plImg')!).objectFit, ar: (document.querySelector('#plImg') as HTMLImageElement).naturalWidth / (document.querySelector('#plImg') as HTMLImageElement).naturalHeight }))) };
  assert.ok(pl.img.l >= pl.W * 0.02 - 1 && pl.img.r <= pl.W * 0.98 + 1 && pl.img.t >= pl.H * 0.02 - 1 && pl.img.b <= pl.H * 0.98 + 1, 'the picture keeps 2% clear of every edge');
  assert.ok(Math.abs(pl.img.w - pl.W * 0.96) < 2 || Math.abs(pl.img.h - pl.H * 0.96) < 2 || pl.img.w < pl.W * 0.96, 'and is as large as that allows');
  assert.ok(Math.abs(pl.img.w / pl.img.h / pl.ar - 1) < 0.02 && pl.fit === 'contain', 'whole, never cropped');
  assert.deepEqual([pl.opacity, /blur\(/.test(pl.blur), /\/thumb/.test(pl.bgImg)], ['0.4', true, true], 'a blurred copy of the picture behind it, at 40%');
  assert.ok(pl.panel.r > pl.W * 0.75 && pl.panel.b > pl.H * 0.75 && pl.panel.r <= pl.W && pl.panel.b <= pl.H, 'words and controls sit at the bottom right');
  assert.ok(pl.ctl.l >= pl.panel.l && pl.ctl.r <= pl.panel.r && pl.ctl.t >= pl.panel.t && pl.ctl.b <= pl.panel.b, 'the controls are inside the panel');
  assert.match(pl.panelBg, /rgba\(12, 13, 15, 0\.7/, 'the panel has a background of its own');
  await page.waitForTimeout(900); await shot(page, '06a-slideshow');
  await page.click('#plClose'); await page.waitForSelector('#player', { state: 'hidden' });
  await page.waitForTimeout(1000); await page.reload(); await page.waitForSelector('#grid .tile');
  assert.deepEqual(await S(page, 'S.stories.map(s => [s.title, s.intro, s.ids.length])'), [['A week by the sea', 'Six photographs from the first week.', 6]]);
});

await step('the author chooses a cover of up to four pictures, shown whole on the story and on its card', async () => {
  await S(page, 'go("stories")'); await page.click('.st-card'); await page.waitForSelector('#reader:not([hidden]) .rd-row img.in');
  // every cover picture keeps its own shape and stays inside the cover box
  const whole = (box: string) => S(page, `(() => { const b = document.querySelector('${box}').getBoundingClientRect(); return [...document.querySelectorAll('${box} .cv img')].map(i => { const it = S.byId.get(i.dataset.id), r = i.getBoundingClientRect(); return [Math.abs(r.width / r.height / it.ar - 1) < 0.03, r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1, getComputedStyle(i).objectFit]; }); })()`);
  const cover = () => S(page, 'S.stories[0].covers');
  const first = (await cover())[0]; assert.equal((await cover()).length, 1);
  await page.click('#rdCover'); await page.waitForSelector('#rdHint');
  assert.equal(await page.locator('.rd-ph.chosen').count(), 1);
  const others = await S(page, `Stories.items(Stories.cur).map(i => i.id).filter(id => id !== "${first}")`);
  for (const id of others.slice(0, 3)) await page.click(`.rd-ph[data-id="${id}"]`);
  assert.deepEqual(await cover(), [first, ...others.slice(0, 3)], 'the order of clicks is the order kept');
  assert.deepEqual(await page.$$eval('.rd-pick', (e: any[]) => e.map((x) => x.textContent).sort()), ['1', '2', '3', '4']);
  assert.deepEqual(await S(page, `[...document.querySelectorAll('#rdCoverBox .cv img')].map(i => i.dataset.id)`), [first, ...others.slice(0, 3)]);
  assert.deepEqual(await whole('#rdCoverBox'), Array(4).fill([true, true, 'contain']));
  await shot(page, '06c-cover-four');
  await page.click(`.rd-ph[data-id="${others[3]}"]`); await page.waitForSelector('.toast:has-text("up to four")'); assert.equal((await cover()).length, 4);
  await page.click(`.rd-ph[data-id="${first}"]`); assert.deepEqual(await cover(), others.slice(0, 3), 'a chosen one comes off with another click');
  assert.deepEqual(await whole('#rdCoverBox'), Array(3).fill([true, true, 'contain']));
  await page.click('#rdHint .btn'); await page.waitForSelector('#rdHint', { state: 'detached' });
  // outside the mode a click opens the viewer as before
  await page.click(`.rd-ph[data-id="${first}"]`); await page.waitForSelector('#viewer:not([hidden])'); await page.keyboard.press('Escape');
  await page.click('#reader .modal-x'); await page.waitForSelector('.st-card .cv img.in');
  assert.deepEqual(await whole('.st-card .st-cover'), Array(3).fill([true, true, 'contain']));
  await shot(page, '06d-story-card');
  await page.waitForTimeout(1000); await page.reload(); await page.waitForSelector('#grid .tile');
  assert.deepEqual(await cover(), others.slice(0, 3), 'the cover is kept on the server');
});

await step('the author breaks a story into sections, moves pictures between them, and can go back to automatic', async () => {
  await S(page, 'go("stories")'); await page.click('.st-card'); await page.waitForSelector('#reader:not([hidden]) .rd-row img.in');
  const story = () => S(page, '(s => ({ sections: s.sections && s.sections.map(x => [x.title, x.text, x.ids.length]), ids: s.ids, notes: s.notes }))(S.stories[0])');
  const order = () => S(page, 'Stories.items(S.stories[0]).map(i => i.id)');
  assert.equal((await story()).sections, null, 'a story arranges itself until its author changes the structure');
  const parts0 = await page.locator('.rd-ch').count(); assert.ok(parts0 >= 2);
  const heading0 = await page.textContent('.rd-ch >> nth=0 >> h2');
  await page.fill('.rd-ch >> nth=0 >> .rd-note', 'We left before sunrise.');
  // the first change by hand turns the automatic parts into sections, with their headings and what was written
  await page.click('#rdArrange'); await page.waitForSelector('#rdArr');
  assert.equal(await page.locator('.ar-sec').count(), parts0); assert.equal(await page.$('#arAuto'), null);
  await page.waitForSelector('#rdArr .ar-it img.in'); // the small pictures load
  assert.deepEqual(await S(page, `[...document.querySelectorAll('.ar-it')].map(t => { const it = S.byId.get(t.dataset.id), r = t.getBoundingClientRect(); return Math.abs(r.width / r.height / it.ar - 1) < 0.03; })`), Array(await page.locator('.ar-it').count()).fill(true), 'every one keeps its shape');
  const before = await order();
  const lastK = parts0 - 1, inLast = await page.locator(`.ar-sec[data-k="${lastK}"] .ar-it`).count();
  // make sure there is a section with two pictures to cut: join the last two parts if the last has only one
  if (inLast < 2) { await page.click(`.ar-join[data-k="${lastK}"]`); }
  const k = (await page.locator('.ar-sec').count()) - 1;
  await page.click(`.ar-sec[data-k="${k}"] .ar-cut >> nth=0`);
  await until(page, `document.querySelectorAll('.ar-sec').length === ${k + 2}`, 10000);
  let st = await story();
  assert.deepEqual([st.sections[0][0], st.sections[0][1]], [heading0, 'We left before sunrise.'], 'the first part kept its heading and its text');
  assert.deepEqual(await order(), before, 'a break changes no order');
  assert.deepEqual(st.sections[k + 1], ['', '', st.sections[k + 1][2]], 'the new section starts empty of words');
  await page.waitForSelector('#arAuto');
  await page.fill(`.ar-title[data-k="${k + 1}"]`, 'The way home');
  await page.evaluate(() => { document.querySelector('#reader')!.scrollTop = 0; }); await page.waitForTimeout(400); await shot(page, '06e-arrange');
  // the reader shows the section under its new title, and the player announces it as the section begins
  await page.click('#rdArrange'); await page.waitForSelector('.rd-row img');
  assert.equal(await page.inputValue(`.rd-sec-title >> nth=${k + 1}`), 'The way home');
  const at = await S(page, `Stories.items(S.stories[0]).findIndex(i => i.id === S.stories[0].sections[${k + 1}].ids[0])`);
  await S(page, `Stories.play(${at})`); await page.waitForSelector('#plSection.show'); assert.equal(await page.textContent('#plSection'), 'The way home');
  assert.deepEqual(await S(page, 'Player.items.map(i => i.id)'), before); await page.keyboard.press('Escape');
  await page.click('#rdArrange'); await page.waitForSelector('#rdArr');
  // move a picture one step later with the keyboard: it changes places with the one after it, across sections if need be
  if (!(await story()).sections.some((x: any) => x[2] >= 2)) { await page.click('.ar-join[data-k="1"]'); await until(page, 'S.stories[0].sections[0].ids.length >= 2'); }
  const [mover, after] = await S(page, '(x => [x.ids[0], x.ids[1]])(S.stories[0].sections.find(x => x.ids.length >= 2))'), was = await order(), mi = was.indexOf(mover);
  await page.focus(`.ar-it[data-id="${mover}"]`); await page.keyboard.press('Shift+ArrowRight');
  let now = await order(); assert.deepEqual([now[mi], now[mi + 1]], [after, mover]); assert.deepEqual([...now.slice(0, mi), ...now.slice(mi + 2)], [...was.slice(0, mi), ...was.slice(mi + 2)]);
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.id), mover, 'it keeps the focus, so it can be moved again');
  // drag a picture from further on in front of the first
  await page.evaluate(() => { document.querySelector('#reader')!.scrollTop = 0; });
  const dragged = now[2];
  await page.dragAndDrop(`.ar-it[data-id="${dragged}"]`, `.ar-it[data-id="${now[0]}"]`, { targetPosition: { x: 4, y: 20 } });
  await until(page, `Stories.items(S.stories[0])[0].id === "${dragged}"`);
  const mine = await order(); assert.deepEqual(mine, [dragged, ...now.filter((id: string) => id !== dragged)], 'only that picture moved, and none is lost or doubled');
  assert.ok((await story()).sections.every((x: any) => x[2] > 0), 'no section is left empty');
  // the reader and the player follow the author's order
  await page.click('#rdArrange'); await page.waitForSelector('.rd-row img');
  assert.deepEqual(await S(page, `[...document.querySelectorAll('.rd-rows img')].map(i => i.dataset.id)`), mine);
  await S(page, 'Stories.play(0)'); assert.deepEqual(await S(page, 'Player.items.map(i => i.id)'), mine); await page.keyboard.press('Escape');
  // a break removed joins the section to the one before and keeps both texts
  const firstText = (await story()).sections[0][1];
  await page.fill('.rd-ch >> nth=1 >> .rd-note', 'Second thoughts.');
  await page.click('#rdArrange'); const nSec = await page.locator('.ar-sec').count(); assert.ok(nSec >= 2);
  await page.click('.ar-join[data-k="1"]'); await until(page, `document.querySelectorAll('.ar-sec').length === ${nSec - 1}`, 10000);
  st = await story(); assert.equal(st.sections[0][1], [firstText, 'Second thoughts.'].filter(Boolean).join('\n\n')); assert.deepEqual(await order(), mine);
  // kept on the server
  await page.waitForTimeout(1000); await page.reload(); await page.waitForSelector('#grid .tile');
  assert.deepEqual(await order(), mine); assert.deepEqual((await story()).sections, st.sections);
  // back to automatic, after a confirmation: the order is the date's again and the earlier text is back
  await S(page, 'go("stories")'); await page.click('.st-card'); await page.click('#rdArrange'); await page.click('#arAuto'); await page.click('#arAutoYes');
  await until(page, 'S.stories[0].sections === null'); assert.equal(await page.$('#arAuto'), null);
  await page.click('#rdArrange'); await page.waitForSelector('.rd-row img');
  assert.deepEqual(await order(), before); assert.equal(await page.inputValue('.rd-ch >> nth=0 >> .rd-note'), 'We left before sunrise.');
  await page.click('#reader .modal-x'); await page.waitForTimeout(1000);
});

await step('pictures can be taken out of a story, one at a time or a whole section, and they stay in the library', async () => {
  await S(page, 'go("stories")'); await page.click('.st-card'); await page.waitForSelector('#reader:not([hidden]) .rd-row img.in');
  const ids = () => S(page, 'Stories.items(S.stories[0]).map(i => i.id)'), all = await ids(), lib = await S(page, 'S.items.length');
  assert.equal(all.length, 6); assert.equal(await S(page, 'S.stories[0].sections'), null);
  await page.click('#rdArrange'); await page.waitForSelector('#rdArr .ar-it img.in');
  // one picture, with the small x on it. The story keeps arranging itself.
  const one = all[1];
  await page.hover(`.ar-it[data-id="${one}"]`); await page.click(`.ar-it[data-id="${one}"] .ar-x`);
  await page.waitForSelector('.toast:has-text("Removed 1 picture from the story. It is still in your library.")');
  assert.deepEqual(await ids(), all.filter((x: string) => x !== one)); assert.equal(await page.$(`.ar-it[data-id="${one}"]`), null);
  assert.deepEqual([await S(page, 'S.stories[0].sections'), await S(page, 'S.items.length'), await S(page, `!!S.byId.get("${one}")`)], [null, lib, true]);
  // Undo puts it back
  await page.click('.toast:has-text("Removed 1 picture") .linkbtn'); await page.waitForSelector(`.ar-it[data-id="${one}"]`); assert.deepEqual(await ids(), all);
  // the Delete key does the same for the picture in focus
  await page.focus(`.ar-it[data-id="${all[0]}"]`); await page.keyboard.press('Delete'); await page.waitForSelector(`.ar-it[data-id="${all[0]}"]`, { state: 'detached' }); assert.equal((await ids()).length, 5);
  // a whole section, after a confirmation
  const secs = await page.locator('.ar-sec').count(), dropped = await page.$$eval('.ar-sec[data-k="1"] .ar-it', (e: any[]) => e.map((x) => x.dataset.id));
  await page.click('.ar-drop[data-k="1"]'); assert.match(await page.textContent('.pop .confirm p'), /^Remove this section and its \d+ pictures? from the story\? The pictures stay in your library\./);
  await shot(page, '06g-remove-section');
  await page.click('#arDropYes'); await until(page, `document.querySelectorAll('.ar-sec').length === ${secs - 1}`, 5000);
  const left = await ids(); assert.deepEqual(left, all.filter((x: string) => x !== all[0] && !dropped.includes(x)));
  assert.equal(await S(page, 'S.items.length'), lib, 'nothing left the library');
  // kept on the server
  await page.waitForTimeout(600); await page.reload(); await page.waitForSelector('#grid .tile'); assert.deepEqual([...(await ids())].sort(), [...left].sort());
  // the last picture cannot be removed this way
  await S(page, 'go("stories")'); await page.click('.st-card'); await page.click('#rdArrange'); await page.waitForSelector('#rdArr .ar-it');
  for (const id of left.slice(1)) { await page.focus(`.ar-it[data-id="${id}"]`); await page.keyboard.press('Delete'); await page.waitForSelector(`.ar-it[data-id="${id}"]`, { state: 'detached' }); }
  assert.deepEqual([await page.locator('.ar-it').count(), await page.locator('.ar-x').count(), await page.locator('.ar-drop').count()], [1, 0, 0], 'the last picture has no remove control');
  await page.focus('.ar-it'); await page.keyboard.press('Delete'); await page.waitForSelector('.toast:has-text("A story needs at least one picture")'); assert.equal((await ids()).length, 1);
  await page.click('#reader .modal-x');
});

await step('a story is made from scratch by picking one by one, by place, by day or by moment, and a picture can be in several stories', async () => {
  await S(page, 'go("stories")'); await page.click('#stNew'); await page.waitForSelector('.sp-box #spGrid .tile img.in');
  await closeIsTopRight(page, '#spClose', '.sp-box');
  assert.equal(await page.isDisabled('#spGo'), true); assert.equal(await page.textContent('#spCount'), 'Nothing chosen yet');
  // the same never-crop rule as everywhere else
  assert.deepEqual(await S(page, `[...document.querySelectorAll('#spGrid .tile')].map(t => { const it = S.byId.get(t.dataset.id), r = t.getBoundingClientRect(); return Math.abs(r.width / r.height / it.ar - 1) < 0.03; }).filter(x => !x)`), []);
  const chosen = () => S(page, '[...StoryPicker.sel]');
  // one by one
  const one = await page.getAttribute('#spGrid .tile >> nth=0', 'data-id'); await page.click('#spGrid .tile >> nth=0');
  assert.deepEqual(await chosen(), [one]); assert.equal(await page.textContent('#spCount'), '1 item chosen');
  await page.click('#spGrid .tile >> nth=0'); assert.deepEqual(await chosen(), []);
  // by place: everything from one place in one click
  await page.click('.sp-seg [data-m=place]'); await page.waitForSelector('#spGroups .sp-g .sp-all');
  const place = await S(page, 'StoryPicker.groups("place")[0]').then((g: any) => ({ label: g.label, n: g.items.length }));
  await page.click('#spGroups .sp-g[data-key] >> nth=0 >> .sp-all'); assert.equal((await chosen()).length, place.n);
  assert.ok(await S(page, `[...StoryPicker.sel].every(id => StoryPicker.placeName(S.byId.get(id)) === ${JSON.stringify(place.label)})`));
  assert.equal(await page.textContent('#spGroups .sp-g[data-key] >> nth=0 >> .sp-all'), 'Remove');
  await page.click('#spGroups .sp-g[data-key] >> nth=0 >> .sp-all'); assert.deepEqual(await chosen(), []);
  // by day
  await page.click('.sp-seg [data-m=day]'); const day = await S(page, 'StoryPicker.groups("day").find(g => g.items.length >= 1)').then((g: any) => ({ key: g.key, label: g.label, n: g.items.length }));
  assert.match(day.label, /^\w+day, \w+ \d+, \d{4}$/);
  await page.click(`#spGroups .sp-g[data-key="${day.key}"] .sp-gl`); await page.waitForFunction((n: number) => document.querySelectorAll('#spGrid .tile').length === n, day.n);
  // by moment: taken close together in time, in one place. Two places on one day are two moments.
  await page.click('.sp-seg [data-m=moment]');
  const moments = await S(page, 'StoryPicker.groups("moment").map(g => ({ key: g.key, label: g.label, n: g.items.length, place: g.place, span: g.last - g.first }))');
  assert.ok(moments.length >= 3 && moments.every((m: any) => /^\w{3}, \w{3} \d+, \d{4}, (morning|afternoon|evening|night)( in .+)?$/.test(m.label)), JSON.stringify(moments.slice(0, 3)));
  assert.ok(await S(page, 'StoryPicker.groups("moment").every(g => g.items.every((it, i, a) => StoryPicker.placeName(it) === g.place && (i === 0 || it.date - a[i - 1].date <= 3 * 3600000)))'), 'every moment is one place and has no gap of more than three hours');
  await page.waitForSelector('#spGrid .tile img.in'); await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 15000 });
  assert.equal(await page.locator('#spGrid .tile').count(), await S(page, 'StoryPicker.pool.length'), 'with no moment picked, everything is shown beside the list');
  await shot(page, '06h-picker');
  const [m1, m2] = moments; await page.click(`#spGroups .sp-g[data-key="${m1.key}"] .sp-all`); await page.click(`#spGroups .sp-g[data-key="${m2.key}"] .sp-all`);
  assert.equal((await chosen()).length, m1.n + m2.n);
  const picked = await chosen();
  await page.fill('#spTitle', 'Two moments'); await page.click('#spGo');
  await page.waitForSelector('#reader:not([hidden]) .rd-row img'); await until(page, 'S.stories.some(s => s.title === "Two moments")');
  assert.deepEqual([...(await S(page, 'S.stories.find(s => s.title === "Two moments").ids'))].sort(), [...picked].sort());
  // a picture that is already in one story goes into another
  const shared = await S(page, 'S.stories.find(s => s.title === "A week by the sea").ids[0]');
  await page.click('#rdArrange'); await page.click('#arAdd'); await page.waitForSelector('.sp-box #spGrid .tile');
  assert.equal(await page.$('#spTitle'), null, 'adding to a story asks for no title');
  for (const id of picked.slice(0, 1)) assert.equal(await page.locator(`#spGrid .tile.has[data-id="${id}"]`).count(), 1, 'what the story already holds is marked and cannot be chosen twice');
  if (!picked.includes(shared)) { await page.click(`#spGrid .tile[data-id="${shared}"]`); await page.click('#spGo'); await page.waitForSelector('.sp-box', { state: 'detached' }); await page.waitForSelector(`.ar-it[data-id="${shared}"]`); }
  else await page.click('#spClose');
  assert.deepEqual(await S(page, `S.stories.filter(s => s.ids.includes("${shared}")).map(s => s.title).sort()`), ['A week by the sea', 'Two moments']);
  await page.click('#reader .modal-x');
  // and from the library: select, Make story, then "Or add them to a story"
  await S(page, 'go("library")'); const extra = await S(page, '(s => S.items.find(i => i.space === S.space && i.status === "ready" && !s.ids.includes(i.id)).id)(S.stories.find(s => s.title === "Two moments"))');
  await S(page, `S.sel.clear(), S.sel.add("${extra}"), Bus.emit("sel")`); await page.click('#bulk [data-bulk=story]');
  await page.click('.bulk-stories .mi:has-text("Two moments")'); await page.waitForSelector('.toast:has-text("Added 1 item to")');
  await until(page, `S.stories.find(s => s.title === "Two moments").ids.includes("${extra}") && S.sel.size === 0`);
  await page.waitForTimeout(300); await page.reload(); await page.waitForSelector('#grid .tile');
  assert.ok(await S(page, `(s => s.ids.includes("${extra}") && s.ids.includes("${shared}"))(S.stories.find(s => s.title === "Two moments"))`), 'kept on the server');
});

await step('stories are filed under groups, and their editors choose who else can read them', async () => {
  await S(page, 'go("stories")'); assert.equal(await page.$('#stGroups'), null, 'no groups yet');
  await page.click('.st-card:has-text("Two moments")'); await page.waitForSelector('#rdGroups .rd-ginp');
  await page.fill('.rd-ginp', 'Sunsets'); await page.press('.rd-ginp', 'Enter'); await page.fill('.rd-ginp', 'Road trips'); await page.press('.rd-ginp', 'Enter');
  assert.deepEqual(await page.$$eval('#rdGroups .chip.on span:first-child', (e: any[]) => e.map((x) => x.textContent)), ['Sunsets', 'Road trips']);
  // sharing: owners and editors always, everyone else by a tick
  await page.click('#rdShare'); await page.waitForSelector('#shPeople .sharerow'); await closeIsTopRight(page, '#shClose', '.sh-box');
  assert.deepEqual(await page.$$eval('#shPeople .sharerow', (r: any[]) => r.map((x) => [x.querySelector('span:last-child').textContent.trim(), (x.querySelector('input') as HTMLInputElement).checked, (x.querySelector('input') as HTMLInputElement).disabled])), [['Chaz owner, always', true, true]]);
  await page.click('#shClose'); await page.click('#reader .modal-x'); await page.waitForTimeout(1000);
  await S(page, 'go("stories")'); await page.click('.st-card:has-text("A week by the sea")'); await page.waitForSelector('#rdGroups .rd-ginp');
  await page.fill('.rd-ginp', 'sunsets'); await page.press('.rd-ginp', 'Enter'); await page.click('#reader .modal-x'); await page.waitForTimeout(1000);
  // the stories page filters by group
  await page.waitForSelector('#stGroups .chip >> nth=2'); await page.click('#stGroups .chip:has-text("Sunsets")'); assert.equal(await page.locator('.st-card').count(), 2); await page.click('#stGroups .chip:has-text("Sunsets")');
  assert.deepEqual(await page.$$eval('#stGroups .chip', (e: any[]) => e.map((x) => x.textContent)), ['All stories (2)', 'Sunsets (2)', 'Road trips (1)'], 'typed as "sunsets", filed under the group that was already there');
  await page.click('#stGroups .chip:has-text("Road trips")'); assert.deepEqual(await page.$$eval('.st-card h3', (e: any[]) => e.map((x) => x.textContent)), ['Two moments']);
  assert.match(await page.textContent('.st-card .st-card-g'), /Sunsets, Road trips/);
  await page.click('#stGroups .chip:has-text("All stories")'); assert.equal(await page.locator('.st-card').count(), 2);
  await page.reload(); await page.waitForSelector('#grid .tile');
  assert.deepEqual(await S(page, 'S.stories.find(s => s.title === "Two moments").groups'), ['Sunsets', 'Road trips']);
  // tidy up for the steps that follow
  await S(page, `(s => api("DELETE", "/api/stories/" + s.id).then(() => S.stories.splice(S.stories.indexOf(s), 1)))(S.stories.find(s => s.title === "Two moments"))`); await until(page, 'S.stories.length === 1');
  await S(page, `(s => api("PATCH", "/api/stories/" + s.id, { groups: [] }).then(() => { s.groups = []; }))(S.stories[0])`);
});

await step('a story is shared with public links that each have their own options, and a visitor sees that story and nothing else', async () => {
  const count0 = await S(page, 'S.items.length');
  await S(page, 'go("stories")');
  await S(page, `Stories.create("Shared one", S.items.filter(i => i.space === S.space && i.kind === "photo" && i.status === "ready").slice(0, 5)).then(s => Stories.open(s.id))`);
  await page.waitForSelector('#reader:not([hidden]) .rd-row img.in'); await page.fill('.rd-intro', 'For whoever has the link.'); await page.waitForTimeout(1000);
  await page.click('#rdShare'); await page.waitForSelector('#slList .sl-none');
  await page.click('#slNew'); await page.waitForSelector('#slList .slk');
  const url = await page.inputValue('.slk .sl-url'); assert.match(url, /\/s\/[\w-]{24,}$/);
  assert.deepEqual(await page.$$eval('.slk input[type=checkbox]', (c: any[]) => c.map((x) => x.checked)), [false, false], 'a new link is view only');
  await shot(page, '06i-share-sheet');
  // someone who is not signed in opens the link
  const guest = await newPage();
  await guest.goto(url); await guest.waitForSelector('#reader:not([hidden]) .rd-row img.in');
  assert.equal(await guest.textContent('.rd-title'), 'Shared one'); assert.equal(await guest.textContent('.rd-intro'), 'For whoever has the link.');
  assert.deepEqual([await guest.isVisible('.top'), await guest.isVisible('#reader .modal-x'), await guest.isVisible('#rdShare'), await guest.isVisible('#rdArrange'), await guest.isVisible('#rdAddMine'), await guest.locator('#reader textarea').count()], [false, false, false, false, false, 0], 'no app around it, and nothing to change');
  assert.deepEqual(await guest.evaluate(() => [...new Set([...document.querySelectorAll('#reader img')].map((i) => getComputedStyle(i).objectFit))]), ['contain']);
  assert.equal(await S(guest, 'S.items.length'), 5, 'only the pictures of this story');
  assert.match(await guest.textContent('.rd-shared'), /shared with you through ImageStoria/);
  expectRefusals = true; assert.deepEqual(await guest.evaluate(async () => [(await fetch('/api/index')).status, (await fetch('/api/stories')).status, (await fetch('/api/bootstrap').then((r) => r.json())).me]), [401, 401, null]); await guest.waitForTimeout(100); expectRefusals = false;
  // a click on a picture opens it in the slideshow, standing still, with no download
  await guest.click('.rd-ph >> nth=1'); await guest.waitForSelector('#player:not([hidden]) #plImg.in');
  assert.deepEqual([await S(guest, 'Player.playing'), await S(guest, 'Player.i'), await guest.isVisible('#plDown')], [false, 1, false]);
  assert.match(await guest.getAttribute('#plImg', 'src'), /\/api\/share\/[\w-]+\/files\/[\w-]+\/display$/);
  await guest.keyboard.press('ArrowRight'); assert.equal(await S(guest, 'Player.i'), 2); await guest.keyboard.press('Escape'); await guest.waitForSelector('#player', { state: 'hidden' });
  await shot(guest, '06j-shared-story');
  // the owner turns on downloads and adding, and sets a password, on that one link
  await page.check('.slk input[data-opt=allowDownload]'); await page.waitForSelector('.toast:has-text("now allows downloads")');
  await page.check('.slk input[data-opt=allowAdd]'); await page.waitForSelector('.toast:has-text("can now add photos")');
  await page.click('.slk [data-act=pw]'); await page.fill('.sl-pw input', 'sal y limon'); await page.click('.sl-pw .btn.primary'); await page.waitForSelector('.slk .sl-lock');
  // a second link with its own options
  await page.click('#slNew'); await page.waitForFunction(() => document.querySelectorAll('#slList .slk').length === 2);
  assert.deepEqual(await page.$$eval('.slk', (r: any[]) => r.map((x) => [...x.querySelectorAll('input[type=checkbox]')].map((c: any) => c.checked).concat(!!x.querySelector('.sl-lock')))), [[true, true, true], [false, false, false]]);
  // the visitor now meets the password
  await guest.reload(); await guest.waitForSelector('#gateCard h1'); assert.equal(await guest.textContent('#gateCard h1'), 'This story is protected');
  expectRefusals = true; await guest.fill('#gateCard input[type=password]', 'wrong'); await guest.click('#gateCard button[type=submit]'); await guest.waitForSelector('.gate-err:not([hidden])'); await guest.waitForTimeout(100); expectRefusals = false;
  assert.match(await guest.textContent('.gate-err'), /not the password/);
  await guest.fill('#gateCard input[type=password]', 'sal y limon'); await guest.click('#gateCard button[type=submit]'); await guest.waitForSelector('#reader:not([hidden]) .rd-row img.in');
  // downloads are offered now, and the visitor can add a photo of their own
  await guest.click('.rd-ph >> nth=0'); await guest.waitForSelector('#player:not([hidden])'); assert.equal(await guest.isVisible('#plDown'), true);
  const [dl] = await Promise.all([guest.waitForEvent('download'), guest.click('#plDown')]); assert.match(dl.suggestedFilename(), /^IMG_10\d\d\.jpg$/); await guest.keyboard.press('Escape');
  const [chooser] = await Promise.all([guest.waitForEvent('filechooser'), guest.click('#rdAddMine')]); await chooser.setFiles(fixture('seaside.jpg'));
  await guest.waitForSelector('.toast:has-text("Added 1 file")'); await until(guest, 'S.items.length === 6', 60000);
  assert.equal(await guest.locator('.rd-ph').count(), 6, 'it appears in the story once it is processed');
  // the owner sees it in the library and in the story
  await S(page, 'Sync.poll()'); await until(page, `S.items.length === ${count0 + 1} && S.items.some(i => i.fileName === "seaside.jpg" && i.status === "ready")`);
  await S(page, 'Stories.load()'); await until(page, 'S.stories.find(s => s.title === "Shared one").ids.length === 6');
  // deleting the link ends it at once
  await page.click('.slk >> nth=0 >> [aria-label^="Delete the link"]'); await page.click('.pop [data-act=del]'); await page.waitForFunction(() => document.querySelectorAll('#slList .slk').length === 1);
  expectRefusals = true; await guest.reload(); await guest.waitForSelector('#gateCard h1'); assert.equal(await guest.textContent('#gateCard h1'), 'This link does not work'); await guest.waitForTimeout(100); expectRefusals = false;
  await guest.context().close();
  // tidy up for the steps that follow: the story, and the visitor's photo
  await page.click('#shClose');
  await S(page, `(async () => { const s = S.stories.find(x => x.title === "Shared one"), it = S.items.find(i => i.fileName === "seaside.jpg"); await api("DELETE", "/api/stories/" + s.id); await api("POST", "/api/items/bulk", { ids: [it.id], action: "delete" }); await api("POST", "/api/trash/empty", { ids: [it.id] }); S.stories.splice(S.stories.indexOf(s), 1); Stories.close(); await Sync.full(); Lib.refresh(); })()`);
  await until(page, `S.items.length === ${count0} && S.stories.length === 1`);
});

await step('a video in a story plays through in the player, and shows as a still with its length on the page', async () => {
  const vid = await S(page, 'S.items.find(i => i.kind === "video").id'), pic = await S(page, 'S.items.find(i => i.fileName === "IMG_1004.jpg").id');
  await S(page, `Stories.create("With a clip", [S.byId.get("${vid}"), S.byId.get("${pic}")]).then(s => Stories.open(s.id))`);
  await page.waitForSelector(`#reader .rd-ph[data-id="${vid}"] .rd-play`);
  assert.match(await page.textContent(`.rd-ph[data-id="${vid}"] .rd-play`), /^\d+:\d\d$/, 'the still carries the length');
  assert.equal(await page.$(`.rd-ph[data-id="${pic}"] .rd-play`), null);
  await page.click(`.rd-ph[data-id="${vid}"]`); await page.waitForSelector('#viewer:not([hidden])'); await page.waitForFunction(() => !(document.querySelector('#vwVideo') as HTMLVideoElement).paused); await page.keyboard.press('Escape');
  // music for the story: ten pieces made by the app, from still to driving, and a place for your own
  await page.click('#rdMusic'); await page.waitForSelector('#muList .mu >> nth=10'); await closeIsTopRight(page, '#muClose', '.mu-box');
  assert.deepEqual(await page.$$eval('#muList .mu', (r: any[]) => r.map((x) => x.querySelector('b').textContent)), ['No music', 'Still water', 'First light', 'Slow road', 'Golden hour', 'Postcards', 'City lights', 'Open windows', 'Boardwalk', 'Summit', 'Full tilt']);
  assert.deepEqual(await page.$$eval('#muList .mu', (r: any[]) => r.map((x) => x.querySelectorAll('.mu-e i.on').length)), [0, 1, 1, 2, 2, 3, 3, 3, 4, 4, 5], 'each shows its energy');
  await shot(page, '06k-music');
  // listen before choosing: the first time, the server makes the piece
  await page.click('.mu[data-id="builtin:golden-hour"] .mu-play'); await page.waitForFunction(() => !!(window as any).Music?.audio || true);
  await until(page, 'Music.audio && !Music.audio.paused && Music.audio.currentTime > 0', 40000);
  await page.click('.mu[data-id="builtin:golden-hour"] .mu-play'); assert.equal(await S(page, 'Music.playing'), null, 'a second click stops it');
  await page.check('.mu[data-id="builtin:golden-hour"] input'); await page.waitForSelector('.toast:has-text("now plays “Golden hour”")');
  await page.click('#muClose'); assert.equal(await page.evaluate(() => document.querySelector('#rdMusic')!.classList.contains('on')), true);
  // the video is first by date. In the player it plays, and its piece of the bar follows it.
  const pv = () => page.evaluate(() => { const v = document.querySelector('#plVideo') as HTMLVideoElement, seg = document.querySelector('#plBar i.now') as HTMLElement; return { hidden: v.hidden, paused: v.paused, muted: v.muted, t: v.currentTime, src: v.getAttribute('src'), vid: !!seg && seg.classList.contains('vid'), p: seg ? +seg.style.getPropertyValue('--p') : -1, img: (document.querySelector('#plImg') as HTMLElement).hidden }; });
  await S(page, 'Player.DUR = 60000'); // so only the video can move the player on
  await page.click('#rdPlay'); await page.waitForFunction(() => { const v = document.querySelector('#plVideo') as HTMLVideoElement; return !v.hidden && !v.paused && v.currentTime > 0; });
  let s = await pv(); assert.deepEqual([s.vid, s.img, s.muted], [true, true, false]); assert.ok(s.p > 0 && s.p < 1, 'the bar is part way: ' + s.p);
  // the story's music plays under it, and dips while the video's own sound is playing
  const au = () => page.evaluate(() => { const a = document.querySelector('#plAudio') as HTMLAudioElement; return { src: a.getAttribute('src'), paused: a.paused, vol: Math.round(a.volume * 100) / 100, muted: a.muted }; });
  assert.match((await au()).src ?? '', /\/api\/music\/builtin%3Agolden-hour\/file\?v=\d+$/); assert.equal(await page.isVisible('#plMusic'), true);
  await until(page, 'document.querySelector("#plAudio").volume <= 0.11', 10000); assert.equal((await au()).paused, false);
  assert.deepEqual(await page.evaluate(() => { const v = document.querySelector('#plVideo')!, r = v.getBoundingClientRect(); return [getComputedStyle(v).objectFit, r.width > 100 && r.right <= innerWidth && r.bottom <= innerHeight]; }), ['contain', true]);
  await shot(page, '06f-player-video');
  // pause pauses the video itself, and play carries on from where it was
  await page.keyboard.press(' '); s = await pv(); assert.equal(s.paused, true); const at = s.t; await page.waitForTimeout(300); assert.equal((await pv()).t, at);
  assert.equal((await au()).paused, true, 'pause pauses the music too');
  await page.keyboard.press(' '); await page.waitForFunction((t: number) => { const v = document.querySelector('#plVideo') as HTMLVideoElement; return !v.paused && v.currentTime > t; }, at);
  // when it ends the player moves on by itself
  await until(page, 'Player.i === 1', 30000); s = await pv(); assert.deepEqual([s.hidden, s.src, s.img], [true, null, false]);
  await until(page, 'document.querySelector("#plAudio").volume >= 0.54', 10000); assert.equal((await au()).paused, false, 'on a photo the music is back up');
  await page.click('#plMusic'); assert.equal((await au()).muted, true); await page.click('#plMusic'); assert.equal((await au()).muted, false);
  // A phone can stop the music by itself when a video starts to sound, and an iPhone does not let the page turn it down.
  // Stopped music comes back as soon as nothing is talking over it.
  await page.evaluate(() => (document.querySelector('#plAudio') as HTMLAudioElement).pause()); assert.equal((await au()).paused, true);
  await S(page, 'Player.duck()'); await until(page, '!document.querySelector("#plAudio").paused'); 
  // where the volume cannot be set, the music steps aside for a video with sound instead of dipping, and returns after it
  await S(page, 'Player.fixedVol = true, Player.step(-1)'); await page.waitForFunction(() => { const v = document.querySelector('#plVideo') as HTMLVideoElement; return !v.hidden && !v.paused && v.currentTime > 0.2; });
  await until(page, 'document.querySelector("#plAudio").paused'); 
  await S(page, 'Player.step(1)'); await until(page, '!document.querySelector("#plAudio").paused', 10000); await S(page, 'Player.fixedVol = false, Player.duck()');
  // Previous works at any time, and the video starts again
  await page.keyboard.press('ArrowLeft'); await page.waitForFunction(() => { const v = document.querySelector('#plVideo') as HTMLVideoElement; return !v.hidden && !v.paused; });
  await page.keyboard.press('ArrowRight'); assert.deepEqual([(await pv()).hidden, await S(page, 'Player.i')], [true, 1]);
  await page.keyboard.press('Escape'); await page.waitForSelector('#player', { state: 'hidden' });
  assert.deepEqual([(await au()).paused, (await au()).src], [true, null], 'closing stops the music');
  // a browser that refuses sound: it plays silent and offers the sound
  await page.evaluate(() => { const P = HTMLMediaElement.prototype as any; P._play = P.play; P.play = function () { return this.muted ? P._play.call(this) : Promise.reject(new DOMException('refused', 'NotAllowedError')); }; });
  await page.click('#rdPlay'); await page.waitForSelector('#plUnmute:not([hidden])'); await page.waitForFunction(() => !(document.querySelector('#plVideo') as HTMLVideoElement).paused);
  assert.equal((await pv()).muted, true); await page.click('#plUnmute'); assert.equal((await pv()).muted, false); assert.equal(await page.isVisible('#plUnmute'), false);
  await page.evaluate(() => { const P = HTMLMediaElement.prototype as any; P.play = P._play; delete P._play; });
  await page.click('#plClose'); assert.deepEqual([(await pv()).paused, (await pv()).src], [true, null], 'closing stops it');
  await S(page, 'Player.DUR = 4600');
  // a reel: the story as one video file, made by the server in the background
  await page.click('#rdReel'); await page.waitForSelector('#reGo'); await closeIsTopRight(page, '#reClose', '.re-box');
  assert.equal(await page.inputValue('#reMusic'), 'builtin:golden-hour', 'the story\'s own music is offered first');
  assert.match(await page.textContent('#reTotal'), /^About 0:\d\d long: 1 photo and 1 video\. A video plays for up to 20 seconds\.$/);
  await page.click('.re-fmt[data-f="16:9"]'); await page.click('.re-fmt[data-f="9:16"]'); assert.deepEqual(await page.$$eval('.re-fmt', (b: any[]) => b.map((x) => x.classList.contains('on'))), [true, false]);
  await page.evaluate(() => { const r = document.querySelector('#reSecs') as HTMLInputElement; r.value = '2'; r.dispatchEvent(new Event('input')); });
  await shot(page, '06l-reel');
  await page.click('#reGo'); await page.waitForSelector('.re[data-status=queued], .re[data-status=running], .re[data-status=ready]');
  await page.waitForSelector('.re[data-status=ready]', { timeout: 120000 });
  await page.evaluate('window.__name = (f) => f');
  // the outline that stands for the reel's shape stays inside its own column, tall or wide, and never lies over the words
  assert.deepEqual(await page.evaluate(() => { const row = document.querySelector('.re')!, t = row.querySelector('.re-t')!.getBoundingClientRect(); const mk = (f: string) => { const i = (window as any).eval('Reels').shape(f, 30) as HTMLElement; row.prepend(i); const r = i.getBoundingClientRect(); i.remove(); return [Math.round(r.width), Math.round(r.height), r.right <= t.left + 34]; }; return [mk('9:16'), mk('16:9')]; }), [[17, 30, true], [30, 17, true]]);
  const [shape, words] = [await page.locator('.re .re-shape').first().boundingBox(), await page.locator('.re .re-t').first().boundingBox()]; assert.ok(shape.x + shape.width <= words.x, 'the outline ends before the words begin');
  assert.match(await page.textContent('.re .re-t b'), /^Tall, 9:16, Golden hour$/); assert.match(await page.textContent('.re .re-st'), /^0:0\d, [\d.]+ (KB|MB), made just now$/);
  await page.click('.re [aria-label="Play this reel"]'); await page.waitForFunction(() => { const v = document.querySelector('.re-video') as HTMLVideoElement; return v && v.videoWidth > 0 && !v.paused && v.currentTime > 0; }, null, { timeout: 30000 });
  assert.deepEqual(await page.evaluate(() => { const v = document.querySelector('.re-video') as HTMLVideoElement; return [v.videoWidth, v.videoHeight, getComputedStyle(v).objectFit]; }), [1080, 1920, 'contain']);
  const [reelFile] = await Promise.all([page.waitForEvent('download'), page.click('.re [aria-label="Download this reel"]')]); assert.equal(reelFile.suggestedFilename(), 'With a clip 9x16.mp4');
  await page.click('#reClose'); await page.waitForSelector('.re-box', { state: 'detached' });
  // the Reels page lists it, with the story it came from
  await page.keyboard.press('Escape'); await page.click('.views [data-view=reels]'); await page.waitForSelector('#rpList .rc[data-from=story]');
  assert.match(await page.textContent('#rpList .rc[data-from=story] .re-t'), /With a clip.*Tall, 9:16, Golden hour\. From a story, 2 items\./s); assert.ok(await page.$('#rpList .rc[data-from=story] .re-open'));
  // a reel straight from the library: select pictures, Make reel, choose the card's pictures and a title
  await page.click('.views [data-view=library]'); await page.waitForSelector('#grid .tile');
  await page.locator('#grid .tile').nth(0).dispatchEvent('click', { shiftKey: true }); await page.locator('#grid .tile').nth(1).click(); await page.locator('#grid .tile').nth(2).click();
  await page.click('#bulk [data-bulk=reel]'); await page.waitForSelector('#reCovers .re-cv');
  assert.match(await page.textContent('.re-box h2'), /^Make a reel from 3 items$/); assert.equal(await page.locator('#reCovers .re-cv').count(), 3); assert.match(await page.textContent('#reCoverNote'), /None chosen/);
  // every picture in the chooser is whole: its box has the picture's own shape
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('#reCovers .re-cv')].every((b) => { const it = (window as any).eval('S.byId').get((b as HTMLElement).dataset.id), r = b.querySelector('img')!.getBoundingClientRect(); return Math.abs(r.width / r.height - it.ar) < 0.05; })));
  await page.locator('#reCovers .re-cv').nth(1).click(); await page.locator('#reCovers .re-cv').nth(0).click();
  assert.deepEqual(await page.$$eval('#reCovers .re-cv', (b: HTMLElement[]) => b.map((x) => x.querySelector('b')?.textContent ?? '')), ['2', '1', ''], 'numbered in the order they were chosen');
  assert.match(await page.textContent('#reCoverNote'), /2 pictures on the card/);
  await page.fill('#reTitle', 'Three from the library'); await page.selectOption('#reMusic', ''); await page.click('.re-fmt[data-f="16:9"]'); await shot(page, '06m-library-reel');
  // the sheet stays open: the reel shows there while it is made, and plays there when it is ready
  assert.match(await page.textContent('#reList'), /None yet/);
  await page.click('#reGo'); await page.waitForSelector('#reList .re'); assert.ok(await page.isVisible('.re-box'), 'the sheet is still open');
  assert.match(await page.textContent('#reList .re .re-t'), /Three from the library.*Wide, 16:9, no music\..*(Waiting to start|Being made, \d+%|made just now)/s);
  await page.waitForSelector('#reList .re[data-status=ready]', { timeout: 120000 });
  await page.click('#reList .re [aria-label="Play this reel"]'); await page.waitForFunction(() => { const v = document.querySelector('#reList .re-video') as HTMLVideoElement; return v && v.videoWidth === 1920 && !v.paused; }, null, { timeout: 30000 });
  // another one from the same pictures, without leaving: tall this time. Closing while it is being made does not stop it.
  await page.click('.re-fmt[data-f="9:16"]'); await page.fill('#reTitle', 'The tall one'); await page.click('#reGo'); await until(page, 'document.querySelectorAll("#reList .re").length === 2');
  await page.click('#reClose'); await page.waitForSelector('.re-box', { state: 'detached' }); assert.equal(await S(page, 'ReelWatch.ids.size'), 1, 'the page keeps watching it');
  // a notice that stays until it is clicked says when it is ready, and a click on it opens the Reels page
  await page.waitForSelector('.toast.sticky:has-text("Your reel “The tall one” is ready.")', { timeout: 120000 }); await page.waitForTimeout(7000);
  assert.ok(await page.isVisible('.toast.sticky'), 'it does not go away by itself'); assert.equal(await S(page, 'ReelWatch.ids.size'), 0);
  await page.click('.toast.sticky span'); await page.waitForSelector('#rpList .rc[data-from=library]'); assert.equal(await S(page, 'S.view'), 'reels'); assert.equal(await page.locator('.toast.sticky').count(), 0);
  assert.deepEqual(await page.$$eval('#rpList .rc', (r: HTMLElement[]) => r.map((x) => [x.dataset.from, x.dataset.status, x.querySelector('.re-t b')!.textContent])), [['library', 'ready', 'The tall one'], ['library', 'ready', 'Three from the library'], ['story', 'ready', 'With a clip']]);
  await page.click('#rpList .rc:has-text("The tall one") [aria-label="Delete this reel"]'); await page.click('.pop button:has-text("Delete reel")'); await until(page, 'document.querySelectorAll("#rpList .rc").length === 2');
  await S(page, 'S.sel.clear(), Bus.emit("sel")');
  assert.match(await page.textContent('#rpList .rc[data-from=library] .re-t'), /Three from the library.*Wide, 16:9, no music\. From the library, 3 items\./s);
  assert.deepEqual(await page.$$eval('#rpList .rc', (r: HTMLElement[]) => r.map((x) => x.dataset.from)), ['library', 'story'], 'both kinds, newest first');
  assert.ok(await page.isVisible('#rpList .rc[data-from=library] .rc-im img'), 'with its first cover picture on it');
  // cards: the cover is whole (its box keeps the picture's own shape), play and download are icons, and six to eight fit across a desktop screen
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('#rpList .rc-im img')].every((i) => { const im = i as HTMLImageElement, r = im.getBoundingClientRect(); return Math.abs(r.width / r.height - Number(im.getAttribute('width')) / Number(im.getAttribute('height'))) < 0.04 && getComputedStyle(im).objectFit !== 'cover'; })), 'no cover is cut to fit its card');
  assert.deepEqual(await page.$$eval('#rpList .rc[data-from=library] .rc-tools > *', (b: HTMLElement[]) => b.filter((x) => x.getAttribute('aria-label')).map((x) => [x.getAttribute('aria-label'), x.textContent!.trim(), !!x.querySelector('svg')])), [['Play this reel', '', true], ['Download this reel', '', true], ['Delete this reel', '', true]]);
  // each reel is a card with an edge of its own, the cards of a row are one height, and their icons stand on one line
  const cards = await page.$$eval('#rpList .rc', (c: HTMLElement[]) => c.map((x) => { const r = x.getBoundingClientRect(), t = x.querySelector('.rc-tools')!.getBoundingClientRect(), cs = getComputedStyle(x); return { top: Math.round(r.top), h: Math.round(r.height), tools: Math.round(t.top), edge: parseFloat(cs.borderTopWidth) > 0 && cs.backgroundColor !== 'rgba(0, 0, 0, 0)', inside: t.bottom <= r.bottom + 1 }; }));
  assert.ok(cards.length >= 2 && cards.every((c) => c.edge && c.inside), 'cards have a border and a background: ' + JSON.stringify(cards));
  assert.deepEqual([new Set(cards.map((c) => c.top)).size, new Set(cards.map((c) => c.h)).size, new Set(cards.map((c) => c.tools)).size], [1, 1, 1], 'one row: same top, same height, icons at the same height: ' + JSON.stringify(cards));
  for (const [w, lo, hi] of [[1440, 6, 8], [1920, 6, 8], [1280, 6, 8]] as const) { await page.setViewportSize({ width: w, height: 900 }); const across = await page.evaluate(() => getComputedStyle(document.querySelector('#rpList')!).gridTemplateColumns.split(' ').length); assert.ok(across >= lo && across <= hi, `${across} cards across at ${w} px`); }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('#rpList .rc[data-from=library] [aria-label="Play this reel"]'); await page.waitForFunction(() => { const v = document.querySelector('.rp-box .rp-video') as HTMLVideoElement; return v && v.videoWidth === 1920 && !v.paused; }, null, { timeout: 30000 });
  await closeIsTopRight(page, '#rpClose', '.rp-box');
  await shot(page, '06n-reels-page');
  await page.click('#rpClose'); await page.waitForSelector('.rp-box', { state: 'detached' }); await shot(page, '06o-reel-cards');
  await page.click('#rpList .rc[data-from=library] [aria-label="Delete this reel"]'); await page.click('.pop button:has-text("Delete reel")'); await until(page, 'document.querySelectorAll("#rpList .rc").length === 1');
  await page.click('.views [data-view=stories]'); await page.waitForSelector('.st-card'); await page.click('.st-card:has-text("With a clip")'); await page.waitForSelector('#rdReel');
  await S(page, `api("DELETE", "/api/stories/" + Stories.cur.id).then(() => { S.stories.splice(S.stories.indexOf(Stories.cur), 1); Stories.close(); })`);
  await until(page, 'S.stories.length === 1');
});

await step('deleted items wait in a trash the owner can look through, put back from and delete from for good', async () => {
  const [plain, other, copy] = [await S(page, 'S.items.find(i => i.fileName === "plain.png").id'), await S(page, 'S.items.find(i => i.fileName === "IMG_1003.jpg").id'), await S(page, 'S.items.find(i => i.copyOf).id')];
  await S(page, `removeItems(["${plain}", "${other}", "${copy}"].map(id => S.byId.get(id)))`); await until(page, 'S.items.length === 16');
  // the toast after a delete leads straight to the trash
  await page.click('.toast .linkbtn:has-text("Open trash")'); await page.waitForSelector('#v-trash .tile img.in');
  assert.equal(await page.locator('#v-trash .tile').count(), 3);
  assert.deepEqual([await page.$('#trTwins'), await page.locator('#v-trash .bdg.err').count()], [null, 0], 'nothing is marked as already back in the library');
  assert.match(await page.textContent('#trRule'), /^3 items, .+ Items stay here until you delete them for good\./);
  // the same never-crop rule as the library
  assert.deepEqual(await S(page, `[...document.querySelectorAll('#v-trash .tile')].map(t => { const it = Trash.items.find(i => i.id === t.dataset.id), r = t.getBoundingClientRect(); return r.width / r.height / it.ar; }).filter(x => Math.abs(x - 1) > 0.02)`), []);
  assert.deepEqual(await page.evaluate(() => [...new Set([...document.querySelectorAll('#v-trash img')].map((i) => getComputedStyle(i).objectFit))]), ['contain']);
  assert.match(await page.textContent(`#v-trash .tile[data-id="${plain}"] .tr-when`), /^Deleted just now$/);
  await shot(page, '06b-trash');
  // put one back
  await page.click(`#v-trash .tile[data-id="${other}"]`); assert.match(await page.textContent('#trSelCount'), /^1 item selected, /);
  await page.click('#trBack'); await until(page, `S.items.length === 17 && !!S.byId.get("${other}")`); await page.waitForFunction(() => document.querySelectorAll('#v-trash .tile').length === 2);
  // delete one for good: the confirmation says how many and how much space
  await page.click(`#v-trash .tile[data-id="${copy}"]`); await page.click('#trDelete');
  assert.match(await page.textContent('.pop .confirm p'), /^Delete 1 item and its files for good\? That frees [\d.]+ (KB|MB)\. This cannot be undone\.$/);
  await page.click('#trYes'); await page.waitForFunction(() => document.querySelectorAll('#v-trash .tile').length === 1);
  expectRefusals = true; assert.equal(await page.evaluate(async (id: string) => (await fetch(`/api/files/${id}/thumb`, { cache: 'no-store' })).status, copy), 404); await page.waitForTimeout(100); expectRefusals = false;
  // the settings page still has "Put everything back", and a way into the trash
  await page.click('#v-trash .tr-wrap > .linkbtn'); await page.waitForSelector('#v-admin [data-card=trash]'); assert.match(await page.textContent('#v-admin [data-card=trash]'), /Trash1 item/); await card(page, 'trash');
  await page.click('#adTrashBack'); await until(page, `S.items.length === 18 && !!S.byId.get("${plain}")`);
  await page.click('#adTrashOpen'); await page.waitForSelector('#trRule'); assert.match(await page.textContent('#trRule'), /^The trash is empty\./);
});

await step('the owner adds a person and gets an invite link', async () => {
  await page.click('#btnMe'); await page.click('.menu .mi:has-text("People and settings")'); await page.waitForSelector('#adPeople .ad-person');
  // people and settings is a modal of the same size as the viewer, over whatever was on screen
  const ab = await page.locator('#adBox').boundingBox(); assert.deepEqual([Math.round(ab.width), Math.round(ab.height), Math.round(ab.x), Math.round(ab.y)], [1296, 810, 72, 45]);
  await closeIsTopRight(page, '#adClose', '#adBox');
  const under = await S(page, 'S.view'); await page.keyboard.press('Escape'); await page.waitForSelector('#admin', { state: 'hidden' }); assert.equal(await S(page, 'S.view'), under, 'closing it leaves you where you were');
  await S(page, 'go("admin")'); await page.waitForSelector('#adPeople .ad-person');
  // the page is a board of cards: people, spaces, people in the pictures, and the library and server. All of it fits without scrolling.
  assert.deepEqual(await page.$$eval('#v-admin .ad-gh h2', (h: HTMLElement[]) => h.map((x) => x.textContent)), ['People', 'Spaces', 'People in the pictures', 'Library and server']);
  assert.deepEqual(await page.$$eval('#adServer .ad-card .ad-ct b', (h: HTMLElement[]) => h.map((x) => x.textContent)), ['Backups', 'Workers', 'Places', 'Video', 'Storage', 'Trash', 'Sign-in', 'Email', 'Public page', 'Move this library', 'Recent activity']);
  assert.ok(await page.evaluate(() => { const v = document.querySelector('#v-admin')!; return v.scrollHeight <= v.clientHeight + 1; }), 'the whole board is on one screen');
  assert.match(await page.textContent('#adPeople .ad-person'), /\(you\).*Owner.*All spaces/s); assert.match(await page.textContent('#adServer [data-card=mail]'), /EmailOffLinks are yours to pass on/);
  // a card opens a window over the page, and Escape closes the window before the page
  await card(page, 'storage'); assert.match(await page.textContent('#adStorage'), /18 items on this server’s disk/); await page.keyboard.press('Escape'); await page.waitForSelector('#adModal', { state: 'detached' }); assert.ok(await page.isVisible('#admin'));
  // the owner's own card: role, spaces and what they can do
  await page.click('#adPeople .ad-person'); await page.waitForSelector('#adPerson'); assert.match(await page.textContent('#adModal'), /\(you\).*Role.*Spaces.*An owner opens every space\..*Can/s); assert.ok(await page.isDisabled('#adPerson select'), 'the only owner stays an owner');
  await card(page, 'invite');
  await page.fill('.ad-invite input >> nth=0', 'maria@example.com'); await page.selectOption('.ad-invite select >> nth=0', 'viewer'); await page.click('.ad-invite .btn.primary');
  await page.waitForSelector('.ad-link input'); inviteLink = await page.inputValue('.ad-link input');
  // no mail key in this run: the page says nothing was sent, and where email is switched on
  assert.match(await page.textContent('#adInviteMade'), /This server does not send email, so pass this link on yourself\. It works once, for 14 days\./);
  // the new person has a card, and their window has the link and the way to remove them
  assert.equal(await page.locator('#adPeople .ad-person').count(), 2); assert.match(await page.textContent('#adPeople .ad-person >> nth=1'), /Invited, has not joined yet.*Viewer.*1 space/s);
  await S(page, 'Admin.closeModal()'); await page.click('#adPeople .ad-person >> nth=1'); await page.waitForSelector('#adPersonLink'); assert.ok(await page.isVisible('#adPersonRemove')); assert.equal(await page.locator('#adPerson .chip.on').count(), 1);
  await card(page, 'mail');
  assert.match(await page.textContent('#adMail'), /Invites and reset links by emailoff/); assert.match(await page.textContent('#adMail'), /RESEND_API_KEY and MAIL_FROM/);
  assert.match(inviteLink, /\/\?invite=[\w-]{20,}$/);
  await card(page, 'video');
  assert.match(await page.textContent('#adVideo') ?? '', /in the library/); assert.ok(await page.$('#adVideoCopies'), 'the settings page can make copies for videos already here');
  // backups: the settings page says where they go, warns that the same disk is no protection, and an owner can make one now
  assert.match(await page.textContent('#adServer [data-card=backup]'), /BackupsNone yet/); await card(page, 'backup');
  assert.match(await page.textContent('#adBackup') ?? '', /No backup has been made yet/); assert.match(await page.textContent('#adBackupDisk') ?? '', /do not protect against losing the disk/);
  await page.click('#adBackupNow'); await page.waitForSelector('#adBackupNow:not([disabled])');
  // with pg_dump on this machine the backup is made. Without it the page shows why it failed. Either way it says what happened.
  assert.match(await page.textContent('#adBackup') ?? '', /Last backup: .+ on this server’s disk, under backups\/|pg_dump program was not found/);
  // workers: no machine yet, a token is shown once, and a machine that checks in shows up with what it is doing
  assert.match(await page.textContent('#adServer [data-card=workers]'), /WorkersNo machine0 machines, \d+ to read/); await card(page, 'workers');
  assert.match(await page.textContent('#adWorkerNone'), /No machine is connected/);
  assert.match(await page.textContent('#adWorkerTasks'), /Captions, scenes and objects\d+ waiting, 0 done\./);
  assert.ok(await page.isDisabled('#adWorkerTasks .wk-task button'), 'nothing has been read, so there is nothing to read again');
  await page.fill('#adWorkerName', 'Tower'); await page.click('#adWorkerAdd'); await page.waitForSelector('#adTokenMade input');
  const wtoken = await page.inputValue('#adTokenMade input'); assert.match(wtoken, /^aiw_[\w-]{43}$/); assert.match(await page.textContent('#adTokenMade'), /shown this once/);
  assert.match(await page.textContent('#adWorkerList .rig'), /Tower.*Has not checked in yet\./);
  const fw = new FakeWorker(app.base, wtoken); await fw.heartbeat({ host: 'garage', gpu: 'RTX 3060, 12 GB', os: 'Linux', doing: 'caption' }); const held = (await fw.claim(['caption'], 2)).data.items; assert.equal(held.length, 2);
  await S(page, 'Admin.render()'); await page.waitForSelector('#adWorkerList .rig.working');
  assert.match(await page.textContent('#adWorkerList .rig'), /Tower.*RTX 3060, 12 GB, Linux, garage\. Reading 2 items \(caption\)\./);
  assert.equal(await page.$('#adTokenMade'), null, 'the token is not shown a second time'); assert.ok(!(await page.content()).includes(wtoken));
  assert.match(await page.textContent('#adWorkerTasks'), /2 being read/);
  await page.click('#adWorkerList .rig button:has-text("Pause")'); await page.waitForSelector('#adWorkerList .rig.asleep:has-text("Paused")');
  assert.equal((await fw.claim(['caption'], 2)).data.paused, true);
  await page.click('#adWorkerList .rig button:has-text("Resume")'); await page.waitForSelector('#adWorkerList .rig.working'); assert.match(await page.textContent('#adServer [data-card=workers]'), /Workers1 working1 machine/);
  await shot(page, '07b-workers');
  await page.click('#adWorkerList .rig [aria-label="Revoke the token for Tower"]'); await page.click('.pop button:has-text("Revoke")'); await page.waitForSelector('#adWorkerNone');
  assert.equal((await fw.claim(['caption'], 2)).status, 401); assert.doesNotMatch(await page.textContent('#adWorkerTasks'), /being read/);
  await S(page, 'Admin.closeModal()'); await shot(page, '07-settings');
});

await step('the invited person joins, sees only their space, and is refused everything else by the server', async () => {
  const p2 = await newPage();
  await p2.goto(app.base); await p2.waitForSelector('#gateCard h1'); assert.equal(await p2.textContent('#gateCard h1'), 'Sign in');
  await p2.fill('#gateCard input[type=email]', 'owner@example.com'); await p2.fill('#gateCard input[type=password]', 'not the password'); await p2.click('#gateCard button[type=submit]');
  await p2.waitForSelector('.gate-err:not([hidden])');
  await shot(p2, '08-signin');
  await p2.goto(inviteLink); await p2.waitForSelector('#gateCard h1'); assert.equal(await p2.textContent('#gateCard h1'), 'You are invited');
  await p2.fill('#gateCard input[autocomplete=name]', 'Maria'); await p2.fill('#gateCard input[type=password]', 'a long enough password'); await p2.click('#gateCard button[type=submit]');
  await p2.waitForSelector('#grid .tile');
  assert.deepEqual(await S(p2, '[S.spaces.map(s => s.name), S.items.length, document.querySelector("#btnUpload").hidden, S.stories.length]'), [['Life'], 18, true, 0]);
  await p2.click('#grid .tile >> nth=4'); await p2.waitForSelector('#viewer:not([hidden])');
  assert.ok(!(await p2.$$eval('#vwTools > *', (b: any[]) => b.map((x) => x.getAttribute('aria-label') || x.textContent))).some((t: string) => /Edit|Download|trash/i.test(t)));
  assert.equal(await p2.$('.vi-title.ro') !== null, true, 'the title is read-only');
  expectRefusals = true;
  const firstId = await S(p2, 'S.items[0].id');
  const refused = await p2.evaluate(async (id: string) => { const out: Record<string, number> = {}; for (const [k, m, u, b] of [['upload', 'POST', '/api/upload', {}], ['people', 'GET', '/api/people'], ['trash', 'POST', '/api/items/bulk', { ids: [id], action: 'delete' }], ['download', 'GET', `/api/files/${id}/orig?download=1`], ['retitle', 'PATCH', '/api/items/' + id, { title: 'x' }], ['copy', 'POST', `/api/items/${id}/copies`, { recipe: {} }]] as const) out[k] = (await fetch(u, { method: m, headers: { 'x-afterimage': '1', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).status; return out; }, firstId);
  await p2.waitForTimeout(200); expectRefusals = false;
  assert.deepEqual(refused, { upload: 403, people: 403, trash: 403, download: 403, retitle: 403, copy: 403 });
  await p2.keyboard.press('Escape'); await p2.click('#btnMe'); await p2.click('.menu .mi:has-text("Sign out")'); await p2.waitForSelector('#gateCard h1');
  expectRefusals = true; assert.equal(await p2.evaluate(async () => (await fetch('/api/index')).status), 401); await p2.waitForTimeout(100); expectRefusals = false;
  await p2.context().close();
});

await step('the owner adds a space from the top bar, reorders spaces on the settings page, and many tabs never push the search box away', async () => {
  await S(page, 'go("library")');
  await page.click('#btnAddSpace'); await page.fill('#newSpaceName', 'Family'); await page.selectOption('#newSpaceKind', 'studio'); await page.click('#newSpaceAdd');
  await until(page, 'S.spaces.length === 3 && curSpace().name === "Family" && curSpace().kind === "studio"');
  assert.deepEqual(await page.$$eval('.spaces button', (b: any[]) => b.map((x) => [x.textContent, x.classList.contains('on')])), [['Life', false], ['Studio', false], ['Family', true]]);
  // order: the arrows, and dragging by the handle
  const tabs = () => page.$$eval('.spaces button', (b: any[]) => b.map((x) => x.textContent));
  await S(page, 'go("admin")'); await page.waitForSelector('.ad-space >> nth=2');
  assert.match(await page.textContent('.ad-space >> nth=2'), /By seriesFamily0 items, 1 person/);
  await page.click('.ad-space >> nth=2'); await page.waitForSelector('#adSpace'); assert.equal(await page.inputValue('#adSpaceName'), 'Family'); assert.match(await page.textContent('#adSpace'), /Name.*Arranged.*People.*Holds.*Order.*Tab 3 of 3/s);
  await page.click('#adSpace [aria-label="Move Family up"]'); await until(page, 'S.spaces.map(s => s.name).join() === "Life,Family,Studio"');
  assert.deepEqual(await tabs(), ['Life', 'Family', 'Studio']);
  await until(page, 'document.querySelectorAll(".ad-space .ad-ch")[1].textContent === "Family"', 10000); // the page has redrawn in the new order
  assert.match(await page.textContent('#adSpace'), /Tab 2 of 3/, 'the window stays open on the same space'); await S(page, 'Admin.closeModal()');
  await page.evaluate(() => document.querySelector('#adSpaces')!.scrollIntoView({ block: 'center' })); // both cards in sight, so nothing scrolls mid-drag
  await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 15000 }); // messages from the steps before no longer cover the handle
  const [g, t] = [await page.locator('.ad-space >> nth=2 >> .ad-grip').boundingBox(), await page.locator('.ad-space >> nth=0').boundingBox()];
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + 6, g.y + g.height / 2 - 8, { steps: 3 }); await page.mouse.move(t.x + 60, t.y + t.height / 2, { steps: 6 }); await page.mouse.up();
  await until(page, 'S.spaces.map(s => s.name).join() === "Studio,Life,Family"'); assert.deepEqual(await tabs(), ['Studio', 'Life', 'Family']);
  await page.reload(); await page.waitForSelector('.spaces button'); assert.deepEqual(await tabs(), ['Studio', 'Life', 'Family'], 'the order is kept on the server');
  // eight spaces at 1280 px: the tabs scroll sideways and everything else keeps its place
  for (const name of ['Clients', 'Prints', 'Scans', 'Travel', 'Archive of older work']) await page.evaluate(async (name: string) => { await api('POST', '/api/spaces', { name }); }, name);
  const fits = async (p: any, width: number) => {
    await p.waitForFunction(() => document.querySelectorAll('.spaces button').length === 8);
    const [lens, add, up, me, on, box] = await p.evaluate(() => ['.lens', '#btnAddSpace', '#btnUpload', '#btnMe', '.spaces button.on', '.spaces'].map((s) => { const q = document.querySelector(s)!.getBoundingClientRect(); return { left: q.left, right: q.right, width: q.width }; }));
    const m = { lens, add, up, me, on, box, ...(await p.evaluate(() => ({ scrolls: document.querySelector('.spaces')!.scrollWidth > document.querySelector('.spaces')!.clientWidth, page: document.documentElement.scrollWidth }))) };
    assert.ok(m.page <= width, 'no sideways scrolling of the page at ' + width);
    for (const k of ['lens', 'add', 'up', 'me'] as const) assert.ok(m[k].left >= 0 && m[k].right <= width && m[k].width > 0, `${k} is on the screen at ${width}`);
    assert.ok(m.lens.width >= 200, `the search box keeps a usable width at ${width}: ${Math.round(m.lens.width)}`);
    assert.equal(m.scrolls, true, 'the tabs scroll sideways at ' + width);
    assert.ok(m.on.left >= m.box.left - 1 && m.on.right <= m.box.right + 1, 'the space in use is in sight');
  };
  const wide = await newPage({ width: 1280, height: 800 });
  await wide.goto(app.base); await wide.fill('#gateCard input[type=email]', 'owner@example.com'); await wide.fill('#gateCard input[type=password]', PASSWORD); await wide.click('#gateCard button[type=submit]'); await wide.waitForSelector('.spaces button');
  await fits(wide, 1280); await wide.click('.spaces button >> nth=7'); await fits(wide, 1280); await shot(wide, '07b-eight-spaces');
  // a phone held sideways is wider than a phone but has no room for tabs: they become a menu, and nothing in the top bar overlaps
  await wide.setViewportSize({ width: 844, height: 390 }); await wide.waitForTimeout(300);
  assert.ok(await wide.isVisible('#spaceSel'), 'the spaces are a menu when held sideways');
  const line = await wide.evaluate(() => ['.top .brand', '#spaceSel', '#btnAddSpace', '.views', '.lens', '#btnUpload', '#btnMe'].map((q) => { const r = document.querySelector(q)!.getBoundingClientRect(); return [q, Math.round(r.left), Math.round(r.right)] as [string, number, number]; }));
  line.forEach((r, i) => { assert.ok(r[2] > r[1], r[0] + ' has a width'); if (i) assert.ok(r[1] >= line[i - 1]![2], `${r[0]} starts after ${line[i - 1]![0]}: ${JSON.stringify(line)}`); }); assert.ok(line[6]![2] <= 844, JSON.stringify(line));
  await shot(wide, '07d-eight-spaces-sideways');
  // on a phone eight tabs would push the account button off the screen, so the spaces become a menu
  await wide.setViewportSize({ width: 390, height: 844 }); await wide.waitForTimeout(300);
  assert.ok(await wide.isVisible('#spaceSel'), 'the spaces are a menu'); assert.equal(await wide.locator('#spaceSel option').count(), 8);
  assert.equal(await wide.inputValue('#spaceSel'), await S(wide, 'S.space'), 'showing the space in use');
  const me8 = await wide.locator('#btnMe').boundingBox(), up8 = await wide.locator('#btnUpload').boundingBox();
  assert.ok(me8.x + me8.width <= 390 && me8.y < 70 && Math.abs(me8.y + me8.height / 2 - (up8.y + up8.height / 2)) < 6 && up8.x < me8.x, 'the account button is at the top right, beside Add');
  assert.ok(await wide.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'nothing is wider than the screen');
  const other = await S(wide, 'S.spaces[2].id') as string; await wide.selectOption('#spaceSel', other); await until(wide, `S.space === "${other}"`); assert.equal(await wide.inputValue('#spaceSel'), other);
  await shot(wide, '07c-eight-spaces-phone');
  await wide.context().close();
  // back to the two the rest of this run expects
  await page.evaluate(async () => { const b = await api('GET', '/api/bootstrap'); for (const s of b.spaces) if (!['Life', 'Studio'].includes(s.name)) await api('DELETE', '/api/spaces/' + s.id); const left = (await api('GET', '/api/bootstrap')).spaces; await api('POST', '/api/spaces/order', { ids: ['Life', 'Studio'].map(n => left.find((s: any) => s.name === n).id) }); });
  await page.reload(); await page.waitForSelector('#grid .tile'); assert.deepEqual(await tabs(), ['Life', 'Studio']);
});

await step('what a worker read fills the page: scenes, things in the picture, search, the viewer and story drafts, and a person can correct any of it', async () => {
  await S(page, 'go("library")'); await S(page, 'Lib.clear()');
  // before any worker: no scenes, nothing "in the picture", and the site is fully usable
  assert.equal(await page.locator('#facets .f-scene, #facets .f-thing').count(), 0);
  const made = await page.evaluate(inPage('api("POST", "/api/admin/workers", { name: "Garage" })')) as any;
  const fw = new FakeWorker(app.base, made.token);
  let n = 0;
  const seen = () => { n++; return n % 2 ? { caption: 'A fishing boat pulled up on pale sand.', scene: 'beach', objects: [{ label: 'boat', confidence: 0.92 }, { label: 'sand', confidence: 0.71 }], text: 'PESCADOR 7' } : { caption: 'Tall cactus on a dry hillside.', scene: 'desert', objects: [{ label: 'cactus', confidence: 0.88 }, { label: 'rock', confidence: 0.4 }], text: '' }; };
  for (let k = 0; k < 20; k++) { if (!(await fw.work(seen)).length) break; }
  await S(page, 'Sync.poll()'); await until(page, 'S.items.filter(i => i.status === "ready").every(i => i.ai.status === "done")');
  // the two filters come alive, in blue
  await page.waitForSelector('#facets .f-scene .fval.ai'); await page.waitForSelector('#facets .f-thing .fval.ai');
  assert.deepEqual((await page.$$eval('#facets .f-scene .fval span:first-child', (e: HTMLElement[]) => e.map((x) => x.textContent))).sort(), ['beach', 'desert']);
  assert.deepEqual((await page.$$eval('#facets .f-thing .fval span:first-child', (e: HTMLElement[]) => e.map((x) => x.textContent))).sort(), ['boat', 'cactus', 'rock', 'sand']);
  const beach = await S(page, 'Lib.inSpace().filter(i => i.ai.scene === "beach").length') as number, desert = await S(page, 'Lib.inSpace().filter(i => i.ai.scene === "desert").length') as number, all = await S(page, 'Lib.inSpace().length') as number; assert.ok(beach > 0 && desert > 0);
  // the filter sections: closed until opened, except the first, and a closed one still shows what is switched on
  await page.evaluate(() => { (window as any).__folded = 1; localStorage.removeItem('afterimage.facetsOpen'); }); await S(page, 'Lib.renderFacets()');
  assert.deepEqual(await page.$$eval('#facets .facet-head', (h: HTMLElement[]) => [...new Set(h.map((x) => x.getAttribute('aria-expanded')))]), ['false']);
  assert.ok(await page.isVisible('#facets .f-flag .fval'), 'the first section is always open'); assert.equal(await page.locator('#facets .facet:not(.f-flag) .fval').count(), 0);
  assert.equal(await page.textContent('#facets .f-scene .facet-n'), '2');
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('#facets .facet-head')].every((h) => getComputedStyle(h).backgroundColor !== getComputedStyle(document.querySelector('#facets')!).backgroundColor)), 'each heading is a band of its own color');
  await page.click('#facets .f-scene .facet-head'); await page.waitForSelector('#facets .f-scene .fval'); assert.equal(await page.getAttribute('#facets .f-scene .facet-head', 'aria-expanded'), 'true'); assert.equal(await page.locator('#facets .f-thing .fval').count(), 0);
  await page.click('#facets .f-scene .fval:has-text("beach")'); await page.click('#facets .f-scene .facet-head');
  assert.deepEqual(await page.$$eval('#facets .f-scene .fval', (e: HTMLElement[]) => e.map((x) => x.querySelector('span')!.textContent)), ['beach'], 'closed, it keeps the one that is on');
  assert.equal(await page.textContent('#facets .f-scene .facet-n'), '1 on'); await shot(page, '08b-filter-sections');
  await page.click('#facets .f-scene .facet-head'); assert.equal(await S(page, 'localStorage.getItem("afterimage.facetsOpen")'), '["scene"]'); await S(page, 'Lib.clear()');
  await page.evaluate(() => { localStorage.setItem('afterimage.facetsOpen', '["year","place","spot","person","scene","thing","color","tag","cam","series"]'); }); await S(page, 'Lib.renderFacets()');
  await page.click('#facets .f-scene .fval:has-text("beach")'); assert.match(await page.textContent('#libCount'), new RegExp(`^${beach} of ${all}`));
  assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('#facets .f-scene .fval.on')!).backgroundColor), /77, 125, 255/, 'a machine filter is blue when on');
  await S(page, 'Lib.clear()'); await page.click('#facets .f-thing .fval:has-text("cactus")'); assert.match(await page.textContent('#libCount'), new RegExp(`^${desert} of ${all}`)); await S(page, 'Lib.clear()');
  // search finds words from a caption, and words the worker read in the picture
  await page.fill('#lensInput', 'hillside'); await page.keyboard.press('Enter'); await page.waitForTimeout(200); assert.match(await page.textContent('#libCount'), new RegExp(`^${desert} of ${all}`)); await S(page, 'Lib.clear()');
  await page.fill('#lensInput', 'pescador'); await page.keyboard.press('Enter'); await page.waitForTimeout(200); assert.match(await page.textContent('#libCount'), new RegExp(`^${beach} of ${all}`)); await S(page, 'Lib.clear()'); await page.fill('#lensInput', '');
  // the viewer: what the machine said is blue, with its confidence
  const id = await S(page, 'Lib.inSpace().find(i => i.ai.text === "PESCADOR 7").id') as string;
  await page.evaluate(() => (document.activeElement as HTMLElement).blur()); await S(page, `Viewer.open("${id}")`); await page.waitForSelector('#viAi');
  assert.match(await page.textContent('#viAi h4'), /Seen by your worker/); assert.equal(await page.textContent('#viAi .ai-cap'), 'A fishing boat pulled up on pale sand.');
  assert.match(await page.textContent('#viAi .ai-by'), /Written by the worker\./); assert.equal(await page.textContent('#viAiText'), 'Text in the picture: PESCADOR 7');
  assert.deepEqual(await page.$$eval('#viAiChips .chipw .chip', (e: HTMLElement[]) => e.map((x) => [x.textContent, x.classList.contains('ai'), x.classList.contains('mine')])), [['beach', true, false], ['boat', true, false], ['sand', true, false]]);
  assert.match(await page.getAttribute('#viAiChips .chip:has-text("boat")', 'title'), /Seen by the worker\. Confidence 92%\./);
  const blue = await page.evaluate(() => [getComputedStyle(document.querySelector('#viAi .ai-cap')!).boxShadow, getComputedStyle(document.querySelector('#viAiChips .chip.ai.strong')!).borderColor]); assert.match(blue[0]!, /77, 125, 255/); assert.match(blue[1]!, /77, 125, 255/);
  await shot(page, '08a-worker-read');
  // "More like this" uses the scene and the things
  assert.ok(await page.locator('#vwInfo .simgrid .sim').count() > 0);
  // a person corrects the caption, the scene and a label, and adds one. What a person said is amber.
  await page.click('#viAiCapEdit'); await page.fill('#viAi .ai-edit', 'Our panga, the Pescador, on the beach at dawn.'); await page.click('#viAi .ai-capedit .btn.primary'); await page.waitForSelector('#viAi .ai-cap.mine');
  assert.match(await page.textContent('#viAi .ai-by'), /Corrected by a person\./);
  await page.click('#viAiScene'); assert.ok(await page.locator('.pop .menu.scenes .mi').count() > 20); await page.click('.pop .menu.scenes .mi:has-text("coast")'); await page.waitForSelector('#viAiChips .chip.mine.strong:has-text("coast")');
  await page.click('#viAiChips [aria-label="Remove sand"]'); await page.waitForSelector('#viAiChips .chip:has-text("sand")', { state: 'detached' });
  await page.fill('#viAiAdd', 'Panga'); await page.press('#viAiAdd', 'Enter'); await page.waitForSelector('#viAiChips .chip.mine:has-text("panga")');
  const amber = await page.evaluate(() => [getComputedStyle(document.querySelector('#viAi .ai-cap.mine')!).boxShadow, getComputedStyle(document.querySelector('#viAiChips .chip.mine.strong')!).borderColor]); assert.match(amber[0]!, /255, 178, 36/); assert.match(amber[1]!, /255, 178, 36/);
  await shot(page, '08b-corrected');
  // the library is read again by another model. The corrections stand, and what was removed does not come back
  await page.evaluate(inPage('api("POST", "/api/admin/workers/redo", { task: "caption" })'));
  for (let k = 0; k < 20; k++) { if (!(await fw.work(() => ({ caption: 'A second reading.', scene: 'beach', objects: [{ label: 'sand', confidence: 0.99 }, { label: 'boat', confidence: 0.5 }, { label: 'gull', confidence: 0.6 }], text: 'PESCADOR 7' }), ['caption'], { name: 'second-vision', version: '2' })).length) break; }
  await page.keyboard.press('Escape'); await page.waitForSelector('#viewer', { state: 'hidden' }); await page.reload(); await page.waitForSelector('#grid .tile');
  await S(page, `Viewer.open("${id}")`); await page.waitForSelector('#viAi');
  assert.equal(await page.textContent('#viAi .ai-cap'), 'Our panga, the Pescador, on the beach at dawn.');
  assert.deepEqual(await page.$$eval('#viAiChips .chipw .chip', (e: HTMLElement[]) => e.map((x) => [x.textContent, x.classList.contains('mine')])), [['coast', true], ['panga', true], ['gull', false], ['boat', false]]);
  await page.keyboard.press('Escape'); await page.waitForSelector('#viewer', { state: 'hidden' });
  // a story part can be drafted from the captions, and the draft is the author's to rewrite
  await S(page, 'go("stories")'); await page.waitForSelector('.st-card'); await page.click('.st-card >> nth=0'); await page.waitForSelector('#reader:not([hidden]) .rd-ch');
  await page.click('.rd-ch >> nth=0 >> .linkbtn.ai'); await page.waitForSelector('.toast:has-text("Draft added")');
  assert.match(await page.inputValue('.rd-ch >> nth=0 >> .rd-note'), /A second reading\.|Our panga/);
  await page.fill('.rd-ch >> nth=0 >> .rd-note', ''); await page.waitForTimeout(700); await page.click('.rd-bar .modal-x'); await page.waitForSelector('#reader', { state: 'hidden' }); await S(page, 'go("library")'); await page.waitForSelector('#grid .tile');
  await page.evaluate(inPage(`api("DELETE", "/api/admin/workers/${made.id}")`));
});

await step('search finds pictures by meaning under the exact matches, More like this goes by looks, and near duplicates are shown for a person to decide', async () => {
  await S(page, 'go("library")'); await S(page, 'Lib.clear()');
  // the words someone types become numbers on the server. Here a stand-in does it: anything about boats points one way, everything else nowhere.
  const dim = 64, unit = (...n: number[]) => { const f = new Float32Array(dim); n.forEach((x, i) => { f[i] = x; }); return f; };
  app.ctx.embedText = async (q: string) => (/boat/.test(q) ? unit(1) : (() => { const f = new Float32Array(dim); f[dim - 1] = 1; return f; })());
  const made = await page.evaluate(inPage('api("POST", "/api/admin/workers", { name: "Garage" })')) as any, fw = new FakeWorker(app.base, made.token);
  // three pictures of "boats": two taken a minute apart that look almost the same, and a third that is merely alike
  const [A, B, C] = await S(page, 'Lib.inSpace().filter(i => i.kind === "photo" && !i.copyOf && i.status === "ready").slice(0, 3).map(i => i.id)') as string[];
  await page.evaluate(inPage(`Promise.all([api("PATCH", "/api/items/${A}", { d: "2021-06-01T10:00:00" }), api("PATCH", "/api/items/${B}", { d: "2021-06-01T10:01:00" }), api("PATCH", "/api/items/${C}", { d: "2021-06-01T15:00:00" })])`));
  const looks: Record<string, Float32Array> = { [A!]: unit(1), [B!]: unit(0.97, 0.2431), [C!]: unit(0.96, 0, 0.28) };
  let k = 3;
  for (let round = 0; round < 20; round++) {
    const ids = await fw.work((it: any) => { const f = looks[it.id] ?? (() => { const u = new Float32Array(dim); u[++k % (dim - 2) + 1] = 1; u[(k * 7) % (dim - 2) + 1] += 0.5; return u; })(); return { dim, vector: Buffer.from(f.buffer).toString('base64') }; }, ['embed'], { name: app.cfg.EMBED_MODEL, version: 'e2e' });
    if (!ids.length) break;
  }
  await S(page, 'Sync.full().then(() => Lib.refresh())');
  // typing words no title, tag or caption holds: nothing matches exactly, and three pictures are found by meaning, under a heading of their own
  await page.fill('#lensInput', 'boats at dusk'); await page.keyboard.press('Enter'); await page.waitForSelector('#meaningHead');
  const all = await S(page, 'Lib.inSpace().length') as number;
  assert.match(await page.textContent('#libCount'), new RegExp(`^0 of ${all}, and 3 by meaning$`));
  assert.match(await page.textContent('#meaningHead'), /By meaning\s*3 more items that fit “boats at dusk” by what they show\. The best match is first\./);
  assert.deepEqual(await page.$$eval('#grid .tile', (t: HTMLElement[]) => t.map((x) => x.dataset.id)), [A, B, C], 'best match first');
  assert.ok(await page.isHidden('#emptyLib'), 'the page does not say nothing matches');
  assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('#meaningHead h3')!).color), /^rgb\((1[0-9]{2}|[0-9]{2}), 1[0-9]{2}, 2[0-9]{2}\)$/, 'found by a machine, so it is blue');
  await shot(page, '08c-by-meaning');
  // an exact match stays on top, and the same picture is not listed twice
  await page.evaluate(inPage(`api("PATCH", "/api/items/${C}", { title: "Boats at dusk" })`)); await S(page, 'Sync.full().then(() => Lib.refresh())');
  await until(page, 'document.querySelectorAll("#grid .tile").length === 3 && document.querySelector("#grid .tile").dataset.id === "' + C + '"');
  assert.match(await page.textContent('#libCount'), new RegExp(`^1 of ${all}, and 2 by meaning$`));
  assert.deepEqual(await page.$$eval('#grid .tile', (t: HTMLElement[]) => t.map((x) => x.dataset.id)), [C, A, B]);
  // words that fit nothing: no heading, and the usual message
  await S(page, 'Lib.clear()'); await page.fill('#lensInput', 'zebra crossing'); await page.keyboard.press('Enter'); await page.waitForTimeout(500);
  assert.equal(await page.$('#meaningHead'), null); assert.ok(await page.isVisible('#emptyLib'));
  await S(page, 'Lib.clear()'); await page.fill('#lensInput', ''); await page.evaluate(inPage(`api("PATCH", "/api/items/${C}", { title: "" })`));
  // More like this, by what the pictures look like
  await page.evaluate(() => (document.activeElement as HTMLElement).blur()); await S(page, `Viewer.open("${A}")`); await page.waitForSelector('#viSim[data-by=look] .sim');
  assert.deepEqual(await S(page, `S.byId.get("${A}")._sim.items.map(i => i.id).slice(0, 2)`), [B, C]);
  // this picture has a near duplicate, and the viewer says so
  await S(page, 'Dupes.load(true)'); await until(page, `S.byId.get("${A}").dup > 0`); await S(page, 'Viewer.info(true)');
  assert.match(await page.textContent('#viDupes'), /One other picture looks almost the same as this one\./); assert.ok(await page.$('#viDupKeep'));
  await page.keyboard.press('Escape'); await page.waitForSelector('#viewer', { state: 'hidden' });
  // the quick filter shows each group together, marks the best one, and removes nothing until asked
  await page.click('#facets .f-flag .fval:has-text("Near duplicates")'); await page.waitForSelector('#dupBar');
  assert.match(await page.textContent('#dupBar'), /1 group of near duplicates, 2 items\./); assert.match(await page.textContent('#grid .ghead .gmeta'), /^2 look-alikes/);
  assert.deepEqual((await page.$$eval('#grid .tile', (t: HTMLElement[]) => t.map((x) => x.dataset.id))).sort(), [A, B].sort());
  assert.equal(await page.locator('#grid .tile .bdg.best').count(), 1); const kept = await page.locator('#grid .tile:has(.bdg.best)').getAttribute('data-id');
  await shot(page, '08d-near-duplicates');
  assert.equal(await S(page, 'Lib.inSpace().length'), all, 'nothing was removed by looking');
  await page.click('#dupKeep'); assert.match(await page.textContent('.pop .confirm'), /Move 1 item to the trash and keep the best of each group\?/); await page.click('.pop .btn.danger');
  await page.waitForSelector('.toast:has-text("Moved 1 item to the trash")'); await until(page, `S.items.filter(i => i.space === S.space).length === ${all - 1}`);
  assert.ok(await S(page, `S.byId.has("${kept}")`), 'the best one stays');
  // put it back, so the rest of this run finds the library as it was
  await page.evaluate(inPage(`api("POST", "/api/trash/restore", { ids: ["${kept === A ? B : A}"] })`)); await S(page, 'Lib.clear()'); await S(page, 'Sync.full().then(() => Lib.refresh())'); await until(page, `Lib.inSpace().length === ${all}`);
  await page.evaluate(inPage(`api("DELETE", "/api/admin/workers/${made.id}")`)); app.ctx.embedText = null;
});

await step('people: the owner turns recognition on, names a group of faces, answers a suggestion with a key, sees people in the library and the viewer, and can undo an automatic name', async () => {
  await S(page, 'go("library")'); await S(page, 'Lib.clear()');
  assert.ok(await page.isVisible('.views [data-view=people]'), 'the owner has a People page');
  // the People tab says it is off and points to People and settings, where the switch and the naming are
  await page.click('.views [data-view=people]'); await page.waitForSelector('#ppvOff'); assert.match(await page.textContent('#ppvOff'), /People recognition is off for Life\./);
  await page.click('#ppToSettings'); await page.waitForSelector('#adModal #ppOff');
  assert.match(await page.textContent('#adFaces'), /People in the pictures.*In Life, the space you are in.*People recognitionOff/s); assert.equal(await page.locator('#adFaces .ad-card').count(), 1);
  assert.match(await page.textContent('#ppOff'), /People recognition is off for Life\..*Only the owner and editors see them\./);
  await page.click('#ppOn'); await page.waitForSelector('#ppTabs'); assert.deepEqual(await page.$$eval('#adFaces .ad-card .ad-ct b', (h: HTMLElement[]) => h.map((x) => x.textContent)), ['Name faces', 'Automatic naming', 'People recognition']);
  await card(page, 'recog'); assert.match(await page.textContent('#ppCounts'), /^0 faces found in Life/);
  // a worker reads four pictures: Maria is in three of them, Juan in two, and a stranger in one
  const made = await page.evaluate(inPage('api("POST", "/api/admin/workers", { name: "Garage" })')) as any, fw = new FakeWorker(app.base, made.token);
  const pics = await S(page, 'Lib.inSpace().filter(i => i.kind === "photo" && !i.copyOf && i.status === "ready").slice(0, 5).map(i => i.id)') as string[];
  const fv = (who: number, shot: number) => { const f = new Float32Array(64); f[who] = 1; f[shot] = 0.2; return Buffer.from(f.buffer).toString('base64'); };
  const face = (who: number, shot: number, x: number, quality = 0.8) => ({ box: [x, 0.25, 0.22, 0.3], score: 0.9, quality, vector: fv(who, shot) });
  const seen: Record<string, unknown[]> = { [pics[0]!]: [face(0, 10, 0.1, 0.95), face(1, 20, 0.6)], [pics[1]!]: [face(0, 11, 0.3), face(2, 30, 0.7, 0.3)], [pics[2]!]: [face(0, 12, 0.2), face(1, 21, 0.55)], [pics[3]!]: [] };
  const read = async () => { for (let k = 0; k < 30; k++) { const got = await fw.work((it: any) => ({ w: 1000, h: 800, faces: seen[it.id] ?? [] }), ['faces'], { name: 'e2e-faces', version: '1' }); if (!got.length && k > 1) break; } };
  await read();
  await S(page, 'Naming.refresh()'); await until(page, '/6 faces found in Life: 0 named by a person, 0 named automatically, 6 waiting to be named/.test((document.querySelector("#ppCounts") || {}).textContent || "")');
  assert.match(await page.textContent('#adFaces [data-card=faces]'), /Name faces6 to name0 people/);
  // the workspace: a tab for each kind of work, opening on the first that has something in it
  await card(page, 'faces'); await page.waitForSelector('#ppGroups .pp-group >> nth=1');
  assert.deepEqual(await page.$$eval('#ppTabs button', (b: HTMLElement[]) => b.map((x) => [x.textContent, x.classList.contains('on')])), [['Questions0', false], ['To name6', true], ['Named automatically0', false], ['People0', false]]);
  assert.deepEqual(await page.$$eval('#ppGroups .pp-group', (g: HTMLElement[]) => g.map((x) => x.querySelectorAll('.face').length)), [3, 2], 'the largest group first'); assert.equal(await page.locator('.pp-singles .face').count(), 1);
  // a face is a detail of a picture: it keeps the shape of its own box and has square corners
  await until(page, '[...document.querySelectorAll("#ppGroups .face")].every(i => i.complete && i.naturalWidth > 0)');
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('#ppGroups .face')].every((i) => { const im = i as HTMLImageElement, r = im.getBoundingClientRect(), cs = getComputedStyle(im); return Math.abs(r.width / r.height - im.naturalWidth / im.naturalHeight) < 0.03 && cs.objectFit !== 'cover' && cs.borderRadius === '0px'; })));
  // leave one face out, then name the rest with one name
  await page.click('#ppGroups .pp-group >> nth=0 >> .pp-facebtn >> nth=2'); assert.match(await page.textContent('#ppGroups .pp-group >> nth=0 >> .pp-gacts .muted'), /^2 faces$/);
  await page.fill('#ppGroups .pp-group >> nth=0 >> input', 'Maria'); await page.press('#ppGroups .pp-group >> nth=0 >> input', 'Enter');
  await until(page, 'document.querySelector("#ppTab-named i").textContent === "1"'); await page.click('#ppTab-named');
  await page.waitForSelector('#ppNamed .pp-person'); assert.match(await page.textContent('#ppNamed .pp-person small'), /^2 faces$/); assert.equal(await page.inputValue('#ppNamed .pp-name'), 'Maria');
  // the face that was left out comes back as a question, answered from the keyboard
  await page.click('#ppTab-ask'); await page.waitForSelector('#ppReview'); assert.equal(await page.textContent('#ppAsk'), 'Is this Maria?'); assert.match(await page.textContent('#ppReview .ai-note'), /Suggested by the worker, 9\d% alike\. 1 question waiting\./);
  await shot(page, '09a-people');
  await page.evaluate(() => (document.activeElement as HTMLElement).blur()); await page.keyboard.press('y');
  // with no question left the workspace goes back to the faces still to name
  await page.waitForSelector('#ppGroups .pp-group'); assert.equal(await page.$('#ppReview'), null); assert.equal(await page.textContent('#ppTab-ask i'), '0');
  await page.fill('#ppGroups .pp-group >> nth=0 >> input', 'Juan'); await page.click('#ppGroups .pp-group >> nth=0 >> .btn.primary'); await until(page, 'document.querySelector("#ppTab-named i").textContent === "2"');
  // faces seen once are chosen by clicking, any number of them, and the bar above them acts on all that are chosen
  await page.waitForSelector('#ppSingles .pp-facebtn'); assert.equal(await page.textContent('#ppPickN'), 'None chosen'); assert.ok(await page.isDisabled('#ppPickGo') && await page.isDisabled('#ppPickIgnore') && await page.isDisabled('#ppPickNot'));
  await page.click('#ppSingles .pp-facebtn'); assert.equal(await page.textContent('#ppPickN'), '1 chosen'); assert.ok(await page.isEnabled('#ppPickGo') && await page.isEnabled('#ppPickIgnore')); assert.ok(await page.isVisible('#ppPickOpen')); assert.ok(await page.$('#ppSingles .pp-facebtn.sel'));
  // its picture opens on top of the workspace and the settings page, and Escape closes the picture only
  await page.click('#ppPickOpen'); await page.waitForSelector('#viewer:not([hidden])');
  assert.ok(await page.evaluate(() => { const e = document.elementFromPoint(innerWidth / 2 - 150, innerHeight / 2); return !!e && !!e.closest('#viewer'); }), 'the picture is in front');
  await page.keyboard.press('Escape'); await page.waitForSelector('#viewer', { state: 'hidden' }); assert.ok(await page.isVisible('#adModal #ppSingles'), 'the workspace is still open behind it');
  await page.click('#ppSingles .pp-facebtn'); assert.equal(await page.textContent('#ppPickN'), 'None chosen'); await page.click('#ppPickAll'); assert.equal(await page.textContent('#ppPickN'), '1 chosen'); assert.equal(await page.textContent('#ppPickAll'), 'Choose none'); await page.click('#ppPickAll');
  await shot(page, '09a2-faces-to-name');
  await page.click('#ppTab-named'); await page.waitForSelector('#ppNamed .pp-person >> nth=1'); assert.deepEqual((await page.$$eval('#ppNamed .pp-person small', (e: HTMLElement[]) => e.map((x) => x.textContent))).sort(), ['2 faces', '3 faces']);
  // the numbers come before the switch
  assert.match(await page.textContent('#adFaces [data-card=auto]'), /Automatic namingOff/); await card(page, 'auto');
  assert.match(await page.textContent('#ppAutoBox'), /It is off\./); assert.deepEqual(await page.$$eval('#ppAutoBox .pp-nums th', (t: HTMLElement[]) => t.map((x) => x.textContent)), ['Threshold', 'Named right', 'Named wrong', 'Left to ask']);
  assert.equal(await page.locator('#ppAutoBox .pp-nums tbody tr').count(), 8); assert.match(await page.textContent('#ppAutoBox'), /on the 5 faces you have confirmed/);
  // the People tab: a card for each person, and that person's pictures when one is chosen, every one whole
  await S(page, 'Sync.full().then(() => Lib.refresh())'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.waitForSelector('#admin', { state: 'hidden' });
  await page.click('.views [data-view=people]'); await page.waitForSelector('#ppvPeople .pp-card >> nth=1');
  assert.deepEqual(await page.$$eval('#ppvPeople .pp-card', (c: HTMLElement[]) => c.map((x) => [x.querySelector('b')!.textContent, x.querySelector('small')!.textContent])), [['Maria', '3 pictures'], ['Juan', '2 pictures']], 'whoever is in the most pictures comes first');
  assert.equal(await page.$('#ppPics'), null, 'no pictures until someone is chosen'); assert.equal(await page.$('#v-people #ppGroups'), null, 'the naming is not on this page');
  await page.click('#ppvPeople .pp-card:has-text("Maria")'); await page.waitForSelector('#ppPics .pp-pic img.in');
  assert.match(await page.textContent('#ppSel'), /^Maria3 pictures/); assert.equal(await page.locator('#ppPics .pp-pic').count(), 3);
  assert.deepEqual((await page.$$eval('#ppPics .pp-pic', (t: HTMLElement[]) => t.map((x) => x.dataset.id))).sort(), [pics[0], pics[1], pics[2]].sort());
  await until(page, '[...document.querySelectorAll("#ppPics .pp-pic img")].every(i => i.complete && i.naturalWidth > 0)');
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('#ppPics .pp-pic')].every((t) => { const r = t.getBoundingClientRect(), im = t.querySelector('img') as HTMLImageElement, cs = getComputedStyle(im); return Math.abs(r.width / r.height - im.naturalWidth / im.naturalHeight) < 0.04 && cs.objectFit !== 'cover' && cs.borderRadius === '0px'; })), 'every picture keeps its own shape');
  await shot(page, '09c-people-tab');
  await page.click('#ppPics .pp-pic >> nth=0'); await page.waitForSelector('#viewer:not([hidden])'); await page.keyboard.press('Escape'); await page.waitForSelector('#viewer', { state: 'hidden' });
  await page.click('#ppvPeople .pp-card:has-text("Juan")'); await until(page, 'document.querySelectorAll("#ppPics .pp-pic").length === 2');
  await page.click('#ppAll'); await page.waitForSelector('#ppPics', { state: 'detached' });
  // the library filters and searches by person, for the owner
  await S(page, 'go("library")'); await page.waitForSelector('#facets .f-person .fval');
  assert.deepEqual((await page.$$eval('#facets .f-person .fval', (e: HTMLElement[]) => e.map((x) => x.textContent))).sort(), ['Juan2', 'Maria3']);
  await page.click('#facets .f-person .fval:has-text("Maria")'); assert.match(await page.textContent('#libCount'), /^3 of \d+/); await S(page, 'Lib.clear()');
  await page.fill('#lensInput', 'juan'); await page.keyboard.press('Enter'); await page.waitForTimeout(200); assert.match(await page.textContent('#libCount'), /^2 of \d+/); await S(page, 'Lib.clear()'); await page.fill('#lensInput', '');
  // the viewer: a chip for every face, amber for a name a person gave, and the face outlined while the pointer rests on its chip
  await page.evaluate(() => (document.activeElement as HTMLElement).blur()); await S(page, `Viewer.open("${pics[1]}")`); await page.waitForSelector('#viPeople .chip');
  assert.ok(await page.evaluate(() => { const p = document.querySelector('#viPeople')!, a = document.querySelector('#viAi'); return !a || !!(p.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'people come before what the worker saw');
  assert.deepEqual(await page.$$eval('#viPeople .fvals > *', (e: HTMLElement[]) => e.map((x) => [x.textContent, !!x.querySelector('.chip.mine')])), [['Maria', true], ['Who is this?', false]]);
  await page.hover('#viPeople .chip.mine'); await page.waitForSelector('#vwFaceBox');
  const at = await S(page, '(() => { const r = Viewer.rect(), f = document.querySelector("#vwFrame").getBoundingClientRect(), b = document.querySelector("#vwFaceBox").getBoundingClientRect(); return [(b.left - f.left - r.x) / r.w, (b.top - f.top - r.y) / r.h, b.width / r.w, b.height / r.h]; })()') as number[];
  assert.ok(Math.abs(at[0]! - 0.3) < 0.02 && Math.abs(at[1]! - 0.25) < 0.02 && Math.abs(at[2]! - 0.22) < 0.02 && Math.abs(at[3]! - 0.3) < 0.02, 'the outline sits on the face: ' + at.map((n) => n.toFixed(2)).join(' '));
  await shot(page, '09b-viewer-people');
  await page.mouse.move(5, 5); await page.waitForSelector('#vwFaceBox', { state: 'detached' });
  await page.keyboard.press('Escape'); await page.waitForSelector('#viewer', { state: 'hidden' });
  // automatic naming, once the owner turns it on: a new face of Maria is named without asking, marked as automatic, and can be undone
  await S(page, 'go("admin")'); await card(page, 'auto'); await page.waitForSelector('#ppAutoSwitch'); await page.click('#ppAutoSwitch'); await page.waitForSelector('.toast:has-text("Automatic naming is on")');
  seen[pics[4]!] = [face(0, 13, 0.4)]; await page.evaluate(inPage('api("POST", "/api/admin/workers/redo", { task: "faces" })')); await read();
  await S(page, 'Naming.refresh()'); await until(page, '/1 to check/.test(document.querySelector("#adFaces [data-card=faces]").textContent)'); assert.match(await page.textContent('#adFaces [data-card=auto]'), /On at \d+%1 named without asking/);
  await card(page, 'faces'); await page.click('#ppTab-check'); await page.waitForSelector('#ppAuto .pp-auto'); assert.equal(await page.textContent('#ppAutoAll'), 'All 1 are right');
  assert.match(await page.textContent('#ppAuto .pp-auto'), /Maria\s*Named automatically, 9\d% alike/); assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('#ppAuto .ai-note')!).color), /^rgb\((1[0-9]{2}|[0-9]{2}), 1[0-9]{2}, 2[0-9]{2}\)$/);
  await page.click('#ppAuto .pp-auto button:has-text("Undo")'); await page.waitForSelector('.toast:has-text("more careful about Maria")'); await page.waitForSelector('#ppAuto', { state: 'detached' });
  // several faces seen once are named in one go: choose them all, type the name, press Name
  await page.click('#ppTab-todo'); await page.waitForSelector('#ppSingles .pp-facebtn'); const lone = await page.locator('#ppSingles .pp-facebtn').count(); const had = Number(await page.textContent('#ppTab-named i'));
  await page.click('#ppPickAll'); assert.equal(await page.textContent('#ppPickN'), `${lone} chosen`); await page.fill('#ppPickName', 'Ana'); await page.click('#ppPickGo');
  await until(page, `document.querySelector("#ppTab-named i").textContent === "${had + 1}" && !document.querySelector("#ppSingles")`); await page.click('#ppTab-named'); await page.waitForSelector('#ppNamed .pp-person >> nth=2');
  assert.ok((await page.$$eval('#ppNamed .pp-name', (e: HTMLInputElement[]) => e.map((x) => x.value))).includes('Ana'));
  // off again: everything about faces is deleted, and the pictures are untouched
  const before = await S(page, 'S.items.length');
  await card(page, 'recog'); await page.click('#ppWipe'); assert.match(await page.textContent('.pop .confirm'), /delete all face data\? This cannot be undone\./); await page.click('.pop .btn.danger');
  await page.waitForSelector('#ppOff'); await S(page, 'go("library")'); await until(page, '!document.querySelector("#facets .f-person")');
  assert.equal(await S(page, 'S.items.length'), before);
  await page.evaluate(inPage(`api("DELETE", "/api/admin/workers/${made.id}")`));
});

await step('places: a picture is named after the beach it was taken at, and a picture with no location gets a suggestion a person accepts or rejects', async () => {
  await S(page, 'go("library")'); await S(page, 'Lib.clear()');
  // no place names yet: the settings page says so, and offers to fetch them
  await S(page, 'go("admin")'); await page.waitForSelector('#adServer [data-card=places]'); assert.match(await page.textContent('#adServer [data-card=places]'), /PlacesNot loaded/); await card(page, 'places');
  assert.match(await page.textContent('#adPlacesState'), /No place names are loaded yet\./); assert.ok(await page.isDisabled('#adPlacesRename')); assert.ok(await page.isEnabled('#adPlacesFetch'));
  assert.match(await page.textContent('#adPlaces'), /fetched once from GeoNames, about 400 MB/);
  // the names are loaded (here from a small file in the GeoNames layout, with a beach 200 m from one of the pictures)
  const P = await S(page, '(() => { const i = Lib.inSpace().find(i => i.kind === "photo" && i.lat != null && !i.copyOf); return { id: i.id, lat: i.lat, lng: i.lng }; })()') as { id: string; lat: number; lng: number };
  const line = (id: number, name: string, cls: string, code: string, lat: number, lng: number) => [id, name, name, '', lat.toFixed(6), lng.toFixed(6), cls, code, 'ES', '', '', '', '', '', '0', '', '', 'Europe/Madrid', '2024-01-01'].join('\t');
  const tsv = path.join(app.dataDir, 'e2e-places.txt'); fs.writeFileSync(tsv, [line(1, 'Playa del Saler', 'T', 'BCH', P.lat + 200 / 111320, P.lng), line(2, 'Rancho', 'S', 'FRM', P.lat, P.lng)].join('\n') + '\n');
  const imported = await importPlaceNames(app.ctx, tsv); assert.equal(imported.kept, 1); assert.ok(imported.renamed >= 1);
  await S(page, 'Admin.over = null'); await S(page, 'Admin.render()'); await until(page, '/1 place names are loaded/.test((document.querySelector("#adPlacesState") || {}).textContent || "")');
  assert.match(await page.textContent('#adPlacesState'), /Place names from GeoNames \(geonames\.org\), under the Creative Commons Attribution 4\.0 licence\./);
  await page.click('#adPlacesRename'); await page.waitForSelector('.toast:has-text("Every place name was already up to date")'); assert.match(await page.textContent('#adServer [data-card=places]'), /Places1 names/);
  await S(page, 'Admin.close()'); await page.waitForSelector('#admin', { state: 'hidden' });
  // the library: a filter for it, search finds it, and the viewer names it above the town
  await S(page, 'Sync.full().then(() => Lib.refresh())'); await page.waitForSelector('#facets .f-spot .fval');
  assert.match(await page.textContent('#facets .f-spot'), /Beaches, parks and landmarks\d+\s*Playa del Saler/);
  await page.fill('#lensInput', 'saler'); await page.keyboard.press('Enter'); await page.waitForTimeout(200); const hits = Number((await page.textContent('#libCount'))!.split(' ')[0]); assert.ok(hits >= 1); await S(page, 'Lib.clear()'); await page.fill('#lensInput', '');
  await page.evaluate(() => (document.activeElement as HTMLElement).blur()); await S(page, `Viewer.open("${P.id}")`); await page.waitForSelector('#viSpot');
  assert.match(await page.textContent('#viSpot'), /^Playa del Saler\s*beach$/); await page.keyboard.press('Escape'); await page.waitForSelector('#viewer', { state: 'hidden' });
  // two pictures lose their location. One was taken three minutes after P with the same camera. A worker recognises the place in the other.
  const [Q, R] = await S(page, `Lib.inSpace().filter(i => i.kind === "photo" && !i.copyOf && i.id !== "${P.id}" && i.status === "ready").slice(0, 2).map(i => i.id)`) as string[];
  await page.evaluate(inPage(`api("POST", "/api/items/bulk", { ids: ["${Q}", "${R}"], action: "unlocate" })`));
  await app.ctx.db.execute(sql`update items set camera = 'Test Cam', taken_at = '2022-03-03 10:00:00' where id = ${P.id}::uuid`);
  await app.ctx.db.execute(sql`update items set camera = 'Test Cam', taken_at = '2022-03-03 10:03:00', updated_at = now() where id = ${Q}::uuid`);
  await app.ctx.db.execute(sql`update items set camera = 'Other Cam', taken_at = '2019-01-01 10:00:00', updated_at = now() where id = ${R}::uuid`);
  const made = await page.evaluate(inPage('api("POST", "/api/admin/workers", { name: "Garage" })')) as any, fw = new FakeWorker(app.base, made.token);
  for (let k = 0; k < 20; k++) { const got = await fw.work((it: any) => (it.id === R ? { place: 'Playa del Saler, Valencia', kind: 'beach', confidence: 0.84, why: 'The long sand bar.' } : { place: '', kind: 'unknown', confidence: 0, why: '' }), ['place'], { name: 'e2e-vision', version: '1' }); if (!got.length && k > 1) break; }
  await S(page, 'Sync.full().then(() => Sugg.load(true)).then(() => Lib.refresh())'); await until(page, 'Sugg.by.size === 2');
  // on the "No location" filter the suggestions can be reviewed together
  await page.click('#facets .f-flag .fval:has-text("No location")'); await page.waitForSelector('#sugBar');
  assert.match(await page.textContent('#sugBar'), /A place is suggested for 2 of these pictures\./); assert.ok(await page.isVisible('#facets .f-flag .fval:has-text("Place suggested")'));
  await page.click('#sugReview'); await page.waitForSelector('.sg-box .sg-row >> nth=1'); await closeIsTopRight(page, '#sgClose', '.sg-box');
  assert.deepEqual((await page.$$eval('.sg-box .sg-row', (r: HTMLElement[]) => r.map((x) => [x.querySelector('b')!.textContent, x.querySelector('small')!.textContent]))).sort(), [['Possibly Playa del Saler, Valencia', 'Recognised by the worker. 1 picture.'], ['Possibly Playa del Saler', 'From a picture taken minutes away. 1 picture.']]);
  // every picture in the sheet is whole
  await until(page, '[...document.querySelectorAll(".sg-strip img")].every(i => i.complete && i.naturalWidth > 0)');
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('.sg-strip img')].every((i) => { const im = i as HTMLImageElement, r = im.getBoundingClientRect(); return Math.abs(r.width / r.height - im.naturalWidth / im.naturalHeight) < 0.03 && getComputedStyle(im).objectFit !== 'cover'; })));
  assert.equal(await S(page, `S.byId.get("${Q}").lat`), null, 'nothing is stored until a person accepts');
  await shot(page, '10a-suggested-places');
  await page.click('.sg-box .sg-row:has-text("minutes away") .btn.primary'); await page.waitForSelector('.toast:has-text("Location set for 1 item")'); await until(page, 'document.querySelectorAll(".sg-box .sg-row").length === 1');
  await page.click('#sgClose'); await page.waitForSelector('.sg-box', { state: 'detached' });
  const q = await S(page, `(() => { const i = S.byId.get("${Q}"); return [Math.abs(i.lat - ${P.lat}) < 1e-9, i.locSrc, i.spot]; })()`); assert.deepEqual(q, [true, 'suggested', 'Playa del Saler']);
  await S(page, 'Lib.clear()'); await page.evaluate(() => (document.activeElement as HTMLElement).blur()); await S(page, `Viewer.open("${Q}")`); await page.waitForSelector('#viSpot');
  assert.match(await page.textContent('#vwInfo'), /accepted from a suggestion/); await page.keyboard.press('Escape'); await page.waitForSelector('#viewer', { state: 'hidden' });
  // in the viewer the other one is shown as a guess, in blue, and a no is final
  await S(page, `Viewer.open("${R}")`); await page.waitForSelector('#viSugg');
  assert.match(await page.textContent('#viSugg'), /Possibly Playa del Saler, Valencia\s*Recognised by the worker\. The long sand bar\./);
  assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('#viSugg')!).borderLeftColor), /77, 125, 255/);
  await page.click('#viSuggNo'); await page.waitForSelector('.toast:has-text("They will not be suggested again")'); await page.waitForSelector('#viSugg', { state: 'detached' });
  assert.equal(await S(page, `S.byId.get("${R}").lat`), null); assert.equal(await S(page, 'Sugg.by.size'), 0);
  await page.keyboard.press('Escape'); await page.waitForSelector('#viewer', { state: 'hidden' });
  await page.evaluate(inPage(`api("DELETE", "/api/admin/workers/${made.id}")`));
});

await step('a person adds a profile picture, and it stands for them wherever their initial did', async () => {
  await S(page, 'go("library")');
  assert.equal(await page.locator('#btnMe img').count(), 0); assert.equal((await page.textContent('#btnMe'))!.trim().length, 1, 'an initial until there is a picture');
  // it is added on the settings page, from the person's own row, and nowhere else
  await page.click('#btnMe'); assert.doesNotMatch(await page.textContent('.pop .menu'), /profile picture/i); await page.keyboard.press('Escape');
  await S(page, 'go("admin")'); await page.click('#adPeople .ad-person:has-text("(you)")'); await page.waitForSelector('#adMyPic'); assert.equal(await page.getAttribute('#adMyPic', 'aria-label'), 'Add a profile picture'); assert.equal(await page.$('#adMyPicOff'), null);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#adMyPic')]); await chooser.setFiles(fixture('seaside.jpg'));
  await page.waitForSelector('.toast:has-text("Profile picture saved")'); await page.waitForSelector('#btnMe img.av-img');
  await until(page, '(i => i.complete && i.naturalWidth === 256 && i.naturalHeight === 256)(document.querySelector("#btnMe img"))');
  const r = await page.locator('#btnMe img').boundingBox(); assert.ok(Math.abs(r.width - r.height) < 1 && r.width >= 30, 'it fills the round badge');
  // on the settings page the owner's own row shows it, with a way to change or remove it
  await S(page, 'go("admin")'); await page.click('#adPeople .ad-person:has-text("(you)")'); await page.waitForSelector('#adModal header img.av-img'); assert.ok(await page.isVisible('#adMyPicOff')); assert.equal(await page.textContent('#adMyPic'), 'Change picture');
  assert.equal(await page.locator('#adPeople .av-img').count(), 1, 'only the person who added one has one');
  await shot(page, '11-profile-picture');
  await page.click('#adMyPicOff'); await page.waitForSelector('.toast:has-text("Profile picture removed")'); await page.waitForSelector('#adModal header img', { state: 'detached' });
  assert.equal(await page.locator('#btnMe img').count(), 0);
  await S(page, 'Admin.close()'); await page.waitForSelector('#admin', { state: 'hidden' });
});

await step('the page works on a phone-sized screen', async () => {
  const p3 = await newPage({ width: 390, height: 844 });
  await p3.goto(app.base); await p3.fill('#gateCard input[type=email]', 'owner@example.com'); await p3.fill('#gateCard input[type=password]', PASSWORD); await p3.click('#gateCard button[type=submit]');
  await p3.waitForSelector('#grid .tile img.in');
  assert.ok(await p3.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling');
  await shot(p3, '09-phone');
  // the grid reaches the edge of the screen and the pictures sit in the middle of it
  const edge = await p3.evaluate(() => { const sc = document.querySelector('#gridScroll')!, r = sc.getBoundingClientRect(), ts = [...document.querySelectorAll('#grid .tile')].map((t) => t.getBoundingClientRect()); return { gap: innerWidth - r.right, l: Math.min(...ts.map((t) => t.left)) - r.left, r: r.right - Math.max(...ts.map((t) => t.right)) }; });
  assert.equal(edge.gap, 0, 'nothing between the grid and the edge of the screen'); assert.ok(Math.abs(edge.l - edge.r) <= 4, `the pictures are in the middle: ${edge.l} px on the left, ${edge.r} px on the right`);
  // the timeline takes no room: it shows over the edge while the grid scrolls, and goes away again
  const rbOn = 'document.querySelector("#ribbon").classList.contains("on")';
  assert.equal(await S(p3, 'document.querySelector("#ribbon").hidden'), false, 'the library is long enough to have a timeline'); assert.equal(await S(p3, rbOn), false, 'the timeline is out of sight until the grid scrolls');
  await S(p3, 'document.querySelector("#gridScroll").scrollTop = 240'); await until(p3, rbOn, 3000); await shot(p3, '09b-phone-timeline');
  await until(p3, '!' + rbOn, 6000); await S(p3, 'document.querySelector("#gridScroll").scrollTop = 0'); await until(p3, rbOn, 3000); await until(p3, '!' + rbOn, 6000);
  // the top of a phone: account at the top right beside Add, the views on their own line under it, and with two spaces the tabs stay tabs
  const top = await p3.evaluate(() => Object.fromEntries(['#btnMe', '#btnUpload', '.views', '.lens', '.spaces'].map((q) => { const r = document.querySelector(q)!.getBoundingClientRect(); return [q, { l: r.left, r: r.right, t: r.top, b: r.bottom }]; }))) as any;
  assert.ok(top['#btnMe'].r <= 390 && top['#btnMe'].r > 340 && top['#btnUpload'].r <= top['#btnMe'].l && Math.abs(top['#btnMe'].t - top['#btnUpload'].t) < 8, 'account and Add share the top right corner');
  assert.ok(top['.views'].t >= top['#btnMe'].b - 2 && top['.lens'].t >= top['.views'].b - 2, 'the views are on the line below, and search below that');
  assert.ok(await p3.isHidden('#spaceSel') && await p3.isVisible('.spaces button'), 'two spaces fit, so they stay as tabs');
  // one line under it: filters, sort, group. No count.
  assert.ok(await p3.isHidden('#libCount'));
  const bar = await p3.evaluate(() => ['#btnFacets', '#selSort', '#selGroup'].map((q) => { const r = document.querySelector(q)!.getBoundingClientRect(); return [r.left, r.top + r.height / 2, r.right]; }));
  assert.ok(bar[0]![0]! < bar[1]![0]! && bar[1]![2]! <= bar[2]![0]! && bar[2]![2]! <= 390 && Math.abs(bar[0]![1]! - bar[1]![1]!) < 6 && Math.abs(bar[1]![1]! - bar[2]![1]!) < 6, 'filters, then sort, then group, on one line');
  // the filters open over the page and can be closed again: from their own corner, and by touching the page beside them
  await p3.click('#btnFacets'); await p3.waitForSelector('#facets', { state: 'visible' }); assert.ok(await p3.isVisible('#facetsClose'));
  const fc = await p3.locator('#facetsClose').boundingBox(), fp = await p3.locator('#facets').boundingBox(); assert.ok(fc.y < 200 && fc.x + fc.width <= fp.x + fp.width + 1, 'the close button is at the top of the filters');
  await shot(p3, '09c-phone-filters');
  await p3.click('#facetsClose'); await p3.waitForSelector('#facets', { state: 'hidden' });
  await p3.click('#btnFacets'); await p3.waitForSelector('#facets', { state: 'visible' }); await p3.mouse.click(370, 500); await p3.waitForSelector('#facets', { state: 'hidden' });
  // on a phone the viewer stays full screen
  await p3.click('#grid .tile >> nth=0'); await p3.waitForSelector('#viewer:not([hidden])');
  const pb = await p3.locator('#vwBox').boundingBox(); assert.deepEqual([pb.x, pb.y, pb.width, pb.height], [0, 0, 390, 844]);
  assert.ok(await p3.evaluate(() => [...document.querySelectorAll('.vw-top button')].every((b) => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })), 'every viewer button fits on the screen');
  await shot(p3, '09b-phone-viewer');
  await closeIsTopRight(p3, '#vwClose', '#vwBox');
  await p3.click('#vwClose'); await p3.waitForSelector('#viewer', { state: 'hidden' });
  // stories on a phone: neither the list nor an open story is wider than the screen, so nothing slides sideways
  const wide = (sel: string) => p3.evaluate((sel: string) => { const n = document.querySelector(sel) as HTMLElement; n.scrollLeft = 500; const moved = n.scrollLeft; n.scrollLeft = 0; return [n.scrollWidth <= n.clientWidth, moved, [...n.querySelectorAll('*')].filter((x) => (x as HTMLElement).offsetParent && x.getBoundingClientRect().right > innerWidth + 1).map((x) => x.className || x.tagName).slice(0, 4)]; }, sel);
  await p3.click('.views [data-view=stories]'); await p3.waitForSelector('.st-card'); assert.deepEqual(await wide('#v-stories'), [true, 0, []]);
  assert.ok(await p3.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.top *')].every((x) => x.getBoundingClientRect().right <= innerWidth + 1)), 'the top bar, with Reels in it, fits');
  await p3.click('.st-card'); await p3.waitForSelector('#reader:not([hidden]) .rd-bar'); assert.deepEqual(await wide('#reader'), [true, 0, []]);
  assert.ok(await p3.evaluate(() => [...document.querySelectorAll('.rd-bar > *')].every((x) => { const r = x.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })), 'every button of the story bar is on the screen');
  await shot(p3, '09f-phone-story'); await closeIsTopRight(p3, '#reader .modal-x', '#reader');
  await p3.click('#reader .modal-x'); await p3.waitForSelector('#reader', { state: 'hidden' });
  await p3.click('.views [data-view=reels]'); await p3.waitForSelector('#rpList'); assert.deepEqual(await wide('#v-reels'), [true, 0, []]);
  await p3.click('.views [data-view=library]'); await p3.waitForSelector('#grid .tile img.in');

  /* fingers. The page listens to pointer events, so the test sends those, marked as touch. */
  await p3.evaluate('window.__name = (f) => f'); // the test runner wraps named helpers in this; the page does not have it
  const finger = (sel: string, path: [number, number][], opts: { hold?: number; id?: number; lift?: boolean; down?: boolean } = {}) => p3.evaluate(async ([sel, path, o]: [string, [number, number][], any]) => {
    const el = document.querySelector(sel) as HTMLElement, r = el.getBoundingClientRect(), id = o.id ?? 7;
    const at = (type: string, [x, y]: [number, number]) => { const cx = r.left + x, cy = r.top + y, t = (document.elementFromPoint(cx, cy) as HTMLElement) ?? el; t.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 7, clientX: cx, clientY: cy, bubbles: true, cancelable: true, composed: true })); return t; };
    let last = path[0]!;
    if (o.down !== false) at('pointerdown', path[0]!);
    if (o.hold) await new Promise((res) => setTimeout(res, o.hold));
    for (const p of path.slice(1)) { at('pointermove', p); last = p; await new Promise((res) => setTimeout(res, 12)); }
    if (o.lift !== false) { const t = at('pointerup', last); if (path.length === 1 || o.hold) t.dispatchEvent(new MouseEvent('click', { clientX: r.left + last[0], clientY: r.top + last[1], bubbles: true, cancelable: true })); }
  }, [sel, path, opts] as [string, [number, number][], any]);
  const sel = () => S(p3, 'S.sel.size');
  // a long press starts a selection and does not open the picture. A tap then adds another.
  await finger('#grid .tile', [[40, 40]], { hold: 620 });
  assert.equal(await sel(), 1, 'holding a picture selects it'); assert.equal(await p3.isVisible('#viewer'), false, 'and does not open it');
  await p3.locator('#grid .tile').nth(1).click(); assert.equal(await sel(), 2, 'a tap adds the next one');
  // a finger that moves is scrolling, not selecting
  await p3.evaluate(() => { const t = document.querySelectorAll('#grid .tile')[2] as HTMLElement, r = t.getBoundingClientRect(), ev = (type: string, y: number) => t.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'touch', clientX: r.left + 30, clientY: r.top + y, bubbles: true })); ev('pointerdown', 30); ev('pointermove', 70); });
  await p3.waitForTimeout(620); assert.equal(await sel(), 2, 'a moving finger selects nothing');
  await p3.evaluate(() => document.querySelectorAll('#grid .tile')[2]!.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, pointerType: 'touch', bubbles: true })));
  // the bulk bar sits inside the screen with every action reachable, and the location dialog fits
  const bb = await p3.locator('#bulk').boundingBox(); assert.ok(bb.x >= 0 && bb.x + bb.width <= 390 && bb.y + bb.height <= 844, 'the bulk bar is on the screen: ' + JSON.stringify(bb));
  assert.ok(await p3.evaluate(() => [...document.querySelectorAll('#bulk .btn')].filter((b) => (b as HTMLElement).offsetParent).every((b) => (b as HTMLElement).offsetHeight >= 40)), 'its buttons are large enough for a thumb');
  await shot(p3, '09c-phone-bulk');
  await p3.locator('#bulk [data-bulk=location]').scrollIntoViewIfNeeded(); await p3.click('#bulk [data-bulk=location]'); await p3.waitForSelector('.loc-box');
  const lb = await p3.locator('.loc-box').boundingBox(); assert.ok(lb.x >= 0 && lb.x + lb.width <= 390 && lb.y >= 0 && lb.y + lb.height <= 844, 'the location dialog fits: ' + JSON.stringify(lb));
  assert.ok(await p3.evaluate(() => { const b = document.querySelector('.loc-box')!.getBoundingClientRect(); return [...document.querySelectorAll('.loc-box button')].filter((x) => (x as HTMLElement).offsetParent).every((x) => { const r = x.getBoundingClientRect(); return r.left >= b.left && r.right <= b.right; }); }), 'every button of the dialog is inside it');
  assert.ok(await p3.isVisible('.loc-box input'), 'with its search box in reach'); await shot(p3, '09d-phone-location');
  await p3.keyboard.press('Escape'); await p3.waitForSelector('.loc-box', { state: 'detached' }).catch(() => p3.waitForSelector('.loc-box', { state: 'hidden' }));
  await p3.click('#bulk [data-bulk=clear]'); assert.equal(await sel(), 0);
  // the viewer: a sideways swipe steps, a pinch zooms in place, a swipe down closes
  await p3.click('#grid .tile >> nth=0'); await p3.waitForSelector('#viewer:not([hidden])'); await until(p3, 'Viewer.item && Viewer.item.status === "ready"');
  await S(p3, '(() => { while (Viewer.item.kind === "video") Viewer.step(1); })()');
  const at0 = await S(p3, 'Viewer.idx');
  await finger('#vwFrame', [[300, 200], [240, 204], [160, 206], [90, 208]]); assert.equal(await S(p3, 'Viewer.idx'), at0 + 1, 'a swipe to the left shows the next one'); assert.equal(await S(p3, '!!Zoom.item'), false, 'and does not zoom');
  await finger('#vwFrame', [[90, 200], [170, 203], [250, 205], [310, 206]]); assert.equal(await S(p3, 'Viewer.idx'), at0, 'a swipe to the right goes back');
  await finger('#vwFrame', [[200, 200], [204, 212]]); assert.equal(await S(p3, 'Viewer.idx'), at0, 'a small movement does nothing');
  await S(p3, '(() => { while (Viewer.item.kind === "video") Viewer.step(1); })()');
  // two fingers moving apart
  await finger('#vwFrame', [[170, 200]], { id: 7, lift: false }); await finger('#vwFrame', [[220, 200]], { id: 8, lift: false });
  await finger('#vwFrame', [[220, 200], [250, 200], [290, 200], [330, 200]], { id: 8, down: false, lift: false });
  const zoomed = await S(p3, 'Zoom.item ? Zoom.s / Zoom.fit : 0'); assert.ok(zoomed > 1.5, 'a pinch zooms in: ' + zoomed);
  await finger('#vwFrame', [[330, 200], [280, 200], [230, 200], [200, 200], [185, 200]], { id: 8, down: false, lift: false });
  await p3.evaluate(() => { for (const id of [8, 7]) document.querySelector('#vwFrame')!.dispatchEvent(new PointerEvent('pointerup', { pointerId: id, pointerType: 'touch', bubbles: true })); });
  assert.equal(await S(p3, '!!Zoom.item'), false, 'pinching back to the fitted size leaves the zoom'); assert.equal(await p3.isVisible('#viewer'), true);
  await p3.waitForTimeout(400);
  await finger('#vwFrame', [[200, 120], [203, 190], [205, 270], [206, 330]]); await p3.waitForSelector('#viewer', { state: 'hidden' });
  // around the notch and the home indicator: with insets like an iPhone's, nothing at an edge sits under them
  await p3.evaluate(() => { const r = document.documentElement.style; r.setProperty('--sat', '47px'); r.setProperty('--sab', '34px'); });
  const topPad = await p3.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.top')!).paddingTop)); assert.ok(topPad >= 47, 'the top bar starts below the notch: ' + topPad);
  await p3.locator('#grid .tile').nth(0).dispatchEvent('click', { shiftKey: true }); await p3.waitForSelector('#bulk:not([hidden])');
  const b2 = await p3.locator('#bulk').boundingBox(); assert.ok(b2.y + b2.height <= 844 - 34, 'the bulk bar stays above the home indicator: ' + (b2.y + b2.height));
  await p3.click('#bulk [data-bulk=clear]'); await p3.click('#grid .tile >> nth=0'); await p3.waitForSelector('#viewer:not([hidden])');
  const [xb, tb] = [await p3.locator('#vwClose').boundingBox(), await p3.locator('.vw-top').boundingBox()]; assert.ok(xb.y >= 47 && tb.y >= 47, `the viewer's controls are below the notch: ${xb.y}, ${tb.y}`);
  await shot(p3, '09e-phone-safe-areas');
  await p3.click('#vwClose');
  // uploads go through the phone's own picker: pictures and videos, several at once
  assert.deepEqual(await p3.evaluate(() => { const i = document.querySelector('#upFiles') as HTMLInputElement; return [i.multiple, /image\/\*/.test(i.accept), /video\/\*/.test(i.accept)]; }), [true, true, true]);
  await p3.context().close();
});

await step('on a phone, a settings window stays below the clock and above the home bar, so it can always be closed', async () => {
  const p = await newPage({ width: 390, height: 844 });
  await p.goto(app.base); await p.fill('#gateCard input[type=email]', 'owner@example.com'); await p.fill('#gateCard input[type=password]', PASSWORD); await p.click('#gateCard button[type=submit]');
  await p.waitForSelector('#grid .tile img.in');
  // the room an iPhone keeps for its clock and its home bar, as it reports them to a page opened from the home screen
  await p.evaluate(() => { document.documentElement.style.setProperty('--sat', '47px'); document.documentElement.style.setProperty('--sab', '34px'); });
  await S(p, 'go("admin")'); await p.waitForSelector('#v-admin [data-card=storage]');
  for (const key of ['storage', 'backup', 'move']) {
    await card(p, key);
    const r = await p.evaluate(() => { const x = document.querySelector('#adModalClose')!.getBoundingClientRect(), b = document.querySelector('.ad-mbox')!.getBoundingClientRect(); return { top: x.top, bottom: b.bottom }; });
    assert.ok(r.top >= 47, `${key}: the close button is below the clock (it starts at ${r.top} px)`); assert.ok(r.bottom <= 844 - 34 + 1, `${key}: the window ends above the home bar (at ${r.bottom} px)`);
  }
  await p.click('#adModalClose'); assert.equal(await p.$('#adModal'), null, 'and it closes');
  await p.context().close();
});
await step('the site can be put on a phone\'s home screen: a manifest with icons, allowed by the security policy, and no service worker', async () => {
  const p4 = await newPage({ width: 390, height: 844 });
  await p4.addInitScript('window.__name = (f) => f');
  const res = await p4.goto(app.base); const csp = res!.headers()['content-security-policy'] ?? '';
  assert.match(csp, /manifest-src 'self'/);
  assert.equal(await p4.getAttribute('link[rel=manifest]', 'href'), '/manifest.webmanifest'); assert.match(await p4.getAttribute('meta[name=viewport]', 'content') ?? '', /viewport-fit=cover/);
  assert.equal(await p4.getAttribute('meta[name=apple-mobile-web-app-capable]', 'content'), 'yes'); assert.equal(await p4.getAttribute('meta[name=theme-color]', 'content'), '#1a1b1d');
  const got = await p4.evaluate(async () => {
    const r = await fetch('/manifest.webmanifest'), m = await r.json();
    const size = async (src: string) => { const b = await createImageBitmap(await (await fetch(src)).blob()), c = new OffscreenCanvas(b.width, b.height), x = c.getContext('2d')!; x.drawImage(b, 0, 0); return { w: b.width, h: b.height, corner: [...x.getImageData(2, 2, 1, 1).data] }; };
    const icons = []; for (const i of m.icons) icons.push({ ...i, ...(await size(i.src)) });
    return { type: r.headers.get('content-type'), m, icons, apple: await size((document.querySelector('link[rel=apple-touch-icon]') as HTMLLinkElement).href), workers: (await navigator.serviceWorker?.getRegistrations?.() ?? []).length };
  });
  assert.match(got.type ?? '', /application\/manifest\+json/);
  assert.deepEqual([got.m.name, got.m.short_name, got.m.display, got.m.start_url, got.m.background_color, got.m.theme_color], ['ImageStoria', 'ImageStoria', 'standalone', '/', '#1a1b1d', '#1a1b1d']);
  assert.deepEqual(got.icons.map((i: any) => [i.sizes, i.purpose, i.w, i.h]), [['192x192', 'any', 192, 192], ['512x512', 'any', 512, 512], ['512x512', 'maskable', 512, 512]]);
  // a maskable icon is color right to its corners, so a phone can cut it to any shape. The plain one keeps its own rounded corners.
  assert.deepEqual(got.icons[2].corner, [26, 27, 29, 255]); assert.equal(got.icons[1].corner[3], 0);
  assert.deepEqual([got.apple.w, got.apple.h, got.apple.corner[3]], [180, 180, 255], 'the iOS icon is 180 px and has no see-through corners');
  assert.equal(got.workers, 0, 'no service worker: a private library must never be served from a stale cache');
  await p4.context().close();
});
await page.context().close(); await app.stop();

/* ---------- 2. Single sign-on only ---------- */
console.log('Single sign-on (stand-in provider)');
const idp = await mockOidc();
const sso = await startApp('ai_e2e_sso', { LOCAL_AUTH: 'false', OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'afterimage', OIDC_CLIENT_SECRET: 'shh' });
await step('with local accounts off, the first person to sign in with SolPersona becomes the owner', async () => {
  const p = await newPage();
  await p.goto(sso.base); await p.waitForSelector('#gateCard a.sso');
  assert.equal(await p.$('#gateCard form'), null, 'no password form');
  assert.equal((await p.textContent('#gateCard a.sso')).trim(), 'Become the owner with SolPersona');
  await p.click('#gateCard a.sso'); await p.waitForSelector('#app:not([hidden])');
  assert.deepEqual(await S(p, '[S.me.name, S.me.role, S.me.oidcLinked]'), ['Chaz', 'owner', true]);
  // someone who was never invited is turned away with a plain message
  await p.click('#btnMe'); await p.click('.menu .mi:has-text("Sign out")'); await p.waitForSelector('#gateCard a.sso');
  idp.state.current = { sub: 'sp-9', name: 'Stranger', preferred_username: 'stranger', email: 'stranger@example.com', email_verified: true };
  await p.click('#gateCard a.sso'); await p.waitForSelector('.gate-err');
  assert.match(await p.textContent('.gate-err'), /not on the list/);
  await p.context().close();
});
await sso.stop(); await idp.stop();

/* ---------- 3. Files in an S3-compatible bucket ---------- */
console.log('Bucket storage (local S3 server)');
const s3dir = path.join(here, 'tmp', 's3-e2e'); fs.rmSync(s3dir, { recursive: true, force: true }); fs.mkdirSync(s3dir, { recursive: true });
const s3 = new S3rver({ port: 0, address: '127.0.0.1', silent: true, directory: s3dir, configureBuckets: [{ name: 'afterimage' }] });
const s3port = (await s3.run()).port;
const bucket = await startApp('ai_e2e_s3', { STORAGE_DRIVER: 's3', S3_ENDPOINT: `http://127.0.0.1:${s3port}`, S3_BUCKET: 'afterimage', S3_ACCESS_KEY_ID: 'S3RVER', S3_SECRET_ACCESS_KEY: 'S3RVER', S3_FORCE_PATH_STYLE: 'true' });
await step('with a bucket, the browser loads pictures straight from it through signed links, and editing still works', async () => {
  const p = await newPage();
  await p.goto(bucket.base); await p.fill('#gateCard input[autocomplete=name]', 'Chaz'); await p.fill('#gateCard input[type=email]', 'owner@example.com'); await p.fill('#gateCard input[type=password]', PASSWORD); await p.click('#gateCard button[type=submit]');
  await p.waitForSelector('#app:not([hidden])');
  const fromBucket: string[] = []; p.on('response', (r: any) => { if (r.url().includes(`127.0.0.1:${s3port}`) && r.status() === 200) fromBucket.push(r.url()); });
  await p.click('#btnUpload'); await p.setInputFiles('#upFiles', [path.join(photos, 'IMG_1001.jpg'), path.join(photos, 'IMG_1002.jpg')]); await settled(p, 2); await p.waitForSelector('#upload', { state: 'hidden' });
  await p.waitForSelector('#grid .tile img.in');
  assert.ok(fromBucket.some((u) => /thumbs\/.*X-Amz-Signature=/.test(u)), 'thumbnails came from the bucket with a signature');
  await p.click('#grid .tile >> nth=0'); await p.waitForSelector('#viewer:not([hidden])'); await p.keyboard.press('e'); await p.waitForSelector('#edBusy', { state: 'hidden' });
  await p.evaluate(() => { const i = document.querySelector('#edAdjust input[data-k=exposure]') as HTMLInputElement; i.value = '25'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); });
  await p.click('#edSave'); await until(p, 'S.items.some(i => i.copyOf && i.status === "ready")', 40000);
  await p.context().close();
});
await bucket.stop(); await s3.close();

await browser.close();
fs.rmSync(stylePath, { force: true });
const failed = results.filter((r) => r[1]);
if (trouble.length) console.log('\nUnexpected errors in the browser:\n  ' + [...new Set(trouble)].join('\n  '));
console.log(`\n${results.length - failed.length} of ${results.length} browser checks passed.`);
process.exit(failed.length || trouble.length ? 1 : 0);
