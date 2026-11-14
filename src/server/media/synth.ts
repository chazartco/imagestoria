/**
 * The sound engine behind the built-in music: oscillators, filters, instruments, drums, effects and a mixer.
 * Everything here is plain arithmetic on arrays of samples. There are no samples of real instruments and
 * nothing is downloaded. The pieces themselves are written in music.ts.
 *
 * What makes it sound like music and not like a toy:
 *   - saw and pulse waves are band-limited (polyBLEP), so they have no digital whine on high notes
 *   - filters are zero-delay state-variable filters that stay stable and sweep smoothly
 *   - the electric piano, bells and mallets are built the way those sounds are known to work (FM, modes)
 *   - drums are built like a drum machine builds them: tuned sweeps, layered noise, metallic hat oscillators
 *   - the reverb is a feedback delay network with diffusion, which decays smoothly instead of ringing
 *   - each instrument group is set to a level, ducked under the kick where the style wants it, and the
 *     whole mix is compressed a little and limited, like a finished record
 */

export const SR = 44100;
const TAU = Math.PI * 2;
export type St = { l: Float32Array; r: Float32Array };
export const st = (n: number): St => ({ l: new Float32Array(n), r: new Float32Array(n) });
export const secs = (s: number) => Math.max(1, Math.round(s * SR));
export const mtof = (m: number) => 440 * 2 ** ((m - 69) / 12);
export const dB = (x: number) => 10 ** (x / 20);
export function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* ---------- note and chord names ---------- */

