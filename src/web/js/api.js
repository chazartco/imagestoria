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

const Sync = {
  at: 0, timer: 0, busy: false, watch: new Map(),
  apply(data) {
    Object.assign(PLACES, data.places || {});
    /* the names of people in the pictures, for those who may see them. A changed name changes what search finds. */
    if (data.persons) { const was = JSON.stringify(PERSONS); for (const k in PERSONS) delete PERSONS[k]; Object.assign(PERSONS, data.persons); if (was !== JSON.stringify(PERSONS)) S.items.forEach(i => { if (i.people && i.people.length) i.hay = null; }); }
    let changed = false;
    for (const r of data.items) {
      /* v is the moment the row last changed on the server. The same v means there is nothing new in it. */
      const old = S.byId.get(r.id);
      if (old && old._v === r.v) continue;
      const it = hydrate(r, old); it._v = r.v; changed = true;
      if (it._hold) Object.assign(it, it._hold);   // something typed here that has not been saved yet wins
      if (!old) { S.items.push(it); S.byId.set(it.id, it); }
      const w = this.watch.get(it.id); if (w && it.status !== 'processing') { this.watch.delete(it.id); w(it); }
    }
    for (const id of data.removed || []) if (S.byId.has(id)) { S.byId.delete(id); S.sel.delete(id); S.items = S.items.filter(i => i.id !== id); changed = true; }
    this.at = data.now;
    return changed;
  },
  async full() { const data = await api('GET', '/api/index'); S.items = []; S.byId.clear(); this.apply(data); },
  async poll() {
    if (this.busy || !S.me) return; this.busy = true;
    try { if (this.apply(await api('GET', '/api/index?since=' + this.at))) Bus.emit('synced'); } catch (e) { /* offline for a moment: try again next round */ }
    this.busy = false; this.schedule();
  },
  /* check often while something is still being processed, rarely otherwise */
  schedule() { clearTimeout(this.timer); const hot = this.watch.size || S.items.some(i => i.status === 'processing'), warm = !hot && S.items.some(i => i.play === 'queued' || i.play === 'making'); this.timer = setTimeout(() => { if (document.hidden) this.schedule(); else this.poll(); }, hot ? 1500 : warm ? 6000 : 25000); },
  soon() { clearTimeout(this.timer); this.timer = setTimeout(() => this.poll(), 400); },
  /* call fn once this item has finished processing */
  whenReady(id, fn) { this.watch.set(id, fn); this.soon(); }
};
