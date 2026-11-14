/* ---------- app shell ---------- */
function go(view) {
  /* People and settings is a modal over whatever is on screen, not a place of its own */
  if (view === 'admin') return Admin.open();
  Admin.close();
  if (view === 'trash' && !can('admin')) view = 'library';
  if (view === 'people' && !seesPeople()) view = 'library';
  S.view = view; closePop();
  $$('.views button').forEach(b => { b.classList.toggle('on', b.dataset.view === view); b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'); });
  $('.browse').hidden = !(view === 'library' || view === 'map');
  $('#v-library').hidden = view !== 'library'; $('#v-map').hidden = view !== 'map'; $('#v-stories').hidden = view !== 'stories'; $('#v-reels').hidden = view !== 'reels'; $('#v-people').hidden = view !== 'people'; $('#v-trash').hidden = view !== 'trash';
  if (view === 'library') { Lib.renderFacets(); Lib.renderBar(); Lib.layout(); }
  if (view === 'map') { Lib.renderFacets(); Lib.renderBar(); MapView.refresh(); }
  if (view === 'stories') { Stories.render(); Stories.load().then(() => { if (S.view === 'stories' && $('#reader').hidden) Stories.render(); }, () => { }); }
  if (view === 'reels') ReelPage.render(); else ReelPage.leave();
  if (view === 'trash') Trash.render();
  if (view === 'people') People.render();
  $('#bulk').hidden = view !== 'library' || !S.sel.size;
}
function paintSpaces() {
  const box = $('.spaces'); box.innerHTML = ''; box.hidden = S.spaces.length < 2;
  S.spaces.forEach(s => box.append(el('button', { role: 'tab', class: s.id === S.space ? 'on' : '', 'aria-selected': s.id === S.space, text: s.name, onclick: () => setSpace(s.id) })));
  $('#btnAddSpace').hidden = !can('admin');
  const sel = $('#spaceSel'); sel.innerHTML = ''; S.spaces.forEach(s => sel.append(el('option', { value: s.id, text: s.name, selected: s.id === S.space }))); sel.onchange = () => setSpace(sel.value);
  /* People is for the owner and editors. It shows as soon as they may use it, and says so when recognition is off for the space. */
  $('.views [data-view=people]').hidden = !seesPeople();
  /* with many spaces the tabs scroll sideways: keep the one in use in sight */
  showSpaceTab();
}
addEventListener('resize', () => { if (S.me && S.spaces) showSpaceTab(); });
function showSpaceTab() {
  /* On a phone the tabs share a line with the account button. When they do not all fit, they become a menu, so nothing is pushed off the screen.
     On any screen they also become a menu when the line is so tight that not even the tab in use fits (a phone held sideways). */
  const bar = $('.spacebar'); bar.classList.remove('asmenu'); $('#spaceSel').hidden = true;
  const box = $('.spaces'), on = $('button.on', box);
  if (S.spaces.length > 1 && box.scrollWidth > box.clientWidth + 1 && (matchMedia('(max-width: 820px)').matches || (on && box.clientWidth < on.offsetWidth + 4))) { bar.classList.add('asmenu'); $('#spaceSel').hidden = false; return; }
  if (!on || box.scrollWidth <= box.clientWidth) return;
  const b = box.getBoundingClientRect(), r = on.getBoundingClientRect(); box.scrollLeft += r.left - b.left - (b.width - r.width) / 2;
}
/* owners add a space right where the spaces are */
function addSpacePop(btn) {
  const name = el('input', { class: 'inp', id: 'newSpaceName', placeholder: 'Name, for example Family', maxlength: 60, 'aria-label': 'Name for the new space' });
  const kind = el('select', { class: 'inp', id: 'newSpaceKind', 'aria-label': 'How the new space is arranged' }, el('option', { value: 'life', text: 'By date, like a photo roll' }), el('option', { value: 'studio', text: 'By series, like a portfolio' }));
  const add = () => {
    const v = name.value.trim(); if (!v) return name.focus();
    closePop(); attempt(api('POST', '/api/spaces', { name: v, kind: kind.value }), `Added the space ${v}`).then(s => reloadShell().then(() => { setSpace(s.id); if (Admin.isOpen()) Admin.render(); }), () => { });
  };
  name.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  popover(btn, el('div', { class: 'tagpop' }, el('p', { class: 'pop-h', text: 'Add a space' }), el('p', { class: 'vi-note newspace-note', text: 'A space is a separate library with its own people.' }), name, kind, el('div', { class: 'rowr' }, el('button', { class: 'btn small primary', id: 'newSpaceAdd', text: 'Add space', onclick: add }))), { align: 'left' });
  name.focus();
}
function setSpace(id) {
  if (!S.spaces.some(s => s.id === id)) id = S.spaces[0] ? S.spaces[0].id : null;
  S.space = id; S.sel.clear(); S.filters = []; store.set('space', id || '');
  const studio = curSpace().kind === 'studio';
  paintSpaces();
  $('#optSeries').hidden = !studio; $('#selGroup').value = S.group = studio ? 'series' : 'month';
  Lib.compute(); Bus.emit('sel'); $('#gridScroll').scrollTop = 0; go(S.view);
  Dupes.load(true); Sugg.load(true);
}
function setTheme(t) { S.theme = t; document.documentElement.dataset.theme = t; store.set('theme', t); Bus.emit('theme'); }
function paintMe() {
  const u = S.me, av = $('#btnMe'); av.innerHTML = ''; av.style.background = u.color; av.title = `${u.name}, ${u.role}`;
  if (u.avatar) av.append(el('img', { class: 'av-img', alt: '', draggable: false, src: `/api/avatars/${u.id}?v=${u.avatar}` })); else av.textContent = (u.name || '?')[0];
  $('#btnUpload').hidden = !can('upload');
}
/* names, roles and spaces as the server now has them (after a change on the settings page) */
function reloadShell() {
  return api('GET', '/api/bootstrap').then(b => {
    if (!b.me) return location.reload();
    S.cfg = b; S.me = b.me; S.users = b.people; S.spaces = b.spaces; paintMe();
    if (!S.spaces.some(s => s.id === S.space)) setSpace(S.spaces[0] && S.spaces[0].id); else { paintSpaces(); $('#optSeries').hidden = curSpace().kind !== 'studio'; }
  });
}

/* a small form in a sheet: used for changing the password */
function passwordSheet() {
  const cur = el('input', { class: 'inp', type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password' });
  const next = el('input', { class: 'inp', type: 'password', autocomplete: 'new-password', minlength: 10, 'aria-label': 'New password' });
  const msg = el('p', { class: 'gate-err', hidden: true });
  const form = el('form', { class: 'gate-form', onsubmit: e => {
    e.preventDefault(); msg.hidden = true;
    if (next.value.length < 10) { msg.hidden = false; msg.textContent = 'Use at least 10 characters.'; return; }
    api('POST', '/api/me/password', { current: cur.value || undefined, next: next.value }).then(() => { S.me.hasPassword = true; sheet.remove(); toast('Password changed'); }, er => { msg.hidden = false; msg.textContent = er.message; });
  } },
    S.me.hasPassword ? el('label', {}, 'Current password', cur) : el('p', { class: 'vi-note', text: 'You sign in with ' + (S.cfg.auth.oidc ? S.cfg.auth.oidc.name : 'single sign-on') + ' today. A password gives you a second way in.' }),
    el('label', {}, 'New password, at least 10 characters', next), msg,
    el('div', { class: 'rowr' }, el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => sheet.remove() }), el('button', { class: 'btn primary', type: 'submit', text: 'Save password' })));
  const sheet = el('div', { class: 'overlay sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Change password', onclick: e => { if (e.target === sheet) sheet.remove(); } }, el('div', { class: 'sheet-box narrow' }, el('header', {}, el('h2', { text: S.me.hasPassword ? 'Change password' : 'Set a password' })), form));
  document.body.append(sheet); (S.me.hasPassword ? cur : next).focus();
}
/* a profile picture: choose a file, the server makes the small square copy */
function afterAvatar() { return reloadShell().then(() => { if (Admin.isOpen()) Admin.render(); if (!$('#viewer').hidden && Viewer.item) Viewer.paintComments(); }); }
function pickAvatar() {
  const inp = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,image/avif', hidden: true });
  inp.addEventListener('change', () => {
    const f = inp.files[0]; inp.remove(); if (!f) return;
    const fd = new FormData(); fd.set('file', f, f.name);
    attempt(fetch('/api/me/avatar', { method: 'POST', body: fd, headers: { 'x-afterimage': '1' }, credentials: 'same-origin' }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'The picture could not be saved.'); return d; }), 'Profile picture saved').then(afterAvatar, () => { });
  });
  document.body.append(inp); inp.click();
}
function meMenu(btn) {
  const u = S.me, list = el('div', { class: 'menu' }), sso = S.cfg.auth.oidc;
  list.append(el('div', { class: 'me-h' }, avatarEl(u), el('div', {}, el('b', { text: u.name }), el('small', { class: 'muted', text: ` ${u.email || u.handle || ''}` }), el('p', { class: 'muted me-role', text: ROLE_NOTE[u.role] }))));
  list.append(el('hr'), el('button', { class: 'mi', html: icon('sun', 16) + `<span>${S.theme === 'dark' ? 'Light' : 'Dark'} theme</span>`, onclick: () => { setTheme(S.theme === 'dark' ? 'light' : 'dark'); closePop(); } }));
  if (can('admin')) list.append(el('button', { class: 'mi', html: icon('people', 16) + '<span>People and settings</span>', onclick: () => { closePop(); go('admin'); } }));
  if (S.cfg.auth.local) list.append(el('button', { class: 'mi', html: icon('eye', 16) + `<span>${u.hasPassword ? 'Change password' : 'Set a password'}</span>`, onclick: () => { closePop(); passwordSheet(); } }));
  if (sso && !u.oidcLinked) list.append(el('button', { class: 'mi', html: icon('link', 16) + `<span>Connect ${esc(sso.name)}</span>`, onclick: () => { location.href = '/api/auth/oidc/start?link=1'; } }));
  list.append(el('button', { class: 'mi', html: icon('book', 16) + '<span>Keyboard shortcuts</span>', onclick: () => { closePop(); $('#keys').hidden = false; } }));
  list.append(el('hr'), el('button', { class: 'mi', html: icon('right', 16) + '<span>Sign out</span>', onclick: () => api('POST', '/api/auth/logout').then(() => location.replace('/'), () => location.replace('/')) }));
  popover(btn, list);
}