const LETTER: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
/** "f#5" or "bb3" to a MIDI note number. Middle C is c4 = 60. */
export function note(name: string): number {
  const m = /^([a-g])([#b]?)(-?\d)$/.exec(name.toLowerCase());
  if (!m) throw new Error('not a note: ' + name);
  return LETTER[m[1]!]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12 * (Number(m[3]) + 1);
}
const QUALITY: Record<string, number[]> = {
  '': [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9], '69': [0, 4, 7, 9, 14],
  maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], '9': [0, 4, 7, 10, 14], '13': [0, 4, 10, 14, 21], add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
  sus2: [0, 2, 7], sus4: [0, 5, 7], '7sus4': [0, 5, 7, 10], '9sus4': [0, 5, 7, 10, 14], m11: [0, 3, 7, 10, 14, 17], '7b9': [0, 4, 7, 10, 13], '7#9': [0, 4, 7, 10, 15],
};
export interface Chord { root: number; tones: number[]; name: string }
/** "C#m7" to its root (0 to 11) and the notes it is made of, counted in semitones above the root. */
export function chord(name: string): Chord {
  const m = /^([A-G])([#b]?)(.*)$/.exec(name);
  if (!m || !QUALITY[m[3]!]) throw new Error('not a chord: ' + name);
  return { root: (LETTER[m[1]!.toLowerCase()]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12, tones: QUALITY[m[3]!]!, name };
}
/**
 * Spread a chord's notes around a centre, the way a keyboard player would: a few notes close together,
 * moving as little as possible from one chord to the next. With more notes in the chord than voices,
 * the fifth goes first and then the root, because the bass has the root anyway.
 */
export function voicing(c: Chord, centre: number, voices: number): number[] {
  let tones = c.tones.slice();
  for (const drop of [7, 0]) if (tones.length > voices) tones = tones.filter((t) => t !== drop);
  tones = tones.slice(-voices);
  const out: number[] = [];
  for (const t of tones) {
    const pc = (c.root + t) % 12; let best = 0, dist = 1e9;
    for (let m = pc; m < 128; m += 12) { const d = Math.abs(m - centre); if (d < dist && !out.includes(m)) { dist = d; best = m; } }
    out.push(best);
  }
  return out.sort((a, b) => a - b);
}

/* ---------- filters ---------- */

/** A zero-delay state-variable filter, run in place. mode 0 low-pass, 1 band-pass, 2 high-pass. The cutoff may move. */
export function svf(x: Float32Array, mode: 0 | 1 | 2, cutoff: number | ((i: number) => number), q = 0.707): Float32Array {
  let ic1 = 0, ic2 = 0, a1 = 0, a2 = 0, a3 = 0; const k = 1 / q, fixed = typeof cutoff === 'number';
  for (let i = 0; i < x.length; i++) {
    if ((i & 31) === 0 && (i === 0 || !fixed)) { const fc = Math.min(Math.max(20, fixed ? (cutoff as number) : (cutoff as (i: number) => number)(i)), SR * 0.45), g = Math.tan(Math.PI * fc / SR); a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2; }
    const v3 = x[i]! - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    x[i] = mode === 0 ? v2 : mode === 1 ? v1 : x[i]! - k * v1 - v2;
  }
  return x;
}
const both = (b: St, f: (x: Float32Array) => unknown) => { f(b.l); f(b.r); return b; };
/** A shelf or a bell, for shaping the tone of a group or of the whole mix (the well-known "cookbook" formulas). */
export function eq(x: Float32Array, kind: 'low' | 'high' | 'peak', hz: number, gainDb: number, q = 0.707): Float32Array {
  if (Math.abs(gainDb) < 0.05) return x;
  const A = 10 ** (gainDb / 40), w = TAU * hz / SR, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q), sq = 2 * Math.sqrt(A) * al;
  let b0, b1, b2, a0, a1, a2;
  if (kind === 'peak') { b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; }
  else if (kind === 'low') { b0 = A * (A + 1 - (A - 1) * cs + sq); b1 = 2 * A * (A - 1 - (A + 1) * cs); b2 = A * (A + 1 - (A - 1) * cs - sq); a0 = A + 1 + (A - 1) * cs + sq; a1 = -2 * (A - 1 + (A + 1) * cs); a2 = A + 1 + (A - 1) * cs - sq; }
  else { b0 = A * (A + 1 + (A - 1) * cs + sq); b1 = -2 * A * (A - 1 + (A + 1) * cs); b2 = A * (A + 1 + (A - 1) * cs - sq); a0 = A + 1 - (A - 1) * cs + sq; a1 = 2 * (A - 1 - (A + 1) * cs); a2 = A + 1 - (A - 1) * cs - sq; }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]!, y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = y; x[i] = y; }
  return x;
}

/* ---------- envelopes ---------- */

/** Attack, decay to a sustain level, and release after the key is let go. Curved the way analog envelopes are. */
export function adsr(n: number, gate: number, a: number, d: number, s: number, r: number): Float32Array {
  const e = new Float32Array(n), an = Math.max(1, a * SR), dk = Math.exp(-1 / Math.max(1, d * SR * 0.3)), rk = Math.exp(-1 / Math.max(1, r * SR * 0.25)), gn = Math.min(n, Math.round(gate * SR));
  let v = 0;
  for (let i = 0; i < n; i++) {
    if (i < gn) { if (i < an) v = i / an; else v = s + (v - s) * dk; } else v *= rk;
    e[i] = v;
  }
  // never end on a step
  const f = Math.min(n, 96); for (let i = 0; i < f; i++) e[n - 1 - i] = e[n - 1 - i]! * (i / f);
  return e;
}
const fadeEnds = (x: Float32Array, inS = 0.001, outS = 0.01) => { const a = Math.min(x.length, secs(inS)), b = Math.min(x.length, secs(outS)); for (let i = 0; i < a; i++) x[i] = x[i]! * (i / a); for (let i = 0; i < b; i++) x[x.length - 1 - i] = x[x.length - 1 - i]! * (i / b); return x; };

/* ---------- the synthesizer voice: oscillators, filter, amplifier ---------- */

const blep = (t: number, dt: number) => (t < dt ? ((t /= dt), t + t - t * t - 1) : t > 1 - dt ? ((t = (t - 1) / dt), t * t + t + t + 1) : 0);
export interface Voice {
  f: number; gate: number; vel?: number; wave?: 'saw' | 'pulse' | 'tri' | 'sine'; pw?: number;
  /** how many copies of the oscillator, how far apart they are tuned (cents), and how wide they sit left to right */
  uni?: number; det?: number; width?: number;
  sub?: number; noise?: number;
  /** filter: resting cutoff in Hz, how far the envelope opens it, the envelope's attack, decay and sustain, resonance, slope */
  cut: number; env?: number; fa?: number; fd?: number; fs?: number; q?: number; poles?: 2 | 4; track?: number;
  a?: number; d?: number; s?: number; r?: number; drive?: number;
  vib?: number; vibRate?: number; vibDelay?: number; glideFrom?: number; glideT?: number; seed?: number;
}
/** One note of a subtractive synthesizer. Returns stereo. */
export function voice(o: Voice): St {
  const vel = o.vel ?? 1, r = o.r ?? 0.12, n = secs(o.gate + r + 0.02), out = st(n), R = rng((o.seed ?? 1) * 7919 + Math.round(o.f * 31));
  const uni = o.uni ?? 1, det = o.det ?? 0, width = o.width ?? 0, wave = o.wave ?? 'saw', pw = o.pw ?? 0.5;
  // pitch movement shared by all the oscillator copies: a slide into the note, and vibrato that arrives late
  const move = new Float32Array(n), vd = o.vibDelay ?? 0.18, vr = o.vibRate ?? 5.4, vdep = (o.vib ?? 0) / 1200, gf = o.glideFrom ? Math.log2(o.glideFrom / o.f) : 0, gt = Math.max(0.001, o.glideT ?? 0.06);
  for (let i = 0; i < n; i++) { const t = i / SR; move[i] = 2 ** (gf * Math.exp(-t / (gt * 0.35)) + vdep * Math.min(1, Math.max(0, (t - vd) / 0.25)) * Math.sin(TAU * vr * t)); }
  const still = !o.vib && !o.glideFrom;
  for (let u = 0; u < uni; u++) {
    const pos = uni === 1 ? 0 : (u / (uni - 1)) * 2 - 1, ratio = 2 ** ((det * pos + (uni > 1 ? (R() - 0.5) * det * 0.25 : 0)) / 1200), pan = pos * width * (u % 2 ? 1 : -1) * (uni > 2 ? 1 : 1);
    const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4), base = o.f * ratio / SR; let ph = R();
    for (let i = 0; i < n; i++) {
      const dt = still ? base : base * move[i]!; let s: number;
      if (wave === 'saw') s = 2 * ph - 1 - blep(ph, dt);
      else if (wave === 'pulse') { const p2 = ph + 1 - pw; s = (ph < pw ? 1 : -1) + blep(ph, dt) - blep(p2 >= 1 ? p2 - 1 : p2, dt); }
      else if (wave === 'tri') s = 4 * Math.abs(ph - 0.5) - 1;
      else s = Math.sin(TAU * ph);
      out.l[i] = out.l[i]! + s * gl; out.r[i] = out.r[i]! + s * gr;
      ph += dt; if (ph >= 1) ph -= 1;
    }
  }
  const norm = 1 / Math.sqrt(uni);
  if (o.sub || o.noise) { const w = TAU * o.f * 0.5 / SR; for (let i = 0; i < n; i++) { const x = (o.sub ? Math.sin(w * i) * o.sub : 0) / norm + (o.noise ? (R() * 2 - 1) * o.noise : 0) / norm; out.l[i] = out.l[i]! + x * 0.707; out.r[i] = out.r[i]! + x * 0.707; } }
  const fenv = adsr(n, o.gate, o.fa ?? 0.002, o.fd ?? 0.2, o.fs ?? 0, r), base = o.cut * (o.track ? (o.f / 261.6) ** o.track : 1), amt = o.env ?? 0;
  const cutoff = (i: number) => base + amt * fenv[i]!;
  for (let pass = 0; pass < (o.poles === 4 ? 2 : 1); pass++) both(out, (x) => svf(x, 0, amt ? cutoff : base, pass === 0 ? o.q ?? 0.8 : 0.6));
  const aenv = adsr(n, o.gate, o.a ?? 0.003, o.d ?? 0.3, o.s ?? 1, r), dr = o.drive ?? 0;
  for (let i = 0; i < n; i++) {
    let l = out.l[i]! * norm, rr = out.r[i]! * norm; if (dr) { l = Math.tanh(l * dr); rr = Math.tanh(rr * dr); }
    const g = aenv[i]! * vel; out.l[i] = l * g; out.r[i] = rr * g;
  }
  return out;
}

