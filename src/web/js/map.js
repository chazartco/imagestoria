/* ---------- map: the same filtered set, laid out by where it was taken ----------
   The street map is OpenFreeMap, drawn in the browser by MapLibre. No key, no account, no usage meter.
   Clustering and the pin-plus-thumbnails markers are ours. The style addresses come from the server
   settings, so a self-hosted tile server can replace OpenFreeMap without touching this file. */
const PIN_SVG = '<svg viewBox="0 0 22 30" width="22" height="30" aria-hidden="true"><path d="M11 29.2S1 17.6 1 10.8a10 10 0 0120 0C21 17.6 11 29.2 11 29.2z" fill="#ffb224" stroke="#1f1600" stroke-width="1.4"/><circle cx="11" cy="10.8" r="3.6" fill="#1f1600"/></svg>';
const mkDot = () => { const d = document.createElement('span'); d.className = 'mk-dot'; return d; };
const mkWrap = child => { const w = document.createElement('div'); w.className = 'mk-wrap'; w.append(child); return w; };
const mapStyle = () => (S.theme === 'light' ? S.cfg.map.light : S.cfg.map.dark);

function MapEngine(box, onMove, onTrouble) {
  const map = new maplibregl.Map({ container: box, style: mapStyle(), center: [0, 20], zoom: 1.4, minZoom: 1, dragRotate: false, pitchWithRotate: false, attributionControl: { compact: true } });
  map.touchZoomRotate.disableRotation(); map.keyboard.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  let styled = false, fellBack = false, marks = [];
  map.on('styledata', () => { styled = true; });
  map.on('error', () => { if (styled) return; if (!fellBack && S.cfg.map.fallback) { fellBack = true; map.setStyle(S.cfg.map.fallback); } else onTrouble(); });
  map.on('moveend', onMove); map.on('load', onMove);
  // position in world pixels at the current zoom, so clusters stay put while the map is dragged
  const world = (lat, lng) => { const s = Math.sin(lat * Math.PI / 180), k = 512 * Math.pow(2, map.getZoom()); return { x: k * (.5 + lng / 360), y: k * (.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) }; };
  return {
    map,
    zoom: () => map.getZoom() + 1,
    px: world,
    bounds: () => { const b = map.getBounds(); return { n: b.getNorth(), s: b.getSouth(), e: b.getEast(), w: b.getWest() }; },
    fit(pts, maxZoom) { const b = new maplibregl.LngLatBounds(); pts.forEach(p => b.extend([p[1], p[0]])); const w = box.clientWidth, r = w > 700 ? 240 : 60; map.fitBounds(b, { padding: { top: 90, bottom: 50, left: 50, right: r }, maxZoom: maxZoom - 1, animate: false }); },
    view(lat, lng, z) { map.jumpTo({ center: [lng, lat], zoom: z - 1 }); },
    markers(list) { marks.forEach(m => m.remove()); marks = list.map(m => new maplibregl.Marker({ element: mkWrap(m.el), anchor: 'top-left' }).setLngLat([m.lng, m.lat]).addTo(map)); },
    resize() { map.resize(); },
    theme() { styled = false; fellBack = false; map.setStyle(mapStyle()); }
  };
}

