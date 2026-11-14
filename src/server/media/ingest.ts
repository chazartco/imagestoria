import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, eq } from 'drizzle-orm';
import exifr from 'exifr';
import sharp from 'sharp';
import type { OutputInfo, Sharp } from 'sharp';
import { lookAtVideo, queuePlayCopy } from './playcopy.js';
import { lutData } from '../routes/luts.js';
import { blurFactor, coverZoom, developRecipe, GEO0 } from '../../shared/develop.js';
import type { Ctx } from '../context.js';
import { schema } from '../db/index.js';
import { placeIdFor, whereFor } from './spots.js';

const run = promisify(execFile);
sharp.cache(false);

export const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|heic|heif|tiff?|bmp)$/i;
export const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
/** Formats a browser shows on its own. Anything else gets a full-size WebP copy for the zoom view. */
const WEB_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const MIME: Record<string, string> = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heif: 'image/heic', heic: 'image/heic', tiff: 'image/tiff', tif: 'image/tiff', bmp: 'image/bmp', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo' };

export const mimeFor = (name: string) => MIME[(name.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream';
export const isVideoName = (name: string) => VIDEO_EXT.test(name);
export const isMediaName = (name: string) => IMAGE_EXT.test(name) || VIDEO_EXT.test(name);

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** A wall-clock moment kept in a Date's UTC fields, so 17:42 on the camera stays 17:42 for every viewer. */
export const wall = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi, s));
export function wallFromEpoch(ms: number, tzOffsetMinutes: number) {
  return new Date(ms - tzOffsetMinutes * 60_000);
}
function parseExifDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})[:-](\d\d)[:-](\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(v);
  if (!m || m[1] === '0000') return null;
  return wall(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

export interface Probe {
  takenAt: Date | null;
  lat: number | null;
  lng: number | null;
  camera: string | null;
  lens: string | null;
  iso: number | null;
  shutter: string | null;
  fnum: number | null;
  focal: number | null;
}
const emptyProbe = (): Probe => ({ takenAt: null, lat: null, lng: null, camera: null, lens: null, iso: null, shutter: null, fnum: null, focal: null });

const PICK = ['Make', 'Model', 'LensModel', 'ISO', 'ExposureTime', 'FNumber', 'FocalLength', 'DateTimeOriginal', 'CreateDate', 'ModifyDate'];
async function readTags(input: string | Buffer) {
  let tags: any = null, gps: any = null;
  try { tags = await exifr.parse(input, { reviveValues: false, gps: false, pick: PICK }); } catch { /* unreadable */ }
  try { gps = await exifr.gps(input); } catch { /* none */ }
  if (tags && tags.errors && Object.keys(tags).length === 1) tags = null;
  return { tags, gps };
}

export async function probeImage(file: string): Promise<Probe> {
  const p = emptyProbe();
  let { tags: x, gps: g } = await readTags(file);
  if (!x && !g) {
    // Some files keep their EXIF where the first reader does not look (certain HEIC writers).
    // The image library can still hand over the raw block, which then parses as a small TIFF.
    try {
      const block = (await sharp(file).metadata()).exif;
      if (block && block.length > 12) ({ tags: x, gps: g } = await readTags(block.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? block.subarray(6) : block));
    } catch { /* no metadata at all: fine */ }
  }
  if (x) {
    p.takenAt = parseExifDate(x.DateTimeOriginal) ?? parseExifDate(x.CreateDate) ?? parseExifDate(x.ModifyDate);
    const make = String(x.Make ?? '').trim(), model = String(x.Model ?? '').trim();
    // "Apple iPhone 15 Pro" reads better as "iPhone 15 Pro"; "FUJIFILM X-T5" keeps its maker.
    p.camera = (model.toLowerCase().startsWith(make.toLowerCase()) || make === 'Apple' ? model : `${make} ${model}`).trim() || null;
    p.lens = x.LensModel ? String(x.LensModel).trim() : null;
    p.iso = Number.isFinite(+x.ISO) ? Math.round(+x.ISO) : null;
    const t = +x.ExposureTime;
    if (Number.isFinite(t) && t > 0) p.shutter = t >= 1 ? String(Math.round(t * 10) / 10) : `1/${Math.round(1 / t)}`;
    p.fnum = Number.isFinite(+x.FNumber) ? Math.round(+x.FNumber * 100) / 100 : null;
    p.focal = Number.isFinite(+x.FocalLength) ? Math.round(+x.FocalLength) : null;
  }
  if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude) && (g.latitude !== 0 || g.longitude !== 0)) { p.lat = g.latitude; p.lng = g.longitude; }
  return p;
}