/* ---------- instruments that are not a filtered wave ---------- */

/**
 * An electric piano. A soft hammer strikes a tine: one sine bends another (frequency modulation), hard at
 * first so the attack barks a little, then less, so the note settles into a round tone. A second, much
 * higher pair gives the bell-like "ting" of the tine. Played harder, it barks more.
 */
export function epiano(f: number, gate: number, vel = 0.8): St {
  const n = secs(gate + 0.5), out = st(n), k = Math.min(2.4, Math.max(0.6, (f / 261.6) ** 0.45)), gn = gate * SR;
  for (const [ch, cents] of [[out.l, -2.5], [out.r, 2.5]] as const) {
    const w = TAU * f * 2 ** (cents / 1200) / SR;
    for (let i = 0; i < n; i++) {
      const t = i / SR, rel = i > gn ? Math.exp(-(i - gn) / (0.07 * SR)) : 1;
      const index = vel ** 1.6 * (2.3 * Math.exp(-t * 11) + 0.75 * Math.exp(-t * 1.6)) / k;
      const body = Math.sin(w * i + index * Math.sin(w * i)) * (0.62 * Math.exp(-t * 1.5 * k) + 0.38 * Math.exp(-t * 0.42 * k));
      const tine = Math.sin(w * i + 1.1 * Math.exp(-t * 24) * Math.sin(w * 13.02 * i)) * Math.exp(-t * 9 * k) * 0.22 * vel;
      ch[i] = (body + tine) * rel * vel * Math.min(1, i / 60);
    }
  }
  return out;
}
/**
 * A struck bar: marimba, vibraphone or kalimba. A bar rings at its own note and at a few fixed higher
 * ones that are not simple multiples of it, each dying away faster than the one below. A soft thump of
 * noise is the mallet.
 */
export function mallet(f: number, gate: number, vel = 0.8, kind: 'marimba' | 'vibes' | 'kalimba' = 'marimba', R: () => number = Math.random): Float32Array {
  const P = { marimba: { parts: [[1, 1, 1], [3.98, 0.3, 3.2], [9.9, 0.1, 7]], decay: 5.2, thump: 0.5, ring: 0.9 }, vibes: { parts: [[1, 1, 1], [3.99, 0.22, 2.2], [10.1, 0.06, 5]], decay: 0.95, thump: 0.25, ring: 2.6 }, kalimba: { parts: [[1, 1, 1], [5.42, 0.16, 4], [2.02, 0.12, 1.6]], decay: 3.4, thump: 0.35, ring: 1.2 } }[kind];
  const k = (f / 440) ** 0.55, n = secs(Math.min(gate + 0.2, 0.02) + P.ring / Math.max(0.6, k) + (kind === 'vibes' ? Math.min(gate, 2.5) : 0)), out = new Float32Array(n), gn = (kind === 'vibes' ? gate + 0.1 : 9) * SR;
  for (const [ratio, amp, fast] of P.parts) {
    const w = TAU * f * ratio! / SR; if (f * ratio! > SR * 0.42) continue;
    for (let i = 0; i < n; i++) out[i] = out[i]! + Math.sin(w * i) * amp! * Math.exp(-(i / SR) * P.decay * k * fast!);
  }
  const th = secs(0.012); let lp = 0;
  for (let i = 0; i < n; i++) { if (i < th) { lp += ((R() * 2 - 1) - lp) * 0.18; out[i] = out[i]! + lp * P.thump * (1 - i / th); } out[i] = out[i]! * vel * (i > gn ? Math.exp(-(i - gn) / (0.12 * SR)) : 1); }
  return fadeEnds(out, 0.0008, 0.02);
}
/** A glassy bell for quiet pieces: two bell tones a hair apart, so it shimmers. */
export function glass(f: number, gate: number, vel = 0.7): St {
  const n = secs(gate + 2.2), out = st(n), k = (f / 523) ** 0.5;
  for (const [ch, cents] of [[out.l, -4], [out.r, 4]] as const) {
    const w = TAU * f * 2 ** (cents / 1200) / SR;
    for (let i = 0; i < n; i++) { const t = i / SR; ch[i] = (Math.sin(w * i + 1.5 * Math.exp(-t * 3) * Math.sin(w * 3.5 * i)) * Math.exp(-t * 1.5 * k) + Math.sin(w * 2 * i + 0.6 * Math.sin(w * 7.03 * i) * Math.exp(-t * 6)) * 0.22 * Math.exp(-t * 2.6 * k)) * vel * Math.min(1, i / 180); }
  }
  return both(out, (x) => fadeEnds(x, 0.002, 0.3));
}
/** A bass built from one sine bending another: round, with a clear front edge that cuts through small speakers. */
export function fmBass(f: number, gate: number, vel = 0.9, bite = 1): Float32Array {
  const n = secs(gate + 0.06), out = new Float32Array(n), w = TAU * f / SR, env = adsr(n, gate, 0.003, 0.35, 0.72, 0.05);
  for (let i = 0; i < n; i++) { const t = i / SR; out[i] = (Math.sin(w * i + bite * (2.4 * Math.exp(-t * 22) + 0.55) * Math.sin(w * i)) * 0.85 + Math.sin(w * 0.5 * i) * 0.35) * env[i]! * vel; }
  return out;
}
export function subBass(f: number, gate: number, vel = 0.9): Float32Array {
  const n = secs(gate + 0.08), out = new Float32Array(n), w = TAU * f / SR, env = adsr(n, gate, 0.012, 0.6, 0.85, 0.07);
  for (let i = 0; i < n; i++) out[i] = Math.tanh((Math.sin(w * i) + 0.22 * Math.sin(2 * w * i)) * 1.25) * env[i]! * vel;
  return out;
}

