import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/index.js';

const run = promisify(execFile);
const { items, jobs } = schema;

/**
 * A copy every browser can play.
 *
 * The original of a video is never changed, and some originals do not play in a browser: iPhone video is often
 * HEVC, and MKV and AVI files can hold almost anything. So each video is looked at once, and gets one of four answers:
 *
 *   none     H.264 video, 8-bit 4:2:0, with AAC sound or none, in an MP4 or MOV file. It plays as it is.
 *   remux    The video and sound are fine and only the file around them is not. Repackaged without re-encoding. Seconds.
 *   audio    The video is fine and the sound is not (cameras often write uncompressed sound). The video is copied
 *            as it is and only the sound is made into AAC. Seconds.
 *   encode   Anything else. A new H.264 file is made: same shape, never cropped or padded, the long edge at most
 *            VIDEO_COPY_MAX_EDGE, upright, HDR tone-mapped to ordinary video so it is not grey and washed out.
 *
 * The copy is stored at video/{year}/{month}/{item id}.mp4 and served as the file kind "play".
 * items.play_status: null (not looked at yet), none, queued, making, ready, failed.
 */
export type PlayPlan = 'none' | 'remux' | 'audio' | 'encode';
export interface PlayLook { plan: PlayPlan; hdr: string | null; why: string; duration: number }

const HDR: Record<string, string> = { smpte2084: 'smpte2084', 'arib-std-b67': 'arib-std-b67' };

export async function lookAtVideo(file: string, mode: 'auto' | 'always' | 'never'): Promise<PlayLook> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: 8 << 20, timeout: 60_000 });
  const j = JSON.parse(stdout) as { streams?: any[]; format?: { format_name?: string; duration?: string } };
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic), a = (j.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('There is no video in this file.');
  const duration = Number(j.format?.duration ?? 0) || 0, hdr = HDR[String(v.color_transfer ?? '')] ?? null;
  if (mode === 'never') return { plan: 'none', hdr, why: 'copies are turned off', duration };
  const okVideo = v.codec_name === 'h264' && ['yuv420p', 'yuvj420p'].includes(v.pix_fmt) && !hdr;
  const okAudio = !a || a.codec_name === 'aac', okBox = /\b(mp4|mov)\b/.test(String(j.format?.format_name ?? ''));
  if (mode === 'always') return { plan: 'encode', hdr, why: 'copies are made of every video', duration };
  if (!okVideo) return { plan: 'encode', hdr, why: hdr ? 'it is HDR video' : `its video is ${v.codec_name}${v.codec_name === 'h264' ? ' in ' + v.pix_fmt : ''}`, duration };
  if (!okAudio) return { plan: 'audio', hdr, why: `its sound is ${a.codec_name}`, duration };
  if (!okBox) return { plan: 'remux', hdr, why: `it is a ${String(j.format?.format_name).split(',')[0]} file`, duration };
  return { plan: 'none', hdr, why: 'it plays as it is', duration };
}

/** The ffmpeg arguments for one plan. Local files only: no network protocol is allowed in, so a crafted file cannot make the server fetch anything. */
export function playArgs(look: PlayLook, src: string, out: string, maxEdge: number): string[] {
  const head = ['-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_chapters', '-1'];
  const tail = ['-movflags', '+faststart', '-f', 'mp4', out], aac = ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'];
  if (look.plan === 'remux') return [...head, '-c', 'copy', ...tail];
  if (look.plan === 'audio') return [...head, '-c:v', 'copy', ...aac, ...tail];
  const M = Math.max(320, Math.round(maxEdge / 2) * 2);
  // Same shape, both sides even, never larger than it was. ffmpeg has already turned the picture upright by this point.
  const vf = [`scale=w='if(gte(iw,ih),trunc(min(iw,${M})/2)*2,-2)':h='if(gte(iw,ih),-2,trunc(min(ih,${M})/2)*2)'`];
  // HDR to ordinary video: to linear light, down to the screen's range with a filmic curve, then back to the usual encoding.
  if (look.hdr) vf.push(`zscale=tin=${look.hdr}:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100`, 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  vf.push('format=yuv420p', 'setsar=1');
  return [...head, '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', ...aac, ...tail];
}

export function playKeyFor(itemId: string, takenAt: Date) {
  return `video/${takenAt.getUTCFullYear()}/${String(takenAt.getUTCMonth() + 1).padStart(2, '0')}/${itemId}.mp4`;
}

/** Put a video in line for its copy. Does nothing for one already waiting. */
export async function queuePlayCopy(ctx: Ctx, itemId: string) {
  await ctx.db.update(items).set({ playStatus: 'queued', playError: null, updatedAt: new Date() }).where(eq(items.id, itemId));
  const waiting = await ctx.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.type, 'playcopy'), eq(jobs.itemId, itemId), or(eq(jobs.status, 'queued'), eq(jobs.status, 'running'))));
  if (!waiting.length) await ctx.db.insert(jobs).values({ type: 'playcopy', itemId, payload: {} });
}

