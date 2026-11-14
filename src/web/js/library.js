/* ---------- library: filters, uncropped lazy grid, selection ---------- */
const FACETS = {
  scene: { label: 'Scenes', get: it => it.ai.scene ? [it.ai.scene] : [] },
  thing: { label: 'In the picture', get: it => it.ai.things.map(t => t.l) },
  tag: { label: 'Your tags', get: it => it.tags },
  place: { label: 'Places', get: it => it.place ? [it.place] : [], name: v => PLACES[v] ? PLACES[v].name : v },
  spot: { label: 'Beaches, parks and landmarks', get: it => it.spot ? [it.spot] : [] },
  person: { label: 'People', get: it => it.people, name: v => PERSONS[v] || 'Someone' },
  series: { label: 'Series', get: it => it.series ? [it.series] : [] },
  year: { label: 'Years', get: it => [String(new Date(it.date).getFullYear())] },
  cam: { label: 'Cameras', get: it => it.cam ? [it.cam] : [] },
  color: { label: 'Colors', get: it => it.buckets, name: v => v[0].toUpperCase() + v.slice(1) },
  flag: { label: 'Quick', get: it => { const f = []; if (it.fav) f.push('fav'); if (it.likes.length) f.push('liked'); if (it.nc) f.push('commented'); if (it.copyOf) f.push('edited'); if (it.kind === 'video') f.push('video'); if (it.dup) f.push('dupes'); if (it.lat == null) f.push('noloc'); if (it.lat == null && Sugg.by.has(it.id)) f.push('sugg'); if (it.dateSrc === 'file') f.push('filedate'); if (it.status === 'processing') f.push('waiting'); if (it.status === 'failed') f.push('failed'); return f; }, name: v => ({ fav: 'Liked by you', liked: 'Liked by anyone', commented: 'With comments', edited: 'Edited copies', video: 'Videos', dupes: 'Near duplicates', noloc: 'No location', sugg: 'Place suggested', filedate: 'Date not from the camera', waiting: 'Still processing', failed: 'Could not be read' }[v]) }
};
/* ---------- search by meaning ----------
   Typing in the search box filters the list here at once, by the words themselves. The server is also asked which pictures
   fit the words by what they show, and those are added underneath, under a heading of their own. */
const Meaning = {
  q: '', space: '', state: '', note: '', ids: [],
  query() { return S.filters.filter(f => f.type === 'text').map(f => f.value).join(' ').trim(); },
  update() {
    const q = this.query(), space = S.space;
    if (!q || !S.me || !S.me.id) { this.q = ''; this.ids = []; this.state = ''; this.note = ''; return; }
    if (q === this.q && space === this.space) return;
    this.q = q; this.space = space; this.ids = []; this.state = 'asking'; this.note = '';
    api('GET', `/api/search?q=${encodeURIComponent(q)}&space=${space}`).then(r => {
      if (this.q !== q || this.space !== space) return;
      this.state = r.state; this.note = r.note || ''; this.ids = r.results.map(x => x[0]);
      if (S.view === 'library') { Lib.layout(); Lib.renderBar(); }
    }, () => { if (this.q === q) this.state = 'failed'; });
  },
  /* what was found by meaning that the words did not already find, and that passes every other filter, best match first */
  extra() {
    if (!this.q || this.q !== this.query() || this.space !== S.space) return [];
    const have = new Set(Lib.list.map(i => i.id));
    return this.ids.map(id => S.byId.get(id)).filter(it => it && it.space === S.space && !have.has(it.id) && Lib.matches(it, 'text'));
  }
};

/* ---------- near duplicates: bursts and re-exports, found by the server from what the pictures look like ---------- */
const Dupes = {
  space: '', groups: [], at: 0,
  load(force) {
    const space = S.space; if (!space || !S.me || !S.me.id) return;
    if (!force && space === this.space && Date.now() - this.at < 20000) return;
    this.at = Date.now(); this.space = space;
    api('GET', '/api/duplicates?space=' + space).then(r => {
      if (S.space !== space) return;
      S.items.forEach(i => { i.dup = 0; });
      this.groups = r.groups.map(g => g.map(id => S.byId.get(id)).filter(Boolean)).filter(g => g.length > 1);
      this.groups.forEach((g, k) => g.forEach(it => { it.dup = k + 1; }));
      Lib.renderFacets(); if (Lib.has('flag', 'dupes')) Lib.refresh();
    }, () => { });
  },
  group(it) { return it.dup ? (this.groups[it.dup - 1] || []).filter(o => S.byId.has(o.id)) : []; },
  /* the one to keep: the most pixels, then the one people liked, then an original over an edited copy, then the bigger file, then the first taken */
  best(g) { return [...g].sort((a, b) => b.w * b.h - a.w * a.h || b.likes.length - a.likes.length || !!a.copyOf - !!b.copyOf || (b.bytes.orig || 0) - (a.bytes.orig || 0) || a.date - b.date)[0]; },
  isBest(it) { const g = this.group(it); return g.length > 1 && this.best(g) === it; },
  /* everything in the listed groups except the best of each */
  rest(list) { const out = [], seen = new Set(); for (const it of list) { if (!it.dup || seen.has(it.dup)) continue; seen.add(it.dup); const g = this.group(it), keep = this.best(g); g.forEach(o => { if (o !== keep) out.push(o); }); } return out; }
};