/* ---------- drums, built the way a drum machine builds them ---------- */

const white = (n: number, R: () => number) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = R() * 2 - 1; return x; };
export type KickKind = 'house' | '808' | 'lofi' | 'wave' | 'hard';
/** A sine that falls in pitch very fast and then slowly: the fall is the punch, what is left is the weight. Plus a click. */
export function kick(kind: KickKind, R: () => number): Float32Array {
  const P = { house: [50, 170, 45, 45, 11, 6.5, 0.3, 1.5, 0.42], '808': [43, 95, 40, 22, 8, 3.1, 0.14, 1.25, 0.85], lofi: [53, 85, 36, 18, 10, 8.5, 0.1, 1.3, 0.34], wave: [52, 190, 50, 38, 12, 8, 0.3, 1.6, 0.36], hard: [51, 230, 55, 55, 12, 7.2, 0.28, 1.8, 0.38] }[kind] as number[];
  const [f0, a1, r1, a2, r2, dec, click, drive, len] = P as [number, number, number, number, number, number, number, number, number];
  const n = secs(len), out = new Float32Array(n), cl = svf(white(secs(0.012), R), 2, 2500); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR; ph += (f0 + a1 * Math.exp(-t * r1) + a2 * Math.exp(-t * r2)) / SR;
    out[i] = Math.tanh((Math.sin(TAU * ph) * Math.exp(-Math.max(0, t - 0.006) * dec) + (i < cl.length ? cl[i]! * click * (1 - i / cl.length) : 0)) * drive) / Math.tanh(drive);
  }
  if (kind === 'lofi') svf(out, 0, 2600);
  return fadeEnds(out, 0.0003, 0.03);
}
export type SnareKind = '909' | 'lofi' | 'gated' | 'clap' | 'rim' | 'snap';
/** Two tuned thumps for the drum's skin, and filtered noise for the wires under it. A clap is a few bursts of noise in a row. */
export function snare(kind: SnareKind, R: () => number): Float32Array {
  if (kind === 'clap' || kind === 'snap') {
    const hi = kind === 'snap', n = secs(hi ? 0.14 : 0.34), x = white(n, R), bursts = hi ? [0, 0.007] : [0, 0.009, 0.019, 0.03];
    for (let i = 0; i < n; i++) { const t = i / SR; let e = 0; for (const [k, s] of bursts.entries()) if (t >= s) e = Math.max(e, k === bursts.length - 1 ? Math.exp(-(t - s) * (hi ? 42 : 17)) : Math.exp(-(t - s) * 160)); x[i] = x[i]! * e; }
    svf(x, 1, hi ? 2600 : 1250, 1.3); svf(x, 2, hi ? 1200 : 550); for (let i = 0; i < n; i++) x[i] = Math.tanh(x[i]! * 2.4) * 0.8; svf(x, 0, hi ? 9000 : 7500);
    return fadeEnds(x, 0.0003, 0.03);
  }
  if (kind === 'rim') {
    const n = secs(0.07), x = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR; x[i] = Math.sin(TAU * 1720 * t) * Math.exp(-t * 95) * 0.55 + Math.sin(TAU * 445 * t) * Math.exp(-t * 65) * 0.6 + (R() * 2 - 1) * Math.exp(-t * 500) * 0.3; }
    return fadeEnds(svf(x, 2, 320), 0.0002, 0.01);
  }
  const lofi = kind === 'lofi', gated = kind === 'gated', n = secs(gated ? 0.36 : lofi ? 0.24 : 0.3), x = new Float32Array(n), nz = svf(white(n, R), 2, lofi ? 700 : 1400);
  if (lofi) svf(nz, 0, 5200);
  for (let i = 0; i < n; i++) {
    const t = i / SR, tone = (Math.sin(TAU * (182 + 55 * Math.exp(-t * 42)) * t) * 0.6 + Math.sin(TAU * (331 + 70 * Math.exp(-t * 42)) * t) * 0.34) * Math.exp(-t * (lofi ? 27 : 21));
    const wires = nz[i]! * Math.exp(-t * (lofi ? 21 : 15)), room = gated ? nz[i]! * 0.26 * Math.exp(-t * 4) * (t < 0.2 ? 1 : Math.max(0, 1 - (t - 0.2) / 0.03)) : 0;
    x[i] = Math.tanh((tone * (lofi ? 1 : 0.9) + wires * (lofi ? 0.55 : 0.85) + room) * 1.5) * 0.85;
  }
  svf(x, 0, lofi ? 7000 : gated ? 6800 : 9500);
  return fadeEnds(x, 0.0003, 0.03);
}
export type HatKind = 'closed' | 'open' | 'ride' | 'crash' | 'shaker';
/**
 * Cymbals: six square waves at pitches that do not agree with each other, which is what makes metal sound
 * like metal, then only the top of that is kept. A shaker is filtered noise with a soft front.
 */
