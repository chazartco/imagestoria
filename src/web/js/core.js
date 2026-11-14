/* ---------- core: helpers, state, events ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') { for (const p in v) { if (p.startsWith('--')) n.style.setProperty(p, v[p]); else n.style[p] = v[p]; } }
    else if (k === 'data') Object.assign(n.dataset, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n && k !== 'list') { try { n[k] = v; } catch (e) { n.setAttribute(k, v); } }
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat(3)) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;

function rng(seed) {
  let a = seed >>> 0;
  const f = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  f.r = (a, b) => a + f() * (b - a);
  f.i = (a, b) => Math.floor(a + f() * (b - a + 1));
  f.pick = arr => arr[Math.floor(f() * arr.length)];
  f.chance = p => f() < p;
  return f;
}

/* color */
function hexRgb(h) { h = h.replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); const n = parseInt(h, 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function rgbHex(r, g, b) { return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join(''); }
function rgbHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) { const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
  return [h, s, l];
}
function hslRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360; const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
function mix(h1, h2, t) { const a = hexRgb(h1), b = hexRgb(h2); return rgbHex(lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)); }
function rgba(hex, a) { const c = hexRgb(hex); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; }
/* The afterimage of a color: opposite hue, inverted lightness, softened. */
function ghostOf(hex) {
  const [r, g, b] = hexRgb(hex); const [h, s, l] = rgbHsl(r, g, b);
  const c = hslRgb(h + 180, clamp(s * .55, .08, .5), clamp(1 - l, .22, .46)); return rgbHex(c[0], c[1], c[2]);
}
const BUCKETS = [
  ['red', '#d6453d'], ['orange', '#ee8a2f'], ['yellow', '#f2cf45'], ['green', '#57a55a'], ['teal', '#34b3a8'], ['blue', '#3f7fe0'],
  ['purple', '#8a5bd1'], ['pink', '#e36aa5'], ['brown', '#8a5a3c'], ['white', '#f2f1ec'], ['gray', '#8d9096'], ['black', '#18191b']
];
function bucketOf(hex) {
  const [r, g, b] = hexRgb(hex); const [h, s, l] = rgbHsl(r, g, b);
  if (l < .13) return 'black'; if (l > .88 && s < .5) return 'white'; if (s < .14) return l > .8 ? 'white' : l < .2 ? 'black' : 'gray';
  if (h < 45 && h >= 12 && l < .42 && s < .7) return 'brown';
  if (h < 14 || h >= 345) return 'red'; if (h < 42) return 'orange'; if (h < 68) return 'yellow'; if (h < 160) return 'green';
  if (h < 195) return 'teal'; if (h < 255) return 'blue'; if (h < 300) return 'purple'; return 'pink';
}