export interface VideoInfo extends Probe { width: number; height: number; duration: number | null }
export async function probeVideo(file: string): Promise<VideoInfo> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: 8 << 20 });
  const j = JSON.parse(stdout) as { streams?: any[]; format?: { duration?: string; tags?: Record<string, string> } };
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
  if (!v) throw new Error('No video track in this file.');
  let width = v.width as number, height = v.height as number;
  const rot = Math.abs(Number(v.tags?.rotate ?? (v.side_data_list ?? []).find((s: any) => s.rotation != null)?.rotation ?? 0));
  if (rot === 90 || rot === 270) [width, height] = [height, width];
  const tags: Record<string, string> = {};
  for (const [k, val] of Object.entries(j.format?.tags ?? {})) tags[k.toLowerCase()] = val;
  const out: VideoInfo = { ...emptyProbe(), width, height, duration: j.format?.duration ? Number(j.format.duration) : null };
  // Apple writes the local time with its offset; the plain creation_time is UTC, which would shift the hour.
  const apple = tags['com.apple.quicktime.creationdate'];
  out.takenAt = parseExifDate(apple) ?? null;
  if (!out.takenAt && tags['creation_time']) { const d = new Date(tags['creation_time']); if (!Number.isNaN(d.getTime()) && d.getUTCFullYear() > 1971) out.takenAt = d; }
  const loc = /([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(tags['com.apple.quicktime.location.iso6709'] ?? tags['location'] ?? '');
  if (loc) { out.lat = Number(loc[1]); out.lng = Number(loc[2]); }
  const make = tags['com.apple.quicktime.make'] ?? '', model = tags['com.apple.quicktime.model'] ?? '';
  out.camera = `${model.startsWith(make) ? '' : make + ' '}${model}`.trim() || null;
  return out;
}

/**
 * Open any supported picture as an upright sharp image.
 * Most formats go straight in. iPhone HEIC needs a decoder that the stock image library
 * does not ship, so it is decoded by a bundled WebAssembly build of libheif first.
 */
export interface Upright { img: Sharp; width: number; height: number }
export async function openUpright(file: string): Promise<Upright> {
  try {
    const m = await sharp(file, { failOn: 'none', limitInputPixels: 400_000_000 }).metadata();
    const img = sharp(file, { failOn: 'none', limitInputPixels: 400_000_000 }).rotate();
    await img.clone().resize(8, 8).raw().toBuffer(); // proves the decoder can really read it
    const turned = (m.orientation ?? 1) >= 5;
    return { img, width: (turned ? m.height : m.width) ?? 0, height: (turned ? m.width : m.height) ?? 0 };
  } catch (first) {
    try {
      const convert = (await import('heic-convert')).default as (o: { buffer: Buffer; format: 'JPEG'; quality: number }) => Promise<ArrayBuffer>;
      const jpg = Buffer.from(await convert({ buffer: await fsp.readFile(file), format: 'JPEG', quality: 0.96 }));
      // libheif already applied the rotation stored in the file, so no second rotation here.
      const m = await sharp(jpg).metadata();
      return { img: sharp(jpg, { failOn: 'none' }), width: m.width ?? 0, height: m.height ?? 0 };
    } catch {
      throw first;
    }
  }
}

/** Five dominant colors, most common first, from a small copy of the picture. */
export async function paletteOf(img: Sharp): Promise<string[]> {
  const { data } = await img.clone().resize(32, 32, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bins = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < data.length; i += 3) {
    const k = ((data[i]! >> 5) << 6) | ((data[i + 1]! >> 5) << 3) | (data[i + 2]! >> 5);
    const b = bins.get(k) ?? [0, 0, 0, 0];
    b[0] += data[i]!; b[1] += data[i + 1]!; b[2] += data[i + 2]!; b[3]++;
    bins.set(k, b);
  }
  return [...bins.values()].sort((a, b) => b[3] - a[3]).slice(0, 5).map((b) => '#' + [b[0], b[1], b[2]].map((v) => Math.round(v / b[3]).toString(16).padStart(2, '0')).join(''));
}

export function keysFor(itemId: string, takenAt: Date, fileName: string) {
  const y = takenAt.getUTCFullYear(), m = String(takenAt.getUTCMonth() + 1).padStart(2, '0');
  const safe = fileName.replace(/[^\w.\-()+ ]+/g, '_').slice(-120) || 'file';
  return { orig: `originals/${y}/${m}/${itemId}/${safe}`, display: `display/${y}/${m}/${itemId}.webp`, thumb: `thumbs/${y}/${m}/${itemId}.webp`, full: `full/${y}/${m}/${itemId}.webp` };
}

export { placeIdFor };

/** Make and store the WebP copies of an upright image. Returns sizes and the palette. */
async function makeRenditions(ctx: Ctx, up: Upright, keys: ReturnType<typeof keysFor>, opts: { full: boolean }) {
  const { img, width, height } = up;
  if (!width || !height) throw new Error('This picture could not be decoded.');
  const ar = width / height;
  let th = Math.min(ctx.cfg.THUMB_HEIGHT, height), tw = Math.round(th * ar);
  if (tw > 1500) { tw = 1500; th = Math.round(tw / ar); }
  const k = Math.min(1, ctx.cfg.DISPLAY_LONG_EDGE / Math.max(width, height));
  const thumb = await img.clone().resize(Math.max(1, tw), Math.max(1, th), { fit: 'fill' }).webp({ quality: 78 }).toBuffer();
  const display = await img.clone().resize(Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k)), { fit: 'fill' }).webp({ quality: 86 }).toBuffer();
  await ctx.storage.putBuffer(keys.thumb, thumb, 'image/webp');
  await ctx.storage.putBuffer(keys.display, display, 'image/webp');
  let bytesFull = 0;
  if (opts.full) {
    // WebP tops out at 16383 px a side; shrink only if a picture is larger than that.
    const f = Math.min(1, 16383 / Math.max(width, height));
    const full = await img.clone().resize(Math.round(width * f), Math.round(height * f), { fit: 'fill' }).webp({ quality: 92 }).toBuffer();
    await ctx.storage.putBuffer(keys.full, full, 'image/webp');
    bytesFull = full.length;
  }
  return { width, height, bytesThumb: thumb.length, bytesDisplay: display.length, bytesFull, palette: await paletteOf(sharp(thumb)) };
}

