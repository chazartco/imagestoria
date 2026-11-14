import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { composeCard, composeFrame, coverLayout, daySpan } from '../src/server/media/reel.js';
import { Client, fixture, startApp } from './helpers.js';

describe('reels: a story as a video', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let owner: Client, viewer: Client, life: string, story: string, out: string;
  const done = async (id: string, ms = 120000) => {
    for (const t0 = Date.now(); ;) {
      const r = (await owner.get(`/api/stories/${story}/reels`)).data.reels.find((x: any) => x.id === id);
      if (r.status === 'ready' || r.status === 'failed') return r;
      if (Date.now() - t0 > ms) throw new Error('the reel never finished: ' + JSON.stringify(r));
      await new Promise((r2) => setTimeout(r2, 400));
    }
  };
  const fetchTo = async (who: Client, url: string, name: string) => { const res = await who.raw('GET', url); assert.equal(res.status, 200); const f = path.join(out, name); fs.writeFileSync(f, Buffer.from(await res.arrayBuffer())); return f; };
  const probe = (f: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]).toString());
  /** how loud a stretch of the file is, in dB */
  const loudness = (f: string, from: number, len: number, filter = 'anull') => { const o = spawnSync('ffmpeg', ['-v', 'info', '-nostdin', '-ss', String(from), '-t', String(len), '-i', f, '-vn', '-af', `${filter},volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr; return Number(/mean_volume: (-?[\d.]+) dB/.exec(o)![1]); };

  before(async () => {
    app = await startApp('ai_test_reel', { REEL_VIDEO_MAX_SECONDS: '2' }); out = path.join(app.dataDir, 'tmp', 'reel-test'); fs.mkdirSync(out, { recursive: true });
    owner = new Client(app.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
    life = (await owner.get('/api/bootstrap')).data.spaces[0].id;
    // a short clip with a steady tone for its sound, so the test can tell the clip's sound from the music
    const talk = path.join(out, 'talking.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', talk]);
    const ids: string[] = [];
    for (const f of [fixture('seaside.jpg'), talk, fixture('sideways.jpg')]) ids.push((await owner.upload(f, life)).data.id);
    await owner.settled();
    story = (await owner.post('/api/stories', { title: 'A day / at the bay', spaceId: life, ids })).data.id;
    // the author's order: a photo, the clip, a photo
    await owner.json('PATCH', `/api/stories/${story}`, { sections: [{ title: '', text: '', ids }] });
    const inv = await owner.post('/api/people/invite', { who: 'maria@example.com', role: 'viewer', spaceIds: [life] });
    viewer = new Client(app.base);
    await viewer.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: 'Maria', email: 'maria@example.com', password: 'a long enough password' });
    await owner.json('PATCH', `/api/stories/${story}`, { shared: [(await viewer.get('/api/me')).data.id] });
  });
  after(async () => { await app.stop(); });

  it('puts a whole picture in the frame, clear of the edges, over a blurred copy of itself', async () => {
    // a wide picture in a tall frame: the picture must be whole, and the blur fills what is left
    const f = path.join(out, 'frame.jpg'); await composeFrame(fixture('seaside.jpg'), 1080, 1920, f);
    const m = await sharp(f).metadata(); assert.deepEqual([m.width, m.height], [1080, 1920]);
    const src = await sharp(fixture('seaside.jpg')).metadata(), ar = src.width! / src.height!;
    const w = Math.round(1080 * 0.96 / 2) * 2, h = w / ar, top = Math.round((1920 - h) / 2), left = (1080 - w) / 2;
    const { data } = await sharp(f).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => [...data.subarray((Math.round(y) * 1080 + Math.round(x)) * 3, (Math.round(y) * 1080 + Math.round(x)) * 3 + 3)];
    const same = (a: number[], b: number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
    // the four corners of the picture are where a whole, uncropped picture would put them
    const small = await sharp(fixture('seaside.jpg')).resize(w, Math.round(h), { fit: 'fill' }).raw().toBuffer();
    const sp = (x: number, y: number) => [...small.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];
    for (const [x, y] of [[4, 4], [w - 5, 4], [4, Math.round(h) - 5], [w - 5, Math.round(h) - 5], [w >> 1, Math.round(h) >> 1]] as const) assert.ok(same(px(left + x, top + y), sp(x, y), 26), `the picture's own pixel is at ${x},${y}`);
    // above and below it is the backdrop: darker, and smooth
    const bandTop = [px(200, 40), px(540, 60), px(880, 80)], lum = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    assert.ok(bandTop.every((c) => lum(c) < 150), 'the backdrop is darkened');
    assert.ok(Math.abs(lum(px(540, 60)) - lum(px(544, 60))) < 6 && Math.abs(lum(px(540, 60)) - lum(px(540, 66))) < 6, 'and blurred');
    assert.ok(left >= 1080 * 0.02 - 1, 'the picture stays 2% clear of the frame edge');
  });

  it('draws the story card: every cover whole, laid out as large as the frame allows, with the title on a panel of its own', async () => {
    // layout: pictures in a row share a height, rows share a width, nothing overlaps or leaves the box, shapes are kept
    for (const [ars, bw, bh] of [[[1.5], 900, 1200], [[1.5, 0.75], 900, 1200], [[1.5, 0.75, 1, 2.4], 900, 1200], [[1.5, 0.75, 1, 2.4], 1700, 600], [[0.5, 0.5, 0.5], 1700, 600]] as [number[], number, number][]) {
      const cells = coverLayout(ars, bw, bh, 12); assert.equal(cells.length, ars.length);
      cells.forEach((c, i) => { assert.ok(Math.abs(c.w / c.h - ars[i]!) < 0.03 * ars[i]! + 0.01, `shape kept: ${c.w}x${c.h} for ${ars[i]}`); assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= bw + 1 && c.y + c.h <= bh + 1, 'inside the box'); });
      for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) { const a = cells[i]!, b = cells[j]!; assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'no two overlap'); }
    }
    // a wide picture and a tall one stack in a tall frame and sit side by side in a wide one
    const tall = coverLayout([1.5, 1.5], 900, 1200, 12), wide = coverLayout([1.5, 1.5], 1700, 600, 12);
    assert.ok(tall[1]!.y > tall[0]!.y && tall[1]!.x === tall[0]!.x); assert.ok(wide[1]!.x > wide[0]!.x && wide[1]!.y === wide[0]!.y);
    assert.deepEqual([daySpan(new Date(2024, 2, 4), new Date(2024, 2, 4)), daySpan(new Date(2024, 2, 4), new Date(2024, 2, 9)), daySpan(new Date(2024, 2, 4), new Date(2024, 3, 2)), daySpan(new Date(2024, 11, 30), new Date(2025, 0, 2))],
      ['March 4, 2024', 'March 4 to 9, 2024', 'March 4 to April 2, 2024', 'December 30, 2024 to January 2, 2025']);
    const f = path.join(out, 'card.jpg'); await composeCard([fixture('seaside.jpg'), fixture('sideways.jpg')], 'A day at the bay & after <it>', '3 items, March 4 to 9, 2024', 1080, 1920, f);
    const m = await sharp(f).metadata(); assert.deepEqual([m.width, m.height], [1080, 1920]);
    const { data } = await sharp(f).raw().toBuffer({ resolveWithObject: true }), lum = (x: number, y: number) => { const i = (y * 1080 + x) * 3; return 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!; };
    // the title is light writing on a dark panel near the bottom
    let light = 0, dark = 0; for (let y = 1600; y < 1800; y += 2) for (let x = 80; x < 1000; x += 2) { const l = lum(x, y); if (l > 170) light++; if (l < 60) dark++; }
    assert.ok(light > 300, 'the title is written: ' + light); assert.ok(dark > 10000, 'on a dark panel: ' + dark);
  });

  it('makes a tall reel with music that dips under the video\'s own sound', async () => {
    const first = (await owner.get('/api/index')).data.items.find((i: any) => i.fileName === 'seaside.jpg').id;
    assert.equal((await owner.json('PATCH', `/api/stories/${story}`, { covers: [first] })).status, 200);
    const asked = await owner.post(`/api/stories/${story}/reels`, { format: '9:16', music: 'builtin:golden-hour', secondsPerPhoto: 3 });
    assert.equal(asked.status, 200); assert.deepEqual([asked.data.status, asked.data.format, asked.data.music], ['queued', '9:16', 'builtin:golden-hour']);
    const r = await done(asked.data.id);
    assert.deepEqual([r.status, r.error, r.progress], ['ready', null, 1]);
    const f = await fetchTo(owner, `/api/reels/${r.id}/file`, 'tall.mp4'), j = probe(f);
    const v = j.streams.find((s: any) => s.codec_type === 'video'), a = j.streams.find((s: any) => s.codec_type === 'audio');
    assert.deepEqual([v.codec_name, v.width, v.height, v.pix_fmt, v.r_frame_rate], ['h264', 1080, 1920, 'yuv420p', '30/1']);
    assert.deepEqual([a.codec_name, a.channels, a.sample_rate], ['aac', 2, '48000']);
    // the card for three seconds, a photo for three, the clip (3 seconds long, capped at 2 in this test), a photo for three
    assert.ok(Math.abs(Number(j.format.duration) - 11) < 0.35, 'length: ' + j.format.duration); assert.ok(Math.abs(r.seconds - 11) < 0.35);
    // The very first frame is the story's card in full view, not black: it is what a site shows as the thumbnail.
    const firstFrame = path.join(out, 'tall-first.png'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', f, '-frames:v', '1', firstFrame]);
    const card = path.join(out, 'tall-card.jpg'); await composeCard([fixture('seaside.jpg')], 'A day / at the bay', '', 1080, 1920, card);
    const [got, want] = await Promise.all([firstFrame, card].map((x) => sharp(x).removeAlpha().resize(54, 96, { fit: 'fill' }).raw().toBuffer()));
    const lumOf = (b: Buffer, i: number) => 0.2126 * b[i * 3]! + 0.7152 * b[i * 3 + 1]! + 0.0722 * b[i * 3 + 2]!;
    let bright = 0, off = 0; for (let i = 0; i < 54 * 40; i++) { bright += lumOf(got!, i); off += Math.abs(lumOf(got!, i) - lumOf(want!, i)); }
    assert.ok(bright / (54 * 40) > 45, 'the first frame is not black: ' + (bright / (54 * 40)).toFixed(0)); assert.ok(off / (54 * 40) < 10, 'it is the card at full strength, not a fade: ' + (off / (54 * 40)).toFixed(1));
    assert.ok(r.bytes === fs.statSync(f).size && r.bytes > 50000);
    // it starts playing at once: the index is at the front of the file
    const head = fs.readFileSync(f).subarray(0, 4096).toString('latin1'); assert.ok(head.indexOf('moov') > 0 && head.indexOf('moov') < head.indexOf('mdat') || head.indexOf('mdat') < 0, 'the index comes before the data');
    // frames from the middle of each part, to look at
    for (const [t, name] of [[4.5, 'tall-photo-1.jpg'], [9.5, 'tall-photo-2.jpg'], [7, 'tall-video.jpg']] as const) execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', f, '-frames:v', '1', '-q:v', '3', path.join(out, name)]);
    const frame = await sharp(path.join(out, 'tall-video.jpg')).metadata(); assert.deepEqual([frame.width, frame.height], [1080, 1920]);
    // The clip's own sound is a 440 Hz tone. With everything below 3 kHz filtered away what is left is the music alone,
    // and it must be clearly quieter while the clip plays than on the photo before it. That is the dip.
    const onPhoto = loudness(f, 4, 1.6), underVideo = loudness(f, 6.5, 1.3);
    assert.ok(onPhoto > -40, 'music plays under the photos: ' + onPhoto);
    assert.ok(underVideo > -30, 'the clip keeps its own sound: ' + underVideo);
    const music = [loudness(f, 4, 1.6, 'highpass=f=3000'), loudness(f, 6.5, 1.3, 'highpass=f=3000')];
    assert.ok(music[0]! - music[1]! >= 8, `the music dips under the clip: ${music[0]} dB on the photo, ${music[1]} dB under the clip`);
  });

  it('makes a wide reel with no music, from the same story', async () => {
    const asked = await owner.post(`/api/stories/${story}/reels`, { format: '16:9', music: null, secondsPerPhoto: 1.5 });
    const r = await done(asked.data.id); assert.equal(r.status, 'ready', r.error);
    const f = await fetchTo(owner, `/api/reels/${r.id}/file`, 'wide.mp4'), j = probe(f), v = j.streams.find((s: any) => s.codec_type === 'video');
    assert.deepEqual([v.width, v.height], [1920, 1080]); assert.ok(Math.abs(Number(j.format.duration) - 7.5) < 0.35, 'the card stays at least two and a half seconds: ' + j.format.duration);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', f, '-frames:v', '1', '-q:v', '3', path.join(out, 'wide-first.jpg')]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '6.7', '-i', f, '-frames:v', '1', '-q:v', '3', path.join(out, 'wide-photo-2.jpg')]);
    const list = (await owner.get(`/api/stories/${story}/reels`)).data;
    assert.deepEqual(list.reels.map((x: any) => [x.format, x.status]), [['16:9', 'ready'], ['9:16', 'ready']], 'newest first');
    assert.deepEqual(list.sizes, { '9:16': [1080, 1920], '16:9': [1920, 1080] });
    // a download has a name made from the story's title
    const dl = await owner.raw('GET', `/api/reels/${r.id}/file?download=1`); assert.match(dl.headers.get('content-disposition') ?? '', /filename\*=UTF-8''A%20day%20%20%20at%20the%20bay%2016x9\.mp4|A%20day%20at%20the%20bay/); await dl.arrayBuffer();
  });

  it('makes a reel straight from pictures chosen in the library, with a title and chosen covers, and lists it with the story reels', async () => {
    const idx = (await owner.get('/api/index')).data.items, id = (n: string) => idx.find((i: any) => i.fileName === n).id;
    const a = id('seaside.jpg'), b = id('sideways.jpg'), spaceReels = async (who = owner) => (await who.get(`/api/reels?space=${life}`)).data.reels;
    const wait = async (rid: string) => { for (const t0 = Date.now(); ;) { const r = (await spaceReels()).find((x: any) => x.id === rid); if (r.status === 'ready' || r.status === 'failed') return r; if (Date.now() - t0 > 120000) throw new Error('never finished'); await new Promise((r2) => setTimeout(r2, 400)); } };
    const ask = (body: any, who = owner) => who.post('/api/reels', { format: '16:9', secondsPerPhoto: 2, ...body });
    // refused: nothing chosen, a cover that is not in the reel, more than four covers, a picture that does not exist, someone who may not edit
    assert.equal((await ask({ ids: [] })).status, 400);
    assert.match((await ask({ ids: [a], covers: [b] })).data.error, /cover pictures must be among/);
    assert.equal((await ask({ ids: [a, b], covers: [a, b, a, b, a] })).status, 400);
    assert.match((await ask({ ids: [a, '00000000-0000-4000-8000-000000000000'] })).data.error, /are gone/);
    assert.equal((await ask({ ids: [a] }, viewer)).status, 403);
    const other = (await owner.post('/api/spaces', { name: 'Studio', kind: 'studio' })).data.id, far = (await owner.upload(fixture('plain.png'), other)).data.id; await owner.settled();
    assert.match((await ask({ ids: [a, far] })).data.error, /one space/);
    // made
    const asked = await ask({ ids: [b, a], covers: [b, a], title: 'Two from the bay', music: null });
    assert.equal(asked.status, 200, JSON.stringify(asked.data)); assert.deepEqual([asked.data.story, asked.data.title, asked.data.covers, asked.data.count, asked.data.status], [null, 'Two from the bay', [b, a], 2, 'queued']);
    const r = await wait(asked.data.id); assert.equal(r.status, 'ready', r.error);
    assert.deepEqual([r.from, r.title, r.count, r.mayDelete, r.covers], ['library', 'Two from the bay', 2, true, [b, a]]);
    const f = await fetchTo(owner, `/api/reels/${r.id}/file`, 'library.mp4'), j = probe(f), v = j.streams.find((s: any) => s.codec_type === 'video');
    // the card for two and a half seconds, then two photos for two seconds each
    assert.deepEqual([v.width, v.height], [1920, 1080]); assert.ok(Math.abs(Number(j.format.duration) - 6.5) < 0.35, 'length: ' + j.format.duration);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', f, '-frames:v', '1', path.join(out, 'library-first.png')]);
    const first = await sharp(path.join(out, 'library-first.png')).removeAlpha().resize(96, 54, { fit: 'fill' }).raw().toBuffer(); let lum = 0; for (let i = 0; i < first.length; i += 3) lum += first[i]! + first[i + 1]! + first[i + 2]!;
    assert.ok(lum / first.length > 40, 'it opens on its card, not on black');
    const dl = await owner.raw('GET', `/api/reels/${r.id}/file?download=1`); assert.match(dl.headers.get('content-disposition') ?? '', /Two%20from%20the%20bay%2016x9\.mp4/); await dl.arrayBuffer();
    // one without a title or covers is fine too
    const plain = await ask({ ids: [a] }); assert.equal(plain.status, 200); const p = await wait(plain.data.id); assert.equal(p.status, 'ready', p.error); assert.deepEqual([p.title, p.covers, p.first], ['', [], a]);
    // the list of the space holds the reels made from stories and the ones made from the library, newest first
    const all = await spaceReels();
    assert.deepEqual(all.map((x: any) => [x.from, x.title, x.format]), [['library', '', '16:9'], ['library', 'Two from the bay', '16:9'], ['story', 'A day / at the bay', '16:9'], ['story', 'A day / at the bay', '9:16']]);
    assert.deepEqual(all.filter((x: any) => x.from === 'story').map((x: any) => [x.story, x.count, x.covers.length > 0]), [[story, 3, true], [story, 3, true]]);
    assert.deepEqual((await owner.get(`/api/reels?space=${other}`)).data.reels, [], 'another space has its own');
    // someone who may only look sees and plays them, and removes nothing
    const theirs = await spaceReels(viewer); assert.equal(theirs.length, 4); assert.ok(theirs.every((x: any) => x.mayDelete === false));
    const seen = await viewer.raw('GET', `/api/reels/${r.id}/file`); assert.equal(seen.status, 200); await seen.arrayBuffer();
    assert.equal((await viewer.json('DELETE', `/api/reels/${r.id}`)).status, 403); assert.equal((await new Client(app.base).get(`/api/reels?space=${life}`)).status, 401);
    // deleting it removes its file
    const file = path.join(app.dataDir, 'media', 'reels', 'library', life, `${p.id}.mp4`); assert.ok(fs.existsSync(file));
    assert.equal((await owner.json('DELETE', `/api/reels/${p.id}`)).status, 200); assert.ok(!fs.existsSync(file)); assert.equal((await spaceReels()).length, 3);
    assert.equal((await owner.raw('GET', `/api/reels/${p.id}/file`)).status, 404);
  });

  it('is asked for and removed only by people who may change the story, and a reader may watch', async () => {
    const reel = (await owner.get(`/api/stories/${story}/reels`)).data.reels[0];
    assert.equal((await viewer.get(`/api/stories/${story}/reels`)).status, 200);
    const seen = await viewer.raw('GET', `/api/reels/${reel.id}/file`); assert.equal(seen.status, 200); await seen.arrayBuffer();
    assert.deepEqual([(await viewer.post(`/api/stories/${story}/reels`, { format: '9:16' })).status, (await viewer.json('DELETE', `/api/reels/${reel.id}`)).status, (await viewer.raw('GET', `/api/reels/${reel.id}/file?download=1`)).status], [403, 403, 403]);
    assert.equal((await new Client(app.base).raw('GET', `/api/reels/${reel.id}/file`)).status, 401);
    assert.equal((await owner.post(`/api/stories/${story}/reels`, { format: '4:3' })).status, 400);
    assert.equal((await owner.post(`/api/stories/${story}/reels`, { format: '9:16', music: 'builtin:nope' })).status, 400);
    const key = (await app.pool.query('select key from reels where id = $1', [reel.id])).rows[0].key, file = path.join(app.dataDir, 'media', key);
    assert.ok(fs.existsSync(file));
    assert.equal((await owner.json('DELETE', `/api/reels/${reel.id}`)).status, 200);
    assert.ok(!fs.existsSync(file), 'its file is removed');
    // deleting the story removes the reels that are left, files included
    const other = (await app.pool.query('select key from reels where story_id is not null')).rows[0].key;
    await owner.json('DELETE', `/api/stories/${story}`);
    assert.ok(!fs.existsSync(path.join(app.dataDir, 'media', other))); assert.equal((await app.pool.query('select count(*)::int n from reels where story_id is not null')).rows[0].n, 0);
    assert.deepEqual((await owner.get(`/api/reels?space=${life}`)).data.reels.map((x: any) => [x.from, x.title]), [['library', 'Two from the bay']], 'a reel made from the library does not go with the story');
    assert.deepEqual(fs.readdirSync(path.join(app.dataDir, 'tmp')).filter((n) => n.startsWith('reel-') && n !== 'reel-test'), [], 'no working files are left behind');
  });
});
