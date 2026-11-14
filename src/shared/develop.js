/* The develop pipeline: how an edit recipe turns pixels into pixels.
   This one file runs in two places. The browser uses it for the live preview in the editor,
   and the server uses it to render the saved copy from the full-size original, so the two always agree.
   The web build strips the "export" keywords and inlines the file. */

export const ADJ0 = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temp: 0, tint: 0, vibrance: 0, saturation: 0, shHue: 220, shAmt: 0, hlHue: 40, hlAmt: 0, clarity: 0, fade: 0, vignette: 0, grain: 0 };
export const CURVE0 = [0, 0.25, 0.5, 0.75, 1];
export const GEO0 = { rot: 0, flipH: false, flipV: false, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 'Free' };

/** The soft copy used for Clarity is the picture shrunk by this factor and enlarged again, at any size. */
export function blurFactor(w, h) { return Math.max(2, Math.round(Math.max(w, h) / 90)); }

/** How much a straightened picture must be enlarged so no empty corners show. */
export function coverZoom(bw, bh, degrees) {
  const t = degrees * Math.PI / 180, cs = Math.abs(Math.cos(t)), sn = Math.abs(Math.sin(t));
  return Math.max((bw * cs + bh * sn) / bw, (bw * sn + bh * cs) / bh);
}

function hueRgb(h) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? 6 * t : t < 0.5 ? 1 : t < 2 / 3 ? (2 / 3 - t) * 6 : 0; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

