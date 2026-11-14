import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { decryptBackup, pgEnv, runBackup, scheduleDue } from '../src/server/backup.js';
import { loadConfig } from '../src/server/config.js';
import { Client, fixture, startApp } from './helpers.js';

const PG = process.env.TEST_PG ?? 'postgres://postgres@127.0.0.1:54329';
// These tests run the real pg_dump and pg_restore. They come with the PostgreSQL client, the database's version or newer.
const have = (bin: string) => spawnSync(bin, ['--version']).status === 0;
const tools = have('pg_dump') && have('pg_restore');
if (!tools) console.warn('SKIPPED: the backup tests need pg_dump and pg_restore on the PATH (the PostgreSQL client, version 16 or newer).');

describe('backups of the database', { skip: !tools }, () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let owner: Client, viewer: Client, dir: string;
  const state = async () => (await owner.get('/api/admin/overview')).data.backup;
  const fileOf = (key: string) => path.join(app.dataDir, 'media', key);
  /** how many rows every table holds, in every schema the app uses */
  const counts = async (url: string) => {
    const c = new pg.Client({ connectionString: url }); await c.connect();
    try {
      const tables = (await c.query(`select table_schema as s, table_name as t from information_schema.tables where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema') order by 1, 2`)).rows;
      const out: Record<string, number> = {};
      for (const { s, t } of tables) out[`${s}.${t}`] = (await c.query(`select count(*)::int as n from "${s}"."${t}"`)).rows[0].n;
      return out;
    } finally { await c.end(); }
  };
  const emptyDb = async (name: string) => { const c = new pg.Client({ connectionString: `${PG}/postgres` }); await c.connect(); await c.query(`drop database if exists ${name} with (force)`); await c.query(`create database ${name}`); await c.end(); return `${PG}/${name}`; };

  before(async () => {
    app = await startApp('ai_test_backup', { BACKUP_KEEP: '2' }); dir = path.join(app.dataDir, 'tmp', 'backup-test'); fs.mkdirSync(dir, { recursive: true });
    owner = new Client(app.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
    const life = (await owner.get('/api/bootstrap')).data.spaces[0].id;
    // a library with something in most tables: pictures, a tag, a like, a comment, a story with a link, a person, an edit
    const a = (await owner.upload(fixture('seaside.jpg'), life)).data.id, b = (await owner.upload(fixture('sideways.jpg'), life)).data.id; await owner.settled();
    await owner.post('/api/items/bulk', { ids: [a, b], action: 'tag', tags: ['bay'] });
    await owner.json('PUT', `/api/items/${a}/like`); await owner.post(`/api/items/${a}/comments`, { text: 'The light that evening.' });
    const story = (await owner.post('/api/stories', { title: 'By the water', spaceId: life, ids: [a, b] })).data.id;
    await owner.post(`/api/stories/${story}/links`, {});
    await owner.post(`/api/items/${a}/copies`, { recipe: { v: 2, adj: { matte: 30 }, geo: { rot: 0, flipH: false, flipV: false, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } }, curve: [0, 0.25, 0.5, 0.75, 1] } }); await owner.settled(60000);
    const inv = await owner.post('/api/people/invite', { who: 'maria@example.com', role: 'viewer', spaceIds: [life] });
    viewer = new Client(app.base);
    await viewer.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: 'Maria', email: 'maria@example.com', password: 'a long enough password' });
  });
  after(async () => { await app.stop(); });

  it('is off until a time of day is set, and refuses a time that is not one', () => {
    const base = { DATABASE_URL: 'postgres://u@h/d' };
    assert.deepEqual([loadConfig(base).BACKUP_SCHEDULE, loadConfig({ ...base, BACKUP_SCHEDULE: 'off' }).BACKUP_SCHEDULE, loadConfig({ ...base, BACKUP_SCHEDULE: '03:30' }).BACKUP_SCHEDULE, loadConfig(base).BACKUP_KEEP], ['', '', '03:30', 14]);
    for (const bad of ['25:00', '3am', '03:60', 'nightly']) assert.throws(() => loadConfig({ ...base, BACKUP_SCHEDULE: bad }), /BACKUP_SCHEDULE/);
    assert.equal(scheduleDue('03:30', new Date(2026, 0, 5, 3, 30, 40)), true); assert.equal(scheduleDue('03:30', new Date(2026, 0, 5, 3, 31, 0)), false); assert.equal(scheduleDue('', new Date()), false);
    // the password goes to pg_dump in the environment, never on its command line
    assert.deepEqual(pgEnv('postgres://after%40image:p%2Fw@db.example.com:6543/photos?sslmode=require'), { PGHOST: 'db.example.com', PGPORT: '6543', PGDATABASE: 'photos', PGUSER: 'after@image', PGPASSWORD: 'p/w', PGSSLMODE: 'require' });
  });

  it('writes one compressed dump to storage when an owner asks, and says so on the settings page', async () => {
    const first = await state();
    assert.deepEqual([first.schedule, first.keep, first.encrypted, first.where, first.last, first.failure, first.count], [null, 2, false, 'disk', null, null, 0]);
    assert.equal((await viewer.post('/api/admin/backup')).status, 403); assert.equal((await new Client(app.base).post('/api/admin/backup')).status, 401);
    const r = await owner.post('/api/admin/backup'); assert.equal(r.status, 200, JSON.stringify(r.data));
    const last = r.data.last; assert.match(last.key, /^backups\/afterimage-\d{8}-\d{6}\.dump$/);
    assert.ok(Math.abs(last.at - Date.now()) < 60000); assert.equal(last.bytes, fs.statSync(fileOf(last.key)).size); assert.ok(last.bytes > 5000);
    assert.equal(fs.readFileSync(fileOf(last.key)).subarray(0, 5).toString('latin1'), 'PGDMP', 'a pg_dump file in the custom format');
    assert.deepEqual([(await state()).count, (await state()).last.key], [1, last.key]);
    assert.deepEqual(fs.readdirSync(path.join(app.dataDir, 'tmp')).filter((f) => f.startsWith('backup-') && f.endsWith('.part')), [], 'nothing is left in the working folder');
    const act = (await owner.get('/api/admin/overview')).data.activity.map((x: any) => x.text).join('\n'); assert.match(act, /backed up the database/);
  });

  it('restores into an empty database with every row of every table', async () => {
    const key = (await state()).last.key, url = await emptyDb('ai_test_backup_restored');
    const res = spawnSync('pg_restore', ['--no-owner', '--exit-on-error', '-d', url, fileOf(key)], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    // The backup is a picture of the moment it was taken. Only two things were written after that moment, by the backup
    // itself: its line in the activity log and its entry in the list of backups. Everything else must agree table by table.
    const [was, is] = [await counts(`${PG}/ai_test_backup`), await counts(url)];
    assert.deepEqual(is, { ...was, 'public.activity': was['public.activity']! - 1, 'public.settings': was['public.settings']! - 1 });
    assert.ok(Object.keys(was).length >= 15, 'every table was compared: ' + Object.keys(was).length);
    for (const t of ['public.items', 'public.users', 'public.stories', 'public.story_items', 'public.story_links', 'public.tags', 'public.item_tags', 'public.likes', 'public.comments', 'public.sessions', 'public.activity']) assert.ok(was[t]! > 0, `${t} had rows to restore`);
    // and what was written is there to read
    const c = new pg.Client({ connectionString: url }); await c.connect();
    assert.equal((await c.query(`select title from stories`)).rows[0].title, 'By the water'); assert.equal((await c.query(`select recipe->>'v' as v from items where copy_of is not null`)).rows[0].v, '2');
    await c.end();
  });

  it('encrypts the dump when a passphrase is set, in a form openssl opens without this app', async () => {
    (app.cfg as any).BACKUP_PASSPHRASE = 'three quiet herons at dusk';
    const r = await owner.post('/api/admin/backup'); assert.equal(r.status, 200, JSON.stringify(r.data));
    const last = r.data.last, f = fileOf(last.key);
    assert.match(last.key, /\.dump\.enc$/); assert.equal(last.encrypted, true); assert.equal(r.data.encrypted, true);
    const raw = fs.readFileSync(f); assert.equal(raw.subarray(0, 8).toString('latin1'), 'Salted__'); assert.ok(!raw.includes(Buffer.from('PGDMP')) && !raw.includes(Buffer.from('chaz@example.com')), 'nothing readable is left in it');
    const mine = path.join(dir, 'opened.dump'), theirs = path.join(dir, 'opened-by-openssl.dump');
    await decryptBackup(f, mine, 'three quiet herons at dusk');
    execFileSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '600000', '-md', 'sha256', '-in', f, '-out', theirs, '-pass', 'pass:three quiet herons at dusk']);
    assert.ok(fs.readFileSync(mine).equals(fs.readFileSync(theirs)), 'openssl gets the same file out'); assert.equal(fs.readFileSync(mine).subarray(0, 5).toString('latin1'), 'PGDMP');
    const url = await emptyDb('ai_test_backup_restored'); assert.equal(spawnSync('pg_restore', ['--no-owner', '--exit-on-error', '-d', url, mine]).status, 0);
    assert.deepEqual((await counts(url))['public.items'], (await counts(`${PG}/ai_test_backup`))['public.items']);
    await assert.rejects(decryptBackup(f, path.join(dir, 'wrong.dump'), 'not the passphrase'), /passphrase is wrong/); assert.ok(!fs.existsSync(path.join(dir, 'wrong.dump')));
    await assert.rejects(decryptBackup(fixture('seaside.jpg'), path.join(dir, 'x.dump'), 'x'), /not an encrypted backup/);
    (app.cfg as any).BACKUP_PASSPHRASE = '';
  });

  it('keeps the newest ones and removes the oldest beyond BACKUP_KEEP', async () => {
    const two = fs.readdirSync(fileOf('backups')).sort(); assert.equal(two.length, 2);
    const r = await owner.post('/api/admin/backup'); assert.equal(r.status, 200);
    const now = fs.readdirSync(fileOf('backups')).sort();
    assert.equal(now.length, 2, 'still two: ' + now); assert.ok(!now.includes(two[0]!), 'the oldest is gone'); assert.ok(now.includes(path.basename(r.data.last.key)));
    assert.deepEqual([r.data.count, r.data.bytes], [2, now.reduce((a, f) => a + fs.statSync(path.join(fileOf('backups'), f)).size, 0)]);
  });

  it('runs one at a time, whoever asks', async () => {
    const [a, b] = await Promise.all([runBackup(app.ctx, 'one'), runBackup(app.ctx, 'two')]);
    const busy = [a, b].filter((r) => 'busy' in r), ok = [a, b].filter((r) => 'ok' in r && r.ok);
    assert.deepEqual([busy.length, ok.length], [1, 1], JSON.stringify([a, b]));
    // the lock is let go afterwards
    assert.ok('ok' in (await runBackup(app.ctx, 'three')));
    const held = await app.pool.query(`select count(*)::int as n from pg_locks where locktype = 'advisory'`); assert.equal(held.rows[0].n, 0);
  });

  it('keeps the reason when a backup fails, shows it, and clears it when one works again', async () => {
    const before = (await state()).last.key;
    (app.cfg as any).PG_DUMP = '/nowhere/pg_dump';
    const r = await owner.post('/api/admin/backup'); assert.equal(r.status, 500); assert.match(r.data.error, /^The backup failed\. The pg_dump program was not found/);
    let s = await state(); assert.match(s.failure.reason, /pg_dump program was not found/); assert.ok(Math.abs(s.failure.at - Date.now()) < 60000); assert.equal(s.last.key, before, 'the backups that exist are untouched');
    // a database it cannot reach
    (app.cfg as any).PG_DUMP = 'pg_dump'; const real = app.cfg.DATABASE_URL; (app.cfg as any).DATABASE_URL = real.replace(/\/[^/]+$/, '/ai_test_no_such_database');
    const r2 = await runBackup(app.ctx, 'x'); (app.cfg as any).DATABASE_URL = real;
    assert.ok('ok' in r2 && !r2.ok && /does not exist/.test(r2.reason), JSON.stringify(r2));
    assert.equal((await owner.post('/api/admin/backup')).status, 200); s = await state(); assert.equal(s.failure, null); assert.notEqual(s.last.key, before);
  });
});