export function hat(kind: HatKind, R: () => number): Float32Array {
  if (kind === 'shaker') { const n = secs(0.1), x = svf(white(n, R), 1, 6800, 0.9); for (let i = 0; i < n; i++) { const t = i / SR; x[i] = x[i]! * Math.min(1, t / 0.011) * Math.exp(-t * 46) * 1.6; } return fadeEnds(x, 0.001, 0.02); }
  const P = { closed: [0.075, 68, 7800, 0.25], open: [0.36, 10.5, 7200, 0.3], ride: [1.1, 3.4, 5200, 0.2], crash: [1.9, 2.5, 3600, 0.75] }[kind] as [number, number, number, number], [len, dec, hp, hiss] = P;
  const n = secs(len), x = new Float32Array(n), nz = white(n, R);
  for (const [k, f] of [205.3, 304.4, 369.6, 522.7, 540, 800].entries()) { const inc = f * (kind === 'ride' ? 1.31 : 1) / SR; let ph = k * 0.17; for (let i = 0; i < n; i++) { x[i] = x[i]! + (ph < 0.5 ? 1 : -1) / 6; ph += inc; if (ph >= 1) ph -= 1; } }
  for (let i = 0; i < n; i++) x[i] = x[i]! + nz[i]! * hiss;
  svf(x, 2, hp, 0.9); svf(x, 2, hp * 0.8, 0.7); svf(x, 0, 12000); svf(x, 0, 14000);
  for (let i = 0; i < n; i++) { const t = i / SR; x[i] = x[i]! * Math.exp(-t * dec) * (kind === 'crash' ? Math.min(1, t / 0.004) : 1) * 1.8; }
  return fadeEnds(x, 0.0003, kind === 'closed' ? 0.008 : 0.08);
}
/** Hand drums and toms: a short tuned thump. */
export function perc(f: number, R: () => number, long = false): Float32Array {
  const n = secs(long ? 0.45 : 0.16), x = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; ph += f * (1 + 0.28 * Math.exp(-t * 55)) / SR; x[i] = Math.sin(TAU * ph) * Math.exp(-t * (long ? 7.5 : 19)) + (R() * 2 - 1) * Math.exp(-t * 380) * 0.18; }
  return fadeEnds(x, 0.0003, 0.02);
}
/** Noise that opens up over a stretch of time, to lift the music into the next part. Played backwards it lets it down again. */
export function riser(seconds: number, R: () => number, down = false): St {
  const n = secs(seconds), out = st(n);
  for (const ch of [out.l, out.r]) { const x = white(n, R); svf(x, 1, (i) => 350 * (26 ** ((i / n) ** 1.5)), 1.6); for (let i = 0; i < n; i++) ch[i] = x[i]! * (i / n) ** 2.2; }
  if (down) { out.l.reverse(); out.r.reverse(); }
  return both(out, (x) => fadeEnds(x, 0.01, 0.02));
}
/** A low boom with a splash, to mark the start of a big part. */
export function impact(R: () => number): St {
  const n = secs(2.4), out = st(n), nz = [white(n, R), white(n, R)]; let ph = 0;
  nz.forEach((x) => svf(x, 0, (i) => 600 + 7000 * Math.exp(-(i / SR) * 3.2)));
  for (let i = 0; i < n; i++) { const t = i / SR; ph += (36 + 34 * Math.exp(-t * 9)) / SR; const boom = Math.tanh(Math.sin(TAU * ph) * 1.6) * Math.exp(-t * 2.7) * 0.9; out.l[i] = boom + nz[0]![i]! * Math.exp(-t * 3.4) * 0.38; out.r[i] = boom + nz[1]![i]! * Math.exp(-t * 3.4) * 0.38; }
  return both(out, (x) => fadeEnds(x, 0.0005, 0.2));
}
/** The crackle and hiss of an old record, for the laid-back pieces. */
export function vinyl(seconds: number, R: () => number): St {
  const n = secs(seconds), out = st(n);
  for (const ch of [out.l, out.r]) {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) { if (R() < 1 / 5200) { const a = (R() ** 3) * (R() < 0.5 ? 1 : -1), w = 2 + Math.floor(R() * 8); for (let k = 0; k < w && i + k < n; k++) x[i + k] = x[i + k]! + a * (1 - k / w); } x[i] = x[i]! + (R() * 2 - 1) * 0.012; }
    svf(x, 2, 900); svf(x, 0, 6500); ch.set(x);
  }
  return out;
}

/* ---------- effects ---------- */