/** 256-entry lookup table from the five tone-curve points. */
export function curveLut(ys) {
  const n = ys.length, lut = new Uint8ClampedArray(256), m = [];
  for (let i = 0; i < n; i++) m.push(i === 0 ? (ys[1] - ys[0]) * (n - 1) : i === n - 1 ? (ys[n - 1] - ys[n - 2]) * (n - 1) : (ys[i + 1] - ys[i - 1]) * (n - 1) / 2);
  for (let v = 0; v < 256; v++) {
    const t = v / 255 * (n - 1), i = Math.min(n - 2, Math.floor(t)), u = t - i, h = 1 / (n - 1), u2 = u * u, u3 = u2 * u;
    lut[v] = ((2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * h * m[i + 1]) * 255;
  }
  return lut;
}
export function curveIsFlat(ys) { return !ys.some((v, i) => Math.abs(v - i / (ys.length - 1)) > 0.002); }

/**
 * Apply adjustments. src and blur are RGBA byte arrays of the same size; out may be the same array as src.
 * When the pixels are only a patch of a larger picture (the editor's magnifier), fw and fh give the size of the
 * whole picture and ox, oy where the patch sits in it, so effects that depend on position come out the same.
 * @param {{src: Uint8Array|Uint8ClampedArray, blur: Uint8Array|Uint8ClampedArray, out: Uint8Array|Uint8ClampedArray, w: number, h: number, fw?: number, fh?: number, ox?: number, oy?: number}} P
 */
export function develop(P, A, curve) {
  const d = P.src, bd = P.blur, o = P.out, w = P.w, h = P.h, fw = P.fw || w, fh = P.fh || h, ox = P.ox || 0, oy = P.oy || 0;
  const lut = curve && !curveIsFlat(curve) ? curveLut(curve) : null;
  const ex = Math.pow(2, A.exposure / 50), con = A.contrast >= 0 ? 1 + A.contrast / 100 : 1 + A.contrast / 200;
  const tr = 1 + A.temp / 100 * 0.28 + Math.max(0, A.tint) / 100 * 0.06, tb = 1 - A.temp / 100 * 0.28 + Math.max(0, A.tint) / 100 * 0.06, tg = 1 - A.tint / 100 * 0.18;
  const hl = A.highlights / 100 * 0.42, sh = A.shadows / 100 * 0.42, wh = A.whites / 100 * 0.3, bk = A.blacks / 100 * 0.3;
  const sat = 1 + A.saturation / 100, vib = A.vibrance / 100, cl = A.clarity / 100 * 1.6, fade = A.fade / 100, vig = A.vignette / 100 * 0.85, grain = A.grain / 100 * 0.26;
  const sc = hueRgb(A.shHue), hc = hueRgb(A.hlHue), sa = A.shAmt / 100 * 0.3, ha = A.hlAmt / 100 * 0.3;
  const sR = (sc[0] - 0.5) * sa, sG = (sc[1] - 0.5) * sa, sB = (sc[2] - 0.5) * sa, hR = (hc[0] - 0.5) * ha, hG = (hc[1] - 0.5) * ha, hB = (hc[2] - 0.5) * ha;
  let seed = 0x9e3779b9 | 0, i = 0;
  for (let y = 0; y < h; y++) {
    const dy = (y + oy) / fh - 0.5;
    for (let x = 0; x < w; x++, i += 4) {
      let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      if (cl) { const det = (0.2126 * r + 0.7152 * g + 0.0722 * b) - (0.2126 * bd[i] + 0.7152 * bd[i + 1] + 0.0722 * bd[i + 2]) / 255; r += det * cl; g += det * cl; b += det * cl; }
      r = (r * ex * tr - 0.5) * con + 0.5; g = (g * ex * tg - 0.5) * con + 0.5; b = (b * ex * tb - 0.5) * con + 0.5;
      let l = 0.2126 * r + 0.7152 * g + 0.0722 * b; l = l < 0 ? 0 : l > 1 ? 1 : l; const il = 1 - l;
      const dl = sh * il * il * l * 6.75 + hl * l * l * il * 6.75 + wh * l * l * l + bk * il * il * il;
      r += dl; g += dl; b += dl;
      if (lut) { r = lut[r <= 0 ? 0 : r >= 1 ? 255 : (r * 255) | 0] / 255; g = lut[g <= 0 ? 0 : g >= 1 ? 255 : (g * 255) | 0] / 255; b = lut[b <= 0 ? 0 : b >= 1 ? 255 : (b * 255) | 0] / 255; }
      l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (sat !== 1 || vib) { const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b); let s2 = (mx - mn) * 1.6; if (s2 > 1) s2 = 1; const k = sat * (1 + vib * (1 - s2)); r = l + (r - l) * k; g = l + (g - l) * k; b = l + (b - l) * k; }
      if (sa || ha) { const lc = l < 0 ? 0 : l > 1 ? 1 : l, ws = (1 - lc) * (1 - lc), wl = lc * lc; r += sR * ws + hR * wl; g += sG * ws + hG * wl; b += sB * ws + hB * wl; }
      if (fade) { r = r * (1 - fade * 0.24) + fade * 0.11; g = g * (1 - fade * 0.24) + fade * 0.11; b = b * (1 - fade * 0.24) + fade * 0.11; }
      if (vig) { const dx = (x + ox) / fw - 0.5, t = (dx * dx + dy * dy) * 2, f = 1 - vig * t * t; r *= f; g *= f; b *= f; }
      if (grain) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; const nz = ((seed >>> 0) / 4294967296 - 0.5) * grain; r += nz; g += nz; b += nz; }
      o[i] = r <= 0 ? 0 : r >= 1 ? 255 : (r * 255 + 0.5) | 0; o[i + 1] = g <= 0 ? 0 : g >= 1 ? 255 : (g * 255 + 0.5) | 0; o[i + 2] = b <= 0 ? 0 : b >= 1 ? 255 : (b * 255 + 0.5) | 0; o[i + 3] = 255;
    }
  }
  return o;
}

/* ---------- version 2: grading ----------
   Everything above is version 1 and stays as it is, so a copy saved before version 2 renders the same forever.
   Version 2 adds a curve for each of red, green and blue, color mixing by hue, a tint for the midtones with a
   balance control, a matte control, a 3D lookup table, and an intensity that blends the result with the untouched picture. */

