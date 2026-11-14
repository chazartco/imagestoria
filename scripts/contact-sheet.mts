// Prints every look on the same six pictures, one page per group, so the looks can be judged side by side.
// Usage: npx tsx scripts/contact-sheet.mts [folder with photos] [folder for the pages]
// With no folder of photos it draws six practice scenes: faces, sea and sky, leaves, a night street, a low sun, a color chart.
// The pages are JPEG files named looks-01-cinematic.jpg and so on. The first row of each page is the untouched picture.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ADJ2, CURVE0, blurFactor, develop2 } from '../src/shared/develop.js';
import { LOOKS, LOOK_GROUPS } from '../src/shared/looks.js';

const [photoDir, outArg] = process.argv.slice(2);
const out = outArg ?? path.join(process.cwd(), 'contact-sheets');
fs.mkdirSync(out, { recursive: true });
const CW = 300, CH = 200, WORK = 2, LABEL = 190, GAP = 6;

type Pic = { data: Buffer; w: number; h: number };

/* ---------- practice scenes ---------- */
const hash = (x: number, y: number, s: number) => { let n = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; n = (n ^ (n >>> 13)) * 1274126177 | 0; return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
const vnoise = (x: number, y: number, s: number) => { const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy); return (hash(xi, yi, s) * (1 - u) + hash(xi + 1, yi, s) * u) * (1 - v) + (hash(xi, yi + 1, s) * (1 - u) + hash(xi + 1, yi + 1, s) * u) * v; };
const fbm = (x: number, y: number, s: number) => vnoise(x, y, s) * 0.5 + vnoise(x * 2.1, y * 2.1, s + 1) * 0.3 + vnoise(x * 4.3, y * 4.3, s + 2) * 0.2;
type RGB = [number, number, number];
const mixc = (a: RGB, b: RGB, t: number): RGB => { t = Math.max(0, Math.min(1, t)); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
const mul = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: RGB, b: RGB): RGB => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const SKIN: RGB[] = [[0.94, 0.77, 0.67], [0.8, 0.58, 0.44], [0.45, 0.29, 0.2]];
/** A head and shoulders: a shaded ball of skin, hair above, a shirt below. Returns null outside it. */
function person(u: number, v: number, cx: number, cy: number, r: number, skin: RGB, shirt: RGB, light: RGB = [1, 1, 1], lx = -0.5): RGB | null {
  const dx = (u - cx) / r, dy = (v - cy) / (r * 1.3), d2 = dx * dx + dy * dy;
  if (d2 < 1) {
    const nz = Math.sqrt(1 - d2), sh = Math.max(0, dx * lx - dy * 0.45 + nz * 0.75);
    if (dy < -0.45 - 0.25 * Math.cos(dx * 3)) return mul([0.1, 0.07, 0.06], 0.6 + sh);
    const c = mul(skin, 0.42 + 0.68 * sh), blush = Math.exp(-((Math.abs(dx) - 0.45) ** 2 + (dy - 0.25) ** 2) * 14) * 0.07;
    return [c[0] * light[0] + blush, c[1] * light[1], c[2] * light[2]];
  }
  const sy = (v - cy) / r - 1.25; if (sy > 0 && Math.abs(u - cx) < r * (0.75 + sy * 0.9)) return mul([shirt[0] * light[0], shirt[1] * light[1], shirt[2] * light[2]], 0.75 + 0.25 * vnoise(u * 60, v * 60, 9));
  return null;
}
const SCENES: Record<string, (u: number, v: number) => RGB> = {
  faces(u, v) {
    for (const [i, cx] of [0.2, 0.5, 0.8].entries()) { const p = person(u, v, cx, 0.42, 0.115, SKIN[i]!, [[0.2, 0.32, 0.55], [0.9, 0.9, 0.88], [0.7, 0.14, 0.13]][i] as RGB); if (p) return p; }
    return mul(mixc([0.5, 0.53, 0.56], [0.3, 0.33, 0.37], v + (u - 0.5) * 0.3), 0.9 + 0.2 * fbm(u * 3, v * 3, 4));
  },
  sea(u, v) {
    if (v < 0.52) { const sky = mixc([0.2, 0.45, 0.85], [0.66, 0.82, 0.95], v / 0.52), c = fbm(u * 4, v * 9, 11); return mixc(sky, [0.98, 0.98, 0.97], (c - 0.5) * 5 * (1 - v)); }
    if (v < 0.78) { const t = (v - 0.52) / 0.26, w = fbm(u * 30, v * 120, 5); return add(mixc([0.05, 0.3, 0.6], [0.2, 0.75, 0.72], t), mul([1, 1, 1], Math.max(0, w - 0.62) * 0.9)); }
    const palm = fbm(u * 9, v * 9, 21) > 0.6 && u < 0.3; return palm ? mul([0.15, 0.4, 0.14], 0.7 + fbm(u * 40, v * 40, 2)) : mul([0.88, 0.78, 0.6], 0.85 + 0.25 * fbm(u * 60, v * 60, 3));
  },
  leaves(u, v) {
    const n = fbm(u * 7, v * 7, 31), m = fbm(u * 23, v * 23, 37), light = fbm(u * 3 + 5, v * 3, 41);
    if (Math.abs(u - 0.72 - 0.05 * Math.sin(v * 5)) < 0.035) return mul([0.36, 0.25, 0.16], 0.6 + m * 0.8);
    for (let k = 0; k < 9; k++) { const fx = hash(k, 1, 7), fy = hash(k, 2, 7), d = Math.hypot(u - fx, (v - fy) * 0.66); if (d < 0.022) return ([[0.86, 0.12, 0.14], [0.85, 0.2, 0.6], [0.95, 0.8, 0.15]] as RGB[])[k % 3]!; }
    let c = mixc([0.05, 0.16, 0.06], [0.22, 0.48, 0.13], n * 1.5 - 0.2); c = mixc(c, [0.6, 0.7, 0.22], (m - 0.55) * 3);
    if (v < 0.22 && light > 0.55) return mixc(c, [0.75, 0.87, 0.97], (light - 0.55) * 8);
    return mul(c, 0.55 + light * 0.9);
  },
  night(u, v) {
    const street = v > 0.68, vv = street ? 0.68 - (v - 0.68) * 1.2 : v, uu = street ? u + (fbm(u * 40, v * 14, 51) - 0.5) * 0.03 : u;
    let c: RGB = mul([0.03, 0.035, 0.07], 0.6 + fbm(uu * 4, vv * 2, 53));
    const bx = Math.floor(uu * 7), top = 0.12 + hash(bx, 3, 5) * 0.3; if (vv > top) { c = mul([0.05, 0.055, 0.085], 0.8 + hash(bx, 4, 5) * 0.6); const wx = Math.floor(uu * 56), wy = Math.floor(vv * 40); if (hash(wx, wy, 8) > 0.82 && (uu * 56) % 1 > 0.25 && (vv * 40) % 1 > 0.3) c = mul([1, 0.74, 0.4], 0.5 + hash(wx, wy, 9) * 0.5); }
    for (const [x, y, w, col] of [[0.18, 0.5, 0.1, [1, 0.1, 0.7]], [0.45, 0.42, 0.13, [0.1, 0.9, 1]], [0.7, 0.52, 0.08, [1, 0.85, 0.15]], [0.88, 0.4, 0.07, [1, 0.12, 0.1]], [0.32, 0.6, 0.06, [0.2, 1, 0.35]]] as [number, number, number, RGB][]) {
      const dx = Math.max(0, Math.abs(uu - x) - w), dy = Math.abs(vv - y), d = Math.hypot(dx, dy * 1.5); c = add(c, mul(col, Math.exp(-d * d * 900) * 1.1 + Math.exp(-d * 9) * 0.22));
    }
    if (!street) { const p = person(u, v, 0.57, 0.55, 0.05, SKIN[1]!, [0.15, 0.15, 0.2], [0.75, 0.6, 0.85], 0.4); if (p) return mul(p, 0.75); }
    return street ? mul(c, 0.55) : c;
  },
  sunset(u, v) {
    const d = Math.hypot(u - 0.68, (v - 0.56) * 1.4), glow = Math.exp(-d * 5);
    if (v < 0.6 + 0.02 * Math.sin(u * 23) + 0.03 * fbm(u * 12, 0, 61)) { let c = mixc([0.36, 0.38, 0.62], [1, 0.58, 0.22], Math.pow(v / 0.6, 1.6)); c = add(c, mul([1, 0.8, 0.45], glow * 0.75)); const cl = fbm(u * 5, v * 14, 63); return mixc(c, [0.85, 0.42, 0.38], (cl - 0.58) * 4); }
    const p = person(u, v, 0.3, 0.52, 0.07, SKIN[0]!, [0.3, 0.2, 0.2], [1, 0.82, 0.6], 0.7); if (p) return mul(p, 0.7);
    const g = fbm(u * 50, v * 90, 67); return add(mul([0.2, 0.14, 0.07], 0.5 + g), mul([0.9, 0.55, 0.2], Math.max(0, g - 0.6) * glow * 3));
  },
  chart(u, v) {
    if (v < 0.2) return [Math.floor(u * 16) / 15, Math.floor(u * 16) / 15, Math.floor(u * 16) / 15].map((x) => Math.pow(x, 1.1)) as RGB;
    if (v < 0.68) { const s = [1, 0.6, 0.3][Math.floor((v - 0.2) / 0.16)]!, h = u * 6, f = (n: number) => { const k = (n + h) % 6; return 1 - Math.max(0, Math.min(1, Math.min(k, 4 - k))); }, c: RGB = [f(5), f(3), f(1)]; return mixc([0.55, 0.55, 0.55], c, s); }
    const row: RGB[] = [SKIN[0]!, [0.87, 0.67, 0.55], SKIN[1]!, [0.62, 0.42, 0.31], SKIN[2]!, [0.3, 0.19, 0.14], [0.25, 0.5, 0.86], [0.55, 0.76, 0.93], [0.16, 0.4, 0.12], [0.45, 0.6, 0.2], [0.86, 0.78, 0.6], [0.36, 0.25, 0.16]];
    return row[Math.min(row.length - 1, Math.floor(u * row.length))]!;
  },
};
function scene(name: string, w: number, h: number): Pic {
  const data = Buffer.alloc(w * h * 4), f = SCENES[name]!;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) { const c = f((x + 0.5) / w, (y + 0.5) / h), g = (hash(x, y, 99) - 0.5) * 0.012; for (let k = 0; k < 3; k++) data[i + k] = Math.max(0, Math.min(255, Math.round((c[k]! + g) * 255))); data[i + 3] = 255; }
  return { data, w, h };
}