const MapView = {
  eng: null, fitted: null, note: '', mini: null, broken: false,
  ready() {
    if (this.eng || this.broken) return Promise.resolve(this.eng);
    try { this.eng = MapEngine($('#mapFree'), () => this.moved(), () => { this.note = 'The street map behind the pins could not be loaded. The pins still work.'; this.paintNote(); }); }
    catch (e) { this.broken = true; $('#mapFree').innerHTML = ''; $('#mapFree').append(el('p', { class: 'empty', text: 'This browser could not start the map. It needs WebGL, which is on by default in Chrome, Edge, Firefox and Safari.' })); }
    return Promise.resolve(this.eng);
  },
  paintNote() {
    const all = Lib.inSpace().filter(i => Lib.matches(i, 'area')), missing = all.filter(i => i.lat == null).length, n = $('#mapNote');
    const parts = []; if (missing) parts.push(`${fmt.plural(missing, 'item')} with no location ${missing === 1 ? 'is' : 'are'} not shown`); if (this.note) parts.push(this.note);
    n.hidden = !parts.length; n.textContent = parts.join('. ');
  },
  located() { return Lib.inSpace().filter(i => Lib.matches(i, 'area') && i.lat != null); },
  sig() { return S.space + '|' + S.filters.filter(f => f.type !== 'area').map(f => f.type + f.value).join(','); },
  refresh() {
    return this.ready().then(eng => {
      if (!eng || S.view !== 'map') return; eng.resize();
      const items = this.located(), sig = this.sig();
      if (sig !== this.fitted && items.length) { this.fitted = sig; eng.fit(items.map(i => [i.lat, i.lng]), 13); }
      this.paintNote(); this.moved();
    });
  },
  moved() { this.cluster(); this.tray(); },

  /* a pin with a small bundle of uncropped thumbnails beside it */
  marker(group) {
    const eng = this.eng, sorted = group.slice().sort((a, b) => (b.fav - a.fav) || (b.date - a.date)), byDate = group.slice().sort((a, b) => a.date - b.date), TH = 42, picks = []; let used = 0;
    for (const it of sorted) { if (picks.length >= 3) break; const w = it.ar * Math.min(TH, 170 / it.ar); if (picks.length && used + w > 156) continue; picks.push(it); used += w + 2; }
    const open = () => {
      if (group.length === 1) return Viewer.open(group[0].id, group);
      let n = -90, s = 90, e = -180, w = 180; group.forEach(i => { n = Math.max(n, i.lat); s = Math.min(s, i.lat); e = Math.max(e, i.lng); w = Math.min(w, i.lng); });
      if (eng.zoom() < 16 && Math.hypot(n - s, e - w) > .0004) eng.fit(group.map(i => [i.lat, i.lng]), Math.min(17, Math.ceil(eng.zoom()) + 4)); else Viewer.open(byDate[0].id, byDate);
    };
    let dn = null; const dragged = ev => ev.detail !== 0 && dn && Math.hypot(ev.clientX - dn[0], ev.clientY - dn[1]) > 6;
    const bundle = el('div', { class: 'mk-bundle' });
    picks.forEach(it => { const h = Math.min(TH, 170 / it.ar), im = el('img', { alt: '', draggable: false }); bundle.append(el('button', { class: 'mk-th', style: { width: Math.round(it.ar * h) + 'px', height: Math.round(h) + 'px', background: it.ghost }, title: label(it), 'aria-label': label(it), onclick: ev => { ev.stopPropagation(); if (!dragged(ev)) Viewer.open(it.id, byDate); } }, im)); loadInto(im, it, 'thumb'); });
    if (group.length > picks.length) bundle.append(el('button', { class: 'mk-n', text: '+' + fmt.n(group.length - picks.length), title: 'Zoom in to these ' + group.length, onclick: ev => { ev.stopPropagation(); if (!dragged(ev)) open(); } }));
    return el('div', { class: 'mk', onpointerdown: ev => { dn = [ev.clientX, ev.clientY]; } }, el('button', { class: 'mk-pin', html: PIN_SVG, 'aria-label': group.length > 1 ? `${group.length} items here. Zoom in` : 'Open this photo', onclick: ev => { ev.stopPropagation(); if (!dragged(ev)) open(); } }), bundle);
  },
  cluster() {
    const eng = this.eng; if (!eng) return; const cells = new Map();
    for (const it of this.located()) { const p = eng.px(it.lat, it.lng); if (!p) return; const k = Math.floor(p.x / 236) + ':' + Math.floor(p.y / 92); let c = cells.get(k); if (!c) cells.set(k, c = { items: [], x: 0, y: 0, lat: 0, lng: 0 }); c.items.push(it); c.x += p.x; c.y += p.y; c.lat += it.lat; c.lng += it.lng; }
    const all = [...cells.values()]; all.forEach(c => { const n = c.items.length; c.x /= n; c.y /= n; c.lat /= n; c.lng /= n; });
    // neighbours whose bundles would sit on top of each other are folded into the larger one
    all.sort((a, b) => b.items.length - a.items.length); const kept = [];
    for (const c of all) { const hit = kept.find(k => Math.abs(k.x - c.x) < 218 && Math.abs(k.y - c.y) < 60); if (hit) hit.items.push(...c.items); else kept.push(c); }
    const list = kept.map(c => ({ lat: c.lat, lng: c.lng, el: this.marker(c.items) }));
    list.sort((a, b) => b.lat - a.lat); eng.markers(list);
  },
  inView() { const b = this.eng && this.eng.bounds(); if (!b) return []; const wrap = b.w > b.e; return this.located().filter(i => i.lat <= b.n && i.lat >= b.s && (wrap ? (i.lng >= b.w || i.lng <= b.e) : (i.lng >= b.w && i.lng <= b.e))).sort((a, b2) => b2.date - a.date); },
  tray() {
    if (!this.eng) return; const list = this.inView(), strip = $('#mapStrip'); strip.innerHTML = '';
    $('#mapCount').textContent = list.length ? `${fmt.plural(list.length, 'item')} in this part of the map` : 'Nothing was taken in this part of the map';
    $('#mapToLib').hidden = !list.length;
    list.slice(0, 60).forEach(it => { const im = el('img', { alt: label(it), draggable: false }); strip.append(el('button', { class: 'st', style: { aspectRatio: it.ar, background: it.ghost }, 'aria-label': label(it), onclick: () => Viewer.open(it.id, list) }, im)); loadInto(im, it, 'thumb'); });
    if (list.length > 60) strip.append(el('span', { class: 'muted more', text: `and ${list.length - 60} more` }));
  },
  focus(it) { this.fitted = 'focus'; this.ready().then(eng => { if (!eng) return; setTimeout(() => { eng.resize(); eng.view(it.lat, it.lng, 14); this.fitted = this.sig(); }, 60); }); },
  toLibrary() {
    const b = this.eng && this.eng.bounds(); if (!b) return; S.filters = S.filters.filter(f => f.type !== 'area');
    S.filters.push({ type: 'area', value: b, label: 'Map area' }); go('library'); Lib.changed();
  },

  /* small locator map in the viewer. One map is made once and reused for every photo, which keeps the page light. */
  locator(box, it) {
    if (!box.isConnected) return;
    try {
      if (!this.mini) {
        const d = el('div', { class: 'minimap-g' }); box.append(d);
        const map = new maplibregl.Map({ container: d, style: mapStyle(), center: [it.lng, it.lat], zoom: 9, interactive: false, attributionControl: { compact: true } });
        let ok = false, tried = false; map.on('styledata', () => { ok = true; }); map.on('error', () => { if (!ok && !tried && S.cfg.map.fallback) { tried = true; map.setStyle(S.cfg.map.fallback); } });
        this.mini = { d, map, mk: new maplibregl.Marker({ element: mkWrap(mkDot()), anchor: 'top-left' }).setLngLat([it.lng, it.lat]).addTo(map) };
      } else { const m = this.mini; box.append(m.d); m.map.resize(); m.map.jumpTo({ center: [it.lng, it.lat], zoom: 9 }); m.mk.setLngLat([it.lng, it.lat]); }
    } catch (e) { box.append(el('p', { class: 'vi-note', text: 'The map could not start in this browser.' })); }
  }
};
Bus.on('theme', () => { if (MapView.eng) MapView.eng.theme(); if (MapView.mini) MapView.mini.map.setStyle(mapStyle()); });
Bus.on('synced', () => { if (S.view === 'map') MapView.refresh(); });
