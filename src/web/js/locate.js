/* ---------- location dialog: put one item, or a whole selection, on the map ----------
   Some cameras write no GPS (glasses, scans, screenshots). This is where a person says where a picture was taken:
   by clicking the map, by searching for a town (the server looks it up in its own list, no outside service),
   by picking a place the library already knows, or by typing coordinates. */
const LocDialog = {
  sheet: null, map: null, mk: null, pt: null, items: [], done: null,
  recent() { try { return JSON.parse(store.get('recentLocs', '[]')).filter(r => r && isFinite(r.lat) && isFinite(r.lng)).slice(0, 5); } catch (e) { return []; } },
  remember(pt) {
    const rest = this.recent().filter(r => Math.abs(r.lat - pt.lat) > 1e-4 || Math.abs(r.lng - pt.lng) > 1e-4);
    store.set('recentLocs', JSON.stringify([{ lat: pt.lat, lng: pt.lng, label: pt.label }, ...rest].slice(0, 5)));
  },
  coords(lat, lng) { return `${(+lat).toFixed(4)}, ${(+lng).toFixed(4)}`; },
  /* a name for a spot nobody named: the closest place the library already knows, if one is close */
  near(lat, lng) {
    let best = null, bd = .45;
    for (const k in PLACES) { const p = PLACES[k], d = Math.hypot(p.lat - lat, (p.lng - lng) * Math.cos(lat * Math.PI / 180)); if (d < bd) { bd = d; best = p; } }
    return best ? (bd < .02 ? best.name : 'Near ' + best.name) : this.coords(lat, lng);
  },

  open(items, done) {
    items = items.filter(Boolean); if (!items.length || !can('tag')) return;
    this.close(); this.items = items; this.done = done || null; this.pt = null;
    const n = items.length, have = items.filter(i => i.lat != null), need = n - have.length, many = n > 1;
    const status = el('p', { class: 'loc-status', id: 'locStatus', text: 'Click the map, search for a place, or pick one below.' });
    const apply = el('button', { class: 'btn primary', id: 'locApply', disabled: true, text: many ? 'Set location' : 'Save location', onclick: () => this.apply() });
    const coordInp = el('input', { class: 'inp', id: 'locCoords', placeholder: 'Latitude, longitude', 'aria-label': 'Coordinates: latitude, a comma, longitude', autocomplete: 'off' });
    const readCoords = () => {
      const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(coordInp.value);
      if (!m || Math.abs(+m[1]) > 90 || Math.abs(+m[2]) > 180) return toast('Write the latitude, a comma, then the longitude. For example 48.8584, 2.2945.');
      this.set(+m[1], +m[2], null, true);
    };
    coordInp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); readCoords(); } });
    coordInp.addEventListener('change', () => { if (coordInp.value.trim()) readCoords(); });

    /* search: towns and cities by name */
    const results = el('div', { class: 'loc-results', id: 'locResults', role: 'listbox' });
    const search = el('input', { class: 'inp', id: 'locSearch', type: 'search', placeholder: 'Search for a town or city', 'aria-label': 'Search for a town or city', autocomplete: 'off', spellcheck: false });
    let asked = 0;
    const look = debounce(() => {
      const q = search.value.trim(), mine = ++asked; if (q.length < 2) { results.innerHTML = ''; return; }
      api('GET', '/api/places/search?q=' + encodeURIComponent(q)).then(r => {
        if (mine !== asked || !this.sheet) return; results.innerHTML = '';
        if (!r.places.length) return results.append(el('p', { class: 'vi-note', text: 'No town or city by that name. Try the map, or type coordinates.' }));
        r.places.forEach(p => results.append(el('button', { class: 'loc-hit', role: 'option', onclick: () => this.set(p.lat, p.lng, `${p.name}, ${p.region}`, true) }, el('b', { text: p.name }), el('span', { text: p.region }), el('span', { class: 'n', text: p.population ? fmt.n(p.population) + ' people' : '' }))));
      }, e => { if (mine === asked) toast(e.message); });
    }, 220);
    search.addEventListener('input', look);
    search.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const first = $('.loc-hit', results); if (first) first.click(); }
      /* the dialog opens with the search box in focus: Esc clears what was typed, and closes the dialog when the box is empty */
      else if (e.key === 'Escape') { e.stopPropagation(); if (search.value) { search.value = ''; results.innerHTML = ''; asked++; } else this.close(); }
    });

    /* places this library already has, most used first */
    const counts = new Map(); S.items.forEach(i => { if (i.place && PLACES[i.place]) counts.set(i.place, (counts.get(i.place) || 0) + 1); });
    const known = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => PLACES[k]);
    const chip = (label, lat, lng, title) => el('button', { class: 'chip', text: label, title: title || this.coords(lat, lng), onclick: () => this.set(lat, lng, label, true) });
    const recent = this.recent();
    const side = el('div', { class: 'loc-side' },
      recent.length ? el('section', { id: 'locRecent' }, el('h4', { text: 'Used lately' }), el('div', { class: 'fvals wrap' }, recent.map(r => chip(r.label || this.coords(r.lat, r.lng), r.lat, r.lng)))) : null,
      el('section', {}, el('h4', { text: 'Search' }), search, results),
      known.length ? el('section', { id: 'locKnown' }, el('h4', { text: 'Already in this library' }), el('div', { class: 'fvals wrap loc-known' }, known.map(p => chip(p.name, p.lat, p.lng, `${p.name}, ${p.region}`)))) : null,
      el('section', {}, el('h4', { text: 'Coordinates' }), coordInp));

    /* which of the selection to change, when some of it already has a location */
    let scope = null;
    if (many && have.length) {
      const radio = (value, text, checked, disabled) => el('label', { class: 'loc-opt' }, el('input', { type: 'radio', name: 'locOnly', value, checked, disabled }), text);
      scope = el('div', { class: 'loc-scope', id: 'locScope' },
        el('p', { text: `${fmt.plural(have.length, 'item')} of these already ${have.length === 1 ? 'has' : 'have'} a location.` }),
        radio('missing', need ? `Only the ${fmt.n(need)} without a location` : 'Only the ones without a location (there are none)', need > 0, !need),
        radio('all', `All ${fmt.n(n)} of them`, !need, false));
    }
    const remove = have.length ? el('button', { class: 'btn', id: 'locRemove', text: 'Remove location', onclick: e => popover(e.currentTarget, el('div', { class: 'confirm' },
      el('p', { text: many ? `Remove the location from ${fmt.plural(have.length, 'item')}? They will no longer show on the map.` : 'Remove the location from this item? It will no longer show on the map.' }),
      el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Keep', onclick: closePop }), el('button', { class: 'btn small danger', id: 'locRemoveYes', text: 'Remove location', onclick: () => { closePop(); this.remove(); } }))), { up: true }) }) : null;

    const mapBox = el('div', { class: 'loc-map', id: 'locMap' });
    const sheet = this.sheet = el('div', { class: 'overlay sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Location', onclick: e => { if (e.target === sheet) this.close(); } },
      el('div', { class: 'sheet-box loc-box' },
        el('header', {}, el('h2', { text: many ? `Where were these ${fmt.n(n)} taken?` : 'Where was this taken?' }), el('button', { class: 'iconbtn modal-x', id: 'locClose', title: 'Close', 'aria-label': 'Close', html: icon('x'), onclick: () => this.close() })),
        el('div', { class: 'loc-main' }, side, el('div', { class: 'loc-mapcol' }, mapBox, status)),
        scope, el('div', { class: 'rowr loc-foot' }, remove, el('span', { class: 'grow1' }), el('button', { class: 'btn', text: 'Cancel', onclick: () => this.close() }), apply)));
    sheet._close = () => this.close();
    document.body.append(sheet);

    /* the map: a click drops the pin, and the pin can be dragged */
    const first = have[0], lib = S.items.filter(i => i.lat != null && i.space === S.space);
    try {
      const map = this.map = new maplibregl.Map({ container: mapBox, style: mapStyle(), center: first ? [first.lng, first.lat] : [0, 20], zoom: first ? 10 : 1.2, minZoom: 1, dragRotate: false, pitchWithRotate: false, attributionControl: { compact: true } });
      map.touchZoomRotate.disableRotation(); map.keyboard.disableRotation(); map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      let ok = false, tried = false; map.on('styledata', () => { ok = true; }); map.on('error', () => { if (!ok && !tried && S.cfg.map.fallback) { tried = true; map.setStyle(S.cfg.map.fallback); } });
      map.on('click', e => this.set(e.lngLat.lat, e.lngLat.lng, null, false));
      map.getCanvas().style.cursor = 'crosshair';
      /* start where it helps: on the item's own spot, else around what the selection or the library already has */
      const around = !first && (have.length ? have : lib);
      if (around && around.length) { const b = new maplibregl.LngLatBounds(); around.forEach(i => b.extend([i.lng, i.lat])); map.fitBounds(b, { padding: 50, maxZoom: 10, animate: false }); }
    } catch (e) { mapBox.append(el('p', { class: 'vi-note', text: 'The map could not start in this browser. Search, pick a place or type coordinates instead.' })); }
    if (!many && first) this.set(first.lat, first.lng, first.place && PLACES[first.place] ? PLACES[first.place].name : null, false, true);
    search.focus();
  },
  close() {
    if (!this.sheet) return; closePop();
    if (this.map) { try { this.map.remove(); } catch (e) { } }
    this.sheet.remove(); this.sheet = this.map = this.mk = this.pt = null; this.items = []; this.done = null;
  },
  /* choose a point. fly: move the map there. untouched: this is where the item already is, so there is nothing to save yet. */
  set(lat, lng, label, fly, untouched) {
    if (!this.sheet) return;
    lng = ((lng + 180) % 360 + 360) % 360 - 180; lat = clamp(lat, -90, 90);
    this.pt = { lat, lng, label: label || this.near(lat, lng) };
    if (this.map) {
      if (!this.mk) { this.mk = new maplibregl.Marker({ draggable: true, color: '#ffb224' }).setLngLat([lng, lat]).addTo(this.map); this.mk.on('dragend', () => { const p = this.mk.getLngLat(); this.set(p.lat, p.lng, null, false); }); }
      else this.mk.setLngLat([lng, lat]);
      if (fly) this.map.jumpTo({ center: [lng, lat], zoom: Math.max(this.map.getZoom(), 10) });
    }
    $('#locCoords').value = this.coords(lat, lng);
    $('#locStatus').textContent = `${this.pt.label}${this.pt.label === this.coords(lat, lng) ? '' : ' (' + this.coords(lat, lng) + ')'}. Drag the pin to adjust it.`;
    $('#locApply').disabled = !!untouched;
  },
  apply() {
    const pt = this.pt, items = this.items, done = this.done; if (!pt) return;
    const sc = $('#locScope input:checked'), only = items.length > 1 && sc ? sc.value : 'all';
    const targets = only === 'all' ? items : items.filter(i => i.lat == null);
    $('#locApply').disabled = true;
    attempt(Lib.send(items, 'locate', { lat: pt.lat, lng: pt.lng, only })).then(r => {
      targets.forEach(i => { i.lat = pt.lat; i.lng = pt.lng; i.locSrc = 'manual'; i.hay = null; });
      this.remember(pt); this.close();
      toast(r.n ? `Location set on ${fmt.plural(r.n, 'item')}: ${pt.label}` : 'Nothing was changed. Every selected item already has a location.');
      Lib.refresh(); Sync.soon(); if (done) done();
    }, () => { const b = $('#locApply'); if (b) b.disabled = false; });
  },
  remove() {
    const items = this.items, done = this.done, targets = items.filter(i => i.lat != null);
    attempt(Lib.send(items, 'unlocate')).then(r => {
      targets.forEach(i => { i.lat = i.lng = null; i.place = null; i.locSrc = null; i.hay = null; });
      this.close(); toast(`Location removed from ${fmt.plural(r.n, 'item')}`);
      Lib.refresh(); Sync.soon(); if (done) done();
    }, () => { });
  }
};
