import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { asc, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/index.js';
import { musicFile } from '../routes/music.js';
import { openUpright } from './ingest.js';

const run = promisify(execFile);
const { reels, stories, storySections } = schema;

/**
 * A reel: a story as one video file, tall (9:16) or wide (16:9), for places that want a video.
 *
 * Nothing is cropped. Every picture and every video is shown whole, 2% clear of the frame's edges, over an
 * enlarged, blurred, darkened copy of itself that fills the rest. That is the slideshow's look, baked in.
 *
 * How it is made, with ffmpeg:
 *   0. The reel opens on the story's card: its cover pictures, whole, with its title under them. The card is in
 *      full view from the very first frame, with no fade in, because the first frame is what a site shows as the
 *      video's thumbnail when nobody picks another one.
 *   1. Each photo becomes one still frame (composed with sharp), held for a few seconds.
 *      Each video is scaled into the same frame and keeps its own sound.
 *   2. The pieces are joined end to end.
 *   3. The music is laid under the whole thing. It is pushed down by the sound of the videos themselves
 *      (a sidechain compressor), so it dips when a video speaks and comes back on the photos.
 */
export const REEL_SIZES: Record<string, [number, number]> = { '9:16': [1080, 1920], '16:9': [1920, 1080] };
const FPS = 30, FADE = 0.3, CARD_MIN_SECONDS = 2.5;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const ff = (args: string[], seconds = 600) => run('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args], { timeout: seconds * 1000, maxBuffer: 16 << 20 });
const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', String(FPS * 2), '-video_track_timescale', '90000', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'];

/** One photo as a finished frame: whole, over a blurred copy of itself. */
export async function composeFrame(file: string, W: number, H: number, out: string) {
  const { default: sharp } = await import('sharp');
  const { img } = await openUpright(file);
  // The picture, whole, at the size it will have in the frame. Kept as plain pixels so nothing is lost before the one final save.
  const fg = await img.clone().resize(even(W * 0.96), even(H * 0.96), { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: fg.info.width, height: fg.info.height, channels: fg.info.channels } };
  // The backdrop is made from that same picture: cut to the frame's shape, shrunk, blurred hard and darkened.
  // It is the only thing that is ever cut to shape, and it is a blur, not the picture.
  const bg = await backdrop(fg.data, raw, W, H);
  await sharp(bg).composite([{ input: fg.data, ...raw, left: Math.round((W - fg.info.width) / 2), top: Math.round((H - fg.info.height) / 2) }]).jpeg({ quality: 93, chromaSubsampling: '4:4:4' }).toFile(out);
}

/** A blurred, darkened backdrop the size of the frame, made from a picture's pixels. */
async function backdrop(pixels: Buffer, raw: { raw: { width: number; height: number; channels: 1 | 2 | 3 | 4 } }, W: number, H: number, brightness = 0.5) {
  const { default: sharp } = await import('sharp');
  return sharp(await sharp(pixels, raw).resize(Math.round(W / 8), Math.round(H / 8), { fit: 'cover' }).blur(9).modulate({ brightness, saturation: 1.15 }).png().toBuffer())
    .resize(W, H, { fit: 'fill', kernel: 'cubic' }).blur(10).png().toBuffer();
}

/**
 * Where up to four cover pictures go in a box: in rows, every picture whole, the pictures of a row the same height
 * and every row the same width. Of all the ways to break them into rows, the one that shows them largest wins.
 */
export function coverLayout(ars: number[], boxW: number, boxH: number, gap: number): { x: number; y: number; w: number; h: number }[] {
  let best: { area: number; cells: { x: number; y: number; w: number; h: number }[] } | null = null;
  const n = ars.length;
  for (let mask = 0; mask < 1 << Math.max(0, n - 1); mask++) {
    const rows: number[][] = [[]]; ars.forEach((a, i) => { rows[rows.length - 1]!.push(a); if (i < n - 1 && mask & (1 << i)) rows.push([]); });
    // at width 1 (before gaps), how tall each row is
    const tall = (width: number) => rows.map((r) => (width - gap * (r.length - 1)) / r.reduce((s, a) => s + a, 0));
    let width = boxW, hs = tall(width), total = hs.reduce((s, h) => s + h, 0) + gap * (rows.length - 1);
    if (total > boxH) { width = Math.max(gap * n + n, width * (boxH - gap * (rows.length - 1)) / (total - gap * (rows.length - 1))); hs = tall(width); total = hs.reduce((s, h) => s + h, 0) + gap * (rows.length - 1); }
    if (hs.some((h) => h <= 1)) continue;
    const cells: { x: number; y: number; w: number; h: number }[] = []; let y = (boxH - total) / 2, area = 0;
    rows.forEach((r, k) => { let x = (boxW - width) / 2; for (const a of r) { const w = a * hs[k]!; cells.push({ x: Math.round(x), y: Math.round(y), w: Math.max(2, Math.floor(w)), h: Math.max(2, Math.floor(hs[k]!)) }); area += w * hs[k]!; x += w + gap; } y += hs[k]! + gap; });
    if (!best || area > best.area) best = { area, cells };
  }
  return best ? best.cells : [];
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function wrap(text: string, perLine: number, maxLines: number): string[] {
  const lines: string[] = []; let cur = '';
  for (const word of text.trim().split(/\s+/)) { if (cur && (cur + ' ' + word).length > perLine) { lines.push(cur); cur = word; } else cur = cur ? cur + ' ' + word : word; }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1]!.replace(/.{0,2}$/, '') + '…'; }
  return lines.map((l) => (l.length > perLine + 6 ? l.slice(0, perLine + 5) + '…' : l));
}