/* formatting */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const fmt = {
  bytes(n) { if (n < 1024) return n + ' B'; const u = ['KB', 'MB', 'GB', 'TB']; let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < 3); return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i]; },
  day(ms) { const d = new Date(ms); return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; },
  dayShort(ms) { const d = new Date(ms); return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}`; },
  weekday(ms) { return WEEKDAYS[new Date(ms).getDay()]; },
  month(ms) { const d = new Date(ms); return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; },
  time(ms) { const d = new Date(ms); let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0'); const ap = h < 12 ? 'am' : 'pm'; h = h % 12 || 12; return `${h}:${m} ${ap}`; },
  ago(ms) { const s = (Date.now() - ms) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; if (s < 86400 * 30) return Math.floor(s / 86400) + ' d ago'; return fmt.dayShort(ms); },
  n(v) { return v.toLocaleString('en-US'); },
  dur(s) { s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); },
  plural(n, w, p) { return `${fmt.n(n)} ${n === 1 ? w : (p || w + 's')}`; }
};

/* icons: 24px stroke set drawn for this app */
const ICONS = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.600-7 10-7 10z"/>',
  comment: '<path d="M5 6h14v10H10l-4 3.500V16H5z"/>',
  tag: '<path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8.500" cy="8.500" r="1.200"/>',
  pin: '<path d="M12 21s6-5.700 6-11a6 6 0 10-12 0c0 5.300 6 11 6 11z"/><circle cx="12" cy="10" r="2.200"/>',
  up: '<path d="M12 19V6M6.500 11.500L12 6l5.500 5.500"/>',
  down: '<path d="M12 5v13M6.500 12.500L12 18l5.500-5.500M5 21h14"/>',
  left: '<path d="M14.500 5.500L8 12l6.500 6.500"/>',
  right: '<path d="M9.500 5.500L16 12l-6.500 6.500"/>',
  sliders: '<path d="M5 7h9M18 7h1M5 17h3M12 17h7M5 12h1M10 12h9"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/><circle cx="8" cy="12" r="2"/>',
  trash: '<path d="M5 7h14M10 7V4.500h4V7M7 7l1 12.500h8L17 7"/>',
  zoom: '<circle cx="11" cy="11" r="6.500"/><path d="M16 16l4.500 4.500M8.500 11h5M11 8.500v5"/>',
  play: '<path d="M8 5.500v13l10.500-6.500z"/>',
  pause: '<path d="M8 5.500v13M16 5.500v13"/>',
  undo: '<path d="M8 8H4V4M4 8c2-3 5-4.500 8-4.500a8 8 0 110 16c-3 0-5.500-1.500-7-3.500"/>',
  redo: '<path d="M16 8h4V4M20 8c-2-3-5-4.500-8-4.500a8 8 0 100 16c3 0 5.500-1.500 7-3.500"/>',
  crop: '<path d="M7 3v14h14M3 7h14v14"/>',
  rotl: '<path d="M4 9a8 8 0 111.500 7.500M4 4v5h5"/>',
  rotr: '<path d="M20 9a8 8 0 10-1.500 7.500M20 4v5h-5"/>',
  flip: '<path d="M12 3v18M9 7L4 12l5 5zM15 7l5 5-5 5z"/>',
  cpu: '<rect x="7" y="7" width="10" height="10"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
  people: '<circle cx="9" cy="9" r="3.200"/><path d="M3 19c.500-3.500 3-5 6-5s5.500 1.500 6 5M16 6.200a3 3 0 010 5.600M17.500 14.300c2 .600 3.200 2.200 3.500 4.700"/>',
  more: '<circle cx="6" cy="12" r="1.300"/><circle cx="12" cy="12" r="1.300"/><circle cx="18" cy="12" r="1.300"/>',
  book: '<path d="M4 5.500C6.500 4.500 9.500 4.500 12 6c2.500-1.500 5.500-1.500 8-.500V18c-2.500-1-5.500-1-8 .500-2.500-1.500-5.500-1.500-8-.500zM12 6v12.500"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  panel: '<rect x="4" y="5" width="16" height="14"/><path d="M9.500 5v14"/>',
  eye: '<path d="M2.500 12S6 5.500 12 5.500 21.500 12 21.500 12 18 18.500 12 18.500 2.500 12 2.500 12z"/><circle cx="12" cy="12" r="2.800"/>',
  film: '<rect x="4" y="5" width="16" height="14"/><path d="M4 9h16M4 15h16M8 5v4M12 5v4M16 5v4M8 15v4M12 15v4M16 15v4"/>',
  layers: '<path d="M12 4l8.500 4.500L12 13 3.500 8.500zM3.500 12.500L12 17l8.500-4.500M3.500 16.500L12 21l8.500-4.500"/>',
  loupe: '<circle cx="10.500" cy="10.500" r="6.500"/><path d="M15.500 15.500L21 21"/><circle cx="10.500" cy="10.500" r="2.500"/>',
  chevup: '<path d="M5.500 14.500L12 8l6.500 6.500"/>',
  chevdown: '<path d="M5.500 9.500L12 16l6.500-6.500"/>',
  grip: '<circle cx="9" cy="6.500" r="1.200"/><circle cx="15" cy="6.500" r="1.200"/><circle cx="9" cy="12" r="1.200"/><circle cx="15" cy="12" r="1.200"/><circle cx="9" cy="17.500" r="1.200"/><circle cx="15" cy="17.500" r="1.200"/>',
  cal: '<rect x="4" y="5.500" width="16" height="14.500"/><path d="M4 10h16M8.500 3.500v4M15.500 3.500v4"/>',
  note: '<path d="M9 17.500V5.500l10-2v12"/><circle cx="6.500" cy="17.500" r="2.500"/><circle cx="16.500" cy="15.500" r="2.500"/>',
  sound: '<path d="M4 9.500h3.500L12 5.500v13l-4.500-4H4zM15.500 9a4 4 0 010 6M18 6.500a7.500 7.500 0 010 11"/>',
  link: '<path d="M10 14a4 4 0 005.700 0l3-3A4 4 0 0013 5.300l-1 1M14 10a4 4 0 00-5.700 0l-3 3A4 4 0 0011 18.700l1-1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2.500M12 18.500V21M3 12h2.500M18.500 12H21M5.600 5.600l1.800 1.800M16.600 16.600l1.800 1.800M18.400 5.600l-1.800 1.800M7.400 16.600l-1.800 1.800"/>',
  video: '<rect x="3.500" y="6" width="12" height="12"/><path d="M15.500 10.500l5-3v9l-5-3z"/>',
  copy: '<rect x="8" y="8" width="12" height="12"/><path d="M16 8V4H4v12h4"/>',
  grid: '<rect x="4" y="4" width="7" height="9"/><rect x="13" y="4" width="7" height="5"/><rect x="13" y="11" width="7" height="9"/><rect x="4" y="15" width="7" height="5"/>'
};
function icon(name, size = 18) {
  const p = (ICONS[name] || '').replace(/(\d)\.(\d)00/g, '$1.$2');
  return `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

