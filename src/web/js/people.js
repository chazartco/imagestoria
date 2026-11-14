/* ---------- people in the pictures (owner and editors only) ----------
   Two places. The People tab shows who has been found, and their pictures when one is chosen.
   Saying who is who (naming groups, answering suggestions, automatic naming, the switches) is in People and settings.
   Amber is what a person said, blue is what the machine said. */
const PERSONS = {};
const seesPeople = () => !!S.me && (S.me.role === 'owner' || S.me.role === 'editor');
const personName = id => PERSONS[id] || 'Someone';
const faceImg = (f, h) => el('img', { class: 'face', src: `/api/faces/${f.id}/crop`, alt: 'A face', loading: 'lazy', draggable: false, style: { height: (h || 92) + 'px' } });

/* ---------- the People tab: who is in the pictures ---------- */
const People = {
  data: null, sel: null, io: null,
  render() {
    const box = $('#v-people'); if (!box) return;
    if (!seesPeople()) { box.innerHTML = ''; box.append(el('div', { class: 'pp-wrap' }, el('h1', { text: 'People' }), el('p', { class: 'empty', text: 'Only the owner and editors can open this page.' }))); return; }
    if (!this.data || this.data.space !== S.space) { this.sel = null; box.innerHTML = ''; box.append(el('div', { class: 'pp-wrap' }, el('h1', { text: 'People' }), el('p', { class: 'muted', text: 'Loading' }))); }
    const space = S.space;
    api('GET', '/api/faces/overview?space=' + space).then(d => { d.space = space; this.data = d; d.people.forEach(p => { PERSONS[p.id] = p.name; }); if (S.view === 'people' && S.space === space) this.paint(); }, e => toast(e.message));
  },
  /* the pictures a person is in, newest first */
  items(id) { return S.items.filter(i => i.space === S.space && i.people.includes(id)).sort((a, b) => b.date - a.date); },
  select(id) { this.sel = id; if (S.view !== 'people') go('people'); else this.paint(); $('#v-people').scrollTop = 0; },
  paint() {
    const box = $('#v-people'), d = this.data, sp = curSpace(); box.innerHTML = ''; if (this.io) { this.io.disconnect(); this.io = null; }
    const wrap = el('div', { class: 'pp-wrap' }, el('h1', { text: 'People' })); box.append(wrap);
    const toSettings = text => can('admin') ? el('div', { class: 'btnrow' }, el('button', { class: 'btn primary', id: 'ppToSettings', text, onclick: () => Naming.open() })) : el('p', { class: 'vi-note', text: 'The owner sets this up in People and settings.' });
    if (!d.on) { wrap.append(el('p', { class: 'ad-p', id: 'ppvOff', text: `People recognition is off for ${sp.name}. When it is on, a worker on your own machine finds the faces in this space's pictures, and you say who they are.` }), toSettings('Turn it on in People and settings')); return; }
    if (!d.people.length) {
      const c = d.counts;
      wrap.append(el('p', { class: 'ad-p', id: 'ppvNone', text: c.faces ? `${fmt.plural(c.faces, 'face')} found in ${sp.name}, and nobody has been named yet.` : c.waiting ? 'No faces yet. The worker has not got to these pictures.' : `No faces have been found in ${sp.name}.` }), c.faces ? toSettings('Name people in People and settings') : null);
      return;
    }
    if (this.sel && !d.people.some(p => p.id === this.sel)) this.sel = null;
    const who = d.people.map(p => ({ ...p, pics: this.items(p.id) })).sort((a, b) => b.pics.length - a.pics.length || a.name.localeCompare(b.name));
    wrap.append(el('p', { class: 'ad-p', id: 'ppLead', text: this.sel ? '' : `${fmt.plural(who.length, 'person', 'people')} named in ${sp.name}. Choose one to see their pictures.` }));
    const grid = el('div', { class: 'pp-cards' + (this.sel ? ' small' : ''), id: 'ppvPeople' });
    who.forEach(p => grid.append(el('button', { class: 'pp-card' + (p.id === this.sel ? ' on' : ''), data: { id: p.id }, 'aria-pressed': p.id === this.sel, onclick: () => this.select(p.id === this.sel ? null : p.id) },
      p.cover ? faceImg({ id: p.cover }, this.sel ? 64 : 120) : el('span', { class: 'pp-noface' }), el('b', { text: p.name }), el('small', { class: 'muted', text: fmt.plural(p.pics.length, 'picture') }))));
    wrap.append(grid);
    if (can('admin')) wrap.append(el('p', { class: 'vi-note pp-more-note' }, 'Naming faces, suggestions and automatic naming are in ', el('button', { class: 'linkbtn', id: 'ppToSettings', text: 'People and settings', onclick: () => Naming.open() }), '.'));
    if (!this.sel) return;
    const p = who.find(x => x.id === this.sel), list = p.pics;
    const head = el('div', { class: 'pp-sel', id: 'ppSel' }, el('h2', { text: p.name }), el('span', { class: 'muted', text: fmt.plural(list.length, 'picture') }), el('span', { class: 'grow1' }),
      el('button', { class: 'btn small', text: 'Show in the library', title: 'Filter the library to this person', onclick: () => { Lib.only([{ type: 'person', value: p.id, label: p.name }]); go('library'); } }),
      el('button', { class: 'btn small', id: 'ppAll', text: 'All people', onclick: () => this.select(null) }));
    const pics = el('div', { class: 'pp-pics', id: 'ppPics' }); wrap.append(head, pics);
    if (!list.length) { pics.append(el('p', { class: 'muted', text: 'No pictures yet. They appear here once the library has caught up.' })); return; }
    /* rows that keep every picture's full shape, drawn as they come into view */
    const W = Math.max(240, pics.clientWidth), gap = 4;
    this.io = new IntersectionObserver(es => es.forEach(e => { if (!e.isIntersecting) return; this.io.unobserve(e.target); loadInto($('img', e.target), e.target._it, 'thumb'); }), { root: box, rootMargin: '600px' });
    for (const row of Lib.justify(list, W, Math.min(S.rowH || 210, 240), gap)) {
      const r = el('div', { class: 'pp-row', style: { height: row.h + 'px' } });
      for (const c of row.cells) { const t = el('button', { class: 'pp-pic', data: { id: c.it.id }, 'aria-label': label(c.it) + ', ' + fmt.day(c.it.date), style: { width: c.w + 'px', height: row.h + 'px', background: c.it.ghost }, onclick: () => Viewer.open(c.it.id, list) }, el('img', { alt: '', draggable: false })); t._it = c.it; r.append(t); this.io.observe(t); }
      pics.append(r);
    }
  }
};
addEventListener('resize', () => { if (S.view === 'people' && People.data && People.sel && $('#viewer').hidden) People.paint(); });

