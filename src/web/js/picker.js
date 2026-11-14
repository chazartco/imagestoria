/* ---------- story picker: choose pictures and videos for a story ----------
   Used to make a story from scratch and to add to one that exists. A picture can be in as many stories as you like.
   Four ways to find what to pick: everything, by place, by day, and by moment. A moment is a run of pictures taken
   close together in time at one place, so "Saturday morning in town" and "Saturday evening at the lake" are two. */
const StoryPicker = {
  sheet: null, sel: null, pool: [], mode: 'all', key: null, story: null, io: null, has: null,
  partOfDay(ms) { const h = new Date(ms).getHours(); return h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night'; },
  placeName(it) { return it.place && PLACES[it.place] ? PLACES[it.place].name : ''; },
  /* the groups to offer for a way of looking. Newest first, except places, which go by how much they hold. */
  groups(mode) {
    const map = new Map(), add = (k, label, it, sort) => { let g = map.get(k); if (!g) map.set(k, g = { key: k, label, items: [], sort }); g.items.push(it); };
    if (mode === 'place') { for (const it of this.pool) { const n = this.placeName(it); add(n || '~', n || 'No location', it, 0); } return [...map.values()].sort((a, b) => (a.key === '~') - (b.key === '~') || b.items.length - a.items.length); }
    if (mode === 'day') { for (const it of this.pool) { const d = new Date(it.date), k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; add(k, `${fmt.weekday(it.date)}, ${fmt.day(it.date)}`, it, it.date); } return [...map.values()].sort((a, b) => b.sort - a.sort); }
    if (mode === 'moment') {
      /* a new moment begins after three quiet hours, or when the place changes */
      const asc = this.pool.slice().sort((a, b) => a.date - b.date), out = []; let cur = null;
      for (const it of asc) {
        if (!cur || it.date - cur.last > 3 * 3600000 || this.placeName(it) !== cur.place) out.push(cur = { key: 'm' + it.id, items: [], place: this.placeName(it), first: it.date });
        cur.items.push(it); cur.last = it.date;
      }
      out.forEach(g => { g.label = `${fmt.weekday(g.first).slice(0, 3)}, ${fmt.dayShort(g.first)}, ${this.partOfDay(g.first)}${g.place ? ' in ' + g.place : ''}`; g.sort = g.first; });
      return out.sort((a, b) => b.sort - a.sort);
    }
    return [];
  },

  /* story: add to this one. Without it: a new story. */
  open(opts) {
    opts = opts || {}; if (!can('edit')) return; this.close();
    const story = this.story = opts.story || null; this.sel = new Set(opts.start || []); this.mode = 'all'; this.key = null;
    this.has = new Set(story ? story.ids : []);
    this.pool = S.items.filter(i => i.space === (story ? story.space : S.space) && i.status === 'ready').sort((a, b) => b.date - a.date);
    const title = el('input', { class: 'inp sp-title', id: 'spTitle', placeholder: 'Story title', maxlength: 200, 'aria-label': 'Story title' });
    const seg = el('div', { class: 'seg sp-seg', role: 'tablist' }, [['all', 'Everything'], ['place', 'By place'], ['day', 'By day'], ['moment', 'By moment']].map(([m, t]) => el('button', { role: 'tab', data: { m }, class: m === 'all' ? 'on' : '', text: t, onclick: () => { this.mode = m; this.key = null; this.paint(); } })));
    const sheet = this.sheet = el('div', { class: 'overlay sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': story ? 'Add to the story' : 'New story', onclick: e => { if (e.target === sheet) this.close(); } },
      el('div', { class: 'sheet-box sp-box' },
        el('header', {}, el('h2', { text: story ? `Add pictures to “${story.title}”` : 'New story' }), el('button', { class: 'iconbtn modal-x', id: 'spClose', title: 'Close', 'aria-label': 'Close', html: icon('x'), onclick: () => this.close() })),
        el('div', { class: 'sp-top' }, story ? null : title, seg, el('span', { class: 'muted sp-note', id: 'spNote' })),
        el('div', { class: 'sp-main' }, el('div', { class: 'sp-groups', id: 'spGroups' }), el('div', { class: 'sp-grid', id: 'spGrid' })),
        el('div', { class: 'rowr sp-foot' }, el('b', { id: 'spCount' }), el('button', { class: 'linkbtn', id: 'spClear', text: 'Clear', onclick: () => { this.sel.clear(); this.paintSel(); this.paintGroups(); } }), el('span', { class: 'grow1' }),
          el('button', { class: 'btn', text: 'Cancel', onclick: () => this.close() }), el('button', { class: 'btn primary', id: 'spGo', onclick: () => this.go() }))));
    sheet._close = () => this.close();
    document.body.append(sheet); this.paint(); if (!story) title.focus();
  },
  close() { if (!this.sheet) return; if (this.io) this.io.disconnect(); this.sheet.remove(); this.sheet = this.io = this.story = null; this.pool = []; },
  shown() { if (this.mode === 'all' || !this.key) return this.pool; const g = this.groups(this.mode).find(x => x.key === this.key); return g ? g.items.slice().sort((a, b) => a.date - b.date) : this.pool; },
  free(items) { return items.filter(i => !this.has.has(i.id)); },
  paint() {
    $$('.sp-seg button', this.sheet).forEach(b => b.classList.toggle('on', b.dataset.m === this.mode));
    $('#spNote').textContent = { all: 'Click pictures to choose them one by one.', place: 'Everything taken in one place.', day: 'Everything taken on one day.', moment: 'Pictures taken close together in time, in one place.' }[this.mode];
    this.sheet.classList.toggle('sp-flat', this.mode === 'all');
    this.paintGroups(); this.paintGrid(); this.paintSel();
  },
  paintGroups() {
    const box = $('#spGroups'); const top = box.scrollTop; box.innerHTML = ''; box.hidden = this.mode === 'all'; if (box.hidden) return;
    box.append(el('button', { class: 'sp-g' + (!this.key ? ' on' : ''), onclick: () => { this.key = null; this.paintGroups(); this.paintGrid(); } }, el('span', { class: 'sp-gl', text: 'Show everything' }), el('span', { class: 'n', text: fmt.n(this.pool.length) })));
    for (const g of this.groups(this.mode)) {
      const free = this.free(g.items), all = free.length > 0 && free.every(i => this.sel.has(i.id)), some = free.filter(i => this.sel.has(i.id)).length;
      box.append(el('div', { class: 'sp-g' + (this.key === g.key ? ' on' : ''), data: { key: g.key } },
        el('button', { class: 'sp-gl', title: 'Show these', onclick: () => { this.key = g.key; this.paintGroups(); this.paintGrid(); } }, el('span', { text: g.label }), el('small', { class: 'muted', text: `${fmt.plural(g.items.length, 'item')}${some ? `, ${some} chosen` : ''}` })),
        free.length ? el('button', { class: 'btn small sp-all', text: all ? 'Remove' : 'Add all', 'aria-label': `${all ? 'Remove' : 'Add all of'} ${g.label}`, onclick: () => { free.forEach(i => all ? this.sel.delete(i.id) : this.sel.add(i.id)); this.paintSel(); this.paintGroups(); } }) : el('span', { class: 'muted sp-in', text: 'In the story' })));
    }
    box.scrollTop = top;
  },
  /* the library's own rows, every picture whole. A row is filled with its pictures when it scrolls into sight. */
  paintGrid() {
    const grid = $('#spGrid'), items = this.shown(); grid.innerHTML = ''; grid.scrollTop = 0; if (this.io) this.io.disconnect();
    if (!items.length) { grid.append(el('p', { class: 'empty', text: 'There is nothing here to choose from yet.' })); return; }
    const fill = row => {
      if (row._done) return; row._done = true;
      row._cells.forEach(c => {
        const it = c.it, im = el('img', { alt: '', draggable: false }), inStory = this.has.has(it.id);
        row.append(el('div', { class: 'tile' + (this.sel.has(it.id) ? ' sel' : '') + (inStory ? ' has' : ''), data: { id: it.id }, tabIndex: inStory ? -1 : 0, role: 'button', 'aria-pressed': this.sel.has(it.id), 'aria-label': label(it) + ', ' + fmt.day(it.date), title: `${label(it)}, ${fmt.day(it.date)}${this.placeName(it) ? ', ' + this.placeName(it) : ''}`, style: { left: c.x + 'px', width: c.w + 'px', height: row._h + 'px', background: it.ghost } },
          im, inStory ? el('span', { class: 'bdg sp-has', text: 'In the story' }) : el('span', { class: 'tick', html: icon('check', 14) }), it.kind === 'video' ? el('span', { class: 'badges' }, el('span', { class: 'bdg', html: icon('play', 12) + (it.duration ? ' ' + fmt.dur(it.duration) : '') })) : null));
        loadInto(im, it, 'thumb');
      });
    };
    this.io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { fill(e.target); this.io.unobserve(e.target); } }), { root: grid, rootMargin: '500px 0px' });
    for (const r of Lib.justify(items, Math.max(200, grid.clientWidth - 2), 124, 4)) { const row = el('div', { class: 'sp-row', style: { height: Math.round(r.h) + 'px' } }); row._cells = r.cells; row._h = r.h; grid.append(row); this.io.observe(row); }
    grid.onclick = e => { const t = e.target.closest('.tile'); if (t && !t.classList.contains('has')) this.toggle(t.dataset.id); };
    grid.onkeydown = e => { const t = e.target.closest('.tile'); if (t && !t.classList.contains('has') && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); this.toggle(t.dataset.id); } };
  },
  toggle(id) { if (this.sel.has(id)) this.sel.delete(id); else this.sel.add(id); this.paintSel(); if (this.mode !== 'all') this.paintGroups(); },
  paintSel() {
    $$('#spGrid .tile').forEach(t => { const on = this.sel.has(t.dataset.id); t.classList.toggle('sel', on); t.setAttribute('aria-pressed', on); });
    const n = this.sel.size; $('#spCount').textContent = n ? `${fmt.plural(n, 'item')} chosen` : 'Nothing chosen yet'; $('#spClear').hidden = !n;
    const go = $('#spGo'); go.disabled = !n; go.textContent = this.story ? (n ? `Add ${fmt.plural(n, 'item')}` : 'Add to story') : 'Create story';
  },
  go() {
    const items = [...this.sel].map(id => S.byId.get(id)).filter(Boolean), story = this.story; if (!items.length) return;
    $('#spGo').disabled = true;
    if (story) return Stories.addTo(story, items).then(ok => { if (ok) { this.close(); if (Stories.cur === story) Stories.repaint(); } else if (this.sheet) $('#spGo').disabled = false; });
    const title = $('#spTitle').value.trim() || Stories.guessTitle(items);
    Stories.create(title, items).then(s => { this.close(); if (S.view !== 'stories') go('stories'); Stories.open(s.id); }, () => { if (this.sheet) $('#spGo').disabled = false; });
  }
};