/* ---------- suggested places, for pictures that carry no location ---------- */
const Sugg = {
  space: '', by: new Map(), at: 0,
  load(force) {
    const space = S.space; if (!space || !S.me || !S.me.id) return Promise.resolve();
    if (!force && space === this.space && Date.now() - this.at < 20000) return Promise.resolve();
    this.at = Date.now(); this.space = space;
    return api('GET', '/api/place-suggestions?space=' + space).then(r => {
      if (S.space !== space) return;
      const had = this.by.size; this.by = new Map(r.suggestions.map(s => [s.item, s]));
      if (had || this.by.size) { Lib.renderFacets(); if (S.view === 'library' && (Lib.has('flag', 'noloc') || Lib.has('flag', 'sugg'))) Lib.refresh(); }
    }, () => { });
  },
  how(s) { return s.source === 'nearby' ? 'From a picture taken minutes away' : 'Recognised by the worker'; },
  /* one answer for many pictures: accept or reject, then show what the server now holds */
  answer(verb, list, done) {
    return attempt(api('POST', '/api/place-suggestions/' + verb, { items: list.map(s => ({ id: s.item, source: s.source })) }), null).then(r => {
      toast(verb === 'accept' ? (r.n ? `Location set for ${fmt.plural(r.n, 'item')}` : 'Nothing was changed') : 'They will not be suggested again');
      list.forEach(s => this.by.delete(s.item));
      return Sync.poll().then(() => this.load(true)).then(() => { Lib.refresh(); if (done) done(r); });
    }, () => { });
  },
  /* the suggestions for the pictures on screen, grouped by place, each group accepted or rejected in one go */
  review(items) {
    const close = () => sheet.remove();
    const body = el('div', { class: 'sg-list' });
    const paint = () => {
      body.innerHTML = '';
      const groups = new Map();
      items.filter(i => S.byId.has(i.id) && i.lat == null && this.by.has(i.id)).forEach(it => { const s = this.by.get(it.id), k = s.source + '|' + s.name + '|' + (s.lat == null ? '' : s.lat.toFixed(3) + ',' + s.lng.toFixed(3)); if (!groups.has(k)) groups.set(k, { s, list: [], items: [] }); groups.get(k).list.push(s); groups.get(k).items.push(it); });
      if (!groups.size) { body.append(el('p', { class: 'muted', id: 'sgNone', text: 'No suggestions are left here.' })); return; }
      [...groups.values()].sort((a, b) => b.list.length - a.list.length).forEach(g => {
        const strip = el('div', { class: 'sg-strip' });
        g.items.slice(0, 8).forEach(it => { const im = el('img', { alt: label(it), draggable: false, width: it.w, height: it.h, style: { background: it.ghost } }); loadInto(im, it, 'thumb'); strip.append(im); });
        if (g.items.length > 8) strip.append(el('span', { class: 'muted', text: `and ${g.items.length - 8} more` }));
        const can1 = g.s.lat != null;
        body.append(el('div', { class: 'sg-row', data: { name: g.s.name } }, el('div', { class: 'sg-t' }, el('b', { text: 'Possibly ' + g.s.name }), el('small', { class: 'ai-note', text: `${this.how(g.s)}. ${fmt.plural(g.list.length, 'picture')}.${can1 ? '' : ' This place is not on the map held here, so set the location yourself.'}` })), strip,
          el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Not there', onclick: () => this.answer('reject', g.list, paint) }),
            can1 ? el('button', { class: 'btn small primary', text: `Accept for ${g.list.length === 1 ? 'this picture' : 'all ' + g.list.length}`, onclick: () => this.answer('accept', g.list, paint) })
              : el('button', { class: 'btn small', text: 'Set location', onclick: () => { close(); LocDialog.open(g.items, () => { Sync.soon(); Lib.refresh(); }); } }))));
      });
    };
    const sheet = el('div', { class: 'overlay sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Suggested places', onclick: e => { if (e.target === sheet) close(); } },
      el('div', { class: 'sheet-box sg-box' }, el('header', {}, el('h2', { text: 'Suggested places' }), el('button', { class: 'iconbtn modal-x', id: 'sgClose', title: 'Close', 'aria-label': 'Close', html: icon('x'), onclick: close })), body));
    sheet._close = close; document.body.append(sheet); paint();
  }
};

const facetName = (type, v) => FACETS[type] && FACETS[type].name ? FACETS[type].name(v) : v;

