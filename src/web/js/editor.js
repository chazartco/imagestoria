/* ---------- editor: develop a copy, never the original ---------- */
const ADJ = [
  ['Look', [['amount', 'Intensity', 0, 100]]],
  ['Light', [['exposure', 'Exposure', -100, 100], ['contrast', 'Contrast', -100, 100], ['highlights', 'Highlights', -100, 100], ['shadows', 'Shadows', -100, 100], ['whites', 'Whites', -100, 100], ['blacks', 'Blacks', -100, 100]]],
  ['Color', [['temp', 'Temperature', -100, 100, 'temp'], ['tint', 'Tint', -100, 100, 'tint'], ['vibrance', 'Vibrance', -100, 100], ['saturation', 'Saturation', -100, 100]]],
  ['Curve', 'curve'],
  ['Color mixer', 'mixer'],
  ['Color grade', [['shHue', 'Shadow hue', 0, 360, 'hue'], ['shAmt', 'Shadow amount', 0, 100], ['mdHue', 'Midtone hue', 0, 360, 'hue'], ['mdAmt', 'Midtone amount', 0, 100], ['hlHue', 'Highlight hue', 0, 360, 'hue'], ['hlAmt', 'Highlight amount', 0, 100], ['balance', 'Balance', -100, 100]]],
  ['Effects', [['clarity', 'Clarity', -100, 100], ['matte', 'Matte', 0, 100], ['fade', 'Fade', 0, 100], ['vignette', 'Vignette', -100, 100], ['grain', 'Grain', 0, 100]]]
];
const CURVE_CH = [['all', 'All', '#ffb224'], ['r', 'Red', '#e0524a'], ['g', 'Green', '#4fae5e'], ['b', 'Blue', '#4d7dff']];
const MIX_DOTS = ['#e0443c', '#ee8a2c', '#e6c832', '#4fae5e', '#35b8b4', '#3f7fe8', '#8a5be0', '#d64fb0'];
const curves0 = () => ({ r: CURVE0.slice(), g: CURVE0.slice(), b: CURVE0.slice() });
const ASPECTS = [['Free', 0], ['Original', -1], ['1:1', 1], ['4:5', .8], ['5:4', 1.25], ['3:2', 1.5], ['2:3', 2 / 3], ['16:9', 16 / 9], ['9:16', 9 / 16]];