/** Two copies of the sound, each a few milliseconds late and wavering, one a little out of step with the other. Makes one voice sound like several. */
export function chorus(b: St, rate = 0.5, depthMs = 3.2, baseMs = 13, mix = 0.5): St {
  const n = b.l.length, max = secs((baseMs + depthMs + 12) / 1000); // room for the longest delay either copy ever asks for
  for (const [ch, phase] of [[b.l, 0], [b.r, Math.PI / 2]] as const) {
    const buf = new Float32Array(max), dry = ch.slice(); let w = 0;
    for (let i = 0; i < n; i++) {
      buf[w] = dry[i]!; let acc = 0;
      for (const [k, off] of [0, 2.1].entries()) { const d = (baseMs + off * 2 + depthMs * Math.sin(TAU * rate * (k ? 1.31 : 1) * i / SR + phase + k * 1.7)) * SR / 1000; let rp = w - d; if (rp < 0) rp += max; const i0 = Math.floor(rp), fr = rp - i0; acc += buf[i0]! + (buf[(i0 + 1) % max]! - buf[i0]!) * fr; }
      ch[i] = dry[i]! * (1 - mix * 0.5) + acc * 0.5 * mix; w = (w + 1) % max;
    }
  }
  return b;
}
/** The level sways gently from one speaker to the other, like the tremolo of an electric piano. */
export function tremolo(b: St, rate: number, depth: number): St { for (let i = 0; i < b.l.length; i++) { const s = Math.sin(TAU * rate * i / SR) * depth; b.l[i] = b.l[i]! * (1 + s); b.r[i] = b.r[i]! * (1 - s); } return b; }
/** The slow drift and faint flutter of tape, which is most of what makes a recording sound "warm". */
export function wobble(b: St, R: () => number): St {
  const n = b.l.length, max = secs(0.03), ph = R() * 6;
  for (const ch of [b.l, b.r]) { const buf = new Float32Array(max), dry = ch.slice(); let w = 0; for (let i = 0; i < n; i++) { buf[w] = dry[i]!; const d = (9 + 2.6 * Math.sin(TAU * 0.43 * i / SR + ph) + 0.22 * Math.sin(TAU * 6.3 * i / SR)) * SR / 1000; let rp = w - d; if (rp < 0) rp += max; const i0 = Math.floor(rp), fr = rp - i0; ch[i] = buf[i0]! + (buf[(i0 + 1) % max]! - buf[i0]!) * fr; w = (w + 1) % max; } }
  return b;
}
/** An echo in time with the music that bounces from side to side and gets duller each time. */
export function pingPong(inp: St, seconds: number, feedback: number, lp = 3600, hp = 350): St {
  const n = inp.l.length, d = Math.max(1, Math.round(seconds * SR)), out = st(n), bl = new Float32Array(d), br = new Float32Array(d), a = Math.exp(-TAU * lp / SR), h = Math.exp(-TAU * hp / SR);
  let p = 0, l1 = 0, l2 = 0, h1 = 0, h2 = 0;
  for (let i = 0; i < n; i++) {
    const dl = bl[p]!, dr = br[p]!; out.l[i] = dl; out.r[i] = dr;
    l1 = l1 * a + dr * (1 - a); h1 = h1 * h + l1 * (1 - h); l2 = l2 * a + dl * (1 - a); h2 = h2 * h + l2 * (1 - h);
    bl[p] = (inp.l[i]! + inp.r[i]!) * 0.5 + (l1 - h1) * feedback; br[p] = (l2 - h2) * feedback; p = p + 1 === d ? 0 : p + 1;
  }
  return out;
}
/**
 * A room. The sound is first smeared by four short all-pass delays, then goes round eight longer delays that
 * all feed each other through a mixing matrix, losing a little each time and losing the top faster.
 * Because every delay feeds every other, the echoes multiply into a smooth wash instead of ringing at one pitch.
 */
export function reverb(inp: St, o: { size?: number; decay?: number; damp?: number; pre?: number } = {}): St {
  const n = inp.l.length, out = st(n), size = o.size ?? 1, decay = o.decay ?? 2, pre = secs(o.pre ?? 0.012);
  const smear = (x: Float32Array, lens: number[]) => { const y = new Float32Array(n); y.set(x.subarray(0, Math.max(0, n - pre)), Math.min(pre, n)); for (const L of lens) { const buf = new Float32Array(L); let p = 0; for (let i = 0; i < n; i++) { const d = buf[p]!, v = y[i]! - d * 0.62; buf[p] = v; y[i] = d + v * 0.62; p = p + 1 === L ? 0 : p + 1; } } return y; };
  const inL = smear(inp.l, [149, 113, 383, 281]), inR = smear(inp.r, [157, 107, 367, 293]);
  const D = [1423, 1601, 1867, 2053, 2251, 2399, 2617, 2797].map((v) => Math.round(v * size)), bufs = D.map((d) => new Float32Array(d)), idx = D.map(() => 0), gain = D.map((d) => 10 ** ((-3 * d) / (SR * decay))), lp = D.map(() => 0), a = Math.exp(-TAU * (o.damp ?? 5200) / SR);
  const v = new Float64Array(8), K = 1 / Math.sqrt(8);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 8; k++) v[k] = bufs[k]![idx[k]!]!;
    out.l[i] = (v[0]! - v[1]! + v[2]! - v[3]! + v[4]! - v[5]! + v[6]! - v[7]!) * 0.35; out.r[i] = (v[0]! + v[1]! - v[2]! - v[3]! + v[4]! + v[5]! - v[6]! - v[7]!) * 0.35;
    // every delay hands its sound to every other (a Hadamard matrix, worked out in three passes of adds and subtracts)
    for (let h = 1; h < 8; h <<= 1) for (let k = 0; k < 8; k += h << 1) for (let j = k; j < k + h; j++) { const x = v[j]!, y = v[j + h]!; v[j] = x + y; v[j + h] = x - y; }
    const xl = inL[i]!, xr = inR[i]!;
    for (let k = 0; k < 8; k++) { const x = v[k]! * K + (k & 1 ? xr : xl) * 0.5; lp[k] = lp[k]! * a + x * (1 - a); bufs[k]![idx[k]!] = lp[k]! * gain[k]!; idx[k] = idx[k]! + 1 === D[k] ? 0 : idx[k]! + 1; }
  }
  return both(out, (x) => { svf(x, 2, 190); svf(x, 0, 9500); });
}

/* ---------- the mixer ---------- */

export interface Bus {
  /** the level this group is brought to, in dB. "peak" for drums, "rms" (the default) for everything that sustains. */
  lvl: number; by?: 'peak' | 'rms';
  rev?: number; del?: number;
  /** how far it ducks under each kick, 0 to 1, and how long it takes to come back, in beats */
  duck?: number; duckBeats?: number;
  hp?: number; lp?: number; chorus?: [number, number, number]; trem?: [number, number]; wobble?: boolean; mono?: boolean; tilt?: [number, number];
}
export interface Finish { buses: Record<string, Bus>; rev: { size?: number; decay?: number; damp?: number; pre?: number; lvl: number }; del: { beats: number; fb: number; lvl: number }; lufs?: number; warm?: number; pres?: number; air?: number; lp?: number }