/* ---------- the door: first-run setup, sign-in, invites, password resets ---------- */
const AUTH_ERRORS = {
  off: 'Single sign-on is not set up on this server.',
  denied: 'The sign-in was cancelled.',
  state: 'That sign-in took too long, or was started in another tab. Try again.',
  exchange: 'The sign-in could not be completed. Try again in a moment.',
  userinfo: 'The sign-in could not be completed. Try again in a moment.',
  provider: 'The sign-in service could not be reached. Try again in a moment.',
  disabled: 'Your access to this library has been turned off. Ask the owner.',
  not_invited: 'You are not on the list for this library. Ask the owner for an invite.'
};
const Gate = {
  show(title, lead, ...body) {
    const g = $('#gate'); g.hidden = false; $('#bootWait').hidden = true; $('#gateCard').innerHTML = '';
    $('#gateCard').append(...[el('h1', { text: title }), lead ? el('p', { class: 'gate-lead', text: lead }) : null, ...body].filter(Boolean));
    const first = $('#gateCard input:not([readonly])'); if (first) first.focus();
  },
  field(label, attrs) { const inp = el('input', { class: 'inp', ...attrs }); return [el('label', {}, label, inp), inp]; },
  form(fields, button, submit) {
    const msg = el('p', { class: 'gate-err', role: 'alert', hidden: true }), btn = el('button', { class: 'btn primary', type: 'submit', text: button });
    return el('form', { class: 'gate-form', onsubmit: e => {
      e.preventDefault(); msg.hidden = true; btn.disabled = true;
      Promise.resolve().then(submit).then(() => location.replace('/'), er => { btn.disabled = false; msg.hidden = false; msg.textContent = er.message; });
    } }, ...fields, msg, btn);
  },
  sso(label, query) { const o = S.cfg.auth.oidc; return o ? el('a', { class: 'btn sso', href: '/api/auth/oidc/start' + (query || ''), text: `${label} ${o.name}` }) : null; },
  or() { return S.cfg.auth.local && S.cfg.auth.oidc ? el('p', { class: 'gate-or', text: 'or' }) : null; },
  password(v) { if (v.length < 10) throw new Error('Use at least 10 characters for the password.'); return v; },

  setup() {
    const [ln, name] = this.field('Your name', { autocomplete: 'name', required: true, maxlength: 80 }), [le, email] = this.field('Email', { type: 'email', autocomplete: 'email', required: true }), [lp, pw] = this.field('Password, at least 10 characters', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
    this.show('Set up your library', 'Nobody has an account here yet. The first person in becomes the owner, who decides who else may open it.',
      S.cfg.auth.local ? this.form([ln, le, lp], 'Create the owner account', () => api('POST', '/api/setup', { name: name.value, email: email.value, password: this.password(pw.value) })) : null,
      this.or(), this.sso('Become the owner with'));
  },
  signin(error) {
    const [le, email] = this.field('Email', { type: 'email', autocomplete: 'username', required: true }), [lp, pw] = this.field('Password', { type: 'password', autocomplete: 'current-password', required: true });
    this.show('Sign in', 'This library is private. Only people the owner has added can open it.',
      error ? el('p', { class: 'gate-err', role: 'alert', text: AUTH_ERRORS[error] || 'The sign-in did not work. Try again.' }) : null,
      S.cfg.auth.local ? this.form([le, lp], 'Sign in', () => api('POST', '/api/auth/login', { email: email.value, password: pw.value })) : null,
      this.or(), this.sso('Continue with'),
      S.cfg.auth.local ? el('p', { class: 'gate-foot', text: 'Forgot your password? Ask the owner for a reset link.' }) : null);
  },
  async link(token, fallbackError) {
    let info;
    try { info = await api('GET', '/api/auth/link/' + encodeURIComponent(token)); }
    catch (e) { return this.show('This link no longer works', e.message, el('a', { class: 'btn', href: '/', text: 'Go to sign in' })); }
    if (info.kind === 'reset') {
      const [lp, pw] = this.field('New password, at least 10 characters', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
      return this.show('Choose a new password', `For ${info.name}${info.email ? ', ' + info.email : ''}.`, this.form([lp], 'Save and sign in', () => api('POST', '/api/auth/reset', { token, password: this.password(pw.value) })));
    }
    const [ln, name] = this.field('Your name', { autocomplete: 'name', required: true, maxlength: 80, value: info.name || '' }), [le, email] = this.field('Email', { type: 'email', autocomplete: 'email', required: true, value: info.email || '' }), [lp, pw] = this.field('Password, at least 10 characters', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
    this.show('You are invited', `You can join this library as ${info.role === 'editor' ? 'an editor' : 'a ' + info.role}. ${ROLE_NOTE[info.role]}.`,
      fallbackError ? el('p', { class: 'gate-err', role: 'alert', text: AUTH_ERRORS[fallbackError] || '' }) : null,
      S.cfg.auth.local ? this.form([ln, le, lp], 'Join', () => api('POST', '/api/auth/accept-invite', { token, name: name.value, email: email.value, password: this.password(pw.value) })) : null,
      this.or(), this.sso('Join with', '?invite=' + encodeURIComponent(token)));
  }
};

function startApp(b) {
  S.me = b.me; S.users = b.people; S.spaces = b.spaces;
  $('#app').hidden = false; $('#bootWait').hidden = true; paintMe();
  initLibrary(); initLens(); initViewer(); initEditor();
  $$('.views button').forEach(x => x.onclick = () => go(x.dataset.view));
  $('.brand').onclick = e => { e.preventDefault(); Lib.clear(); go('library'); };
  $('#btnMe').onclick = e => meMenu(e.currentTarget); $('#adClose').onclick = () => Admin.close(); $('#admin').addEventListener('click', e => { if (e.target === e.currentTarget) Admin.close(); }); $('#btnAddSpace').onclick = e => addSpacePop(e.currentTarget);
  $('#btnUpload').onclick = () => Upload.open(); $('#emptyAdd').onclick = () => Upload.open();
  $('#upClose').onclick = () => Upload.close(); $('#keysClose').onclick = () => $('#keys').hidden = true;
  $('#upPick').onclick = () => $('#upFiles').click(); $('#upFolder').onclick = () => $('#upDir').click();
  $('#upFiles').onchange = e => { Upload.add(e.target.files); e.target.value = ''; }; $('#upDir').onchange = e => { Upload.add(e.target.files); e.target.value = ''; };
  $('#mapToLib').onclick = () => MapView.toLibrary();
  $('#emptyClear').onclick = () => Lib.clear();
  $('#plClose').onclick = () => Player.close(); $('#plPrev').onclick = () => Player.step(-1); $('#plNext').onclick = () => Player.step(1); $('#plPlay').onclick = () => Player.toggle(); $('#plUnmute').onclick = () => Player.unmute();
  // drop files anywhere
  /* Only files from outside: dragging a picture that is already on the page also says "Files", and must not add it to the library. */
  let depth = 0, own = false; addEventListener('dragstart', () => { own = true; }, true); addEventListener('dragend', () => { own = false; }, true);
  const hasFiles = e => !own && e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  addEventListener('dragenter', e => { if (!hasFiles(e) || !can('upload')) return; depth++; $('#dropzone').hidden = false; });
  addEventListener('dragleave', e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) $('#dropzone').hidden = true; });
  addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; $('#dropzone').hidden = true; if (can('upload')) Upload.add(e.dataTransfer.files); });
  // keys
  addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
    if (e.key === 'Escape') {
      if (openPop) return closePop(); if (typing) return e.target.blur();
      const extra = $('.overlay.sheet:not([id])'); if (extra) return extra._close ? extra._close() : extra.remove();
      if (!$('#keys').hidden) return $('#keys').hidden = true; if (Admin.isOpen() && $('#viewer').hidden && $('#editor').hidden) return Admin.esc(); /* a picture opened from the settings page closes first */ if (!$('#player').hidden) return Player.close(); if (!$('#editor').hidden) return Editor.close();
      if (!$('#viewer').hidden) return Zoom.item ? Zoom.close() : Viewer.close(); if (!$('#reader').hidden) return Stories.close(); if (!$('#upload').hidden) return Upload.close(); if (S.sel.size) { S.sel.clear(); Bus.emit('sel'); } return;
    }
    if (typing) return;
    if (!$('#editor').hidden) { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); Editor.restore(Editor.hi + (e.shiftKey ? 1 : -1)); } return; }
    if (!$('#player').hidden) { if (e.key === 'ArrowRight') Player.step(1); else if (e.key === 'ArrowLeft') Player.step(-1); else if (e.key === ' ') { e.preventDefault(); Player.toggle(); } return; }
    if (!$('#viewer').hidden) {
      const it = Viewer.item; if (!it || e.metaKey || e.ctrlKey) return;
      if (e.key === 'ArrowRight') Viewer.step(1); else if (e.key === 'ArrowLeft') Viewer.step(-1); else if (e.key === 'f') Viewer.toggleLike();
      else if (e.key === 'e' && can('edit') && it.kind !== 'video' && it.status === 'ready') Editor.open(it); else if (e.key === 'z') Zoom.toggle(it);
      else if (e.key === ' ' && it.kind === 'video') { if (e.target.tagName !== 'VIDEO') { e.preventDefault(); Viewer.togglePlay(); } }
      else if (Zoom.item) { const [cx, cy] = Zoom.center(); if (e.key === '+' || e.key === '=') Zoom.zoomAt(cx, cy, Zoom.s * 1.4); else if (e.key === '-') Zoom.zoomAt(cx, cy, Zoom.s / 1.4); else if (e.key === '0') Zoom.close(); else if (e.key === '1') Zoom.zoomAt(cx, cy, 1); }
      return;
    }
    if (e.key === '/') { e.preventDefault(); $('#lensInput').focus(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && S.view === 'library') { e.preventDefault(); Lib.list.forEach(i => S.sel.add(i.id)); Bus.emit('sel'); }
  });
  addEventListener('resize', () => { showSpaceTab(); if (!$('#reader').hidden || S.view === 'stories') { clearTimeout(startApp._rt); startApp._rt = setTimeout(() => Stories.relayout(), 150); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) Sync.soon(); });

  if (!S.spaces.length) { $('#app').hidden = true; return Gate.show('Nothing to open yet', 'You are signed in, but the owner has not given you a space. Ask them to tick one for you in People and settings.', el('button', { class: 'btn', text: 'Sign out', onclick: () => api('POST', '/api/auth/logout').then(() => location.replace('/')) })); }
  const saved = store.get('space', '');
  setSpace(S.spaces.some(s => s.id === saved) ? saved : S.spaces[0].id);
  Sync.schedule();
}