/** Line up every video that has not been looked at, or whose copy failed. Returns how many. */
export async function queueMissingPlayCopies(ctx: Ctx): Promise<number> {
  if (ctx.cfg.VIDEO_COPY === 'never') return 0;
  const rows = await ctx.db.select({ id: items.id }).from(items).where(and(eq(items.kind, 'video'), eq(items.status, 'ready'), isNull(items.deletedAt), or(isNull(items.playStatus), eq(items.playStatus, 'failed'))));
  for (const r of rows) await queuePlayCopy(ctx, r.id);
  if (rows.length) ctx.kick();
  return rows.length;
}

/**
 * Look at one video and make its copy if it needs one. `local` is the original on this machine when the caller
 * already has it. Never throws and never touches the item's own status: a copy that cannot be made is noted on the
 * item with its reason, and the original stays there to try or download.
 */
export async function makePlayCopy(ctx: Ctx, itemId: string, local?: string) {
  const { db, cfg, storage } = ctx;
  const [it] = await db.select().from(items).where(eq(items.id, itemId));
  if (!it || it.kind !== 'video' || it.deletedAt) return;
  const set = (v: Partial<typeof items.$inferInsert>) => db.update(items).set({ ...v, updatedAt: new Date() }).where(eq(items.id, it.id));
  const stem = path.join(cfg.tmpDir, `play-${it.id}-${crypto.randomBytes(4).toString('hex')}`), out = `${stem}.mp4`;
  let src = local, fetched = false;
  try {
    await fsp.mkdir(cfg.tmpDir, { recursive: true });
    await set({ playStatus: 'making', playError: null });
    if (!src) { src = `${stem}-src${path.extname(it.fileName) || '.bin'}`; fetched = true; await storage.toFile(it.origKey, src); }
    let look = await lookAtVideo(src, cfg.VIDEO_COPY);
    if (look.plan === 'none') { if (it.playKey) await storage.remove([it.playKey]); await set({ playStatus: 'none', playKey: null, bytesPlay: 0 }); return; }
    const limit = Math.max(600, cfg.VIDEO_COPY_TIMEOUT_MINUTES * 60) * 1000;
    const go = (l: PlayLook) => run('ffmpeg', playArgs(l, src!, out, cfg.VIDEO_COPY_MAX_EDGE), { timeout: limit, maxBuffer: 16 << 20 });
    try { await go(look); }
    catch (e: any) {
      // Repackaging can trip on an odd stream. A full re-encode handles what a plain copy cannot.
      if (look.plan === 'encode' || e?.killed) throw e;
      look = { ...look, plan: 'encode' }; await go(look);
    }
    const bytes = (await fsp.stat(out)).size;
    if (bytes < 1000) throw new Error('The copy came out empty.');
    const key = playKeyFor(it.id, it.takenAt);
    await storage.putFile(key, out, 'video/mp4');
    await set({ playStatus: 'ready', playKey: key, bytesPlay: bytes, playError: null });
  } catch (e: any) {
    ctx.log.warn({ err: e, item: it.id }, 'a playable copy could not be made');
    const said = String(e?.stderr || e?.message || e).trim().split('\n').filter(Boolean).pop() ?? '';
    await set({ playStatus: 'failed', playError: (e?.killed ? 'Making the copy took too long and was stopped.' : `The copy could not be made. ${said}`).slice(0, 400) }).catch(() => {});
  } finally {
    await fsp.rm(out, { force: true }).catch(() => {});
    if (fetched && src) await fsp.rm(src, { force: true }).catch(() => {});
  }
}

/** For the settings page: how the copies stand. */
export async function playCopyCounts(ctx: Ctx) {
  const [r] = await ctx.db.select({
    videos: sql<number>`count(*)::int`, copies: sql<number>`count(*) filter (where ${items.playStatus} = 'ready')::int`,
    waiting: sql<number>`count(*) filter (where ${items.playStatus} in ('queued','making'))::int`, failed: sql<number>`count(*) filter (where ${items.playStatus} = 'failed')::int`,
    unknown: sql<number>`count(*) filter (where ${items.playStatus} is null and ${items.status} = 'ready')::int`, bytes: sql<number>`coalesce(sum(${items.bytesPlay}),0)::float8`,
  }).from(items).where(and(eq(items.kind, 'video'), isNull(items.deletedAt)));
  return { mode: ctx.cfg.VIDEO_COPY, maxEdge: ctx.cfg.VIDEO_COPY_MAX_EDGE, ...r! };
}
