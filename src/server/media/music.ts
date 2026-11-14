/**
 * The built-in music: ten pieces the server writes out and plays itself, from still to driving.
 * Nothing is downloaded and no outside service is asked. The sound engine is synth.ts. This file is the
 * music: for each piece its tempo, its chords, a bass line, a drum pattern and a melody written out note
 * by note, and how the instruments come and go over its length. A piece ends where it begins, so it loops.
 *
 * Every piece has the same shape, 36 bars long:
 *   intro (4 bars), first part (8), second part (8), a quiet middle (4), the full part (8), and a way out (4).
 *
 * render(id) returns 16-bit stereo PCM at 44.1 kHz. The caller turns that into a file (see routes/music.ts).
 */
import {
  type Chord, type Finish, type HatKind, type KickKind, type SnareKind, type St, Mix, SR, chord, epiano, fmBass, glass, hat, impact, kick, mallet, mtof,
  perc, riser, rng, snare, subBass, vinyl, voice, voicing,
} from './synth.js';

export { SR };
export interface Track { id: string; name: string; mood: string; energy: 1 | 2 | 3 | 4 | 5; bpm: number }
const BARS = 36;
type Part = 'intro' | 'a' | 'b' | 'mid' | 'c' | 'out';
/** which part a bar belongs to, and how far into that part it is */
const where = (bar: number): [Part, number] => (bar < 4 ? ['intro', bar] : bar < 12 ? ['a', bar - 4] : bar < 20 ? ['b', bar - 12] : bar < 24 ? ['mid', bar - 20] : bar < 32 ? ['c', bar - 24] : ['out', bar - 32]);

/* ---------- patches: the sounds the pieces are played with ---------- */

const f = mtof;
/** A wide, slow pad: several detuned saws that open up over the length of the chord. */
const pad = (m: number, gate: number, bright = 1, seed = 1) => voice({ f: f(m), gate, uni: 5, det: 15, width: 0.85, cut: 420 * bright, env: 1200 * bright, fa: gate * 0.45, fd: gate, fs: 0.7, q: 0.7, a: Math.min(1.1, gate * 0.3), d: 1, s: 0.9, r: 1.0, vel: 0.3, seed });
/** A pad that swells in like a brass section, for the night-drive piece. */
const swell = (m: number, gate: number, seed = 1) => voice({ f: f(m), gate, uni: 5, det: 12, width: 0.8, cut: 380, env: 2500, fa: 0.22, fd: 1.4, fs: 0.55, q: 0.8, a: 0.05, d: 1, s: 0.85, r: 0.5, vel: 0.3, seed });
/** A big chord stab: seven saws, open at the front and closing fast. */
const stab = (m: number, gate: number, bright = 1, seed = 1) => voice({ f: f(m), gate, uni: 7, det: 22, width: 1, cut: 700, env: 5200 * bright, fd: 0.24, fs: 0.3, q: 0.8, a: 0.004, d: 0.3, s: 0.6, r: 0.16, vel: 0.3, seed });
/** A short, bright pluck that closes at once, for arpeggios. */
const pluck = (m: number, bright = 1, seed = 1) => voice({ f: f(m), gate: 0.11, wave: 'saw', uni: 2, det: 9, width: 0.5, cut: 240, env: 3600 * bright, fd: 0.16, q: 1.3, poles: 4, a: 0.002, d: 0.26, s: 0, r: 0.22, track: 0.35, seed });
/** A rubbery analog bass. */
const sawBass = (m: number, gate: number, bright = 1) => { const v = voice({ f: f(m), gate, wave: 'saw', uni: 2, det: 7, cut: 140, env: 1250 * bright, fd: 0.13, q: 1.5, poles: 4, sub: 0.55, a: 0.003, d: 0.25, s: 0.75, r: 0.05, drive: 1.5 }); return v.l.map((x, i) => (x + v.r[i]!) * 0.5); };
/** A singing lead that slides from the note before and wavers once it has landed. */
const lead = (m: number, gate: number, from?: number) => voice({ f: f(m), gate, wave: 'saw', uni: 3, det: 10, width: 0.35, cut: 1250, env: 2300, fd: 0.45, fs: 0.55, q: 1, a: 0.012, d: 0.5, s: 0.85, r: 0.22, vib: 13, glideFrom: from ? f(from) : undefined, glideT: 0.07 });
/** A soft, flute-like voice for the calm pieces. */
const whistle = (m: number, gate: number, from?: number) => voice({ f: f(m), gate, wave: 'tri', cut: 2600, q: 0.7, a: 0.035, d: 0.4, s: 0.9, r: 0.28, vib: 11, vibDelay: 0.22, glideFrom: from ? f(from) : undefined, glideT: 0.05 });
/** A bright, bouncy lead from a narrow pulse wave. */
const chip = (m: number, gate: number) => voice({ f: f(m), gate, wave: 'pulse', pw: 0.32, uni: 2, det: 6, width: 0.3, cut: 900, env: 3200, fd: 0.2, fs: 0.4, q: 1, a: 0.004, d: 0.3, s: 0.7, r: 0.14, vib: 8 });
/** A funky clavinet-like scratch. */
const clav = (m: number, gate: number) => voice({ f: f(m), gate, wave: 'pulse', pw: 0.2, cut: 420, env: 3600, fd: 0.09, q: 2.1, a: 0.001, d: 0.15, s: 0, r: 0.05 });

/* ---------- what every piece needs: a drum kit, and ways to play chords, bass and arpeggios ---------- */

