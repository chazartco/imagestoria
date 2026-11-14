/* ---------- viewer: one photo, everything about it ---------- */
const SPOT_KIND = { landmark: 'landmark', beach: 'beach', park: 'park', reserve: 'reserve', natural: 'natural feature', neighborhood: 'neighborhood', water: 'water' };
const Viewer = {
  list: [], idx: 0, item: null, dirty: false, loupeOn: true, mag: 2.5, miniMap: null, more: null,
  open(id, list) {
    const first = S.byId.get(id); if (!first) return;
    this.list = (list && list.length ? list : Lib.order).slice(); this.idx = this.list.findIndex(i => i.id === id);
    if (this.idx < 0) { this.list = [first]; this.idx = 0; }
    $('#viewer').hidden = false; document.body.classList.add('modal-open'); this.fold(store.get('vwInfo', '1') === '0'); this.show();
  },
  /* fold the details away so the picture gets the whole modal. The choice is remembered. */
  fold(off, keep) {
    Zoom.close(); $('#vwBox').classList.toggle('noinfo', off); const b = $('#vwFold'), t = off ? 'Show details' : 'Hide details';
    b.title = t; b.setAttribute('aria-label', t); b.classList.toggle('on', !off);
    if (keep) { store.set('vwInfo', off ? '0' : '1'); if (this.item) { this.strip(); if (!off) this.info(true); } }
  },
  close() {
    this.flush(); Zoom.close();
    $('#viewer').hidden = true; document.body.classList.remove('modal-open'); this.stopVideo();
    if (this.miniMap) { this.miniMap.remove(); this.miniMap = null; }
    if (this.dirty) { this.dirty = false; Lib.refresh(); if (S.view === 'stories') Stories.render(); }
    this.item = null; this.more = null;
  },
  /* ---------- video: plays when opened, stops when left ---------- */
  stopVideo() { const v = $('#vwVideo'); this._playing = null; $('#vwUnmute').hidden = true; v.pause(); if (v.hasAttribute('src')) { v.removeAttribute('src'); v.load(); } },
  playVideo(it) {
    const v = $('#vwVideo'), un = $('#vwUnmute'); this._playing = it; this._forcedMute = false; un.hidden = true;
    playWithSound(v, () => this._playing === it && this.item === it, forced => { this._forcedMute = forced; un.hidden = !forced; });
  },
  unmute() { const v = $('#vwVideo'); this._forcedMute = false; v.muted = false; $('#vwUnmute').hidden = true; if (v.volume === 0) v.volume = 1; },
  /* A video whose copy for browsers is not there yet says so, and offers the original to download. */
  playNote(it, ready, broken) {
    const n = $('#vwPlayNote'); n.innerHTML = ''; n.hidden = true; if (!it || it.kind !== 'video' || !ready) return;
    const text = it.play === 'queued' || it.play === 'making' ? 'A copy that plays in every browser is being made. Until it is ready, this plays the original, which may not work here.'
      : it.play === 'failed' ? 'A copy that plays in every browser could not be made. This plays the original, which may not work here.'
      : broken ? 'This browser cannot play this video.' : '';
    if (!text) return;
    n.append(text); if (can('download')) n.append(el('button', { class: 'linkbtn', text: 'Download the original', onclick: () => Img.download(it) })); n.hidden = false;
  },
  togglePlay() { const v = $('#vwVideo'); if (v.hidden) return; if (v.paused) v.play().catch(() => { }); else v.pause(); },
  step(d) { const n = this.idx + d; if (n < 0 || n >= this.list.length) return; this.idx = n; this.show(); },
  show() {
    this.flush(); Zoom.close();
    const it = this.item = this.list[this.idx]; if (!it) return this.close();
    const img = $('#vwImg'), vid = $('#vwVideo'), stage = $('#vwStage'), lp = $('#loupe');
    stage.style.setProperty('--ghost', it.ghost); lp.classList.remove('show'); lp.style.backgroundImage = '';
    const ready = it.status === 'ready';
    $('#vwWait').hidden = ready; if (!ready) $('#vwWait').textContent = it.status === 'failed' ? 'This file could not be read. ' + (it.error || '') : 'Still being processed. It will appear here by itself.';
    this.stopVideo();
    this.playNote(it, ready);
    if (it.kind === 'video' && ready) { img.hidden = true; vid.hidden = false; vid.poster = Img.url(it, 'display'); vid.src = Img.media(it); vid.dataset.play = it.play || ''; this.playVideo(it); }
    else {
      vid.hidden = true; img.hidden = !ready; img.classList.remove('in'); img.alt = label(it);
      if (ready) {
        /* the thumbnail is almost always in the browser already: show it at once, then swap in the display copy */
        img._want = it.id; img.src = Img.url(it, 'thumb'); img.classList.add('in');
        const big = new Image(), url = Img.url(it, 'display');
        big.onload = () => { if (this.item === it && img._want === it.id) { img.src = url; lp.style.backgroundImage = `url("${url}")`; } };
        big.src = url;
      }
    }
    this._origAsked = false;
    $('#vwPrev').disabled = this.idx === 0; $('#vwNext').disabled = this.idx === this.list.length - 1;
    $('#vwCount').textContent = `${this.idx + 1} of ${this.list.length}`;
    $('#vwHint').textContent = it.kind === 'video' || !ready ? '' : 'Hover to magnify, scroll to change strength. Click to zoom into the original.';
    this.more = null;
    api('GET', '/api/items/' + it.id).then(m => { if (this.item !== it) return; this.more = m; this.paintComments(); this.files(); }, () => { });
    this.tools(); this.strip(); this.info();
  },
  /* the item changed on the server while it was open */
  synced() {
    const it = this.item; if (!it) return;
    if (!S.byId.has(it.id)) { this.list.splice(this.idx, 1); if (!this.list.length) return this.close(); this.idx = Math.min(this.idx, this.list.length - 1); return this.show(); }
    if (it.status !== this._status) { this._status = it.status; return this.show(); }
    const a = document.activeElement; if (a && $('#vwInfo').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
    this.tools(); this.info(true);
  },
  toggleLike() {
    const it = this.item, on = !it.fav; it.fav = on; this.dirty = true; this.tools(); this.likes();
    api(on ? 'PUT' : 'DELETE', `/api/items/${it.id}/like`).catch(e => { it.fav = !on; toast(e.message); if (this.item === it) { this.tools(); this.likes(); } });
  },
  tools() {
    const it = this.item, t = $('#vwTools'), ready = it.status === 'ready'; t.innerHTML = '';
    const b = (ic, label, fn, cls) => el('button', { class: 'iconbtn ' + (cls || ''), title: label, 'aria-label': label, html: icon(ic), onclick: fn });
    if (it.kind !== 'video' && ready) t.append(b('loupe', this.loupeOn ? 'Turn magnifier off' : 'Turn magnifier on', () => { this.loupeOn = !this.loupeOn; $('#loupe').classList.remove('show'); this.tools(); }, this.loupeOn ? 'on' : ''), b('zoom', 'Zoom into the original', () => Zoom.toggle(it)));
    t.append(b('heart', it.fav ? 'Remove your like' : 'Like', () => this.toggleLike(), it.fav ? 'on fav' : ''));
    if (can('edit') && it.kind !== 'video' && ready) t.append(el('button', { class: 'btn small', html: icon('sliders', 16) + '<span>Edit a copy</span>', onclick: () => Editor.open(it) }));
    if (can('download') && it.status !== 'failed') t.append(b('down', 'Download original', () => Img.download(it)));
    if (can('del')) t.append(b('trash', 'Move to trash', e => popover(e.currentTarget, el('div', { class: 'confirm' }, el('p', { text: 'Move this to the trash? It can be brought back until the trash is emptied.' }), el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Keep', onclick: closePop }), el('button', { class: 'btn small danger', text: 'Move to trash', onclick: () => { closePop(); removeItems([it]).then(() => { if (this.item !== it) return; this.list.splice(this.idx, 1); this.dirty = false; if (!this.list.length) this.close(); else { this.idx = Math.min(this.idx, this.list.length - 1); this.show(); } }); } }))), { up: true })));
  },
  strip() {
    const s = $('#vwStrip'); s.innerHTML = ''; const a = Math.max(0, this.idx - 14), b = Math.min(this.list.length, this.idx + 15);
    for (let i = a; i < b; i++) { const it = this.list[i]; const im = el('img', { alt: '', draggable: false }); const bt = el('button', { class: 'st' + (i === this.idx ? ' on' : ''), style: { aspectRatio: it.ar, background: it.ghost }, 'aria-label': label(it), onclick: () => { this.idx = i; this.show(); } }, im); loadInto(im, it, 'thumb'); s.append(bt); }
    const on = $('.st.on', s); if (on) s.scrollLeft = on.offsetLeft - s.clientWidth / 2 + on.clientWidth / 2;
  },

  /* typing is saved a moment after it stops, and always before moving on */
  pend: null,
  edit(it, patch) {
    Object.assign(it, patch); it.hay = null; this.dirty = true;
    it._hold = Object.assign(it._hold || {}, patch);
    if (this.pend && this.pend.it !== it) this.flush();
    this.pend = this.pend || { it, body: {} }; Object.assign(this.pend.body, patch);
    clearTimeout(this._pt); this._pt = setTimeout(() => this.flush(), 700);
  },
  flush() {
    clearTimeout(this._pt); const p = this.pend; if (!p) return; this.pend = null;
    api('PATCH', '/api/items/' + p.it.id, p.body).then(() => { if (!this.pend || this.pend.it !== p.it) p.it._hold = null; }, e => { p.it._hold = null; toast('Not saved. ' + e.message); Sync.soon(); });
  },
  go(filter) { this.close(); go('library'); Lib.only([filter]); },

  info(keepScroll) {
    const it = this.item, box = $('#vwInfo'), edit = can('tag'), top = box.scrollTop; box.innerHTML = '';
    this._status = it.status;
    const pl = it.place && PLACES[it.place];
    /* --- yours: title, description, tags, comments --- */
    const title = edit ? el('textarea', { class: 'vi-title', rows: 1, placeholder: 'Add a title', value: it.title, maxlength: 300, 'aria-label': 'Title', oninput: e => { this.edit(it, { title: e.target.value.replace(/\n/g, ' ') }); autosize(e.target); } }) : el('h2', { class: 'vi-title ro', text: it.title || it.fileName });
    const when = el('p', { class: 'vi-when' }, `${fmt.weekday(it.date)}, ${fmt.day(it.date)} at ${fmt.time(it.date)}`, pl ? el('span', {}, ' in ', el('button', { class: 'linkbtn', text: pl.name, title: 'Show everything from here', onclick: () => this.go({ type: 'place', value: it.place, label: pl.name }) })) : null);
    const desc = edit ? el('textarea', { class: 'vi-desc', rows: 2, placeholder: 'Add a description', value: it.desc, maxlength: 5000, 'aria-label': 'Description', oninput: e => { this.edit(it, { desc: e.target.value }); autosize(e.target); } }) : (it.desc ? el('p', { class: 'vi-desc ro', text: it.desc }) : null);
    box.append(el('div', { class: 'vi-head' }, title, when, el('p', { class: 'vi-likes', id: 'viLikes' }), desc)); this.likes();
    if (it.copyOf && S.byId.get(it.copyOf)) { const o = S.byId.get(it.copyOf); box.append(el('p', { class: 'vi-note' }, 'Edited copy of ', el('button', { class: 'linkbtn', text: o.title || o.fileName, onclick: () => this.open(o.id, [o, it]) }), '. The original is untouched.')); }

    const tags = el('div', { class: 'fvals wrap' });
    const sendTags = body => api('POST', `/api/items/${it.id}/tags`, body).catch(e => { toast(e.message); Sync.soon(); });
    const paintTags = () => {
      tags.innerHTML = '';
      it.tags.forEach(t => tags.append(el('span', { class: 'chip on' }, el('button', { class: 'chip-t', text: t, title: 'Find everything with this tag', onclick: () => this.go({ type: 'tag', value: t, label: t }) }), edit ? el('button', { class: 'chip-x', 'aria-label': 'Remove tag ' + t, html: icon('x', 12), onclick: () => { it.tags.splice(it.tags.indexOf(t), 1); it.hay = null; this.dirty = true; sendTags({ remove: [t] }); paintTags(); } }) : null)));
      if (!it.tags.length && !edit) tags.append(el('span', { class: 'muted', text: 'No tags yet' }));
      if (edit) {
        const inp = el('input', { class: 'inp taginp', placeholder: it.tags.length ? 'Add another' : 'Add a tag', list: 'tagList', maxlength: 60, 'aria-label': 'Add a tag' });
        inp.addEventListener('keydown', e => { if (e.key === 'Enter' && inp.value.trim()) { const v = inp.value.trim().toLowerCase(); if (!it.tags.includes(v)) { it.tags.push(v); it.hay = null; this.dirty = true; sendTags({ add: [v] }); } paintTags(); $('.taginp', tags).focus(); } e.stopPropagation(); });
        tags.append(inp);
      }
    };
    paintTags(); $('#tagList').innerHTML = allTags(it.space).map(t => `<option value="${esc(t)}">`).join('');
    box.append(el('section', { class: 'vi-sec' }, el('h4', { text: 'Tags' }), tags));

    const sp = S.spaces.find(s => s.id === it.space);
    if (sp && sp.kind === 'studio' && (edit || it.series)) {
      const names = [...new Set(S.items.filter(i => i.space === it.space && i.series).map(i => i.series))].sort();
      box.append(el('section', { class: 'vi-sec' }, el('h4', { text: 'Series' }), edit
        ? [el('input', { class: 'inp', value: it.series || '', placeholder: 'Which body of work is this part of?', list: 'seriesList', maxlength: 120, 'aria-label': 'Series', oninput: e => this.edit(it, { series: e.target.value.trim() || null }), onkeydown: e => e.stopPropagation() }), el('datalist', { id: 'seriesList' }, names.map(n => el('option', { value: n })))]
        : el('button', { class: 'chip', text: it.series, onclick: () => this.go({ type: 'series', value: it.series, label: it.series }) })));
    }

    const csec = el('section', { class: 'vi-sec' }, el('h4', { id: 'viCmtH', text: it.nc ? `Comments (${it.nc})` : 'Comments' }), el('div', { class: 'cmts', id: 'viCmts' }));
    if (can('comment')) {
      const ta = el('textarea', { class: 'inp', rows: 2, placeholder: 'Write a comment', maxlength: 4000, 'aria-label': 'Write a comment' });
      const post = () => { const v = ta.value.trim(); if (!v) return; ta.disabled = true; api('POST', `/api/items/${it.id}/comments`, { text: v }).then(c => { ta.disabled = false; ta.value = ''; it.nc++; this.dirty = true; if (this.item === it && this.more) { this.more.comments.push(c); this.paintComments(); } }, e => { ta.disabled = false; toast(e.message); }); };
      ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post(); e.stopPropagation(); });
      csec.append(el('div', { class: 'cmt-new' }, ta, el('button', { class: 'btn small primary', text: 'Post comment', onclick: post })));
    } else csec.append(el('p', { class: 'vi-note', text: 'You can view but not comment. The owner can change that in People and settings.' }));
    box.append(csec); this.paintComments();

    /* --- read from the image by a machine (arrives with the local worker) --- */
    /* --- people in the picture: for the owner and editors, in a space where recognition is on --- */
    this.faceBox(null);
    const spOf = S.spaces.find(s => s.id === it.space);
    if (seesPeople() && spOf && spOf.people && it.kind === 'photo' && it.status === 'ready') {
      const psec = el('section', { class: 'vi-sec', id: 'viPeople', hidden: true }, el('h4', { text: 'People' }), el('div', { class: 'fvals wrap' }));
      box.append(psec);
      api('GET', `/api/items/${it.id}/faces`).then(r => { if (this.item === it && psec.isConnected) this.paintFaces(it, psec, r.faces); }, () => { });
    }

    /* Blue is what the machine said, amber is what a person said. A person may correct any of it, and a correction is never overwritten. */
    if (it.ai.status === 'done' && (it.ai.caption || it.ai.scene || it.ai.things.length || it.ai.text || can('tag'))) {
      const may = can('tag'), mine = k => it.ai.locked.includes(k);
      const fix = (body, apply, done) => attempt(api('PATCH', `/api/items/${it.id}/ai`, body), done).then(() => { apply(); it.hay = null; this.dirty = true; if (this.item === it) this.info(true); Sync.soon(); }, () => { });
      const lock = k => { if (!mine(k)) it.ai.locked.push(k); };
      const ai = el('section', { class: 'vi-sec ai', id: 'viAi' }, el('h4', {}, el('span', { html: icon('cpu', 14) }), ' Seen by your worker'));
      const cap = el('p', { class: 'ai-cap' + (mine('caption') ? ' mine' : ''), text: it.ai.caption || (may ? '' : '') });
      const editCap = () => {
        const ta = el('textarea', { class: 'inp ai-edit', rows: 3, maxlength: 2000, 'aria-label': 'Caption', value: it.ai.caption, onkeydown: e => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); if (e.key === 'Escape') this.info(true); } });
        const save = () => { const v = ta.value.trim().replace(/\s+/g, ' '); if (v === it.ai.caption) return this.info(true); fix({ caption: v }, () => { it.ai.caption = v; lock('caption'); }, 'Caption corrected'); };
        cap.replaceWith(el('div', { class: 'ai-capedit' }, ta, el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Cancel', onclick: () => this.info(true) }), el('button', { class: 'btn small primary', text: 'Save caption', onclick: save }))));
        capTools.hidden = true; ta.focus();
      };
      const capTools = el('div', { class: 'ai-by' }, mine('caption') ? el('span', { class: 'by-me', text: 'Corrected by a person.' }) : it.ai.caption ? el('span', { text: 'Written by the worker.' }) : null,
        may ? el('button', { class: 'linkbtn', id: 'viAiCapEdit', text: it.ai.caption ? 'Correct the caption' : 'Write a caption', onclick: editCap }) : null);
      if (it.ai.caption) ai.append(cap); else cap.hidden = true;
      if (it.ai.caption || may) ai.append(capTools);
      const tw = el('div', { class: 'fvals wrap', id: 'viAiChips' });
      const x = (label, onclick) => el('button', { class: 'chip-x', title: label, 'aria-label': label, html: icon('x', 12), onclick });
      if (it.ai.scene) tw.append(el('span', { class: 'chipw' }, el('button', { class: 'chip strong ' + (mine('scene') ? 'mine' : 'ai'), text: it.ai.scene, title: (mine('scene') ? 'Set by a person. ' : 'Chosen by the worker. ') + 'Click to find this scene.', onclick: () => this.go({ type: 'scene', value: it.ai.scene, label: it.ai.scene }) })));
      if (may) tw.append(el('button', { class: 'chip dashed', id: 'viAiScene', text: it.ai.scene ? 'Change scene' : 'Set a scene', onclick: e => popover(e.currentTarget, el('div', { class: 'menu scenes' }, [...SCENES, null].map(sc => el('button', { class: 'mi' + (sc === it.ai.scene ? ' on' : ''), text: sc || 'No scene', onclick: () => { closePop(); if (sc === it.ai.scene) return; fix({ scene: sc }, () => { it.ai.scene = sc; lock('scene'); }, sc ? `Scene set to ${sc}` : 'Scene removed'); } })))) }));
      it.ai.things.forEach(t => tw.append(el('span', { class: 'chipw' }, el('button', { class: 'chip ' + (t.by === 'person' ? 'mine' : 'ai'), title: (t.by === 'person' ? 'Added by a person.' : `Seen by the worker. Confidence ${Math.round(t.c * 100)}%.`) + ' Click to find more.', onclick: () => this.go({ type: 'thing', value: t.l, label: t.l }) }, el('span', { text: t.l }), t.by === 'person' ? null : el('i', { class: 'conf', style: { '--c': t.c } })),
        may ? x(`Remove ${t.l}`, () => fix({ remove: [t.l] }, () => { it.ai.things = it.ai.things.filter(o => o !== t); }, `Removed ${t.l}. It will not come back.`)) : null)));
      if (may) {
        const add = el('input', { class: 'inp chip-add', id: 'viAiAdd', placeholder: 'Add what is in it', maxlength: 60, 'aria-label': 'Add something that is in the picture', onkeydown: e => { e.stopPropagation(); if (e.key !== 'Enter') return; const v = norm(add.value.trim()).replace(/\s+/g, ' '); if (!v) return; if (it.ai.things.some(t => t.l === v && t.by === 'person')) { add.value = ''; return; } fix({ add: [v] }, () => { it.ai.things = [{ l: v, c: 1, by: 'person' }, ...it.ai.things.filter(t => t.l !== v)]; }, `Added ${v}`); } });
        tw.append(add);
      }
      ai.append(tw);
      if (it.ai.text) ai.append(el('p', { class: 'ai-text', id: 'viAiText' }, el('span', { class: 'muted', text: 'Text in the picture: ' }), it.ai.text));
      box.append(ai);
    }

    if (it.status === 'ready') {
      const pal = el('div', { class: 'palette' }); it.palette.forEach(c => pal.append(el('button', { class: 'pal', style: { background: c }, title: `${c}. Find more ${bucketOf(c)} photos`, 'aria-label': 'Find ' + bucketOf(c), onclick: () => this.go({ type: 'color', value: bucketOf(c), label: facetName('color', bucketOf(c)) }) })));
      box.append(el('section', { class: 'vi-sec' }, el('h4', { text: 'Colors' }), pal));
    }

    /* --- where --- */
    if (this.miniMap) { this.miniMap.remove(); this.miniMap = null; }
    const where = el('section', { class: 'vi-sec' }, el('h4', { text: 'Where' }));
    const locate = () => LocDialog.open([it], () => { this.dirty = true; if (this.item === it) this.info(true); });
    if (it.lat != null) {
      const mm = el('div', { class: 'minimap', id: 'miniMap' });
      if (it.spot) where.append(el('p', { class: 'vi-row', id: 'viSpot' }, el('button', { class: 'linkbtn', text: it.spot, title: 'Find more pictures from here', onclick: () => this.go({ type: 'spot', value: it.spot, label: it.spot }) }), el('span', { class: 'muted', text: SPOT_KIND[it.spotKind] || '' })));
      where.append(mm, el('p', { class: 'vi-row' }, el('span', { text: (pl ? pl.name + ', ' + pl.region : 'Unnamed place') }), el('span', { class: 'muted', text: `${it.lat.toFixed(4)}, ${it.lng.toFixed(4)}${it.locSrc === 'manual' ? ', set by hand' : it.locSrc === 'suggested' ? ', accepted from a suggestion' : ''}` })),
        el('p', { class: 'vi-row' }, el('button', { class: 'linkbtn', text: 'Open in map view', onclick: () => { this.close(); go('map'); MapView.focus(it); } }), edit ? el('button', { class: 'linkbtn', id: 'viLocate', text: 'Change', onclick: locate }) : null));
      box.append(where);
      setTimeout(() => { if (this.item !== it || !mm.isConnected) return; this.miniMap = MapView.locator(mm, it); }, 30);
    } else if (edit) {
      /* a suggested place: a guess, shown as one, that becomes the location only when a person accepts it */
      const sg = Sugg.by.get(it.id);
      if (sg) {
        const after = () => { this.dirty = true; if (this.item === it) this.info(true); };
        where.append(el('div', { class: 'vi-sugg', id: 'viSugg' }, el('p', {}, el('span', { html: icon('cpu', 14) }), ' Possibly ', el('b', { text: sg.name })), el('small', { class: 'ai-note', text: `${Sugg.how(sg)}. ${sg.why}`.trim() }),
          el('div', { class: 'rowr' }, el('button', { class: 'btn small', id: 'viSuggNo', text: 'Not there', onclick: () => Sugg.answer('reject', [sg], after) }), sg.lat != null ? el('button', { class: 'btn small primary', id: 'viSuggYes', text: 'Accept', onclick: () => Sugg.answer('accept', [sg], after) }) : null)));
      }
      where.append(el('p', { class: 'vi-note', text: 'This file carries no location. Add one to put it on the map.' }), el('div', { class: 'rowr' }, el('button', { class: 'btn small', id: 'viLocate', html: icon('pin', 16) + '<span>Set location</span>', onclick: locate }))); box.append(where); }

    const rows = [];
    if (it.cam) rows.push(['Camera', it.cam + (it.lens ? ', ' + it.lens : '')]);
    if (it.shutter) rows.push(['Exposure', [it.shutter + ' s', it.fnum ? 'f/' + it.fnum : '', it.iso ? 'ISO ' + it.iso : '', it.focal ? it.focal + ' mm' : ''].filter(Boolean).join(', ')]);
    if (it.status === 'ready') rows.push(['Size', `${fmt.n(it.w)} × ${fmt.n(it.h)} (${(it.w * it.h / 1e6).toFixed(1)} MP)`]);
    rows.push(['File', it.fileName]); if (it.duration) rows.push(['Length', fmt.dur(it.duration)]);
    rows.push(['Added', fmt.dayShort(it.added)]);
    const dl = el('dl', { class: 'kv' }, rows.map(r => [el('dt', { text: r[0] }), el('dd', { text: r[1] })]));
    if (edit) {
      const d = new Date(it.date), p = n => String(n).padStart(2, '0'), val = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
      const inp = el('input', { class: 'inp', type: 'datetime-local', value: val, 'aria-label': 'Date taken', onkeydown: e => e.stopPropagation(), onchange: e => { const v = e.target.value; if (!v) return; attempt(api('PATCH', '/api/items/' + it.id, { d: v }), 'Date saved').then(() => { it.date = new Date(v).getTime(); it.dateSrc = 'manual'; it.hay = null; this.dirty = true; Sync.soon(); }); } });
      dl.append(el('dt', { text: 'Taken' }), el('dd', {}, inp));
    }
    box.append(el('section', { class: 'vi-sec' }, el('h4', { text: 'Details' }), dl));

    box.append(el('section', { class: 'vi-sec' }, el('h4', { text: S.cfg.storage === 's3' ? 'Files in your bucket' : 'Files on disk' }), el('dl', { class: 'kv files', id: 'viFiles' }))); this.files();

    const copies = S.items.filter(i => i.copyOf === it.id);
    if (copies.length) { const vs = el('div', { class: 'simgrid' }); copies.forEach(c => { const im = el('img', { alt: label(c) }); vs.append(el('button', { class: 'sim', style: { aspectRatio: c.ar, background: c.ghost }, onclick: () => this.open(c.id, [it, ...copies]) }, im)); loadInto(im, c, 'thumb'); }); box.append(el('section', { class: 'vi-sec' }, el('h4', { text: 'Edited copies' }), vs)); }

    /* near duplicates of this picture, with a way to keep one and trash the rest */
    const twins = Dupes.group(it).filter(o => o !== it);
    if (twins.length) {
      const all = [it, ...twins];
      box.append(el('section', { class: 'vi-sec', id: 'viDupes' }, el('h4', { text: 'Near duplicates' }),
        el('p', { class: 'vi-note', text: `${twins.length === 1 ? 'One other picture looks' : twins.length + ' other pictures look'} almost the same as this one.${Dupes.isBest(it) ? ' This one has the most detail.' : ''}` }),
        el('div', { class: 'btnrow' }, el('button', { class: 'btn small', text: 'Show them together', onclick: () => this.go({ type: 'flag', value: 'dupes', label: 'Near duplicates' }) }),
          can('del') ? el('button', { class: 'btn small', id: 'viDupKeep', text: `Keep this one, trash the other ${twins.length === 1 ? 'one' : twins.length}`, onclick: e => popover(e.currentTarget, el('div', { class: 'confirm' }, el('p', { text: `Move ${fmt.plural(twins.length, 'item')} to the trash and keep this one? They stay in the trash until it is emptied.` }), el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Leave them', onclick: closePop }), el('button', { class: 'btn small danger', text: 'Move to trash', onclick: () => { closePop(); removeItems(twins).then(() => { Dupes.load(true); this.dirty = true; if (this.item === it) this.info(true); }, () => { }); } })))) }) : null)));
    }
    /* More like this: by what the pictures look like once a worker has read them, and by scene, labels and tags until then */
    const simSec = el('section', { class: 'vi-sec', id: 'viSim', hidden: true }, el('h4', { text: 'More like this' }), el('div', { class: 'simgrid' }));
    const paintSim = sim => { const sg = $('.simgrid', simSec); sg.innerHTML = ''; simSec.hidden = !sim.length; sim.forEach(s => { const im = el('img', { alt: label(s), draggable: false }); sg.append(el('button', { class: 'sim', style: { aspectRatio: s.ar, background: s.ghost }, onclick: () => this.open(s.id, [it, ...sim]) }, im)); loadInto(im, s, 'thumb'); }); };
    paintSim(this.similar(it)); box.append(simSec);
    if (S.me && S.me.id && it.status === 'ready') {
      if (it._sim && Date.now() - it._sim.at < 60000) { if (it._sim.items.length) { simSec.dataset.by = 'look'; paintSim(it._sim.items); } }
      else api('GET', `/api/items/${it.id}/similar`).then(r => { const items = r.ids.map(id => S.byId.get(id)).filter(Boolean).slice(0, 9); it._sim = { at: Date.now(), items: r.state === 'ok' ? items : [] }; if (this.item === it && r.state === 'ok' && items.length && simSec.isConnected) { simSec.dataset.by = 'look'; paintSim(items); } }, () => { });
    }
    $$('textarea.vi-title, textarea.vi-desc', box).forEach(autosize);
    box.scrollTop = keepScroll ? top : 0;
  },
  paintComments() {
    const cm = $('#viCmts'), it = this.item; if (!cm || !it) return; cm.innerHTML = '';
    const list = this.more ? this.more.comments : null;
    $('#viCmtH').textContent = it.nc ? `Comments (${it.nc})` : 'Comments';
    if (!list) { if (it.nc) cm.append(el('p', { class: 'muted', text: 'Loading comments' })); return; }
    if (!list.length) cm.append(el('p', { class: 'muted', text: can('comment') ? 'No comments yet. Say something about this one.' : 'No comments yet.' }));
    list.forEach(c => { const u = userById(c.user); cm.append(el('div', { class: 'cmt' }, avatarEl(u), el('div', {}, el('p', { class: 'cmt-h' }, el('b', { text: u.name }), el('span', { class: 'muted', text: ' ' + fmt.ago(c.t) })), el('p', { class: 'cmt-t', text: c.text })), (c.user === S.me.id || can('admin')) ? el('button', { class: 'iconbtn tiny', 'aria-label': 'Delete comment', html: icon('x', 12), onclick: () => api('DELETE', '/api/comments/' + c.id).then(() => { list.splice(list.indexOf(c), 1); it.nc = Math.max(0, it.nc - 1); this.dirty = true; this.paintComments(); }, e => toast(e.message)) }) : null)); });
  },
  likes() { const n = $('#viLikes'), it = this.item; if (!n || !it) return; n.hidden = !it.likes.length; n.innerHTML = it.likes.length ? icon('heart', 14) + '<span>Liked by ' + esc(likedBy(it)) + '</span>' : ''; },
  /* where the three copies of this item live in storage */
  files() {
    const files = $('#viFiles'), it = this.item, m = this.more; if (!files || !it) return; files.innerHTML = '';
    if (it.status !== 'ready') { files.append(el('dt', { text: 'Original' }), el('dd', {}, el('span', { text: it.bytes.orig ? fmt.bytes(it.bytes.orig) : 'Arriving' }))); return; }
    const [dw, dh] = Img.size(it, 'display'), [tw2, th2] = Img.size(it, 'thumb');
    const frow = (name, path, dims, bytes) => files.append(el('dt', { text: name }), el('dd', {}, el('span', { text: [dims, bytes ? fmt.bytes(bytes) : ''].filter(Boolean).join(', ') }), path ? el('code', { text: path }) : null));
    frow('Original', m && m.keys.orig, it.kind === 'video' ? fmt.dur(it.duration || 0) : `${it.w} × ${it.h}`, it.bytes.orig);
    if (it.hasFull) frow('Full size for browsers', m && m.keys.full, `${it.w} × ${it.h}`, m && m.bytesFull);
    frow('Display', m && m.keys.display, `${dw} × ${dh}`, it.bytes.disp); frow('Thumbnail', m && m.keys.thumb, `${tw2} × ${th2}`, it.bytes.thumb);
  },
  /* without a machine reading the pictures yet, likeness comes from what people wrote, the colors, the series and the place */
  /* the people section: a chip for every face, with the face outlined on the picture while the pointer rests on its chip */
  paintFaces(it, sec, faces) {
    const tw = $('.fvals', sec); tw.innerHTML = ''; sec.hidden = !faces.length;
    const again = () => api('GET', `/api/items/${it.id}/faces`).then(r => { this.dirty = true; Sync.soon(); if (this.item === it && sec.isConnected) this.paintFaces(it, sec, r.faces); }, () => { });
    const act = (p, done) => attempt(p, done).then(again, () => { });
    const no = (f, who) => el('button', { class: 'chip-x', title: `This is not ${who}`, 'aria-label': `This is not ${who}`, html: icon('x', 12), onclick: () => { this.faceBox(null); act(api('POST', '/api/faces/reject', { faceIds: [f.id] }), `Not ${who}`); } });
    faces.forEach(f => {
      const hov = { onmouseenter: () => this.faceBox(f.box), onmouseleave: () => this.faceBox(null), onfocus: () => this.faceBox(f.box), onblur: () => this.faceBox(null) };
      if (f.person) { const who = personName(f.person); tw.append(el('span', { class: 'chipw', data: { face: f.id } }, el('button', { class: 'chip ' + (f.status === 'auto' ? 'ai' : 'mine'), text: who, title: (f.status === 'auto' ? 'Named automatically.' : 'Named by a person.') + ' Click to find more pictures of them.', ...hov, onclick: () => this.go({ type: 'person', value: f.person, label: who }) }), no(f, who))); }
      else if (f.status === 'suggested' && f.suggested) { const who = personName(f.suggested); tw.append(el('span', { class: 'chipw', data: { face: f.id } }, el('button', { class: 'chip ai dashed', text: who + '?', title: 'Suggested by the worker. Click if this is right.', ...hov, onclick: () => act(api('POST', '/api/faces/name', { faceIds: [f.id], personId: f.suggested }), `Named ${who}`) }), no(f, who))); }
      else tw.append(el('button', { class: 'chip dashed', data: { face: f.id }, text: 'Who is this?', ...hov, onclick: e => {
        const inp = el('input', { class: 'inp', placeholder: 'Type a name, press Enter', maxlength: 80, 'aria-label': 'Name', onkeydown: ev => { ev.stopPropagation(); if (ev.key === 'Enter' && inp.value.trim()) { closePop(); act(api('POST', '/api/faces/name', { faceIds: [f.id], name: inp.value.trim() }), `Named ${inp.value.trim()}`); } } });
        const known = Object.entries(PERSONS).filter(([id]) => S.items.some(i => i.space === it.space && i.people.includes(id))).map(([id, name]) => el('button', { class: 'chip mine', text: name, onclick: () => { closePop(); act(api('POST', '/api/faces/name', { faceIds: [f.id], personId: id }), `Named ${name}`); } }));
        popover(e.currentTarget, el('div', { class: 'tagpop' }, el('p', { class: 'pop-h', text: 'Who is this?' }), inp, el('div', { class: 'fvals wrap' }, known), el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Ignore this face', onclick: () => { closePop(); act(api('POST', '/api/faces/ignore', { faceIds: [f.id], as: 'ignored' }), 'Set aside'); } })))); inp.focus();
      } }));
    });
  },
  /* an outline around one face, laid over the picture. The picture itself is not changed or cut. */
  faceBox(b) {
    let n = $('#vwFaceBox'); if (!b || !this.item) { if (n) n.remove(); return; }
    const r = this.rect(); if (!n) { n = el('div', { id: 'vwFaceBox', class: 'facebox' }); $('#vwFrame').append(n); }
    Object.assign(n.style, { left: r.x + b[0] * r.w + 'px', top: r.y + b[1] * r.h + 'px', width: b[2] * r.w + 'px', height: b[3] * r.h + 'px' });
  },
  similar(it) {
    const things = new Set(it.ai.things.map(t => t.l)), tags = new Set(it.tags);
    return S.items.filter(o => o !== it && o.space === it.space && o.status === 'ready' && o.copyOf !== it.id && o.id !== it.copyOf).map(o => [o,
      (it.ai.scene && o.ai.scene === it.ai.scene ? 3 : 0) + o.ai.things.filter(t => things.has(t.l)).length * .6 + o.tags.filter(t => tags.has(t)).length * 1.2 +
      (it.series && o.series === it.series ? 2 : 0) + o.buckets.filter(b => it.buckets.includes(b)).length * .5 + (it.place && o.place === it.place ? .4 : 0) - (Math.abs(o.date - it.date) < dayMs ? 1 : 0)
    ]).filter(x => x[1] >= 1.5).sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0]);
  },
  /* rectangle the photo really occupies inside the frame (it is never cropped, so there are margins) */
  rect() { const f = $('#vwFrame'), it = this.item, fw = f.clientWidth, fh = f.clientHeight; let w = fw, h = w / it.ar; if (h > fh) { h = fh; w = h * it.ar; } return { x: (fw - w) / 2, y: (fh - h) / 2, w, h }; },
  /* is the pointer on the picture itself, not on the margins around it */
  onPicture(e) {
    const it = this.item; if (!it || it.kind === 'video' || it.status !== 'ready' || e.target.closest('button')) return false;
    const f = $('#vwFrame').getBoundingClientRect(), r = this.rect(), px = e.clientX - f.left, py = e.clientY - f.top;
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  },
  moveLoupe(e) {
    const lp = $('#loupe'), it = this.item; if (!it || it.kind === 'video' || it.status !== 'ready' || Zoom.item) return;
    const f = $('#vwFrame').getBoundingClientRect(), px = e.clientX - f.left, py = e.clientY - f.top, r = this.rect(), inside = this.onPicture(e);
    $('#vwFrame').classList.toggle('over', inside);
    if (!inside || !this.loupeOn) { lp.classList.remove('show'); return; }
    const D = lp.offsetWidth || 230, M = this.mag;
    lp.style.left = px - D / 2 + 'px'; lp.style.top = py - D / 2 + 'px';
    lp.style.backgroundSize = `${r.w * M}px ${r.h * M}px`; lp.style.backgroundPosition = `${-((px - r.x) * M - D / 2)}px ${-((py - r.y) * M - D / 2)}px`;
    lp.classList.add('show');
    if (!this._origAsked && r.w * M > Img.size(it, 'display')[0] * 1.15) { this._origAsked = true; clearTimeout(this._ot); this._ot = setTimeout(() => { if (this.item === it && lp.classList.contains('show')) { const url = Img.url(it, 'orig'), big = new Image(); big.onload = () => { if (this.item === it) lp.style.backgroundImage = `url("${url}")`; }; big.src = url; } else this._origAsked = false; }, 500); }
  }
};
/* Start a video with the volume the person last chose. If the browser will not start sound without a click first,
   start silent and say so through forced(true), so the caller can offer the sound. Used by the viewer and the story player. */
function playWithSound(v, stillHere, forced) {
  v.volume = clamp(+store.get('volume', '1') || 0, 0, 1); v.muted = store.get('muted', '0') === '1';
  const p = v.play(); if (!p) return;
  p.catch(e => {
    if (!stillHere() || e.name !== 'NotAllowedError' || v.muted) return;
    forced(true); v.muted = true;
    v.play().catch(() => { if (stillHere()) { forced(false); v.muted = false; } });
  });
}
function autosize(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }

/* ---------- zoom: the original at full size, inside the viewer's own frame ---------- */
const Zoom = {
  item: null, s: 1, x: 0, y: 0, fit: 1, hx: 0, hy: 0,
  /* the fitted picture as the zoom layer sees it: the smallest size, and the place to come back to */
  measure() {
    const it = this.item, r = Viewer.rect(), f = $('#vwFrame').getBoundingClientRect(), st = $('#zmStage').getBoundingClientRect();
    this.fit = r.w / it.w; this.hx = f.left - st.left + r.x; this.hy = f.top - st.top + r.y;
  },
  /* cx, cy: the point to zoom into, measured from the zoom layer's corner. Without them, the middle. */
  open(it, cx, cy) {
    if (!it || it.status !== 'ready' || it.kind === 'video') return;
    this.item = it; const layer = $('#vwZoom'), img = $('#zmImg'), lp = $('#loupe'), frame = $('#vwFrame');
    lp.classList.remove('show'); frame.classList.remove('over'); frame.classList.add('zoomed'); layer.hidden = false;
    img.style.width = it.w + 'px'; img.style.height = it.h + 'px'; img.alt = label(it);
    img.src = Img.url(it, 'display');
    this.measure(); this.s = this.fit; this.x = this.hx; this.y = this.hy; img.classList.remove('anim'); this.apply();
    const c = this.center(); if (cx == null) { cx = c[0]; cy = c[1]; }
    void img.offsetWidth; img.classList.add('anim'); clearTimeout(this._at); this._at = setTimeout(() => img.classList.remove('anim'), 260);
    this.zoomAt(cx, cy, this.fit * 1.15 < 1 ? 1 : this.fit * 2);
    const ld = $('#zmLoad'); ld.hidden = false; ld.textContent = 'Loading the original';
    const url = Img.url(it, 'orig'), im = new Image();
    im.onload = () => { if (this.item === it) { img.src = url; ld.hidden = true; } };
    im.onerror = () => { if (this.item === it) ld.textContent = 'The original could not be loaded. Showing the display copy.'; };
    im.src = url;
  },
  close() { if (!this.item) return; this.item = null; clearTimeout(this._at); $('#vwZoom').hidden = true; $('#vwFrame').classList.remove('zoomed'); $('#zmImg').removeAttribute('src'); },
  toggle(it, cx, cy) { if (this.item) this.close(); else this.open(it, cx, cy); },
  apply() { $('#zmImg').style.transform = `translate(${this.x}px,${this.y}px) scale(${this.s})`; this.hud(); },
  hud() { const it = this.item; if (!it) return; $('#zmInfo').textContent = `${it.fileName}, ${fmt.n(it.w)} × ${fmt.n(it.h)}, ${Math.round(this.s * 100)}%`; },
  zoomAt(cx, cy, s2) {
    s2 = clamp(s2, this.fit, Math.max(8, this.fit * 4));
    if (s2 <= this.fit * 1.001) { this.s = this.fit; this.x = this.hx; this.y = this.hy; return this.apply(); }
    this.x = cx - (cx - this.x) * (s2 / this.s); this.y = cy - (cy - this.y) * (s2 / this.s); this.s = s2; this.apply();
  },
  center() { const st = $('#zmStage'); return [st.clientWidth / 2, st.clientHeight / 2]; }
};

function initViewer() {
  /* a video that cannot be played says so. When its copy for browsers arrives while it is open, the copy takes over. */
  $('#vwVideo').addEventListener('error', () => { const it = Viewer.item; if (it && it.kind === 'video' && !$('#viewer').hidden) Viewer.playNote(it, true, true); });
  Bus.on('synced', () => {
    const it = Viewer.item, v = $('#vwVideo'); if (!it || it.kind !== 'video' || $('#viewer').hidden || v.hidden || v.dataset.play === (it.play || '')) return;
    v.dataset.play = it.play || ''; Viewer.playNote(it, it.status === 'ready');
    if (it.play === 'ready' && (v.paused || v.error)) { v.src = Img.media(it); Viewer.playVideo(it); }
  });
  Bus.on('synced', () => Viewer.synced());
  window.addEventListener('pagehide', () => Viewer.flush());
  $('#vwClose').onclick = () => Viewer.close(); $('#vwPrev').onclick = () => Viewer.step(-1); $('#vwNext').onclick = () => Viewer.step(1);
  const frame = $('#vwFrame');
  frame.addEventListener('pointermove', e => Viewer.moveLoupe(e)); frame.addEventListener('pointerleave', () => { $('#loupe').classList.remove('show'); frame.classList.remove('over'); });
  frame.addEventListener('wheel', e => { if (!frame.classList.contains('over') || !Viewer.loupeOn) return; e.preventDefault(); Viewer.mag = clamp(Viewer.mag * Math.exp(-e.deltaY * .0015), 1.4, 8); Viewer._origAsked = false; Viewer.moveLoupe(e); }, { passive: false });
  frame.addEventListener('click', e => {
    if (Viewer.onPicture(e)) { /* the zoom layer is the frame plus its side margins */ const r = frame.getBoundingClientRect(), m = parseFloat(getComputedStyle(frame).marginLeft) || 0; Zoom.open(Viewer.item, e.clientX - r.left + m, e.clientY - r.top); }
    else if (e.target === frame) Viewer.close();
  });
  /* the dimmed library around the modal closes it */
  $('#viewer').addEventListener('click', e => { if (e.target === e.currentTarget) Viewer.close(); });
  $('#vwFold').onclick = () => Viewer.fold(!$('#vwBox').classList.contains('noinfo'), true);
  /* With fingers. One finger: sideways steps to the next or the one before, down closes. Two fingers: pinch to zoom,
     in place, on the same zoom layer the mouse uses. Listened for on the way down (capture) so it also sees the
     fingers that land on the zoom layer. */
  const touch = new Map(); let swipe = null, pinch = null;
  const mid = () => { const [a, b] = [...touch.values()], r = $('#zmStage').getBoundingClientRect(), fr = frame.getBoundingClientRect(); return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2 - (r.width ? r.left : fr.left), cy: (a.y + b.y) / 2 - (r.width ? r.top : fr.top) }; };
  const slide = (dx, dy) => { const im = $('#vwImg'); frame.classList.toggle('swiping', !!(dx || dy)); im.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : ''; im.style.opacity = dy > 0 ? String(clamp(1 - dy / 500, .35, 1)) : ''; };
  frame.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || e.target.closest('video, button')) return;
    touch.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touch.size === 1) swipe = Zoom.item ? null : { x: e.clientX, y: e.clientY, t: Date.now(), dir: '' };
    else if (touch.size === 2) { swipe = null; slide(0, 0); const m = mid(); pinch = { d0: m.d, s0: Zoom.item ? Zoom.s : 0 }; Viewer.pinching = true; }
  }, true);
  frame.addEventListener('pointermove', e => {
    const p = touch.get(e.pointerId); if (!p) return; p.x = e.clientX; p.y = e.clientY;
    if (pinch && touch.size === 2) {
      const m = mid(), k = m.d / pinch.d0, it = Viewer.item;
      if (!Zoom.item) { if (k < 1.12 || !it || it.kind === 'video' || it.status !== 'ready') return; Zoom.open(it, m.cx, m.cy); $('#zmImg').classList.remove('anim'); Zoom.zoomAt(m.cx, m.cy, Zoom.fit * k); pinch = { d0: m.d, s0: Zoom.s }; return; }
      Zoom.zoomAt(m.cx, m.cy, pinch.s0 * k); e.stopPropagation(); return;
    }
    if (!swipe) return; const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    if (!swipe.dir) { if (Math.hypot(dx, dy) < 12) return; swipe.dir = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'; }
    if (swipe.dir === 'x') slide(dx, 0); else slide(0, Math.max(0, dy));
  }, true);
  const lift = e => {
    if (!touch.delete(e.pointerId)) return;
    if (pinch) {
      if (touch.size < 2) { pinch = null; $('#zmStage')._moved = true; setTimeout(() => { Viewer.pinching = false; }, 60); if (Zoom.item && Zoom.s <= Zoom.fit * 1.03) Zoom.close(); Viewer.swallow = Date.now(); }
      return;
    }
    const s = swipe; swipe = null; if (!s) return; const dx = e.clientX - s.x, dy = e.clientY - s.y, quick = Date.now() - s.t < 320;
    slide(0, 0);
    if (!s.dir || e.type === 'pointercancel') return;
    Viewer.swallow = Date.now();   // the click that follows a swipe must not open the zoom
    if (s.dir === 'x' && (Math.abs(dx) > 70 || (quick && Math.abs(dx) > 30))) Viewer.step(dx < 0 ? 1 : -1);
    else if (s.dir === 'y' && (dy > 110 || (quick && dy > 50))) Viewer.close();
  };
  frame.addEventListener('pointerup', lift, true); frame.addEventListener('pointercancel', lift, true);
  frame.addEventListener('click', e => { if (Date.now() - (Viewer.swallow || 0) < 350) { e.stopPropagation(); e.preventDefault(); } }, true);
  // video
  const vid = $('#vwVideo');
  vid.addEventListener('volumechange', () => { if (Viewer._forcedMute || !Viewer._playing) return; store.set('volume', String(vid.volume)); store.set('muted', vid.muted ? '1' : '0'); $('#vwUnmute').hidden = true; });
  $('#vwUnmute').onclick = e => { e.stopPropagation(); Viewer.unmute(); };
  // zoom, in place: drag to move, wheel to zoom, a plain click goes back to the fitted picture
  const st = $('#zmStage'); let drag = null;
  st.addEventListener('wheel', e => { e.preventDefault(); e.stopPropagation(); const r = st.getBoundingClientRect(); Zoom.zoomAt(e.clientX - r.left, e.clientY - r.top, Zoom.s * Math.exp(-e.deltaY * .0016)); }, { passive: false });
  st.addEventListener('pointerdown', e => { if (e.button) return; drag = { x: e.clientX - Zoom.x, y: e.clientY - Zoom.y, x0: e.clientX, y0: e.clientY, moved: false }; st.setPointerCapture(e.pointerId); });
  st.addEventListener('pointermove', e => { if (!drag || Viewer.pinching) { if (Viewer.pinching && drag) { drag.x = e.clientX - Zoom.x; drag.y = e.clientY - Zoom.y; } return; } if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return; drag.moved = true; st.classList.add('grab'); Zoom.x = e.clientX - drag.x; Zoom.y = e.clientY - drag.y; Zoom.apply(); });
  const drop = () => { st.classList.remove('grab'); const d = drag; drag = null; return d; };
  st.addEventListener('pointercancel', drop);
  st.addEventListener('pointerup', () => { const d = drop(); st._moved = !!(d && d.moved); });
  st.addEventListener('click', e => { e.stopPropagation(); if (!st._moved) Zoom.close(); st._moved = false; });
  $('#vwZoom').addEventListener('click', e => { e.stopPropagation(); const b = e.target.closest('[data-z]'); if (!b) return; const [cx, cy] = Zoom.center(); const a = b.dataset.z; if (a === 'fit') Zoom.close(); else if (a === '100') Zoom.zoomAt(cx, cy, 1); else if (a === 'in') Zoom.zoomAt(cx, cy, Zoom.s * 1.4); else if (a === 'out') Zoom.zoomAt(cx, cy, Zoom.s / 1.4); });
  window.addEventListener('resize', () => Zoom.close());
}