const Lib = {
  list: [], blocks: [], total: 0, mounted: new Map(), width: 0, months: [],
  /* ----- filtering ----- */
  matches(it, except) {
    const by = {};
    for (const f of S.filters) { if (f.type === except) continue; (by[f.type] = by[f.type] || []).push(f); }
    for (const type in by) {
      const fs = by[type];
      if (type === 'text') { const h = hay(it); if (!fs.every(f => f.value.split(/\s+/).every(w => h.includes(w)))) return false; }
      else if (type === 'area') { const b = fs[0].value; if (it.lat == null || it.lat < b.s || it.lat > b.n || it.lng < b.w || it.lng > b.e) return false; }
      else if (type === 'ids') { if (!fs[0].value.has(it.id)) return false; }
      else { const vals = FACETS[type].get(it); if (type === 'flag' ? !fs.every(f => vals.includes(f.value)) : !fs.some(f => vals.includes(f.value))) return false; }
    }
    return true;
  },
  inSpace() { return S.items.filter(i => i.space === S.space); },
  compute() {
    const l = this.inSpace().filter(i => this.matches(i));
    if (S.sort === 'new') l.sort((a, b) => b.date - a.date); else if (S.sort === 'old') l.sort((a, b) => a.date - b.date); else l.sort((a, b) => b.added - a.added);
    this.list = l; return l;
  },
  has(type, value) { return S.filters.some(f => f.type === type && f.value === value); },
  toggle(type, value, label) {
    const i = S.filters.findIndex(f => f.type === type && f.value === value);
    if (i >= 0) S.filters.splice(i, 1); else S.filters.push({ type, value, label: label || facetName(type, value) });
    this.changed();
  },
  only(filters) { S.filters = filters; this.changed(); },
  clear() { S.filters = []; this.changed(); },
  changed() { this.compute(); Bus.emit('filters'); },

  /* ----- layout: rows that keep every photo's full shape ----- */
  justify(items, W, target, gap) {
    const rows = []; let row = [], sum = 0;
    const flush = last => {
      if (!row.length) return;
      let h = (W - gap * (row.length - 1)) / sum; if (last && h > target) h = target;
      let x = 0; const cells = row.map(it => { const w = it.ar * h; const c = { it, x, w }; x += w + gap; return c; });
      rows.push({ h, cells }); row = []; sum = 0;
    };
    for (const it of items) { row.push(it); sum += it.ar; if (sum * target + gap * (row.length - 1) >= W) flush(false); }
    flush(true); return rows;
  },
  groups() {
    const l = this.list, g = S.group;
    /* looking at near duplicates, each group of look-alikes is shown together, with the best one first */
    if (this.has('flag', 'dupes')) {
      const map = new Map(); for (const it of l) { if (!map.has(it.dup)) map.set(it.dup, []); map.get(it.dup).push(it); }
      return [...map.entries()].map(([k, items]) => { const keep = Dupes.best(Dupes.group(items[0])); items.sort((a, b) => (b === keep) - (a === keep) || a.date - b.date); return { key: 'dup' + k, label: `${fmt.day(items[0].date)}, ${fmt.time(items[0].date)}`, items, dup: true }; });
    }
    if (g === 'none') return [{ key: 'all', label: '', items: l }];
    const map = new Map();
    const keyOf = it => {
      /* sorted by recently added, the headings follow the day or month it was added, so the newest arrivals stay together */
      const byAdded = S.sort === 'added', t = byAdded ? it.added : it.date, d = new Date(t), pre = byAdded ? 'Added ' : '';
      if (g === 'month') return [d.getFullYear() * 12 + d.getMonth(), pre + fmt.month(t)];
      if (g === 'day') return [Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000), pre + (byAdded ? fmt.day(t) : `${fmt.weekday(t)}, ${fmt.day(t)}`)];
      if (g === 'place') return [it.place || '~', it.place && PLACES[it.place] ? PLACES[it.place].name : 'No location'];
      if (g === 'series') return [it.series || '~', it.series || 'No series'];
      return ['all', ''];
    };
    for (const it of l) { const [k, label] = keyOf(it); if (!map.has(k)) map.set(k, { key: k, label, items: [] }); map.get(k).items.push(it); }
    const out = [...map.values()];
    /* biggest group first, with whatever has no place or no series at the end */
    if (g === 'place' || g === 'series') out.sort((a, b) => (a.key === '~') - (b.key === '~') || b.items.length - a.items.length);
    return out;
  },
  resurface() {
    if (curSpace().kind !== 'life' || S.filters.length) return null;
    const now = new Date(), out = [];
    for (const it of this.inSpace()) { const d = new Date(it.date); if (d.getFullYear() >= now.getFullYear()) continue; const same = new Date(now.getFullYear(), d.getMonth(), d.getDate()); if (Math.abs(same - now) < 6 * dayMs) out.push(it); }
    if (out.length < 3) return null;
    out.sort((a, b) => a.date - b.date);
    const yrs = now.getFullYear() - new Date(out[0].date).getFullYear();
    const pc = {}; out.forEach(i => { if (i.place) pc[i.place] = (pc[i.place] || 0) + 1; }); const top = Object.entries(pc).sort((a, b) => b[1] - a[1])[0];
    return { items: out, place: top && PLACES[top[0]] ? PLACES[top[0]].name : '', label: yrs === 1 ? 'This week, one year ago' : `This week, ${yrs} years ago` };
  },
  layout() {
    const sc = $('#gridScroll'), W = Math.max(240, $('#grid').clientWidth), gap = 4;
    this.width = W; const blocks = []; let y = 0; const order = []; this.months = [];
    Meaning.update();
    const rs = this.resurface();
    if (rs) { blocks.push({ t: 'banner', y, h: 168, rs }); y += 168 + 14; }
    /* looking at pictures with no location: the ones a place is suggested for can be accepted many at a time */
    if ((this.has('flag', 'noloc') || this.has('flag', 'sugg')) && can('tag') && this.list.some(i => i.lat == null && Sugg.by.has(i.id))) { const sh = W < 760 ? 130 : 64; blocks.push({ t: 'sugbar', y, h: sh }); y += sh + 8; }
    if (this.has('flag', 'dupes') && this.list.length) { const dh = W < 760 ? 170 : 74; blocks.push({ t: 'dupbar', y, h: dh }); y += dh + 8; }
    let lastMonth = null;
    for (const g of this.groups()) {
      if (g.label) { blocks.push({ t: 'head', y, h: 52, g }); y += 52; }
      for (const row of this.justify(g.items, W, S.rowH, gap)) {
        const m = fmt.month(row.cells[0].it.date); if (S.sort !== 'added' && (S.group === 'month' || S.group === 'day' || S.group === 'none') && m !== lastMonth) { this.months.push({ label: m, y, year: new Date(row.cells[0].it.date).getFullYear() }); lastMonth = m; }
        blocks.push({ t: 'row', y, h: row.h, cells: row.cells }); row.cells.forEach(c => order.push(c.it)); y += row.h + gap;
      }
      y += 22;
    }
    /* found by meaning: under everything the words found, under its own heading */
    const more = Meaning.extra(); this.meaningN = more.length;
    if (more.length || (Meaning.q && Meaning.note)) {
      blocks.push({ t: 'mhead', y, h: 64, n: more.length }); y += 64;
      for (const row of this.justify(more, W, S.rowH, gap)) { blocks.push({ t: 'row', y, h: row.h, cells: row.cells }); row.cells.forEach(c => order.push(c.it)); y += row.h + gap; }
      y += 22;
    }
    this.blocks = blocks; this.total = y; this.order = order;
    $('#grid').style.height = y + 'px';
    for (const [, n] of this.mounted) n.remove(); this.mounted.clear();
    this.window(); this.ribbon();
    const none = this.inSpace().length === 0; $('#emptyLib').hidden = this.list.length > 0 || more.length > 0;
    $('#emptyText').textContent = none ? (can('upload') ? 'This space is empty. Add photos to get started.' : 'Nothing has been added to this space yet.') : 'Nothing matches these filters.'; $('#emptyClear').hidden = none; $('#emptyAdd').hidden = !none || !can('upload');
  },
  /* ----- lazy window: only rows near the viewport exist in the page ----- */
  window() {
    const sc = $('#gridScroll'), top = sc.scrollTop - 700, bot = sc.scrollTop + sc.clientHeight + 900, bl = this.blocks;
    let lo = 0, hi = bl.length - 1, first = bl.length;
    while (lo <= hi) { const mid = lo + hi >> 1; if (bl[mid].y + bl[mid].h >= top) { first = mid; hi = mid - 1; } else lo = mid + 1; }
    const keep = new Set();
    for (let i = first; i < bl.length && bl[i].y <= bot; i++) { keep.add(i); if (!this.mounted.has(i)) { const n = this.build(bl[i]); this.mounted.set(i, n); $('#grid').append(n); } }
    for (const [i, n] of this.mounted) if (!keep.has(i)) { n.remove(); this.mounted.delete(i); }
    this.ribbonPos();
  },
  build(b) {
    if (b.t === 'head') {
      const places = [...new Set(b.g.items.map(i => i.place).filter(p => p && PLACES[p]))].map(p => PLACES[p].name);
      const where = (S.group === 'month' || S.group === 'day') && places.length ? ' from ' + (places.length > 2 ? places.slice(0, 2).join(', ') + ' and ' + (places.length - 2) + ' more' : places.join(' and ')) : '';
      return el('div', { class: 'ghead', style: { top: b.y + 'px' } },
        el('h3', { text: b.g.label }), el('span', { class: 'gmeta', text: fmt.plural(b.g.items.length, b.g.dup ? 'look-alike' : 'item') + where }),
        el('button', { class: 'linkbtn', text: b.g.items.every(i => S.sel.has(i.id)) ? 'Clear selection' : 'Select all', onclick: e => { const all = b.g.items.every(i => S.sel.has(i.id)); b.g.items.forEach(i => all ? S.sel.delete(i.id) : S.sel.add(i.id)); e.target.textContent = all ? 'Select all' : 'Clear selection'; Bus.emit('sel'); } }));
    }
    if (b.t === 'mhead') {
      return el('div', { class: 'ghead ai', id: 'meaningHead', style: { top: b.y + 'px' } }, el('h3', {}, el('span', { html: icon('cpu', 16) }), ' By meaning'),
        el('span', { class: 'gmeta', text: b.n ? `${fmt.plural(b.n, 'more item')} that ${b.n === 1 ? 'fits' : 'fit'} “${Meaning.q}” by what ${b.n === 1 ? 'it shows' : 'they show'}. The best match is first.` : Meaning.note }));
    }
    if (b.t === 'sugbar') {
      const n = this.list.filter(i => i.lat == null && Sugg.by.has(i.id)).length;
      return el('div', { class: 'dupbar ai', id: 'sugBar', style: { top: b.y + 'px', height: b.h + 'px' } },
        el('p', {}, el('b', { text: `A place is suggested for ${n} of these ${n === 1 ? 'pictures' : 'pictures'}.` }), ' A suggestion is a guess: from a picture the same camera took minutes away, or from what a worker recognised. It becomes the location only when you accept it.'),
        el('button', { class: 'btn', id: 'sugReview', text: 'Review suggestions', onclick: () => Sugg.review(this.list.filter(i => i.lat == null && Sugg.by.has(i.id))) }));
    }
    if (b.t === 'dupbar') {
      const shown = this.list, groups = new Set(shown.map(i => i.dup)).size, rest = Dupes.rest(shown);
      return el('div', { class: 'dupbar', id: 'dupBar', style: { top: b.y + 'px', height: b.h + 'px' } },
        el('p', {}, el('b', { text: `${fmt.plural(groups, 'group')} of near duplicates, ${fmt.plural(shown.length, 'item')}.` }), ' Pictures that look almost the same and were taken together. In each group the one marked Best has the most detail. Nothing is removed unless you say so.'),
        can('del') && rest.length ? el('button', { class: 'btn', id: 'dupKeep', text: `Keep the best, trash the other ${rest.length}`, onclick: e => popover(e.currentTarget, el('div', { class: 'confirm' }, el('p', { text: `Move ${fmt.plural(rest.length, 'item')} to the trash and keep the best of each group? They stay in the trash until it is emptied, so you can put any of them back.` }), el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Leave them', onclick: closePop }), el('button', { class: 'btn small danger', text: 'Move to trash', onclick: () => { closePop(); removeItems(rest).then(() => Dupes.load(true), () => { }); } })))) }) : null);
    }
    if (b.t === 'banner') {
      const strip = el('div', { class: 'rs-strip' });
      const sh = b.h - 28; let used = 0; const fit = b.rs.items.filter(it => { const w = it.ar * sh + 4; if (used + w > this.width - 248) return false; used += w; return true; });
      fit.forEach(it => { const im = el('img', { alt: label(it), draggable: false }); const t = el('button', { class: 'rs-thumb', style: { aspectRatio: it.ar, background: it.ghost }, onclick: () => Viewer.open(it.id, b.rs.items) }, im); loadInto(im, it, 'thumb'); strip.append(t); });
      return el('div', { class: 'resurface', style: { top: b.y + 'px', height: b.h + 'px' } },
        el('div', { class: 'rs-text' }, el('h3', { text: b.rs.label }), el('p', { text: `${fmt.plural(b.rs.items.length, 'item')}${b.rs.place ? ', most of them from ' + b.rs.place : ''}` }),
          el('button', { class: 'btn small', text: 'See them all', onclick: () => Lib.only([{ type: 'ids', value: new Set(b.rs.items.map(i => i.id)), label: b.rs.label }]) })), strip);
    }
    const row = el('div', { class: 'grow', style: { top: b.y + 'px', height: b.h + 'px' } });
    for (const c of b.cells) row.append(this.tile(c.it, c.x, c.w, b.h));
    return row;
  },
  tile(it, x, w, h) {
    const img = el('img', { alt: label(it), draggable: false });
    const badges = el('span', { class: 'badges' });
    if (it.kind === 'video') badges.append(el('span', { class: 'bdg', html: icon('play', 12) + (it.duration ? ' ' + fmt.dur(it.duration) : '') }));
    if (it.copyOf) badges.append(el('span', { class: 'bdg', title: 'Edited copy', html: icon('sliders', 12) }));
    if (it.dup && this.has('flag', 'dupes') && Dupes.isBest(it)) badges.append(el('span', { class: 'bdg best', title: 'The one with the most detail in its group', text: 'Best' }));
    if (it.nc) badges.append(el('span', { class: 'bdg', title: 'Comments', html: icon('comment', 12) + ' ' + it.nc }));
    if (it.status === 'processing') badges.append(el('span', { class: 'bdg', text: 'Processing' }));
    if (it.status === 'failed') badges.append(el('span', { class: 'bdg err', title: it.error || '', text: 'Could not be read' }));
    const t = el('div', { class: 'tile' + (S.sel.has(it.id) ? ' sel' : ''), data: { id: it.id }, style: { left: x + 'px', width: w + 'px', height: h + 'px', background: it.ghost }, tabIndex: 0, role: 'button', 'aria-label': label(it) + ', ' + fmt.day(it.date) },
      img, el('button', { class: 'tick', 'aria-label': 'Select', tabIndex: -1, html: icon('check', 14) }), this.likeBtn(it), badges,
      it.title ? el('span', { class: 'tcap', text: it.title }) : null);
    loadInto(img, it, 'thumb');
    return t;
  },
  /* the heart on every tile: outline until you like it, with a count once anyone else has */
  likeBtn(it, btn) {
    const mine = it.fav, n = it.likes.length, others = n - (mine ? 1 : 0);
    btn = btn || el('button', { class: 'like', tabIndex: -1 });
    btn.className = 'like' + (mine ? ' on' : ''); btn.setAttribute('aria-pressed', mine); btn.setAttribute('aria-label', mine ? 'Unlike' : 'Like');
    btn.title = n ? 'Liked by ' + likedBy(it) : 'Like'; btn.innerHTML = icon('heart', 19) + (others > 0 ? `<b>${n}</b>` : ''); return btn;
  },
  like(id) {
    const it = S.byId.get(id); if (!it) return; const on = !it.fav; it.fav = on;
    api(on ? 'PUT' : 'DELETE', `/api/items/${id}/like`).catch(e => { it.fav = !on; toast(e.message); this.repaintLike(it); });
    if (Lib.has('flag', 'fav') || Lib.has('flag', 'liked')) return this.refresh();
    this.repaintLike(it); this.renderFacets();
  },
  repaintLike(it) { $$('.tile', $('#grid')).forEach(t => { if (t.dataset.id === it.id) this.likeBtn(it, $('.like', t)); }); },
  paintSel() { $$('.tile', $('#grid')).forEach(t => t.classList.toggle('sel', S.sel.has(t.dataset.id))); $('#v-library').classList.toggle('selecting', S.sel.size > 0); },

  /* ----- time ribbon: the whole library's timeline on the right edge ----- */
  ribbon() {
    const rb = $('#ribbon'); rb.innerHTML = ''; rb.hidden = this.months.length < 3; if (rb.hidden) return;
    const H = rb.clientHeight - 16; let lastY = -99, lastYear = null;
    for (const m of this.months) {
      const y = 8 + m.y / Math.max(1, this.total) * H;
      if (m.year !== lastYear && y - lastY > 18) { rb.append(el('span', { class: 'rb-year', style: { top: y + 'px' }, text: m.year })); lastY = y; lastYear = m.year; }
      else rb.append(el('span', { class: 'rb-dot', style: { top: y + 'px' } }));
    }
    rb.append(el('span', { class: 'rb-pos', id: 'rbPos' }), el('span', { class: 'rb-tip', id: 'rbTip' }));
    this.ribbonPos();
  },
  ribbonPos() {
    const p = $('#rbPos'); if (!p) return; const sc = $('#gridScroll'), H = $('#ribbon').clientHeight - 16;
    p.style.top = 8 + sc.scrollTop / Math.max(1, this.total) * H + 'px'; p.style.height = Math.max(10, sc.clientHeight / Math.max(1, this.total) * H) + 'px';
  },
  monthAt(y) { let m = this.months[0]; for (const x of this.months) { if (x.y <= y) m = x; else break; } return m; },

  /* ----- selection ----- */
  select(id, range) {
    if (range && S.lastSel) { const a = this.order.findIndex(i => i.id === S.lastSel), b = this.order.findIndex(i => i.id === id); if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.sel.add(this.order[i].id); }
    else if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
    S.lastSel = id; Bus.emit('sel');
  },
  selected() { return [...S.sel].map(id => S.byId.get(id)).filter(Boolean); },

  /* ----- facets panel -----
     Each kind of filter is a section with a heading that opens and closes it. The first one (favorites,
     videos and the like) has no heading and is always open. The rest start closed, and this browser
     remembers which were opened. A closed section still shows the values that are switched on. */
  facetsOpen() { try { const v = JSON.parse(store.get('facetsOpen', '[]')); return new Set(Array.isArray(v) ? v : []); } catch (e) { return new Set(); } },
  renderFacets() {
    const box = $('#facets'); const scrollTop = box.scrollTop; box.innerHTML = '';
    /* on a phone the filters cover the page, so they carry their own way out */
    box.append(el('div', { class: 'facets-head' }, el('b', { text: 'Filters' }), el('button', { class: 'iconbtn', id: 'facetsClose', title: 'Close filters', 'aria-label': 'Close filters', html: icon('x'), onclick: () => { $('.browse').classList.remove('nofacets'); } })));
    const types = curSpace().kind === 'studio' ? ['flag', 'series', 'person', 'scene', 'color', 'thing', 'tag', 'year', 'place', 'spot', 'cam'] : ['flag', 'year', 'place', 'spot', 'person', 'scene', 'thing', 'color', 'tag', 'cam'];
    const space = this.inSpace(), opened = this.facetsOpen();
    for (const type of types) {
      const counts = new Map();
      for (const it of space) { if (!this.matches(it, type)) continue; for (const v of FACETS[type].get(it)) counts.set(v, (counts.get(v) || 0) + 1); }
      S.filters.filter(f => f.type === type).forEach(f => { if (!counts.has(f.value)) counts.set(f.value, 0); });
      if (!counts.size) continue;
      let vals = [...counts.entries()];
      if (type === 'year') vals.sort((a, b) => b[0] - a[0]); else if (type === 'color') vals.sort((a, b) => BUCKETS.findIndex(x => x[0] === a[0]) - BUCKETS.findIndex(x => x[0] === b[0])); else if (type === 'flag') { const o = ['fav', 'liked', 'commented', 'edited', 'video', 'dupes', 'waiting', 'failed', 'noloc', 'sugg', 'filedate']; vals.sort((a, b) => o.indexOf(a[0]) - o.indexOf(b[0])); } else vals.sort((a, b) => b[1] - a[1]);
      const open = type === 'flag' || opened.has(type), nOn = S.filters.filter(f => f.type === type).length;
      const head = type === 'flag' ? null : el('h4', {}, el('button', { class: 'facet-head', 'aria-expanded': String(open), title: type === 'scene' || type === 'thing' ? 'Found by reading the image' : null,
        onclick: () => { const o = this.facetsOpen(); if (o.has(type)) o.delete(type); else o.add(type); store.set('facetsOpen', JSON.stringify([...o])); this.renderFacets(); } },
        el('span', { class: 'look-chev', html: icon('chevdown', 14) }), el('span', { class: 'facet-t', text: FACETS[type].label }), el('span', { class: 'facet-n' + (nOn ? ' on' : ''), text: nOn ? `${nOn} on` : vals.length })));
      const sec = el('section', { class: 'facet f-' + type + (open ? '' : ' shut') }, head);
      const wrap = el('div', { class: type === 'color' ? 'swatches' : 'fvals' });
      const limit = !open ? 0 : type === 'thing' && !this._moreThings ? 10 : type === 'spot' && !this._moreSpots ? 8 : 99;
      (open ? vals.slice(0, limit) : vals.filter(([v]) => this.has(type, v))).forEach(([v, n]) => {
        const on = this.has(type, v);
        if (type === 'color') wrap.append(el('button', { class: 'swatch' + (on ? ' on' : ''), style: { background: BUCKETS.find(b => b[0] === v)[1] }, title: `${facetName(type, v)} (${n})`, 'aria-label': facetName(type, v), 'aria-pressed': on, onclick: () => this.toggle(type, v) }));
        else wrap.append(el('button', { class: 'fval' + (on ? ' on' : '') + (type === 'scene' || type === 'thing' ? ' ai' : ''), 'aria-pressed': on, onclick: () => this.toggle(type, v) }, el('span', { text: facetName(type, v) }), el('span', { class: 'n', text: n })));
      });
      if (open && (type === 'thing' || type === 'spot') && vals.length > limit) wrap.append(el('button', { class: 'linkbtn', text: `Show ${vals.length - limit} more`, onclick: () => { this[type === 'thing' ? '_moreThings' : '_moreSpots'] = true; this.renderFacets(); } }));
      if (wrap.firstChild) sec.append(wrap); box.append(sec);
    }
    box.scrollTop = scrollTop;
  },
  renderBar() {
    const all = this.inSpace().length, n = this.list.length;
    $('#libCount').textContent = S.filters.length ? `${fmt.n(n)} of ${fmt.n(all)}` + (m => m ? `, and ${fmt.n(m)} by meaning` : '')(Meaning.extra().length) : fmt.plural(all, 'item');
    const chips = $('#chips'); chips.innerHTML = '';
    S.filters.forEach(f => chips.append(el('button', { class: 'chip on' + (f.type === 'scene' || f.type === 'thing' ? ' ai' : ''), title: 'Remove filter', onclick: () => { S.filters.splice(S.filters.indexOf(f), 1); this.changed(); } }, f.type === 'color' ? el('i', { class: 'dot', style: { background: BUCKETS.find(b => b[0] === f.value)[1] } }) : null, el('span', { text: f.type === 'text' ? `“${f.label}”` : f.label }), el('span', { class: 'chip-x', html: icon('x', 12) }))));
    if (S.filters.length > 1) chips.append(el('button', { class: 'linkbtn', text: 'Clear all', onclick: () => this.clear() }));
  },
  refresh() { this.compute(); this.renderFacets(); this.renderBar(); if (S.view === 'library') this.layout(); if (S.view === 'map') MapView.refresh(); },

  /* ----- bulk actions ----- */
  renderBulk() {
    const bar = $('#bulk'), n = S.sel.size; bar.hidden = n === 0 || S.view !== 'library'; if (!n) return;
    $('#bulkCount').textContent = fmt.plural(n, 'item') + ' selected';
    $$('[data-cap]', bar).forEach(b => b.hidden = !can(b.dataset.cap));
    if (S.spaces.length < 2) $('#bulkMove').hidden = true;
  },
  /* one request for the whole selection */
  /* The server takes up to 5,000 at a time, so a very large selection goes in a few requests, one after another. */
  async send(items, action, extra) {
    const ids = items.map(i => i.id); let n = 0;
    for (let k = 0; k < ids.length; k += 5000) n += (await api('POST', '/api/items/bulk', { ids: ids.slice(k, k + 5000), action, ...extra })).n || 0;
    return { ok: true, n };
  },
  bulk(action, btn) {
    const items = this.selected(); if (!items.length) return;
    const n = fmt.plural(items.length, 'item');
    if (action === 'clear') { S.sel.clear(); Bus.emit('sel'); }
    else if (action === 'fav') {
      const on = !items.every(i => i.fav); items.forEach(i => i.fav = on); this.refresh();
      attempt(this.send(items, on ? 'like' : 'unlike'), on ? `Liked ${n}` : `Removed your like from ${n}`).catch(() => Sync.soon());
    }
    else if (action === 'location') LocDialog.open(items);
    else if (action === 'date') DateDialog.open(items);
    else if (action === 'move') {
      const list = el('div', { class: 'menu' }, el('p', { class: 'pop-h', text: `Move ${n} to` }), S.spaces.filter(s => s.id !== S.space).map(s => el('button', { class: 'mi', text: s.name, onclick: () => {
        closePop(); attempt(this.send(items, 'move', { spaceId: s.id }), `Moved ${n} to ${s.name}`).then(() => { items.forEach(i => i.space = s.id); S.sel.clear(); Bus.emit('sel'); this.refresh(); });
      } })));
      popover(btn, list, { up: true });
    }
    else if (action === 'download') {
      if (items.length > 25) return toast('Select 25 or fewer to download in one go.');
      items.forEach((it, k) => setTimeout(() => Img.download(it), k * 400));
      toast(`Downloading ${fmt.plural(items.length, 'original')}`);
    }
    else if (action === 'delete') {
      popover(btn, el('div', { class: 'confirm' }, el('p', { text: `Move ${n} to the trash? The owner can bring them back until the trash is emptied.` }), el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Keep', onclick: closePop }), el('button', { class: 'btn small danger', text: 'Move to trash', onclick: () => { closePop(); removeItems(items); } }))), { up: true });
    }
    else if (action === 'tag') {
      const inp = el('input', { class: 'inp', placeholder: 'Type a tag, press Enter', 'aria-label': 'Tag to add' });
      const add = v => { v = v.trim().toLowerCase(); if (!v) return; closePop(); attempt(this.send(items, 'tag', { tags: [v] }), `Tagged ${n} “${v}”`).then(() => { items.forEach(i => { if (!i.tags.includes(v)) { i.tags.push(v); i.hay = null; } }); this.refresh(); }); };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') add(inp.value); });
      const known = allTags(S.space).slice(0, 8);
      popover(btn, el('div', { class: 'tagpop' }, el('p', { class: 'pop-h', text: `Add a tag to ${n}` }), inp, el('div', { class: 'fvals wrap' }, known.map(t => el('button', { class: 'chip', text: t, onclick: () => add(t) })))), { up: true }); inp.focus();
    }
    else if (action === 'reel') Reels.open(null, items);
    else if (action === 'story') {
      const inp = el('input', { class: 'inp', placeholder: 'Story title', value: Stories.guessTitle(items), 'aria-label': 'Story title' });
      const go = () => { closePop(); Stories.create(inp.value.trim() || 'Untitled story', items).then(s => { S.sel.clear(); Bus.emit('sel'); Stories.open(s.id); }); };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      /* or into a story that is already there: a picture can be in as many stories as you like */
      const theirs = S.stories.filter(s => s.space === S.space && Stories.mine(s)).slice(0, 12);
      const into = theirs.length ? [el('p', { class: 'pop-h bulk-into', text: 'Or add them to a story' }), el('div', { class: 'menu bulk-stories' }, theirs.map(s => el('button', { class: 'mi', text: s.title, onclick: () => { closePop(); Stories.addTo(s, items).then(ok => { if (ok) { S.sel.clear(); Bus.emit('sel'); } }); } })))] : null;
      popover(btn, el('div', { class: 'tagpop' }, el('p', { class: 'pop-h', text: `Make a story from ${n}` }), inp, el('div', { class: 'rowr' }, el('button', { class: 'btn small primary', text: 'Make story', onclick: go })), into), { up: true }); inp.focus(); inp.select();
    }
  }
};
function likedBy(it) { const names = it.likes.map(id => id === myId() ? 'you' : (S.users.find(u => u.id === id) || { name: 'someone' }).name); names.sort((a, b) => (b === 'you') - (a === 'you')); return names.length > 2 ? names.slice(0, 2).join(', ') + ' and ' + (names.length - 2) + ' more' : names.join(' and '); }
function allTags(space) { const m = new Map(); S.items.filter(i => !space || i.space === space).forEach(i => i.tags.forEach(t => m.set(t, (m.get(t) || 0) + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]); }
/* deleting sends items to the trash on the server, then drops them from the list here */
function removeItems(items) {
  const ids = new Set(items.map(i => i.id));
  return Lib.send(items, 'delete').then(() => {
    /* the owner can go straight to the trash from here, to put something back */
    toast(`Moved ${fmt.plural(items.length, 'item')} to the trash`, can('admin') ? { label: 'Open trash', fn: () => { if (!$('#viewer').hidden) Viewer.close(); go('trash'); } } : undefined);
    S.items = S.items.filter(i => !ids.has(i.id)); ids.forEach(id => { S.byId.delete(id); S.sel.delete(id); });
    Stories.forget(ids);
    Bus.emit('sel'); Lib.refresh();
  }, e => { toast(e.message); throw e; });
}

function initLibrary() {
  const sc = $('#gridScroll'), grid = $('#grid');
  let raf = 0; sc.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; Lib.window(); }); }, { passive: true });
  let rw = 0; new ResizeObserver(() => { if (S.view !== 'library') return; const w = grid.clientWidth; if (Math.abs(w - rw) > 1) { rw = w; Lib.layout(); } }).observe(sc);
  /* With a finger: hold a picture for half a second to start selecting, then tap others to add them.
     The hold only counts if the finger stays put, so scrolling never selects anything. */
  let press = null, held = 0;
  const letGo = () => { if (press) { clearTimeout(press.timer); press = null; } };
  grid.addEventListener('pointerdown', e => {
    letGo(); if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return; const t = e.target.closest('.tile'); if (!t || e.target.closest('.like')) return;
    const id = t.dataset.id, x = e.clientX, y = e.clientY;
    press = { id, x, y, timer: setTimeout(() => { press = null; held = Date.now(); Lib.select(id, false); if (navigator.vibrate) try { navigator.vibrate(12); } catch (err) { } }, 480) };
  });
  grid.addEventListener('pointermove', e => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) letGo(); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) grid.addEventListener(ev, letGo);
  sc.addEventListener('scroll', letGo, { passive: true });
  /* the phone's own long-press menu would cover the selection it just started */
  grid.addEventListener('contextmenu', e => { if (Date.now() - held < 1500 || (e.pointerType && e.pointerType !== 'mouse')) e.preventDefault(); });
  grid.addEventListener('click', e => {
    /* lifting the finger after a hold is not a tap */
    if (Date.now() - held < 700) { held = 0; return; }
    const t = e.target.closest('.tile'); if (!t) return; const id = t.dataset.id;
    const lk = e.target.closest('.like'); if (lk) return Lib.like(id);
    if (e.target.closest('.tick') || e.shiftKey || e.metaKey || e.ctrlKey || S.sel.size) Lib.select(id, e.shiftKey);
    else Viewer.open(id, Lib.order);
  });
  grid.addEventListener('keydown', e => { const t = e.target.closest('.tile'); if (!t) return; if (e.key === 'Enter') Viewer.open(t.dataset.id, Lib.order); if (e.key === ' ') { e.preventDefault(); Lib.select(t.dataset.id, e.shiftKey); } });
  $('#selGroup').addEventListener('change', e => { S.group = e.target.value; Lib.layout(); });
  $('#selSort').addEventListener('change', e => { S.sort = e.target.value; Lib.compute(); Lib.layout(); sc.scrollTop = 0; });
  $('#rowH').addEventListener('input', e => { S.rowH = +e.target.value; Lib.layout(); });
  $('#facetScrim').addEventListener('click', () => $('.browse').classList.remove('nofacets'));
  $('#btnFacets').addEventListener('click', () => { $('.browse').classList.toggle('nofacets'); if (S.view === 'library') Lib.layout(); });
  $('#bulk').addEventListener('click', e => { const b = e.target.closest('[data-bulk]'); if (b) Lib.bulk(b.dataset.bulk, b); });
  // time ribbon: hover shows the month, press or drag jumps there
  const rb = $('#ribbon');
  const at = e => { const r = rb.getBoundingClientRect(); return clamp((e.clientY - r.top - 8) / (r.height - 16), 0, 1); };
  let drag = false;
  rb.addEventListener('pointermove', e => { const f = at(e), tip = $('#rbTip'); if (!tip) return; const m = Lib.monthAt(f * Lib.total); tip.textContent = m ? m.label : ''; tip.style.top = e.clientY - rb.getBoundingClientRect().top + 'px'; tip.classList.add('show'); if (drag) sc.scrollTop = f * Lib.total - sc.clientHeight / 2; });
  rb.addEventListener('pointerdown', e => { drag = true; rb.setPointerCapture(e.pointerId); sc.scrollTop = at(e) * Lib.total - sc.clientHeight / 2; });
  rb.addEventListener('pointerup', () => drag = false); rb.addEventListener('pointerleave', () => { const tip = $('#rbTip'); if (tip) tip.classList.remove('show'); });
  Bus.on('filters', () => { Lib.renderFacets(); Lib.renderBar(); if (S.view === 'library') { Lib.layout(); sc.scrollTop = 0; } });
  Bus.on('sel', () => { Lib.paintSel(); Lib.renderBulk(); });
  Bus.on('synced', () => { Lib.refresh(); Dupes.load(); Sugg.load(); if (S.view === 'stories' && $('#reader').hidden) Stories.render(); });
}

/* ----- search lens: one box that understands places, scenes, things, tags, colors, years ----- */
function initLens() {
  const inp = $('#lensInput'), box = $('#lensSug'); let sug = [], hi = 0;
  const build = () => {
    const q = norm(inp.value.trim()); sug = []; hi = 0;
    if (!q) { box.hidden = true; return; }
    sug.push({ type: 'text', value: q, label: inp.value.trim(), kind: 'Anything matching', n: Lib.inSpace().filter(i => q.split(/\s+/).every(w => hay(i).includes(w))).length });
    const space = Lib.inSpace();
    for (const type of ['place', 'scene', 'thing', 'tag', 'series', 'year', 'color', 'cam']) {
      const counts = new Map(); for (const it of space) for (const v of FACETS[type].get(it)) counts.set(v, (counts.get(v) || 0) + 1);
      [...counts.entries()].filter(([v]) => norm(facetName(type, v)).includes(q)).sort((a, b) => b[1] - a[1]).slice(0, 4).forEach(([v, n]) => sug.push({ type, value: v, label: facetName(type, v), kind: { place: 'Place', scene: 'Scene', thing: 'In the picture', tag: 'Tag', series: 'Series', year: 'Year', color: 'Color', cam: 'Camera' }[type], n }));
    }
    sug = sug.slice(0, 11); if (sug.length > 1 && sug[0].n === 0) hi = 1;
    paint();
  };
  const paint = () => {
    box.innerHTML = ''; box.hidden = false;
    sug.forEach((s, i) => box.append(el('button', { class: 'sug' + (i === hi ? ' hi' : ''), role: 'option', onmousedown: e => { e.preventDefault(); apply(i); } },
      el('span', { class: 'sug-k' + (s.type === 'scene' || s.type === 'thing' ? ' ai' : ''), text: s.kind }), s.type === 'color' ? el('i', { class: 'dot', style: { background: BUCKETS.find(b => b[0] === s.value)[1] } }) : null, el('span', { class: 'sug-l', text: s.type === 'text' ? `“${s.label}”` : s.label }), el('span', { class: 'n', text: s.n }))));
  };
  const apply = i => { const s = sug[i]; if (!s) return; if (!Lib.has(s.type, s.value)) S.filters.push({ type: s.type, value: s.value, label: s.label }); inp.value = ''; box.hidden = true; if (S.view !== 'library' && S.view !== 'map') go('library'); Lib.changed(); };
  inp.addEventListener('input', build); inp.addEventListener('focus', build);
  inp.addEventListener('blur', () => setTimeout(() => box.hidden = true, 120));
  inp.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.min(sug.length - 1, hi + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(0, hi - 1); paint(); }
    else if (e.key === 'Enter') apply(hi);
    else if (e.key === 'Escape') { inp.value = ''; box.hidden = true; inp.blur(); }
    else if (e.key === 'Backspace' && !inp.value && S.filters.length) { S.filters.pop(); Lib.changed(); }
  });
}
