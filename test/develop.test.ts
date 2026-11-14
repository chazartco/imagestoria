import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import crypto from 'node:crypto';
import { LOOKS, LOOK_GROUPS } from '../src/shared/looks.js';
import { ADJ0, ADJ2, CURVE0, develop, develop2, developRecipe, recipeIsEmpty } from '../src/shared/develop.js';

/** A picture with something different in every corner, so position matters. */
function picture(w: number, h: number) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) { d[i] = 40 + (x * 180) / w; d[i + 1] = 60 + (y * 150) / h; d[i + 2] = 200 - ((x + y) * 120) / (w + h); d[i + 3] = 255; }
  return d;
}

describe('The develop pipeline', () => {
  it('develops a patch of a picture exactly as it develops that part of the whole picture', () => {
    const w = 96, h = 64, src = picture(w, h);
    const A = { ...ADJ0, exposure: 12, contrast: 20, vibrance: 30, shAmt: 20, fade: 10, vignette: 70 };
    const whole = develop({ src, blur: src, out: new Uint8ClampedArray(src.length), w, h }, A, CURVE0);
    // the editor's magnifier hands over only the pixels under it, and says where they sit in the whole
    const ox = 60, oy = 33, pw = 30, ph = 24, patch = new Uint8ClampedArray(pw * ph * 4);
    for (let y = 0; y < ph; y++) patch.set(src.subarray(((y + oy) * w + ox) * 4, ((y + oy) * w + ox + pw) * 4), y * pw * 4);
    const out = develop({ src: patch, blur: patch, out: new Uint8ClampedArray(patch.length), w: pw, h: ph, fw: w, fh: h, ox, oy }, A, CURVE0);
    for (let y = 0; y < ph; y++) assert.deepEqual([...out.subarray(y * pw * 4, (y + 1) * pw * 4)], [...whole.subarray(((y + oy) * w + ox) * 4, ((y + oy) * w + ox + pw) * 4)], 'row ' + y);
    // without its place in the whole, the vignette would be centered on the patch, which is wrong
    const naive = develop({ src: patch, blur: patch, out: new Uint8ClampedArray(patch.length), w: pw, h: ph }, A, CURVE0);
    assert.notDeepEqual([...naive], [...out]);
  });

  /** A recipe exactly as the editor saved them before version 2, with every control of that time in use. */
  const OLD = {
    adj: { exposure: 14, contrast: 22, highlights: -30, shadows: 26, whites: 8, blacks: -12, temp: 18, tint: -6, vibrance: 24, saturation: -10, shHue: 215, shAmt: 30, hlHue: 38, hlAmt: 24, clarity: 20, fade: 12, vignette: 40, grain: 16 },
    geo: { rot: 0, flipH: false, flipV: false, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 'Free' }, curve: [0.02, 0.2, 0.5, 0.82, 0.98], look: 'Café',
  };
  const soft = (src: Uint8ClampedArray) => src.map((v, i) => (i & 3) === 3 ? 255 : (v * 3 + 128) >> 2);
  const one = (rgb: number[], A: Record<string, number>, curves?: any, lut?: any) => [...develop2({ src: new Uint8ClampedArray([...rgb, 255]), blur: new Uint8ClampedArray([...rgb, 255]), out: new Uint8ClampedArray(4), w: 1, h: 1 }, { ...ADJ2, ...A }, CURVE0, curves ?? null, lut ?? null)].slice(0, 3);

  it('renders a recipe saved before version 2 exactly as it always did', () => {
    const w = 120, h = 80, src = picture(w, h), blur = soft(src);
    const out = developRecipe({ src, blur, out: new Uint8ClampedArray(src.length), w, h }, OLD, null);
    // The digest was taken from the version 1 code before version 2 was written. If it changes, old copies would change.
    assert.equal(crypto.createHash('sha256').update(out).digest('hex'), 'c1f3bf92921c677ead5a7f1eb45211e89fd4147d4dba7bed556dcffa59287320');
    assert.deepEqual([...out], [...develop({ src, blur, out: new Uint8ClampedArray(src.length), w, h }, { ...ADJ0, ...OLD.adj }, OLD.curve)], 'and it goes down the old path');
  });

  it('gives the same picture in version 2 when only the old controls are used, so reopening an old copy changes nothing you can see', () => {
    const w = 120, h = 80, src = picture(w, h), blur = soft(src);
    const v1 = developRecipe({ src, blur, out: new Uint8ClampedArray(src.length), w, h }, OLD, null);
    const v2 = developRecipe({ src, blur, out: new Uint8ClampedArray(src.length), w, h }, { ...OLD, v: 2 }, null);
    let worst = 0; for (let i = 0; i < v1.length; i++) worst = Math.max(worst, Math.abs(v1[i]! - v2[i]!));
    assert.ok(worst <= 2, 'at most two levels apart, was ' + worst);
    assert.deepEqual(one([90, 140, 200], {}), [90, 140, 200], 'and with nothing set, nothing changes');
  });

  it('develops a patch with the new controls exactly as it develops that part of the whole picture', () => {
    const w = 96, h = 64, src = picture(w, h), A = { ...ADJ2, contrast: 12, mxH1: 40, mxS5: -60, mxL3: 30, mdAmt: 40, mdHue: 300, balance: 30, matte: 50, vignette: 60, amount: 70 }, curves = { r: [0, 0.3, 0.5, 0.7, 1], g: CURVE0, b: [0.05, 0.25, 0.5, 0.7, 0.9] };
    const whole = develop2({ src, blur: src, out: new Uint8ClampedArray(src.length), w, h }, A, CURVE0, curves, null);
    const ox = 60, oy = 33, pw = 30, ph = 24, patch = new Uint8ClampedArray(pw * ph * 4);
    for (let y = 0; y < ph; y++) patch.set(src.subarray(((y + oy) * w + ox) * 4, ((y + oy) * w + ox + pw) * 4), y * pw * 4);
    const out = develop2({ src: patch, blur: patch, out: new Uint8ClampedArray(patch.length), w: pw, h: ph, fw: w, fh: h, ox, oy }, A, CURVE0, curves, null);
    for (let y = 0; y < ph; y++) assert.deepEqual([...out.subarray(y * pw * 4, (y + 1) * pw * 4)], [...whole.subarray(((y + oy) * w + ox) * 4, ((y + oy) * w + ox + pw) * 4)], 'row ' + y);
  });

  it('has a curve for each of red, green and blue', () => {
    const [r, g, b] = one([128, 128, 128], {}, { r: [0, 0.25, 0.7, 0.75, 1], g: CURVE0, b: CURVE0 });
    assert.ok(r! > 170 && g === 128 && b === 128, `only red moves: ${[r, g, b]}`);
  });

  it('mixes color by hue: one range changes and the others, and gray, stay', () => {
    const orange = [220, 140, 60], blue = [50, 90, 210], gray = [120, 120, 120];
    const spread = (c: number[]) => Math.max(...c) - Math.min(...c), luma = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    const muted = one(orange, { mxS1: -100 });
    assert.ok(spread(muted) < 8, 'orange with its saturation taken away is gray: ' + muted);
    assert.deepEqual(one(blue, { mxS1: -100 }), blue); assert.deepEqual(one(gray, { mxS1: -100, mxH1: 80, mxL1: 80 }), gray);
    const turned = one(orange, { mxH1: 100 });
    assert.ok(turned[1]! > turned[0]! - 30 && turned[1]! > orange[1]! + 20, 'turning orange up the wheel takes it toward yellow and green: ' + turned);
    assert.ok(Math.abs(luma(turned) - luma(orange)) < 3, 'and it stays as bright as it was');
    assert.ok(luma(one(blue, { mxL5: -100 })) < luma(blue) - 15, 'a range can be made darker'); assert.deepEqual(one(orange, { mxL5: -100 }), orange);
    // teal and orange: blues pulled toward aqua, the skin range left alone
    const teal = one(blue, { mxH5: -70 }); assert.ok(teal[1]! > blue[1]! + 15 && teal[0]! < blue[0]! - 20, 'blue turned toward teal: ' + teal);
  });

  it('grades in three ways, shadows, midtones and highlights, with a balance', () => {
    const tintOf = (c: number[]) => c[2]! - c[0]!; // how blue against red
    const mid = (v: number, A: Record<string, number>) => tintOf(one([v, v, v], A));
    const M = { mdHue: 240, mdAmt: 100 };
    assert.ok(mid(128, M) > 25, 'the midtone tint colors the middle'); assert.ok(Math.abs(mid(2, M)) < 4 && Math.abs(mid(253, M)) < 4, 'and leaves black and white alone');
    const [r, g, b] = one([128, 128, 128], M); assert.ok(Math.abs(0.2126 * r! + 0.7152 * g! + 0.0722 * b! - 128) < 2, 'without making the middle brighter or darker');
    const S = { shHue: 240, shAmt: 100 };
    assert.ok(mid(30, S) > mid(128, S) && mid(128, S) > mid(230, S), 'the shadow tint is strongest in the dark');
    assert.ok(mid(128, { ...S, balance: -100 }) > mid(128, S) + 4 && mid(128, { ...S, balance: 100 }) < mid(128, S) - 4, 'the balance says how far up the shadows reach');
  });

  it('has a matte control that lifts the blacks and softens the whites without flattening the middle', () => {
    const v = (x: number) => one([x, x, x], { matte: 100 })[0]!;
    assert.ok(v(0) >= 35 && v(0) <= 48, 'black is lifted: ' + v(0)); assert.ok(v(255) <= 242 && v(255) >= 230, 'white is softened: ' + v(255));
    assert.ok(Math.abs(v(128) - 128) <= 4, 'the middle stays: ' + v(128));
    assert.ok(v(160) - v(96) > 0.85 * 64, 'and keeps its contrast, which Fade does not');
  });

  it('blends the whole look against the untouched picture with the intensity', () => {
    const src = [60, 120, 200], A = { exposure: 30, saturation: -100, matte: 40, mxH5: 50 }, full = one(src, A), half = one(src, { ...A, amount: 50 });
    half.forEach((v, i) => assert.ok(Math.abs(v - (src[i]! + full[i]!) / 2) <= 1, `halfway between: ${half} of ${src} and ${full}`));
    assert.deepEqual(one(src, { ...A, amount: 0 }), src);
    assert.equal(recipeIsEmpty({ v: 2, adj: { ...ADJ2 }, curve: CURVE0 }), true);
    assert.equal(recipeIsEmpty({ v: 2, adj: { ...ADJ2, matte: 10 }, curve: CURVE0 }), false);
    assert.equal(recipeIsEmpty({ v: 2, adj: { ...ADJ2, matte: 10, amount: 0 }, curve: CURVE0 }), true, 'a look at no intensity is no change');
    assert.equal(recipeIsEmpty({ v: 2, adj: { ...ADJ2 }, curve: CURVE0, curves: { r: [0, 0.3, 0.5, 0.75, 1], g: CURVE0, b: CURVE0 } }), false);
    assert.equal(recipeIsEmpty(OLD), false); assert.equal(recipeIsEmpty({ adj: { ...ADJ0 }, curve: CURVE0 }), true);
  });
});

