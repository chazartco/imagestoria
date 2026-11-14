import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, fixture, startApp } from './helpers.js';

/** The refinements made after Phase 2 (docs/prompts/01-refinements.md), group C: stories. */
describe('stories: covers and sections', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let owner: Client, reader: Client, life: string, story: string;
  let a: string, b: string, c: string, d: string;
  const get = async (who = owner) => (await who.get('/api/stories')).data.stories.find((s: any) => s.id === story);
  const patch = (body: unknown, who = owner) => who.json('PATCH', `/api/stories/${story}`, body);

  before(async () => {
    app = await startApp('ai_test_stories');
    owner = new Client(app.base);
    await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' });
    life = (await owner.get('/api/bootstrap')).data.spaces[0].id;
    [a, b, c, d] = await Promise.all(['seaside.jpg', 'plain.png', 'sideways.jpg', 'clip.mp4'].map(async (f) => (await owner.upload(fixture(f), life)).data.id)) as [string, string, string, string];
    await owner.settled();
    story = (await owner.post('/api/stories', { title: 'Four things', spaceId: life, ids: [a, b, c, d], cover: b })).data.id;
    // a commenter the story is shared with: may read it, may not change it
    const inv = await owner.post('/api/people/invite', { who: 'tomas@example.com', role: 'commenter', spaceIds: [life] });
    reader = new Client(app.base);
    await reader.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name: 'Tomás', email: 'tomas@example.com', password: 'a long enough password' });
    await patch({ shared: [(await reader.get('/api/me')).data.id] });
  });
  after(async () => { await app.stop(); });

  it('starts with one cover picture and no sections of its own', async () => {
    const s = await get();
    assert.deepEqual([s.cover, s.covers, s.sections], [b, [b], null]);
    assert.deepEqual([...s.ids].sort(), [a, b, c, d].sort());
  });

  it('keeps a cover of up to four pictures in the order they were chosen', async () => {
    assert.equal((await patch({ covers: [c, a, d] })).status, 200);
    let s = await get();
    assert.deepEqual([s.covers, s.cover], [[c, a, d], c], 'the first of them is still "the cover" for anything older');
    assert.equal((await app.pool.query('select cover_item_id from stories where id = $1', [story])).rows[0].cover_item_id, c, 'cover_item_id is kept in step');
    assert.equal((await patch({ covers: [a, b, c, d] })).status, 200);
    assert.equal((await patch({ covers: [] })).status, 400, 'a story keeps a cover');
    assert.equal((await patch({ covers: [a, a] })).status, 400);
    assert.equal((await patch({ covers: [a, '00000000-0000-4000-8000-000000000000'] })).status, 400, 'only pictures of the story itself');
    const five = (await owner.upload(fixture('iphone.heic'), life)).data.id; await owner.settled();
    assert.equal((await patch({ covers: [a, b, c, d, five] })).status, 400, 'four at most');
    s = await get(); assert.deepEqual(s.covers, [a, b, c, d]);
  });

  it('drops a cover picture that is deleted, and takes it back if it returns', async () => {
    await owner.post('/api/items/bulk', { ids: [a, c], action: 'delete' });
    let s = await get();
    assert.deepEqual([s.covers, s.cover], [[b, d], b]);
    await owner.post('/api/trash/restore');
    s = await get(); assert.deepEqual(s.covers, [a, b, c, d]);
  });

  it('still shows the cover of a story made before covers were a list', async () => {
    await app.pool.query(`update stories set cover_ids = '{}', cover_item_id = $2 where id = $1`, [story, d]);
    assert.deepEqual((await get()).covers, [d]);
    await patch({ covers: [a, b] });
  });

  it('stores the author\'s sections and the order of the pictures inside them', async () => {
    await patch({ notes: { 'Fri Aug 14 2026': 'Written while the story arranged itself.' } });
    const mine = [{ title: 'The end first', text: 'Why not.', ids: [d, a] }, { title: '', text: 'And the rest.', ids: [c, b] }];
    assert.equal((await patch({ sections: mine })).status, 200);
    let s = await get();
    assert.deepEqual(s.sections, mine);
    assert.deepEqual(s.ids, [d, a, c, b], 'the order of the story is the author\'s, not the date\'s');
    assert.equal(s.notes['Fri Aug 14 2026'], 'Written while the story arranged itself.', 'earlier notes are kept, untouched');
    // the page always sends the whole arrangement: moving a picture into another section is just a new list
    const moved = [{ title: 'The end first', text: 'Why not.', ids: [a] }, { title: 'Second', text: 'And the rest.', ids: [c, d, b] }];
    await patch({ sections: moved });
    s = await get(); assert.deepEqual([s.sections, s.ids], [moved, [a, c, d, b]]);
    assert.equal((await app.pool.query('select count(*)::int n from story_sections where story_id = $1', [story])).rows[0].n, 2, 'the old rows are replaced, not piled up');
  });

  it('refuses an arrangement that does not match the story', async () => {
    const ok = (await get()).sections;
    for (const bad of [
      [{ title: 'x', text: '', ids: [a, a] }, { title: 'y', text: '', ids: [b, c, d] }],
      [{ title: 'x', text: '', ids: [a, b] }, { title: 'y', text: '', ids: [b, c, d] }],
      [{ title: 'x', text: '', ids: [a, '00000000-0000-4000-8000-000000000000'] }],
      [{ title: 'x', text: '', ids: [] }],
      [],
    ]) assert.equal((await patch({ sections: bad })).status, 400, JSON.stringify(bad));
    assert.deepEqual((await get()).sections, ok, 'nothing was changed by the refused ones');
  });

  it('keeps a picture that is in the trash while the story is rearranged', async () => {
    await owner.post('/api/items/bulk', { ids: [c], action: 'delete' });
    let s = await get();
    assert.deepEqual(s.sections.map((x: any) => x.ids), [[a], [d, b]], 'a trashed picture is not shown');
    // the page cannot see the trashed picture, so its arrangement leaves it out
    await patch({ sections: [{ title: 'One', text: '', ids: [b, a] }, { title: 'Two', text: '', ids: [d] }] });
    await owner.post('/api/trash/restore');
    s = await get();
    assert.deepEqual(s.sections.map((x: any) => x.ids), [[b, a], [d, c]], 'back from the trash, it is at the end of the last section');
  });

  it('lets people the story is shared with read the arrangement, and nobody but its author or an owner change it', async () => {
    const seen = await get(reader);
    assert.deepEqual([seen.sections.map((x: any) => x.title), seen.covers], [['One', 'Two'], [a, b]]);
    assert.equal((await patch({ covers: [d] }, reader)).status, 403);
    assert.equal((await patch({ sections: null }, reader)).status, 403);
    assert.equal((await patch({ sections: [{ title: 'Mine now', text: '', ids: [a, b, c, d] }] }, reader)).status, 403);
    assert.deepEqual((await get()).sections.map((x: any) => x.title), ['One', 'Two']);
  });

  it('goes back to arranging itself, with the notes written before', async () => {
    assert.equal((await patch({ sections: null })).status, 200);
    const s = await get();
    assert.equal(s.sections, null);
    assert.deepEqual([...s.ids].sort(), [a, b, c, d].sort());
    assert.equal(s.notes['Fri Aug 14 2026'], 'Written while the story arranged itself.');
    assert.deepEqual((await app.pool.query('select count(*)::int n, count(section_id)::int with_section from story_items where story_id = $1', [story])).rows[0], { n: 4, with_section: 0 });
    assert.equal((await app.pool.query('select count(*)::int n from story_sections')).rows[0].n, 0);
  });

  it('takes pictures out of a story, one at a time or a section at a time, and leaves them in the library', async () => {
    // an automatic story: one picture out, nothing else changes
    await patch({ covers: [a, b] });
    assert.equal((await patch({ remove: [a] })).status, 200);
    let s = await get();
    assert.deepEqual([[...s.ids].sort(), s.sections, s.covers], [[b, c, d].sort(), null, [b]], 'it left the story and its cover');
    assert.ok((await owner.get('/api/index')).data.items.some((i: any) => i.id === a), 'it is still in the library');
    // put back, which is how the page undoes it
    assert.equal((await patch({ add: [a], covers: [a, b] })).status, 200);
    s = await get(); assert.deepEqual([[...s.ids].sort(), s.covers], [[a, b, c, d].sort(), [a, b]]);
    // by section: the section goes with its pictures, and the page sends what is left
    await patch({ sections: [{ title: 'Keep', text: 'kept words', ids: [a, b] }, { title: 'Drop', text: 'dropped words', ids: [c, d] }] });
    assert.equal((await patch({ remove: [c, d], sections: [{ title: 'Keep', text: 'kept words', ids: [a, b] }] })).status, 200);
    s = await get(); assert.deepEqual([s.sections, s.ids], [[{ title: 'Keep', text: 'kept words', ids: [a, b] }], [a, b]]);
    // removing without sending the arrangement still leaves no empty section behind
    await patch({ add: [c, d], sections: [{ title: 'Keep', text: '', ids: [a, b] }, { title: 'Drop', text: '', ids: [c, d] }] });
    await patch({ remove: [c, d] });
    s = await get(); assert.deepEqual(s.sections.map((x: any) => [x.title, x.ids]), [['Keep', [a, b]]]);
    assert.equal((await app.pool.query('select count(*)::int n from story_sections where story_id = $1', [story])).rows[0].n, 1);
    // a picture added back to a story with sections lands in the last one
    await patch({ add: [c] }); s = await get(); assert.deepEqual(s.sections.map((x: any) => x.ids), [[a, b, c]]);
    // limits
    assert.equal((await patch({ remove: [a, b, c] })).status, 400, 'a story keeps at least one picture');
    assert.deepEqual((await get()).ids, [a, b, c]);
    assert.equal((await patch({ remove: [a] }, reader)).status, 403);
    assert.equal((await patch({ add: [d] }, reader)).status, 403);
    assert.equal((await patch({ sections: [{ title: 'x', text: '', ids: [a, b, c] }], remove: [c] })).status, 400, 'an arrangement cannot name a picture that is being removed');
    await patch({ add: ['00000000-0000-4000-8000-000000000000'] }); assert.deepEqual((await get()).ids, [a, b, c], 'only real items of the same space can be added');
  });

  it('lets owners and editors change any story and choose who reads it, and nobody else', async () => {
    const join = async (who: string, role: string, name: string) => {
      const inv = await owner.post('/api/people/invite', { who, role, spaceIds: [life] });
      const c = new Client(app.base);
      await c.post('/api/auth/accept-invite', { token: new URL(inv.data.link).searchParams.get('invite'), name, email: who, password: 'a long enough password' });
      return { c, id: (await c.get('/api/me')).data.id as string };
    };
    const ed = await join('edith@example.com', 'editor', 'Edith'), vw = await join('victor@example.com', 'viewer', 'Victor');
    const readerId = (await reader.get('/api/me')).data.id;
    // an editor did not make this story, and may still change it and see who reads it
    assert.equal((await patch({ intro: 'Edited by an editor.' }, ed.c)).status, 200);
    assert.equal((await get()).intro, 'Edited by an editor.');
    const acc = await ed.c.get(`/api/stories/${story}/access`);
    assert.equal(acc.status, 200);
    const by = (id: string) => acc.data.people.find((u: any) => u.id === id);
    assert.deepEqual([by(ed.id).always, by(vw.id).always, by(vw.id).shared, by(readerId).shared, by(vw.id).inSpace], [true, false, false, true, true]);
    assert.ok(acc.data.people.some((u: any) => u.role === 'owner' && u.always));
    // the viewer cannot read it until someone ticks them
    assert.equal(await get(vw.c), undefined);
    assert.equal((await patch({ shared: [readerId, vw.id] }, ed.c)).status, 200, 'an editor may share it');
    assert.equal((await get(vw.c)).title, 'Four things');
    // reading is not changing
    assert.deepEqual([(await patch({ intro: 'x' }, vw.c)).status, (await vw.c.get(`/api/stories/${story}/access`)).status, (await patch({ shared: [] }, vw.c)).status], [403, 403, 403]);
    await patch({ shared: [readerId] }, ed.c);
    assert.equal(await get(vw.c), undefined, 'and unticked, it is gone for them again');
  });

  it('files stories under groups, and a story can be in several', async () => {
    assert.deepEqual((await get()).groups, []);
    assert.equal((await patch({ groups: ['  Sunsets ', 'Road trips', 'sunsets', '', 'Beach   days'] })).status, 200);
    assert.deepEqual((await get()).groups, ['sunsets', 'Road trips', 'Beach days'], 'trimmed, and the same name is kept once whatever its capitals');
    const other = await owner.post('/api/stories', { title: 'Another', spaceId: life, ids: [a], groups: ['Road trips'] });
    assert.deepEqual((await owner.get('/api/stories')).data.stories.find((x: any) => x.id === other.data.id).groups, ['Road trips']);
    assert.equal((await patch({ groups: ['x'] }, reader)).status, 403);
    await patch({ groups: [] }); assert.deepEqual((await get()).groups, []);
    // the same picture is now in two stories, and leaves one without leaving the other
    const all = (await owner.get('/api/stories')).data.stories;
    assert.ok(all.find((x: any) => x.id === story).ids.includes(a) && all.find((x: any) => x.id === other.data.id).ids.includes(a));
    await owner.json('PATCH', `/api/stories/${other.data.id}`, { add: [b] });
    await owner.json('PATCH', `/api/stories/${other.data.id}`, { remove: [a] });
    const after = (await owner.get('/api/stories')).data.stories;
    assert.deepEqual([after.find((x: any) => x.id === other.data.id).ids, after.find((x: any) => x.id === story).ids.includes(a)], [[b], true]);
    await owner.json('DELETE', `/api/stories/${other.data.id}`);
  });
});
