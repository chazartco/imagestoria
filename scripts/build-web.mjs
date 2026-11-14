// Builds the front end into dist/web. There is no bundler: the page is a handful of plain scripts
// joined into one file, in the order below. Run with: npm run build:web
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src/web');
const out = path.join(root, 'dist/web');
const assets = path.join(out, 'assets');
const read = (p) => fs.readFileSync(p, 'utf8');
const mod = (p) => path.join(root, 'node_modules', p);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(assets, 'fonts'), { recursive: true });

// 1. Scripts. The develop pipeline is shared with the server, so its "export" keywords are dropped here.
// The looks are shared too (the contact sheet script reads them), and are joined on after it.
const shared = ['develop', 'looks', 'scenes'].map((n) => read(path.join(root, `src/shared/${n}.js`)).replace(/^import .*$/gm, '').replace(/^export /gm, '')).join('\n\n');
const order = ['core', 'api', 'img', 'library', 'viewer', 'map', 'locate', 'dates', 'stories', 'picker', 'share', 'editor', 'upload', 'admin', 'trash', 'people', 'app'];
const js = [`/* ImageStoria. Built ${new Date().toISOString().slice(0, 10)}. Source: src/web/js and src/shared. */`, shared, ...order.map((n) => read(path.join(src, 'js', `${n}.js`)))].join('\n\n');
fs.writeFileSync(path.join(assets, 'app.js'), js);

// 2. Fonts. Self-hosted so the page never calls a font service.
const fontCss = [];
for (const [pkg, files] of [['bricolage-grotesque', ['wght.css']], ['newsreader', ['wght.css', 'wght-italic.css']]]) {
  for (const f of files) {
    const css = read(mod(`@fontsource-variable/${pkg}/${f}`));
    fontCss.push(css.replace(/url\(\.\/files\/([^)]+)\)/g, (_, file) => {
      fs.copyFileSync(mod(`@fontsource-variable/${pkg}/files/${file}`), path.join(assets, 'fonts', file));
      return `url(/assets/fonts/${file})`;
    }).replace(/'(Bricolage Grotesque|Newsreader) Variable'/g, "'$1'"));
  }
}
const css = fontCss.join('\n') + '\n' + read(path.join(src, 'css/app.css'));
fs.writeFileSync(path.join(assets, 'app.css'), css);

// 3. The map library, as published.
fs.copyFileSync(mod('maplibre-gl/dist/maplibre-gl.js'), path.join(assets, 'maplibre-gl.js'));
fs.copyFileSync(mod('maplibre-gl/dist/maplibre-gl.css'), path.join(assets, 'maplibre-gl.css'));

// 4. Icons, and the manifest that lets a phone put the site on its home screen as an app.
//    All of them are drawn from the icon in brand/. Two shapes are needed:
//    "any":      the icon as it is, with its own rounded corners, at 192 and 512 px.
//    "maskable": the mark on a square that is color to its edges, kept inside the middle 80% so a phone can cut
//                the square to whatever shape it likes. iOS wants the same for its home screen icon, at 180 px.
const iconSvg = read(path.join(root, 'brand/imagestoria-app-icon.svg'));
const BG = (/<rect[^>]*fill="(#[0-9a-fA-F]{6})"/.exec(iconSvg) || [])[1] || '#1A1B1D';
const markOnly = (/<g [^>]*>[\s\S]*<\/g>/.exec(iconSvg) || [''])[0];
const bleed = (scale) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="${BG}"/><g transform="translate(60 60) scale(${scale}) translate(-60 -60)">${markOnly}</g></svg>`);
fs.copyFileSync(path.join(root, 'brand/imagestoria-app-icon.svg'), path.join(assets, 'favicon.svg'));
fs.copyFileSync(path.join(root, 'brand/imagestoria-app-icon.png'), path.join(assets, 'app-icon.png'));
for (const size of [192, 512]) await sharp(Buffer.from(iconSvg), { density: 300 }).resize(size, size).png().toFile(path.join(assets, `icon-${size}.png`));
await sharp(bleed(0.72), { density: 300 }).resize(512, 512).flatten({ background: BG }).png().toFile(path.join(assets, 'icon-maskable-512.png'));
await sharp(bleed(0.9), { density: 300 }).resize(180, 180).flatten({ background: BG }).png().toFile(path.join(assets, 'apple-touch-icon.png'));
fs.writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify({
  name: 'ImageStoria', short_name: 'ImageStoria', description: 'Your photos and videos, on your own server.',
  id: '/', start_url: '/', scope: '/', display: 'standalone', background_color: BG.toLowerCase(), theme_color: BG.toLowerCase(),
  icons: [
    { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/assets/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2));

// 5. The page. The version in the asset addresses changes whenever the scripts or styles do.
const v = crypto.createHash('sha1').update(js).update(css).digest('hex').slice(0, 10);
const mark = read(path.join(src, 'mark.svg.txt')).trim();
fs.writeFileSync(path.join(out, 'index.html'), read(path.join(src, 'index.html')).replaceAll('{{MARK}}', mark).replaceAll('{{V}}', v));

const kb = (p) => `${Math.round(fs.statSync(p).size / 1024)} KB`;
console.log(`web: app.js ${kb(path.join(assets, 'app.js'))}, app.css ${kb(path.join(assets, 'app.css'))}, version ${v}`);