async function withLocalOriginal<T>(ctx: Ctx, item: typeof schema.items.$inferSelect, tmpPath: string | undefined, fn: (file: string) => Promise<T>): Promise<T> {
  if (tmpPath && fs.existsSync(tmpPath)) {
    try { return await fn(tmpPath); } finally { await fsp.rm(tmpPath, { force: true }); }
  }
  const file = path.join(ctx.cfg.tmpDir, `${item.id}-${crypto.randomBytes(4).toString('hex')}${path.extname(item.fileName)}`);
  await fsp.mkdir(ctx.cfg.tmpDir, { recursive: true });
  await ctx.storage.toFile(item.origKey, file);
  try { return await fn(file); } finally { await fsp.rm(file, { force: true }); }
}

/** After an upload: read its details, make the WebP copies, name the place. */
export async function ingestItem(ctx: Ctx, itemId: string, payload: { tmpPath?: string; fallbackTakenAt?: string }) {
  const [item] = await ctx.db.select().from(schema.items).where(eq(schema.items.id, itemId));
  if (!item) return;
  await withLocalOriginal(ctx, item, payload.tmpPath, async (file) => {
    const keys = keysFor(item.id, item.takenAt, item.fileName);
    let probe: Probe, rend: Awaited<ReturnType<typeof makeRenditions>>, duration: number | null = null, full = false;
    if (item.kind === 'video') {
      const v = await probeVideo(file);
      probe = v; duration = v.duration;
      const poster = path.join(ctx.cfg.tmpDir, `${item.id}-poster.jpg`);
      try {
        const at = Math.min(1, (v.duration ?? 2) / 4);
        await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', file, '-frames:v', '1', '-q:v', '2', poster]);
        rend = await makeRenditions(ctx, await openUpright(poster), keys, { full: false });
      } finally { await fsp.rm(poster, { force: true }); }
    } else {
      probe = await probeImage(file);
      full = !WEB_IMAGE.has(item.mime);
      rend = await makeRenditions(ctx, await openUpright(file), keys, { full });
    }
    const takenAt = probe.takenAt ?? (payload.fallbackTakenAt ? new Date(payload.fallbackTakenAt) : item.takenAt);
    await ctx.db.update(schema.items).set({
      status: 'ready', error: null, width: rend.width, height: rend.height, duration, takenAt, dateSource: probe.takenAt ? 'exif' : 'file',
      lat: probe.lat, lng: probe.lng, ...(await whereFor(ctx, probe.lat, probe.lng)), locationSource: probe.lat != null && probe.lng != null ? 'exif' : null,
      camera: probe.camera, lens: probe.lens, iso: probe.iso, shutter: probe.shutter, fnum: probe.fnum, focal: probe.focal,
      palette: rend.palette, displayKey: keys.display, thumbKey: keys.thumb, fullKey: full ? keys.full : null,
      bytesDisplay: rend.bytesDisplay, bytesThumb: rend.bytesThumb, bytesFull: rend.bytesFull, updatedAt: new Date(),
    }).where(eq(schema.items.id, item.id));
    if (item.kind === 'video') {
      // Does it play in a browser as it is? Most do, and are done here. The rest wait in their own line for a copy.
      const plan = await lookAtVideo(file, ctx.cfg.VIDEO_COPY).then((l) => l.plan, () => 'encode' as const);
      if (plan === 'none') await ctx.db.update(schema.items).set({ playStatus: 'none' }).where(eq(schema.items.id, item.id));
      else await queuePlayCopy(ctx, item.id);
    }
  });
}