const Editor = {
  item: null, srcCanvas: null, adj: null, geo: null, curve: null, curves: null, lut: null, myLuts: [], lutCache: new Map(), curveCh: 'all', mixI: 0, look: 'Original', tab: 'adjust',
  base: null, work: null, srcData: null, blurData: null, noise: null, hist: [], hi: -1, raf: 0, before: false,
  loupeOn: true, mag: 2.5, full: null, fullAsked: false, lp: null, lpOver: false, cropDrag: false, wc: null, blurCanvas: null,
  async open(it) {
    /* editing a copy again starts from the first original with the copy's settings loaded, so quality never degrades */
    let origin = it, recipe = null;
    $('#editor').hidden = false; $('#edBusy').hidden = false; $('#edBusy').textContent = 'Preparing'; $('#edTitle').textContent = '';
    try {
      if (it.copyOf && S.byId.get(it.copyOf)) { const m = await api('GET', '/api/items/' + it.id); if (m.recipe) { origin = S.byId.get(it.copyOf); recipe = m.recipe; } }
      this.item = origin; this.full = null; this.fullAsked = false; this.lp = null; this.lpOver = false; this.setLoupe(store.get('edLoupe', '1') !== '0');
      this.adj = { ...ADJ2 }; this.curve = CURVE0.slice(); this.curves = curves0(); this.curveCh = 'all'; this.look = 'Original'; this.lut = null;
      api('GET', '/api/luts').then(r => { this.myLuts = r.luts; if (this.item && this.tab === 'looks') this.listLooks(); }, () => { });
      this.geo = { ...GEO0, crop: { ...GEO0.crop } };
      if (recipe) { Object.assign(this.adj, recipe.adj); this.geo = { ...this.geo, ...recipe.geo, crop: { ...recipe.geo.crop } }; this.curve = recipe.curve.slice(); if (recipe.curves) for (const k of 'rgb') if (recipe.curves[k]) this.curves[k] = recipe.curves[k].slice(); this.look = recipe.look || 'Custom'; if (recipe.lut) this.lut = await this.loadLut(recipe.lut); }
      $('#edTitle').textContent = `Editing a copy of ${origin.title || origin.fileName}` + (recipe ? ', picking up where the last copy left off' : '');
      /* ?proxy=1 asks the server to pass the pixels through itself, so the canvas may read them */
      const im = new Image(); im.src = Img.url(origin, 'display', 'proxy=1'); await im.decode();
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im, 0, 0); this.srcCanvas = c;
    } catch (e) { this.close(); return toast('The picture could not be opened for editing.'); }
    this.hist = []; this.hi = -1; this.buildPanel(); this.setTab('adjust'); this.rebuild(); this.push(); $('#edBusy').hidden = true;
  },
  close() { $('#editor').hidden = true; this.item = null; this.hover = null; this.lookP = null; this.lookQ = ''; if (this.lookSeen) this.lookSeen.disconnect(); this.before = false; $('#edBefore').classList.remove('on'); this.hideLoupe(); this.lp = null; this.srcCanvas = this.base = this.work = this.srcData = this.blurData = this.full = this.blurCanvas = null; },
  /* what is saved. A recipe made here is version 2: it is developed with develop2 in shared/develop.js. */
  recipe() { return { v: VERSION, adj: { ...this.adj }, geo: { ...this.geo, crop: { ...this.geo.crop } }, curve: this.curve.slice(), curves: { r: this.curves.r.slice(), g: this.curves.g.slice(), b: this.curves.b.slice() }, look: this.look, ...(this.lut ? { lut: this.lut.id } : {}) }; },
  snap() { return JSON.stringify({ adj: this.adj, geo: this.geo, curve: this.curve, curves: this.curves, look: this.look, lut: this.lut ? this.lut.id : null }); },
  /* the numbers of a look of your own: fetched once, then kept for as long as the page is open */
  async loadLut(id) {
    if (this.lutCache.has(id)) return this.lutCache.get(id);
    const res = await fetch(`/api/luts/${id}/data`, { credentials: 'same-origin' }); if (!res.ok) throw new Error('That look could not be loaded.');
    const lut = { id, n: +res.headers.get('x-lut-size'), data: new Float32Array(await res.arrayBuffer()) }; this.lutCache.set(id, lut); return lut;
  },
  push() { const s = this.snap(); if (this.hist[this.hi] === s) return; this.hist = this.hist.slice(0, this.hi + 1); this.hist.push(s); this.hi = this.hist.length - 1; this.histBtns(); },
  restore(i) { if (i < 0 || i >= this.hist.length) return; this.hi = i; const r = JSON.parse(this.hist[i]); this.adj = r.adj; this.geo = r.geo; this.curve = r.curve; this.curves = r.curves; this.look = r.look; this.lut = r.lut ? this.lutCache.get(r.lut) || null : null; this.syncPanel(); this.rebuild(); this.histBtns(); },
  histBtns() { $('#edUndo').disabled = this.hi <= 0; $('#edRedo').disabled = this.hi >= this.hist.length - 1; },

  /* geometry: rotate, flip, straighten on the whole frame; crop is applied after */
  buildBase(maxLong) {
    const s = this.srcCanvas, g = this.geo, sw = s.width, sh = s.height, odd = g.rot % 2, bw = odd ? sh : sw, bh = odd ? sw : sh;
    const k = Math.min(1, maxLong / Math.max(bw, bh)), c = document.createElement('canvas'); c.width = Math.round(bw * k); c.height = Math.round(bh * k);
    const x = c.getContext('2d'), th = g.straighten * Math.PI / 180, z = coverZoom(bw, bh, g.straighten);
    x.imageSmoothingQuality = 'high'; x.translate(c.width / 2, c.height / 2); x.scale(g.flipH ? -1 : 1, g.flipV ? -1 : 1); x.rotate(g.rot * Math.PI / 2 + th); x.scale(z * k, z * k); x.drawImage(s, -sw / 2, -sh / 2);
    return c;
  },
  cropOf(base, full) {
    const cr = full ? { x: 0, y: 0, w: 1, h: 1 } : this.geo.crop, w = Math.max(2, Math.round(base.width * cr.w)), h = Math.max(2, Math.round(base.height * cr.h));
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(base, Math.round(base.width * cr.x), Math.round(base.height * cr.y), w, h, 0, 0, w, h); return c;
  },
  prep(canvas) {
    const w = canvas.width, h = canvas.height, ctx = canvas.getContext('2d', { willReadFrequently: true });
    const src = ctx.getImageData(0, 0, w, h);
    /* the soft copy Clarity works against: the picture shrunk and enlarged again, by the same factor the server uses */
    const sm = document.createElement('canvas'), f = blurFactor(w, h); sm.width = Math.max(2, Math.round(w / f)); sm.height = Math.max(2, Math.round(h / f));
    const sx = sm.getContext('2d'); sx.imageSmoothingQuality = 'high'; sx.drawImage(canvas, 0, 0, sm.width, sm.height);
    const bl = document.createElement('canvas'); bl.width = w; bl.height = h; const bx = bl.getContext('2d', { willReadFrequently: true }); bx.imageSmoothingQuality = 'high'; bx.drawImage(sm, 0, 0, w, h);
    return { src, blur: bx.getImageData(0, 0, w, h), blurCanvas: bl, w, h };
  },
  rebuild() {
    this.base = this.buildBase(1280); this.work = this.cropOf(this.base, this.tab === 'crop');
    const p = this.prep(this.work); this.srcData = p.src; this.blurData = p.blur; this.blurCanvas = p.blurCanvas;
    /* the part of the frame the preview shows: all of it while cropping, the crop otherwise */
    this.wc = this.tab === 'crop' ? { x: 0, y: 0, w: 1, h: 1 } : { ...this.geo.crop };
    const cv = $('#edCanvas'); cv.width = p.w; cv.height = p.h; this.fit(); this.render(); if (this.tab === 'looks') this.paintLooks();
  },
  fit() {
    const st = $('#edStage'), cv = $('#edCanvas'); if (!cv.width) return; const pad = this.tab === 'crop' ? 40 : 24, sw = st.clientWidth - pad * 2, sh = st.clientHeight - pad * 2, k = Math.min(sw / cv.width, sh / cv.height);
    cv.style.width = Math.round(cv.width * k) + 'px'; cv.style.height = Math.round(cv.height * k) + 'px'; this.placeCrop();
  },
  curveNow() { return this.curveCh === 'all' ? this.curve : this.curves[this.curveCh]; },
  curveTable() { return curveLut(this.curveNow()); },
  /* the pixel work itself lives in shared/develop.js, the same code the server runs on the full-size original */
  process(P, A, curve, curves, lut) { const out = new ImageData(P.w, P.h); develop2({ src: P.src.data, blur: P.blur.data, out: out.data, w: P.w, h: P.h }, A, curve, curves, lut || null); return out; },
  schedule() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); }); },
  render() {
    if (!this.srcData) return; const cv = $('#edCanvas'), P = { src: this.srcData, blur: this.blurData, w: cv.width, h: cv.height };
    const R = this.hover || this, out = this.before ? this.srcData : this.process(P, R.adj, R.curve, R.curves, R.lut);
    cv.getContext('2d').putImageData(out, 0, 0); this.histogram(out); this.paintLoupe();
  },

  /* ---------- magnifier: the edited result at the detail of the full-size file ----------
     The preview is a small copy, so enlarging it would show nothing new. The magnifier cuts its patch from the
     full-size file (loaded once per editing session) and runs it through the same develop code as the saved copy. */
  setLoupe(on, keep) {
    this.loupeOn = on; const b = $('#edLoupeBtn'), t = on ? 'Turn magnifier off' : 'Turn magnifier on';
    b.classList.toggle('on', on); b.title = t; b.setAttribute('aria-label', t); if (!on) this.hideLoupe(); if (keep) store.set('edLoupe', on ? '1' : '0');
  },
  askFull() {
    if (this.fullAsked || !this.item) return; this.fullAsked = true; const it = this.item, im = new Image();
    im.src = Img.url(it, 'orig', 'proxy=1');
    im.decode().then(() => { if (this.item === it) { this.full = im; this.paintLoupe(); } }, () => { /* the preview copy stays in use */ });
  },
  hideLoupe() { this.lpOver = false; $('#edLoupe').classList.remove('show'); },
  moveLoupe(e) {
    const lp = $('#edLoupe'), cv = $('#edCanvas');
    if (!this.item || !this.loupeOn || this.cropDrag || !this.srcData || !$('#edBusy').hidden) return this.hideLoupe();
    const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    if (px < 0 || py < 0 || px > r.width || py > r.height) return this.hideLoupe();
    const st = $('#edStage').getBoundingClientRect(), D = lp.offsetWidth || 236;
    lp.style.left = e.clientX - st.left - D / 2 + 'px'; lp.style.top = e.clientY - st.top - D / 2 + 'px';
    this.lp = { u: px / r.width, v: py / r.height, cssW: r.width }; this.lpOver = true; lp.classList.add('show');
    this.askFull(); this.paintLoupe();
  },
  paintLoupe() {
    const q = this.lp, it = this.item, lp = $('#edLoupe'); if (!q || !it || !this.work || !this.wc || !lp.classList.contains('show')) return;
    const D = 236, P = Math.round(D * Math.min(2, window.devicePixelRatio || 1)); if (lp.width !== P) { lp.width = P; lp.height = P; }
    const g = this.geo, odd = g.rot % 2, BW = odd ? it.h : it.w, BH = odd ? it.w : it.h, wc = this.wc, outW = wc.w * BW, outH = wc.h * BH;
    /* F: how many pixels of the full-size frame the magnifier spans. k: screen pixels per frame pixel. cx, cy: its middle, in frame pixels. */
    const F = D / this.mag * outW / q.cssW, k = P / F, cx = (wc.x + q.u * wc.w) * BW, cy = (wc.y + q.v * wc.h) * BH;
    const c = this._lc || (this._lc = document.createElement('canvas')); c.width = P; c.height = P;
    const x = c.getContext('2d', { willReadFrequently: true }), src = this.full || this.srcCanvas;
    x.imageSmoothingQuality = 'high'; x.translate(P / 2, P / 2); x.scale(k, k); x.translate(-cx, -cy);
    x.beginPath(); x.rect(wc.x * BW, wc.y * BH, outW, outH); x.clip();
    /* the same turn, flip and straighten as buildBase, at full size */
    x.translate(BW / 2, BH / 2); x.scale(g.flipH ? -1 : 1, g.flipV ? -1 : 1); x.rotate(g.rot * Math.PI / 2 + g.straighten * Math.PI / 180); const z = coverZoom(BW, BH, g.straighten); x.scale(z, z);
    x.drawImage(src, -it.w / 2, -it.h / 2, it.w, it.h);
    const sd = x.getImageData(0, 0, P, P), ox = (cx - wc.x * BW) * k - P / 2, oy = (cy - wc.y * BH) * k - P / 2, o2 = lp.getContext('2d');
    if (this.before) { o2.putImageData(sd, 0, 0); this.loupeDetail = this.full ? 'full' : 'preview'; return; }
    let blur = sd.data;
    if (this.adj.clarity) {
      /* Clarity compares each pixel with a soft copy. Take that from the preview's soft copy, which is as soft as the one the server makes. */
      const b = this._lb || (this._lb = document.createElement('canvas')); b.width = P; b.height = P; const bx = b.getContext('2d', { willReadFrequently: true }); bx.imageSmoothingQuality = 'high';
      const ws = this.work.width / outW, wF = F * ws; bx.drawImage(this.blurCanvas, (cx - wc.x * BW) * ws - wF / 2, (cy - wc.y * BH) * ws - wF / 2, wF, wF, 0, 0, P, P);
      blur = bx.getImageData(0, 0, P, P).data;
    }
    const out = new ImageData(P, P);
    develop2({ src: sd.data, blur, out: out.data, w: P, h: P, fw: outW * k, fh: outH * k, ox, oy }, this.adj, this.curve, this.curves, this.lut);
    /* outside the picture stays empty */
    const od = out.data, s0 = sd.data; for (let i = 3; i < od.length; i += 4) od[i] = s0[i];
    o2.putImageData(out, 0, 0); this.loupeDetail = this.full ? 'full' : 'preview';
  },
  /* "before" shows the untouched picture, in the preview and in the magnifier. While the button is held the pointer is on the button, so the magnifier comes back where it last was. */
  setBefore(v) {
    if (this.before === v || !this.item) return; this.before = v; $('#edBefore').classList.toggle('on', v);
    const lp = $('#edLoupe'); if (v && this.loupeOn && this.lp && !this.cropDrag) lp.classList.add('show'); else if (!v && !this.lpOver) lp.classList.remove('show');
    this.render();
  },
  histogram(out) {
    const c = $('#edHist'), x = c.getContext('2d'), d = out.data, R = new Uint32Array(64), Gc = new Uint32Array(64), B = new Uint32Array(64);
    for (let i = 0; i < d.length; i += 28) { R[d[i] >> 2]++; Gc[d[i + 1] >> 2]++; B[d[i + 2] >> 2]++; }
    let mx = 1; for (let i = 1; i < 63; i++) mx = Math.max(mx, R[i], Gc[i], B[i]);
    x.clearRect(0, 0, c.width, c.height); x.globalCompositeOperation = 'lighter';
    [[R, '#e0524a'], [Gc, '#4fae5e'], [B, '#4d7dff']].forEach(([a, col]) => { x.fillStyle = col; x.beginPath(); x.moveTo(0, c.height); for (let i = 0; i < 64; i++) x.lineTo(i / 63 * c.width, c.height - Math.min(1, a[i] / mx) * (c.height - 4)); x.lineTo(c.width, c.height); x.fill(); });
    x.globalCompositeOperation = 'source-over';
  },

  /* panel */
  buildPanel() {
    const box = $('#edAdjust'); box.innerHTML = '';
    /* one slider. Intensity says how much of everything else is applied, so moving it does not make the look a custom one. */
    const row = ([key, label, min, max, track]) => {
      const out = el('output', { text: this.adj[key] });
      const inp = el('input', { type: 'range', min, max, step: 1, value: this.adj[key], class: 'sl ' + (track || ''), 'aria-label': label, data: { k: key } });
      inp.addEventListener('input', () => { this.adj[key] = +inp.value; out.textContent = inp.value; if (key !== 'amount') this.look = 'Custom'; this.schedule(); if (key.startsWith('mx')) this.markMix(); });
      inp.addEventListener('change', () => this.push());
      return el('label', { class: 'slrow', title: 'Double-click to reset', ondblclick: () => { this.adj[key] = ADJ2[key]; inp.value = ADJ2[key]; out.textContent = ADJ2[key]; this.schedule(); this.push(); if (key.startsWith('mx')) this.markMix(); } }, el('span', { text: label }), out, inp);
    };
    for (const [name, rows] of ADJ) {
      const sec = el('section', { class: 'ed-sec' }, el('h4', { text: name }));
      if (rows === 'curve') {
        const chs = el('div', { class: 'fvals', id: 'edCurveCh' }); CURVE_CH.forEach(([k, label]) => chs.append(el('button', { class: 'chip' + (this.curveCh === k ? ' on' : ''), text: label, data: { ch: k }, onclick: () => { this.curveCh = k; $$('#edCurveCh .chip').forEach(c => c.classList.toggle('on', c.dataset.ch === k)); this.drawCurve(); } })));
        const cv = el('canvas', { id: 'edCurve', width: 520, height: 300, class: 'curve', 'aria-label': 'Tone curve. Drag the five points up or down.' });
        sec.append(chs, cv, el('button', { class: 'linkbtn', text: 'Reset curve', onclick: () => { const c = this.curveNow(); CURVE0.forEach((v, i) => c[i] = v); this.drawCurve(); this.schedule(); this.push(); } })); box.append(sec); this.bindCurve(cv); continue;
      }
      if (rows === 'mixer') {
        /* eight ranges of color, three sliders for the one that is chosen */
        const dots = el('div', { class: 'mixdots', id: 'edMix' }), rowsBox = el('div', { id: 'edMixRows' });
        const show = () => { const i = this.mixI; rowsBox.innerHTML = ''; rowsBox.append(row(['mxH' + i, 'Hue', -100, 100]), row(['mxS' + i, 'Saturation', -100, 100]), row(['mxL' + i, 'Brightness', -100, 100])); this.markMix(); };
        MIX_NAMES.forEach((n, i) => dots.append(el('button', { class: 'mixdot', title: n, 'aria-label': n + ' range', style: `--c:${MIX_DOTS[i]}`, data: { i }, onclick: () => { this.mixI = i; show(); } })));
        sec.append(dots, rowsBox); box.append(sec); this.showMix = show; show(); continue;
      }
      for (const r of rows) sec.append(row(r));
      box.append(sec);
    }
    const cb = $('#edCrop'); cb.innerHTML = '';
    const asp = el('div', { class: 'fvals wrap', id: 'edAspects' }); ASPECTS.forEach(([n]) => asp.append(el('button', { class: 'chip' + (this.geo.aspect === n ? ' on' : ''), text: n, onclick: () => { this.setAspect(n); this.push(); } })));
    const st = el('input', { type: 'range', min: -15, max: 15, step: .1, value: this.geo.straighten, class: 'sl', id: 'edStraighten', 'aria-label': 'Straighten' }), so = el('output', { text: this.geo.straighten + '°' });
    st.addEventListener('input', () => { this.geo.straighten = +st.value; so.textContent = (+st.value).toFixed(1) + '°'; this.rebuild(); }); st.addEventListener('change', () => this.push());
    const tb = (ic, label, fn) => el('button', { class: 'btn small', html: icon(ic, 16) + `<span>${label}</span>`, onclick: () => { fn(); this.rebuild(); this.push(); } });
    cb.append(el('section', { class: 'ed-sec' }, el('h4', { text: 'Shape' }), asp),
      el('section', { class: 'ed-sec' }, el('h4', { text: 'Straighten' }), el('label', { class: 'slrow' }, el('span', { text: 'Angle' }), so, st)),
      el('section', { class: 'ed-sec' }, el('h4', { text: 'Turn and flip' }), el('div', { class: 'btnrow' },
        tb('rotl', 'Left', () => { this.geo.rot = (this.geo.rot + 3) % 4; this.resetCrop(); }), tb('rotr', 'Right', () => { this.geo.rot = (this.geo.rot + 1) % 4; this.resetCrop(); }),
        tb('flip', 'Flip', () => { this.geo.flipH = !this.geo.flipH; this.geo.crop.x = 1 - this.geo.crop.x - this.geo.crop.w; }))),
      el('p', { class: 'vi-note', text: 'Drag the frame or its handles. Cropping only affects this copy.' }), el('button', { class: 'linkbtn', text: 'Reset crop', onclick: () => { this.resetCrop(); this.geo.straighten = 0; st.value = 0; so.textContent = '0°'; this.rebuild(); this.push(); } }));
    this.drawCurve();
  },
  /* the chosen range of the mixer is ringed, and a range that has been changed carries a mark */
  markMix() { $$('#edMix .mixdot').forEach(b => { const i = +b.dataset.i; b.classList.toggle('on', i === this.mixI); b.classList.toggle('set', !!(this.adj['mxH' + i] || this.adj['mxS' + i] || this.adj['mxL' + i])); }); const n = $('#edMix'); if (n) n.dataset.name = MIX_NAMES[this.mixI]; },
  syncPanel() { $$('#edAdjust input[type=range]').forEach(i => { i.value = this.adj[i.dataset.k]; i.parentNode.querySelector('output').textContent = this.adj[i.dataset.k]; }); this.markMix(); const st = $('#edStraighten'); if (st) { st.value = this.geo.straighten; st.parentNode.querySelector('output').textContent = (+this.geo.straighten).toFixed(1) + '°'; } $$('#edAspects .chip').forEach(c => c.classList.toggle('on', c.textContent === this.geo.aspect)); this.drawCurve(); if (this.tab === 'looks') this.markLook(); },
  setTab(t) { const was = this.tab; this.tab = t; if (t === 'looks' && was !== 'looks') this.lookOpen = new Set(['fav']); $$('.ed-tabs button').forEach(b => { b.classList.toggle('on', b.dataset.tab === t); b.setAttribute('aria-selected', b.dataset.tab === t); }); $('#edAdjust').hidden = t !== 'adjust'; $('#edLooks').hidden = t !== 'looks'; $('#edCrop').hidden = t !== 'crop'; $('#cropBox').hidden = t !== 'crop'; if (this.srcCanvas && (was === 'crop') !== (t === 'crop')) this.rebuild(); else if (t === 'looks' && this.srcCanvas) this.paintLooks(); },
  /* ---------- looks ----------
     A look is a set of slider and curve values (shared/looks.js). Choosing one sets them. Favorites and recently
     used looks are remembered in this browser. Every time the Looks tab is entered the groups are closed and
     only Favorites is open, so the list is short. lookOpen holds the groups opened since then. */
  lookSet(L) { return { adj: { ...ADJ2, ...L.adj }, curve: (L.curve || CURVE0).slice(), curves: L.curves ? { r: L.curves.r.slice(), g: L.curves.g.slice(), b: L.curves.b.slice() } : curves0(), lut: L.lut || null }; },
  lookNames(key) { try { const v = JSON.parse(store.get(key, '[]')); return Array.isArray(v) ? v.filter(n => typeof n === 'string' && (n.startsWith('lut:') || LOOKS.some(l => l.name === n))) : []; } catch (e) { return []; } },
  /* one of your own looks, in the shape the built-in ones have */
  mineLook(l) { return { name: l.name, group: 'Mine', adj: {}, lutId: l.id, lut: this.lutCache.get(l.id) || null }; },
  applyLook(L) {
    this.hover = null;
    this.lut = null;
    if (L && L.lut) { const r = this.lookSet(L); this.adj = r.adj; this.curve = r.curve; this.curves = r.curves; this.lut = L.lut; this.look = L.name; }
    else if (L) { const r = this.lookSet(L); this.adj = r.adj; this.curve = r.curve; this.curves = r.curves; this.look = L.name; store.set('lookRecent', JSON.stringify([L.name, ...this.lookNames('lookRecent').filter(n => n !== L.name)].slice(0, 6))); }
    else { this.adj = { ...ADJ2 }; this.curve = CURVE0.slice(); this.curves = curves0(); this.look = 'Original'; }
    this.syncPanel(); this.render(); this.push();
  },
  toggleFav(name) { const f = this.lookNames('lookFavs'), i = f.indexOf(name); if (i >= 0) f.splice(i, 1); else f.push(name); store.set('lookFavs', JSON.stringify(f)); this.listLooks(); },
  paintLooks() {
    const box = $('#edLooks'); box.innerHTML = '';
    const small = document.createElement('canvas'), k = 220 / Math.max(this.work.width, this.work.height); small.width = Math.max(2, Math.round(this.work.width * k)); small.height = Math.max(2, Math.round(this.work.height * k)); small.getContext('2d').drawImage(this.work, 0, 0, small.width, small.height);
    this.lookP = this.prep(small);
    const find = el('input', { type: 'search', id: 'edLookFind', class: 'inp', placeholder: 'Find a look', 'aria-label': 'Find a look', value: this.lookQ || '' });
    find.addEventListener('input', () => { this.lookQ = find.value; this.listLooks(); });
    const out = el('output', { text: this.adj.amount }), amt = el('input', { type: 'range', min: 0, max: 100, step: 1, value: this.adj.amount, class: 'sl', id: 'edLookAmt', 'aria-label': 'Intensity' });
    amt.addEventListener('input', () => { this.adj.amount = +amt.value; out.textContent = amt.value; this.schedule(); }); amt.addEventListener('change', () => { this.syncPanel(); this.push(); });
    box.append(find, el('label', { class: 'slrow', title: 'How much of the look is applied' }, el('span', { text: 'Intensity' }), out, amt), el('div', { id: 'edLookList' }));
    this.listLooks();
  },
  /* the list under the search box. Previews are drawn only when they scroll into view. */
  listLooks() {
    const list = $('#edLookList'); if (!list || !this.lookP) return; list.innerHTML = '';
    if (this.lookSeen) this.lookSeen.disconnect();
    const P = this.lookP, q = (this.lookQ || '').trim().toLowerCase(), favs = this.lookNames('lookFavs'), open = this.lookOpen || (this.lookOpen = new Set(['fav']));
    const seen = this.lookSeen = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { seen.unobserve(e.target); const r = this.lookSet(e.target._look); const c = e.target, draw = lut => { c.getContext('2d').putImageData(this.process(P, r.adj, r.curve, r.curves, lut), 0, 0); c.dataset.drawn = '1'; }; if (c._look.lutId) this.loadLut(c._look.lutId).then(lut => { c._look.lut = lut; if (this.lookP === P) draw(lut); }, () => { }); else draw(null); } }, { root: $('.ed-panel'), rootMargin: '200px' });
    const tile = L => {
      const c = el('canvas', { width: P.w, height: P.h }); c._look = L; seen.observe(c);
      const pick = el('button', { class: 'look-pick', onclick: () => this.applyLook(L) }, el('span', { class: 'look-im' }, c), el('span', { class: 'look-name', text: L.name }));
      /* resting the pointer on a look shows it on the main picture without choosing it */
      pick.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse' && (!L.lutId || L.lut)) { this.hover = this.lookSet(L); this.hoverName = L.name; this.schedule(); } });
      pick.addEventListener('pointerleave', () => { if (this.hover) { this.hover = null; this.hoverName = null; this.schedule(); } });
      const on = favs.includes(L.name), t = on ? `Take ${L.name} out of favorites` : `Add ${L.name} to favorites`;
      if (L.lutId) {
        /* a look of your own: its name can be changed in place, and it can be removed */
        pick.onclick = () => this.loadLut(L.lutId).then(lut => { L.lut = lut; this.applyLook(L); }, e => toast(e.message));
        const name = el('input', { class: 'inp look-rename', value: L.name, maxlength: 60, 'aria-label': 'Name of this look' });
        name.addEventListener('change', () => api('PATCH', '/api/luts/' + L.lutId, { name: name.value }).then(r => { const m = this.myLuts.find(x => x.id === L.lutId); if (m) m.name = r.name; if (this.lut && this.lut.id === L.lutId) this.look = r.name; this.listLooks(); }, e => { toast(e.message); name.value = L.name; }));
        pick.querySelector('.look-name').remove();
        const fk = 'lut:' + L.lutId, fon = favs.includes(fk), ft = fon ? `Take ${L.name} out of favorites` : `Add ${L.name} to favorites`;
        return el('div', { class: 'look mine' + (this.lut && this.lut.id === L.lutId ? ' on' : ''), data: { look: L.name, lut: L.lutId } }, pick, name, el('button', { class: 'look-fav' + (fon ? ' on' : ''), title: ft, 'aria-label': ft, 'aria-pressed': String(fon), text: fon ? '★' : '☆', onclick: () => this.toggleFav(fk) }), el('button', { class: 'linkbtn look-remove', text: 'Remove', onclick: () => api('DELETE', '/api/luts/' + L.lutId).then(r => { this.myLuts = this.myLuts.filter(x => x.id !== L.lutId); store.set('lookFavs', JSON.stringify(this.lookNames('lookFavs').filter(n => n !== fk))); this.listLooks(); toast(r.kept ? 'Removed from your looks. Copies made with it are not affected.' : 'Removed from your looks.'); }, e => toast(e.message)) }));
      }
      return el('div', { class: 'look' + (this.look === L.name && !this.lut ? ' on' : ''), data: { look: L.name } }, pick, el('button', { class: 'look-fav' + (on ? ' on' : ''), title: t, 'aria-label': t, 'aria-pressed': String(on), text: on ? '★' : '☆', onclick: () => this.toggleFav(L.name) }));
    };
    const group = (name, looks, key) => {
      if (!looks.length) return; const shut = !q && !open.has(key), grid = el('div', { class: 'looks', hidden: shut });
      looks.forEach(L => grid.append(tile(L)));
      const head = el('button', { class: 'look-head', 'aria-expanded': String(!shut), onclick: () => { if (open.has(key)) open.delete(key); else open.add(key); grid.hidden = !open.has(key); head.setAttribute('aria-expanded', String(open.has(key))); } }, el('span', { class: 'look-chev', html: icon('chevdown', 14) }), el('span', { text: name }), el('span', { class: 'look-n', text: looks.length }));
      list.append(el('section', { class: 'look-group', data: { g: key } }, head, grid));
    };
    const hit = L => !q || L.name.toLowerCase().includes(q) || L.group.toLowerCase().includes(q), by = n => { if (!n.startsWith('lut:')) return LOOKS.find(l => l.name === n); const m = this.myLuts.find(l => l.id === n.slice(4)); return m ? this.mineLook(m) : null; };
    if (!q) {
      list.append(el('button', { class: 'chip look-none' + (this.look === 'Original' ? ' on' : ''), text: 'No look', title: 'Back to the picture as it was', onclick: () => this.applyLook(null) }));
      group('Favorites', favs.map(by).filter(Boolean), 'fav'); group('Recently used', this.lookNames('lookRecent').map(by), 'recent');
    }
    let any = false; for (const g of LOOK_GROUPS) { const ls = LOOKS.filter(l => l.group === g && hit(l)); if (ls.length) any = true; group(g, ls, g); }
    /* looks of your own, loaded from .cube files */
    const mine = this.myLuts.filter(l => !q || l.name.toLowerCase().includes(q) || 'mine'.includes(q)).map(l => this.mineLook(l));
    if (mine.length) any = true; group('Mine', mine, 'mine');
    if (!any) list.append(el('p', { class: 'vi-note', text: `No look is called “${this.lookQ.trim()}”.` }));
    if (!q && can('edit')) {
      const inp = el('input', { type: 'file', id: 'edCubeFile', accept: '.cube', hidden: true, onchange: () => {
        const f = inp.files[0]; if (!f) return; const fd = new FormData(); fd.set('file', f, f.name);
        fetch('/api/luts', { method: 'POST', headers: { 'x-afterimage': '1' }, body: fd, credentials: 'same-origin' }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'That file could not be added.'); return d; })
          .then(d => { this.myLuts.push(d); this.myLuts.sort((a, b) => a.name.localeCompare(b.name)); this.lookOpen.add('mine'); this.listLooks(); toast(`Added “${d.name}” to your looks.`); }, e => toast(e.message));
      } });
      list.append(el('section', { class: 'look-add' }, inp, el('button', { class: 'btn small', text: 'Add a look from a .cube file', onclick: () => inp.click() }), el('p', { class: 'vi-note', text: 'A .cube file is a 3D lookup table from a grading program. It becomes a look under Mine, and works with the sliders and the intensity like any other.' })));
    }
  },
  markLook() { $$('#edLooks .look').forEach(b => b.classList.toggle('on', b.dataset.lut ? !!this.lut && this.lut.id === b.dataset.lut : !this.lut && b.dataset.look === this.look)); const n = $('#edLooks .look-none'); if (n) n.classList.toggle('on', this.look === 'Original'); const a = $('#edLookAmt'); if (a) { a.value = this.adj.amount; a.parentNode.querySelector('output').textContent = this.adj.amount; } },
  drawCurve() {
    const c = $('#edCurve'); if (!c) return; const x = c.getContext('2d'), W = c.width, H = c.height, pad = 16, lut = this.curveTable(), cs = getComputedStyle(document.documentElement);
    x.clearRect(0, 0, W, H); x.strokeStyle = 'rgba(128,128,128,.28)'; x.lineWidth = 1; for (let i = 0; i <= 4; i++) { x.beginPath(); x.moveTo(pad + i / 4 * (W - pad * 2), pad); x.lineTo(pad + i / 4 * (W - pad * 2), H - pad); x.moveTo(pad, pad + i / 4 * (H - pad * 2)); x.lineTo(W - pad, pad + i / 4 * (H - pad * 2)); x.stroke(); }
    const ink = CURVE_CH.find(c => c[0] === this.curveCh)[2]; x.strokeStyle = ink; x.lineWidth = 3; x.beginPath(); for (let v = 0; v < 256; v++) { const px = pad + v / 255 * (W - pad * 2), py = H - pad - lut[v] / 255 * (H - pad * 2); v ? x.lineTo(px, py) : x.moveTo(px, py); } x.stroke();
    this.curveNow().forEach((y, i) => { x.fillStyle = ink; x.strokeStyle = '#1a1b1d'; x.lineWidth = 3; x.beginPath(); x.arc(pad + i / 4 * (W - pad * 2), H - pad - y * (H - pad * 2), 9, 0, 6.29); x.fill(); x.stroke(); });
  },
  bindCurve(c) {
    let idx = -1; const pos = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height]; };
    c.addEventListener('pointerdown', e => { const [px] = pos(e); idx = Math.round(clamp(px, 0, 1) * 4); c.setPointerCapture(e.pointerId); move(e); });
    const move = e => { if (idx < 0) return; const [, py] = pos(e); this.curveNow()[idx] = clamp((py - 16 / 300) / (1 - 32 / 300), 0, 1); this.look = 'Custom'; this.drawCurve(); this.schedule(); };
    c.addEventListener('pointermove', move); c.addEventListener('pointerup', () => { if (idx >= 0) { idx = -1; this.push(); } });
    c.addEventListener('dblclick', e => { const [px] = pos(e); const i = Math.round(clamp(px, 0, 1) * 4); this.curveNow()[i] = i / 4; this.drawCurve(); this.schedule(); this.push(); });
  },

  /* crop */
  resetCrop() { this.geo.crop = { x: 0, y: 0, w: 1, h: 1 }; if (this.geo.aspect !== 'Free') this.setAspect(this.geo.aspect, true); },
  /* the chosen shape as a fraction of the frame. Measured against the real pixel size, not the smaller preview, so 1:1 comes out exactly square. */
  aspectNorm() { const a = (ASPECTS.find(x => x[0] === this.geo.aspect) || ASPECTS[0])[1]; if (!a || !this.base) return 0; const frame = this.item.ar ** (this.geo.rot % 2 ? -1 : 1); return (a === -1 ? frame : a) / frame; },
  setAspect(name, quiet) {
    this.geo.aspect = name; $$('#edAspects .chip').forEach(c => c.classList.toggle('on', c.textContent === name));
    const a = this.aspectNorm(); if (a) { let w = 1, h = w / a; if (h > 1) { h = 1; w = a; } this.geo.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h }; }
    if (!quiet) { if (this.tab === 'crop') this.placeCrop(); else this.rebuild(); }
  },
  placeCrop() {
    const box = $('#cropBox'); if (this.tab !== 'crop') return; const cv = $('#edCanvas'), st = $('#edStage').getBoundingClientRect(), r = cv.getBoundingClientRect(), c = this.geo.crop;
    box.style.left = r.left - st.left + c.x * r.width + 'px'; box.style.top = r.top - st.top + c.y * r.height + 'px'; box.style.width = c.w * r.width + 'px'; box.style.height = c.h * r.height + 'px';
    const odd = this.geo.rot % 2; $('#cropSize').textContent = `${Math.round((odd ? this.item.h : this.item.w) * c.w)} × ${Math.round((odd ? this.item.w : this.item.h) * c.h)}`;
  },
  bindCrop() {
    const box = $('#cropBox'); let d = null;
    box.addEventListener('pointerdown', e => { this.cropDrag = true; this.hideLoupe(); const r = $('#edCanvas').getBoundingClientRect(); d = { mode: e.target.dataset.h || 'move', px: e.clientX, py: e.clientY, c: { ...this.geo.crop }, rw: r.width, rh: r.height }; box.setPointerCapture(e.pointerId); e.preventDefault(); });
    box.addEventListener('pointermove', e => {
      if (!d) return; const dx = (e.clientX - d.px) / d.rw, dy = (e.clientY - d.py) / d.rh, c0 = d.c, m = d.mode, min = .06, a = this.aspectNorm();
      let l = c0.x, t = c0.y, r = c0.x + c0.w, b = c0.y + c0.h;
      if (m === 'move') { l = clamp(c0.x + dx, 0, 1 - c0.w); t = clamp(c0.y + dy, 0, 1 - c0.h); r = l + c0.w; b = t + c0.h; }
      else {
        if (m.includes('w')) l = clamp(l + dx, 0, r - min); if (m.includes('e')) r = clamp(r + dx, l + min, 1); if (m.includes('n')) t = clamp(t + dy, 0, b - min); if (m.includes('s')) b = clamp(b + dy, t + min, 1);
        if (a) {
          if (m === 'n' || m === 's') { let h = b - t, w = Math.min(1, h * a); h = w / a; const cx = clamp(c0.x + c0.w / 2, w / 2, 1 - w / 2); l = cx - w / 2; r = cx + w / 2; if (m === 'n') t = b - h; else b = t + h; }
          else if (m === 'e' || m === 'w') { let w = r - l, h = Math.min(1, w / a); w = h * a; const cy = clamp(c0.y + c0.h / 2, h / 2, 1 - h / 2); t = cy - h / 2; b = cy + h / 2; if (m === 'w') l = r - w; else r = l + w; }
          else { let w = r - l, h = w / a; const avail = m.includes('n') ? b : 1 - t; if (h > avail) { h = avail; w = h * a; } if (m.includes('n')) t = b - h; else b = t + h; if (m.includes('w')) l = r - w; else r = l + w; }
        }
      }
      this.geo.crop = { x: l, y: t, w: r - l, h: b - t }; this.placeCrop();
    });
    const end = () => { this.cropDrag = false; if (d) { d = null; this.push(); } };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  },

  /* saving sends only the settings. The server develops the full-size original with them and stores the result as a new item. */
  save() {
    const src = this.item, recipe = this.recipe(), viewing = !$('#viewer').hidden;
    if (recipeIsEmpty(recipe)) return toast('Nothing has been changed yet, so there is nothing to save.');
    $('#edSave').disabled = true;
    api('POST', `/api/items/${src.id}/copies`, { recipe }).then(r => {
      $('#edSave').disabled = false; this.close(); toast('Developing your copy at full size. The original is untouched.');
      Sync.whenReady(r.id, it => {
        if (it.status !== 'ready') return toast('The copy could not be made. ' + (it.error || ''));
        if (viewing && Viewer.item && (Viewer.item.id === src.id || Viewer.item.copyOf === src.id)) Viewer.open(it.id, [src, ...S.items.filter(i => i.copyOf === src.id)]);
        else toast('Your copy is ready.', { label: 'View copy', fn: () => Viewer.open(it.id, [src, it]) });
      });
    }, e => { $('#edSave').disabled = false; toast(e.message); });
  }
};

