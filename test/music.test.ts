import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { TRACKS, render } from '../src/server/media/music.js';
import { Client, fixture, startApp } from './helpers.js';

describe('music', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let owner: Client, viewer: Client, life: string, story: string, tmp: string;
  const upload = async (who: Client, file: string, name = path.basename(file)) => { const fd = new FormData(); fd.set('file', new Blob([fs.readFileSync(file)]), name); const r = await who.raw('POST', '/api/music', { body: fd }); return { status: r.status, data: await r.json() as any }; };
  const probe = (buf: Buffer, ext: string) => { const f = path.join(tmp, `probe-${crypto.randomBytes(4).toString('hex')}${ext}`); fs.writeFileSync(f, buf); const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]).toString()); fs.rmSync(f); return j; };

  before(async () => {
    app = await startApp('ai_test_music'); tmp = path.join(app.dataDir, 'tmp');
    owner = new Client(app.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
    life = (await owner.get('/api/bootstrap')).data.spaces[0].id;
    const a = (await owner.upload(fixture('seaside.jpg'), life)).data.id; await owner.settled();
    story = (await owner.post('/api/stories', { title: 'With music', spaceId: life, ids: [a] })).data.id;
    const inv = await owner.post('/api/people/invite', { who: 'maria@example.com', role: 'viewer', spaceIds: [life] });
    viewer = new Client(app.base);
    await viewer.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: 'Maria', email: 'maria@example.com', password: 'a long enough password' });
  });
  after(async () => { await app.stop(); });

  it('composes ten pieces of its own, from still to driving, the same way every time', () => {
    assert.equal(TRACKS.length, 10);
    assert.deepEqual([...new Set(TRACKS.map((t) => t.energy))].sort(), [1, 2, 3, 4, 5], 'every energy level is there');
    assert.deepEqual(TRACKS.map((t) => t.energy), [...TRACKS.map((t) => t.energy)].sort((a, b) => a - b), 'listed from the quietest to the most driving');
    assert.equal(new Set(TRACKS.map((t) => t.name)).size, 10);
    const hash = (id: string) => { const { pcm } = render(id); return crypto.createHash('sha1').update(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)).digest('hex'); };
    assert.equal(hash('golden-hour'), hash('golden-hour'));
    // real sound: not silent, not clipped to a square, both speakers used, and the end meets the beginning
    for (const id of ['still-water', 'full-tilt']) {
      const { pcm, seconds } = render(id), n = pcm.length / 2; let sum = 0, peak = 0, diff = 0, flat = 0;
      for (let i = 0; i < n; i++) { const l = pcm[i * 2]! / 32768, r = pcm[i * 2 + 1]! / 32768; sum += l * l + r * r; peak = Math.max(peak, Math.abs(l), Math.abs(r)); diff += Math.abs(l - r); if (Math.abs(l) > 0.915) flat++; }
      const rms = 10 * Math.log10(sum / (2 * n));
      assert.ok(rms > -24 && rms < -11, `${id} is at a normal loudness: ${rms.toFixed(1)} dB`);
      assert.ok(peak <= 0.86 && flat / n === 0, `${id} is never clipped: peak ${peak.toFixed(2)}`);
      assert.ok(diff / n > 0.01, `${id} is in stereo`);
      assert.ok(Math.abs(n / 44100 - seconds) < 0.01 && seconds > 45 && seconds < 150);
      assert.ok(Math.abs(pcm[0]! - pcm[(n - 1) * 2]!) / 32768 < 0.08, `${id} loops without a jump`);
    }
  });

  it('lists the built-in pieces and makes one into a file the first time it is wanted', async () => {
    assert.equal((await new Client(app.base).get('/api/music')).status, 401);
    const list = (await owner.get('/api/music')).data;
    assert.equal(list.builtin.length, 10); assert.deepEqual(list.mine, []);
    assert.deepEqual(Object.keys(list.builtin[0]).sort(), ['bpm', 'energy', 'id', 'mood', 'name', 'seconds']);
    const ref = list.builtin.find((t: any) => t.name === 'Golden hour').id; assert.equal(ref, 'builtin:golden-hour');
    const t0 = Date.now(), res = await owner.raw('GET', `/api/music/${encodeURIComponent(ref)}/file`), first = Date.now() - t0;
    assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'audio/mp4');
    const j = probe(Buffer.from(await res.arrayBuffer()), '.m4a');
    assert.deepEqual([j.streams[0].codec_name, j.streams[0].channels], ['aac', 2]);
    assert.ok(Math.abs(Number(j.format.duration) - list.builtin.find((t: any) => t.id === ref).seconds) < 1.5, 'as long as the list says');
    const t1 = Date.now(); assert.equal((await owner.raw('GET', `/api/music/${encodeURIComponent(ref)}/file`)).status, 200);
    assert.ok(Date.now() - t1 < Math.max(400, first / 3), 'the second time it is already there');
    assert.equal((await owner.raw('GET', '/api/music/builtin%3Anot-a-track/file')).status, 404);
    assert.ok((await owner.get('/api/bootstrap')).data.musicVersion >= 4, 'the page is told which version of the music to ask for');
    assert.equal((await new Client(app.base).raw('GET', `/api/music/${encodeURIComponent(ref)}/file`)).status, 401);
  });

  it('takes tracks of your own, and only real music', async () => {
    const mp3 = path.join(tmp, 'My_Song.mp3');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-c:a', 'libmp3lame', '-b:a', '96k', mp3]);
    const up = await upload(owner, mp3);
    assert.equal(up.status, 200); assert.equal(up.data.name, 'My Song'); assert.ok(Math.abs(up.data.seconds - 3) < 0.3);
    assert.deepEqual((await owner.get('/api/music')).data.mine.map((t: any) => t.name), ['My Song']);
    const file = await owner.raw('GET', `/api/music/${up.data.id}/file`);
    assert.deepEqual([file.status, file.headers.get('content-type')], [200, 'audio/mpeg']);
    assert.equal(Buffer.from(await file.arrayBuffer()).length, fs.statSync(mp3).size, 'kept exactly as it was added');
    // not music
    assert.equal((await upload(owner, fixture('seaside.jpg'))).status, 415);
    const fake = path.join(tmp, 'fake.mp3'); fs.writeFileSync(fake, 'this is not sound');
    const bad = await upload(owner, fake); assert.equal(bad.status, 415); assert.match(bad.data.error, /could not be read as music/);
    // someone who may not edit can listen, and cannot add or remove
    assert.equal((await viewer.raw('GET', `/api/music/${up.data.id}/file`)).status, 200);
    assert.deepEqual([(await upload(viewer, mp3)).status, (await viewer.json('DELETE', `/api/music/${up.data.id}`)).status], [403, 403]);
    assert.equal((await owner.get('/api/music')).data.mine.length, 1);
  });

  it('gives a story its music, and a visitor with a link hears it too', async () => {
    const mine = (await owner.get('/api/music')).data.mine[0].id;
    const get = async () => (await owner.get('/api/stories')).data.stories.find((s: any) => s.id === story).music;
    assert.equal(await get(), null);
    assert.equal((await owner.json('PATCH', `/api/stories/${story}`, { music: 'builtin:summit' })).status, 200); assert.equal(await get(), 'builtin:summit');
    assert.equal((await owner.json('PATCH', `/api/stories/${story}`, { music: 'builtin:nope' })).status, 400);
    assert.equal((await owner.json('PATCH', `/api/stories/${story}`, { music: '00000000-0000-4000-8000-000000000000' })).status, 400);
    assert.equal(await get(), 'builtin:summit');
    assert.equal((await owner.json('PATCH', `/api/stories/${story}`, { music: mine })).status, 200);
    const link = (await owner.post(`/api/stories/${story}/links`, {})).data, token = new URL(link.url).pathname.split('/').pop(), v = new Client(app.base);
    assert.equal((await v.get(`/api/share/${token}`)).data.story.music, mine);
    const heard = await v.raw('GET', `/api/share/${token}/music`); assert.deepEqual([heard.status, heard.headers.get('content-type')], [200, 'audio/mpeg']); await heard.arrayBuffer();
    // removing a track leaves the stories that used it without music, not pointing at nothing
    assert.equal((await owner.json('DELETE', `/api/music/${mine}`)).status, 200);
    assert.equal(await get(), null); assert.equal((await v.raw('GET', `/api/share/${token}/music`)).status, 404);
    assert.deepEqual((await owner.get('/api/music')).data.mine, []);
    assert.equal((await owner.json('PATCH', `/api/stories/${story}`, { music: null })).status, 200);
  });
});
