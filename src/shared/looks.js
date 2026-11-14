/* The looks: named starting points for the develop pipeline (version 2, see develop.js).
   Each one is a recipe written for this app. None is copied from, or named after, a preset pack, a film stock,
   a brand or a person. The browser lists them in the editor and scripts/contact-sheet.mts prints them for review.
   The web build strips the "import" and "export" keywords and inlines the file after develop.js. */
import { CURVE0 } from './develop.js';

export const LOOK_GROUPS = ['Cinematic', 'Moody', 'Clean and commercial', 'Portrait and skin', 'Landscape and travel', 'Street and urban', 'Golden hour', 'Night and neon', 'Film color', 'Faded and vintage', 'Black and white'];

const MIX_AT = { red: 0, orange: 1, yellow: 2, green: 3, aqua: 4, blue: 5, purple: 6, magenta: 7 };
/** A gentle S: darker shadows, brighter highlights. `d` is how far the quarter points move. */
const ess = d => [0, 0.25 - d, 0.5, 0.75 + d, 1];

/**
 * One look. `adj` holds slider values. `more` may hold:
 *   mix    { orange: [hue, saturation, brightness], ... } for the color mixer
 *   curve  the overall curve, and r, g, b the channel curves, each five points
 */
function look(group, name, adj, more) {
  const a = { ...adj }, m = more || {};
  for (const k in m.mix || {}) { const v = m.mix[k], i = MIX_AT[k]; if (v[0]) a['mxH' + i] = v[0]; if (v[1]) a['mxS' + i] = v[1]; if (v[2]) a['mxL' + i] = v[2]; }
  return { group, name, adj: a, curve: m.curve || null, curves: m.r || m.g || m.b ? { r: m.r || CURVE0, g: m.g || CURVE0, b: m.b || CURVE0 } : null };
}

