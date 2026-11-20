/* ---------- the library in memory ----------
   The page loads a compact row for every item it may see, keeps the list in memory and filters it locally.
   That is what makes search, the timeline and the map answer instantly. Afterwards it only asks for what changed. */
const PLACES = {};
const dayMs = 86400000;
const myId = () => (S.me ? S.me.id : '');
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const label = it => it.title || it.ai.caption || it.fileName;

/* a like belongs to a person: it.fav reads and writes the like of whoever is signed in */
const ItemProto = {
  get fav() { return this.likes.includes(myId()); },
  set fav(v) { const i = this.likes.indexOf(myId()); if (v && i < 0) this.likes.push(myId()); if (!v && i >= 0) this.likes.splice(i, 1); }
};
function hydrate(r, into) {
  const it = into || Object.create(ItemProto);
  const pal = r.palette && r.palette.length ? r.palette : ['#3a3d41'];
  Object.assign(it, {
    id: r.id, space: r.space, kind: r.kind, status: r.status, error: r.error, fileName: r.fileName, mime: r.mime,
    w: r.w || 3, h: r.h || 2, ar: (r.w || 3) / (r.h || 2), duration: r.duration,
    date: new Date(r.d).getTime(), dateSrc: r.dateSrc || null, added: r.added, title: r.title || '', desc: r.desc || '',
    lat: r.lat, lng: r.lng, place: r.place, locSrc: r.locSrc || null, spot: r.spot || '', spotKind: r.spotKind || '', cam: r.cam, lens: r.lens || '', iso: r.iso, shutter: r.shutter, fnum: r.fnum, focal: r.focal,
    palette: pal, buckets: [...new Set(pal.map(bucketOf))], ghost: ghostOf(pal[0]), series: r.series, copyOf: r.copyOf, hasFull: r.hasFull, play: r.play || null, playError: r.playError || '',
    bytes: { orig: r.bOrig, disp: r.bDisp, thumb: r.bThumb }, tags: r.tags || [], likes: r.likes || [], nc: r.nc || 0, people: r.people || [],
    ai: { status: r.aiStatus, scene: r.aiScene, caption: r.aiCaption || '', text: r.aiText || '', locked: r.aiLocked || [], things: (r.labels || []).map(x => ({ l: x[0], c: x[1], by: x[2] === 'person' ? 'person' : 'ai' })) },
    hay: null
  });
  return it;
}
function hay(it) {
  if (it.hay) return it.hay;
  const d = new Date(it.date), pl = it.place && PLACES[it.place];
  it.hay = norm([it.title, it.desc, it.tags.join(' '), it.ai.scene || '', it.ai.things.map(t => t.l).join(' '), it.ai.caption, it.ai.text, it.people.map(p => PERSONS[p] || '').join(' '), pl ? pl.name + ' ' + pl.region : '', it.spot, it.cam || '', it.series || '', MONTHS[d.getMonth()], d.getFullYear(), it.fileName].join(' '));
  return it.hay;
}

/* ---------- the list kept between visits ----------
   The whole list is tens of megabytes in a large library, and it used to be downloaded on every visit. Now the browser
   keeps it (in IndexedDB, on this device, under this person's name) and a visit asks only for what changed since.
   With that answer come three numbers that say exactly what the server holds, so a list that has drifted for any reason
   is noticed and loaded again in full. Signing out, or arriving signed out, empties it. If the browser will not keep
   it (private windows, no room), everything works as before: the list is simply loaded every time. */
const Kept = {
  FORMAT: 1, db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((ok, no) => {
      let rq; try { rq = indexedDB.open('afterimage.index', 1); } catch (e) { return no(e); }
      rq.onupgradeneeded = () => { const d = rq.result; if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' }); if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta'); };
      rq.onsuccess = () => { this.db = rq.result; this.db.onversionchange = () => { this.db.close(); this.db = null; }; ok(this.db); };
      rq.onerror = () => no(rq.error); rq.onblocked = () => no(new Error('blocked'));
    });
  },
  tx(mode, fn) { return this.open().then(d => new Promise((ok, no) => { const t = d.transaction(['items', 'meta'], mode); let out; t.oncomplete = () => ok(out); t.onerror = t.onabort = () => no(t.error || new Error('The list could not be kept.')); out = fn(t.objectStore('items'), t.objectStore('meta')); })); },
  /* what was kept for this person, or nothing */
  read(me) {
    return this.tx('readonly', (items, meta) => { const r = {}; meta.get('meta').onsuccess = e => { r.meta = e.target.result; }; items.getAll().onsuccess = e => { r.rows = e.target.result; }; return r; })
      .then(r => (r.meta && r.meta.format === this.FORMAT && r.meta.user === me && r.meta.key && r.rows ? r : null), () => null);
  },
  plain(it) { const o = Object.assign({}, it); o.hay = null; delete o._hold; return o; },
  /* The moment the list is good for is written with the rows themselves, in one go: if the write does not finish, neither does the moment. */
  write(me, key, at, changed, removed, all) {
    const rows = changed.map(it => this.plain(it));
    return this.tx('readwrite', (items, meta) => {
      if (all) items.clear();
      for (const id of removed) items.delete(id);
      /* a few hundred rows at a time, so writing a whole library never holds the page up */
      let k = 0;
      const step = () => { const end = Math.min(rows.length, k + 400); let last = null; for (; k < end; k++) last = items.put(rows[k]); if (k < rows.length) last.onsuccess = step; else meta.put({ format: this.FORMAT, user: me, key, at }, 'meta'); };
      step();
    }).catch(() => { });
  },
  clear() { return this.tx('readwrite', (items, meta) => { items.clear(); meta.clear(); }).catch(() => { }); }
};

