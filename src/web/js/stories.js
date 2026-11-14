/* ---------- stories: photos told in order, with your words between them ----------
   A story arranges itself by date until its author arranges it by hand. Then it has sections: each with a
   title, a text and its pictures in the author's order (s.sections). s.sections is null while it is automatic. */
const Stories = {
  cur: null, io: null, mode: null, // mode: null (reading), 'cover' (choosing the cover) or 'arrange' (sections and order)
  /* the story's pictures in the order they are told */
  items(s) {
    if (s.sections) return s.sections.flatMap(x => x.ids).map(id => S.byId.get(id)).filter(Boolean);
    return s.ids.map(id => S.byId.get(id)).filter(Boolean).sort((a, b) => a.date - b.date);
  },
  /* the cover: the pictures the author chose, up to four, or the first picture when nothing was chosen */
  covers(s, items) {
    items = items || this.items(s); const have = new Set(items.map(i => i.id));
    const c = (s.covers || []).filter(id => have.has(id)).map(id => S.byId.get(id));
    return c.length ? c : items.slice(0, 1);
  },
  span(items) { if (!items.length) return ''; const ds = items.map(i => i.date), a = Math.min(...ds), b = Math.max(...ds); const da = new Date(a), db = new Date(b); if (da.toDateString() === db.toDateString()) return fmt.day(a); if (da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth()) return `${MONTHS[da.getMonth()]} ${da.getDate()} to ${db.getDate()}, ${da.getFullYear()}`; return `${fmt.dayShort(a)} to ${fmt.dayShort(b)}`; },
  places(items) { return [...new Set(items.map(i => i.place).filter(p => p && PLACES[p]))].map(p => PLACES[p].name); },
  guessTitle(items) { const ser = new Set(items.map(i => i.series)); if (ser.size === 1 && items[0].series) return items[0].series; const pl = this.places(items); return (pl[0] ? pl[0] + ', ' : '') + fmt.month(Math.min(...items.map(i => i.date))); },
  load() { return api('GET', '/api/stories').then(r => { S.stories = r.stories; }); },
  create(title, items) {
    items = items.slice().sort((a, b) => a.date - b.date);
    const cover = (items.find(i => i.fav) || items[0]).id, ids = items.map(i => i.id);
    return attempt(api('POST', '/api/stories', { title, spaceId: S.space, ids, cover })).then(r => {
      const s = { id: r.id, space: S.space, title, intro: '', ids, cover, covers: [cover], notes: {}, sections: null, shared: [], by: S.me.id, made: Date.now() };
      S.stories.unshift(s); return s;
    });
  },
  /* items that left the library drop out of every story, its cover and its sections */
  forget(gone) {
    S.stories.forEach(s => {
      s.ids = s.ids.filter(id => !gone.has(id)); s.covers = (s.covers || []).filter(id => !gone.has(id));
      if (s.sections) { s.sections.forEach(x => x.ids = x.ids.filter(id => !gone.has(id))); s.sections = s.sections.filter(x => x.ids.length); if (!s.sections.length) s.sections = null; }
    });
  },
  /* typing in a story is saved a moment after it stops */
  save(s, patch) {
    const p = this._pend && this._pend.s === s ? this._pend : (this.flush(), this._pend = { s, body: {} });
    if (patch.notes) p.body.notes = Object.assign(p.body.notes || {}, patch.notes); else Object.assign(p.body, patch);
    clearTimeout(this._pt); this._pt = setTimeout(() => this.flush(), 800);
  },
  flush() {
    clearTimeout(this._pt); const p = this._pend; if (!p) return; this._pend = null;
    if (p.body.title !== undefined && !p.body.title.trim()) delete p.body.title;
    if (Object.keys(p.body).length) api('PATCH', '/api/stories/' + p.s.id, p.body).catch(e => toast('Not saved. ' + e.message));
  },
  mine(s) { return !S.share && !!S.me && (S.me.role === 'owner' || S.me.role === 'editor' || (can('edit') && s.by === S.me.id)); },
  /* every group name in use in this space, most used first */
  allGroups() { const m = new Map(); S.stories.filter(s => s.space === S.space).forEach(s => (s.groups || []).forEach(g => m.set(g, (m.get(g) || 0) + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])); },
  /* put pictures into a story that exists. A picture can be in any number of stories. */
  addTo(s, items) {
    const fresh = items.filter(i => !s.ids.includes(i.id)); if (!fresh.length) { toast('Those are already in that story.'); return Promise.resolve(false); }
    if (this._pend && this._pend.s === s) this.flush();
    return api('PATCH', '/api/stories/' + s.id, { add: fresh.map(i => i.id) }).then(() => {
      const ids = fresh.map(i => i.id); s.ids.push(...ids); if (s.sections) s.sections[s.sections.length - 1].ids.push(...ids);
      toast(`Added ${fmt.plural(ids.length, 'item')} to “${s.title}”`); return true;
    }, e => { toast(e.message); return false; });
  },
  /* groups that could become a story: in a life space, photos taken close together in time;
     in a studio space, the pieces of one series */
  LONG: 80,
  suggestions() {
    const pool = S.items.filter(i => i.space === S.space && i.status === 'ready' && !i.copyOf).sort((a, b) => a.date - b.date), groups = [];
    if (curSpace().kind === 'studio') { const m = new Map(); pool.forEach(i => { if (i.series) { if (!m.has(i.series)) m.set(i.series, []); m.get(i.series).push(i); } }); m.forEach((items, name) => { if (items.length >= 4) groups.push({ title: name, items }); }); }
    else {
      /* A run of days with no gap over two days is one group. A long run (a whole trip, or a library with something every day) is cut into its days. */
      const add = list => { if (list.length >= 8) groups.push({ title: this.guessTitle(list), items: list }); }, day = i => new Date(i.date).toDateString();
      let cur = []; const close = () => { if (cur.length > this.LONG && day(cur[0]) !== day(cur[cur.length - 1])) { let d = []; cur.forEach(i => { if (d.length && day(i) !== day(d[0])) { add(d); d = []; } d.push(i); }); add(d); } else add(cur); cur = []; };
      pool.forEach(i => { if (cur.length && i.date - cur[cur.length - 1].date > 2 * dayMs) close(); cur.push(i); }); close();
    }
    /* A group is told when a story of about its own size holds most of it. One story with everything in it does not tell every day. */
    const told = S.stories.filter(s => s.space === S.space).map(s => new Set(s.ids));
    return groups.filter(g => !told.some(t => { const n = g.items.filter(i => t.has(i.id)).length; return n > g.items.length * .6 && n > t.size * .4; })).sort((a, b) => b.items[b.items.length - 1].date - a.items[a.items.length - 1].date).slice(0, 6);
  },

  /* ----- the cover: one to four pictures, each one whole -----
     The same justified rows as the grid, tried as one row and as two, keeping whichever shows the pictures largest. */
  coverRows(items, W, H, gap) {
    let best = null; const n = items.length;
    for (let k = n; k >= 1; k--) {
      const rows = (k === n ? [items] : [items.slice(0, k), items.slice(k)]).map(r => ({ items: r, h: (W - gap * (r.length - 1)) / r.reduce((a, i) => a + i.ar, 0) }));
      const f = Math.min(1, (H - gap * (rows.length - 1)) / rows.reduce((a, r) => a + r.h, 0));
      const area = rows.reduce((a, r) => a + r.items.reduce((x, i) => x + i.ar * r.h * f * r.h * f, 0), 0);
      if (!best || area > best.area * 1.001) best = { rows, f, area };
    }
    return best;
  },
  paintCover(box, items, lazy) {
    const cs = getComputedStyle(box), W = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), H = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    box.innerHTML = ''; if (!items.length || W < 20 || H < 20) return;
    const gap = items.length > 1 ? 6 : 0, lay = this.coverRows(items, W, H, gap), cv = el('div', { class: 'cv', style: { gap: gap + 'px' } });
    lay.rows.forEach(r => { const row = el('div', { class: 'cv-row', style: { gap: gap + 'px' } }); r.items.forEach(it => { const h = Math.floor(r.h * lay.f), im = el('img', { alt: label(it), data: { id: it.id }, draggable: false, width: Math.floor(it.ar * r.h * lay.f), height: h, style: { background: it.ghost } }); row.append(im); if (lazy) this.io.observe(im); else loadInto(im, it, 'display'); }); cv.append(row); });
    box.append(cv);
  },

  render() {
    const box = $('#v-stories'); box.innerHTML = '';
    const inSpace = S.stories.filter(s => s.space === S.space), groups = this.allGroups(), covers = [];
    if (this.group && !groups.some(g => g[0] === this.group)) this.group = null;
    const mine = this.group ? inSpace.filter(s => (s.groups || []).includes(this.group)) : inSpace;
    const wrap = el('div', { class: 'st-wrap' }, el('header', { class: 'st-head' }, el('div', { class: 'st-head-r' }, el('h1', { text: 'Stories' }), can('edit') ? el('button', { class: 'btn primary', id: 'stNew', html: icon('plus', 16) + '<span>New story</span>', onclick: () => StoryPicker.open() }) : null),
      el('p', { text: 'A story is a set of photos told in order, with your words between them. Open one to read it, or play it full screen.' })));
    if (groups.length) wrap.append(el('div', { class: 'fvals wrap st-groups', id: 'stGroups' }, el('button', { class: 'chip' + (!this.group ? ' on' : ''), text: `All stories (${inSpace.length})`, onclick: () => { this.group = null; this.render(); } }), groups.map(([g, n]) => el('button', { class: 'chip' + (this.group === g ? ' on' : ''), 'aria-pressed': this.group === g, text: `${g} (${n})`, onclick: () => { this.group = this.group === g ? null : g; this.render(); } }))));
    const grid = el('div', { class: 'st-grid' });
    mine.forEach(s => {
      const items = this.items(s), cov = this.covers(s, items), cover = cov[0]; if (!cover) return;
      const cb = el('div', { class: 'st-cover', style: { background: `linear-gradient(135deg, ${mix(cover.palette[0], '#111214', .55)}, ${mix(cover.palette[1] || cover.palette[0], '#111214', .7)})` } });
      covers.push([cb, cov]);
      grid.append(el('button', { class: 'st-card', data: { id: s.id }, onclick: () => this.open(s.id) }, cb,
        el('h3', { text: s.title }), el('p', { text: `${fmt.plural(items.length, 'item')}, ${this.span(items)}` }), this.places(items).length ? el('p', { class: 'muted', text: this.places(items).slice(0, 3).join(', ') }) : null, (s.groups || []).length ? el('p', { class: 'st-card-g', text: s.groups.join(', ') }) : null));
    });
    if (!mine.length) grid.append(el('p', { class: 'empty', text: can('edit') ? (this.group ? 'No stories in this group.' : 'No stories in this space yet. Choose “New story”, or select photos in the library and choose “Make story”.') : 'No stories have been shared with you in this space yet.' }));
    wrap.append(grid);
    if (can('edit')) {
      const sug = this.suggestions();
      if (sug.length) {
        wrap.append(el('h2', { class: 'st-sub', text: 'Ready to tell' }), el('p', { class: 'st-subp', text: curSpace().kind === 'studio' ? 'Each series could be a story.' : 'Photos that were taken close together in time. Each group could be a story.' }));
        const sg = el('div', { class: 'sg-list' });
        sug.forEach(g => {
          const items = g.items, strip = el('div', { class: 'sg-strip' }); items.filter((x, i) => i % Math.ceil(items.length / 6) === 0).slice(0, 6).forEach(it => { const im = el('img', { alt: '' }); strip.append(el('span', { class: 'st', style: { aspectRatio: it.ar, background: it.ghost } }, im)); loadInto(im, it, 'thumb'); });
          sg.append(el('div', { class: 'sg' }, el('div', { class: 'sg-t' }, el('h3', { text: g.title }), el('p', { class: 'muted', text: `${fmt.plural(items.length, 'item')}, ${this.span(items)}` })), strip,
            el('button', { class: 'btn small', text: 'Make this a story', onclick: () => this.create(g.title, items).then(s => this.open(s.id)) })));
        });
        wrap.append(sg);
      }
    }
    box.append(wrap);
    covers.forEach(([cb, cov]) => this.paintCover(cb, cov, false)); // sized once the cards are in the page
  },

  /* ----- parts: what the reader shows between its headings ----- */
  chapters(items) {
    const days = new Set(items.map(i => new Date(i.date).toDateString())), byMonth = days.size > 8, map = new Map();
    for (const it of items) { const d = new Date(it.date), k = byMonth ? d.getFullYear() + '-' + d.getMonth() : d.toDateString(); if (!map.has(k)) map.set(k, { key: k, items: [], label: byMonth ? fmt.month(it.date) : `${fmt.weekday(it.date)}, ${MONTHS[d.getMonth()]} ${d.getDate()}` }); map.get(k).items.push(it); }
    return [...map.values()];
  },
  parts(s) {
    if (s.sections) return s.sections.map((x, k) => ({ auto: false, k, title: x.title, text: x.text, items: x.ids.map(id => S.byId.get(id)).filter(Boolean) })).filter(p => p.items.length);
    return this.chapters(this.items(s)).map(ch => { const pl = this.places(ch.items); return { auto: true, key: ch.key, label: ch.label, title: ch.label + (pl.length === 1 ? ' in ' + pl[0] : ''), text: s.notes[ch.key] || '', items: ch.items }; });
  },
  draft(part) {
    const caps = [], seen = new Set(); for (const it of part.items) { if (it.ai.caption && !seen.has(it.ai.scene || it.ai.caption)) { seen.add(it.ai.scene || it.ai.caption); caps.push(it.ai.caption); } }
    const pl = this.places(part.items); const lead = pl.length ? `${pl.join(' and ')}. ` : '';
    return lead + caps.slice(0, 4).map((c, i) => i === 0 ? c : (i === caps.slice(0, 4).length - 1 ? 'Then ' + c[0].toLowerCase() + c.slice(1) : c)).join('. ') + '.';
  },

  /* ----- the author's own structure ----- */
  /* The first change made by hand turns the automatic parts into real sections, with their headings and whatever was written for them. */
  manual(s) { if (!s.sections) s.sections = this.parts(s).map(p => ({ title: p.title, text: p.text, ids: p.items.map(i => i.id) })); return s.sections; },
  /* after a change: no section is left empty, and nothing that was written is lost */
  settle(s) {
    const secs = s.sections;
    for (let k = secs.length - 1; k >= 0; k--) { if (secs[k].ids.length || secs.length === 1) continue; const into = secs[k ? k - 1 : 1]; into.text = (k ? [into.text, secs[k].text] : [secs[k].text, into.text]).filter(t => t.trim()).join('\n\n'); secs.splice(k, 1); }
    s.ids = secs.flatMap(x => x.ids);
    this.save(s, { sections: secs.map(x => ({ title: x.title, text: x.text, ids: x.ids })) });
  },
  split(s, k, at) {
    const secs = this.manual(s), x = secs[k]; if (!x || at <= 0 || at >= x.ids.length) return;
    secs.splice(k + 1, 0, { title: '', text: '', ids: x.ids.splice(at) }); this.settle(s);
  },
  /* removing a break joins a section to the one before it and keeps both texts */
  join(s, k) {
    const secs = this.manual(s); if (k <= 0 || !secs[k]) return; const a = secs[k - 1], b = secs[k];
    a.ids.push(...b.ids); a.text = [a.text, b.text].filter(t => t.trim()).join('\n\n'); if (!a.title.trim()) a.title = b.title; secs.splice(k, 1); this.settle(s);
  },
  /* put a picture at a place in a section. at counts among the pictures of that section before the move. */
  move(s, id, k, at) {
    const secs = this.manual(s), from = secs.findIndex(x => x.ids.includes(id)); if (from < 0 || !secs[k]) return;
    const i = secs[from].ids.indexOf(id); if (from === k && (at === i || at === i + 1)) return;
    secs[from].ids.splice(i, 1); if (from === k && i < at) at--;
    secs[k].ids.splice(clamp(at, 0, secs[k].ids.length), 0, id); this.settle(s);
  },
  /* one step earlier or later in the whole story, crossing into the next section at its edge */
  nudge(s, id, d) {
    const secs = this.manual(s), k = secs.findIndex(x => x.ids.includes(id)); if (k < 0) return; const i = secs[k].ids.indexOf(id);
    if (d < 0) { if (i > 0) this.move(s, id, k, i - 1); else if (k > 0) this.move(s, id, k - 1, secs[k - 1].ids.length); }
    else if (i < secs[k].ids.length - 1) this.move(s, id, k, i + 2); else if (k < secs.length - 1) this.move(s, id, k + 1, 0);
  },
  automatic(s) { s.sections = null; this.save(s, { sections: null }); },
  /* Take pictures out of the story. They stay in the library. dropText: a whole section was removed on purpose, so its words go with it.
     Otherwise a section emptied one picture at a time hands its text to its neighbour, as it does when pictures are moved out. */
  takeOut(s, ids, dropText) {
    const gone = new Set(ids), left = this.items(s).filter(i => !gone.has(i.id));
    if (!left.length) { toast('A story needs at least one picture. Delete the story to remove them all.'); return Promise.resolve(false); }
    const was = { ids: s.ids.slice(), covers: (s.covers || []).slice(), cover: s.cover, sections: s.sections && s.sections.map(x => ({ title: x.title, text: x.text, ids: x.ids.slice() })) };
    this.flush(); // anything typed a moment ago is saved first, so the two changes arrive in order
    s.ids = s.ids.filter(id => !gone.has(id)); s.covers = (s.covers || []).filter(id => !gone.has(id)); s.cover = s.covers[0] || null;
    const body = { remove: ids };
    if (s.sections) {
      s.sections.forEach(x => x.ids = x.ids.filter(id => !gone.has(id)));
      if (dropText) s.sections = s.sections.filter(x => x.ids.length);
      else for (let k = s.sections.length - 1; k >= 0; k--) { const x = s.sections[k]; if (x.ids.length || s.sections.length === 1) continue; const into = s.sections[k ? k - 1 : 1]; into.text = (k ? [into.text, x.text] : [x.text, into.text]).filter(t => t.trim()).join('\n\n'); s.sections.splice(k, 1); }
      body.sections = s.sections.map(x => ({ title: x.title, text: x.text, ids: x.ids }));
    }
    const n = fmt.plural(ids.length, 'picture');
    return api('PATCH', '/api/stories/' + s.id, body).then(() => {
      toast(`Removed ${n} from the story. ${ids.length === 1 ? 'It is' : 'They are'} still in your library.`, { label: 'Undo', fn: () => {
        Object.assign(s, was);
        api('PATCH', '/api/stories/' + s.id, { add: ids, covers: was.covers.length ? was.covers : undefined, ...(was.sections ? { sections: was.sections } : {}) }).then(() => { toast(`Put ${n} back in the story`); if (this.cur === s) this.repaint(); }, e => { toast(e.message); this.load().then(() => { if (this.cur) { this.cur = S.stories.find(x => x.id === s.id) || null; if (this.cur) this.repaint(); else this.close(); } }); });
      } });
      return true;
    }, e => { Object.assign(s, was); toast(e.message); return false; });
  },
  repaint() { const rd = $('#reader'), top = rd.scrollTop; this.paint(); rd.scrollTop = top; },
  /* where each section begins, for the player to announce */
  starts(s) { const m = new Map(); if (s.sections) this.parts(s).forEach(p => { if (p.title.trim()) m.set(p.items[0].id, p.title.trim()); }); return m; },
  play(from, paused) { const s = this.cur; this.flush(); Player.open(this.items(s), from || 0, this.starts(s), paused, s.music ? (S.share ? `/api/share/${S.share.token}/music?v=${S.cfg.musicVersion || 0}-${encodeURIComponent(s.music)}` : Music.url(s.music)) : null); },

  open(id) {
    const s = this.cur = S.stories.find(x => x.id === id); if (!s) return; this.mode = null;
    const rd = $('#reader'); rd.hidden = false; document.body.classList.add('modal-open'); this.paint(); rd.scrollTop = 0;
  },
  close() { this.flush(); $('#reader').hidden = true; document.body.classList.remove('modal-open'); this.cur = null; this.mode = null; if (this.io) this.io.disconnect(); if (S.view === 'stories') this.render(); },
  setMode(m) { this.mode = this.mode === m ? null : m; const top = $('#reader').scrollTop; this.paint(); $('#reader').scrollTop = this.mode === 'arrange' ? 0 : top; },
  paint() {
    const s = this.cur, rd = $('#reader'), items = this.items(s), edit = this.mine(s); rd.innerHTML = ''; rd.className = 'overlay reader' + (this.mode ? ' mode-' + this.mode : '');
    const x = el('button', { class: 'iconbtn modal-x', title: 'Close', 'aria-label': 'Close', html: icon('x'), onclick: () => this.close() });
    if (!items.length) { rd.append(el('div', { class: 'rd-bar' }, el('span', { class: 'rd-bar-t' }), x), el('p', { class: 'empty', text: 'The photos in this story are no longer in the library.' })); return; }
    if (this.io) this.io.disconnect();
    this.io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { const it = S.byId.get(e.target.dataset.id); if (it) loadInto(e.target, it, e.target.dataset.kind || 'display'); this.io.unobserve(e.target); } }), { root: rd, rootMargin: '700px' });
    const modeBtn = (m, ic, text, id) => el('button', { class: 'btn small' + (this.mode === m ? ' on' : ''), id, 'aria-pressed': this.mode === m, html: icon(ic, 16) + `<span>${this.mode === m ? 'Done' : text}</span>`, onclick: () => this.setMode(m) });
    const bar = el('div', { class: 'rd-bar' }, el('span', { class: 'rd-bar-t', text: s.title }),
      el('button', { class: 'btn small primary', id: 'rdPlay', html: icon('play', 16) + '<span>Play</span>', onclick: () => this.play(0) }),
      edit ? modeBtn('cover', 'grid', 'Choose cover', 'rdCover') : null, edit ? modeBtn('arrange', 'layers', 'Arrange', 'rdArrange') : null,
      edit ? el('button', { class: 'btn small' + (s.music ? ' on' : ''), id: 'rdMusic', html: icon('note', 16) + '<span>Music</span>', onclick: () => Music.open(s) }) : null,
      edit ? el('button', { class: 'btn small', id: 'rdReel', html: icon('film', 16) + '<span>Reel</span>', onclick: () => Reels.open(s) }) : null,
      S.share && S.share.can.add ? el('button', { class: 'btn small', id: 'rdAddMine', html: icon('plus', 16) + '<span>Add your photos</span>', onclick: () => Share.pick() }) : null,
      edit ? el('button', { class: 'btn small', id: 'rdShare', html: icon('people', 16) + '<span>Share</span>', onclick: () => this.share() }) : null,
      edit ? el('button', { class: 'iconbtn', title: 'Delete story', 'aria-label': 'Delete story', html: icon('trash'), onclick: e => popover(e.currentTarget, el('div', { class: 'confirm' }, el('p', { text: 'Delete this story? The photos stay in your library.' }), el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Keep', onclick: closePop }), el('button', { class: 'btn small danger', text: 'Delete', onclick: () => { closePop(); this._pend = null; clearTimeout(this._pt); attempt(api('DELETE', '/api/stories/' + s.id), 'Story deleted').then(() => { S.stories.splice(S.stories.indexOf(s), 1); this.close(); }); } })))) }) : null, x);
    rd.append(bar);
    if (this.mode === 'arrange') { rd.append(this.arrange(s)); return; }
    const cov = this.covers(s, items), cover = cov[0];
    const title = edit ? el('textarea', { class: 'rd-title', rows: 1, value: s.title, 'aria-label': 'Story title', maxlength: 200, oninput: e => { s.title = e.target.value.replace(/\n/g, ' '); autosize(e.target); $('.rd-bar-t').textContent = s.title; this.save(s, { title: s.title }); } }) : el('h1', { class: 'rd-title', text: s.title });
    const intro = edit ? el('textarea', { class: 'rd-intro', rows: 2, placeholder: 'Start the story in a sentence or two', value: s.intro, 'aria-label': 'Introduction', maxlength: 5000, oninput: e => { s.intro = e.target.value; autosize(e.target); this.save(s, { intro: s.intro }); } }) : (s.intro ? el('p', { class: 'rd-intro', text: s.intro }) : null);
    const head = el('header', { class: 'rd-head', style: { '--a': mix(cover.palette[0], '#16171a', .62), '--b': mix(cover.palette[1] || cover.palette[0], '#16171a', .8) } },
      el('div', { class: 'rd-head-t' }, title, el('p', { class: 'rd-meta', text: `${this.span(items)}. ${fmt.plural(items.length, 'item')}${this.places(items).length ? ' from ' + this.places(items).join(', ') : ''}.` }), this.groupsRow(s, edit), intro, this.route(items)),
      el('figure', { class: 'rd-cover', id: 'rdCoverBox' }));
    if (this.mode === 'cover') rd.append(el('div', { class: 'rd-hint', id: 'rdHint' }, el('span', { text: 'Click up to four pictures for the cover. They show in the order you click them. Click a chosen one again to take it off.' }), el('button', { class: 'btn small primary', text: 'Done', onclick: () => this.setMode('cover') })));
    const body = el('div', { class: 'rd-body' }), parts = this.parts(s);
    parts.forEach((part, pi) => {
      const scenes = {}; part.items.forEach(i => { if (i.ai.scene) scenes[i.ai.scene] = (scenes[i.ai.scene] || 0) + 1; }); const top = Object.entries(scenes).sort((a, b) => b[1] - a[1]).slice(0, 2).map(v => v[0].toLowerCase());
      const sec = el('section', { class: 'rd-ch' }), own = !part.auto && s.sections[part.k];
      /* a section made by hand has a heading its author can rewrite. An automatic part is headed by its date. */
      const h = own && edit ? el('textarea', { class: 'rd-sec-title', rows: 1, value: own.title, placeholder: 'Give this section a title', maxlength: 200, 'aria-label': 'Section title', oninput: e => { own.title = e.target.value.replace(/\n/g, ' '); autosize(e.target); this.settle(s); } })
        : (part.title.trim() ? el('h2', { text: part.title }) : null);
      sec.append(el('div', { class: 'rd-ch-h' }, parts.length > 1 ? el('span', { class: 'rd-num', text: `Part ${pi + 1}` }) : null, h,
        el('p', { class: 'muted', text: `${fmt.plural(part.items.length, 'item')}${part.auto && part.items.length > 1 && parts.length > 1 && !/\d{4}$/.test(part.label) ? ` between ${fmt.time(part.items[0].date)} and ${fmt.time(part.items[part.items.length - 1].date)}` : ''}${top.length ? ', mostly ' + top.join(' and ') : ''}` })));
      const write = v => { if (own) { own.text = v; this.settle(s); } else { s.notes[part.key] = v; this.save(s, { notes: { [part.key]: v } }); } };
      if (edit) {
        const ta = el('textarea', { class: 'rd-note', rows: 2, placeholder: 'What happened here?', value: part.text, maxlength: 8000, 'aria-label': 'Section text', oninput: e => { autosize(e.target); write(e.target.value); } });
        sec.append(ta);
        if (part.items.some(i => i.ai.caption)) sec.append(el('button', { class: 'linkbtn ai', html: icon('cpu', 14) + ' <span>Draft this part from what the worker saw</span>', onclick: () => { ta.value = this.draft(part); autosize(ta); write(ta.value); toast('Draft added. Rewrite it in your own words.'); } }));
      } else if (part.text) sec.append(el('p', { class: 'rd-note', text: part.text }));
      const rows = el('div', { class: 'rd-rows', data: { ch: pi } }); rows._items = part.items; sec.append(rows); body.append(sec);
    });
    rd.append(head, body, el('footer', { class: 'rd-foot' }, el('button', { class: 'btn', html: icon('play', 16) + '<span>Play this story</span>', onclick: () => this.play(0) }),
      S.share ? el('p', { class: 'rd-shared muted', text: 'A private story, shared with you through ImageStoria.' }) : null));
    this.paintCover($('#rdCoverBox'), cov, true); this.rows(); $$('textarea', rd).forEach(autosize);
  },
  rows() {
    const rd = $('#reader'); if (rd.hidden || this.mode === 'arrange') return; const s = this.cur, all = this.items(s), choosing = this.mode === 'cover', chosen = choosing ? this.covers(s, all).map(i => i.id) : [];
    $$('.rd-rows', rd).forEach(box => {
      const W = box.clientWidth, target = clamp(innerHeight * .56, 240, 560); box.innerHTML = '';
      Lib.justify(box._items, W, target, 10).forEach(row => {
        const r = el('div', { class: 'rd-row' });
        row.cells.forEach(c => {
          const it = c.it, im = el('img', { alt: label(it), data: { id: it.id }, draggable: false }), n = chosen.indexOf(it.id);
          r.append(el('figure', { style: { width: c.w + 'px' } }, el('button', { class: 'rd-ph' + (n >= 0 ? ' chosen' : ''), data: { id: it.id }, 'aria-pressed': choosing ? n >= 0 : null, style: { height: row.h + 'px', background: it.ghost }, onclick: () => choosing ? this.toggleCover(it) : S.share ? this.play(all.indexOf(it), true) : Viewer.open(it.id, all) }, im,
            /* a video shows its still, with a play mark and its length, and opens in the viewer like anything else */
            it.kind === 'video' ? el('span', { class: 'rd-play', html: icon('play', 15) + (it.duration ? `<span>${fmt.dur(it.duration)}</span>` : '') }) : null,
            n >= 0 ? el('span', { class: 'rd-pick', text: n + 1 }) : null), it.title ? el('figcaption', { text: it.title }) : null));
          this.io.observe(im);
        });
        box.append(r);
      });
    });
  },
  relayout() { const rd = $('#reader'); if (!rd.hidden && this.cur) { if (this.mode !== 'arrange' && $('#rdCoverBox')) this.paintCover($('#rdCoverBox'), this.covers(this.cur), true); this.rows(); } else if (S.view === 'stories') this.render(); },
  /* the order of clicks is the order shown */
  toggleCover(it) {
    const s = this.cur, now = this.covers(s).map(i => i.id), at = now.indexOf(it.id);
    if (at >= 0) { if (now.length === 1) return toast('A story needs a cover. Choose another picture first, then take this one off.'); now.splice(at, 1); }
    else if (now.length >= 4) return toast('A cover holds up to four pictures. Click one of the chosen ones to take it off first.');
    else now.push(it.id);
    s.covers = now; s.cover = now[0]; this.save(s, { covers: now });
    this.paintCover($('#rdCoverBox'), this.covers(s), true); this.rows();
  },

  /* ----- arranging: breaks between pictures, and the order of the pictures ----- */
  arrange(s) {
    const parts = this.parts(s), only = this.items(s).length < 2, box = el('div', { class: 'ar', id: 'rdArr' }), again = keep => { const top = $('#reader').scrollTop; this.paint(); $('#reader').scrollTop = top; if (keep) { const t = $(`.ar-it[data-id="${keep}"]`); if (t) t.focus({ preventScroll: true }); } };
    box.append(el('div', { class: 'ar-help' }, el('p', { text: s.sections ? 'This story is arranged by hand. Drag a picture to move it, into another section if you like. Click the line between two pictures to start a new section there. The small x on a picture takes it out of the story.' : 'This story arranges itself by date. The small x on a picture takes it out of the story, and that alone changes nothing else. Your first change here makes the parts below your own sections, with their headings and text, and from then on the order is yours. Drag a picture to move it. Click the line between two pictures to start a new section there.' }),
      el('div', { class: 'btnrow ar-acts' }, el('button', { class: 'btn small primary', id: 'arAdd', html: icon('plus', 15) + '<span>Add pictures</span>', onclick: () => StoryPicker.open({ story: s }) }),
      s.sections ? el('button', { class: 'btn small', id: 'arAuto', text: 'Back to automatic', onclick: e => popover(e.currentTarget, el('div', { class: 'confirm' }, el('p', { text: 'Arrange this story by date again? Your sections, their titles and their text are removed. What you wrote before arranging it by hand comes back.' }), el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Keep my sections', onclick: closePop }), el('button', { class: 'btn small danger', id: 'arAutoYes', text: 'Back to automatic', onclick: () => { closePop(); this.automatic(s); again(); } })))) }) : null)));
    parts.forEach((part, k) => {
      const list = el('div', { class: 'ar-items', data: { k } });
      part.items.forEach((it, i) => {
        if (i) list.append(el('button', { class: 'ar-cut', data: { k, at: i }, title: 'Start a new section here', 'aria-label': `Start a new section before ${label(it)}` }));
        const im = el('img', { alt: '', draggable: false, data: { id: it.id, kind: 'thumb' } });
        list.append(el('div', { class: 'ar-it', draggable: true, tabIndex: 0, role: 'button', data: { id: it.id, k, i }, 'aria-label': `${label(it)}. Hold Shift and press the left or right arrow to move it. Press Delete to remove it from the story.`, title: label(it), style: { width: Math.round(it.ar * 104) + 'px', background: it.ghost } }, im, it.kind === 'video' ? el('span', { class: 'rd-play', html: icon('play', 12) }) : null,
          only ? null : el('button', { class: 'ar-x', tabIndex: -1, data: { id: it.id }, title: 'Remove from the story', 'aria-label': `Remove ${label(it)} from the story`, html: icon('x', 13) })));
        this.io.observe(im);
      });
      box.append(el('section', { class: 'ar-sec', data: { k } }, el('div', { class: 'ar-h' }, el('span', { class: 'rd-num', text: `Section ${k + 1}` }),
        el('input', { class: 'inp ar-title', value: part.title, placeholder: 'Section title', maxlength: 200, 'aria-label': `Title of section ${k + 1}`, data: { k } }),
        el('span', { class: 'muted', text: fmt.plural(part.items.length, 'item') }),
        k ? el('button', { class: 'btn small ar-join', data: { k }, text: 'Join with the section before' }) : null,
        parts.length > 1 ? el('button', { class: 'btn small ar-drop', data: { k }, text: 'Remove section' }) : null), list));
    });
    box.addEventListener('click', e => {
      const cut = e.target.closest('.ar-cut'), jn = e.target.closest('.ar-join'), x = e.target.closest('.ar-x'), drop = e.target.closest('.ar-drop');
      if (cut) { this.split(s, +cut.dataset.k, +cut.dataset.at); again(); } else if (jn) { this.join(s, +jn.dataset.k); again(); }
      else if (x) { e.stopPropagation(); this.takeOut(s, [x.dataset.id]).then(ok => { if (ok) again(); }); }
      else if (drop) {
        /* a whole section: its pictures leave the story, and its title and text go with it */
        const part = parts[+drop.dataset.k], ids = part.items.map(i => i.id), words = part.auto ? (part.text.trim() ? ' Its text is deleted.' : '') : (part.title.trim() || part.text.trim() ? ' Its title and text are deleted.' : '');
        popover(drop, el('div', { class: 'confirm' }, el('p', { text: `Remove this section and its ${fmt.plural(ids.length, 'picture')} from the story? The pictures stay in your library.${words}` }),
          el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Keep', onclick: closePop }), el('button', { class: 'btn small danger', id: 'arDropYes', text: 'Remove section', onclick: () => { closePop(); this.takeOut(s, ids, true).then(ok => { if (ok) again(); }); } }))));
      }
    });
    box.addEventListener('input', e => { const t = e.target.closest('.ar-title'); if (!t) return; const was = !!s.sections; this.manual(s)[+t.dataset.k].title = t.value; this.settle(s); if (!was) { const k = t.dataset.k, at = t.selectionStart; again(); const n = $(`.ar-title[data-k="${k}"]`); if (n) { n.focus(); n.setSelectionRange(at, at); } } });
    box.addEventListener('keydown', e => {
      const t = e.target.closest('.ar-it'); if (!t) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); const nx = t.nextElementSibling && t.nextElementSibling.closest('.ar-it, .ar-cut'), keep = (nx && (nx.classList.contains('ar-it') ? nx : nx.nextElementSibling) || {}).dataset; this.takeOut(s, [t.dataset.id]).then(ok => { if (ok) again(keep && keep.id); }); return; }
      if (!e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return; e.preventDefault(); this.nudge(s, t.dataset.id, e.key === 'ArrowLeft' ? -1 : 1); again(t.dataset.id);
    });
    /* dragging: the amber line shows where the picture will land */
    const clear = () => $$('.drop-before, .drop-after, .drop-end', box).forEach(n => n.classList.remove('drop-before', 'drop-after', 'drop-end'));
    box.addEventListener('dragstart', e => { const t = e.target.closest('.ar-it'); if (!t) return; this._drag = t.dataset.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.dataset.id); t.classList.add('dragging'); });
    box.addEventListener('dragend', () => { this._drag = null; clear(); $$('.dragging', box).forEach(n => n.classList.remove('dragging')); });
    box.addEventListener('dragover', e => {
      if (!this._drag) return; const t = e.target.closest('.ar-it'), list = e.target.closest('.ar-items'); if (!t && !list) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move'; clear();
      if (t) { const r = t.getBoundingClientRect(); t.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after'); } else list.classList.add('drop-end');
    });
    box.addEventListener('drop', e => {
      const id = this._drag; if (!id) return; const t = e.target.closest('.ar-it'), list = e.target.closest('.ar-items'); if (!t && !list) return; e.preventDefault(); this._drag = null;
      if (t) { const r = t.getBoundingClientRect(); this.move(s, id, +t.dataset.k, +t.dataset.i + (e.clientX < r.left + r.width / 2 ? 0 : 1)); } else this.move(s, id, +list.dataset.k, 1e9);
      again(id);
    });
    return box;
  },

  route(items) {
    const pts = []; let last = null;
    for (const it of items) { if (!it.place || it.place === last || !PLACES[it.place]) continue; last = it.place; pts.push(PLACES[it.place]); }
    if (pts.length < 2) return null;
    const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length, k = Math.cos(lat0 * Math.PI / 180);
    const xs = pts.map(p => p.lng * k), ys = pts.map(p => -p.lat), minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
    const W = 300, H = 150, pad = 26, sc = Math.min((W - pad * 2) / Math.max(.0001, maxx - minx), (H - pad * 2) / Math.max(.0001, maxy - miny));
    const P = pts.map((p, i) => [pad + (xs[i] - minx) * sc + ((W - pad * 2) - (maxx - minx) * sc) / 2, pad + (ys[i] - miny) * sc + ((H - pad * 2) - (maxy - miny) * sc) / 2]);
    const seen = new Set(); let labels = '';
    P.forEach((p, i) => { if (seen.has(pts[i].name)) return; seen.add(pts[i].name); labels += `<circle cx="${p[0]}" cy="${p[1]}" r="4"/><text x="${p[0] + 7}" y="${p[1] - 8}">${esc(pts[i].name)}</text>`; });
    return el('div', { class: 'rd-route', html: `<svg viewBox="0 0 ${W + 90} ${H}" role="img" aria-label="Route: ${esc([...seen].join(', '))}"><polyline points="${P.map(p => p.join(',')).join(' ')}"/>${labels}</svg>` });
  },
  /* a story's groups: chips to read, and for its editors a field to add one */
  groupsRow(s, edit) {
    const gs = s.groups || (s.groups = []); if (!edit && !gs.length) return null;
    const row = el('div', { class: 'fvals wrap rd-groups', id: 'rdGroups' });
    const paint = () => {
      row.innerHTML = '';
      gs.forEach(g => row.append(el('span', { class: 'chip on' }, el('span', { text: g }), edit ? el('button', { class: 'chip-x', 'aria-label': 'Take out of the group ' + g, html: icon('x', 12), onclick: () => { gs.splice(gs.indexOf(g), 1); this.save(s, { groups: gs.slice() }); paint(); } }) : null)));
      if (!edit) return;
      const inp = el('input', { class: 'inp taginp rd-ginp', placeholder: gs.length ? 'Another group' : 'Add to a group, such as Sunsets', list: 'groupList', maxlength: 40, 'aria-label': 'Add this story to a group' });
      /* a group that exists keeps its spelling: typing "sunsets" files the story under "Sunsets" */
      const add = () => { let v = inp.value.trim().replace(/\s+/g, ' '); if (!v) return; const known = this.allGroups().find(g => g[0].toLowerCase() === v.toLowerCase()); if (known) v = known[0]; if (!gs.some(g => g.toLowerCase() === v.toLowerCase())) { gs.push(v); this.save(s, { groups: gs.slice() }); } paint(); $('.rd-ginp', row).focus(); };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } e.stopPropagation(); }); inp.addEventListener('change', add);
      row.append(inp, el('datalist', { id: 'groupList' }, this.allGroups().filter(g => !gs.includes(g[0])).map(g => el('option', { value: g[0] }))));
    };
    paint(); return row;
  },
  /* Who can read this story. Owners and editors of the space always can. Everyone else is chosen here, one by one. */
  share() {
    const s = this.cur; if (!s || !this.mine(s)) return; this.flush();
    const people = el('div', { class: 'sharelist', id: 'shPeople' }, el('p', { class: 'muted', text: 'Loading' })), links = el('div', { id: 'shLinks' });
    const sheet = el('div', { class: 'overlay sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Share this story', onclick: e => { if (e.target === sheet) sheet.remove(); } },
      el('div', { class: 'sheet-box sh-box' },
        el('header', {}, el('h2', { text: 'Share this story' }), el('button', { class: 'iconbtn modal-x', id: 'shClose', title: 'Close', 'aria-label': 'Close', html: icon('x'), onclick: () => sheet.remove() })),
        el('section', { class: 'sh-sec' }, el('h3', { text: 'People' }), el('p', { class: 'vi-note', text: 'Owners and editors of this space can always read and change it. Tick anyone else who should be able to read it.' }), people),
        links));
    document.body.append(sheet);
    api('GET', `/api/stories/${s.id}/access`).then(r => {
      people.innerHTML = '';
      const rows = r.people.slice().sort((a, b) => (b.always - a.always) || a.name.localeCompare(b.name));
      rows.forEach(u => {
        const cb = el('input', { type: 'checkbox', checked: u.always || u.shared, disabled: u.always || !u.inSpace, 'aria-label': u.name, onchange: e => { const at = s.shared.indexOf(u.id); if (e.target.checked && at < 0) s.shared.push(u.id); if (!e.target.checked && at >= 0) s.shared.splice(at, 1); attempt(api('PATCH', '/api/stories/' + s.id, { shared: s.shared }), e.target.checked ? `${u.name} can now read this story` : `${u.name} can no longer read this story`).catch(() => { e.target.checked = !e.target.checked; }); } });
        const why = u.always ? (u.role === 'owner' ? 'owner, always' : 'editor, always') : !u.inSpace ? 'cannot open this space' : u.pending ? 'invited, has not joined yet' : u.role;
        people.append(el('label', { class: 'sharerow', data: { id: u.id } }, cb, avatarEl(u), el('span', {}, u.name, el('small', { class: 'muted', text: ' ' + why }))));
      });
      if (!rows.some(u => !u.always)) people.append(el('p', { class: 'vi-note', text: 'There is nobody else yet. Invite a viewer or commenter in People and settings.' }));
    }, e => { people.innerHTML = ''; people.append(el('p', { class: 'vi-note', text: e.message })); });
    if (typeof ShareLinks !== 'undefined') ShareLinks.mount(links, s);
  }
};

/* ---------- player: the story full screen, one item at a time ----------
   A photo stays for a few seconds. A video plays from start to end, and its piece of the progress bar lasts as long as it does. */
const Player = {
  items: [], i: 0, playing: true, timer: 0, DUR: 4600, starts: null, raf: 0, secTimer: 0,
  /* paused: opened to look at one picture, so it does not move on by itself */
  open(items, i, starts, paused, music) {
    if (!items.length) return; this.items = items; this.i = i; this.starts = starts || new Map(); this.playing = !paused; $('#player').hidden = false;
    this.startMusic(music);
    const dl = $('#plDown'); dl.hidden = !(S.share ? S.share.can.download : can('download')); dl.onclick = () => Img.download(this.items[this.i]);
    this.show();
  },
  close() { clearTimeout(this.timer); clearTimeout(this.secTimer); this.stopVideo(); this.stopMusic(); $('#player').hidden = true; },
  /* ----- music under the slideshow. It dips while a video with sound plays, and comes back after. ----- */
  LOUD: 0.55, SOFT: 0.1,
  startMusic(url) {
    const a = $('#plAudio'), b = $('#plMusic'); this.music = url || null; b.hidden = !url; if (!url) return this.stopMusic();
    this.musicOff = store.get('musicOff', '0') === '1'; this.paintMusic();
    if (a.getAttribute('src') !== url) a.src = url;
    a.volume = this.LOUD;
    /* iPhones and iPads do not let a page set the volume of sound. There the music cannot dip, so it stops for a video with sound and starts again after it. */
    this.fixedVol = Math.abs(a.volume - this.LOUD) > 0.01;
    a.muted = this.musicOff; b.onclick = () => { this.musicOff = !this.musicOff; store.set('musicOff', this.musicOff ? '1' : '0'); a.muted = this.musicOff; this.paintMusic(); if (!this.musicOff && this.playing) a.play().catch(() => { }); };
    if (this.playing) a.play().catch(() => { /* the browser wants a click first: the music starts with the next one */ });
  },
  paintMusic() { const b = $('#plMusic'), t = this.musicOff ? 'Music on' : 'Music off'; b.classList.toggle('off', this.musicOff); b.title = t; b.setAttribute('aria-label', t); },
  stopMusic() { const a = $('#plAudio'); clearInterval(this._fade); a.pause(); if (a.hasAttribute('src')) { a.removeAttribute('src'); a.load(); } this.music = null; },
  /* glide the music to a level, so it never jumps */
  musicTo(level) {
    const a = $('#plAudio'); clearInterval(this._fade); if (!this.music) return; this._level = level;
    this._fade = setInterval(() => { const d = level - a.volume; if (Math.abs(d) < 0.02) { a.volume = level; return clearInterval(this._fade); } a.volume = clamp(a.volume + Math.sign(d) * 0.035, 0, 1); }, 30);
  },
  /* dip when the thing on screen is a video that is playing with its sound on */
  duck() {
    const v = $('#plVideo'), a = $('#plAudio'), it = this.items[this.i], talking = this.isVideo(it) && !v.hidden && !v.paused && !v.muted && v.volume > 0;
    if (!this.music) return;
    if (this.fixedVol) { if (talking) a.pause(); else this.resumeMusic(); return; }
    this.musicTo(talking ? this.SOFT : this.LOUD);
    /* a phone may stop the music by itself when a video starts to sound. Once the video is not talking any more, it comes back. */
    if (!talking) this.resumeMusic();
  },
  resumeMusic() { const a = $('#plAudio'); if (this.music && this.playing && !this.musicOff && a.paused && !$('#player').hidden) a.play().catch(() => { }); },
  isVideo(it) { return !!it && it.kind === 'video' && it.status === 'ready'; },
  stopVideo() {
    const v = $('#plVideo'); cancelAnimationFrame(this.raf); v.onended = v.onerror = v.onplaying = v.onpause = v.onvolumechange = null; v.pause(); v.hidden = true; this._forced = false; $('#plUnmute').hidden = true;
    if (v.hasAttribute('src')) { v.removeAttribute('src'); v.load(); }
  },
  startVideo(it) { const v = $('#plVideo'); playWithSound(v, () => this.items[this.i] === it && !$('#player').hidden && this.playing, forced => { this._forced = forced; $('#plUnmute').hidden = !forced; }); },
  /* This runs inside a tap, which is the one moment a phone lets sound start. So the music is started here too, even if it is about to
     step aside for the video: after that the phone lets it start again by itself when the video ends. */
  unmute() {
    const v = $('#plVideo'), a = $('#plAudio'); this._forced = false; v.muted = false; if (v.volume === 0) v.volume = 1; $('#plUnmute').hidden = true;
    if (this.music && !this.musicOff && a.paused) { const p = a.play(); if (p && p.then) p.then(() => this.duck(), () => { }); } else this.duck();
  },
  /* a video's piece of the bar follows the video itself, so pausing or waiting for data never puts it out of step */
  tick() {
    const v = $('#plVideo'), it = this.items[this.i], seg = $('#plBar i.now'); if (!seg || $('#player').hidden || !this.isVideo(it)) return;
    const total = isFinite(v.duration) && v.duration > 0 ? v.duration : (it.duration || 0);
    seg.style.setProperty('--p', total ? clamp(v.currentTime / total, 0, 1) : 0);
    this.raf = requestAnimationFrame(() => this.tick());
  },
  paintCtl() { $('#plPlay').innerHTML = icon(this.playing ? 'pause' : 'play'); $('#plPlay').setAttribute('aria-label', this.playing ? 'Pause' : 'Play'); },
  next() { if (this.i < this.items.length - 1) { this.i++; this.show(); } else { this.playing = false; if (this.isVideo(this.items[this.i])) this.paintCtl(); else this.show(); } },
  show() {
    clearTimeout(this.timer); this.stopVideo();
    const it = this.items[this.i], p = $('#player'), img = $('#plImg'), v = $('#plVideo'), vid = this.isVideo(it);
    p.style.setProperty('--a', mix(it.palette[0], '#0c0d0f', .72)); p.style.setProperty('--b', mix(it.palette[1] || it.palette[0], '#0c0d0f', .86));
    /* behind the picture: the picture itself, enlarged and blurred. The small copy is plenty for a blur. */
    $('#plBg').style.backgroundImage = `url("${Img.url(it, 'thumb')}")`;
    img.hidden = vid; img.classList.remove('in');
    if (vid) { v.hidden = false; v.style.aspectRatio = it.ar; v.style.height = `min(96vh, ${96 / it.ar}vw)`; v.poster = Img.url(it, 'display'); v.src = Img.media(it); }
    else { loadInto(img, it, 'display'); img.alt = label(it); }
    $('#plCap').textContent = it.title || it.ai.caption || ''; $('#plCap').hidden = !$('#plCap').textContent; const pl = it.place && PLACES[it.place];
    $('#plMeta').textContent = fmt.day(it.date) + (pl ? ', ' + pl.name : '');
    const bar = $('#plBar'); bar.innerHTML = ''; this.items.forEach((x, k) => bar.append(el('i', { class: k < this.i ? 'done' : k === this.i ? 'now' + (vid ? ' vid' : this.playing ? ' run' : '') : '' })));
    bar.style.setProperty('--dur', this.DUR + 'ms');
    this.paintCtl();
    const nx = this.items[this.i + 1]; if (nx) new Image().src = Img.url(nx, 'display');
    /* the title of a section, shown for a moment as the section begins */
    const st = $('#plSection'), title = this.starts.get(it.id); clearTimeout(this.secTimer); st.textContent = title || ''; st.classList.toggle('show', !!title);
    if (title) this.secTimer = setTimeout(() => st.classList.remove('show'), 2600);
    if (vid) {
      v.onplaying = v.onpause = v.onvolumechange = () => this.duck();
      v.onended = () => this.next();
      /* a file this browser cannot play is shown as its still, for as long as a photo */
      v.onerror = () => { if (this.items[this.i] === it && this.playing) this.timer = setTimeout(() => this.next(), this.DUR); };
      if (this.playing) this.startVideo(it); this.tick();
    } else if (this.playing) this.timer = setTimeout(() => this.next(), this.DUR);
    this.duck();
  },
  step(d) { const n = this.i + d; if (n < 0 || n >= this.items.length) return; this.i = n; this.show(); },
  toggle() {
    const it = this.items[this.i];
    if (this.isVideo(it)) {
      /* pause pauses the video where it is, and play carries on from there */
      const v = $('#plVideo'); this.playing = !this.playing;
      const au = $('#plAudio'); if (this.music) { if (this.playing) au.play().catch(() => { }); else au.pause(); }
      if (!this.playing) v.pause(); else { if (v.ended) { if (this.i === this.items.length - 1) { this.i = 0; return this.show(); } return this.next(); } this.startVideo(it); }
      return this.paintCtl();
    }
    this.playing = !this.playing; if (this.playing && this.i === this.items.length - 1) this.i = 0;
    if (this.music) { if (this.playing) $('#plAudio').play().catch(() => { }); else $('#plAudio').pause(); }
    this.show();
  }
};

/* ---------- music: choosing what plays under a story ----------
   Ten pieces come with the app, made by the server itself, from still to driving. You can add tracks of your own. */
const Music = {
  list: null, sheet: null, audio: null, playing: null,
  /* the version makes a browser fetch a piece again when the built-in music has been rewritten */
  url(ref) { return `/api/music/${encodeURIComponent(ref)}/file?v=${(S.cfg && S.cfg.musicVersion) || 0}`; },
  load() { return api('GET', '/api/music').then(r => { this.list = r; return r; }); },
  name(ref) { if (!ref || !this.list) return ''; const t = [...this.list.builtin, ...this.list.mine].find(x => x.id === ref); return t ? t.name : ''; },
  stop() { if (this.audio) { this.audio.pause(); this.audio = null; } this.playing = null; if (this.sheet) $$('.mu-play', this.sheet).forEach(b => { b.innerHTML = icon('play', 15); b.setAttribute('aria-label', 'Listen'); }); },
  listen(t, btn) {
    const same = this.playing === t.id; this.stop(); if (same) return;
    /* a built-in piece is made the first time it is wanted, which takes a few seconds */
    btn.innerHTML = icon('pause', 15); btn.setAttribute('aria-label', 'Stop'); this.playing = t.id;
    const a = this.audio = new Audio(this.url(t.id)); a.volume = 0.8; a.onended = () => this.stop(); a.onerror = () => { if (this.playing === t.id) { this.stop(); toast('That track could not be played.'); } };
    a.play().catch(() => { });
  },
  open(s) {
    this.close();
    const body = el('div', { class: 'mu-list', id: 'muList' }, el('p', { class: 'muted', text: 'Loading' }));
    const sheet = this.sheet = el('div', { class: 'overlay sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Music for this story', onclick: e => { if (e.target === sheet) this.close(); } },
      el('div', { class: 'sheet-box mu-box' },
        el('header', {}, el('h2', { text: 'Music for this story' }), el('button', { class: 'iconbtn modal-x', id: 'muClose', title: 'Close', 'aria-label': 'Close', html: icon('x'), onclick: () => this.close() })),
        el('p', { class: 'vi-note', text: 'It plays under the slideshow and in reels, and dips while a video with sound is playing.' }), body));
    sheet._close = () => this.close(); document.body.append(sheet);
    this.load().then(() => this.paint(s), e => { body.innerHTML = ''; body.append(el('p', { class: 'vi-note', text: e.message })); });
  },
  close() { this.stop(); if (this.sheet) { this.sheet.remove(); this.sheet = null; } },
  paint(s) {
    const body = $('#muList'); if (!body) return; body.innerHTML = '';
    const choose = ref => { s.music = ref; Stories.save(s, { music: ref }); const b = $('#rdMusic'); if (b) b.classList.toggle('on', !!ref); this.paint(s); toast(ref ? `This story now plays “${this.name(ref)}”` : 'This story now plays no music'); };
    const row = (t, extra) => el('div', { class: 'mu' + (s.music === t.id ? ' on' : ''), data: { id: t.id || '' } },
      el('input', { type: 'radio', name: 'muPick', checked: (s.music || '') === (t.id || ''), 'aria-label': t.name, onchange: () => choose(t.id || null) }),
      t.id ? el('button', { class: 'iconbtn mu-play', 'aria-label': 'Listen', html: icon(this.playing === t.id ? 'pause' : 'play', 15), onclick: e => this.listen(t, e.currentTarget) }) : el('span'),
      el('div', { class: 'mu-t' }, el('b', { text: t.name }), el('small', { class: 'muted', text: [t.mood, t.seconds ? fmt.dur(t.seconds) : ''].filter(Boolean).join(', ') })),
      t.energy ? el('span', { class: 'mu-e', title: `Energy ${t.energy} of 5`, 'aria-label': `Energy ${t.energy} of 5` }, [1, 2, 3, 4, 5].map(k => el('i', { class: k <= t.energy ? 'on' : '' }))) : el('span'), extra || el('span'));
    body.append(row({ id: null, name: 'No music', mood: 'Only the sound of the videos' }));
    body.append(el('h3', { text: 'Made by this app' })); this.list.builtin.forEach(t => body.append(row(t)));
    body.append(el('h3', { text: 'Yours' }));
    if (!this.list.mine.length) body.append(el('p', { class: 'muted mu-none', text: 'Nothing added yet.' }));
    this.list.mine.forEach(t => body.append(row({ ...t, mood: '' }, (can('admin') || t.by === S.me.id) ? el('button', { class: 'iconbtn', title: 'Remove this track', 'aria-label': `Remove ${t.name}`, html: icon('trash', 15), onclick: e => popover(e.currentTarget, el('div', { class: 'confirm' }, el('p', { text: `Remove “${t.name}”? Stories that use it will play no music.` }), el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Keep', onclick: closePop }), el('button', { class: 'btn small danger', text: 'Remove', onclick: () => { closePop(); this.stop(); attempt(api('DELETE', '/api/music/' + t.id), 'Track removed').then(() => { S.stories.forEach(x => { if (x.music === t.id) x.music = null; }); return this.load(); }).then(() => this.paint(s), () => { }); } })))) }) : null)));
    const inp = el('input', { type: 'file', id: 'muFile', accept: 'audio/*,.mp3,.m4a,.wav,.ogg,.flac', hidden: true, onchange: () => { const f = inp.files[0]; if (!f) return; const fd = new FormData(); fd.set('file', f, f.name); toast(`Adding ${f.name}`); fetch('/api/music', { method: 'POST', headers: { 'x-afterimage': '1' }, body: fd, credentials: 'same-origin' }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'That file could not be added.'); return this.load(); }).then(() => { this.paint(s); toast('Track added'); }, e => toast(e.message)); } });
    body.append(inp, el('div', { class: 'btnrow' }, el('button', { class: 'btn', id: 'muAdd', html: icon('up', 16) + '<span>Add a track of your own</span>', onclick: () => inp.click() }), el('span', { class: 'muted', text: `MP3, M4A, WAV, OGG or FLAC, up to ${this.list.maxMb} MB.` })));
  }
};

/* ---------- reels: a story made into one video file, tall or wide ----------
   The server makes it in the background. Every picture and video is shown whole, over a blurred copy of itself. */
const Reels = {
  sheet: null, story: null, items: [], covers: [], list: [], made: [], space: null, timer: 0, format: '9:16', info: null,
  /* the little outline that stands for a tall or a wide reel, never larger than max on its long side */
  shape(format, max) { const tall = format === '9:16'; return el('i', { class: 're-shape small', style: tall ? { height: max + 'px', width: Math.round(max * 9 / 16) + 'px' } : { width: max + 'px', height: Math.round(max * 9 / 16) + 'px' } }); },
  /* For a story: Reels.open(story). For pictures chosen in the library: Reels.open(null, items). */
  open(s, items) {
    this.close(); this.story = s; this.items = s ? Stories.items(s) : items.filter(i => i.status === 'ready').sort((a, b) => a.date - b.date); this.covers = []; this.made = []; this.list = [];
    this.space = (this.items[0] && this.items[0].space) || S.space;
    this.format = store.get('reelFormat', '9:16') === '16:9' ? '16:9' : '9:16';
    if (!this.items.length) return toast('Nothing in the selection is ready to go in a reel yet.');
    const body = el('div', { id: 'reBody' }, el('p', { class: 'muted', text: 'Loading' }));
    const sheet = this.sheet = el('div', { class: 'overlay sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Make a reel', onclick: e => { if (e.target === sheet) this.close(); } },
      el('div', { class: 'sheet-box re-box' }, el('header', {}, el('h2', { text: s ? 'Make a reel of this story' : `Make a reel from ${fmt.plural(this.items.length, 'item')}` }), el('button', { class: 'iconbtn modal-x', id: 'reClose', title: 'Close', 'aria-label': 'Close', html: icon('x'), onclick: () => this.close() })), body));
    sheet._close = () => this.close(); document.body.append(sheet);
    const from = s ? `/api/stories/${s.id}/reels` : `/api/reels?space=${this.items[0].space}`;
    Promise.all([api('GET', from), Music.list ? Promise.resolve() : Music.load()]).then(([r]) => { if (!this.sheet) return; this.info = r; this.list = s ? r.reels : []; this.paint(); this.watch(); }, e => { body.innerHTML = ''; body.append(el('p', { class: 'vi-note', text: e.message })); });
  },
  close() {
    clearTimeout(this.timer);
    /* closing does not stop a reel that is being made. It is watched from the page, which says when it is ready. */
    if (this.sheet) { const going = this.list.filter(r => r.status === 'queued' || r.status === 'running').map(r => r.id); if (going.length) ReelWatch.add(this.space, going); }
    if (this.sheet) { $$('video', this.sheet).forEach(v => v.pause()); this.sheet.remove(); } this.sheet = this.story = null; this.items = []; this.list = [];
  },
  /* the reels this sheet is about: all of a story's, or the ones made here from the library selection */
  fetchList() { return this.story ? api('GET', `/api/stories/${this.story.id}/reels`).then(r => r.reels) : api('GET', '/api/reels?space=' + this.space).then(r => this.made.map(id => r.reels.find(x => x.id === id)).filter(Boolean)); },
  /* while one is being made, ask how far along it is */
  watch() {
    clearTimeout(this.timer); const sheet = this.sheet; if (!sheet || !this.list.some(r => r.status === 'queued' || r.status === 'running')) return;
    this.timer = setTimeout(() => { if (this.sheet !== sheet) return; this.fetchList().then(list => { if (this.sheet !== sheet) return; const was = JSON.stringify(this.list.map(x => [x.id, x.status])); this.list = list; if (was !== JSON.stringify(list.map(x => [x.id, x.status]))) this.paintList(); else this.paintProgress(this.list); this.watch(); }, () => this.watch()); }, 1500);
  },
  length(seconds) {
    const cap = this.info.videoMaxSeconds; let t = Math.max(seconds, 2.5);   // the card at the start
    for (const it of this.items) t += it.kind === 'video' ? Math.min(it.duration || seconds, cap) : seconds;
    return t;
  },
  /* the pictures of a library reel, each shown whole. Tapping one puts it on the card, up to four, in the order tapped. */
  paintCovers() {
    const box = $('#reCovers'); if (!box) return; box.innerHTML = '';
    this.items.forEach(it => {
      const at = this.covers.indexOf(it.id), im = el('img', { alt: label(it), draggable: false, width: Math.round(it.ar * 76), height: 76, style: { background: it.ghost } }); loadInto(im, it, 'thumb');
      box.append(el('button', { class: 're-cv' + (at >= 0 ? ' on' : ''), data: { id: it.id }, 'aria-pressed': String(at >= 0), title: at >= 0 ? 'Take off the card' : 'Put on the card', onclick: () => {
        if (at >= 0) this.covers.splice(at, 1); else if (this.covers.length >= 4) return toast('The card holds up to four pictures. Take one off first.'); else this.covers.push(it.id);
        this.paintCovers();
      } }, im, at >= 0 ? el('b', { text: at + 1 }) : null));
    });
    const n = $('#reCoverNote'); if (n) n.textContent = this.covers.length ? `${fmt.plural(this.covers.length, 'picture')} on the card.` : 'None chosen, so the card shows the first picture.';
  },
  paint() {
    const body = $('#reBody'), s = this.story, items = this.items; if (!body) return; body.innerHTML = '';
    const secs = el('input', { type: 'range', class: 'sl', id: 'reSecs', min: 2, max: 8, step: 0.5, value: +store.get('reelSecs', '3.5') || 3.5, 'aria-label': 'Seconds each photo stays' }), secOut = el('output'), total = el('p', { class: 'vi-note', id: 'reTotal' });
    const pre = s ? s.music : null;
    const music = el('select', { class: 'inp', id: 'reMusic', 'aria-label': 'Music' }, el('option', { value: '', text: 'No music' }), el('optgroup', { label: 'Made by this app' }, Music.list.builtin.map(t => el('option', { value: t.id, text: `${t.name} (${'●'.repeat(t.energy)}${'○'.repeat(5 - t.energy)})`, selected: pre === t.id }))), Music.list.mine.length ? el('optgroup', { label: 'Yours' }, Music.list.mine.map(t => el('option', { value: t.id, text: t.name, selected: pre === t.id }))) : null);
    const fmtBtn = (f, name, note) => el('button', { class: 're-fmt' + (this.format === f ? ' on' : ''), data: { f }, 'aria-pressed': this.format === f, onclick: () => { this.format = f; store.set('reelFormat', f); $$('.re-fmt', body).forEach(b => { b.classList.toggle('on', b.dataset.f === f); b.setAttribute('aria-pressed', b.dataset.f === f); }); } },
      el('i', { class: 're-shape', style: { aspectRatio: f.replace(':', ' / ') } }), el('b', { text: name }), el('small', { class: 'muted', text: note }));
    const sum = () => { secOut.textContent = `${(+secs.value).toFixed(1)} s`; const t = this.length(+secs.value), n = items.filter(i => i.kind === 'video').length; total.textContent = `About ${fmt.dur(t)} long: ${fmt.plural(items.length - n, 'photo')}${n ? ` and ${fmt.plural(n, 'video')}` : ''}.${n ? ` A video plays for up to ${this.info.videoMaxSeconds} seconds.` : ''}${items.length > this.info.maxItems ? ` That is more than the ${this.info.maxItems} items a reel can hold.` : ''}`; };
    secs.addEventListener('input', () => { store.set('reelSecs', secs.value); sum(); });
    const title = el('input', { class: 'inp', id: 'reTitle', maxlength: 120, placeholder: 'A title for the card (optional)', 'aria-label': 'Title of the reel' });
    const ask = () => s ? api('POST', `/api/stories/${s.id}/reels`, { format: this.format, music: music.value || null, secondsPerPhoto: +secs.value })
      : api('POST', '/api/reels', { ids: items.map(i => i.id), covers: this.covers, title: title.value.trim(), format: this.format, music: music.value || null, secondsPerPhoto: +secs.value });
    const go = el('button', { class: 'btn primary', id: 'reGo', disabled: items.length > this.info.maxItems, html: icon('film', 16) + '<span>Make the reel</span>', onclick: () => {
      go.disabled = true;
      /* the sheet stays open: the reel appears in the list below with how far along it is, and plays there when it is ready */
      attempt(ask(), 'Making your reel.').then(r => { if (!s) this.made.unshift(r.id); this.list.unshift(r); this.paintList(); this.watch(); go.disabled = false; const l = $('#reList'); if (l && l.scrollIntoView) l.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, () => { go.disabled = false; });
    } });
    body.append(el('p', { class: 'vi-note', text: s ? 'One video file of the whole story, in its order. It opens on the story card. Every picture and video is shown whole, over a blurred copy of itself, so nothing is cropped. The music dips while a video with sound plays.'
      : 'One video file of these pictures, oldest first. It opens on a card with the pictures you choose below. Every picture and video is shown whole, over a blurred copy of itself, so nothing is cropped. The music dips while a video with sound plays.' }));
    if (!s) body.append(el('label', { class: 're-title' }, 'Title', title), el('div', { class: 're-cvs-h' }, el('b', { text: 'Pictures for the card, up to four' }), el('small', { class: 'muted', id: 'reCoverNote' })), el('div', { class: 're-cvs', id: 'reCovers' }));
    body.append(el('div', { class: 're-fmts' }, fmtBtn('9:16', 'Tall, 9:16', 'For phones and reels'), fmtBtn('16:9', 'Wide, 16:9', 'For screens and TVs')),
      el('div', { class: 're-opts' }, el('label', {}, 'Music', music), el('label', { class: 'slrow re-secs' }, el('span', { text: 'Each photo stays' }), secOut, secs)), total, el('div', { class: 'rowr' }, go));
    body.append(el('h3', { class: 're-h', text: s ? 'Reels of this story' : 'Reels made from these pictures' }), el('div', { class: 're-list', id: 'reList' }),
      el('p', { class: 'vi-note', id: 'reAfter', text: 'You can close this while a reel is being made. A notice appears on the page when it is ready, and every reel is kept on the Reels page.' }));
    sum(); this.paintList(); if (!s) this.paintCovers();
  },
  status(r) { return r.status === 'ready' ? `${fmt.dur(r.seconds || 0)}, ${fmt.bytes(r.bytes)}, made ${fmt.ago(r.made)}` : r.status === 'failed' ? `Could not be made. ${r.error || ''}` : r.status === 'queued' ? 'Waiting to start' : `Being made, ${Math.round(r.progress * 100)}%`; },
  paintProgress(list) { list.forEach(r => { const n = $(`.re[data-id="${r.id}"] .re-st, .rc[data-id="${r.id}"] .re-st`); if (n && (r.status === 'queued' || r.status === 'running')) n.textContent = this.status(r); }); },
  /* One reel as a row: what it is, how it stands, and play, download, delete. Used in the story's sheet and on the Reels page.
     o.lead: what stands at the left. o.name and o.note: its two lines. o.gone: called after it is deleted. */
  row(r, box, o) {
    const ready = r.status === 'ready', failed = r.status === 'failed', url = `/api/reels/${r.id}/file`;
    const row = el('div', { class: 're' + (failed ? ' err' : '') + (o.big ? ' big' : ''), data: { id: r.id, status: r.status } },
      o.lead, el('div', { class: 're-t' }, el('b', { text: o.name }), o.note ? el('small', { class: 'muted', text: o.note }) : null, el('small', { class: 're-st muted', text: this.status(r) })),
      ready ? el('button', { class: 'btn small', 'aria-label': 'Play this reel', html: icon('play', 14) + '<span>Play</span>', onclick: () => { const open = $('.re-video', row); $$('.re-video', box).forEach(v => { v.pause(); v.remove(); }); if (open) return; const v = el('video', { class: 're-video', controls: true, playsinline: true, src: url, style: { aspectRatio: r.format.replace(':', ' / ') } }); row.append(v); v.play().catch(() => { }); } }) : el('span'),
      ready && can('download') ? el('a', { class: 'btn small', href: url + '?download=1', download: '', 'aria-label': 'Download this reel', html: icon('down', 14) + '<span>Download</span>' }) : el('span'),
      o.mayDelete === false ? el('span') : el('button', { class: 'iconbtn', title: 'Delete this reel', 'aria-label': 'Delete this reel', html: icon('trash', 15), onclick: e => popover(e.currentTarget, el('div', { class: 'confirm' }, el('p', { text: 'Delete this reel? The pictures it was made from are not touched.' }), el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Keep', onclick: closePop }), el('button', { class: 'btn small danger', text: 'Delete reel', onclick: () => { closePop(); attempt(api('DELETE', '/api/reels/' + r.id), 'Reel deleted').then(o.gone, () => { }); } })))) }));
    box.append(row); return row;
  },
  kind(r) { return `${r.format === '9:16' ? 'Tall' : 'Wide'}, ${r.format}${r.music ? `, ${Music.name(r.music) || 'music'}` : ', no music'}`; },
  paintList() {
    const box = $('#reList'); if (!box) return; box.innerHTML = '';
    if (!this.list.length) return box.append(el('p', { class: 'muted', text: this.story ? 'None yet.' : 'None yet. Choose the card and the shape above, then Make the reel. You can make more than one.' }));
    this.list.forEach(r => this.row(r, box, { lead: this.shape(r.format, 30), name: this.story ? this.kind(r) : (r.title || 'Untitled reel'), note: this.story ? '' : this.kind(r) + '.', gone: () => { this.list.splice(this.list.indexOf(r), 1); this.made = this.made.filter(id => id !== r.id); this.paintList(); } }));
  }
};

/* ---------- reels still being made after their sheet was closed: the page says when each is ready ---------- */
const ReelWatch = {
  ids: new Map(), timer: 0,
  add(space, ids) { ids.forEach(id => this.ids.set(id, space)); this.tick(); },
  tick() { clearTimeout(this.timer); if (this.ids.size) this.timer = setTimeout(() => this.poll(), 2500); },
  poll() {
    const spaces = [...new Set(this.ids.values())];
    Promise.all(spaces.map(sp => api('GET', '/api/reels?space=' + sp).then(r => r.reels, () => null))).then(lists => {
      if (lists.some(l => !l)) return this.tick();   // could not ask just now: try again
      const all = lists.flat();
      for (const id of [...this.ids.keys()]) {
        const r = all.find(x => x.id === id); if (r && (r.status === 'queued' || r.status === 'running')) continue;
        this.ids.delete(id); if (!r) continue;
        const name = r.title ? `Your reel “${r.title}”` : 'Your reel', open = { label: 'Open Reels', sticky: true, fn: () => go('reels') };
        if (r.status === 'ready') toast(`${name} is ready.`, open); else toast(`${name} could not be made. ${r.error || ''}`, open);
        if (S.view === 'reels') ReelPage.load();
      }
      this.tick();
    });
  }
};

/* ---------- the Reels page: every reel of this space, from stories and from the library ---------- */
const ReelPage = {
  list: [], timer: 0, loaded: false,
  leave() { clearTimeout(this.timer); $$('#v-reels video').forEach(v => v.pause()); },
  render() {
    const v = $('#v-reels'); v.innerHTML = ''; this.loaded = false;
    v.append(el('div', { class: 'st-wrap' }, el('header', { class: 'st-head' }, el('div', { class: 'st-head-r' }, el('h1', { text: 'Reels' })),
      el('p', { text: can('edit') ? 'A reel is one video file made from your pictures, with a card at the start and music if you like. Make one from a story with its Reel button, or select pictures in the library and choose Make reel.' : 'A reel is one video file made from pictures, with a card at the start.' })),
      el('div', { class: 'rc-grid', id: 'rpList' }, el('p', { class: 'muted', text: 'Loading' }))));
    (Music.list ? Promise.resolve() : Music.load().catch(() => { })).then(() => this.load());
  },
  load() {
    clearTimeout(this.timer); const space = S.space;
    return api('GET', '/api/reels?space=' + space).then(r => { if (S.view !== 'reels' || S.space !== space) return; const was = JSON.stringify(this.list.map(x => [x.id, x.status])), first = !this.loaded; this.list = r.reels; this.loaded = true; if (first || was !== JSON.stringify(r.reels.map(x => [x.id, x.status]))) this.paint(); else Reels.paintProgress(this.list); this.watch(); },
      e => { const b = $('#rpList'); if (b) { b.innerHTML = ''; b.append(el('p', { class: 'vi-note', text: e.message })); } });
  },
  watch() { clearTimeout(this.timer); if (S.view !== 'reels' || !this.list.some(r => r.status === 'queued' || r.status === 'running')) return; this.timer = setTimeout(() => this.load(), 1500); },
  /* The reels as cards, six to eight across a desktop screen. The cover picture is shown whole, never cut to the card. */
  paint() {
    const box = $('#rpList'); if (!box) return; box.innerHTML = '';
    if (!this.list.length) return box.append(el('p', { class: 'muted', id: 'rpNone', text: 'No reels yet.' }));
    this.list.forEach(r => {
      const ready = r.status === 'ready', failed = r.status === 'failed', url = `/api/reels/${r.id}/file`, name = r.title || 'Untitled reel';
      const c = [...(r.covers || []), r.first].map(id => id && S.byId.get(id)).find(Boolean);
      let pic; if (c) { pic = el('img', { alt: '', draggable: false, width: c.w, height: c.h, style: { background: c.ghost } }); loadInto(pic, c, 'thumb'); } else pic = Reels.shape(r.format, 44);
      const from = r.from === 'story' ? `From a story, ${fmt.plural(r.count, 'item')}` : `From the library, ${fmt.plural(r.count, 'item')}`;
      const face = el(ready ? 'button' : 'div', { class: 'rc-im', ...(ready ? { 'aria-label': `Play ${name}`, title: 'Play', onclick: () => this.play(r) } : {}) }, pic, el('span', { class: 'rc-shape' }, Reels.shape(r.format, 16)), ready ? el('span', { class: 'rc-go', html: icon('play', 22) }) : null);
      const tools = el('div', { class: 'rc-tools' },
        ready ? el('button', { class: 'iconbtn', title: 'Play', 'aria-label': 'Play this reel', html: icon('play', 16), onclick: () => this.play(r) }) : null,
        ready && can('download') ? el('a', { class: 'iconbtn', href: url + '?download=1', download: '', title: 'Download', 'aria-label': 'Download this reel', html: icon('down', 16) }) : null,
        r.from === 'story' && r.story ? el('button', { class: 'iconbtn re-open', title: 'Open the story', 'aria-label': 'Open the story', html: icon('book', 16), onclick: () => Stories.load().then(() => Stories.open(r.story), () => { }) }) : null,
        el('span', { class: 'grow1' }),
        r.mayDelete === false ? null : el('button', { class: 'iconbtn', title: 'Delete this reel', 'aria-label': 'Delete this reel', html: icon('trash', 15), onclick: e => popover(e.currentTarget, el('div', { class: 'confirm' }, el('p', { text: 'Delete this reel? The pictures it was made from are not touched.' }), el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Keep', onclick: closePop }), el('button', { class: 'btn small danger', text: 'Delete reel', onclick: () => { closePop(); attempt(api('DELETE', '/api/reels/' + r.id), 'Reel deleted').then(() => { this.list.splice(this.list.indexOf(r), 1); this.paint(); }, () => { }); } })))) }));
      box.append(el('article', { class: 'rc' + (failed ? ' err' : ''), data: { id: r.id, status: r.status, from: r.from } }, face,
        el('div', { class: 're-t' }, el('b', { text: name, title: name }), el('small', { class: 'muted', text: `${Reels.kind(r)}. ${from}.` }), el('small', { class: 're-st muted', text: Reels.status(r) })), tools));
    });
  },
  /* a reel plays in a sheet of its own, at a size worth watching */
  play(r) {
    const v = el('video', { class: 'rp-video', controls: true, playsinline: true, autoplay: true, src: `/api/reels/${r.id}/file`, style: { aspectRatio: r.format.replace(':', ' / ') } });
    const close = () => { v.pause(); sheet.remove(); };
    const sheet = el('div', { class: 'overlay sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Reel', onclick: e => { if (e.target === sheet) close(); } },
      el('div', { class: 'sheet-box rp-box' }, el('header', {}, el('h2', { text: r.title || 'Untitled reel' }), el('button', { class: 'iconbtn modal-x', id: 'rpClose', title: 'Close', 'aria-label': 'Close', html: icon('x'), onclick: close })), v));
    sheet._close = close; document.body.append(sheet); v.play().catch(() => { });
  }
};
