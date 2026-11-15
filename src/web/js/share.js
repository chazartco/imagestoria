/* ---------- sharing a story with a public link ----------
   Two halves. ShareLinks is what an owner or editor sees in the Share sheet: the links of a story and their options.
   Share is what a visitor's browser runs when it opens /s/<token>: the story page and the slideshow, and nothing else of the app. */
const ShareLinks = {
  mount(box, s) {
    const list = el('div', { class: 'sl-list', id: 'slList' }, el('p', { class: 'muted', text: 'Loading' }));
    box.innerHTML = '';
    box.append(el('section', { class: 'sh-sec' }, el('h3', { text: 'Public links' }),
      el('p', { class: 'vi-note', text: 'Anyone who has a link can open this story without signing in. They see this story and nothing else in the library. Each link has its own options, and deleting a link ends it at once for everyone who has it.' }),
      list, el('div', { class: 'btnrow' }, el('button', { class: 'btn', id: 'slNew', html: icon('link', 16) + '<span>New link</span>', onclick: () => attempt(api('POST', `/api/stories/${s.id}/links`, {})).then(l => { this.links.push(l); this.paint(list, s); const inp = $(`.slk[data-id="${l.id}"] .sl-url`, list); if (inp) inp.select(); }, () => { }) }))));
    api('GET', `/api/stories/${s.id}/access`).then(r => { this.links = r.links; this.paint(list, s); }, e => { list.innerHTML = ''; list.append(el('p', { class: 'vi-note', text: e.message })); });
  },
  links: [],
  paint(list, s) {
    list.innerHTML = '';
    if (!this.links.length) list.append(el('p', { class: 'muted sl-none', text: 'No links yet. This story can only be read by the people ticked above.' }));
    this.links.forEach(l => {
      const set = (body, done) => attempt(api('PATCH', '/api/story-links/' + l.id, body), done).then(n => { Object.assign(l, n); this.paint(list, s); }, () => this.paint(list, s));
      const url = el('input', { class: 'inp sl-url', readonly: true, value: l.url, 'aria-label': 'Link address', onfocus: e => e.target.select() });
      const copy = () => { const ok = () => toast('Link copied'); if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(l.url).then(ok, () => url.select()); else { url.select(); document.execCommand('copy'); ok(); } };
      const label = el('input', { class: 'inp sl-label', value: l.label, maxlength: 80, 'aria-label': 'A name for this link, to tell them apart', onchange: e => { const v = e.target.value.trim(); if (v && v !== l.label) set({ label: v }); else e.target.value = l.label; }, onkeydown: e => e.stopPropagation() });
      const opt = (key, text, on, off) => el('label', { class: 'sl-opt' }, el('input', { type: 'checkbox', checked: l[key], data: { opt: key }, onchange: e => set({ [key]: e.target.checked }, e.target.checked ? on : off) }), text);
      /* the password: set, changed or taken off with one small form */
      const pw = el('div', { class: 'sl-pw' });
      const askPw = () => {
        const inp = el('input', { class: 'inp', type: 'text', placeholder: 'A password for this link', maxlength: 200, autocomplete: 'off', 'aria-label': 'Password for this link', onkeydown: e => { if (e.key === 'Enter') save(); e.stopPropagation(); } });
        const save = () => { const v = inp.value; if (v.length < 4) return toast('Use at least 4 characters for a link password.'); set({ password: v }, 'This link now asks for the password'); };
        pw.innerHTML = ''; pw.append(inp, el('button', { class: 'btn small primary', text: 'Save password', onclick: save }), el('button', { class: 'btn small', text: 'Cancel', onclick: () => this.paint(list, s) })); inp.focus();
      };
      if (l.hasPassword) pw.append(el('span', { class: 'sl-lock', html: icon('eye', 14) + '<span>Asks for a password</span>' }), el('button', { class: 'linkbtn', text: 'Change', onclick: askPw }), el('button', { class: 'linkbtn', text: 'Remove', onclick: () => set({ password: null }, 'This link no longer asks for a password') }));
      else pw.append(el('button', { class: 'linkbtn', data: { act: 'pw' }, text: 'Add a password', onclick: askPw }));
      list.append(el('div', { class: 'slk', data: { id: l.id } },
        el('div', { class: 'sl-top' }, label, el('span', { class: 'muted sl-used', text: l.uses ? `opened ${fmt.plural(l.uses, 'time')}, last ${fmt.ago(l.lastUsed)}` : 'not opened yet' }),
          el('button', { class: 'iconbtn', title: 'Delete this link', 'aria-label': `Delete the link ${l.label}`, html: icon('trash', 16), onclick: e => popover(e.currentTarget, el('div', { class: 'confirm' }, el('p', { text: 'Delete this link? It stops working at once for everyone who has it.' }), el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Keep', onclick: closePop }), el('button', { class: 'btn small danger', data: { act: 'del' }, text: 'Delete link', onclick: () => { closePop(); attempt(api('DELETE', '/api/story-links/' + l.id), 'Link deleted').then(() => { this.links.splice(this.links.indexOf(l), 1); this.paint(list, s); }, () => { }); } })))) })),
        el('div', { class: 'sl-row' }, url, el('button', { class: 'btn small primary', text: 'Copy link', onclick: copy })),
        el('div', { class: 'sl-opts' }, el('span', { class: 'sl-opt muted' }, 'Can view.'), opt('allowDownload', 'Download the originals', 'This link now allows downloads', 'This link no longer allows downloads'), opt('allowAdd', 'Add their own photos', 'Visitors can now add photos to this story', 'Visitors can no longer add photos'), pw)));
    });
  }
};

const Share = {
  token: null,
  /* called instead of the normal start when the address is /s/<token> */
  async boot(token) {
    this.token = token; S.share = { token, base: '/api/share/' + token, can: {} }; S.cfg = { auth: {}, map: {}, limits: {} };
    document.body.classList.add('share-mode'); document.title = 'A story, shared with ImageStoria';
    let r;
    try { r = await api('GET', '/api/share/' + token); }
    catch (e) { return Gate.show('This link does not work', 'It may have been turned off by the person who shared it. Ask them for a new one.'); }
    if (r.locked) return this.lock();
    this.start(r);
  },
  lock() {
    const [lp, pw] = Gate.field('Password', { type: 'password', required: true, autocomplete: 'off' }), msg = el('p', { class: 'gate-err', role: 'alert', hidden: true }), btn = el('button', { class: 'btn primary', type: 'submit', text: 'Open the story' });
    Gate.show('This story is protected', 'Type the password you were given with the link.', el('form', { class: 'gate-form', onsubmit: e => {
      e.preventDefault(); msg.hidden = true; btn.disabled = true;
      api('POST', `/api/share/${this.token}/unlock`, { password: pw.value }).then(() => api('GET', '/api/share/' + this.token)).then(r => { if (r.locked) throw new Error('That is not the password for this story.'); this.start(r); }, er => { btn.disabled = false; msg.hidden = false; msg.textContent = er.message; pw.select(); });
    } }, lp, msg, btn));
  },
  /* the visitor's whole world: one story and its pictures */
  take(r) {
    S.share.can = r.can; S.cfg.limits = r.limits; S.cfg.musicVersion = r.musicVersion; Object.assign(PLACES, r.places);
    S.items = r.items.map(x => hydrate({ ...x, space: 'share' })); S.byId = new Map(S.items.map(i => [i.id, i]));
    const old = S.stories[0]; S.stories = [{ ...r.story, id: 'share', space: 'share', shared: [], groups: [], by: null, made: 0 }];
    if (old && Stories.cur === old) Stories.cur = S.stories[0];
  },
  start(r) {
    S.me = { id: '', name: 'Visitor', role: 'visitor', color: '#8d9096', caps: {} }; S.users = []; S.spaces = [{ id: 'share', name: '', kind: 'life' }]; S.space = 'share'; S.view = 'stories';
    this.take(r); document.title = r.story.title;
    $('#gate').hidden = true; $('#bootWait').hidden = true; $('#app').hidden = false;
    $('#plClose').onclick = () => Player.close(); $('#plPrev').onclick = () => Player.step(-1); $('#plNext').onclick = () => Player.step(1); $('#plPlay').onclick = () => Player.toggle(); $('#plUnmute').onclick = () => Player.unmute();
    addEventListener('keydown', e => {
      if ($('#player').hidden || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'Escape') Player.close(); else if (e.key === 'ArrowRight') Player.step(1); else if (e.key === 'ArrowLeft') Player.step(-1); else if (e.key === ' ') { e.preventDefault(); Player.toggle(); }
    });
    addEventListener('resize', debounce(() => Stories.relayout(), 150));
    if (!S.items.length) return Gate.show(r.story.title, r.can.add ? 'There are no pictures in this story yet.' : 'There are no pictures in this story at the moment.');
    Stories.open('share');
    return true;
  },
  /* a visitor adds their own photos, when the link allows it */
  pick() { const inp = el('input', { type: 'file', multiple: true, accept: 'image/*,video/*,.heic,.heif', hidden: true, onchange: () => { this.add([...inp.files]); inp.remove(); } }); document.body.append(inp); inp.click(); },
  async add(files) {
    if (!files.length) return; let ok = 0, last = '';
    const note = el('div', { class: 'toast', role: 'status' }, el('span', { text: `Adding ${fmt.plural(files.length, 'file')}` })); $('#toasts').append(note);
    for (const [k, f] of files.entries()) {
      note.firstChild.textContent = `Adding ${k + 1} of ${files.length}: ${f.name}`;
      const fd = new FormData(); fd.set('lastModified', String(f.lastModified || Date.now())); fd.set('tzOffset', String(new Date(f.lastModified || Date.now()).getTimezoneOffset())); fd.set('file', f, f.name);
      try { const res = await fetch(`/api/share/${this.token}/upload`, { method: 'POST', headers: { 'x-afterimage': '1' }, body: fd, credentials: 'same-origin' }); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || 'That file could not be added.'); ok++; }
      catch (e) { last = e.message; }
    }
    note.remove();
    toast(ok ? `Added ${fmt.plural(ok, 'file')}. ${ok === 1 ? 'It appears' : 'They appear'} here once ${ok === 1 ? 'it has' : 'they have'} been processed.${ok < files.length ? ` ${files.length - ok} could not be added: ${last}` : ''}` : `Nothing was added. ${last}`);
    if (ok) this.watch(S.items.length + ok, Date.now() + 120000);
  },
  /* new pictures show up when the server has made their copies */
  watch(want, until) {
    setTimeout(() => api('GET', '/api/share/' + this.token).then(r => {
      if (r.locked) return;
      if (r.items.length > S.items.length) { this.take(r); Stories.repaint(); }
      if (r.items.length < want && Date.now() < until) this.watch(want, until);
    }, () => { }), 2000);
  }
};
