import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { need, needCap } from '../auth/core.js';
import { type Ctx, HttpError, bad, forbidden, notFound } from '../context.js';
import { schema } from '../db/index.js';
import { TRACKS, render, wav } from '../media/music.js';
import { sendStored } from './items.js';

const run = promisify(execFile);
const { musicTracks, settings } = schema;

/**
 * Music for slideshows and reels. Two kinds, named by one string:
 *   "builtin:<name>"  one of the ten pieces the server composes itself (src/server/media/music.ts)
 *   a music_tracks id a file somebody uploaded
 * A built-in piece is rendered the first time it is asked for, which takes a few seconds, and kept in storage after that.
 */
/** Raise this when the built-in pieces change. They are then rendered afresh, and browsers fetch them again instead of playing an old copy. */
export const MUSIC_VERSION = 5;
const VERSION = MUSIC_VERSION;
const AUDIO: Record<string, string> = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.flac': 'audio/flac' };
const MAX_MUSIC_MB = 80;
const making = new Map<string, Promise<string>>();

async function builtinKey(ctx: Ctx, id: string): Promise<string> {
  if (!TRACKS.some((t) => t.id === id)) throw notFound('There is no built-in track by that name.');
  const key = `music/builtin/v${VERSION}/${id}.m4a`, mark = `music:${key}`;
  const [done] = await ctx.db.select().from(settings).where(eq(settings.key, mark));
  if (done) return key;
  // Two requests for the same piece at once share one render.
  let job = making.get(key);
  if (!job) {
    job = (async () => {
      await fsp.mkdir(ctx.cfg.tmpDir, { recursive: true });
      const stem = path.join(ctx.cfg.tmpDir, `music-${id}-${crypto.randomBytes(4).toString('hex')}`);
      try {
        const { pcm, seconds } = render(id);
        await fsp.writeFile(`${stem}.wav`, wav(pcm));
        await run('ffmpeg', ['-v', 'error', '-y', '-i', `${stem}.wav`, '-c:a', 'aac', '-b:a', '176k', '-movflags', '+faststart', `${stem}.m4a`]);
        await ctx.storage.putFile(key, `${stem}.m4a`, 'audio/mp4');
        await ctx.db.insert(settings).values({ key: mark, value: { seconds, made: Date.now() } }).onConflictDoNothing();
      } finally { await fsp.rm(`${stem}.wav`, { force: true }); await fsp.rm(`${stem}.m4a`, { force: true }); }
      return key;
    })().finally(() => making.delete(key));
    making.set(key, job);
  }
  return job;
}

/** Is this the name of a track that exists? Does not render anything. */
export async function musicExists(ctx: Ctx, ref: string): Promise<boolean> {
  if (ref.startsWith('builtin:')) return TRACKS.some((t) => t.id === ref.slice(8));
  if (!z.string().uuid().safeParse(ref).success) return false;
  return (await ctx.db.select({ id: musicTracks.id }).from(musicTracks).where(eq(musicTracks.id, ref))).length > 0;
}
/** Where a track's file is in storage, rendering a built-in piece first if this is the first time it is wanted. */
export async function musicFile(ctx: Ctx, ref: string): Promise<{ key: string; type: string; name: string }> {
  if (ref.startsWith('builtin:')) { const id = ref.slice(8), t = TRACKS.find((x) => x.id === id); return { key: await builtinKey(ctx, id), type: 'audio/mp4', name: t?.name ?? id }; }
  const [t] = z.string().uuid().safeParse(ref).success ? await ctx.db.select().from(musicTracks).where(eq(musicTracks.id, ref)) : [];
  if (!t) throw notFound('That track is gone. Choose another one.');
  return { key: t.key, type: t.mime, name: t.name };
}

export function registerMusic(app: FastifyInstance, ctx: Ctx) {
  const { db, cfg, storage } = ctx;

  app.get('/api/music', async (req) => {
    need(req);
    const mine = await db.select().from(musicTracks).orderBy(asc(musicTracks.name));
    return {
      builtin: TRACKS.map((t) => ({ id: `builtin:${t.id}`, name: t.name, mood: t.mood, energy: t.energy, bpm: t.bpm, seconds: t.seconds })),
      mine: mine.map((t) => ({ id: t.id, name: t.name, seconds: t.duration, bytes: t.bytes, by: t.addedBy })),
      maxMb: MAX_MUSIC_MB,
    };
  });

  app.get('/api/music/:ref/file', async (req: FastifyRequest, reply: FastifyReply) => {
    need(req);
    const f = await musicFile(ctx, decodeURIComponent((req.params as any).ref));
    return sendStored(ctx, req, reply, f.key, f.type, undefined, false);
  });

  /** Add a track of your own. The file is kept as it is. */
  app.post('/api/music', async (req) => {
    const me = needCap(req, 'edit');
    await fsp.mkdir(cfg.tmpDir, { recursive: true });
    let saved: { tmp: string; name: string; ext: string } | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'field' || saved) { if (part.type !== 'field') part.file.resume(); continue; }
      const name = path.basename(part.filename || 'music'), ext = path.extname(name).toLowerCase();
      const tmp = path.join(cfg.tmpDir, `music-up-${crypto.randomBytes(8).toString('hex')}${ext}`);
      await pipeline(part.file, fs.createWriteStream(tmp));
      saved = { tmp, name, ext };
    }
    if (!saved) throw bad('No file arrived.');
    try {
      if (!AUDIO[saved.ext]) throw new HttpError(415, 'That is not a music file this app can use. Use MP3, M4A, WAV, OGG or FLAC.');
      const bytes = (await fsp.stat(saved.tmp)).size;
      if (bytes > MAX_MUSIC_MB * 1024 * 1024) throw new HttpError(413, `That file is larger than the ${MAX_MUSIC_MB} MB limit for music.`);
      let duration: number | null = null;
      try {
        const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', saved.tmp], { maxBuffer: 4 << 20 });
        const j = JSON.parse(stdout) as { streams?: { codec_type?: string }[]; format?: { duration?: string } };
        if (!(j.streams ?? []).some((s) => s.codec_type === 'audio')) throw new Error('no audio');
        duration = j.format?.duration ? Number(j.format.duration) : null;
      } catch { throw new HttpError(415, 'That file could not be read as music. It may be damaged, or not audio at all.'); }
      const id = crypto.randomUUID(), key = `music/uploads/${id}${saved.ext}`;
      await storage.putFile(key, saved.tmp, AUDIO[saved.ext]!);
      const name = saved.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim().slice(0, 120) || 'Untitled';
      await db.insert(musicTracks).values({ id, name, key, mime: AUDIO[saved.ext]!, bytes, duration, addedBy: me.id });
      return { id, name, seconds: duration, bytes, by: me.id };
    } finally { await fsp.rm(saved.tmp, { force: true }); }
  });

  app.delete('/api/music/:id', async (req) => {
    const me = needCap(req, 'edit');
    const [t] = await db.select().from(musicTracks).where(eq(musicTracks.id, z.string().uuid().parse((req.params as any).id)));
    if (!t) throw notFound('That track is already gone.');
    if (!me.caps.admin && t.addedBy !== me.id) throw forbidden('Only the person who added a track, or an owner, can remove it.');
    await storage.remove([t.key]);
    await db.delete(musicTracks).where(eq(musicTracks.id, t.id));
    // Stories that used it go quiet rather than pointing at nothing.
    await db.update(schema.stories).set({ music: null }).where(eq(schema.stories.music, t.id));
    return { ok: true };
  });
}