const Sync = {
  at: 0, key: '', timer: 0, busy: false, watch: new Map(),
  /* who is signed in: known from the first answer of the server, before the page is drawn */
  who() { const u = S.me || (S.cfg && S.cfg.me); return u ? u.id : ''; },
  apply(data, keep) {
    Object.assign(PLACES, data.places || {});
    /* the names of people in the pictures, for those who may see them. A changed name changes what search finds. */
    if (data.persons) { const was = JSON.stringify(PERSONS); for (const k in PERSONS) delete PERSONS[k]; Object.assign(PERSONS, data.persons); if (was !== JSON.stringify(PERSONS)) S.items.forEach(i => { if (i.people && i.people.length) i.hay = null; }); }
    /* the server sent everything, asked or not (what this person may see has changed): what is here goes */
    const all = !!data.full && keep !== false; if (data.full) { S.items = []; S.byId.clear(); }
    let changed = false; const put = [], gone = [];
    for (const r of data.items) {
      /* v is the moment the row last changed on the server. The same v means there is nothing new in it. */
      const old = S.byId.get(r.id);
      if (old && old._v === r.v) continue;
      const it = hydrate(r, old); it._v = r.v; changed = true; put.push(it);
      if (it._hold) Object.assign(it, it._hold);   // something typed here that has not been saved yet wins
      if (!old) { S.items.push(it); S.byId.set(it.id, it); }
      const w = this.watch.get(it.id); if (w && it.status !== 'processing') { this.watch.delete(it.id); w(it); }
    }
    const dead = new Set(); for (const id of data.removed || []) if (S.byId.has(id)) { S.byId.delete(id); S.sel.delete(id); dead.add(id); gone.push(id); changed = true; }
    if (dead.size) S.items = S.items.filter(i => !dead.has(i.id));
    this.at = data.now; if (data.key !== undefined) this.key = data.key;
    if (keep !== false && this.who() && (all || put.length || gone.length || keep === true)) Kept.write(this.who(), this.key, this.at, all ? S.items : put, gone, all);
    return changed || !!data.full;
  },
  /* the three numbers the server sends with check=1, worked out here from the list in hand */
  sums() { let ids = 0, vs = 0; for (const i of S.items) { ids += parseInt(i.id.slice(0, 8), 16); vs += i._v % 1000000007; } return { n: S.items.length, ids, vs }; },
  everything() { return api('GET', '/api/index').then(data => { data.full = true; this.apply(data); }); },
  /* Opening the page: start from the list kept on this device when there is one and ask what changed, otherwise load it all. */
  async full() {
    S.items = []; S.byId.clear(); this.at = 0;
    const had = this.who() ? await Kept.read(this.who()) : null;
    if (!had) return this.everything();
    for (const o of had.rows) { const it = Object.assign(Object.create(ItemProto), o); S.items.push(it); S.byId.set(it.id, it); }
    let data;
    try { data = await api('GET', `/api/index?since=${had.meta.at}&key=${encodeURIComponent(had.meta.key)}&check=1`); }
    catch (e) { S.items = []; S.byId.clear(); throw e; }
    this.apply(data, true);
    /* the server sends the list newest first, and among items of the same moment the one added first. So it is kept in the page. */
    S.items.sort((a, b) => b.date - a.date || a.added - b.added || (a.id < b.id ? -1 : 1));
    const mine = this.sums(), s = data.sums;
    if (!data.full && (!s || s.n !== mine.n || s.ids !== mine.ids || s.vs !== mine.vs)) return this.everything();
  },
  async poll() {
    if (this.busy || !S.me) return; this.busy = true;
    try { if (this.apply(await api('GET', `/api/index?since=${this.at}&key=${encodeURIComponent(this.key)}`))) Bus.emit('synced'); } catch (e) { /* offline for a moment: try again next round */ }
    this.busy = false; this.schedule();
  },
  /* check often while something is still being processed, rarely otherwise */
  schedule() { clearTimeout(this.timer); const hot = this.watch.size || S.items.some(i => i.status === 'processing'), warm = !hot && S.items.some(i => i.play === 'queued' || i.play === 'making'); this.timer = setTimeout(() => { if (document.hidden) this.schedule(); else this.poll(); }, hot ? 1500 : warm ? 6000 : 25000); },
  soon() { clearTimeout(this.timer); this.timer = setTimeout(() => this.poll(), 400); },
  /* call fn once this item has finished processing */
  whenReady(id, fn) { this.watch.set(id, fn); this.soon(); }
};
