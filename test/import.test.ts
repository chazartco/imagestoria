import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { importFolder } from '../src/server/cli-import.js';
import { Client, fixture, startApp } from './helpers.js';

describe('importing a folder from the command line', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let owner: Client;
  const folder = path.join(import.meta.dirname, 'tmp', 'import-source');

  before(async () => {
    app = await startApp('ai_test_import');
    owner = new Client(app.base);
    fs.rmSync(folder, { recursive: true, force: true });
    fs.mkdirSync(path.join(folder, 'trip', 'day 1'), { recursive: true });
    fs.copyFileSync(fixture('seaside.jpg'), path.join(folder, 'trip', 'day 1', 'seaside.jpg'));
    fs.copyFileSync(fixture('iphone.heic'), path.join(folder, 'trip', 'IMG_0001.HEIC'));
    fs.copyFileSync(fixture('clip.mp4'), path.join(folder, 'clip.mp4'));
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'not a photo');
    fs.writeFileSync(path.join(folder, '.DS_Store'), 'x');
  });
  after(async () => { await app.stop(); });

  it('needs the library to be set up first', async () => {
    await assert.rejects(importFolder(app.ctx.db, app.ctx.storage, folder), /Set up the library/);
    assert.equal((await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' })).status, 200);
  });

  it('reports what it would do without doing it', async () => {
    const r = await importFolder(app.ctx.db, app.ctx.storage, folder, { dryRun: true });
    assert.deepEqual(r, { added: 3, skipped: 0, failed: 0, ignored: 1 });
    assert.equal((await owner.get('/api/index')).data.items.length, 0);
  });

  it('adds photos and videos from every subfolder into the chosen space, and leaves the folder alone', async () => {
    await assert.rejects(importFolder(app.ctx.db, app.ctx.storage, folder, { space: 'nowhere' }), /no space called/);
    const r = await importFolder(app.ctx.db, app.ctx.storage, folder, { space: 'studio' });
    assert.deepEqual(r, { added: 3, skipped: 0, failed: 0, ignored: 1 });
    const idx = await owner.settled();
    const spaces = (await owner.get('/api/bootstrap')).data.spaces;
    const studio = spaces.find((s: any) => s.slug === 'studio').id;
    assert.equal(idx.items.length, 3);
    assert.ok(idx.items.every((i: any) => i.status === 'ready' && i.space === studio), JSON.stringify(idx.items.map((i: any) => [i.fileName, i.status, i.error])));
    const seaside = idx.items.find((i: any) => i.fileName === 'seaside.jpg');
    assert.equal(idx.places[seaside.place].name, 'Valencia');
    assert.ok(fs.existsSync(path.join(folder, 'trip', 'day 1', 'seaside.jpg')) && fs.existsSync(path.join(folder, 'clip.mp4')));
  });

  it('skips what is already in the library when run again', async () => {
    const r = await importFolder(app.ctx.db, app.ctx.storage, folder);
    assert.deepEqual(r, { added: 0, skipped: 3, failed: 0, ignored: 1 });
  });
});