export const VERSION = 2;
/** The eight hue ranges of the color mixer, as the hue at the middle of each, in degrees. */
export const MIX_HUES = [0, 30, 60, 120, 180, 225, 275, 320];
export const MIX_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
export const ADJ2 = (() => { const a = { ...ADJ0, mdHue: 40, mdAmt: 0, balance: 0, matte: 0, amount: 100 }; for (let i = 0; i < 8; i++) { a['mxH' + i] = 0; a['mxS' + i] = 0; a['mxL' + i] = 0; } return a; })();
/** Settings whose resting value is not zero. */
const REST = { shHue: 1, hlHue: 1, mdHue: 1, amount: 1 };
export const CURVES0 = { r: CURVE0, g: CURVE0, b: CURVE0 };

/** The curve through the five points, at any input from 0 to 1. The same shape curveLut draws. */
export function curveAt(ys, x) {
  const n = ys.length, h = 1 / (n - 1), t = x * (n - 1), i = Math.min(n - 2, Math.max(0, Math.floor(t))), u = t - i, u2 = u * u, u3 = u2 * u;
  const m = k => k === 0 ? (ys[1] - ys[0]) * (n - 1) : k === n - 1 ? (ys[n - 1] - ys[n - 2]) * (n - 1) : (ys[k + 1] - ys[k - 1]) * (n - 1) / 2;
  const v = (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * h * m(i) + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * h * m(i + 1);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
const TN = 1024;
/** One table per channel: the overall curve, then that channel's own curve. Null when all four are straight. */
function channelTables(curve, curves) {
  const flat = c => !c || curveIsFlat(c), cs = curves || {};
  if (flat(curve) && flat(cs.r) && flat(cs.g) && flat(cs.b)) return null;
  return ['r', 'g', 'b'].map(k => { const t = new Float32Array(TN); for (let i = 0; i < TN; i++) { let v = i / (TN - 1); if (!flat(curve)) v = curveAt(curve, v); if (!flat(cs[k])) v = curveAt(cs[k], v); t[i] = v; } return t; });
}
const HN = 768;
/** For every hue, how far the mixer turns it (as a cosine and sine), and how much it changes saturation and brightness. */
function mixTables(A) {
  let any = false, turn = false; for (let i = 0; i < 8; i++) { if (A['mxH' + i] || A['mxS' + i] || A['mxL' + i]) any = true; if (A['mxH' + i]) turn = true; }
  if (!any) return null;
  const cs = new Float32Array(HN), sn = new Float32Array(HN), S = new Float32Array(HN), L = new Float32Array(HN);
  for (let k = 0; k < HN; k++) {
    const hue = k / HN * 360; let j = 7; for (let i = 0; i < 8; i++) if (hue >= MIX_HUES[i]) j = i;
    const a = MIX_HUES[j], b = j === 7 ? 360 : MIX_HUES[j + 1], n = (j + 1) % 8; let t = (hue - a) / (b - a); t = t * t * (3 - 2 * t);
    const mix = key => (A[key + j] * (1 - t) + A[key + n] * t) / 100;
    const th = mix('mxH') * 40 * Math.PI / 180; cs[k] = Math.cos(th); sn[k] = Math.sin(th) / Math.sqrt(3);
    S[k] = mix('mxS'); L[k] = mix('mxL') * 0.4;
  }
  return { cs, sn, S, L, turn };
}
/** The tint added at every brightness: shadows, midtones and highlights, moved along by the balance. */
function gradeTables(A) {
  if (!A.shAmt && !A.hlAmt && !A.mdAmt) return null;
  const R = new Float32Array(256), G = new Float32Array(256), B = new Float32Array(256), ex = Math.pow(2, -A.balance / 100 * 1.5);
  const tint = (hue, amt) => { const c = hueRgb(hue), a = amt / 100 * 0.3; return [(c[0] - 0.5) * a, (c[1] - 0.5) * a, (c[2] - 0.5) * a]; };
  const s = tint(A.shHue, A.shAmt), h = tint(A.hlHue, A.hlAmt), md = tint(A.mdHue, A.mdAmt);
  /* the midtone tint keeps brightness where it was, so it colors the middle without lifting or sinking it */
  const ml = 0.2126 * md[0] + 0.7152 * md[1] + 0.0722 * md[2]; md[0] -= ml; md[1] -= ml; md[2] -= ml;
  for (let i = 0; i < 256; i++) { const l = Math.pow(i / 255, ex), ws = (1 - l) * (1 - l), wl = l * l, wm = 4 * l * (1 - l); R[i] = s[0] * ws + h[0] * wl + md[0] * wm; G[i] = s[1] * ws + h[1] * wl + md[1] * wm; B[i] = s[2] * ws + h[2] * wl + md[2] * wm; }
  return [R, G, B];
}

/**
 * Version 2 of develop. P is as for develop. A is the settings (see ADJ2), curve the overall curve,
 * curves the three channel curves ({ r, g, b }, each five points), and lut a 3D lookup table:
 * { n, data } with n points a side and data a Float32Array of n*n*n*3 values from 0 to 1, red changing fastest.
 */
export function develop2(P, A, curve, curves, lut) {
  const d = P.src, bd = P.blur, o = P.out, w = P.w, h = P.h, fw = P.fw || w, fh = P.fh || h, ox = P.ox || 0, oy = P.oy || 0;
  const amt = A.amount / 100, same = o === d;
  if (amt <= 0) { if (!same) for (let i = 0; i < w * h * 4; i += 4) { o[i] = d[i]; o[i + 1] = d[i + 1]; o[i + 2] = d[i + 2]; o[i + 3] = 255; } return o; }
  const T = channelTables(curve, curves), TR = T && T[0], TG = T && T[1], TB = T && T[2], M = mixTables(A), GT = gradeTables(A), GR = GT && GT[0], GG = GT && GT[1], GB = GT && GT[2];
  const ex = Math.pow(2, A.exposure / 50), con = A.contrast >= 0 ? 1 + A.contrast / 100 : 1 + A.contrast / 200;
  const tr = 1 + A.temp / 100 * 0.28 + Math.max(0, A.tint) / 100 * 0.06, tb = 1 - A.temp / 100 * 0.28 + Math.max(0, A.tint) / 100 * 0.06, tg = 1 - A.tint / 100 * 0.18;
  const hl = A.highlights / 100 * 0.42, sh = A.shadows / 100 * 0.42, wh = A.whites / 100 * 0.3, bk = A.blacks / 100 * 0.3;
  const sat = 1 + A.saturation / 100, vib = A.vibrance / 100, cl = A.clarity / 100 * 1.6, fade = A.fade / 100, vig = A.vignette / 100 * 0.85, grain = A.grain / 100 * 0.26;
  const mat = A.matte / 100, ln = lut ? lut.n : 0, ld = lut ? lut.data : null, ln1 = ln - 1, lrow = ln * 3, lslab = ln * ln * 3;
  let seed = 0x9e3779b9 | 0, i = 0;
  for (let y = 0; y < h; y++) {
    const dy = (y + oy) / fh - 0.5;
    for (let x = 0; x < w; x++, i += 4) {
      const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
      let r = r0 / 255, g = g0 / 255, b = b0 / 255;
      if (cl) { const det = (0.2126 * r + 0.7152 * g + 0.0722 * b) - (0.2126 * bd[i] + 0.7152 * bd[i + 1] + 0.0722 * bd[i + 2]) / 255; r += det * cl; g += det * cl; b += det * cl; }
      r = (r * ex * tr - 0.5) * con + 0.5; g = (g * ex * tg - 0.5) * con + 0.5; b = (b * ex * tb - 0.5) * con + 0.5;
      let l = 0.2126 * r + 0.7152 * g + 0.0722 * b; l = l < 0 ? 0 : l > 1 ? 1 : l; const il = 1 - l;
      const dl = sh * il * il * l * 6.75 + hl * l * l * il * 6.75 + wh * l * l * l + bk * il * il * il;
      r += dl; g += dl; b += dl;
      if (TR) { r = TR[r <= 0 ? 0 : r >= 1 ? TN - 1 : (r * (TN - 1) + 0.5) | 0]; g = TG[g <= 0 ? 0 : g >= 1 ? TN - 1 : (g * (TN - 1) + 0.5) | 0]; b = TB[b <= 0 ? 0 : b >= 1 ? TN - 1 : (b * (TN - 1) + 0.5) | 0]; }
      if (M) {
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b), c = mx - mn;
        if (c > 0.004) {
          let hq = mx === r ? (g - b) / c : mx === g ? 2 + (b - r) / c : 4 + (r - g) / c; if (hq < 0) hq += 6;
          let k = (hq * (HN / 6)) | 0; if (k >= HN) k = HN - 1;
          /* gray has no hue to speak of, so the mixer fades out as color does */
          let wt = c * 5; if (wt > 1) wt = 1;
          if (M.turn) {
            const m = (r + g + b) / 3, a1 = r - m, a2 = g - m, a3 = b - m, cs = M.cs[k], sn = M.sn[k], l0 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let r2 = m + a1 * cs + (a3 - a2) * sn, g2 = m + a2 * cs + (a1 - a3) * sn, b2 = m + a3 * cs + (a2 - a1) * sn;
            const fix = l0 - (0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2); r2 += fix; g2 += fix; b2 += fix;
            r += (r2 - r) * wt; g += (g2 - g) * wt; b += (b2 - b) * wt;
          }
          const ks = 1 + M.S[k] * wt, kl = 1 + M.L[k] * wt, l1 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          r = (l1 + (r - l1) * ks) * kl; g = (l1 + (g - l1) * ks) * kl; b = (l1 + (b - l1) * ks) * kl;
        }
      }
      l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (sat !== 1 || vib) { const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b); let s2 = (mx - mn) * 1.6; if (s2 > 1) s2 = 1; const k = sat * (1 + vib * (1 - s2)); r = l + (r - l) * k; g = l + (g - l) * k; b = l + (b - l) * k; }
      if (GR) { const k = l <= 0 ? 0 : l >= 1 ? 255 : (l * 255 + 0.5) | 0; r += GR[k]; g += GG[k]; b += GB[k]; }
      if (ld) {
        /* tetrahedral interpolation: the cube around the color is split into six pieces and the color mixed from the four corners of its piece */
        const fr = (r <= 0 ? 0 : r >= 1 ? 1 : r) * ln1, fg = (g <= 0 ? 0 : g >= 1 ? 1 : g) * ln1, fb = (b <= 0 ? 0 : b >= 1 ? 1 : b) * ln1;
        let ir = fr | 0, ig = fg | 0, ib = fb | 0; if (ir >= ln1) ir = ln1 - 1; if (ig >= ln1) ig = ln1 - 1; if (ib >= ln1) ib = ln1 - 1;
        const xr = fr - ir, xg = fg - ig, xb = fb - ib, p0 = ib * lslab + ig * lrow + ir * 3, p7 = p0 + lslab + lrow + 3;
        let pa, pb, wa, wb2, wc, w0;
        if (xr >= xg) {
          if (xg >= xb) { pa = p0 + 3; pb = pa + lrow; w0 = 1 - xr; wa = xr - xg; wb2 = xg - xb; wc = xb; }
          else if (xr >= xb) { pa = p0 + 3; pb = pa + lslab; w0 = 1 - xr; wa = xr - xb; wb2 = xb - xg; wc = xg; }
          else { pa = p0 + lslab; pb = pa + 3; w0 = 1 - xb; wa = xb - xr; wb2 = xr - xg; wc = xg; }
        } else {
          if (xb >= xg) { pa = p0 + lslab; pb = pa + lrow; w0 = 1 - xb; wa = xb - xg; wb2 = xg - xr; wc = xr; }
          else if (xb >= xr) { pa = p0 + lrow; pb = pa + lslab; w0 = 1 - xg; wa = xg - xb; wb2 = xb - xr; wc = xr; }
          else { pa = p0 + lrow; pb = pa + 3; w0 = 1 - xg; wa = xg - xr; wb2 = xr - xb; wc = xb; }
        }
        r = ld[p0] * w0 + ld[pa] * wa + ld[pb] * wb2 + ld[p7] * wc; g = ld[p0 + 1] * w0 + ld[pa + 1] * wa + ld[pb + 1] * wb2 + ld[p7 + 1] * wc; b = ld[p0 + 2] * w0 + ld[pa + 2] * wa + ld[pb + 2] * wb2 + ld[p7 + 2] * wc;
      }
      if (mat) {
        /* matte: the blacks come up and the whites come down a little. Both fade out toward the middle, which stays where it was. */
        r = r <= 0 ? 0 : r >= 1 ? 1 : r; g = g <= 0 ? 0 : g >= 1 ? 1 : g; b = b <= 0 ? 0 : b >= 1 ? 1 : b;
        let q = 1 - r; q *= q; let u = r * r; r += mat * (0.16 * q * q - 0.07 * u * u); q = 1 - g; q *= q; u = g * g; g += mat * (0.16 * q * q - 0.07 * u * u); q = 1 - b; q *= q; u = b * b; b += mat * (0.16 * q * q - 0.07 * u * u);
      }
      if (fade) { r = r * (1 - fade * 0.24) + fade * 0.11; g = g * (1 - fade * 0.24) + fade * 0.11; b = b * (1 - fade * 0.24) + fade * 0.11; }
      if (vig) { const dx = (x + ox) / fw - 0.5, t = (dx * dx + dy * dy) * 2, f = 1 - vig * t * t; r *= f; g *= f; b *= f; }
      if (grain) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; const nz = ((seed >>> 0) / 4294967296 - 0.5) * grain; r += nz; g += nz; b += nz; }
      if (amt < 1) { r = r <= 0 ? 0 : r >= 1 ? 1 : r; g = g <= 0 ? 0 : g >= 1 ? 1 : g; b = b <= 0 ? 0 : b >= 1 ? 1 : b; r = r0 / 255 + (r - r0 / 255) * amt; g = g0 / 255 + (g - g0 / 255) * amt; b = b0 / 255 + (b - b0 / 255) * amt; }
      o[i] = r <= 0 ? 0 : r >= 1 ? 255 : (r * 255 + 0.5) | 0; o[i + 1] = g <= 0 ? 0 : g >= 1 ? 255 : (g * 255 + 0.5) | 0; o[i + 2] = b <= 0 ? 0 : b >= 1 ? 255 : (b * 255 + 0.5) | 0; o[i + 3] = 255;
    }
  }
  return o;
}

/** Develop pixels with a whole recipe, whichever version it was saved with. lut is the table the recipe names, when it names one. */
export function developRecipe(P, recipe, lut) {
  if ((recipe.v || 1) >= 2) return develop2(P, { ...ADJ2, ...recipe.adj }, recipe.curve, recipe.curves, lut);
  return develop(P, { ...ADJ0, ...recipe.adj }, recipe.curve);
}

/** True when a recipe changes nothing, so there is no point saving a copy. */
export function recipeIsEmpty(r) {
  const a = r.adj || {}, g = r.geo || GEO0, c = g.crop || GEO0.crop, cs = r.curves || {};
  const still = !g.rot && !g.flipH && !g.flipV && !g.straighten && c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1;
  if ((r.v || 1) >= 2 && a.amount === 0) return still;
  return Object.keys(a).every(k => REST[k] || (a[k] ?? 0) === 0) && curveIsFlat(r.curve || CURVE0) &&
    ['r', 'g', 'b'].every(k => curveIsFlat(cs[k] || CURVE0)) && !r.lut && still;
}