export const LOOKS = [
  /* ---------- Cinematic: color contrast between skin and everything else, controlled highlights ---------- */
  look('Cinematic', 'Teal shadows', { contrast: 12, highlights: -14, vibrance: 8, shHue: 192, shAmt: 30, hlHue: 38, hlAmt: 20, vignette: 14 }, { curve: ess(0.02), mix: { blue: [-35, -5, -4], aqua: [0, 10, 0], green: [18, -35, -6], orange: [0, 12, 2] } }),
  look('Cinematic', 'Big screen', { contrast: 20, blacks: -8, highlights: -18, clarity: 12, shHue: 198, shAmt: 40, hlHue: 34, hlAmt: 30, balance: -10, vignette: 18 }, { mix: { blue: [-50, 8, -10], green: [24, -48, -8], yellow: [0, -22, 0], orange: [0, 18, 4] } }),
  look('Cinematic', 'Silver retained', { saturation: -45, contrast: 36, clarity: 30, blacks: -14, highlights: -10, shHue: 210, shAmt: 8, grain: 14 }),
  look('Cinematic', 'Cold case', { temp: -18, saturation: -24, contrast: 18, highlights: -12, shHue: 215, shAmt: 30, mdHue: 200, mdAmt: 12, hlHue: 190, hlAmt: 8, vignette: 20 }, { b: [0.04, 0.27, 0.5, 0.75, 1], mix: { orange: [0, 12, 0] } }),
  look('Cinematic', 'Dry country', { temp: 16, tint: -4, contrast: 16, matte: 15, shHue: 30, shAmt: 8, mdHue: 42, mdAmt: 14, hlHue: 48, hlAmt: 28 }, { mix: { blue: [-15, -40, 0], green: [-30, -40, 0], aqua: [0, -30, 0] } }),
  look('Cinematic', 'Green room', { tint: -20, saturation: -18, contrast: 20, shHue: 150, shAmt: 26, mdHue: 130, mdAmt: 10, hlHue: 70, hlAmt: 14, vignette: 22 }, { g: [0, 0.25, 0.53, 0.76, 1] }),
  look('Cinematic', 'Soft wide', { contrast: -8, highlights: -30, shadows: 22, matte: 35, vibrance: 10, shHue: 205, shAmt: 18, hlHue: 40, hlAmt: 16, grain: 10, vignette: 10 }, { mix: { blue: [-20, 0, 0] } }),

  /* ---------- Moody: darker, quieter color, weight in the shadows ---------- */
  look('Moody', 'Deep woods', { exposure: -8, contrast: 16, blacks: -10, matte: 20, shHue: 190, shAmt: 14, vignette: 30 }, { mix: { green: [22, -40, -25], yellow: [18, -35, -15], aqua: [0, -20, 0], orange: [0, 8, 0] } }),
  look('Moody', 'Storm front', { temp: -14, exposure: -6, contrast: 22, highlights: -30, clarity: 28, saturation: -30, shHue: 220, shAmt: 24, hlHue: 200, hlAmt: 8, vignette: 28 }, { mix: { blue: [0, 0, -25] } }),
  look('Moody', 'Ember', { exposure: -8, temp: 18, contrast: 18, saturation: -15, matte: 18, shHue: 20, shAmt: 18, hlHue: 35, hlAmt: 20, vignette: 34 }, { mix: { blue: [0, -60, 0], aqua: [0, -60, 0], green: [0, -50, 0], red: [0, 10, 0] } }),
  look('Moody', 'Slate', { saturation: -40, matte: 45, contrast: 12, clarity: 14, shHue: 215, shAmt: 22, vignette: 20 }),
  look('Moody', 'Brown study', { temp: 10, saturation: -22, contrast: 14, blacks: -6, matte: 25, mdHue: 28, mdAmt: 22, shHue: 25, shAmt: 10, vignette: 26 }, { mix: { green: [-30, -45, -15], blue: [0, -50, 0] } }),
  look('Moody', 'Low tide', { temp: -8, tint: -6, saturation: -28, highlights: -24, contrast: 10, matte: 30, shHue: 185, shAmt: 28, mdHue: 180, mdAmt: 8, vignette: 18 }, { mix: { orange: [0, 14, 0] } }),
  look('Moody', 'Quiet hour', { exposure: -10, contrast: 6, saturation: -18, matte: 40, fade: 6, shHue: 265, shAmt: 22, hlHue: 30, hlAmt: 14, vignette: 24, grain: 8 }),

  /* ---------- Clean and commercial: true color, bright, nothing that dates ---------- */
  look('Clean and commercial', 'True and bright', { exposure: 6, contrast: 10, highlights: -12, shadows: 14, whites: 6, vibrance: 16, clarity: 10 }),
  look('Clean and commercial', 'White studio', { exposure: 12, whites: 14, shadows: 24, contrast: 4, saturation: -6, temp: -3, vibrance: 8 }, { curve: [0, 0.27, 0.54, 0.78, 1] }),
  look('Clean and commercial', 'Crisp', { contrast: 20, clarity: 30, vibrance: 12, blacks: -10, highlights: -14, whites: 8 }),
  look('Clean and commercial', 'Catalog', { contrast: 8, vibrance: 10, shadows: 10, highlights: -8 }, { mix: { orange: [0, -6, 6], blue: [0, 8, 0], green: [0, -8, 0] } }),
  look('Clean and commercial', 'Fresh air', { temp: -8, exposure: 10, shadows: 26, highlights: -18, contrast: -4, vibrance: 14, matte: 12 }, { mix: { blue: [0, 10, 8], aqua: [0, 10, 0] } }),
  look('Clean and commercial', 'Punch', { contrast: 18, vibrance: 34, saturation: 6, clarity: 16, blacks: -8 }, { curve: ess(0.02), mix: { orange: [0, -10, 0], blue: [0, 10, -10] } }),
  look('Clean and commercial', 'Shop window', { temp: 10, exposure: 5, contrast: 10, shadows: 12, vibrance: 14, clarity: 8, hlHue: 45, hlAmt: 10 }),

  /* ---------- Portrait and skin: the orange and red ranges are where skin lives ---------- */
  look('Portrait and skin', 'Clean skin', { contrast: 4, shadows: 14, highlights: -10, clarity: -12, vibrance: 6 }, { mix: { orange: [0, -10, 10], red: [0, -12, 4], yellow: [0, -14, 0] } }),
  look('Portrait and skin', 'Porcelain', { exposure: 10, clarity: -22, saturation: -14, highlights: -16, shadows: 20, temp: -4, matte: 10 }, { mix: { orange: [0, -18, 16], red: [0, -15, 0] } }),
  look('Portrait and skin', 'Honey', { temp: 12, contrast: 8, clarity: -8, shadows: 12, vibrance: 8, hlHue: 42, hlAmt: 16, mdHue: 32, mdAmt: 8 }, { mix: { orange: [6, 6, 8], yellow: [0, -10, 0] } }),
  look('Portrait and skin', 'Editorial', { contrast: 22, saturation: -22, clarity: 10, blacks: -10, shHue: 220, shAmt: 10, vignette: 10 }, { curve: ess(0.02), mix: { orange: [0, -6, 6] } }),
  look('Portrait and skin', 'Rose', { tint: 10, contrast: -4, clarity: -14, shadows: 14, vibrance: 6, matte: 22, mdHue: 345, mdAmt: 14, hlHue: 20, hlAmt: 10 }, { mix: { orange: [0, 0, 8], red: [-10, 0, 0] } }),
  look('Portrait and skin', 'Against the light', { exposure: 8, shadows: 44, highlights: -34, contrast: 6, temp: 6, vibrance: 12, matte: 8, hlHue: 45, hlAmt: 14 }, { mix: { orange: [0, 0, 6] } }),
  look('Portrait and skin', 'Deep tone', { shadows: 22, contrast: 10, blacks: -4, clarity: 6, vibrance: 10, hlHue: 40, hlAmt: 10 }, { mix: { orange: [0, 6, 10], red: [0, 0, 6] } }),

  /* ---------- Landscape and travel: sky, water, green and rock, each given room ---------- */
  look('Landscape and travel', 'Big sky', { highlights: -30, clarity: 22, contrast: 12, vibrance: 18, whites: 8 }, { mix: { blue: [0, 18, -22], aqua: [0, 10, 0] } }),
  look('Landscape and travel', 'Evergreen', { vibrance: 14, contrast: 12, clarity: 14, shadows: 10 }, { mix: { green: [8, 18, -8], yellow: [22, 6, 0] } }),
  look('Landscape and travel', 'High pass', { temp: -12, clarity: 30, contrast: 16, whites: 10, vibrance: 12, shHue: 215, shAmt: 10 }, { mix: { blue: [0, 12, -10], aqua: [-8, 0, 0] } }),
  look('Landscape and travel', 'Red rock', { temp: 10, contrast: 16, clarity: 20, vibrance: 8 }, { mix: { orange: [0, 22, 0], red: [6, 14, 0], yellow: [0, 8, 0], blue: [0, 10, -14] } }),
  look('Landscape and travel', 'Lagoon', { temp: 4, contrast: 10, highlights: -16, vibrance: 22 }, { mix: { aqua: [-6, 28, 0], blue: [-22, 14, 0], green: [6, 14, 0] } }),
  look('Landscape and travel', 'Picture card', { vibrance: 30, saturation: 8, contrast: 16, highlights: -18, shadows: 16, clarity: 14, vignette: 8 }, { mix: { blue: [0, 0, -12] } }),
  look('Landscape and travel', 'Haze lifter', { contrast: 24, blacks: -18, clarity: 36, vibrance: 20, highlights: -10, temp: 3 }, { curve: ess(0.035) }),

  /* ---------- Street and urban: texture, hard light, color held back ---------- */
  look('Street and urban', 'Concrete', { saturation: -35, contrast: 26, clarity: 38, blacks: -12, shHue: 210, shAmt: 12, grain: 16, vignette: 16 }),
  look('Street and urban', 'Side street', { saturation: -15, matte: 28, contrast: 12, clarity: 14, shHue: 195, shAmt: 16, hlHue: 40, hlAmt: 14 }, { mix: { green: [0, -30, 0], blue: [0, -15, 0] } }),
  look('Street and urban', 'Underpass', { temp: -10, tint: -8, saturation: -20, contrast: 20, clarity: 22, shHue: 180, shAmt: 20, mdHue: 160, mdAmt: 8, vignette: 18 }, { mix: { orange: [0, 12, 0] } }),
  look('Street and urban', 'Rush hour', { contrast: 24, vibrance: 16, clarity: 20, blacks: -10 }, { mix: { yellow: [0, 30, 6], red: [0, 16, 0], blue: [0, -25, 0], green: [0, -30, 0] } }),
  look('Street and urban', 'Late edition', { saturation: -70, contrast: 30, clarity: 26, blacks: -10, highlights: -10, grain: 24 }),
  look('Street and urban', 'Brick and rust', { temp: 8, contrast: 16, clarity: 18, matte: 14, shHue: 205, shAmt: 10 }, { mix: { red: [8, 16, 0], orange: [0, 14, 0], blue: [0, -35, 0], aqua: [0, -30, 0] } }),
  look('Street and urban', 'Glass and steel', { temp: -14, saturation: -10, contrast: 16, clarity: 18, highlights: -20, whites: 8, hlHue: 205, hlAmt: 10 }, { mix: { blue: [0, 14, -6] } }),

  /* ---------- Golden hour: warmth in the highlights, something cooler left underneath ---------- */
  look('Golden hour', 'Last light', { temp: 22, contrast: 8, highlights: -22, shadows: 22, vibrance: 16, hlHue: 40, hlAmt: 26, mdHue: 32, mdAmt: 10, shHue: 250, shAmt: 10 }, { mix: { orange: [0, 10, 0] } }),
  look('Golden hour', 'Honeyed haze', { temp: 18, exposure: 8, contrast: -8, highlights: -10, clarity: -14, vibrance: 10, matte: 30, fade: 6, hlHue: 45, hlAmt: 30 }),
  look('Golden hour', 'Into the sun', { temp: 14, tint: -4, exposure: 10, whites: 10, shadows: 18, hlHue: 52, hlAmt: 32, mdHue: 48, mdAmt: 12, vignette: -12 }, { mix: { yellow: [0, 18, 0], orange: [10, 0, 0] } }),
  look('Golden hour', 'Amber and blue', { temp: 8, contrast: 14, vibrance: 14, hlHue: 36, hlAmt: 30, shHue: 225, shAmt: 30, balance: 10 }, { mix: { blue: [0, 10, 0] } }),
  look('Golden hour', 'Copper', { temp: 20, tint: 8, contrast: 18, blacks: -8, hlHue: 25, hlAmt: 20, vignette: 18 }, { mix: { orange: [-12, 20, 0], yellow: [-25, 10, 0], red: [0, 12, 0] } }),
  look('Golden hour', 'Afterglow', { temp: 6, tint: 14, contrast: 6, vibrance: 14, matte: 18, hlHue: 20, hlAmt: 22, mdHue: 330, mdAmt: 12, shHue: 255, shAmt: 22 }, { mix: { blue: [20, 0, 0] } }),
  look('Golden hour', 'Wheat field', { temp: 16, saturation: -14, contrast: 8, matte: 20, hlHue: 48, hlAmt: 20 }, { mix: { green: [-40, -20, 0], yellow: [0, 10, 6] } }),

  /* ---------- Night and neon: dark held dark, colored light pushed apart ---------- */
  look('Night and neon', 'Neon rain', { contrast: 20, vibrance: 30, blacks: -10, clarity: 14, shHue: 230, shAmt: 22 }, { mix: { magenta: [0, 30, 0], purple: [10, 20, 0], aqua: [0, 30, 0], blue: [-20, 16, 0], orange: [0, -10, 0] } }),
  look('Night and neon', 'Midnight blue', { temp: -26, exposure: -4, contrast: 16, saturation: -8, shHue: 228, shAmt: 36, mdHue: 215, mdAmt: 10, hlHue: 195, hlAmt: 10, vignette: 26 }, { mix: { orange: [0, 16, 0] } }),
  look('Night and neon', 'Streetlamp', { temp: 14, contrast: 18, blacks: -6, clarity: 12, shHue: 200, shAmt: 18, vignette: 20 }, { mix: { orange: [0, 16, 0], yellow: [-20, 10, 0], blue: [0, -30, 0] } }),
  look('Night and neon', 'Arcade', { tint: 16, contrast: 16, vibrance: 24, shHue: 270, shAmt: 34, mdHue: 300, mdAmt: 12, hlHue: 325, hlAmt: 18, vignette: 18 }, { mix: { blue: [30, 14, 0], aqua: [25, 0, 0] } }),
  look('Night and neon', 'Clear night', { shadows: 24, highlights: -36, contrast: 10, clarity: 8, saturation: -6, temp: -6, blacks: -6, vibrance: 12 }),
  look('Night and neon', 'Circuit', { contrast: 22, saturation: -6, clarity: 18, shHue: 172, shAmt: 34, hlHue: 315, hlAmt: 20, balance: -5, vignette: 22 }, { mix: { green: [30, 10, 0], blue: [-40, 0, 0] } }),
  look('Night and neon', 'One red light', { saturation: -50, contrast: 30, blacks: -16, clarity: 20, vignette: 30, grain: 12 }, { mix: { red: [0, 80, 0], orange: [0, 10, 0] } }),

  /* ---------- Film color: the manners of color negative, slide and print, without naming any ---------- */
  look('Film color', 'Warm negative', { temp: 6, saturation: -6, matte: 10, grain: 14 }, { curve: [0.03, 0.24, 0.5, 0.76, 0.97], r: [0, 0.25, 0.5, 0.77, 1], b: [0.03, 0.26, 0.5, 0.73, 0.96], mix: { green: [14, -14, 0], orange: [0, 6, 0] } }),
  look('Film color', 'Cool negative', { tint: -8, saturation: -4, contrast: 8, hlHue: 60, hlAmt: 8, grain: 14 }, { g: [0, 0.25, 0.52, 0.76, 1], b: [0.04, 0.27, 0.5, 0.75, 1], mix: { blue: [-14, 0, 0], red: [6, 0, 0] } }),
  look('Film color', 'Slide', { contrast: 24, vibrance: 24, saturation: 10, blacks: -14, grain: 6 }, { curve: ess(0.025), mix: { blue: [0, 10, -14], green: [0, 10, 0], red: [0, 10, 0] } }),
  look('Film color', 'Wrong chemistry', { contrast: 16, saturation: 10, vignette: 14, grain: 10 }, { r: [0, 0.2, 0.5, 0.8, 1], g: [0, 0.25, 0.56, 0.8, 1], b: [0.14, 0.3, 0.5, 0.66, 0.82] }),
  look('Film color', 'Corner shop print', { temp: 8, tint: 6, matte: 26, contrast: 10, saturation: 6, grain: 20, vignette: 12 }, { b: [0.05, 0.26, 0.5, 0.73, 0.95], mix: { green: [0, -12, 0] } }),
  look('Film color', 'Out of date', { temp: 6, contrast: -6, matte: 40, saturation: -12, fade: 8, shHue: 310, shAmt: 22, hlHue: 75, hlAmt: 22, grain: 30 }),
  look('Film color', 'Picture house', { highlights: -14, saturation: -8, shHue: 190, shAmt: 14, hlHue: 35, hlAmt: 12, grain: 12 }, { curve: [0.02, 0.25, 0.52, 0.77, 0.95], mix: { red: [8, -6, 0], orange: [0, 4, 0], green: [12, -18, 0], blue: [-12, 0, 0] } }),

  /* ---------- Faded and vintage: lifted blacks, tired color, the cast of old paper ---------- */
  look('Faded and vintage', 'Sun-bleached', { fade: 40, exposure: 6, saturation: -24, temp: 10, contrast: -8, hlHue: 50, hlAmt: 18, grain: 16 }),
  look('Faded and vintage', 'Attic box', { temp: 16, tint: -4, matte: 50, saturation: -26, contrast: -4, hlHue: 50, hlAmt: 26, shHue: 35, shAmt: 14, grain: 26, vignette: 20 }),
  look('Faded and vintage', 'Wood paneling', { temp: 14, matte: 34, saturation: -6, contrast: 8, grain: 18, vignette: 14 }, { r: [0, 0.25, 0.51, 0.78, 1], b: [0.08, 0.27, 0.48, 0.7, 0.9], mix: { blue: [-20, -30, 0], green: [-20, -20, 0] } }),
  look('Faded and vintage', 'Pastel', { exposure: 12, contrast: -18, matte: 44, saturation: -16, vibrance: 14, shadows: 24, hlHue: 330, hlAmt: 8, shHue: 200, shAmt: 10 }),
  look('Faded and vintage', 'Peel apart', { matte: 46, contrast: 6, saturation: -10, clarity: -10, shHue: 185, shAmt: 22, hlHue: 48, hlAmt: 22, vignette: 24, grain: 12 }),
  look('Faded and vintage', 'Dusty rose', { tint: 12, matte: 42, saturation: -28, contrast: -6, mdHue: 345, mdAmt: 14, hlHue: 25, hlAmt: 12, grain: 14 }),
  look('Faded and vintage', 'Hand tinted', { saturation: -45, vibrance: 20, matte: 30, temp: 12, contrast: 4, hlHue: 45, hlAmt: 20, shHue: 210, shAmt: 14, grain: 22, vignette: 22 }),

  /* ---------- Black and white: the mixer comes before the color is taken away, so it works as a colored filter on the lens ---------- */
  look('Black and white', 'Plain gray', { saturation: -100, contrast: 10 }),
  look('Black and white', 'Dark sky', { saturation: -100, contrast: 22, clarity: 20 }, { mix: { blue: [0, 0, -70], aqua: [0, 0, -50], red: [0, 0, 30], orange: [0, 0, 25], yellow: [0, 0, 15], green: [0, 0, -20] } }),
  look('Black and white', 'Soft silver', { saturation: -100, contrast: -6, matte: 36, clarity: -10, shadows: 16, grain: 10 }, { mix: { orange: [0, 0, 14] } }),
  look('Black and white', 'Hard press', { saturation: -100, contrast: 44, blacks: -20, whites: 12, clarity: 34, grain: 26 }),
  look('Black and white', 'Sitter', { saturation: -100, contrast: 14, clarity: -6, shadows: 10, vignette: 12, grain: 8 }, { mix: { orange: [0, 0, 20], red: [0, 0, 12] } }),
  look('Black and white', 'Cold tone', { saturation: -100, contrast: 18, clarity: 14, shHue: 235, shAmt: 20, hlHue: 220, hlAmt: 6, vignette: 14 }),
  look('Black and white', 'Warm tone', { saturation: -100, contrast: 12, matte: 14, shHue: 30, shAmt: 22, hlHue: 44, hlAmt: 14, grain: 14 }),
  look('Black and white', 'Long scale', { saturation: -100, exposure: 8, highlights: -30, shadows: 34, contrast: -4, clarity: 10, hlHue: 45, hlAmt: 6 }),
];