interface Kit { kick: Float32Array; snare: Float32Array; clap: Float32Array; rim: Float32Array; snap: Float32Array; ch: Float32Array[]; oh: Float32Array; ride: Float32Array; crash: Float32Array; shaker: Float32Array[]; conga: Float32Array[]; toms: Float32Array[] }
function kit(R: () => number, k: KickKind, s: SnareKind): Kit {
  const hats = (kind: HatKind, n: number) => Array.from({ length: n }, () => hat(kind, R));
  return { kick: kick(k, R), snare: snare(s, R), clap: snare('clap', R), rim: snare('rim', R), snap: snare('snap', R), ch: hats('closed', 4), oh: hat('open', R), ride: hat('ride', R), crash: hat('crash', R), shaker: hats('shaker', 4), conga: [perc(232, R), perc(176, R)], toms: [perc(190, R, true), perc(150, R, true), perc(118, R, true), perc(96, R, true)] };
}
interface Drums { kick?: string; snare?: string; clap?: string; rim?: string; snap?: string; ch?: string; oh?: string; ride?: string; shaker?: string; conga?: string }
/** One bar of drums from patterns like "x---x---x---x---". The kick's moments are remembered, for everything that ducks under it. */
function drums(m: Mix, K: Kit, bar: number, d: Drums, late = 0) {
  if (d.kick) m.lane(bar, d.kick, (s, v) => { const t = m.at(bar, s); m.add('kick', K.kick, t, v); m.kicks.push(t); });
  if (d.snare) m.lane(bar, d.snare, (s, v) => m.add('snare', K.snare, m.at(bar, s) + late, v));
  if (d.clap) m.lane(bar, d.clap, (s, v) => m.add('snare', K.clap, m.at(bar, s) + late * 0.5, v * 0.9, 0.08));
  if (d.rim) m.lane(bar, d.rim, (s, v) => m.add('snare', K.rim, m.at(bar, s) + late, v * 0.8, -0.15));
  if (d.snap) m.lane(bar, d.snap, (s, v) => m.add('snare', K.snap, m.at(bar, s) + late, v * 0.85, 0.12));
  if (d.ch) m.lane(bar, d.ch, (s, v) => m.add('hats', K.ch[Math.floor(m.R() * K.ch.length)]!, m.at(bar, s), v * (0.9 + m.R() * 0.2), 0.28));
  if (d.oh) m.lane(bar, d.oh, (s, v) => m.add('hats', K.oh, m.at(bar, s), v * 0.8, 0.28));
  if (d.ride) m.lane(bar, d.ride, (s, v) => m.add('hats', K.ride, m.at(bar, s), v * 0.5, -0.3));
  if (d.shaker) m.lane(bar, d.shaker, (s, v) => m.add('perc', K.shaker[Math.floor(m.R() * K.shaker.length)]!, m.at(bar, s), v * (0.85 + m.R() * 0.3), -0.32));
  if (d.conga) m.lane(bar, d.conga, (s, v, c) => m.add('perc', K.conga[c === 'o' ? 1 : 0]!, m.at(bar, s), v, c === 'o' ? 0.4 : 0.2));
}
/** The lowest note for a chord: its root, somewhere between the low E and the D above it. */
const low = (c: Chord) => 28 + ((c.root - 4 + 12) % 12);
/** A bass line for one bar: when (sixteenths), how long, and how far above the root. */
function bassLine(m: Mix, bar: number, c: Chord, notes: [number, number, number, number?][], play: (midi: number, seconds: number) => Float32Array) {
  for (const [s, len, up, vel] of notes) m.add('bass', play(low(c) + up, m.steps(len) * 0.92), m.at(bar, s), vel ?? 1);
}
/** A chord played as one, a little spread in time like fingers, on any group. */
function hit(m: Mix, group: string, bar: number, step: number, c: Chord, play: (midi: number, k: number) => St | Float32Array, o: { centre?: number; voices?: number; vel?: number; strum?: number; late?: number } = {}) {
  const ns = voicing(c, o.centre ?? 62, o.voices ?? 4);
  ns.forEach((n, k) => m.add(group, play(n, k), m.at(bar, step) + (o.late ?? 0) + k * (o.strum ?? 0), (o.vel ?? 1) * (k === ns.length - 1 ? 1 : 0.88), ns.length > 1 ? -0.45 + (k / (ns.length - 1)) * 0.9 : 0));
}
/** A chord one note at a time. order picks from the chord's notes, low to high. A number past the top goes up an octave. */
function arp(m: Mix, group: string, bar: number, c: Chord, order: number[], stepLen: number, play: (midi: number, k: number) => St | Float32Array, o: { centre?: number; voices?: number; vel?: number; accent?: number } = {}) {
  const ns = voicing(c, o.centre ?? 67, o.voices ?? 4), count = Math.floor(16 / stepLen);
  for (let k = 0; k < count; k++) { const ix = order[k % order.length]!; if (ix < 0) continue; const n = ns[ix % ns.length]! + 12 * Math.floor(ix / ns.length); m.add(group, play(n, k), m.at(bar, k * stepLen), (o.vel ?? 1) * (k % (o.accent ?? 4) === 0 ? 1 : 0.8), k % 2 ? 0.5 : -0.5); }
}
/** A written melody, one bar or more, with each note sliding from the one before where the voice can do that. */
function tune(m: Mix, group: string, bar: number, written: string, play: (midi: number, seconds: number, from?: number) => St | Float32Array, vel = 1, up = 0) {
  let prev: number | undefined;
  m.line(bar, written, (n, t, s) => { m.add(group, play(n + up, s * 0.96, prev), t, vel * (0.92 + m.R() * 0.16), 0.08); prev = n + up; });
}
/** The lift into a new part: noise that opens over the bar before it, and a cymbal with a low boom as it lands. */
function lift(m: Mix, K: Kit, bar: number, big: boolean) { m.add('fx', riser(m.barLen * (big ? 2 : 1), m.R), m.at(bar - (big ? 2 : 1), 0), big ? 1 : 0.7); m.add('hats', K.crash, m.at(bar, 0), 0.9, 0.1); if (big) m.add('fx', impact(m.R), m.at(bar, 0), 0.9); }
/** A snare roll that gets faster and louder over two bars, into the full part. */
function roll(m: Mix, K: Kit, bar: number) { for (let b = 0; b < 2; b++) for (let s = 0; s < 16; s += b ? 1 : 2) m.add('snare', K.snare, m.at(bar + b, s), 0.25 + 0.65 * ((b * 16 + s) / 32) ** 1.5); }

/* ---------- the ten pieces ---------- */

interface Piece extends Track { seed: number; swing?: number; write: (m: Mix) => Finish }
const loop = <T>(xs: T[], i: number) => xs[i % xs.length]!;
const chords = (names: string) => names.split(' ').map(chord);