/** A piece being written: a timeline with a tempo, and a group ("bus") for each kind of instrument. */
export class Mix {
  readonly beat: number; readonly barLen: number; readonly n: number; readonly body: number;
  private buses = new Map<string, St>(); kicks: number[] = [];
  constructor(readonly bpm: number, readonly bars: number, readonly swing = 0, readonly R: () => number = rng(1)) {
    this.beat = 60 / bpm; this.barLen = this.beat * 4; this.body = secs(bars * this.barLen); this.n = this.body + secs(7);
  }
  /** When a sixteenth note falls. With swing, every second sixteenth comes late. */
  at(bar: number, step: number) { const s16 = this.beat / 4; return bar * this.barLen + step * s16 + (Math.floor(step) % 2 === 1 ? this.swing * s16 : 0); }
  steps(count: number) { return count * this.beat / 4; }
  bus(name: string) { let b = this.buses.get(name); if (!b) this.buses.set(name, (b = st(this.n))); return b; }
  /** Put a sound on a group at a moment. pan runs from -1 (left) to 1 (right). */
  add(name: string, sound: St | Float32Array, time: number, gain = 1, pan = 0) {
    const b = this.bus(name), start = Math.round(time * SR); if (start < 0 || start >= this.n) return;
    const gl = gain * Math.cos((pan + 1) * Math.PI / 4) * 1.414, gr = gain * Math.sin((pan + 1) * Math.PI / 4) * 1.414;
    if (sound instanceof Float32Array) { const m = Math.min(sound.length, this.n - start); for (let i = 0; i < m; i++) { b.l[start + i] = b.l[start + i]! + sound[i]! * gl * 0.707; b.r[start + i] = b.r[start + i]! + sound[i]! * gr * 0.707; } }
    else { const m = Math.min(sound.l.length, this.n - start); for (let i = 0; i < m; i++) { b.l[start + i] = b.l[start + i]! + sound.l[i]! * gl; b.r[start + i] = b.r[start + i]! + sound.r[i]! * gr; } }
  }
  /** Walk a pattern like "x---x-g-x---o---": x a hit, o an accent, g a ghost note, - nothing. */
  lane(bar: number, pattern: string, hit: (step: number, vel: number, ch: string) => void) { for (let s = 0; s < pattern.length; s++) { const c = pattern[s]!; if (c !== '-' && c !== ' ') hit(s * (16 / pattern.length), c === 'o' ? 1 : c === 'g' ? 0.38 : c === 'm' ? 0.62 : 0.85, c); } }
  /** Walk a written line: "e5/4 g5/2 ./2 a5/8" is notes and their lengths in sixteenths, with "." for a rest. */
  line(bar: number, written: string, play: (midi: number, time: number, seconds: number, k: number) => void) {
    let step = 0, k = 0;
    for (const tok of written.trim().split(/\s+/)) { const [nm, len] = tok.split('/') as [string, string], L = Number(len); if (nm !== '.') play(note(nm), this.at(bar + Math.floor(step / 16), step % 16), this.steps(L), k++); step += L; }
  }