/** How an edited copy is made from its original. Version 1 has no `v`. Version 2 adds the channel curves and the grading settings in `adj`. */
export interface Recipe {
  v?: number;
  adj: Record<string, number>;
  curves?: { r?: number[]; g?: number[]; b?: number[] };
  /** The id of a look of your own (a row of `luts`), applied after the sliders. */
  lut?: string;
  geo: { rot: number; flipH: boolean; flipV: boolean; straighten: number; crop: { x: number; y: number; w: number; h: number } };
  curve: number[];
  look?: string;
}

/** Render an edit recipe against a full-size upright picture. Returns a JPEG. */
export async function renderRecipe(source: Sharp, recipe: Recipe, lut: { n: number; data: Float32Array } | null = null): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const geo = { ...GEO0, ...recipe.geo, crop: { ...GEO0.crop, ...(recipe.geo?.crop ?? {}) } };
  // 1. Upright pixels.
  let cur = await source.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw = (b: { data: Buffer; info: OutputInfo }) => sharp(b.data, { raw: { width: b.info.width, height: b.info.height, channels: 4 }, limitInputPixels: 400_000_000 });
  const odd = geo.rot % 2 === 1;
  const bw = odd ? cur.info.height : cur.info.width, bh = odd ? cur.info.width : cur.info.height;
  // 2. Quarter turns plus the straighten angle, then mirror, in the same order the editor preview uses.
  const angle = geo.rot * 90 + geo.straighten;
  if (angle % 360 !== 0) cur = await raw(cur).rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 1 } }).raw().toBuffer({ resolveWithObject: true });
  if (geo.flipH || geo.flipV) { let s = raw(cur); if (geo.flipH) s = s.flop(); if (geo.flipV) s = s.flip(); cur = await s.raw().toBuffer({ resolveWithObject: true }); }
  // 3. The frame that stays visible after straightening, then the crop inside it.
  const z = coverZoom(bw, bh, geo.straighten);
  const fw = bw / z, fh = bh / z, fx = (cur.info.width - fw) / 2, fy = (cur.info.height - fh) / 2;
  const left = Math.max(0, Math.round(fx + geo.crop.x * fw)), top = Math.max(0, Math.round(fy + geo.crop.y * fh));
  const width = Math.max(2, Math.min(cur.info.width - left, Math.round(geo.crop.w * fw))), height = Math.max(2, Math.min(cur.info.height - top, Math.round(geo.crop.h * fh)));
  if (left || top || width !== cur.info.width || height !== cur.info.height) cur = await raw(cur).extract({ left, top, width, height }).raw().toBuffer({ resolveWithObject: true });
  // 4. Tone and color, with the same code the browser preview runs.
  const f = blurFactor(width, height);
  const small = await raw(cur).resize(Math.max(2, Math.round(width / f)), Math.max(2, Math.round(height / f)), { fit: 'fill', kernel: 'cubic' }).raw().toBuffer({ resolveWithObject: true });
  const blur = await raw(small).resize(width, height, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer();
  developRecipe({ src: cur.data, blur, out: cur.data, w: width, h: height }, recipe, lut);
  const jpeg = await raw(cur).removeAlpha().jpeg({ quality: 93, chromaSubsampling: '4:4:4' }).toBuffer();
  return { jpeg, width, height };
}

