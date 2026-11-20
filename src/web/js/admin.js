/* ---------- people and settings (owner only) ----------
   The page is a board of cards. A card says the one thing worth knowing at a glance, and opens a
   small window over the page with the details and the controls. `modal` holds which window is open
   ("backup", "person:<id>", "space:<id>"), so a redraw after a change puts the same window back. */
const Admin = {
  people: [], over: null, modal: null,
  isOpen() { return !$('#admin').hidden; },
  /* It opens on "Loading", never on what it showed last time: a redraw a moment later would wipe whatever was being typed. */
  open() { if (!can('admin')) return; closePop(); this.over = null; Naming.data = null; this.modal = null; this.dropModal(); $('#admin').hidden = false; this.render(); $('#v-admin').scrollTop = 0; },
  close() { if (!this.isOpen()) return; closePop(); this.modal = null; this.dropModal(); $('#admin').hidden = true; },
  /* Escape closes the window on top first, then the page */
  esc() { if (this.modal) this.closeModal(); else this.close(); },
  async load() {
    this.loadFaces();
    const [p, o, w, pd, pub, exp] = await Promise.all([api('GET', '/api/people'), api('GET', '/api/admin/overview'), api('GET', '/api/admin/workers'), api('GET', '/api/admin/places'), api('GET', '/api/admin/public'), api('GET', '/api/admin/exports')]);
    this.people = p.people; this.over = o; this.work = w; this.placeData = pd; this.pub = pub; this.exp = exp;
  },
  /* Who is in the pictures is the slowest thing on this page to work out in a large library, so the board never waits
     for it. Its cards say they are loading and fill in when the answer arrives. Only that row is drawn again then, and
     a window that is open is left alone unless it is one of theirs: nothing being typed elsewhere is lost. */
  loadFaces() {
    const n = this._fl = (this._fl || 0) + 1; Naming.busy = true;
    Naming.load().catch(() => { Naming.data = null; }).then(() => {
      if (n !== this._fl) return; Naming.busy = false;
      if (!this.isOpen() || !this.over) return;
      const row = $('#adFaces'); if (row) row.replaceWith(this.facesGroup());
      if (['faces', 'auto', 'recog'].includes(this.modal)) this.paintModal(false);
    });
  },
  facesGroup() { return this.group('People in the pictures', `In ${curSpace().name}, the space you are in`, Naming.cards(), 'adFaces'); },
  render() {
    const box = $('#v-admin');
    if (!can('admin')) { box.innerHTML = ''; box.append(el('div', { class: 'ad-wrap' }, el('h1', { text: 'People and settings' }), el('p', { class: 'empty', text: 'Only the owner can open this page.' }))); return; }
    if (!this.over) { box.innerHTML = ''; box.append(el('div', { class: 'ad-wrap' }, el('h1', { text: 'People and settings' }), el('p', { class: 'muted', text: 'Loading' }))); }
    this.load().then(() => { if (this.isOpen()) this.paint(); }, e => toast(e.message));
  },
  /* after a change: save, then show what the server now holds */
  change(promise, done) { return attempt(promise, done).then(() => reloadShell()).then(() => this.load()).then(() => { if (this.isOpen()) this.paint(); }, () => { }); },
  /* what to say beside a link, depending on whether it was also emailed */
  linkNote(r, who, kind) {
    const lasts = kind === 'reset' ? 'It lets them choose a new password and works once, for 2 days.' : 'It works once, for 14 days.';
    if (r.mail && r.mail.sent) return `${kind === 'reset' ? 'Reset link' : 'Invite'} emailed to ${r.mail.to}. This is the same link, in case the email does not arrive. ${lasts}`;
    if (r.mail) return `The email could not be sent: ${r.mail.error} Pass this link on yourself. ${lasts}`;
    if (this.over.mail.on) return `${who} has no email address here, so pass this link on yourself. ${lasts}`;
    return kind === 'reset' ? `Send this to ${who}. ${lasts}` : `${who} is on the list. This server does not send email, so pass this link on yourself. ${lasts}`;
  },
  linkBox(link, note) {
    const inp = el('input', { class: 'inp', readonly: true, value: link, 'aria-label': 'Link', onfocus: e => e.target.select() });
    return el('div', { class: 'ad-link' }, el('p', { text: note }), el('div', { class: 'rowr' }, inp, el('button', { class: 'btn small primary', text: 'Copy link', onclick: () => { const ok = () => toast('Link copied'); if (navigator.clipboard) navigator.clipboard.writeText(link).then(ok, () => inp.select()); else { inp.select(); document.execCommand('copy'); ok(); } } })));
  },
  sure(btn, text, yes, fn) { popover(btn, el('div', { class: 'confirm' }, el('p', { text }), el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Keep', onclick: closePop }), el('button', { class: 'btn small danger', text: yes, onclick: () => { closePop(); fn(); } })))); },

  /* ----- cards ----- */
  /* a card: its name, the one fact in large type, a line under it, and a lamp (ok, warn, busy, off) */
  card(key, title, head, note, state, extra) {
    return el('button', { class: 'ad-card' + (state ? ' ' + state : ''), data: { card: key }, onclick: () => this.openModal(key) },
      el('span', { class: 'ad-ct' }, state ? el('i', { class: 'lamp' }) : null, el('b', { text: title }), el('span', { class: 'ad-cgo', html: icon('right', 14) })),
      el('span', { class: 'ad-ch', text: head }), note ? el('small', { class: 'muted', text: note }) : null, extra || null);
  },
  group(title, note, cards, id) { return el('section', { class: 'ad-grp', id: id || null }, el('div', { class: 'ad-gh' }, el('h2', { text: title }), note ? el('span', { class: 'muted', text: note }) : null), el('div', { class: 'ad-cards' }, cards)); },
  addCard(key, text) { return el('button', { class: 'ad-card add', data: { card: key }, onclick: () => this.openModal(key) }, el('span', { html: icon('plus', 18) }), el('b', { text })); },
  sso() { return this.over.auth.oidc; },
  reorder(ids) { return this.change(api('POST', '/api/spaces/order', { ids }), 'Order saved'); },
  moved(id, to) { const ids = S.spaces.map(x => x.id), from = ids.indexOf(id); to = clamp(to, 0, ids.length - 1); if (from < 0 || from === to) return; ids.splice(from, 1); ids.splice(to, 0, id); this.reorder(ids); },
  storageBar(st, tot) { return el('div', { class: 'stbar', role: 'img', 'aria-label': `Originals ${fmt.bytes(st.orig)}, display copies ${fmt.bytes(st.disp + st.full)}, thumbnails ${fmt.bytes(st.thumb)}` }, el('i', { class: 'b-o', style: { flex: Math.max(st.orig, 1) } }), el('i', { class: 'b-d', style: { flex: Math.max(st.disp + st.full, tot * .012, 1) } }), el('i', { class: 'b-t', style: { flex: Math.max(st.thumb, tot * .008, 1) } })); },

  paint() {
    const box = $('#v-admin'), o = this.over, top = box.scrollTop; box.innerHTML = '';
    const wrap = el('div', { class: 'ad-wrap' }, el('h1', { text: 'People and settings' }));
    const up = s => s[0].toUpperCase() + s.slice(1);

    /* people: who can open the library */
    const pcards = this.people.map(u => {
      const me = u.id === S.me.id, owner = u.role === 'owner';
      const sub = u.status === 'pending' ? 'Invited, has not joined yet' : u.status === 'disabled' ? 'Access turned off' : u.email || u.handle || '';
      const more = [owner ? 'All spaces' : fmt.plural(u.spaces.length, 'space'), u.status !== 'pending' && u.last ? 'seen ' + fmt.ago(u.last) : ''].filter(Boolean).join(', ');
      return el('button', { class: 'ad-card ad-person' + (u.status === 'pending' || u.status === 'disabled' ? ' dim' : ''), data: { card: 'person:' + u.id }, 'aria-label': `${u.name}, ${u.role}`, onclick: () => this.openModal('person:' + u.id) },
        avatarEl(u, 'lg'), el('span', { class: 'ad-pt' }, el('b', { text: u.name + (me ? ' (you)' : '') }), el('small', { class: 'muted', text: sub })),
        el('span', { class: 'ad-pm' }, el('span', { class: 'ad-role ' + u.role, text: up(u.role) }), el('small', { class: 'muted', text: more })));
    });
    pcards.push(this.addCard('invite', 'Add a person'));
    wrap.append(this.group('People', `${fmt.plural(this.people.length, 'person', 'people')} can open this library`, pcards, 'adPeople'));

    /* spaces: cards that drag into the order of the tabs */
    const scards = S.spaces.map((s, k) => {
      const n = S.items.filter(i => i.space === s.id).length, lone = S.spaces.length < 2, who = this.people.filter(p => p.role === 'owner' || p.spaces.includes(s.id)).length;
      /* a div, not a button: a button cannot be dragged in every browser */
      const c = el('div', { class: 'ad-card ad-space', role: 'button', tabindex: 0, draggable: !lone, data: { id: s.id, card: 'space:' + s.id }, 'aria-label': `${s.name}, a space`, title: lone ? null : 'Click to change it. Drag to change the order of the tabs.', onclick: () => this.openModal('space:' + s.id), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.openModal('space:' + s.id); } } },
        el('span', { class: 'ad-ct' }, lone ? null : el('span', { class: 'ad-grip', 'aria-hidden': 'true', html: icon('grip', 14) }), el('b', { text: s.kind === 'studio' ? 'By series' : 'By date' }), el('span', { class: 'ad-cgo', html: icon('right', 14) })),
        el('span', { class: 'ad-ch', text: s.name }), el('small', { class: 'muted', text: [fmt.plural(n, 'item'), fmt.plural(who, 'person', 'people'), s.people ? 'faces on' : ''].filter(Boolean).join(', ') }));
      c.addEventListener('dragstart', e => { this._drag = s.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.name); c.classList.add('dragging'); });
      c.addEventListener('dragend', () => { this._drag = null; $$('.ad-space').forEach(r => r.classList.remove('dragging', 'over')); });
      c.addEventListener('dragover', e => { if (!this._drag || this._drag === s.id) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; c.classList.add('over'); });
      c.addEventListener('dragleave', () => c.classList.remove('over'));
      c.addEventListener('drop', e => { if (!this._drag) return; e.preventDefault(); const id = this._drag; this._drag = null; this.moved(id, k); });
      return c;
    });
    scards.push(this.addCard('addspace', 'Add a space'));
    wrap.append(this.group('Spaces', S.spaces.length > 1 ? 'Drag a card to change the order of the tabs' : 'A space is a separate library with its own people', scards, 'adSpaces'));

    /* who is in the pictures, for the space in use */
    wrap.append(this.facesGroup());

    /* the library and the server */
    const cards = [], bk = o.backup, wk = this.work, pd = this.placeData, vd = o.video, st = o.storage, tr = o.trash;
    if (bk) cards.push(this.card('backup', 'Backups', bk.last ? 'Last ' + fmt.ago(bk.last.at) : 'None yet', bk.failure ? 'The last try failed' : bk.schedule ? `Every day at ${bk.schedule}, ${bk.count} kept` : 'No schedule is set', bk.failure || bk.where === 'disk' ? 'warn' : bk.last ? 'ok' : 'off'));
    {
      const fresh = m => !m.paused && m.last && Date.now() - m.last < 150000, busy = wk.workers.filter(m => fresh(m) && m.holding).length, up2 = wk.workers.filter(fresh).length;
      const wait = wk.tasks.reduce((a, t) => a + t.waiting + t.claimed, 0), bad = wk.tasks.reduce((a, t) => a + t.failed, 0);
      cards.push(this.card('workers', 'Workers', !wk.workers.length ? 'No machine' : busy ? `${busy} working` : up2 ? `${up2} waiting for work` : 'None connected',
        [fmt.plural(wk.workers.length, 'machine'), wait ? `${fmt.n(wait)} to read` : 'nothing to read', bad ? `${bad} failed` : ''].filter(Boolean).join(', '), busy ? 'busy' : up2 ? 'ok' : 'off'));
    }
    cards.push(this.card('places', 'Places', pd.busy ? 'Fetching' : pd.rows ? `${fmt.n(pd.rows)} names` : 'Not loaded', pd.error && !pd.busy ? 'The last try did not work' : pd.rows ? 'Beaches, parks and landmarks are named' : 'Pictures are filed under the nearest town', pd.busy ? 'busy' : pd.error ? 'warn' : pd.rows ? 'ok' : 'off'));
    if (vd && vd.videos) cards.push(this.card('video', 'Video', fmt.plural(vd.videos, 'video'), [vd.copies ? `${fmt.plural(vd.copies, 'copy', 'copies')} made` : 'no copies needed yet', vd.waiting ? `${vd.waiting} waiting` : '', vd.failed ? `${vd.failed} failed` : ''].filter(Boolean).join(', '), vd.failed ? 'warn' : vd.waiting ? 'busy' : 'ok'));
    {
      const tot = st.orig + st.disp + st.thumb + st.full + (st.play || 0);
      cards.push(this.card('storage', 'Storage', fmt.bytes(tot), `${fmt.plural(st.items, 'item')} ${st.driver === 's3' ? 'in a bucket' : 'on this server'}`, o.work.failed ? 'warn' : 'ok', this.storageBar(st, tot)));
    }
    cards.push(this.card('trash', 'Trash', tr.n ? fmt.plural(tr.n, 'item') : 'Empty', tr.n ? `${fmt.bytes(tr.bytes)}, ${tr.days > 0 ? `removed after ${fmt.plural(tr.days, 'day')}` : 'kept until you delete them'}` : tr.days > 0 ? `Emptied after ${fmt.plural(tr.days, 'day')}` : 'Nothing is removed by itself', tr.n ? 'warn' : 'off'));
    cards.push(this.card('signin', 'Sign-in', [o.auth.local ? 'Password' : '', this.sso() || ''].filter(Boolean).join(' and ') || 'Off', 'Chosen in the server’s settings file', 'ok'));
    cards.push(this.card('mail', 'Email', o.mail.on ? 'On' : 'Off', o.mail.on ? 'Sent from ' + o.mail.from : 'Links are yours to pass on', o.mail.on ? 'ok' : 'off'));
    {
      const pb = this.pub, ex = this.exp, run = ex.state && ex.state.running, last = ex.list[0];
      cards.push(this.card('publicpage', 'Public page', pb.count ? `${fmt.plural(pb.count, 'story', 'stories')} public` : 'Nothing public', pb.count ? (pb.index ? 'Search engines may list it' : 'Search engines are asked to stay away') : 'Only people who sign in see this library', pb.count ? 'ok' : 'off'));
      cards.push(this.card('move', 'Move this library', run ? 'Exporting' : last ? 'Exported ' + fmt.ago(last.at) : 'No export yet', ex.state && ex.state.error ? 'The last export failed' : 'To a server of your own, or back', run ? 'busy' : ex.state && ex.state.error ? 'warn' : last ? 'ok' : 'off'));
    }
    { const a = o.activity[0]; cards.push(this.card('activity', 'Recent activity', a ? fmt.ago(a.t) : 'Nothing yet', a ? `${a.who} ${a.text}` : '', null)); }
    wrap.append(this.group('Library and server', '', cards, 'adServer'));

    box.append(wrap); box.scrollTop = top;
    this.paintModal(false);
  },

  /* ----- the window a card opens ----- */
  openModal(key) { closePop(); this.modal = key; this.paintModal(true); },
  closeModal() { closePop(); this.modal = null; this.dropModal(); },
  dropModal() { const m = $('#adModal'); if (m) m.remove(); },
  paintModal(fresh) {
    const old = $('#adModal'), top = old && !fresh ? $('.ad-mbody', old).scrollTop : 0; if (old) old.remove();
    if (!this.modal || !this.over) return;
    const [kind, id] = this.modal.split(':'), fn = this.M[kind], m = fn ? fn.call(this, id) : null;
    if (!m) { this.modal = null; return; }
    const body = el('div', { class: 'ad-mbody' }, m.body);
    const sh = el('div', { class: 'ad-modal', id: 'adModal', data: { key: this.modal }, onclick: e => { if (e.target === sh) this.closeModal(); } },
      el('div', { class: 'ad-mbox' + (m.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': m.title },
        el('header', {}, m.head || null, el('h2', { text: m.title }), el('button', { class: 'iconbtn', id: 'adModalClose', title: 'Close', 'aria-label': 'Close', html: icon('x'), onclick: () => this.closeModal() })), body));
    $('#adBox').append(sh); body.scrollTop = top;
  },
  row(label, ...kids) { return [el('span', { class: 'ad-fl', text: label }), el('div', { class: 'ad-fv' }, ...kids)]; },

  M: {
    person(id) {
      const u = this.people.find(p => p.id === id); if (!u) return null;
      const o = this.over, sso = this.sso(), owner = u.role === 'owner', me = u.id === S.me.id, lone = owner && this.people.filter(p => p.role === 'owner').length < 2;
      const role = el('select', { class: 'inp', disabled: lone, 'aria-label': 'Role for ' + u.name }, ['owner', 'editor', 'commenter', 'viewer'].map(r => el('option', { value: r, text: r[0].toUpperCase() + r.slice(1), selected: u.role === r })));
      role.addEventListener('change', () => this.change(api('PATCH', '/api/people/' + u.id, { role: role.value }), `${u.name} is now ${role.value === 'owner' ? 'an owner' : role.value === 'editor' ? 'an editor' : 'a ' + role.value}`));
      const spaces = el('div', { class: 'fvals wrap' }, S.spaces.map(s => { const on = u.spaces.includes(s.id); return el('button', { class: 'chip' + (on ? ' on' : ''), 'aria-pressed': on, text: s.name, onclick: () => this.change(api('PATCH', '/api/people/' + u.id, { spaceIds: on ? u.spaces.filter(x => x !== s.id) : [...u.spaces, s.id] })) }); }));
      /* "Publish stories" is offered for editors only. An owner always may, and the server refuses it for anyone else. */
      const caps = el('div', { class: 'caps' }, [['upload', 'Upload'], ['edit', 'Edit copies'], ['tag', 'Tag and title'], ['comment', 'Comment'], ['download', 'Download'], ...(u.role === 'editor' ? [['publish', 'Publish stories']] : [])].map(([k, l]) => el('label', {}, el('input', { type: 'checkbox', checked: !!u.caps[k], disabled: owner, onchange: e => this.change(api('PATCH', '/api/people/' + u.id, { caps: { [k]: e.target.checked } })) }), l)));
      const how = [u.hasPassword ? 'a password' : '', u.oidcLinked ? sso || 'single sign-on' : ''].filter(Boolean).join(' and ');
      const state = u.status === 'pending' ? 'Invited, has not joined yet' : u.status === 'disabled' ? 'Access turned off' : [how ? 'Signs in with ' + how : '', u.last ? 'seen ' + fmt.ago(u.last) : ''].filter(Boolean).join(', ');
      const form = el('div', { class: 'ad-form' });
      if (me) form.append(...this.row('Picture', el('div', { class: 'rowr' },
        el('button', { class: 'btn small', id: 'adMyPic', 'aria-label': u.avatar ? 'Change your profile picture' : 'Add a profile picture', text: u.avatar ? 'Change picture' : 'Add a picture', onclick: pickAvatar }),
        u.avatar ? el('button', { class: 'btn small', id: 'adMyPicOff', text: 'Remove picture', onclick: () => attempt(api('DELETE', '/api/me/avatar'), 'Profile picture removed').then(afterAvatar, () => { }) }) : null)));
      form.append(...this.row('Role', role, el('small', { class: 'muted', text: ROLE_NOTE[u.role] })),
        ...this.row('Spaces', owner ? el('span', { class: 'muted', text: 'An owner opens every space.' }) : spaces),
        ...this.row('Can', caps));
      const linkOut = el('div'), foot = el('div', { class: 'ad-foot' });
      if (!me && (u.status === 'pending' || o.auth.local)) foot.append(el('button', { class: 'btn', id: 'adPersonLink', html: icon('link', 15) + `<span>${u.status === 'pending' ? 'New invite link' : 'Password reset link'}</span>`, onclick: () => api('POST', `/api/people/${u.id}/link`).then(r => { if (r.mail) toast(r.mail.sent ? `Emailed to ${r.mail.to}` : 'The email could not be sent. The link is here to copy.'); linkOut.innerHTML = ''; linkOut.append(this.linkBox(r.link, this.linkNote(r, u.name, r.kind))); }, er => toast(er.message)) }));
      foot.append(el('span', { class: 'grow1' }));
      if (!me && !owner) foot.append(el('button', { class: 'btn danger', id: 'adPersonRemove', text: 'Remove ' + u.name, onclick: e => this.sure(e.currentTarget, `Remove ${u.name}? They lose access at once. Their comments and likes are removed with them.`, 'Remove', () => this.change(api('DELETE', '/api/people/' + u.id), `${u.name} can no longer open this library`)) }));
      return { title: u.name + (me ? ' (you)' : ''), head: avatarEl(u, 'lg'), body: el('div', { id: 'adPerson' }, el('p', { class: 'ad-p', text: [u.email || u.handle, state].filter(Boolean).join('. ') + '.' }), form, linkOut, foot.childNodes.length > 1 ? foot : null) };
    },
    invite() {
      const o = this.over, sso = this.sso(), signNote = [o.auth.local ? 'an email and password' : '', sso || ''].filter(Boolean).join(' or ');
      const who = el('input', { class: 'inp', placeholder: sso ? `Email, or their ${sso} handle` : 'Email address', 'aria-label': 'Who to invite' }), rsel = el('select', { class: 'inp', 'aria-label': 'Role' }, ['viewer', 'commenter', 'editor'].map(r => el('option', { value: r, text: r[0].toUpperCase() + r.slice(1), selected: r === 'commenter' })));
      const made = el('div');
      const invite = () => {
        const v = who.value.trim(); if (!v) return who.focus();
        attempt(api('POST', '/api/people/invite', { who: v, role: rsel.value, spaceIds: S.space ? [S.space] : [] })).then(r => { this._invite = { link: r.link, who: v, mail: r.mail }; return reloadShell().then(() => this.load()).then(() => this.paint()); }, () => { });
      };
      who.addEventListener('keydown', e => { if (e.key === 'Enter') invite(); });
      if (this._invite) { made.append(this.linkBox(this._invite.link, this.linkNote(this._invite, this._invite.who, 'invite'))); made.firstChild.id = 'adInviteMade'; this._invite = null; }
      setTimeout(() => { if (!made.firstChild) who.focus(); }, 0);
      return { title: 'Add a person', body: el('div', {}, el('p', { class: 'ad-p', text: `Only the people on this page can open the library. They sign in with ${signNote}. A new person starts with ${curSpace().name}, the space you are in now. Open their card afterwards to change what they see and can do.` }),
        el('div', { class: 'ad-invite' }, who, rsel, el('button', { class: 'btn primary', text: o.mail.on ? 'Add and send invite' : 'Add and get invite link', onclick: invite })), made) };
    },
    space(id) {
      const s = S.spaces.find(x => x.id === id); if (!s) return null;
      const k = S.spaces.indexOf(s), n = S.items.filter(i => i.space === s.id).length, lone = S.spaces.length < 2;
      const name = el('input', { class: 'inp', id: 'adSpaceName', value: s.name, maxlength: 60, 'aria-label': 'Name of this space', onkeydown: e => { if (e.key === 'Enter') e.target.blur(); }, onchange: e => { const v = e.target.value.trim(); if (!v) { e.target.value = s.name; return; } this.change(api('PATCH', '/api/spaces/' + s.id, { name: v }), 'Renamed'); } });
      const kind = el('select', { class: 'inp', 'aria-label': 'How this space is arranged', onchange: e => this.change(api('PATCH', '/api/spaces/' + s.id, { kind: e.target.value })) }, el('option', { value: 'life', text: 'By date, like a photo roll', selected: s.kind === 'life' }), el('option', { value: 'studio', text: 'By series, like a portfolio', selected: s.kind === 'studio' }));
      const who = el('div', { class: 'fvals wrap', id: 'adSpaceWho' }, this.people.map(u => { const owner = u.role === 'owner', on = owner || u.spaces.includes(s.id); return el('button', { class: 'chip' + (on ? ' on' : ''), disabled: owner, 'aria-pressed': on, title: owner ? 'An owner opens every space' : on ? `Take ${s.name} away from ${u.name}` : `Let ${u.name} open ${s.name}`, text: u.name, onclick: () => this.change(api('PATCH', '/api/people/' + u.id, { spaceIds: on ? u.spaces.filter(x => x !== s.id) : [...u.spaces, s.id] })) }); }));
      const form = el('div', { class: 'ad-form' }, ...this.row('Name', name), ...this.row('Arranged', kind), ...this.row('People', who),
        ...this.row('Holds', el('span', { text: fmt.plural(n, 'item') + (s.people ? '. People recognition is on.' : '.') })));
      if (!lone) form.append(...this.row('Order', el('div', { class: 'rowr' },
        el('button', { class: 'btn small', disabled: k === 0, 'aria-label': `Move ${s.name} up`, text: 'Earlier', onclick: () => this.moved(s.id, k - 1) }),
        el('button', { class: 'btn small', disabled: k === S.spaces.length - 1, 'aria-label': `Move ${s.name} down`, text: 'Later', onclick: () => this.moved(s.id, k + 1) }),
        el('small', { class: 'muted', text: `Tab ${k + 1} of ${S.spaces.length}` }))));
      return { title: s.name, body: el('div', { id: 'adSpace' }, form, lone ? null : el('div', { class: 'ad-foot' }, el('small', { class: 'muted', text: 'A space can only be removed once it is empty, trash included.' }), el('span', { class: 'grow1' }),
        el('button', { class: 'btn danger', 'aria-label': 'Remove the space ' + s.name, text: 'Remove this space', onclick: () => this.change(api('DELETE', '/api/spaces/' + s.id), `Removed ${s.name}`) }))) };
    },
    addspace() {
      const sname = el('input', { class: 'inp', id: 'adNewSpace', placeholder: 'Name, for example Family', maxlength: 60, 'aria-label': 'Name for a new space' }), skind = el('select', { class: 'inp', 'aria-label': 'Arrangement' }, el('option', { value: 'life', text: 'By date, like a photo roll' }), el('option', { value: 'studio', text: 'By series, like a portfolio' }));
      const add = () => { const v = sname.value.trim(); if (!v) return sname.focus(); this.modal = null; this.change(api('POST', '/api/spaces', { name: v, kind: skind.value }), `Added ${v}`); };
      sname.addEventListener('keydown', e => { if (e.key === 'Enter') add(); }); setTimeout(() => sname.focus(), 0);
      return { title: 'Add a space', body: el('div', {}, el('p', { class: 'ad-p', text: 'A space is a separate library with its own people.' }), el('div', { class: 'ad-invite' }, sname, skind, el('button', { class: 'btn primary', text: 'Add space', onclick: add }))) };
    },
    backup() {
      const bk = this.over.backup; if (!bk) return null;
      const when = t => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      const place = bk.where === 'bucket' ? `in the bucket “${bk.bucket}”, under backups/` : 'on this server’s disk, under backups/ in the media folder';
      const sched = bk.schedule ? `A backup is made every day at ${bk.schedule}, and the newest ${bk.keep} are kept.` : 'No schedule is set, so a backup is only made when you ask for one here. Set BACKUP_SCHEDULE to a time of day to have one made every night.';
      const now = el('button', { class: 'btn primary', id: 'adBackupNow', text: 'Back up now', onclick: () => { now.disabled = true; now.textContent = 'Backing up'; api('POST', '/api/admin/backup').then(() => { toast('The database is backed up.'); this.render(); }, e => { toast(e.message); this.render(); }); } });
      return { title: 'Backups', body: el('div', { id: 'adBackup' },
        el('p', { class: 'ad-p ad-lead', id: 'adBackupLast', text: bk.last ? `Last backup: ${when(bk.last.at)}, ${fmt.bytes(bk.last.bytes)}, ${place}${bk.last.encrypted ? ', encrypted' : ''}. ${fmt.plural(bk.count, 'backup')} kept, ${fmt.bytes(bk.bytes)} in all.` : 'No backup has been made yet.' }),
        bk.failure ? el('p', { class: 'ad-p ad-warn', id: 'adBackupFail', text: `The last backup that was tried, on ${when(bk.failure.at)}, failed. ${bk.failure.reason}` }) : null,
        bk.where === 'disk' ? el('p', { class: 'ad-p ad-warn', id: 'adBackupDisk', text: 'These backups are on the same disk as the database. They protect against a mistake or a damaged database. They do not protect against losing the disk. Copy the backups folder somewhere else, or keep the files in a bucket.' }) : null,
        el('p', { class: 'ad-p', text: `Titles, tags, comments, stories, people and edits live in the database. A backup is a copy of that database. It does not hold the pictures and videos themselves: those need a second copy of their own. ${sched}` }),
        !bk.encrypted ? el('p', { class: 'ad-p', text: 'Backups are not encrypted. They hold password hashes. Set BACKUP_PASSPHRASE to encrypt them before they are stored.' }) : null,
        el('div', { class: 'btnrow' }, now)) };
    },
    workers() {
      const wk = this.work, TASK = { caption: 'Captions, scenes and objects', embed: 'Search by meaning', faces: 'People', place: 'Places' };
      const rigs = el('div', { class: 'rigs wk-rigs', id: 'adWorkerList' });
      wk.workers.forEach(m => {
        const fresh = m.last && Date.now() - m.last < 150000, state = m.paused ? 'asleep' : fresh ? (m.holding ? 'working' : 'idle') : 'asleep';
        const about = [m.info.gpu, m.info.os, m.info.host && m.info.host !== m.name ? m.info.host : ''].filter(Boolean).join(', ');
        const now = m.paused ? 'Paused' : !m.last ? 'Has not checked in yet' : fresh ? (m.holding ? `Reading ${fmt.plural(m.holding, 'item')}` + (m.info.doing ? ` (${m.info.doing})` : '') : 'Waiting for work') : `Last checked in ${fmt.ago(m.last)}`;
        rigs.append(el('div', { class: 'rig wk ' + state, data: { id: m.id } }, el('i', { class: 'lamp' }),
          el('div', {}, el('b', { text: m.name }), el('small', { class: 'muted', text: [about, now].filter(Boolean).join('. ') + '.' })),
          el('span', { class: 'wk-acts' },
            el('button', { class: 'btn small', text: m.paused ? 'Resume' : 'Pause', 'aria-label': `${m.paused ? 'Resume' : 'Pause'} ${m.name}`, onclick: () => this.change(api('PATCH', '/api/admin/workers/' + m.id, { paused: !m.paused }), m.paused ? `${m.name} may take work again` : `${m.name} is paused`) }),
            el('button', { class: 'iconbtn', title: 'Revoke this token', 'aria-label': `Revoke the token for ${m.name}`, html: icon('x'), onclick: e => this.sure(e.currentTarget, `Revoke the token for ${m.name}? The machine is refused from now on. What it has already read is kept.`, 'Revoke', () => this.change(api('DELETE', '/api/admin/workers/' + m.id), `${m.name} can no longer connect`)) }))));
      });
      if (!wk.workers.length) rigs.append(el('p', { class: 'muted', id: 'adWorkerNone', text: 'No machine is connected. Everything else works the same without one.' }));
      const tasks = el('div', { class: 'wk-tasks', id: 'adWorkerTasks' });
      wk.tasks.forEach(t => {
        const facts = [`${t.waiting} waiting`, t.claimed ? `${t.claimed} being read` : '', `${t.done} done`, t.failed ? `${t.failed} could not be read` : ''].filter(Boolean).join(', ');
        tasks.append(el('div', { class: 'wk-task', data: { task: t.task } }, el('div', {}, el('b', { text: TASK[t.task] || t.task }), el('small', { class: 'muted', text: facts + '.' })),
          el('button', { class: 'btn small', text: 'Read everything again', disabled: !(t.done + t.failed), onclick: e => popover(e.currentTarget, el('div', { class: 'confirm' }, el('p', { text: `Put the whole library back in line for “${TASK[t.task] || t.task}”? Use this after changing to a better model. What was read before stays until the new answer arrives, and anything you corrected by hand is kept.` }), el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Leave it', onclick: closePop }), el('button', { class: 'btn small primary', text: 'Read again', onclick: () => { closePop(); this.change(api('POST', '/api/admin/workers/redo', { task: t.task }), 'Back in line'); } })))) })));
      });
      const wname = el('input', { class: 'inp', id: 'adWorkerName', placeholder: 'Name for the machine, such as Tower', maxlength: 60, 'aria-label': 'Name for the machine' }), wmade = el('div');
      const mk = () => { const v = wname.value.trim(); if (!v) return wname.focus(); attempt(api('POST', '/api/admin/workers', { name: v })).then(r => { this._token = r; return this.load().then(() => this.paint()); }, () => { }); };
      wname.addEventListener('keydown', e => { if (e.key === 'Enter') mk(); });
      if (this._token) { wmade.append(this.linkBox(this._token.token, `This is the token for ${this._token.name}. Put it in the worker's config file now: it is shown this once and cannot be shown again. If it is lost, revoke it and make another.`)); wmade.firstChild.id = 'adTokenMade'; $('.btn', wmade).textContent = 'Copy token'; $('input', wmade).setAttribute('aria-label', 'Worker token'); this._token = null; }
      return { title: 'Workers', wide: true, body: el('div', { id: 'adWorkers', class: 'ad-two' },
        el('div', {}, el('h3', { text: 'Machines' }), rigs, el('div', { class: 'ad-invite' }, wname, el('button', { class: 'btn', id: 'adWorkerAdd', text: 'Make a token', onclick: mk })), wmade),
        el('div', {}, el('h3', { text: 'Work' }), tasks),
        el('p', { class: 'vi-note ad-span', text: 'A worker is a program on a machine of your own that reads the pictures: what is in them, and where. It asks this site for work, fetches the pictures it is given, and sends back what it found. Nothing is sent to an outside service, and this site never connects to your machines.' })) };
    },
    places() {
      const pd = this.placeData, when = t => new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' });
      const fetchBtn = el('button', { class: 'btn', id: 'adPlacesFetch', disabled: !!pd.busy, text: pd.rows ? 'Fetch the place names again' : 'Fetch the place names', onclick: () => { fetchBtn.disabled = true; api('POST', '/api/admin/places/fetch').then(() => { toast('Fetching. It takes a few minutes. Look here again when it is done.'); setTimeout(() => { if (this.isOpen()) this.render(); }, 4000); }, e => { fetchBtn.disabled = false; toast(e.message); }); } });
      const again = el('button', { class: 'btn', id: 'adPlacesRename', disabled: !pd.rows || !!pd.busy, text: 'Name places again', onclick: () => { again.disabled = true; again.textContent = 'Naming'; api('POST', '/api/admin/places/rename').then(r => { toast(r.n ? `${fmt.plural(r.n, 'item')} named again` : 'Every place name was already up to date'); Sync.full().then(() => Lib.refresh()); this.render(); }, e => { toast(e.message); this.render(); }); } });
      return { title: 'Places', body: el('div', { id: 'adPlaces' },
        el('p', { class: 'ad-p ad-lead', id: 'adPlacesState', text: pd.busy ? `${pd.busy}.` : pd.rows ? `${fmt.n(pd.rows)} place names are loaded${pd.at ? ', fetched on ' + when(pd.at) : ''}. Place names from GeoNames (geonames.org), under the Creative Commons Attribution 4.0 licence.` : 'No place names are loaded yet.' }),
        pd.error && !pd.busy ? el('p', { class: 'ad-p ad-warn', text: `The last try did not work. ${pd.error}` }) : null,
        el('p', { class: 'ad-p', text: 'Every picture with a location is filed under its nearest town. With place names loaded it is also named after the beach, park, landmark or neighborhood it was taken at. The names are fetched once from GeoNames, about 400 MB, and kept in the database, about 270 MB. After that nothing is asked of an outside service.' }),
        el('div', { class: 'btnrow' }, fetchBtn, again)) };
    },
    video() {
      const vd = this.over.video; if (!vd || !vd.videos) return null;
      const facts = [`${fmt.plural(vd.videos, 'video')} in the library`, vd.copies ? `${fmt.plural(vd.copies, 'copy', 'copies')} made (${fmt.bytes(vd.bytes)})` : '', vd.waiting ? `${vd.waiting} waiting` : '', vd.failed ? `${vd.failed} could not be made` : '', vd.unknown ? `${vd.unknown} not looked at yet` : ''].filter(Boolean).join(', ') + '.';
      const how = vd.mode === 'never' ? 'Copies are turned off (VIDEO_COPY=never).' : vd.mode === 'always' ? `A copy is made of every video, at most ${vd.maxEdge} px on its long side.` : `A copy is made only for a video a browser would not play, at most ${vd.maxEdge} px on its long side.`;
      const go1 = el('button', { class: 'btn', id: 'adVideoCopies', text: 'Make copies for videos already here', disabled: vd.mode === 'never' || !(vd.unknown + vd.failed), onclick: () => { go1.disabled = true; api('POST', '/api/admin/video-copies').then(r => { toast(r.n ? `${fmt.plural(r.n, 'video')} in line. They are done one at a time, after everything else.` : 'Every video has been looked at already.'); this.render(); }, e => { go1.disabled = false; toast(e.message); }); } });
      return { title: 'Video', body: el('div', { id: 'adVideo' }, el('p', { class: 'ad-p ad-lead', text: `${facts} ${how}` }),
        el('p', { class: 'ad-p', text: 'Some videos do not play in a browser: iPhone video is often HEVC or HDR, and MKV and AVI files can hold almost anything. The original is kept untouched and a copy is made to play instead. Download always gives the original.' }), el('div', { class: 'btnrow' }, go1)) };
    },
    storage() {
      const o = this.over, st = o.storage, tot = st.orig + st.disp + st.thumb + st.full + (st.play || 0), where = st.driver === 's3' ? `in the bucket “${st.bucket}”` : 'on this server’s disk';
      return { title: 'Storage', body: el('div', { id: 'adStorage' }, el('p', { class: 'ad-p ad-lead', text: `${fmt.plural(st.items, 'item')} ${where}, ${fmt.bytes(tot)} in total. Every upload is kept untouched, with WebP copies made for fast viewing.` }), this.storageBar(st, tot),
        el('dl', { class: 'kv stkey' }, el('dt', {}, el('i', { class: 'dot b-o' }), 'Originals'), el('dd', {}, fmt.bytes(st.orig), el('code', { text: 'originals/{year}/{month}/{item}/{file}' })),
          el('dt', {}, el('i', { class: 'dot b-d' }), `Display, WebP, ${S.cfg.limits.displayLongEdge} px`), el('dd', {}, fmt.bytes(st.disp + st.full), el('code', { text: 'display/{year}/{month}/{item}.webp' })),
          el('dt', {}, el('i', { class: 'dot b-t' }), `Thumbnails, WebP, ${S.cfg.limits.thumbHeight} px`), el('dd', {}, fmt.bytes(st.thumb), el('code', { text: 'thumbs/{year}/{month}/{item}.webp' })),
          st.play ? el('dt', {}, el('i', { class: 'dot b-d' }), 'Video copies, MP4') : null, st.play ? el('dd', {}, fmt.bytes(st.play), el('code', { text: 'video/{year}/{month}/{item}.mp4' })) : null),
        o.work.waiting || o.work.failed ? el('p', { class: 'vi-note', text: [o.work.waiting ? `${fmt.plural(o.work.waiting, 'file')} still being processed` : '', o.work.failed ? `${fmt.plural(o.work.failed, 'file')} could not be read` : ''].filter(Boolean).join('. ') + '.' }) : null) };
    },
    trash() {
      const tr = this.over.trash, rule = tr.days > 0 ? `Items are removed for good ${fmt.plural(tr.days, 'day')} after they were deleted.` : 'Deleted items wait there until you delete them for good.';
      const open = el('button', { class: 'btn primary', id: 'adTrashOpen', text: 'Open the trash', onclick: () => go('trash') }), row = el('div', { class: 'btnrow' }, open);
      if (tr.n) row.append(
        el('button', { class: 'btn', id: 'adTrashBack', text: 'Put everything back', onclick: () => attempt(api('POST', '/api/trash/restore')).then(r => { toast(r.skipped ? `Put back ${fmt.plural(r.restored, 'item')}. ${fmt.plural(r.skipped, 'item')} stayed because the same file is already in the library.` : `Put back ${fmt.plural(r.restored, 'item')}`); return Sync.full().then(() => { Lib.refresh(); this.render(); }); }, () => { }) }),
        el('button', { class: 'btn danger', text: 'Empty the trash', onclick: e => this.sure(e.currentTarget, `Delete ${fmt.plural(tr.n, 'item')} and their files for good? That frees ${fmt.bytes(tr.bytes)}. This cannot be undone.`, 'Delete for good', () => this.change(api('POST', '/api/trash/empty'), 'Trash emptied')) }));
      return { title: 'Trash', body: el('div', { id: 'adTrash' }, el('p', { class: 'ad-p ad-lead', text: tr.n ? `${fmt.plural(tr.n, 'item')} in the trash, ${fmt.bytes(tr.bytes)}. ${rule} Open it to see them and choose which to put back.` : 'The trash is empty. ' + rule }), row) };
    },
    signin() {
      const o = this.over, sso = this.sso();
      return { title: 'Sign-in', body: el('div', { id: 'adSignin' }, el('div', { class: 'rigs' },
        el('div', { class: 'rig ' + (o.auth.local ? 'idle' : 'asleep') }, el('i', { class: 'lamp' }), el('div', {}, el('b', { text: 'Email and password' })), el('span', { class: 'muted', text: o.auth.local ? 'on' : 'off' })),
        el('div', { class: 'rig ' + (sso ? 'idle' : 'asleep') }, el('i', { class: 'lamp' }), el('div', {}, el('b', { text: sso || 'Single sign-on' })), el('span', { class: 'muted', text: sso ? 'on' : 'not set up' }))),
        el('p', { class: 'vi-note', text: 'These are chosen in the server’s settings file (LOCAL_AUTH and the OIDC_ values), not here, so a mistake on this page can never lock everyone out.' })) };
    },
    mail() {
      const o = this.over;
      return { title: 'Email', body: el('div', { id: 'adMail' }, el('div', { class: 'rigs' },
        el('div', { class: 'rig ' + (o.mail.on ? 'idle' : 'asleep') }, el('i', { class: 'lamp' }), el('div', {}, el('b', { text: 'Invites and reset links by email' }), o.mail.on ? el('small', { class: 'muted', text: ' sent from ' + o.mail.from }) : null), el('span', { class: 'muted', text: o.mail.on ? 'on' : 'off' }))),
        el('p', { class: 'vi-note', text: o.mail.on ? 'An invite to an email address is sent to it, and so is a password reset link. An invite by handle has no address, so its link is still yours to pass on. Every link is also shown here to copy.' : 'Nothing is sent. You copy invite and reset links and pass them on yourself. To send them by email, set RESEND_API_KEY and MAIL_FROM in the server’s settings file.' })) };
    },
    activity() {
      const act = el('ul', { class: 'act', id: 'adActivity' }); this.over.activity.forEach(a => act.append(el('li', {}, el('b', { text: a.who }), ' ' + a.text, el('span', { class: 'muted', text: ' ' + fmt.ago(a.t) }))));
      if (!this.over.activity.length) act.append(el('li', { class: 'muted', text: 'Nothing yet.' }));
      return { title: 'Recent activity', body: act };
    },
    /* what a visitor who is not signed in sees at this library's address */
    publicpage() {
      const pb = this.pub, save = (body, done) => this.change(api('PUT', '/api/admin/public', body), done);
      const text = (id, key, ph, max, lbl) => el('input', { class: 'inp', id, value: pb[key], placeholder: ph, maxlength: max, 'aria-label': lbl, onkeydown: e => { if (e.key === 'Enter') e.target.blur(); }, onchange: e => { const v = e.target.value.trim(); if (v !== pb[key]) save({ [key]: v }, 'Saved'); } });
      const idx = el('label', { class: 'sl-opt' }, el('input', { type: 'checkbox', id: 'adPubIndex', checked: pb.index, onchange: e => save({ index: e.target.checked }, e.target.checked ? 'Search engines may now list the public page' : 'Search engines are asked to stay away') }), 'Let search engines list it');
      /* the logo: chosen from this device, kept whole, shown small beside the name */
      const pick = () => { const inp = el('input', { type: 'file', accept: 'image/png,image/svg+xml,image/jpeg,image/webp', hidden: true });
        inp.addEventListener('change', () => { const f = inp.files[0]; inp.remove(); if (!f) return; const fd = new FormData(); fd.set('file', f, f.name);
          this.change(fetch('/api/admin/public/logo', { method: 'POST', body: fd, headers: { 'x-afterimage': '1' }, credentials: 'same-origin' }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'The logo could not be saved.'); return d; }), 'Logo saved'); });
        document.body.append(inp); inp.click(); };
      const logo = el('div', { class: 'ad-logo', id: 'adPubLogo' }, pb.logo ? el('img', { src: pb.logo, alt: 'The logo now' }) : null,
        el('button', { class: 'btn small', type: 'button', id: 'adPubLogoPick', onclick: pick }, pb.logo ? 'Choose another' : 'Choose a picture'),
        pb.logo ? el('button', { class: 'btn small', type: 'button', id: 'adPubLogoOff', onclick: () => this.change(api('DELETE', '/api/admin/public/logo'), 'Logo removed') }, 'Remove') : null);
      return { title: 'Public page', body: el('div', { id: 'adPublic' },
        el('p', { class: 'ad-p ad-lead', id: 'adPubState', text: pb.count ? `${fmt.plural(pb.count, 'story', 'stories')} ${pb.count === 1 ? 'is' : 'are'} public. Anyone can read ${pb.count === 1 ? 'it' : 'them'} at the address below without signing in. Everything else in the library stays private.` : 'Nothing is public. Someone who is not signed in sees the sign-in page. To publish a story, open it, choose Share, and turn on Public.' }),
        el('div', { class: 'ad-form' }, ...this.row('Name', text('adPubTitle', 'title', 'Your name or a title. Shown at the top left in place of “Stories”', 120, 'Name or title of the public page')), ...this.row('Line', text('adPubLine', 'line', 'One line under the name', 300, 'One line of text under the name')),
          ...this.row('Logo', logo, el('small', { class: 'muted', text: 'Optional. A small picture beside the name: PNG, SVG, JPEG or WebP. It is shown whole, in its own shape.' })),
          ...this.row('Search', idx, el('small', { class: 'muted', text: pb.index ? 'Search engines may list the public page, and a link to it shows a preview.' : 'Off. Search engines are asked not to list the page, and a link to it shows no preview.' }))),
        this.linkBox(pb.url, 'The address of the public page. The featured story is shown open there, or the newest one when none is featured.'),
        el('p', { class: 'ad-p', text: 'Visitors load the pictures of public stories from this library’s own storage. A storage provider may bill for what they load.' }),
        el('p', { class: 'ad-p', text: 'Owners can publish. An editor can when “Publish stories” is ticked on their card.' })) };
    },
    /* the whole library as one file: export it here, import it somewhere else */
    move() {
      const ex = this.exp, run = ex.state && ex.state.running, has = this.over.storage.items + this.over.trash.n > 0;
      const when = t => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      /* while an export runs, look again every two seconds. One timer: drawing this window again starts it over. */
      clearTimeout(this._mt);
      if (run) this._mt = setTimeout(() => { if (this.modal !== 'move' || !this.isOpen()) return; api('GET', '/api/admin/exports').then(r => { this.exp = r; if (!(r.state && r.state.running)) { toast(r.state && r.state.error ? 'The export failed.' : 'The library is exported.'); this.paint(); } else this.paintModal(false); }, () => { }); }, 2000);
      const now = el('button', { class: 'btn primary', id: 'adExportNow', disabled: !!run, text: run ? 'Exporting' : 'Export now', onclick: () => { now.disabled = true; now.textContent = 'Exporting'; api('POST', '/api/admin/export').then(r => { this.exp = r; if (r.state && r.state.running) this.paintModal(false); else { toast('The library is exported.'); this.paint(); } }, e => { toast(e.message); this.render(); }); } });
      const list = el('ul', { class: 'act', id: 'adExports' });
      ex.list.forEach(x => list.append(el('li', {}, el('b', { text: when(x.at) }), ` ${fmt.plural(x.items, 'item')}, ${fmt.bytes(x.bytes)} `, el('a', { class: 'linkbtn', href: '/api/admin/exports/' + encodeURIComponent(x.name), download: x.name, text: 'Download' }), el('small', { class: 'muted', text: ' ' + x.name }))));
      if (!ex.list.length) list.append(el('li', { class: 'muted', text: 'No export has been made yet.' }));
      /* import: a file from this computer, or the name of one already in the exports folder of this library's storage */
      const file = el('input', { type: 'file', id: 'adImportFile', accept: '.gz,application/gzip', 'aria-label': 'Export file to import' });
      const named = el('input', { class: 'inp', id: 'adImportName', placeholder: 'Or the name of a file in the exports folder of the storage', maxlength: 150, 'aria-label': 'Name of an export file in storage' });
      const word = el('input', { class: 'inp', id: 'adImportWord', placeholder: 'Type replace', maxlength: 20, autocomplete: 'off', 'aria-label': 'Type the word replace to confirm' });
      const out = el('div', { id: 'adImportOut' });
      const done = r => { out.innerHTML = ''; out.append(el('p', { class: 'ad-p ad-lead', id: 'adImportDone', text: `Imported ${fmt.plural(r.items, 'item')}. ${r.sentence}` }), el('button', { class: 'btn primary', text: 'Open the imported library', onclick: () => location.replace('/') })); };
      const fail = e => { go1.disabled = false; go1.textContent = 'Import'; out.innerHTML = ''; out.append(el('p', { class: 'ad-p ad-warn', id: 'adImportFail', text: e.message })); };
      const go1 = el('button', { class: 'btn', id: 'adImportGo', text: 'Import', onclick: () => {
        const f = file.files[0], name = named.value.trim(); if (!f && !name) return toast('Choose an export file, or type the name of one in storage.');
        if (has && word.value.trim().toLowerCase() !== 'replace') { word.focus(); return toast('Type the word replace to confirm. Importing replaces everything in this library.'); }
        go1.disabled = true; go1.textContent = 'Importing'; out.innerHTML = '';
        if (f) {
          const fd = new FormData(); fd.set('file', f, f.name);
          fetch(`/api/admin/import?replace=${has ? 1 : 0}&confirm=${encodeURIComponent(word.value.trim())}`, { method: 'POST', body: fd, headers: { 'x-afterimage': '1' }, credentials: 'same-origin' }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'The import did not work.'); return d; }).then(done, fail);
        } else api('POST', '/api/admin/import/from-storage', { name, replace: has, confirm: word.value.trim() }).then(done, fail);
      } });
      const where = ex.where === 'bucket' ? `the bucket “${ex.bucket}”` : 'this server’s media folder';
      return { title: 'Move this library', wide: true, body: el('div', { id: 'adMove', class: 'ad-two' },
        el('div', {}, el('h3', { text: 'Export' }),
          el('p', { class: 'ad-p', text: `An export is one file with everything that is not a picture: people, spaces, titles, tags, comments, stories, edits, names of people in the pictures. It is kept in ${where}, under exports/, and the newest three are kept.` }),
          run ? el('p', { class: 'ad-p ad-lead', id: 'adExportRun', text: ex.state.total ? `Exporting: ${fmt.n(ex.state.done || 0)} of ${fmt.n(ex.state.total)} rows.` : 'Exporting.' }) : null,
          ex.state && ex.state.error ? el('p', { class: 'ad-p ad-warn', id: 'adExportFail', text: `The last export failed. ${ex.state.error}` }) : null,
          list, el('div', { class: 'btnrow' }, now)),
        el('div', {}, el('h3', { text: 'Import' }),
          el('p', { class: 'ad-p', text: has ? 'Importing replaces everything in this library with what is in the export. A backup of the database is made first. The files in storage are not touched.' : 'Importing loads an export into this library. The files in storage are not touched.' }),
          file, named, has ? el('p', { class: 'ad-p ad-warn', text: `This library has ${fmt.plural(this.over.storage.items + this.over.trash.n, 'item')}. To replace it, type the word replace.` }) : null, has ? word : null,
          el('div', { class: 'btnrow' }, go1), out),
        el('p', { class: 'vi-note ad-span', text: 'The export does not hold the pictures. Coming from the hosted service: point this server at the same Space (STORAGE_DRIVER=s3 with the same bucket and prefix), then import. Going to the hosted service from pictures on this disk: copy the media folder into your Space first (npm run media:push), then import there.' })) };
    },
    /* who is in the pictures: three windows that live in people.js */
    faces() { return Naming.wait() || Naming.mFaces(); },
    auto() { return Naming.wait() || Naming.mAuto(); },
    recog() { return Naming.wait() || Naming.mRecog(); }
  }
};