/* event bus */
const Bus = { m: {}, on(e, f) { (this.m[e] = this.m[e] || []).push(f); }, emit(e, d) { (this.m[e] || []).forEach(f => f(d)); } };

/* toast */
function toast(msg, action) {
  const box = $('#toasts');
  const t = el('div', { class: 'toast', role: 'status' }, el('span', { text: msg }));
  if (action) t.append(el('button', { class: 'linkbtn', text: action.label, onclick: () => { action.fn(); t.remove(); } }));
  box.append(t);
  /* a notice about something that finished while you were elsewhere stays until it is clicked or closed */
  if (action && action.sticky) {
    t.classList.add('sticky'); t.addEventListener('click', e => { if (e.target.closest('.toast-x')) return; action.fn(); t.remove(); });
    t.append(el('button', { class: 'iconbtn toast-x', title: 'Dismiss', 'aria-label': 'Dismiss', html: icon('x', 14), onclick: () => t.remove() }));
    return;
  }
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, action ? 6000 : 3200);
}

/* small popover menu anchored to a button */
let openPop = null;
function closePop() { if (openPop) { openPop.remove(); openPop = null; } }
function popover(anchor, content, opts = {}) {
  closePop();
  const p = el('div', { class: 'pop ' + (opts.class || '') }, content);
  document.body.append(p);
  const r = anchor.getBoundingClientRect(), pr = p.getBoundingClientRect();
  let x = opts.align === 'left' ? r.left : r.right - pr.width; let y = opts.up ? r.top - pr.height - 8 : r.bottom + 8;
  x = clamp(x, 8, innerWidth - pr.width - 8); y = clamp(y, 8, innerHeight - pr.height - 8);
  p.style.left = x + 'px'; p.style.top = y + 'px';
  openPop = p; p._anchor = anchor;
  return p;
}
document.addEventListener('pointerdown', e => { if (openPop && !openPop.contains(e.target) && !(openPop._anchor && openPop._anchor.contains(e.target))) closePop(); }, true);

/* app state */
const S = {
  cfg: null,                // from /api/bootstrap: sign-in options, map styles, limits
  spaces: [], space: null,  // spaces this person can open, and the id of the one on screen
  view: 'library',
  items: [], byId: new Map(),
  filters: [],              // {type, value, label}
  sort: 'new', group: 'month', rowH: 210,
  sel: new Set(), lastSel: null,
  users: [], me: null, stories: [],
  theme: 'dark',
  share: null               // set when the page was opened through a public story link: { token, can: { download, add } }
};
const ROLE_NOTE = {
  owner: 'Everything, including people and settings',
  editor: 'Upload, tag, edit copies, comment, download',
  commenter: 'View, comment, download',
  viewer: 'View only'
};
const can = cap => !!(S.me && S.me.caps[cap]);
const curSpace = () => S.spaces.find(s => s.id === S.space) || S.spaces[0] || { id: null, name: '', kind: 'life' };
/* The round badge that stands for a person: their profile picture when they have one, their initial on their colour when not.
   A profile picture is the one picture here that is cut to fit, because it is a badge and not part of the library. */
function avatarEl(u, cls) {
  const n = el('span', { class: 'av' + (cls ? ' ' + cls : ''), style: { background: u.color || '#8d9096' } });
  if (u.avatar && u.id) n.append(el('img', { class: 'av-img', alt: '', draggable: false, src: `/api/avatars/${u.id}?v=${u.avatar}` })); else n.textContent = (u.name || '?')[0];
  return n;
}
const userById = id => S.users.find(u => u.id === id) || { id, name: 'Someone', color: '#8d9096' };
const store = { get(k, d) { try { const v = localStorage.getItem('afterimage.' + k); return v == null ? d : v; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('afterimage.' + k, v); } catch (e) { } } };

/* talking to the server */
async function api(method, url, body) {
  const opt = { method, headers: { 'x-afterimage': '1' }, credentials: 'same-origin' };
  if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opt); } catch (e) { throw new Error('The server could not be reached. Check your connection.'); }
  if (res.status === 401 && S.me && !S.share) { location.reload(); throw new Error('You were signed out.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'That did not work.');
  return data;
}
/* run a change, show what went wrong if it fails */
function attempt(promise, done) { return promise.then(r => { if (done) toast(done); return r; }, e => { toast(e.message); throw e; }); }
function debounce(fn, ms) { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
