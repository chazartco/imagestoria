/* ---------- trash (owner only): what was deleted, whole and uncropped, until it is removed for good ---------- */
const Trash = {
  items: [], days: 0, sel: new Set(), io: null, loaded: false,
  async load() {
    const r = await api('GET', '/api/trash'); this.days = r.days || 0; this.loaded = true;
    this.items = r.items.map(t => ({ ...t, w: t.w || 3, h: t.h || 2, ar: (t.w || 3) / (t.h || 2), ghost: ghostOf((t.palette && t.palette[0]) || '#3a3d41') }));
    const ids = new Set(this.items.map(i => i.id)); for (const id of [...this.sel]) if (!ids.has(id)) this.sel.delete(id);
  },
  render() {
    const box = $('#v-trash');
    if (!can('admin')) { box.innerHTML = ''; box.append(el('div', { class: 'ad-wrap' }, el('h1', { text: 'Trash' }), el('p', { class: 'empty', text: 'Only the owner can open the trash.' }))); return; }
    /* never show what the trash held last time: it may have been emptied or put back since */
    box.innerHTML = ''; box.append(el('div', { class: 'ad-wrap' }, el('h1', { text: 'Trash' }), el('p', { class: 'muted', text: 'Loading' })));
    this.load().then(() => { if (S.view === 'trash') this.paint(); }, e => toast(e.message));
  },
  selected() { return this.items.filter(i => this.sel.has(i.id)); },
  /* after a change: ask the server what is left, and bring the library up to date when things came back */
  after(back) { return this.load().then(() => { if (S.view === 'trash') this.paint(); if (back) return Sync.full().then(() => Lib.refresh()); }); },
  restore(list) {
    const body = list ? { ids: list.map(i => i.id) } : undefined;
    return attempt(api('POST', '/api/trash/restore', body)).then(r => {
      toast(r.skipped ? `Put back ${fmt.plural(r.restored, 'item')}. ${fmt.plural(r.skipped, 'item')} stayed because the same file is already in the library.` : `Put back ${fmt.plural(r.restored, 'item')}`);
      return this.after(true);
    }, () => { });
  },
  remove(list, btn) {
    const all = !list, rows = list || this.items, bytes = rows.reduce((a, i) => a + i.bytes, 0), n = fmt.plural(rows.length, 'item');
    popover(btn, el('div', { class: 'confirm' }, el('p', { text: `Delete ${n} and ${rows.length === 1 ? 'its files' : 'their files'} for good? That frees ${fmt.bytes(bytes)}. This cannot be undone.` }),
      el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Keep', onclick: closePop }), el('button', { class: 'btn small danger', id: 'trYes', text: 'Delete for good', onclick: () => { closePop(); attempt(api('POST', '/api/trash/empty', all ? undefined : { ids: rows.map(i => i.id) }), all ? 'Trash emptied' : `Deleted ${n} for good`).then(() => this.after(false), () => { }); } }))));
  },
  toggle(id) { if (this.sel.has(id)) this.sel.delete(id); else this.sel.add(id); this.paintSel(); },
  paintSel() {
    $$('#v-trash .tile').forEach(t => t.classList.toggle('sel', this.sel.has(t.dataset.id)));
    const n = this.sel.size, bar = $('#trSel'); if (!bar) return; bar.hidden = !n; $('#trAll').hidden = !!n; $('#v-trash .tr-grid').classList.toggle('selecting', n > 0);
    if (n) $('#trSelCount').textContent = `${fmt.plural(n, 'item')} selected, ${fmt.bytes(this.selected().reduce((a, i) => a + i.bytes, 0))}`;
  },
  paint() {
    const box = $('#v-trash'), top = box.scrollTop, items = this.items; box.innerHTML = ''; if (this.io) this.io.disconnect();
    const rule = this.days > 0 ? `Items are removed for good ${fmt.plural(this.days, 'day')} after they were deleted.` : 'Items stay here until you delete them for good. Nothing is removed by itself.';
    const wrap = el('div', { class: 'ad-wrap tr-wrap' }, el('button', { class: 'linkbtn', text: 'People and settings', onclick: () => go('admin') }), el('h1', { text: 'Trash' }));
    if (!items.length) { wrap.append(el('p', { class: 'ad-p', id: 'trRule', text: 'The trash is empty. ' + rule })); box.append(wrap); return; }
    const twins = items.filter(i => i.twin).length, bytes = items.reduce((a, i) => a + i.bytes, 0);
    wrap.append(el('p', { class: 'ad-p', id: 'trRule', text: `${fmt.plural(items.length, 'item')}, ${fmt.bytes(bytes)}. ${rule} Click items to choose some, or act on all of them.` }));
    if (twins) wrap.append(el('p', { class: 'vi-note tr-twins', id: 'trTwins', text: `${fmt.plural(twins, 'item')} cannot be put back, because the same file was added again and is already in the library. ${twins === 1 ? 'It is' : 'They are'} marked below.` }));
    wrap.append(
      el('div', { class: 'btnrow tr-bar', id: 'trAll' }, el('button', { class: 'btn', id: 'trBackAll', text: 'Put everything back', onclick: () => this.restore() }), el('button', { class: 'btn danger', id: 'trEmpty', text: 'Empty the trash', onclick: e => this.remove(null, e.currentTarget) })),
      el('div', { class: 'btnrow tr-bar', id: 'trSel', hidden: true }, el('b', { id: 'trSelCount' }), el('button', { class: 'btn', id: 'trBack', text: 'Put back', onclick: () => this.restore(this.selected()) }), el('button', { class: 'btn danger', id: 'trDelete', text: 'Delete for good', onclick: e => this.remove(this.selected(), e.currentTarget) }), el('button', { class: 'btn', text: 'Clear selection', onclick: () => { this.sel.clear(); this.paintSel(); } })));
    const grid = el('div', { class: 'tr-grid' }); wrap.append(grid); box.append(wrap);
    /* the same rows as the library: every picture whole. A row gets its pictures when it scrolls into sight. */
    const fill = row => { if (row._done) return; row._done = true; row._cells.forEach(c => { const img = $(`.tile[data-id="${c.it.id}"] img`, row); if (img) loadInto(img, c.it, 'thumb'); }); };
    this.io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { fill(e.target); this.io.unobserve(e.target); } }), { root: box, rootMargin: '600px 0px' });
    for (const r of Lib.justify(items, Math.max(240, grid.clientWidth), 190, 4)) {
      const row = el('div', { class: 'tr-row', style: { height: Math.round(r.h) + 'px' } }); row._cells = r.cells;
      r.cells.forEach(c => row.append(el('div', { class: 'tile' + (this.sel.has(c.it.id) ? ' sel' : ''), data: { id: c.it.id }, tabIndex: 0, role: 'button', 'aria-label': `${c.it.title || c.it.fileName}, deleted ${fmt.ago(c.it.deletedAt)}`, title: c.it.title || c.it.fileName, style: { left: c.x + 'px', width: c.w + 'px', height: r.h + 'px', background: c.it.ghost } },
        el('img', { alt: '', draggable: false }), el('span', { class: 'tick', html: icon('check', 14) }),
        el('span', { class: 'badges' }, c.it.kind === 'video' ? el('span', { class: 'bdg', html: icon('play', 12) }) : null, c.it.twin ? el('span', { class: 'bdg err', text: 'Already back in the library' }) : null),
        el('span', { class: 'tr-when', text: 'Deleted ' + fmt.ago(c.it.deletedAt) }))));
      grid.append(row); this.io.observe(row);
    }
    grid.onclick = e => { const t = e.target.closest('.tile'); if (t) this.toggle(t.dataset.id); };
    grid.onkeydown = e => { const t = e.target.closest('.tile'); if (t && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); this.toggle(t.dataset.id); } };
    this.paintSel(); box.scrollTop = top;
  }
};
addEventListener('resize', debounce(() => { if (S.view === 'trash' && Trash.loaded) Trash.paint(); }, 160));
