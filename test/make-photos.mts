// Draws varied test photos with dates, cameras and GPS in their EXIF. Usage: tsx test/make-photos.mts <folder> [count]
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
const out = process.argv[2] ?? path.join(import.meta.dirname, 'tmp', 'photos');
fs.mkdirSync(out, { recursive: true });
const places = [[39.4699, -0.3763], [38.967, -0.183], [40.4168, -3.7038], [35.6762, 139.6503], [39.47, -0.375]];
const dms = (v: number) => { const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 6000); return `${d}/1 ${m}/1 ${s}/100`; };
const sizes = [[1600, 1067], [1067, 1600], [1600, 1200], [2400, 800], [1200, 1200], [900, 1600], [2000, 1125]];
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const n = Number(process.argv[3] ?? 36);
for (let i = 0; i < n; i++) {
  const [w, h] = sizes[i % sizes.length]!; const hue = Math.floor(rnd() * 360), hue2 = (hue + 40 + Math.floor(rnd() * 120)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="${rnd().toFixed(2)}" y2="1"><stop offset="0" stop-color="hsl(${hue},${50 + Math.floor(rnd() * 40)}%,${35 + Math.floor(rnd() * 30)}%)"/><stop offset="1" stop-color="hsl(${hue2},60%,${20 + Math.floor(rnd() * 40)}%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * (0.2 + rnd() * 0.6)}" cy="${h * (0.2 + rnd() * 0.5)}" r="${Math.min(w, h) * (0.08 + rnd() * 0.15)}" fill="hsl(${(hue + 180) % 360},80%,70%)"/><rect x="0" y="${h * 0.72}" width="${w}" height="${h * 0.28}" fill="hsl(${hue2},40%,15%)" opacity=".8"/><text x="${w / 2}" y="${h / 2}" font-size="${Math.min(w, h) / 6}" font-family="sans-serif" fill="#fff" text-anchor="middle" opacity=".85">${i + 1}</text></svg>`;
  const month = 1 + Math.floor(i / 6), day = 2 + (i % 6) * (i < 12 ? 1 : 4), pl = places[Math.floor(i / 8) % places.length]!;
  const exif: any = { IFD0: { Make: 'Canon', Model: i % 3 ? 'Canon EOS R5' : 'iPhone 15 Pro' }, IFD2: { DateTimeOriginal: `2024:${String(month).padStart(2, '0')}:${String(day).padStart(2, '0')} ${String(8 + (i % 10)).padStart(2, '0')}:1${i % 6}:00`, ISOSpeedRatings: '200', FNumber: '28/10', ExposureTime: '1/250', FocalLength: '35/1' } };
  if (i % 9 !== 8) exif.IFD3 = { GPSLatitudeRef: pl[0]! >= 0 ? 'N' : 'S', GPSLatitude: dms(pl[0]! + (rnd() - 0.5) * 0.02), GPSLongitudeRef: pl[1]! >= 0 ? 'E' : 'W', GPSLongitude: dms(pl[1]! + (rnd() - 0.5) * 0.02) };
  await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).withExif(exif).toFile(path.join(out, `IMG_${String(1000 + i)}.jpg`));
}
console.log('made', n, 'photos in', out);