const PIECES: Piece[] = [
  {
    id: 'still-water', name: 'Still water', mood: 'Calm and open, soft bells over a wide pad', energy: 1, bpm: 66, seed: 11,
    write(m) {
      const prog = chords('Dmaj9 Bm11 Gmaj9 A9sus4');
      const bells = ['f#5/6 ./2 a5/4 e5/4', 'd5/8 ./4 b4/4', 'b4/4 d5/4 f#5/6 ./2', 'e5/10 ./6', 'a5/6 ./2 f#5/4 e5/4', 'f#5/8 d5/4 b4/4', 'g5/6 f#5/2 d5/8', 'e5/4 c#5/4 a4/8'];
      for (let bar = 0; bar < BARS; bar++) {
        const [part, k] = where(bar), c = loop(prog, bar), full = part === 'c' || part === 'b';
        voicing(c, 59, 4).forEach((n, i) => m.add('pad', pad(n, m.barLen * 1.05, part === 'c' ? 1.5 : part === 'intro' ? 0.8 : 1.1, bar * 7 + i), m.at(bar, 0), 1));
        if (part === 'c') voicing(c, 71, 3).forEach((n, i) => m.add('pad', pad(n, m.barLen * 1.05, 1.3, bar * 5 + i), m.at(bar, 0), 0.45));
        if (part !== 'intro' && part !== 'mid') m.add('bass', subBass(f(low(c) + 12), m.barLen * 0.98), m.at(bar, 0), 1);
        if (part === 'a' || part === 'c' || part === 'out') tune(m, 'bell', bar, loop(bells, part === 'out' ? k : part === 'c' ? k + 4 : k), (n, s) => glass(f(n), s, 0.7), 1);
        if (part === 'intro' && k % 2 === 1) tune(m, 'bell', bar, k === 1 ? './8 a5/8' : './4 f#5/6 e5/6', (n, s) => glass(f(n), s, 0.6), 0.8);
        if (full || part === 'mid') arp(m, 'vibes', bar, c, part === 'mid' ? [0, -1, 2, -1, 1, -1, 3, -1] : [0, 2, 1, 3, 2, 3, 1, 2], 2, (n) => mallet(f(n), 0.6, 0.7, 'vibes', m.R), { centre: 66, vel: 0.9 });
        if (k === 0 && part !== 'intro') m.add('fx', riser(m.barLen, m.R, true), m.at(bar, 0), 0.5);
      }
      return { buses: { pad: { lvl: -22, rev: 0.6, chorus: [0.35, 3.4, 0.55], hp: 150 }, bass: { lvl: -24, mono: true, lp: 600 }, bell: { lvl: -24, rev: 0.75, del: 0.55, hp: 300 }, vibes: { lvl: -29, rev: 0.6, del: 0.3, hp: 250, trem: [4.6, 0.25] }, fx: { lvl: -34, by: 'peak', rev: 0.6, hp: 400 } }, rev: { size: 1.45, decay: 4.6, damp: 4200, pre: 0.03, lvl: -5 }, del: { beats: 1.5, fb: 0.45, lvl: -9 }, lufs: -17, warm: 1, pres: 1, air: 3 };
    },
  },
  {
    id: 'first-light', name: 'First light', mood: 'Gentle electric piano, slow and warm', energy: 1, bpm: 74, seed: 23,
    write(m) {
      const prog = chords('Amaj9 F#m9 Dmaj9 E9sus4'), K = kit(m.R, 'lofi', 'lofi');
      const vib = ['c#5/4 e5/4 b4/8', 'a4/4 c#5/4 e5/8', 'f#5/6 e5/2 d5/4 c#5/4', 'b4/12 ./4', 'e5/4 a5/4 g#5/8', 'f#5/4 e5/4 c#5/8', 'd5/4 f#5/4 a5/6 g#5/2', 'e5/12 ./4'];
      for (let bar = 0; bar < BARS; bar++) {
        const [part, k] = where(bar), c = loop(prog, bar), ns = voicing(c, 61, 4), quiet = part === 'intro' || part === 'mid' || part === 'out';
        // the piano rocks through the chord in eighths: low, up, and back
        const shape = [-1, 1, 2, 3, 2, 1, 2, 3];
        shape.forEach((ix, s) => { const n = ix < 0 ? low(c) + 24 : ns[ix]!; if (quiet && s % 2 === 1 && part !== 'mid') return; m.add('keys', epiano(f(n), m.steps(ix < 0 ? 6 : 3), (ix < 0 ? 0.78 : 0.6) * (0.9 + m.R() * 0.2)), m.at(bar, s * 2) + (m.R() - 0.5) * 0.012, 1, -0.3 + (ix + 1) * 0.15); });
        if (!quiet || part === 'mid') voicing(c, 60, 3).forEach((n, i) => m.add('pad', pad(n, m.barLen * 1.04, part === 'c' ? 1.2 : 0.9, bar * 3 + i), m.at(bar, 0), 1));
        if (!quiet) m.add('bass', subBass(f(low(c) + 12), m.barLen * 0.9), m.at(bar, 0), 1);
        if (part === 'b' || part === 'c') tune(m, 'vibes', bar, loop(vib, part === 'c' ? k + 4 : k), (n, s) => mallet(f(n), s, 0.75, 'vibes', m.R), 1);
        if (part === 'a' && k >= 4) tune(m, 'vibes', bar, loop(vib, k - 4), (n, s) => mallet(f(n), s, 0.6, 'vibes', m.R), 0.8);
        if (part === 'c') drums(m, K, bar, { shaker: 'x-g-x-g-x-g-x-g-', rim: '----x-------x---' });
      }
      return { buses: { keys: { lvl: -21, rev: 0.35, del: 0.12, trem: [4.3, 0.22], chorus: [0.5, 2.2, 0.35], hp: 90, lp: 10000 }, pad: { lvl: -29, rev: 0.5, chorus: [0.3, 3, 0.5], hp: 180 }, bass: { lvl: -25, mono: true, lp: 500 }, vibes: { lvl: -24, rev: 0.55, del: 0.3, hp: 250, trem: [4.9, 0.28] }, perc: { lvl: -30, by: 'peak', rev: 0.25 }, snare: { lvl: -26, by: 'peak', rev: 0.4 } }, rev: { size: 1.25, decay: 3.2, damp: 4600, pre: 0.02, lvl: -7 }, del: { beats: 0.75, fb: 0.35, lvl: -12 }, lufs: -17, warm: 1, pres: 3, air: 4.5 };
    },
  },
  {
    id: 'slow-road', name: 'Slow road', mood: 'Laid back, dusty drums and warm keys', energy: 2, bpm: 80, seed: 37, swing: 0.3,
    write(m) {
      const prog = chords('Dm9 G13 Cmaj9 Am9'), K = kit(m.R, 'lofi', 'lofi');
      const vib = ['f5/3 e5/3 c5/4 a4/6', 'b4/4 d5/4 e5/8', 'g5/3 e5/3 d5/2 b4/8', 'c5/4 ./4 e5/2 d5/2 c5/4', 'a5/4 f5/4 e5/8', 'd5/3 f5/3 e5/10', 'e5/2 g5/2 b5/4 a5/8', 'g5/4 e5/4 c5/8'];
      m.add('noise', vinyl(BARS * m.barLen, m.R), 0, 1);
      for (let bar = 0; bar < BARS; bar++) {
        const [part, k] = where(bar), c = loop(prog, bar), beat = part === 'a' || part === 'b' || part === 'c' || (part === 'out' && k < 2);
        hit(m, 'keys', bar, 0, c, (n) => epiano(f(n), m.steps(7), 0.74), { centre: 62, strum: 0.02, late: 0.012 });
        if (part !== 'intro') hit(m, 'keys', bar, 10, c, (n) => epiano(f(n), m.steps(3), 0.5), { centre: 62, strum: 0.014, late: 0.018, vel: 0.8 });
        if (k % 4 === 3 && beat) hit(m, 'keys', bar, 14, loop(prog, bar + 1), (n) => epiano(f(n), m.steps(1.5), 0.45), { centre: 62, vel: 0.6, late: 0.01 });
        if (beat) {
          bassLine(m, bar, c, k % 4 === 3 ? [[0, 5, 12], [7, 1, 12, 0.6], [10, 3, 19, 0.85], [14, 2, 24, 0.8]] : [[0, 5, 12], [7, 1, 12, 0.6], [10, 4, 19, 0.85]], (n, s) => subBass(f(n), s));
          drums(m, K, bar, { kick: k % 4 === 3 ? 'x-----x---x--x--' : 'x-----x---x-----', snare: k % 2 ? '----x--g----x---' : '----x-------x---', ch: part === 'a' ? 'x-m-x-m-x-m-x-m-' : 'x-m-x-mgx-m-x-mg' }, 0.014);
        }
        if (part === 'b' || part === 'c' || part === 'mid') tune(m, 'vibes', bar, loop(vib, part === 'c' ? k + 4 : k), (n, s) => mallet(f(n), s, 0.72, 'vibes', m.R), part === 'mid' ? 0.8 : 1);
        if (part === 'c') voicing(c, 60, 3).forEach((n, i) => m.add('pad', pad(n, m.barLen * 1.03, 0.9, bar + i), m.at(bar, 0), 1));
      }
      return { buses: { keys: { lvl: -21, rev: 0.22, wobble: true, trem: [3.6, 0.18], hp: 110, lp: 6500 }, bass: { lvl: -23, mono: true, lp: 420 }, kick: { lvl: -8, by: 'peak' }, snare: { lvl: -11, by: 'peak', rev: 0.2 }, hats: { lvl: -23, by: 'peak', lp: 9000 }, vibes: { lvl: -24, rev: 0.4, del: 0.25, wobble: true, hp: 250 }, pad: { lvl: -30, rev: 0.4, hp: 200, lp: 3500 }, noise: { lvl: -41 } }, rev: { size: 1, decay: 1.7, damp: 3600, lvl: -8 }, del: { beats: 0.75, fb: 0.3, lvl: -13 }, lufs: -16, warm: 0.5, pres: 2.5, air: 2.5, lp: 12000 };
    },
  },
  {
    id: 'golden-hour', name: 'Golden hour', mood: 'Warm and easy, soft plucks and a slow beat', energy: 2, bpm: 88, seed: 41, swing: 0.06,
    write(m) {
      const prog = chords('Gmaj7 Em7 Cmaj7 D69'), K = kit(m.R, 'lofi', 'lofi');
      const mel = ['b4/6 d5/2 g5/8', 'f#5/4 e5/4 b4/8', 'e5/6 g5/2 c6/4 b5/4', 'a5/12 ./4', 'd5/4 g5/4 b5/8', 'a5/4 g5/4 e5/8', 'g5/4 e5/4 c5/4 e5/4', 'd5/8 f#5/4 a5/4'];
      for (let bar = 0; bar < BARS; bar++) {
        const [part, k] = where(bar), c = loop(prog, bar), beat = part === 'a' || part === 'b' || part === 'c', bright = part === 'c' ? 1.25 : part === 'intro' || part === 'out' ? 0.6 : 0.95;
        arp(m, 'arp', bar, c, part === 'intro' || part === 'mid' ? [0, -1, 2, -1, 1, -1, 3, -1] : [0, 2, 1, 2, 3, 2, 1, 2], part === 'intro' || part === 'mid' ? 2 : 1, (n, i) => pluck(n, bright, bar * 16 + i), { centre: 67 });
        voicing(c, 60, 4).forEach((n, i) => m.add('pad', pad(n, m.barLen * 1.04, part === 'c' ? 1.3 : 1, bar * 9 + i), m.at(bar, 0), 1));
        if (beat) {
          bassLine(m, bar, c, k % 4 === 3 ? [[0, 3, 12], [3, 1, 12, 0.7], [8, 3, 12], [12, 2, 19, 0.8], [14, 2, 24, 0.8]] : [[0, 3, 12], [3, 1, 12, 0.7], [8, 3, 12], [12, 3, 19, 0.8]], (n, s) => fmBass(f(n), s, 0.9, 0.6));
          drums(m, K, bar, { kick: 'x-------x-x-----', rim: '----x-------x---', shaker: 'mgxgmgxgmgxgmgxg', ch: part === 'a' ? undefined : '--x---x---x---x-' });
        }
        if (part === 'c') tune(m, 'lead', bar, loop(mel, k), (n, s, p) => whistle(n, s, p), 1);
        if (part === 'b') hit(m, 'vibes', bar, 4, c, (n) => mallet(f(n), 0.5, 0.7, 'vibes', m.R), { centre: 74, voices: 2, strum: 0.03 });
        if (part === 'b' && k >= 4) tune(m, 'lead', bar, loop(mel, k - 4), (n, s, p) => whistle(n, s, p), 0.7);
      }
      return { buses: { arp: { lvl: -24, del: 0.5, rev: 0.3, hp: 220, duck: 0.15 }, pad: { lvl: -25, rev: 0.5, chorus: [0.4, 3, 0.5], hp: 160, duck: 0.2 }, bass: { lvl: -20, mono: true, lp: 900 }, kick: { lvl: -8, by: 'peak' }, snare: { lvl: -13, by: 'peak', rev: 0.35 }, hats: { lvl: -24, by: 'peak' }, perc: { lvl: -23, by: 'peak', rev: 0.15 }, lead: { lvl: -22, rev: 0.45, del: 0.35, hp: 300 }, vibes: { lvl: -27, rev: 0.5, del: 0.3, hp: 300 } }, rev: { size: 1.2, decay: 2.6, damp: 4800, pre: 0.02, lvl: -8 }, del: { beats: 0.75, fb: 0.4, lvl: -10 }, lufs: -16, warm: 0.5, pres: 3, air: 4.5 };
    },
  },
  {
    id: 'postcards', name: 'Postcards', mood: 'Sunny marimba over an island beat', energy: 3, bpm: 100, seed: 53,
    write(m) {
      const prog = chords('E C#m7 Aadd9 B'), K = kit(m.R, 'house', '909');
      const mel = ['g#5/3 b5/3 g#5/2 e5/4 f#5/4', 'g#5/6 e5/2 c#5/8', 'c#5/3 e5/3 a5/2 g#5/4 e5/4', 'f#5/8 d#5/4 b4/4', 'b5/3 g#5/3 e5/2 g#5/8', 'e5/3 g#5/3 c#6/2 b5/8', 'a5/3 g#5/3 e5/2 c#5/8', 'b4/3 d#5/3 f#5/2 b5/8'];
      for (let bar = 0; bar < BARS; bar++) {
        const [part, k] = where(bar), c = loop(prog, bar), beat = part === 'a' || part === 'b' || part === 'c', full = part === 'b' || part === 'c';
        if (k === 0 && (part === 'b' || part === 'c')) lift(m, K, bar, false);
        // the marimba plays the chord in the 3 + 3 + 2 rhythm that makes this kind of music sway
        for (const [s, v] of (part === 'intro' || part === 'out' ? [[0, 1], [6, 0.8], [10, 0.7]] : [[0, 1], [3, 0.75], [6, 0.9], [10, 0.8], [13, 0.7]]) as [number, number][]) hit(m, 'mallet', bar, s, c, (n) => mallet(f(n), 0.25, 0.8, 'marimba', m.R), { centre: 62, voices: 3, vel: v, strum: 0.006 });
        if (part !== 'intro') voicing(c, 60, 3).forEach((n, i) => m.add('pad', pad(n, m.barLen * 1.03, 1.1, bar * 3 + i), m.at(bar, 0), 1));
        if (beat) {
          bassLine(m, bar, c, [[0, 2, 12], [3, 2, 12, 0.85], [6, 1, 12, 0.8], [8, 2, 12], [11, 1, 24, 0.75], [14, 2, 19, 0.85]], (n, s) => fmBass(f(n), s, 0.9, 0.8));
          drums(m, K, bar, { kick: full ? 'x---x---x---x---' : 'x-------x-------', snap: '----x-------x---', shaker: 'mgxgmgxgmgxgmgxg', conga: full ? '--x--o----x-o-x-' : undefined, oh: part === 'c' ? '--x---x---x---x-' : undefined, clap: part === 'c' ? '----x-------x---' : undefined });
        }
        if (full) tune(m, 'lead', bar, loop(mel, part === 'c' ? k : k % 4), (n, s) => mallet(f(n), s, 0.85, 'kalimba', m.R), 1);
        if (part === 'c') tune(m, 'arp', bar, loop(mel, k), (n) => pluck(n, 0.9, bar), 1, 12);
        if (part === 'mid') arp(m, 'lead', bar, c, [0, 2, 1, 3, 2, 1, 3, 2], 2, (n) => mallet(f(n), 0.3, 0.7, 'kalimba', m.R), { centre: 76 });
      }
      return { buses: { mallet: { lvl: -22, rev: 0.3, hp: 130, duck: 0.12 }, pad: { lvl: -29, rev: 0.45, chorus: [0.45, 2.8, 0.5], hp: 200, duck: 0.3 }, bass: { lvl: -19, mono: true, lp: 1400, duck: 0.25 }, kick: { lvl: -7, by: 'peak' }, snare: { lvl: -11, by: 'peak', rev: 0.3 }, hats: { lvl: -22, by: 'peak' }, perc: { lvl: -19, by: 'peak', rev: 0.2 }, lead: { lvl: -21, rev: 0.4, del: 0.3, hp: 350 }, arp: { lvl: -30, del: 0.4, rev: 0.3, hp: 500 }, fx: { lvl: -22, by: 'peak', rev: 0.4, hp: 300 } }, rev: { size: 1.05, decay: 1.9, damp: 5200, lvl: -9 }, del: { beats: 0.75, fb: 0.32, lvl: -12 }, lufs: -15, pres: 2.5, air: 3 };
    },
  },
  {
    id: 'city-lights', name: 'City lights', mood: 'Night drive, glowing synths', energy: 3, bpm: 96, seed: 67,
    write(m) {
      const prog = chords('C#m Aadd9 E B'), K = kit(m.R, 'wave', 'gated');
      const mel = ['g#5/6 e5/2 c#5/8', 'e5/4 f#5/4 g#5/8', 'b5/6 g#5/2 e5/4 f#5/4', 'd#5/8 f#5/8', 'c#6/4 b5/4 g#5/8', 'a5/3 g#5/3 e5/2 c#5/8', 'e5/2 g#5/2 b5/4 e6/8', 'd#6/6 b5/2 f#5/8'];
      for (let bar = 0; bar < BARS; bar++) {
        const [part, k] = where(bar), c = loop(prog, bar), beat = part === 'a' || part === 'b' || part === 'c', full = part === 'b' || part === 'c';
        if (k === 0 && (part === 'a' || part === 'b' || part === 'c')) lift(m, K, bar, part === 'c');
        voicing(c, 61, 4).forEach((n, i) => m.add('pad', swell(n, m.barLen * 1.0, bar * 11 + i), m.at(bar, 0), part === 'intro' ? 0.7 : 1));
        if (part !== 'intro') arp(m, 'arp', bar, c, part === 'a' || part === 'out' ? [0, -1, 2, 1, -1, 3, 2, -1] : [0, 1, 2, 3, 2, 1, 2, 3, 4, 3, 2, 1, 2, 3, 2, 1], part === 'a' || part === 'out' ? 2 : 1, (n, i) => pluck(n, part === 'c' ? 1.2 : 0.9, bar * 16 + i), { centre: 69, voices: 3 });
        if (beat || part === 'mid') for (let s = 0; s < 16; s += 2) m.add('bass', sawBass(low(c) + 12 + (s === 6 || s === 14 ? 12 : 0), m.steps(2) * 0.72, part === 'mid' ? 0.6 : 1), m.at(bar, s), s % 4 === 0 ? 1 : 0.85);
        if (beat) drums(m, K, bar, { kick: 'x-------x-----x-', snare: '----x-------x---', ch: part === 'c' ? 'xgxgxgxgxgxgxgxg' : 'x-x-x-x-x-x-x-x-', oh: full ? '--------------x-' : undefined });
        if (beat && k % 4 === 3) [12, 13, 14, 15].forEach((s, i) => m.add('perc', K.toms[i]!, m.at(bar, s), 0.9, -0.4 + i * 0.27));
        if (full) tune(m, 'lead', bar, loop(mel, part === 'c' ? k : k % 4), (n, s, p) => lead(n, s, p), 1);
      }
      return { buses: { pad: { lvl: -23, rev: 0.45, chorus: [0.5, 3, 0.5], hp: 170, duck: 0.35 }, arp: { lvl: -26, del: 0.5, rev: 0.3, hp: 300, duck: 0.2 }, bass: { lvl: -19, mono: true, lp: 2400, duck: 0.3 }, kick: { lvl: -7, by: 'peak' }, snare: { lvl: -10, by: 'peak', rev: 0.5 }, hats: { lvl: -24, by: 'peak' }, perc: { lvl: -14, by: 'peak', rev: 0.4 }, lead: { lvl: -20, rev: 0.4, del: 0.4, hp: 300 }, fx: { lvl: -20, by: 'peak', rev: 0.4, hp: 250 } }, rev: { size: 1.3, decay: 2.9, damp: 5200, pre: 0.025, lvl: -8 }, del: { beats: 0.75, fb: 0.42, lvl: -10 }, lufs: -15, air: -0.5 };
    },
  },
  {
    id: 'open-windows', name: 'Open windows', mood: 'Light and bouncy', energy: 3, bpm: 108, seed: 71, swing: 0.08,
    write(m) {
      const prog = chords('Fmaj7 Dm7 Bbmaj7 C9sus4'), K = kit(m.R, 'house', '909');
      const mel = ['a5/2 c6/2 a5/2 f5/2 g5/4 a5/4', 'f5/3 e5/3 d5/2 f5/8', 'd5/2 f5/2 bb5/4 a5/4 f5/4', 'g5/6 e5/2 c5/8', 'c6/3 a5/3 f5/2 a5/8', 'a5/2 g5/2 f5/4 d5/8', 'bb5/3 a5/3 g5/2 f5/4 d5/4', 'e5/4 g5/4 c6/8'];
      for (let bar = 0; bar < BARS; bar++) {
        const [part, k] = where(bar), c = loop(prog, bar), beat = part === 'a' || part === 'b' || part === 'c', full = part === 'b' || part === 'c';
        if (k === 0 && (part === 'b' || part === 'c')) lift(m, K, bar, false);
        // the piano answers the beat: short chords on every "and"
        for (const s of part === 'intro' || part === 'out' ? [2, 10] : [2, 6, 10, 14]) hit(m, 'keys', bar, s, c, (n) => epiano(f(n), m.steps(1.4), 0.82), { centre: 64, strum: 0.004 });
        if (part === 'c' || part === 'mid') hit(m, 'keys', bar, 0, c, (n) => epiano(f(n), m.steps(part === 'mid' ? 12 : 2), 0.7), { centre: 64, strum: 0.012, vel: 0.85 });
        if (part !== 'intro') voicing(c, 60, 3).forEach((n, i) => m.add('pad', pad(n, m.barLen * 1.03, 1, bar * 5 + i), m.at(bar, 0), 1));
        if (beat) {
          bassLine(m, bar, c, [[0, 2, 12], [3, 1, 12, 0.8], [6, 2, 24, 0.85], [8, 1, 12], [10, 2, 12, 0.85], [14, 2, 19, 0.85]], (n, s) => fmBass(f(n), s, 0.9, 0.9));
          drums(m, K, bar, { kick: k % 4 === 3 ? 'x--x----x-x---x-' : 'x--x----x-x-----', snare: '----x-------x---', ch: 'x-x-x-x-x-x-x---', oh: '--------------x-', clap: part === 'c' ? '----x-------x---' : undefined, shaker: part === 'c' ? 'gmgxgmgxgmgxgmgx' : undefined });
        }
        if (part === 'a') hit(m, 'vibes', bar, k % 2 ? 12 : 4, c, (n) => mallet(f(n), 0.4, 0.7, 'vibes', m.R), { centre: 76, voices: 2, strum: 0.04 });
        if (full) tune(m, 'lead', bar, loop(mel, part === 'c' ? k : k % 4), (n, s) => chip(n, s), 1);
      }
      return { buses: { keys: { lvl: -21, rev: 0.25, chorus: [0.6, 2, 0.3], hp: 120, lp: 7500, duck: 0.15 }, pad: { lvl: -28, rev: 0.4, chorus: [0.45, 2.8, 0.5], hp: 200, duck: 0.3 }, bass: { lvl: -19, mono: true, lp: 1600, duck: 0.2 }, kick: { lvl: -7, by: 'peak' }, snare: { lvl: -10, by: 'peak', rev: 0.3 }, hats: { lvl: -21, by: 'peak' }, perc: { lvl: -24, by: 'peak' }, vibes: { lvl: -27, rev: 0.5, del: 0.3, hp: 300 }, lead: { lvl: -21, rev: 0.35, del: 0.35, hp: 350 }, fx: { lvl: -23, by: 'peak', rev: 0.4, hp: 300 } }, rev: { size: 1, decay: 1.7, damp: 5600, lvl: -9 }, del: { beats: 0.5, fb: 0.3, lvl: -12 }, lufs: -15, pres: 2, air: 2.5 };
    },
  },
  {
    id: 'boardwalk', name: 'Boardwalk', mood: 'Funky and playful', energy: 4, bpm: 114, seed: 83, swing: 0.12,
    write(m) {
      const prog = chords('Am7 D9 Fmaj7 Em7'), K = kit(m.R, 'house', '909');
      const mel = ['e5/2 g5/2 a5/4 ./2 c6/2 a5/4', 'f#5/3 a5/3 e5/2 d5/8', 'a5/2 c6/2 e6/4 d6/2 c6/2 a5/4', 'g5/4 b5/4 e5/8', 'c6/2 a5/2 g5/4 ./2 e5/2 g5/4', 'a5/3 f#5/3 d5/2 e5/8', 'e6/2 c6/2 a5/4 c6/2 d6/2 e6/4', 'd6/4 b5/4 g5/8'];
      for (let bar = 0; bar < BARS; bar++) {
        const [part, k] = where(bar), c = loop(prog, bar), beat = part === 'a' || part === 'b' || part === 'c', full = part === 'b' || part === 'c';
        if (k === 0 && (part === 'a' || part === 'b' || part === 'c')) lift(m, K, bar, false);
        hit(m, 'keys', bar, 0, c, (n) => epiano(f(n), m.steps(part === 'intro' || part === 'mid' ? 14 : 6), 0.7), { centre: 62, strum: 0.012 });
        // the clavinet scratches sixteenths around the beat, which is where the funk is
        if (part !== 'intro' && part !== 'mid') m.lane(bar, full ? 'x-xg-x-gx-g-xg-x' : '--x--x-g--x--g-x', (s, v) => hit(m, 'clav', bar, s, c, (n) => clav(n, v > 0.5 ? 0.075 : 0.04), { centre: 64, voices: 3, vel: v }));
        // the bass walks through the third, fourth and seventh of each chord, so they have to be that chord's own, and in the key of the piece (A minor, with B natural)
        const third = c.tones.includes(4) ? 4 : 3, sev = c.tones.includes(11) ? 11 : 10, fourth = (c.root + 5) % 12 === 10 ? 6 : 5;
        if (beat || part === 'mid') bassLine(m, bar, c, part === 'mid' ? [[0, 6, 12], [8, 4, 12], [14, 2, 19]] : [[0, 2, 12], [3, 1, 12, 0.8], [6, 1, 24, 0.9], [7, 1, 12 + sev, 0.75], [8, 2, 12], [11, 1, 12 + third, 0.8], [12, 1, 12 + fourth, 0.85], [14, 2, 19, 0.9]], (n, s) => fmBass(f(n), s, 0.92, 1.25));
        if (beat) drums(m, K, bar, { kick: 'x---x---x---x---', clap: '----x-------x---', ch: 'xgmgxgmgxgmgxgmg', oh: '--x---x---x---x-', conga: full ? 'x--x-gx---o-xg--' : undefined, ride: part === 'c' ? 'x---x---x---x---' : undefined });
        if (part === 'b') hit(m, 'vibes', bar, k % 2 ? 6 : 10, c, (n) => mallet(f(n), 0.35, 0.75, 'vibes', m.R), { centre: 76, voices: 2, strum: 0.03 });
        if (part === 'c' || (part === 'b' && k >= 4)) tune(m, 'lead', bar, loop(mel, part === 'c' ? k : k - 4), (n, s) => chip(n, s), part === 'c' ? 1 : 0.8);
      }
      return { buses: { keys: { lvl: -23, rev: 0.25, trem: [5.2, 0.2], chorus: [0.6, 2, 0.3], hp: 140, lp: 7000, duck: 0.2 }, clav: { lvl: -24, rev: 0.15, hp: 350, duck: 0.1 }, bass: { lvl: -18, mono: true, lp: 2200, duck: 0.2 }, kick: { lvl: -7, by: 'peak' }, snare: { lvl: -10, by: 'peak', rev: 0.3 }, hats: { lvl: -20, by: 'peak' }, perc: { lvl: -19, by: 'peak', rev: 0.15 }, vibes: { lvl: -27, rev: 0.45, del: 0.3, hp: 300 }, lead: { lvl: -21, rev: 0.3, del: 0.35, hp: 350 }, fx: { lvl: -23, by: 'peak', rev: 0.4, hp: 300 } }, rev: { size: 0.95, decay: 1.5, damp: 5600, lvl: -10 }, del: { beats: 0.75, fb: 0.3, lvl: -12 }, lufs: -14.5, air: 2.5 };
    },
  },
  {
    id: 'summit', name: 'Summit', mood: 'Uplifting, big and bright', energy: 4, bpm: 124, seed: 97,
    write(m) {
      const prog = chords('D A Bm7 Gadd9'), K = kit(m.R, 'house', '909');
      const mel = ['f#5/4 a5/4 d6/6 a5/2', 'c#6/4 b5/4 a5/8', 'd6/4 f#6/4 e6/4 d6/4', 'b5/8 d6/4 e6/4', 'f#6/6 e6/2 d6/8', 'e6/4 c#6/4 a5/8', 'b5/2 d6/2 f#6/4 a6/8', 'g6/6 f#6/2 d6/8'];
      for (let bar = 0; bar < BARS; bar++) {
        const [part, k] = where(bar), c = loop(prog, bar), beat = part === 'a' || part === 'b' || part === 'c', full = part === 'b' || part === 'c';
        if (k === 0 && (part === 'a' || part === 'b')) lift(m, K, bar, false);
        if (k === 0 && part === 'c') lift(m, K, bar, true);
        if (part === 'mid' && k === 2) roll(m, K, bar);
        // the chords land in a pushed rhythm and duck hard under the kick: that pumping is the sound of this style
        if (part === 'intro' || part === 'mid' || part === 'out') voicing(c, 62, 4).forEach((n, i) => m.add('pad', pad(n, m.barLen * 1.04, part === 'mid' ? 0.9 + k * 0.35 : 1, bar * 3 + i), m.at(bar, 0), 1));
        else for (const s of [0, 3, 6, 8, 11, 14]) hit(m, 'stab', bar, s, c, (n, i) => stab(n, m.steps(s === 8 || s === 0 ? 2.2 : 1.6), part === 'c' ? 1.15 : part === 'b' ? 0.9 : 0.7, bar * 20 + s + i), { centre: 64, voices: 4 });
        arp(m, 'arp', bar, c, part === 'intro' || part === 'out' ? [0, -1, 2, -1, 1, -1, 3, -1] : [0, 1, 2, 3, 4, 3, 2, 1], 1, (n, i) => pluck(n, part === 'c' ? 1.3 : part === 'mid' ? 0.7 + k * 0.2 : 0.95, bar * 16 + i), { centre: 74, voices: 3 });
        if (beat) {
          for (const s of [2, 6, 10, 14]) m.add('bass', sawBass(low(c) + 12, m.steps(2) * 0.8, part === 'c' ? 1.2 : 1), m.at(bar, s), 1);
          if (part === 'c') for (const s of [3, 7, 11, 15]) m.add('bass', sawBass(low(c) + 24, m.steps(1) * 0.7, 1.2), m.at(bar, s), 0.6);
          drums(m, K, bar, { kick: 'x---x---x---x---', clap: part === 'a' ? '------------x---' : '----x-------x---', snare: part === 'c' ? '----x-------x---' : undefined, oh: '--x---x---x---x-', ch: full ? 'x-gxx-gxx-gxx-gx' : undefined, ride: part === 'c' ? 'x-x-x-x-x-x-x-x-' : undefined });
        }
        if (part === 'c') tune(m, 'lead', bar, loop(mel, k), (n, s, p) => lead(n, s, p), 1);
        if (part === 'b' && k >= 4) tune(m, 'lead', bar, loop(mel, k - 4), (n, s, p) => lead(n, s, p), 0.7, -12);
      }
      return { buses: { stab: { lvl: -19, rev: 0.4, chorus: [0.5, 2.5, 0.35], hp: 180, duck: 0.7, duckBeats: 0.85 }, pad: { lvl: -22, rev: 0.55, chorus: [0.4, 3, 0.5], hp: 170 }, arp: { lvl: -26, del: 0.5, rev: 0.35, hp: 400, duck: 0.4 }, bass: { lvl: -18, mono: true, lp: 3000, duck: 0.5, duckBeats: 0.6 }, kick: { lvl: -6, by: 'peak' }, snare: { lvl: -9, by: 'peak', rev: 0.4 }, hats: { lvl: -20, by: 'peak' }, lead: { lvl: -19, rev: 0.4, del: 0.4, hp: 350, duck: 0.2 }, fx: { lvl: -17, by: 'peak', rev: 0.45, hp: 200 } }, rev: { size: 1.25, decay: 2.6, damp: 6000, pre: 0.025, lvl: -8 }, del: { beats: 0.75, fb: 0.4, lvl: -10 }, lufs: -14, air: 2.5 };
    },
  },
  {
    id: 'full-tilt', name: 'Full tilt', mood: 'Fast and driving', energy: 5, bpm: 138, seed: 101,
    write(m) {
      const prog = chords('Em C G D'), K = kit(m.R, 'hard', '909');
      const mel = ['b5/2 e6/2 b5/2 g5/2 b5/4 e6/4', 'g5/2 c6/2 e6/4 d6/4 c6/4', 'd6/2 b5/2 g5/2 b5/2 d6/4 g6/4', 'f#6/4 a5/4 d6/8', 'e6/2 g6/2 e6/2 b5/2 e6/8', 'c6/2 e6/2 g6/4 e6/4 c6/4', 'b5/2 d6/2 g6/2 d6/2 b5/8', 'a5/2 d6/2 f#6/4 a6/8'];
      for (let bar = 0; bar < BARS; bar++) {
        const [part, k] = where(bar), c = loop(prog, bar), beat = part === 'a' || part === 'b' || part === 'c', full = part === 'b' || part === 'c';
        if (k === 0 && (part === 'a' || part === 'b')) lift(m, K, bar, false);
        if (k === 0 && part === 'c') lift(m, K, bar, true);
        if (part === 'mid' && k === 2) roll(m, K, bar);
        // the bass rolls on the three sixteenths between each kick, never on it, so the two never fight
        if (beat) m.lane(bar, '-xxx-xxx-xxx-xxx', (s) => m.add('bass', sawBass(low(c) + 12 + (part === 'c' && (s === 3 || s === 11) ? 12 : 0), m.steps(1) * 0.7, part === 'a' ? 0.8 : 1.15), m.at(bar, s), s % 4 === 3 ? 1 : 0.85));
        if (part === 'intro' || part === 'mid' || part === 'out') voicing(c, 62, 4).forEach((n, i) => m.add('pad', pad(n, m.barLen * 1.04, part === 'mid' ? 0.9 + k * 0.4 : 1, bar * 3 + i), m.at(bar, 0), 1));
        else for (const s of part === 'a' ? [2, 10] : [2, 6, 10, 14]) hit(m, 'stab', bar, s, c, (n, i) => stab(n, m.steps(1.3), part === 'c' ? 1.2 : 0.85, bar * 20 + s + i), { centre: 64, voices: 4 });
        // the arpeggio's filter opens a little more every bar of a part, which keeps the music moving forward
        arp(m, 'arp', bar, c, [0, 2, 1, 3, 2, 4, 3, 2], 1, (n, i) => pluck(n, part === 'intro' ? 0.5 + k * 0.1 : part === 'mid' ? 0.6 + k * 0.25 : 0.8 + k * 0.08, bar * 16 + i), { centre: 71, voices: 3, accent: 3 });
        if (beat) drums(m, K, bar, { kick: 'x---x---x---x---', clap: '----x-------x---', snare: full ? '----x-------x---' : undefined, ch: 'xgxgxgxgxgxgxgxg', oh: '--x---x---x---x-', ride: part === 'c' ? 'x---x---x---x---' : undefined });
        if (part === 'c' || (part === 'b' && k >= 4)) tune(m, 'lead', bar, loop(mel, part === 'c' ? k : k - 4), (n, s, p) => lead(n, s, p), part === 'c' ? 1 : 0.75);
      }
      return { buses: { stab: { lvl: -20, rev: 0.35, chorus: [0.5, 2.5, 0.35], hp: 200, duck: 0.6, duckBeats: 0.8 }, pad: { lvl: -22, rev: 0.5, chorus: [0.4, 3, 0.5], hp: 170 }, arp: { lvl: -24, del: 0.45, rev: 0.3, hp: 350, duck: 0.35 }, bass: { lvl: -17, mono: true, lp: 3200, duck: 0.35, duckBeats: 0.4 }, kick: { lvl: -6, by: 'peak' }, snare: { lvl: -9, by: 'peak', rev: 0.35 }, hats: { lvl: -19, by: 'peak' }, lead: { lvl: -19, rev: 0.35, del: 0.4, hp: 350, duck: 0.2 }, fx: { lvl: -17, by: 'peak', rev: 0.45, hp: 200 } }, rev: { size: 1.15, decay: 2.2, damp: 6200, pre: 0.02, lvl: -9 }, del: { beats: 0.75, fb: 0.38, lvl: -11 }, lufs: -14, air: 2.5 };
    },
  },
];

export const TRACKS: (Track & { seconds: number })[] = PIECES.map((p) => ({ id: p.id, name: p.name, mood: p.mood, energy: p.energy, bpm: p.bpm, seconds: Math.round((BARS * 4 * 60) / p.bpm) }));

/** Render one of the built-in pieces. Returns interleaved 16-bit stereo samples and the length in seconds. */
export function render(id: string): { pcm: Int16Array; seconds: number } {
  const p = PIECES.find((x) => x.id === id);
  if (!p) throw new Error('There is no built-in track by that name.');
  const m = new Mix(p.bpm, BARS, p.swing ?? 0, rng(p.seed));
  const pcm = m.finish(p.write(m));
  return { pcm, seconds: pcm.length / 2 / SR };
}

/** The samples as a WAV file, ready to hand to ffmpeg. */
export function wav(pcm: Int16Array): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22);
  head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