/* ---------- the pictures ---------- */
async function pictures(): Promise<Pic[]> {
  if (!photoDir) return Object.keys(SCENES).map((n) => scene(n, CW * WORK, CH * WORK));
  const files = fs.readdirSync(photoDir).filter((f) => /\.(jpe?g|png|webp|tiff?|heic|avif)$/i.test(f)).sort().slice(0, 6);
  if (!files.length) throw new Error(`There are no pictures in ${photoDir}.`);
  return Promise.all(files.map(async (f) => { const r = await sharp(path.join(photoDir, f)).rotate().resize(CW * WORK, CH * WORK, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { data: r.data, w: r.info.width, h: r.info.height }; }));
}
const raw = (p: Pic) => sharp(p.data, { raw: { width: p.w, height: p.h, channels: 4 } });
async function withBlur(p: Pic) { const f = blurFactor(p.w, p.h); const small = await raw(p).resize(Math.max(2, Math.round(p.w / f)), Math.max(2, Math.round(p.h / f)), { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true }); return { ...p, blur: await sharp(small.data, { raw: { width: small.info.width, height: small.info.height, channels: 4 } }).resize(p.w, p.h, { fit: 'fill' }).raw().toBuffer() }; }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const pics = await Promise.all((await pictures()).map(withBlur));
const only = process.env.GROUP;
for (const [gi, group] of LOOK_GROUPS.entries()) {
  if (only && !group.toLowerCase().includes(only.toLowerCase())) continue;
  const rows = [{ name: 'Original', adj: {}, curve: null, curves: null } as any, ...LOOKS.filter((l) => l.group === group)];
  const W = LABEL + pics.length * (CW + GAP), H = 44 + rows.length * (CH + GAP);
  const parts: sharp.OverlayOptions[] = [];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#17181a"/><text x="14" y="29" font-family="sans-serif" font-size="20" font-weight="700" fill="#ffb224">${esc(group)}</text>`;
  for (const [ri, L] of rows.entries()) {
    const top = 44 + ri * (CH + GAP);
    svg += `<text x="14" y="${top + CH / 2 + 5}" font-family="sans-serif" font-size="16" fill="#eceae6">${esc(L.name)}</text>`;
    for (const [pi, p] of pics.entries()) {
      const o = Buffer.alloc(p.data.length);
      develop2({ src: p.data, blur: p.blur, out: o, w: p.w, h: p.h }, { ...ADJ2, ...L.adj }, L.curve ?? CURVE0, L.curves, null);
      const cell = await sharp(o, { raw: { width: p.w, height: p.h, channels: 4 } }).resize(CW, CH, { fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
      parts.push({ input: cell.data, left: LABEL + pi * (CW + GAP) + Math.round((CW - cell.info.width) / 2), top: top + Math.round((CH - cell.info.height) / 2) });
    }
  }
  const file = path.join(out, `looks-${String(gi + 1).padStart(2, '0')}-${group.toLowerCase().replace(/[^a-z]+/g, '-')}.jpg`);
  await sharp(Buffer.from(svg + '</svg>')).composite(parts).jpeg({ quality: 88 }).toFile(file);
  console.log(file);
}
