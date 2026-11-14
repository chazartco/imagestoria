import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { lookAtVideo, playArgs } from '../src/server/media/playcopy.js';
import { Client, fixture, startApp } from './helpers.js';

describe('a copy of a video that every browser can play', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let owner: Client, viewer: Client, life: string, dir: string;
  const clip: Record<string, string> = {};
  const ff = (...args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  const probe = (f: string) => { const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]).toString()); return { j, v: j.streams.find((s: any) => s.codec_type === 'video'), a: j.streams.find((s: any) => s.codec_type === 'audio') }; };
  const item = async (id: string) => (await owner.get('/api/index')).data.items.find((i: any) => i.id === id);
  /** wait until the copy of one item is settled, one way or the other */
  const copied = async (id: string, ms = 90000) => { for (const t0 = Date.now(); ;) { const i = await item(id); if (i.play === 'none' || i.play === 'ready' || i.play === 'failed') return i; if (Date.now() - t0 > ms) throw new Error('the copy never finished: ' + i.play); await new Promise((r) => setTimeout(r, 300)); } };
  const fetchTo = async (who: Client, url: string, name: string) => { const res = await who.raw('GET', url); assert.equal(res.status, 200, url); const f = path.join(dir, name); fs.writeFileSync(f, Buffer.from(await res.arrayBuffer())); return { f, type: res.headers.get('content-type') }; };
  const add = async (name: string) => { const r = await owner.upload(clip[name]!, life); assert.equal(r.status, 200, JSON.stringify(r.data)); await owner.settled(60000); return r.data.id as string; };
  const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

  before(async () => {
    app = await startApp('ai_test_video', { VIDEO_COPY_MAX_EDGE: '320' }); dir = path.join(app.dataDir, 'tmp', 'video-test'); fs.mkdirSync(dir, { recursive: true });
    owner = new Client(app.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
    life = (await owner.get('/api/bootstrap')).data.spaces[0].id;
    const inv = await owner.post('/api/people/invite', { who: 'maria@example.com', role: 'viewer', spaceIds: [life] });
    viewer = new Client(app.base);
    await viewer.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: 'Maria', email: 'maria@example.com', password: 'a long enough password' });
    // Small clips, each a different picture so no two are the same file, in the forms a library really meets.
    const pic = (n: number, size = '640x360') => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=2,hue=h=${n * 40}`], tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'];
    const p = (n: string) => (clip[n.replace(/\..*$/, '')] = path.join(dir, n));
    ff(...pic(1), ...tone, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p('fine.mp4'));
    ff(...pic(2), ...tone, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p('boxed.mkv'));
    ff(...pic(3), ...tone, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', p('camera.mov'));
    ff(...pic(4), ...tone, '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'pcm_s16le', '-shortest', p('old.avi'));
    ff(...pic(5), '-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', p('phone.mp4'));
    // HDR as a phone writes it: 10-bit, wide color, the PQ curve. The picture is a bright colored test card.
    ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2', '-vf', 'format=yuv420p,zscale=pin=bt709:tin=bt709:min=bt709:rin=tv:p=bt2020:t=smpte2084:m=bt2020nc:r=tv:npl=203,format=yuv420p10le',
      '-c:v', 'libx265', '-x265-params', 'log-level=error', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1', p('hdr.mp4'));
    // held sideways: the pixels lie on their side and a note in the file says to turn them
    ff(...pic(6, '640x360'), '-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', path.join(dir, 'flat.mp4'));
    ff('-display_rotation:v:0', '90', '-i', path.join(dir, 'flat.mp4'), '-c', 'copy', p('sideways.mp4'));
    fs.writeFileSync(p('broken.mkv'), Buffer.concat([fs.readFileSync(clip.boxed!).subarray(0, 3000), crypto.randomBytes(4000)]));
  });
  after(async () => { await app.stop(); });

  it('looks at a video and says what it needs', async () => {
    const plan = async (n: string, mode: 'auto' | 'always' | 'never' = 'auto') => { const l = await lookAtVideo(clip[n]!, mode); return [l.plan, l.hdr]; };
    assert.deepEqual(await plan('fine'), ['none', null]);
    assert.deepEqual(await plan('boxed'), ['remux', null]);
    assert.deepEqual(await plan('camera'), ['audio', null]);
    assert.deepEqual(await plan('old'), ['encode', null]);
    assert.deepEqual(await plan('phone'), ['encode', null]);
    assert.deepEqual(await plan('hdr'), ['encode', 'smpte2084']);
    assert.deepEqual([await plan('fine', 'always'), await plan('old', 'never')], [['encode', null], ['none', null]]);
    assert.match((await lookAtVideo(clip.old!, 'auto')).why, /mpeg4/); assert.match((await lookAtVideo(clip.boxed!, 'auto')).why, /matroska/);
    // ffmpeg is only ever given local files
    for (const p of ['remux', 'audio', 'encode'] as const) { const a = playArgs({ plan: p, hdr: null, why: '', duration: 2 }, '/in.mkv', '/out.mp4', 1920); assert.deepEqual(a.slice(a.indexOf('-protocol_whitelist'), a.indexOf('-protocol_whitelist') + 4), ['-protocol_whitelist', 'file', '-i', '/in.mkv']); assert.ok(a.includes('-nostdin') && a.join(' ').includes('+faststart')); }
  });

  it('leaves a video alone when it already plays, and "play" then gives the original', async () => {
    const id = await add('fine'), i = await copied(id);
    assert.equal(i.play, 'none');
    const got = await fetchTo(owner, `/api/files/${id}/play`, 'fine-play.mp4');
    assert.equal(sha(got.f), sha(clip.fine!)); assert.equal(got.type, 'video/mp4');
    assert.equal((await owner.get('/api/admin/overview')).data.video.copies, 0);
  });

  it('repackages without re-encoding when only the file around the video is the problem', async () => {
    const id = await add('boxed'), i = await copied(id);
    assert.equal(i.play, 'ready', i.playError);
    const got = await fetchTo(owner, `/api/files/${id}/play`, 'boxed-play.mp4'), o = probe(clip.boxed!), c = probe(got.f);
    assert.equal(got.type, 'video/mp4'); assert.match(c.j.format.format_name, /mp4/);
    assert.deepEqual([c.v.codec_name, c.v.width, c.v.height, c.a.codec_name], ['h264', 640, 360, 'aac'], 'not resized: the video was copied as it is');
    assert.equal(c.v.nb_frames, '60'); assert.ok(Math.abs(Number(c.v.bit_rate) - Number(o.v.bit_rate ?? c.v.bit_rate)) / Number(c.v.bit_rate) < 0.2 || !o.v.bit_rate);
    // the same pictures, bit for bit: the video stream was not encoded again
    const frames = (f: string) => crypto.createHash('md5').update(spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v:0', '-c', 'copy', '-f', 'h264', '-bsf:v', 'h264_mp4toannexb', '-'], { maxBuffer: 64 << 20 }).stdout).digest('hex');
    assert.equal(frames(got.f), frames(clip.boxed!));
    const head = fs.readFileSync(got.f).subarray(0, 4096).toString('latin1'); assert.ok(head.includes('moov'), 'the index is at the front, so it starts playing at once');
    // the original is untouched and is what a download gives
    const orig = await fetchTo(owner, `/api/files/${id}/orig?download=1`, 'boxed-orig.mkv'); assert.equal(sha(orig.f), sha(clip.boxed!));
  });

  it('copies the video and only remakes the sound when the sound is the problem', async () => {
    const id = await add('camera'), i = await copied(id); assert.equal(i.play, 'ready', i.playError);
    const c = probe((await fetchTo(owner, `/api/files/${id}/play`, 'camera-play.mp4')).f);
    assert.deepEqual([c.v.codec_name, c.v.width, c.a.codec_name, c.a.channels], ['h264', 640, 'aac', 2]);
  });

  it('makes an H.264 copy of anything else: same shape, no larger than the limit, 8-bit, sound as AAC', async () => {
    for (const n of ['old', 'phone']) {
      const id = await add(n), i = await copied(id); assert.equal(i.play, 'ready', i.playError);
      const got = await fetchTo(owner, `/api/files/${id}/play`, `${n}-play.mp4`), c = probe(got.f);
      assert.deepEqual([c.v.codec_name, c.v.pix_fmt, c.v.width, c.v.height], ['h264', 'yuv420p', 320, 180], n + ': the long edge is held to VIDEO_COPY_MAX_EDGE and the shape is kept');
      if (n === 'old') assert.deepEqual([c.a.codec_name, c.a.channels], ['aac', 2]); else assert.equal(c.a, undefined, 'a silent video stays silent');
      assert.ok(Math.abs(Number(c.j.format.duration) - 2) < 0.2);
      assert.ok(fs.readFileSync(got.f).subarray(0, 4096).toString('latin1').includes('moov'));
      // someone who may look may play, and the item itself is as it was
      assert.equal((await viewer.raw('GET', `/api/files/${id}/play`)).status, 200); assert.deepEqual([i.status, i.w, i.h], ['ready', 640, 360]);
    }
    const o = (await owner.get('/api/admin/overview')).data;
    assert.ok(o.video.copies >= 4 && o.video.bytes > 10000 && o.storage.play === o.video.bytes, 'the copies are counted on the storage page');
    assert.deepEqual([o.video.mode, o.video.maxEdge, o.video.waiting, o.video.failed], ['auto', 320, 0, 0]);
  });

  it('turns a sideways video upright', async () => {
    const id = await add('sideways'), i = await copied(id); assert.equal(i.play, 'ready', i.playError);
    assert.deepEqual([i.w, i.h], [360, 640], 'the item is tall');
    const c = probe((await fetchTo(owner, `/api/files/${id}/play`, 'sideways-play.mp4')).f);
    assert.deepEqual([c.v.width, c.v.height], [180, 320], 'and so is its copy, with nothing left to turn');
    assert.ok(!(c.v.side_data_list ?? []).some((s: any) => s.rotation), 'no turn is left in the file');
  });

  it('tone-maps HDR so the copy is not grey and washed out', async () => {
    const id = await add('hdr'), i = await copied(id); assert.equal(i.play, 'ready', i.playError);
    const got = await fetchTo(owner, `/api/files/${id}/play`, 'hdr-play.mp4'), c = probe(got.f);
    assert.deepEqual([c.v.codec_name, c.v.pix_fmt, c.v.color_transfer, c.v.color_primaries], ['h264', 'yuv420p', 'bt709', 'bt709']);
    // Three frames to compare: the card as it was drawn, the copy, and what comes out when HDR is squeezed to 8 bits with no tone mapping.
    const frame = async (args: string[], name: string) => { const f = path.join(dir, name); ff(...args, '-frames:v', '1', f); const s = await sharp(f).removeAlpha().resize(64, 36, { fit: 'fill' }).raw().toBuffer(); let sat = 0, lum = 0; for (let k = 0; k < s.length; k += 3) { sat += Math.max(s[k]!, s[k + 1]!, s[k + 2]!) - Math.min(s[k]!, s[k + 1]!, s[k + 2]!); lum += 0.2126 * s[k]! + 0.7152 * s[k + 1]! + 0.0722 * s[k + 2]!; } return { sat: sat / (s.length / 3), lum: lum / (s.length / 3) }; };
    const drawn = await frame(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=1'], 'hdr-0-as-drawn.png');
    const naive = await frame(['-i', clip.hdr!, '-vf', 'format=yuv420p,format=rgb24', '-color_trc', 'bt709'], 'hdr-1-before-no-tone-mapping.png');
    const copy = await frame(['-i', got.f], 'hdr-2-after-tone-mapped.png');
    assert.ok(naive.sat < drawn.sat * 0.6, `without tone mapping the colors are washed out: ${naive.sat.toFixed(0)} against ${drawn.sat.toFixed(0)} as drawn`);
    assert.ok(copy.sat > drawn.sat * 0.7 && copy.sat > naive.sat * 1.4, `the copy has its color back: ${copy.sat.toFixed(0)}`);
    assert.ok(Math.abs(copy.lum - drawn.lum) < 45, `and is about as bright as the scene: ${copy.lum.toFixed(0)} against ${drawn.lum.toFixed(0)}`);
  });

  it('notes a copy that cannot be made on the item, and leaves the item itself alone', async () => {
    // a file that passes as a video on the way in and then cannot be read through
    const [made] = (await app.pool.query(`insert into items (space_id, kind, status, file_name, mime, sha256, taken_at, orig_key, width, height) values ($1, 'video', 'ready', 'broken.mkv', 'video/x-matroska', 'x-broken', now(), 'originals/broken.mkv', 640, 360) returning id`, [life])).rows;
    fs.mkdirSync(path.join(app.dataDir, 'media', 'originals'), { recursive: true }); fs.copyFileSync(clip.broken!, path.join(app.dataDir, 'media', 'originals', 'broken.mkv'));
    assert.equal((await owner.post('/api/admin/video-copies')).data.n, 1, 'the button takes up the videos nobody has looked at');
    const i = await copied(made.id);
    assert.equal(i.play, 'failed'); assert.match(i.playError, /^The copy could not be made\. \S/); assert.equal(i.status, 'ready', 'the item is not marked as failed');
    assert.equal((await owner.raw('GET', `/api/files/${made.id}/play`)).headers.get('content-type'), 'video/x-matroska', 'play falls back to the original');
    assert.equal((await owner.get('/api/admin/overview')).data.video.failed, 1);
    assert.equal((await viewer.post('/api/admin/video-copies')).status, 403);
    // nothing is left behind in the working folder
    assert.deepEqual(fs.readdirSync(path.join(app.dataDir, 'tmp')).filter((f) => f.startsWith('play-')), []);
    await app.pool.query('delete from items where id = $1', [made.id]);
  });

  it('never makes a photo wait: copies are taken one at a time, and only when nothing else is in line', async () => {
    // ten videos that all need encoding, then a photo
    await app.pool.query(`update items set play_status = null, play_key = null, bytes_play = 0 where kind = 'video' and file_name in ('old.avi', 'phone.mp4', 'hdr.mp4', 'sideways.mp4')`);
    (app.cfg as any).VIDEO_COPY = 'always';
    assert.equal((await owner.post('/api/admin/video-copies')).data.n, 4);
    const t0 = Date.now(), photo = (await owner.upload(fixture('seaside.jpg'), life)).data.id; await owner.settled(30000);
    const waiting = (await owner.get('/api/admin/overview')).data.video.waiting, running = (await app.pool.query(`select count(*)::int as n from jobs where type = 'playcopy' and status = 'running'`)).rows[0].n;
    assert.equal((await item(photo)).status, 'ready'); assert.ok(Date.now() - t0 < 15000, 'the photo did not wait for the videos');
    assert.ok(running <= 1, 'one copy at a time');
    for (const n of ['old.avi', 'phone.mp4', 'hdr.mp4', 'sideways.mp4']) { const id = (await owner.get('/api/index')).data.items.find((x: any) => x.fileName === n).id; assert.equal((await copied(id)).play, 'ready'); }
    assert.ok(waiting >= 0);
    (app.cfg as any).VIDEO_COPY = 'auto';
    assert.equal((await owner.post('/api/admin/video-copies')).data.n, 0, 'nothing is left to look at');
    (app.cfg as any).VIDEO_COPY = 'never';
    assert.equal((await owner.post('/api/admin/video-copies')).status, 400);
    (app.cfg as any).VIDEO_COPY = 'auto';
  });

  it('removes the copy with the item when the trash is emptied', async () => {
    const it0 = (await owner.get('/api/index')).data.items.find((x: any) => x.fileName === 'boxed.mkv'), d = it0.d as string;
    const file = path.join(app.dataDir, 'media', 'video', d.slice(0, 4), d.slice(5, 7), `${it0.id}.mp4`);
    assert.ok(fs.existsSync(file), 'the copy is stored at video/{year}/{month}/{item id}.mp4');
    await owner.post('/api/items/bulk', { ids: [it0.id], action: 'delete' });
    assert.equal((await owner.raw('GET', `/api/files/${it0.id}/play`)).status, 404);
    assert.ok(fs.existsSync(file), 'kept while the item is in the trash');
    const out = (await owner.post('/api/trash/empty', { ids: [it0.id] })).data; assert.equal(out.n, 1);
    assert.ok(!fs.existsSync(file)); assert.ok(out.bytes > fs.statSync(clip.boxed!).size, 'and its size is counted in what was freed');
  });
});