describe('The looks', () => {
  /** A small picture with skin, sky, leaves, a dark street with colored light, and a gray ramp in it. */
  const card = (() => {
    const colors = [[238, 196, 170], [203, 148, 112], [115, 74, 51], [64, 128, 219], [140, 194, 237], [41, 102, 31], [115, 153, 51], [8, 9, 18], [255, 26, 178], [26, 230, 255], [255, 189, 102], [255, 148, 56]];
    const w = 48, h = 16, d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) { const c = y < 4 ? [x * 255 / (w - 1), x * 255 / (w - 1), x * 255 / (w - 1)] : colors[Math.floor(x / 4)]!; const k = y < 4 ? 1 : 0.55 + 0.45 * (y - 4) / 11; d[i] = c[0]! * k; d[i + 1] = c[1]! * k; d[i + 2] = c[2]! * k; d[i + 3] = 255; }
    return { d, w, h };
  })();
  const through = (L: any) => develop2({ src: card.d, blur: card.d, out: new Uint8ClampedArray(card.d.length), w: card.w, h: card.h }, { ...ADJ2, ...L.adj, grain: 0 }, L.curve ?? CURVE0, L.curves, null);
  const apart = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!); return s / (a.length * 0.75); };

  it('are between 60 and 80, six to eight in each of the eleven groups, each with its own name', () => {
    assert.ok(LOOKS.length >= 60 && LOOKS.length <= 80, 'there are ' + LOOKS.length);
    assert.equal(LOOK_GROUPS.length, 11);
    for (const g of LOOK_GROUPS) { const n = LOOKS.filter((l: any) => l.group === g).length; assert.ok(n >= 6 && n <= 8, `${g} has ${n}`); }
    assert.ok(LOOKS.every((l: any) => LOOK_GROUPS.includes(l.group)));
    assert.equal(new Set(LOOKS.map((l: any) => l.name.toLowerCase())).size, LOOKS.length);
    for (const l of LOOKS as any[]) assert.ok(/^[A-Z][a-z]+([ -][a-z]+)*$/.test(l.name) && l.name.length <= 20, `"${l.name}" is a short name in sentence case`);
  });

  it('use only settings the pipeline has, within the range of their sliders', () => {
    const five = (c: any) => Array.isArray(c) && c.length === 5 && c.every((v: number) => v >= 0 && v <= 1);
    for (const l of LOOKS as any[]) {
      for (const [k, v] of Object.entries(l.adj) as [string, number][]) {
        assert.ok(k in ADJ2 && k !== 'amount', `${l.name}: ${k} is a setting`);
        const hue = /Hue$/.test(k), from0 = hue || /Amt$/.test(k) || ['fade', 'grain', 'matte'].includes(k);
        assert.ok(Number.isInteger(v) && v >= (from0 ? 0 : -100) && v <= (hue ? 360 : 100), `${l.name}: ${k} is ${v}`);
      }
      if (l.curve) assert.ok(five(l.curve), l.name); if (l.curves) assert.ok(five(l.curves.r) && five(l.curves.g) && five(l.curves.b), l.name);
      assert.equal(recipeIsEmpty({ v: 2, adj: { ...ADJ2, ...l.adj }, curve: l.curve ?? CURVE0, curves: l.curves }), false, l.name + ' changes something');
    }
  });

  it('each change the picture, differ from one another, and never break it', () => {
    const outs = (LOOKS as any[]).map((l) => [l.name, through(l)] as const);
    for (const [name, o] of outs) {
      assert.ok(apart(o, card.d) > 2.5, `${name} can be seen: ${apart(o, card.d).toFixed(1)}`);
      // the gray ramp still runs from dark to light, so nothing is turned inside out or flattened
      const lum = (x: number) => 0.2126 * o[x * 4]! + 0.7152 * o[x * 4 + 1]! + 0.0722 * o[x * 4 + 2]!;
      assert.ok(lum(47) - lum(0) > 110, `${name} keeps dark dark and light light: ${lum(0).toFixed(0)} to ${lum(47).toFixed(0)}`);
      for (let x = 4; x < 48; x += 4) assert.ok(lum(x) >= lum(x - 4) - 1, `${name} keeps the tones in order`);
    }
    for (let i = 0; i < outs.length; i++) for (let j = i + 1; j < outs.length; j++) assert.ok(apart(outs[i]![1], outs[j]![1]) > 1.2, `${outs[i]![0]} and ${outs[j]![0]} are different looks: ${apart(outs[i]![1], outs[j]![1]).toFixed(2)}`);
  });

  it('keep to their group: black and white has no color, and the color looks keep skin a skin color', () => {
    for (const l of LOOKS as any[]) {
      const o = through(l), px = (x: number, y: number) => [o[(y * 48 + x) * 4]!, o[(y * 48 + x) * 4 + 1]!, o[(y * 48 + x) * 4 + 2]!];
      if (l.group === 'Black and white') { for (const x of [2, 14, 22, 34, 38]) { const c = px(x, 12); assert.ok(Math.max(...c) - Math.min(...c) < 40, `${l.name} is black and white, with at most a tone`); } continue; }
      if (['Portrait and skin', 'Clean and commercial', 'Landscape and travel'].includes(l.group)) for (const x of [1, 5, 9]) { const [r, g, b] = px(x, 14); assert.ok(r! > g! && g! > b! - 2, `${l.name} keeps skin warm: ${[r, g, b]}`); }
    }
  });
});