/**
 * The story's card as a finished frame: the cover pictures, each one whole, over a blurred copy of the first,
 * with the title and one line about the story under them on a panel of their own so they read on any picture.
 */
export async function composeCard(covers: string[], title: string, line: string, W: number, H: number, out: string) {
  const { default: sharp } = await import('sharp');
  const pics = (await Promise.all(covers.slice(0, 4).map((f) => openUpright(f).catch(() => null)))).filter((p): p is NonNullable<typeof p> => !!p && p.width > 0 && p.height > 0);
  if (!pics.length) throw new Error('The cover of this story could not be read.');
  const pad = Math.round(Math.min(W, H) * 0.06), gap = Math.round(Math.min(W, H) * 0.012), fs = Math.round(Math.min(W, H) * 0.062), small = Math.round(fs * 0.46);
  const textW = W - pad * 2, lines = title.trim() ? wrap(title, Math.max(8, Math.floor((textW - fs) / (fs * 0.5))), 3) : [];
  // with no title and no line there is no panel at all, and the pictures take the room
  const panelH = lines.length || line ? Math.round((lines.length ? fs * 0.7 : small * 0.6) + lines.length * fs * 1.16 + (line ? small * 2.1 : 0) + fs * 0.45) : 0, panelY = H - pad - panelH;
  const boxW = W - pad * 2, boxH = panelY - pad * (panelH ? 2 : 1);
  const cells = coverLayout(pics.map((p) => p.width / p.height), boxW, boxH, gap);
  const parts = await Promise.all(pics.map(async (p, i) => { const c = cells[i]!; const r = await p.img.clone().resize(c.w, c.h, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { input: r.data, raw: { width: r.info.width, height: r.info.height, channels: r.info.channels }, left: pad + c.x, top: pad + c.y }; }));
  const first = parts[0]!, bg = await backdrop(first.input, { raw: first.raw }, W, H, 0.42);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` + (panelH ? `<rect x="${pad}" y="${panelY}" width="${textW}" height="${panelH}" fill="#101112" fill-opacity="0.72"/>` : '');
  lines.forEach((l, i) => { svg += `<text x="${W / 2}" y="${Math.round(panelY + fs * 0.7 + fs * 0.82 + i * fs * 1.16)}" text-anchor="middle" font-family="Newsreader, Georgia, 'DejaVu Serif', serif" font-size="${fs}" fill="#f4f1ea">${xml(l)}</text>`; });
  if (line) svg += `<text x="${W / 2}" y="${Math.round(panelY + (lines.length ? fs * 0.7 : small * 0.6) + lines.length * fs * 1.16 + small * 1.5)}" text-anchor="middle" font-family="'DejaVu Sans', Helvetica, Arial, sans-serif" font-size="${small}" fill="#c9c6bf">${xml(line)}</text>`;
  await sharp(bg).composite([...parts, { input: Buffer.from(svg + '</svg>'), left: 0, top: 0 }]).jpeg({ quality: 93, chromaSubsampling: '4:4:4' }).toFile(out);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "March 4, 2024", "March 4 to 9, 2024", "March 4 to April 2, 2024" or "March 4, 2024 to January 2, 2025". */
export function daySpan(a: Date, b: Date): string {
  const day = (d: Date, year = true) => `${MONTHS[d.getMonth()]} ${d.getDate()}${year ? ', ' + d.getFullYear() : ''}`;
  if (a.toDateString() === b.toDateString()) return day(a);
  if (a.getFullYear() !== b.getFullYear()) return `${day(a)} to ${day(b)}`;
  return a.getMonth() === b.getMonth() ? `${MONTHS[a.getMonth()]} ${a.getDate()} to ${b.getDate()}, ${a.getFullYear()}` : `${day(a, false)} to ${day(b)}`;
}

async function probe(file: string) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: 8 << 20, timeout: 60_000 });
  const j = JSON.parse(stdout) as { streams?: { codec_type?: string }[]; format?: { duration?: string } };
  return { duration: Number(j.format?.duration ?? 0) || 0, audio: (j.streams ?? []).some((s) => s.codec_type === 'audio') };
}

/** Render a reel that was asked for. Never throws: a reel that cannot be made is marked failed, with the reason. */
export async function renderReel(ctx: Ctx, reelId: string) {
  const { db, cfg, storage } = ctx;
  const [reel] = await db.select().from(reels).where(eq(reels.id, reelId));
  if (!reel) return;
  const dir = path.join(cfg.tmpDir, `reel-${reel.id}`);
  const set = (v: Partial<typeof reels.$inferInsert>) => db.update(reels).set(v).where(eq(reels.id, reel.id));
  try {
    // A reel is made from a story, or from pictures chosen in the library. Either way: a title, covers, and pictures in order.
    const story = reel.storyId ? (await db.select().from(stories).where(eq(stories.id, reel.storyId)))[0] : null;
    const size = REEL_SIZES[reel.format];
    if ((reel.storyId && !story) || !size) throw new Error('The story this reel was for is gone.');
    const [W, H] = size, title = story ? story.title : reel.title, coverIds = story ? [...story.coverIds, story.coverItemId] : reel.coverIds, home = story ? story.id : `library/${reel.spaceId}`;
    await set({ status: 'running', progress: 0, error: null });
    await fsp.rm(dir, { recursive: true, force: true }); await fsp.mkdir(dir, { recursive: true });

    // The story's pictures in the order they are told: the author's sections, or by date.
    type Row = { id: string; kind: string; mime: string; fileName: string; origKey: string; fullKey: string | null; displayKey: string | null; takenAt: Date };
    const manual = story ? (await db.select({ id: storySections.id }).from(storySections).where(eq(storySections.storyId, story.id)).orderBy(asc(storySections.position)).limit(1)).length > 0 : false;
    // From the library: the chosen pictures that are still there, oldest first.
    const rows = !story ? (reel.itemIds.length ? (await db.execute(sql`
      select i.id, i.kind, i.mime, i.file_name as "fileName", i.orig_key as "origKey", i.full_key as "fullKey", i.display_key as "displayKey", i.taken_at as "takenAt"
      from items i where i.id in (${sql.join(reel.itemIds.map((x) => sql`${x}::uuid`), sql`, `)}) and i.space_id = ${reel.spaceId}::uuid and i.deleted_at is null and i.status = 'ready'
      order by i.taken_at, i.id`)).rows as Row[] : []) : (await db.execute(sql`
      select i.id, i.kind, i.mime, i.file_name as "fileName", i.orig_key as "origKey", i.full_key as "fullKey", i.display_key as "displayKey", i.taken_at as "takenAt"
      from story_items si join items i on i.id = si.item_id left join story_sections ss on ss.id = si.section_id
      where si.story_id = ${story!.id}::uuid and i.deleted_at is null and i.status = 'ready'
      order by ${manual ? sql`ss.position nulls last, si.position` : sql`i.taken_at`}, i.id`)).rows as Row[];
    if (!rows.length) throw new Error(story ? 'There are no pictures in this story to make a reel from.' : 'There are no pictures left to make this reel from.');
    if (rows.length > cfg.REEL_MAX_ITEMS) throw new Error(story ? `This story has ${rows.length} items. A reel takes up to ${cfg.REEL_MAX_ITEMS}. Make a shorter story for it.` : `There are ${rows.length} items chosen. A reel takes up to ${cfg.REEL_MAX_ITEMS}.`);

    const hold = Math.min(10, Math.max(1.5, reel.secondsPerPhoto)), parts: string[] = [];
    let total = 0;
    {
      // The card. Its covers are the ones the author chose, as far as they are still in the story, or else the first picture.
      const byId = new Map(rows.map((r) => [r.id, r])), chosen = coverIds.map((id) => (id ? byId.get(id) : undefined)).filter((r): r is typeof rows[number] => !!r && !!r.displayKey);
      const covers = [...new Set(chosen)].slice(0, 4); if (!covers.length) { const f = rows.find((r) => r.displayKey); if (f) covers.push(f); }
      if (covers.length) {
        const files: string[] = [];
        for (const [k, c] of covers.entries()) { const f = path.join(dir, `cover-${k}${path.extname(c.displayKey!) || '.webp'}`); await storage.toFile(c.displayKey!, f); files.push(f); }
        const times = rows.map((r) => new Date(r.takenAt).getTime()).filter(Number.isFinite), about = `${rows.length} ${rows.length === 1 ? 'item' : 'items'}` + (times.length ? `, ${daySpan(new Date(Math.min(...times)), new Date(Math.max(...times)))}` : '');
        const card = path.join(dir, 'card.jpg'), seg = path.join(dir, 'seg-card.mp4'), d = Math.max(hold, CARD_MIN_SECONDS);
        await composeCard(files, title, about, W, H, card);
        // No fade in: the first frame of the file is the card in full.
        await ff(['-loop', '1', '-framerate', String(FPS), '-t', d.toFixed(3), '-i', card, '-f', 'lavfi', '-t', d.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
          '-vf', `fade=t=out:st=${(d - FADE).toFixed(3)}:d=${FADE},setsar=1`, '-map', '0:v', '-map', '1:a', '-t', d.toFixed(3), ...ENC, seg]);
        for (const f of [...files, card]) await fsp.rm(f, { force: true });
        parts.push(seg); total += d;
      }
    }
    for (const [k, it] of rows.entries()) {
      const key = it.kind === 'video' ? it.origKey : it.fullKey ?? it.origKey;
      const src = path.join(dir, `src-${k}${path.extname(key) || path.extname(it.fileName) || '.bin'}`), seg = path.join(dir, `seg-${String(k).padStart(4, '0')}.mp4`);
      await storage.toFile(key, src);
      if (it.kind === 'video') {
        const info = await probe(src), d = Math.min(info.duration || hold, cfg.REEL_VIDEO_MAX_SECONDS), fo = Math.max(0, d - FADE);
        const bw = even(W / 8), bh = even(H / 8);
        const graph = `[0:v]split=2[a][b];[a]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=5:2,scale=${W}:${H}:flags=bicubic,eq=brightness=-0.2[bg];` +
          `[b]scale=${even(W * 0.96)}:${even(H * 0.96)}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg];` +
          `[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${FPS},fade=t=in:st=0:d=${FADE},fade=t=out:st=${fo.toFixed(3)}:d=${FADE},setsar=1[v]`;
        const audio = info.audio ? ['-map', '0:a:0', '-af', `aresample=48000,afade=t=in:st=0:d=${FADE},afade=t=out:st=${fo.toFixed(3)}:d=${FADE}`] : ['-map', '1:a:0'];
        await ff(['-t', d.toFixed(3), '-i', src, ...(info.audio ? [] : ['-f', 'lavfi', '-t', d.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']), '-filter_complex', graph, '-map', '[v]', ...audio, '-t', d.toFixed(3), ...ENC, seg]);
        total += d;
      } else {
        const frame = path.join(dir, `frame-${k}.jpg`);
        await composeFrame(src, W, H, frame);
        await ff(['-loop', '1', '-framerate', String(FPS), '-t', hold.toFixed(3), '-i', frame, '-f', 'lavfi', '-t', hold.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
          '-vf', `fade=t=in:st=0:d=${FADE},fade=t=out:st=${(hold - FADE).toFixed(3)}:d=${FADE},setsar=1`, '-map', '0:v', '-map', '1:a', '-t', hold.toFixed(3), ...ENC, seg]);
        await fsp.rm(frame, { force: true });
        total += hold;
      }
      await fsp.rm(src, { force: true });
      parts.push(seg);
      await set({ progress: Math.min(0.9, ((k + 1) / rows.length) * 0.9) });
    }

    const list = path.join(dir, 'list.txt'), joined = path.join(dir, 'joined.mp4'), out = path.join(dir, 'reel.mp4');
    await fsp.writeFile(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    await ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
    if (reel.music) {
      const track = await musicFile(ctx, reel.music), mus = path.join(dir, `music${path.extname(track.key) || '.m4a'}`);
      await storage.toFile(track.key, mus);
      const end = Math.max(0, total - 2.5);
      // The videos' own sound pushes the music down while it lasts. On the photos there is nothing to push it, so it plays at full level.
      const graph = `[1:a]aresample=48000,volume=0.85,afade=t=in:st=0:d=1.2,afade=t=out:st=${end.toFixed(3)}:d=2.5[m];[0:a]asplit=2[voice][key];` +
        `[m][key]sidechaincompress=threshold=0.015:ratio=14:attack=120:release=1400:makeup=1[under];[under][voice]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`;
      await ff(['-i', joined, '-stream_loop', '-1', '-i', mus, '-filter_complex', graph, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', total.toFixed(3), '-movflags', '+faststart', out]);
    } else await ff(['-i', joined, '-c', 'copy', '-movflags', '+faststart', out]);

    const key = `reels/${home}/${reel.id}.mp4`, info = await probe(out);
    await storage.putFile(key, out, 'video/mp4');
    await set({ status: 'ready', progress: 1, key, bytes: (await fsp.stat(out)).size, duration: info.duration || total, error: null });
  } catch (e: any) {
    ctx.log.warn({ err: e, reel: reel.id }, 'a reel could not be made');
    const said = String(e?.stderr || e?.message || e).trim().split('\n').filter(Boolean).pop() ?? '';
    const reason = e?.killed ? 'It took too long and was stopped.' : /^(There are|This story has|The story this)/.test(String(e?.message)) ? String(e.message) : `The video could not be put together. ${said.slice(0, 240)}`;
    await set({ status: 'failed', error: reason }).catch(() => {});
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