  /** Balance the groups, add space, and finish it like a record. Returns 16-bit stereo samples of exactly the piece's length. */
  finish(f: Finish): Int16Array {
    const n = this.n, sum = st(n), toRev = st(n), toDel = st(n);
    // how the level comes back after a kick: down at once, back up in a smooth curve
    const duckCurve = (depth: number, beats: number) => { const g = new Float32Array(n).fill(1), len = secs(beats * this.beat); for (const k of this.kicks) { const s = Math.round(k * SR); for (let i = 0; i < len && s + i < n; i++) { const x = i / len, v = 1 - depth * (1 - x * x * (3 - 2 * x)) * Math.min(1, i / 90); if (v < g[s + i]!) g[s + i] = v; } } return g; };
    for (const [name, b] of this.buses) {
      const c = f.buses[name]; if (!c) throw new Error(`the group "${name}" has no place in the mix`);
      if (c.wobble) wobble(b, this.R);
      if (c.chorus) chorus(b, c.chorus[0], c.chorus[1], 13, c.chorus[2]);
      if (c.trem) tremolo(b, c.trem[0], c.trem[1]);
      if (c.hp) both(b, (x) => svf(x, 2, c.hp!));
      if (c.lp) both(b, (x) => svf(x, 0, c.lp!));
      if (c.tilt) both(b, (x) => eq(x, c.tilt![1] > 0 ? 'high' : 'low', c.tilt![0], Math.abs(c.tilt![1]) * (c.tilt![1] > 0 ? 1 : -1)));
      if (c.mono) for (let i = 0; i < n; i++) { const m = (b.l[i]! + b.r[i]!) * 0.5; b.l[i] = m; b.r[i] = m; }
      // measure it where it is actually playing, and bring it to its place in the mix
      let peak = 0, sq = 0, cnt = 0;
      for (let i = 0; i < n; i++) { const a = Math.max(Math.abs(b.l[i]!), Math.abs(b.r[i]!)); if (a > peak) peak = a; }
      const floor = peak * 0.02; for (let i = 0; i < n; i++) { const l = b.l[i]!, r = b.r[i]!; if (Math.abs(l) > floor || Math.abs(r) > floor) { sq += l * l + r * r; cnt += 2; } }
      const now = c.by === 'peak' ? peak : Math.sqrt(sq / Math.max(1, cnt)), g = now > 1e-9 ? dB(c.lvl) / now : 0;
      const dk = c.duck && this.kicks.length ? duckCurve(c.duck, c.duckBeats ?? 0.9) : null;
      for (let i = 0; i < n; i++) {
        const k = g * (dk ? dk[i]! : 1), l = b.l[i]! * k, r = b.r[i]! * k; sum.l[i] = sum.l[i]! + l; sum.r[i] = sum.r[i]! + r;
        if (c.rev) { toRev.l[i] = toRev.l[i]! + l * c.rev; toRev.r[i] = toRev.r[i]! + r * c.rev; }
        if (c.del) { toDel.l[i] = toDel.l[i]! + l * c.del; toDel.r[i] = toDel.r[i]! + r * c.del; }
      }
    }
    const echo = pingPong(toDel, f.del.beats * this.beat, f.del.fb);
    for (let i = 0; i < n; i++) { toRev.l[i] = toRev.l[i]! + echo.l[i]! * 0.35; toRev.r[i] = toRev.r[i]! + echo.r[i]! * 0.35; }
    const wet = reverb(toRev, f.rev), rl = dB(f.rev.lvl), dl = dB(f.del.lvl);
    for (let i = 0; i < n; i++) { sum.l[i] = sum.l[i]! + wet.l[i]! * rl + echo.l[i]! * dl; sum.r[i] = sum.r[i]! + wet.r[i]! * rl + echo.r[i]! * dl; }
    // what rings on after the last bar is laid over the first, so the end runs into the beginning without a seam
    const len = this.body; for (let i = len; i < n; i++) { sum.l[i - len] = sum.l[i - len]! + sum.l[i]!; sum.r[i - len] = sum.r[i - len]! + sum.r[i]!; }
    // Everything below (filters, compressor, limiter) remembers what it has just heard. So that the first second of the
    // piece is treated exactly like the moment after the last, the end of the piece is run through first and then dropped.
    const pre = Math.min(len, secs(1.5)), body = pre + len, L = new Float32Array(body), Rr = new Float32Array(body);
    L.set(sum.l.subarray(len - pre, len)); L.set(sum.l.subarray(0, len), pre); Rr.set(sum.r.subarray(len - pre, len)); Rr.set(sum.r.subarray(0, len), pre);
    for (const x of [L, Rr]) { svf(x, 2, 28); eq(x, 'low', 180, f.warm ?? 0); eq(x, 'peak', 3300, f.pres ?? 0, 0.8); eq(x, 'high', 6500, f.air ?? 0); if (f.lp) svf(x, 0, f.lp); }

    // "glue": a slow, gentle compressor that makes the groups move together
    const level = (xl: Float32Array, xr: Float32Array) => { let s = 0; for (let i = 0; i < xl.length; i++) s += xl[i]! * xl[i]! + xr[i]! * xr[i]!; return Math.sqrt(s / (2 * xl.length)); };
    let g0 = dB(-20) / Math.max(1e-9, level(L, Rr)); for (let i = 0; i < body; i++) { L[i] = L[i]! * g0; Rr[i] = Rr[i]! * g0; }
    { let e = 0, gr = 1; const at = Math.exp(-1 / (0.03 * SR)), rl2 = Math.exp(-1 / (0.25 * SR)), thr = dB(-20) ** 2; for (let i = 0; i < body; i++) { const p = (L[i]! * L[i]! + Rr[i]! * Rr[i]!) * 0.5; e = p > e ? e * at + p * (1 - at) : e * rl2 + p * (1 - rl2); const over = e > thr ? 0.5 * 10 * Math.log10(e / thr) : 0, want = dB(-over * 0.45); gr += (want - gr) * 0.002; L[i] = L[i]! * gr; Rr[i] = Rr[i]! * gr; } }
    // "Riding the fader": the quiet parts are brought up a little and the loud ones held back a little, slowly, so an
    // intro is clearly softer than the full part but never so soft that it gets lost under a slideshow.
    { const env = new Float32Array(body), k = Math.exp(-1 / (1.1 * SR)); let e2 = 0, tot = 0;
      for (let i = 0; i < body; i++) { const p = (L[i]! * L[i]! + Rr[i]! * Rr[i]!) * 0.5; e2 = e2 * k + p * (1 - k); env[i] = e2; tot += p; }
      e2 = env[body - 1]!; for (let i = body - 1; i >= 0; i--) { e2 = e2 * k + env[i]! * (1 - k); env[i] = e2; }
      const mean = tot / body;
      for (let i = 0; i < body; i++) { const off = 10 * Math.log10((env[i]! + 1e-12) / mean), g = dB(Math.max(-2, Math.min(5.5, -off * 0.5))); L[i] = L[i]! * g; Rr[i] = Rr[i]! * g; } }
    // Loudness is judged the way ears judge it (less weight on deep bass, more on the presence range), then set to the target.
    const kl = L.slice(), kr = Rr.slice(); for (const x of [kl, kr]) { svf(x, 2, 60); eq(x, 'high', 1700, 4); }
    g0 = dB((f.lufs ?? -15) - 1.8) / Math.max(1e-9, level(kl, kr));
    // peaks are rounded off softly, then a limiter that sees them coming holds everything under the ceiling without distortion
    const ceil = 0.84, need = new Float32Array(body);
    for (let i = 0; i < body; i++) { const l = Math.tanh(L[i]! * g0 * 0.9) / 0.9, r = Math.tanh(Rr[i]! * g0 * 0.9) / 0.9; L[i] = l; Rr[i] = r; const a = Math.max(Math.abs(l), Math.abs(r)); need[i] = a > ceil ? ceil / a : 1; }
    const rel = 1 - Math.exp(-1 / (0.12 * SR)), att = 1 - Math.exp(-1 / (0.0015 * SR)); let e = 1;
    for (let i = 0; i < body; i++) { e = Math.min(need[i]!, e + (1 - e) * rel); need[i] = e; }
    e = 1; for (let i = body - 1; i >= 0; i--) { e = Math.min(need[i]!, e + (1 - e) * att); need[i] = e; }
    // A few milliseconds of fade at each end, so there is never a click when a piece starts, stops or goes round again.
    const pcm = new Int16Array(len * 2), edge = secs(0.006);
    for (let i = 0; i < len; i++) { const g = need[pre + i]! * Math.min(1, i / edge, (len - 1 - i) / edge) * 32767; pcm[i * 2] = Math.round(L[pre + i]! * g); pcm[i * 2 + 1] = Math.round(Rr[pre + i]! * g); }
    return pcm;
  }
}