async function boot() {
  $$('[data-ic]').forEach(n => { n.outerHTML = icon(n.dataset.ic, +n.dataset.size || 18); });
  $('#lensIc').innerHTML = icon('search'); $('#upIc').innerHTML = icon('up', 16); $('#btnFacets').innerHTML = icon('panel');
  const t = store.get('theme', ''); S.theme = t === 'light' ? 'light' : 'dark'; document.documentElement.dataset.theme = S.theme;
  /* a public story link: the visitor gets the story and the slideshow, and none of the rest */
  const shared = /^\/s\/([\w-]{16,80})\/?$/.exec(location.pathname); if (shared) return Share.boot(shared[1]);
  let b;
  try { b = await api('GET', '/api/bootstrap'); }
  catch (e) { S.cfg = { auth: {} }; return Gate.show('The server is not answering', 'ImageStoria could not load. Check that the server is running, then reload this page.', el('button', { class: 'btn', text: 'Reload', onclick: () => location.reload() })); }
  S.cfg = b;
  const q = new URLSearchParams(location.search), clean = () => history.replaceState(null, '', location.pathname);
  if (b.setupNeeded) return Gate.setup();
  if (q.get('reset')) return Gate.link(q.get('reset'));
  if (!b.me && q.get('invite')) return Gate.link(q.get('invite'), q.get('auth_error'));
  if (!b.me) return Gate.signin(q.get('auth_error'));
  const linked = q.get('linked'), err = q.get('auth_error'); if (location.search) clean();
  try { await Promise.all([Sync.full(), Stories.load()]); }
  catch (e) { return Gate.show('The library could not be loaded', e.message, el('button', { class: 'btn', text: 'Reload', onclick: () => location.reload() })); }
  startApp(b);
  if (linked) toast(`${b.auth.oidc ? b.auth.oidc.name : 'Single sign-on'} is now connected to your account.`);
  else if (err) toast(AUTH_ERRORS[err] || 'That did not work.');
}
document.addEventListener('DOMContentLoaded', boot);