function initEditor() {
  $('#edCancel').onclick = () => Editor.close(); $('#edSave').onclick = () => Editor.save();
  $('#edUndo').onclick = () => Editor.restore(Editor.hi - 1); $('#edRedo').onclick = () => Editor.restore(Editor.hi + 1);
  $('#edReset').onclick = () => { Editor.lut = null; Editor.adj = { ...ADJ2 }; Editor.curve = [0, .25, .5, .75, 1]; Editor.curves = curves0(); Editor.look = 'Original'; Editor.geo = { ...GEO0, crop: { ...GEO0.crop } }; Editor.syncPanel(); Editor.rebuild(); Editor.push(); };
  const bf = $('#edBefore'); const on = v => Editor.setBefore(v);
  bf.addEventListener('pointerdown', () => on(true)); bf.addEventListener('pointerup', () => on(false)); bf.addEventListener('pointerleave', () => on(false));
  /* holding B does the same, so the pointer can stay on the picture */
  const writing = t => /TEXTAREA|SELECT/.test(t.tagName) || (t.tagName === 'INPUT' && t.type !== 'range');
  addEventListener('keydown', e => { if (e.key.toLowerCase() === 'b' && !e.repeat && !e.metaKey && !e.ctrlKey && Editor.item && !writing(e.target)) on(true); });
  addEventListener('keyup', e => { if (e.key.toLowerCase() === 'b') on(false); }); addEventListener('blur', () => on(false));
  $('#edLoupeBtn').onclick = () => Editor.setLoupe(!Editor.loupeOn, true);
  const stage = $('#edStage');
  stage.addEventListener('pointermove', e => Editor.moveLoupe(e)); stage.addEventListener('pointerleave', () => Editor.hideLoupe());
  stage.addEventListener('wheel', e => { if (!Editor.lpOver) return; e.preventDefault(); Editor.mag = clamp(Editor.mag * Math.exp(-e.deltaY * .0015), 1.4, 8); Editor.paintLoupe(); }, { passive: false });
  $$('.ed-tabs button').forEach(b => b.onclick = () => Editor.setTab(b.dataset.tab));
  Editor.bindCrop(); window.addEventListener('resize', () => { if (Editor.item) Editor.fit(); });
}