/** Turn a saved recipe into a new item's original, then process it like any upload. */
export async function renderCopy(ctx: Ctx, itemId: string, payload: { sourceId: string }) {
  const [copy] = await ctx.db.select().from(schema.items).where(eq(schema.items.id, itemId));
  const [src] = await ctx.db.select().from(schema.items).where(eq(schema.items.id, payload.sourceId));
  if (!copy || !src || !copy.recipe) throw new Error('The picture this copy was made from is gone.');
  const recipe = copy.recipe as Recipe, lut = recipe.lut ? await lutData(ctx, recipe.lut) : null;
  const out = await withLocalOriginal(ctx, src, undefined, async (file) => renderRecipe((await openUpright(file)).img, recipe, lut));
  await ctx.storage.putBuffer(copy.origKey, out.jpeg, 'image/jpeg');
  const keys = keysFor(copy.id, copy.takenAt, copy.fileName);
  const rend = await makeRenditions(ctx, { img: sharp(out.jpeg), width: out.width, height: out.height }, keys, { full: false });
  await ctx.db.update(schema.items).set({
    status: 'ready', error: null, width: rend.width, height: rend.height, mime: 'image/jpeg', sha256: crypto.createHash('sha256').update(out.jpeg).digest('hex'),
    palette: rend.palette, displayKey: keys.display, thumbKey: keys.thumb, bytesOrig: out.jpeg.length, bytesDisplay: rend.bytesDisplay, bytesThumb: rend.bytesThumb, updatedAt: new Date(),
  }).where(eq(schema.items.id, copy.id));
}