/* ---------- saying who is who: cards and windows on People and settings, for the space you are in ----------
   Three cards: Name faces (the workspace), Automatic naming, and People recognition (the switch).
   The workspace has a tab for each kind of work, so only one is on screen at a time. */
const Naming = {
  data: null, review: null, nums: null, off: new Set(), pick: new Set(), last: null, tab: null, keys: null,
  /* from anywhere: open People and settings with the workspace on top */
  open() { go('admin'); Admin.modal = 'faces'; Admin.paintModal(true); },
  async load() {
    const space = S.space, d = await api('GET', '/api/faces/overview?space=' + space); d.space = space;
    const review = d.on ? await api('GET', '/api/faces/review?space=' + space) : { suggested: [], auto: [] };
    const nums = d.on && d.counts.named ? await api('GET', '/api/faces/numbers?space=' + space) : null;
    this.data = d; this.review = review; this.nums = nums;
    d.people.forEach(p => { PERSONS[p.id] = p.name; });
  },
  repaint() { if (Admin.isOpen() && Admin.over) Admin.paint(); },
  refresh() { return this.load().then(() => this.repaint(), e => toast(e.message)); },
  /* after an answer: send it, then show what the server now holds. The library hears about the new names on its next sync. */
  act(promise, done) { return attempt(promise, done).then(() => this.load()).then(() => { Sync.soon(); People.data = null; this.repaint(); }, () => { }); },
  name(faceIds, name, personId) {
    return this.act(api('POST', '/api/faces/name', personId ? { faceIds, personId } : { faceIds, name }).then(r => { if (r.also) toast(`${r.name} was already tagged in ${r.also === 1 ? 'one of those pictures' : r.also + ' of those pictures'}. ${r.also === 1 ? 'That face is' : 'Those faces are'} remembered as ${r.name}, with no second tag.`); return r; }), null);
  },
  openItem(id) { if (S.byId.has(id)) Viewer.open(id, [S.byId.get(id)]); },

  /* ----- the cards ----- */
  cards() {
    const d = this.data, sp = curSpace();
    if (!d) return [Admin.card('recog', 'People recognition', 'Not available', 'It could not be loaded', 'off')];
    if (!d.on) return [Admin.card('recog', 'People recognition', 'Off', `Faces are not looked for in ${sp.name}`, 'off')];
    const c = d.counts, q = this.review.suggested.length, chk = this.review.auto.length, todo = c.unsorted + q;
    return [
      Admin.card('faces', 'Name faces', todo ? `${fmt.n(todo)} to name` : 'All named', [fmt.plural(d.people.length, 'person', 'people'), q ? fmt.plural(q, 'question') : '', chk ? `${chk} to check` : ''].filter(Boolean).join(', '), todo || chk ? 'warn' : 'ok'),
      Admin.card('auto', 'Automatic naming', d.auto ? `On at ${Math.round(d.threshold * 100)}%` : 'Off', c.auto ? `${fmt.n(c.auto)} named without asking` : 'Nothing named without asking', d.auto ? 'ok' : 'off'),
      Admin.card('recog', 'People recognition', 'On', `${fmt.plural(c.faces, 'face')} found` + (c.waiting ? `, ${fmt.plural(c.waiting, 'picture')} to look at` : ''), c.waiting ? 'busy' : 'ok')
    ];
  },

  /* ----- the switch ----- */
  mRecog() {
    const d = this.data, sp = curSpace(); if (!d) return null;
    if (!d.on) return { title: 'People recognition', body: el('div', {},
      el('p', { class: 'ad-p', id: 'ppOff', text: `People recognition is off for ${sp.name}. When it is on, a worker on your own machine finds the faces in this space's pictures, and you say who they are. Faces and names stay in this space and on this server. Only the owner and editors see them.` }),
      el('div', { class: 'btnrow' }, el('button', { class: 'btn primary', id: 'ppOn', text: `Turn it on for ${sp.name}`, onclick: () => attempt(api('POST', '/api/faces/settings', { space: S.space, on: true }), 'People recognition is on. The worker will start on the faces.').then(() => reloadShell()).then(() => { People.data = null; return this.refresh(); }, () => { }) }))) };
    const c = d.counts;
    const sure = (btn, text, body, done) => Admin.sure(btn, text, 'Turn off and delete', () => { for (const k in PERSONS) delete PERSONS[k]; attempt(api('POST', '/api/faces/settings', body), done).then(() => reloadShell()).then(() => { this.data = null; People.data = null; People.sel = null; Sync.full().then(() => Lib.refresh()); return this.refresh(); }, () => { }); });
    return { title: 'People recognition', body: el('div', { id: 'ppSwitch' },
      el('p', { class: 'ad-p ad-lead', id: 'ppCounts', text: `${fmt.plural(c.faces, 'face')} found in ${sp.name}: ${c.named} named by a person, ${c.auto} named automatically, ${c.unsorted} waiting to be named, ${c.ignored} set aside.${c.waiting ? ` ${fmt.plural(c.waiting, 'picture')} still to be looked at by the worker.` : ''}` }),
      el('p', { class: 'ad-p', text: 'Each space has its own people. Switch spaces at the top of the page to work on another. Face data is biometric data. Turning recognition off deletes it: the faces, the names and every answer you gave. The pictures are not touched.' }),
      d.mayAdmin ? el('div', { class: 'btnrow' }, el('button', { class: 'btn', id: 'ppOffSpace', text: `Turn off for ${sp.name}`, onclick: e => sure(e.currentTarget, `Turn people recognition off for ${sp.name} and delete all of its face data? This cannot be undone.`, { space: S.space, on: false }, 'Off. The face data is deleted.') }),
        el('button', { class: 'btn danger', id: 'ppWipe', text: 'Turn off everywhere', onclick: e => sure(e.currentTarget, 'Turn people recognition off in every space and delete all face data? This cannot be undone.', { wipe: true }, 'Off everywhere. All face data is deleted.') })) : null) };
  },

  /* ----- automatic naming: the numbers first, then the switch ----- */
  mAuto() {
    const d = this.data; if (!d) return null; if (!d.on) return this.mRecog();
    const box = el('div', { id: 'ppAutoBox' },
      el('p', { class: 'ad-p', text: `A face is named without asking only when the person has at least ${d.minConfirmed} faces you confirmed, the likeness is at or above the threshold, and no other person comes close. It is ${d.auto ? `on, at ${Math.round(d.threshold * 100)}%` : 'off'}. Every automatic name can be checked and undone under Name faces.` }));
    if (this.nums && this.nums.faces) {
      const t = el('table', { class: 'pp-nums' }, el('thead', {}, el('tr', {}, ...['Threshold', 'Named right', 'Named wrong', 'Left to ask'].map(h => el('th', { text: h })))), el('tbody', {}, this.nums.rows.map(r => el('tr', { class: Math.abs(r.threshold - d.threshold) < 0.001 ? 'on' : '' }, el('td', { text: Math.round(r.threshold * 100) + '%' }), el('td', { text: r.right }), el('td', { class: r.wrong ? 'bad' : '', text: r.wrong }), el('td', { text: r.asked })))));
      box.append(el('p', { class: 'ad-p', text: `This is how it would have done on the ${fmt.plural(this.nums.faces, 'face')} you have confirmed, each one taken out in turn and named again from the rest.` }), t);
    } else box.append(el('p', { class: 'vi-note', text: 'Name some people first. The numbers that show how well it would do appear here.' }));
    if (d.mayAdmin) {
      const sel = el('select', { class: 'inp', id: 'ppThreshold', 'aria-label': 'Threshold' }, [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75].map(v => el('option', { value: v, text: Math.round(v * 100) + '%', selected: Math.abs(v - d.threshold) < 0.001 })));
      const set = on => this.act(api('POST', '/api/faces/settings', { auto: { on, threshold: Number(sel.value) } }), on ? 'Automatic naming is on' : 'Automatic naming is off');
      box.append(el('div', { class: 'ad-invite' }, sel, el('button', { class: 'btn' + (d.auto ? '' : ' primary'), id: 'ppAutoSwitch', text: d.auto ? 'Turn automatic naming off' : 'Turn automatic naming on', onclick: () => set(!d.auto) }), d.auto ? el('button', { class: 'btn', text: 'Use this threshold', onclick: () => set(true) }) : null));
    }
    return { title: 'Automatic naming', body: box };
  },

  /* ----- the workspace ----- */
  mFaces() {
    const d = this.data; if (!d) return null; if (!d.on) return this.mRecog();
    const sp = curSpace(), sug = this.review.suggested, autos = this.review.auto, c = d.counts; this.keys = null;
    const tabs = [['ask', 'Questions', sug.length], ['todo', 'To name', c.unsorted], ['check', 'Named automatically', autos.length], ['named', 'People', d.people.length]];
    /* stay on the tab in use while it has something in it, otherwise go to the first that does */
    if (!this.tab || !(tabs.find(t => t[0] === this.tab) || [])[2]) this.tab = (tabs.find(t => t[2]) || tabs[1])[0];
    const bar = el('div', { class: 'ad-tabs', role: 'tablist', id: 'ppTabs' }, tabs.map(([k, label, n]) => el('button', { role: 'tab', id: 'ppTab-' + k, class: k === this.tab ? 'on' : '', 'aria-selected': String(k === this.tab), onclick: () => { this.tab = k; Admin.paintModal(true); } }, label, el('i', { text: fmt.n(n) }))));
    const body = el('div', { class: 'pp-work', id: 'adFacesBody' }, bar);
    const known = el('datalist', { id: 'ppNames' }, d.people.map(p => el('option', { value: p.name }))); body.append(known);
    const empty = text => el('p', { class: 'muted pp-empty', text });

    if (this.tab === 'ask') {
      /* one question at a time, answered with a key */
      if (!sug.length) body.append(empty('No questions. They appear here when the worker thinks it knows a face but is not sure.'));
      else {
        const f = sug[0];
        const yes = () => this.name([f.id], null, f.person), no = () => this.act(api('POST', '/api/faces/reject', { faceIds: [f.id] })), skip = () => { sug.push(sug.shift()); Admin.paintModal(false); }, ign = () => this.act(api('POST', '/api/faces/ignore', { faceIds: [f.id], as: 'ignored' }));
        this.keys = { y: yes, n: no, s: skip, i: ign };
        body.append(el('section', { class: 'pp-review', id: 'ppReview' },
          el('div', { class: 'pp-q' }, el('button', { class: 'pp-facebtn', title: 'Open the picture', onclick: () => this.openItem(f.item) }, faceImg(f, 168)),
            el('div', {}, el('p', { class: 'pp-ask', id: 'ppAsk' }, 'Is this ', el('b', { text: personName(f.person) }), '?'),
              el('p', { class: 'muted ai-note', text: `Suggested by the worker, ${Math.round(f.score * 100)}% alike. ${fmt.plural(sug.length, 'question')} waiting.` }),
              el('div', { class: 'btnrow' }, el('button', { class: 'btn primary', id: 'ppYes', onclick: yes }, 'Yes ', el('kbd', { text: 'Y' })), el('button', { class: 'btn', id: 'ppNo', onclick: no }, 'No ', el('kbd', { text: 'N' })), el('button', { class: 'btn', id: 'ppSkip', onclick: skip }, 'Skip ', el('kbd', { text: 'S' })), el('button', { class: 'btn', id: 'ppIgnore', title: 'A stranger, or nobody you want named', onclick: ign }, 'Ignore ', el('kbd', { text: 'I' })))))));
      }
    }

    if (this.tab === 'check') {
      /* named without asking: every one can be undone, or all confirmed at once */
      if (!autos.length) body.append(empty('Nothing to check. Faces named without asking are listed here until you say they are right.'));
      else {
        const list = el('div', { class: 'pp-autos' });
        autos.forEach(f => list.append(el('div', { class: 'pp-auto', data: { id: f.id } }, el('button', { class: 'pp-facebtn', title: 'Open the picture', onclick: () => this.openItem(f.item) }, faceImg(f, 56)),
          el('div', {}, el('b', { text: personName(f.person) }), el('small', { class: 'ai-note', text: `Named automatically, ${Math.round(f.score * 100)}% alike${f.at ? ', ' + fmt.ago(f.at) : ''}` })),
          el('button', { class: 'btn small', text: 'Right', title: 'Confirm this name', onclick: () => this.name([f.id], null, f.person) }),
          el('button', { class: 'btn small', text: 'Undo', title: 'This is not them', onclick: () => this.act(api('POST', '/api/faces/reject', { faceIds: [f.id] }), `Undone. Automatic naming is now more careful about ${personName(f.person)}.`) }))));
        const all = () => { const by = new Map(); autos.forEach(f => by.set(f.person, [...(by.get(f.person) || []), f.id])); this.act(Promise.all([...by].map(([p, ids]) => api('POST', '/api/faces/name', { faceIds: ids, personId: p }))), `${fmt.plural(autos.length, 'name')} confirmed`); };
        body.append(el('section', { id: 'ppAuto' }, el('div', { class: 'pp-bar' }, el('span', { class: 'muted', text: 'Undo any that are wrong. Each undo makes automatic naming more careful about that person.' }), el('span', { class: 'grow1' }), el('button', { class: 'btn small primary', id: 'ppAutoAll', text: `All ${autos.length} are right`, onclick: all })), list));
      }
    }

    if (this.tab === 'named') {
      /* the people there are: rename, merge, forget */
      if (!d.people.length) body.append(empty('Nobody has been named yet.'));
      else {
        const grid = el('div', { class: 'pp-people', id: 'ppNamed' });
        d.people.forEach(p => {
          const nm = el('input', { class: 'inp pp-name', value: p.name, maxlength: 80, 'aria-label': 'Name', onkeydown: e => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); }, onchange: e => { const v = e.target.value.trim(); if (!v || v === p.name) { e.target.value = p.name; return; } attempt(api('PATCH', '/api/persons/' + p.id, { name: v }), 'Renamed').then(() => this.load()).then(() => { Sync.soon(); People.data = null; this.repaint(); }, () => { e.target.value = p.name; }); } });
          const menu = e => {
            const others = d.people.filter(o => o.id !== p.id), btn = e.currentTarget;
            popover(btn, el('div', { class: 'menu' },
              others.length ? el('div', { class: 'pop-h', text: `${p.name} is the same person as` }) : null,
              ...others.map(o => el('button', { class: 'mi', text: o.name, onclick: () => { closePop(); this.act(api('POST', `/api/persons/${p.id}/merge`, { into: o.id }), `Merged into ${o.name}`); } })),
              el('button', { class: 'mi danger', text: `Forget ${p.name}`, onclick: ev => { ev.stopPropagation(); Admin.sure(btn, `Forget ${p.name}? The name is removed from ${fmt.plural(p.n, 'face')} and the face data for them is deleted. The pictures are not touched.`, 'Forget', () => { delete PERSONS[p.id]; this.act(api('DELETE', '/api/persons/' + p.id), `${p.name} is forgotten`); }); } })));
          };
          grid.append(el('article', { class: 'pp-person', data: { id: p.id } },
            p.cover ? el('button', { class: 'pp-facebtn', title: `Show the pictures of ${p.name}`, onclick: () => { Admin.close(); People.data = null; People.sel = p.id; go('people'); } }, faceImg({ id: p.cover }, 84)) : el('div', { class: 'pp-noface' }),
            nm, el('small', { class: 'muted', text: `${fmt.plural(p.n, 'face')}${p.auto ? `, ${p.auto} automatic` : ''}${p.looks > 1 ? `, ${p.looks} looks` : ''}` }),
            el('button', { class: 'iconbtn tiny pp-more', title: 'Merge or forget', 'aria-label': `More for ${p.name}`, html: icon('more', 16), onclick: menu })));
        });
        body.append(el('p', { class: 'muted pp-hint', text: 'Type over a name to change it. The menu on each one merges two people who are the same, or forgets one. Click a face to see their pictures.' }), grid);
      }
    }

    if (this.tab === 'todo') {
      if (!d.groups.length && !d.singles.length) body.append(empty(c.waiting ? 'No faces yet. The worker has not got to these pictures.' : d.people.length ? 'Every face has been named or set aside.' : 'No faces have been found in this space.'));
      /* faces that look alike, the largest group first: one name for the whole row */
      if (d.groups.length) {
        const groups = el('div', { class: 'pp-groups' });
        d.groups.forEach((g, k) => {
          const faces = g.faces, n = g.n, row = el('div', { class: 'pp-group', data: { k } }), strip = el('div', { class: 'pp-strip' });
          const live = () => faces.filter(f => !this.off.has(f.id)).map(f => f.id);
          const inp = el('input', { class: 'inp', placeholder: 'Who is this?', list: 'ppNames', maxlength: 80, 'aria-label': 'Name for this group', onkeydown: e => { e.stopPropagation(); if (e.key === 'Enter') go1(); } });
          const count = el('span', { class: 'muted' });
          const tell = () => { const m = live().length; count.textContent = n > faces.length ? `${m} of ${n} shown` : fmt.plural(m, 'face'); };
          const go1 = () => { const v = inp.value.trim(), ids = live(); if (!v) return inp.focus(); if (!ids.length) return toast('Every face in this group is left out. Click a face to put it back.'); this.name(ids, v); };
          faces.forEach(f => { const b = el('button', { class: 'pp-facebtn' + (this.off.has(f.id) ? ' off' : ''), title: 'Click to leave this face out of the group', 'aria-pressed': !this.off.has(f.id), onclick: () => { if (this.off.has(f.id)) this.off.delete(f.id); else this.off.add(f.id); b.classList.toggle('off'); b.setAttribute('aria-pressed', !this.off.has(f.id)); tell(); } }, faceImg(f, 64)); strip.append(b); });
          tell();
          row.append(strip, el('div', { class: 'pp-gacts' }, inp, el('button', { class: 'btn primary small', text: 'Name them', onclick: go1 }), count, el('span', { class: 'grow1' }),
            el('button', { class: 'btn small', text: 'Ignore', title: 'Strangers, or nobody you want named', onclick: () => this.act(api('POST', '/api/faces/ignore', { faceIds: live(), as: 'ignored' }), 'Set aside') }),
            el('button', { class: 'btn small', text: 'Not a person', title: 'A statue, a poster, a pattern', onclick: () => this.act(api('POST', '/api/faces/ignore', { faceIds: live(), as: 'notface' }), 'Set aside') })));
          groups.append(row);
        });
        body.append(el('section', { id: 'ppGroups' }, el('h3', { class: 'pp-h3' }, 'Faces that look alike', el('small', { class: 'muted', text: 'One name for the whole row. Click a face that does not belong to leave it out.' })), groups));
      }
      /* faces seen once: pick any number, then name them or set them aside in one go */
      if (d.singles.length) {
        const ids = d.singles.map(f => f.id); for (const id of [...this.pick]) if (!ids.includes(id)) this.pick.delete(id);
        const grid = el('div', { class: 'pp-strip pp-singles', id: 'ppSingles' });
        const nEl = el('b', { id: 'ppPickN' }), inp = el('input', { class: 'inp', id: 'ppPickName', placeholder: 'Who is this?', list: 'ppNames', maxlength: 80, 'aria-label': 'Name for the chosen faces', onkeydown: e => { e.stopPropagation(); if (e.key === 'Enter') nameThem(); } });
        const need = () => { if (this.pick.size) return true; toast('Choose one or more faces first. Click a face to choose it.'); return false; };
        const nameThem = () => { const v = inp.value.trim(); if (!need()) return; if (!v) return inp.focus(); const list = [...this.pick]; this.pick.clear(); this.name(list, v); };
        const aside = as => { if (!need()) return; const list = [...this.pick]; this.pick.clear(); this.act(api('POST', '/api/faces/ignore', { faceIds: list, as }), `${fmt.plural(list.length, 'face')} set aside`); };
        const bGo = el('button', { class: 'btn small primary', id: 'ppPickGo', text: 'Name', onclick: nameThem }), bIgn = el('button', { class: 'btn small', id: 'ppPickIgnore', text: 'Ignore', title: 'Strangers, or nobody you want named', onclick: () => aside('ignored') }), bNot = el('button', { class: 'btn small', id: 'ppPickNot', text: 'Not a person', title: 'A statue, a poster, a pattern', onclick: () => aside('notface') });
        const bOpen = el('button', { class: 'btn small', id: 'ppPickOpen', text: 'Open the picture', onclick: () => { const f = d.singles.find(x => this.pick.has(x.id)); if (f) this.openItem(f.item); } });
        const bAll = el('button', { class: 'linkbtn', id: 'ppPickAll', onclick: () => { if (this.pick.size === ids.length) this.pick.clear(); else ids.forEach(id => this.pick.add(id)); tell(); } });
        const tell = () => {
          const n = this.pick.size; nEl.textContent = n ? `${n} chosen` : 'None chosen'; bGo.disabled = bIgn.disabled = bNot.disabled = !n; bOpen.hidden = n !== 1; bAll.textContent = n === ids.length ? 'Choose none' : `Choose all ${ids.length}`;
          $$('.pp-facebtn', grid).forEach(b => { const on = this.pick.has(b.dataset.id); b.classList.toggle('sel', on); b.setAttribute('aria-pressed', String(on)); });
        };
        d.singles.forEach((f, i) => grid.append(el('button', { class: 'pp-facebtn', data: { id: f.id }, title: 'Click to choose. Shift and click chooses a run. Double-click opens the picture.', ondblclick: () => this.openItem(f.item), onclick: e => {
          /* shift and click takes every face from the last one clicked to this one */
          if (e.shiftKey && this.last != null && this.last < ids.length) { const [a, b] = [Math.min(this.last, i), Math.max(this.last, i)]; for (let k = a; k <= b; k++) this.pick.add(ids[k]); }
          else if (this.pick.has(f.id)) this.pick.delete(f.id); else this.pick.add(f.id);
          this.last = i; tell();
        } }, faceImg(f, 64), el('i', { class: 'pp-tick', html: icon('check', 12) }))));
        tell();
        body.append(el('section', { id: 'ppOnce' }, el('h3', { class: 'pp-h3' }, 'Faces seen once', el('small', { class: 'muted', text: 'Click faces to choose them, then name them or set them aside together.' })),
          el('div', { class: 'pp-pickbar', id: 'ppPickBar' }, nEl, inp, bGo, bIgn, bNot, bOpen, el('span', { class: 'grow1' }), bAll), grid));
      }
    }
    return { title: `Name faces in ${sp.name}`, wide: true, body };
  },
  /* Y, N, S and I answer the question on screen, while the workspace is open and nothing is being typed */
  key(e) {
    if (!this.keys || !Admin.isOpen() || !$('#ppReview') || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test((e.target.tagName || '')) || !$('#viewer').hidden || $('.pop')) return false;
    const fn = this.keys[e.key.toLowerCase()]; if (!fn) return false;
    e.preventDefault(); fn(); return true;
  }
};
document.addEventListener('keydown', e => { Naming.key(e); });
