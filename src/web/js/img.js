/* ---------- image addresses ----------
   Every item has three copies on the server: a thumbnail and a display copy in WebP, and the untouched original.
   "full" is the original at full size in a form any browser can show (the same file unless it was HEIC or TIFF). */
const Img = {
  get THUMB_H() { return (S.cfg && S.cfg.limits.thumbHeight) || 360; },
  get DISPLAY_LONG() { return (S.cfg && S.cfg.limits.displayLongEdge) || 1600; },
  size(item, kind) {
    if (kind === 'thumb') { let h = Math.min(this.THUMB_H, item.h), w = h * item.ar; if (w > 1500) { w = 1500; h = w / item.ar; } return [Math.round(w), Math.round(h)]; }
    if (kind === 'display') { const s = Math.min(1, this.DISPLAY_LONG / Math.max(item.w, item.h)); return [Math.round(item.w * s), Math.round(item.h * s)]; }
    return [item.w, item.h];
  },
  /* A visitor fetches a story's pictures through the way they came in: a share link, or the published story. Everyone else is signed in.
     A cover on the public front page belongs to another published story, and is fetched through that one (item.via). */
  base(item) { return item.via ? `${item.via}/files/${item.id}` : S.share ? `${S.share.base}/files/${item.id}` : `/api/files/${item.id}`; },
  url(item, kind, extra) { return `${this.base(item)}/${kind === 'orig' ? 'full' : kind}${extra ? '?' + extra : ''}`; },
  /* the file a video element plays */
  /* "play" is the copy made for browsers when the video has one, and the original when it does not.
     The address changes when the copy arrives, so the browser does not go on playing what it fetched before. */
  media(item) { return `${this.base(item)}/play${item.play === 'ready' ? '?c=1' : ''}`; },
  /* the untouched file, exactly as it was uploaded */
  download(item) { const a = el('a', { href: `${this.base(item)}/orig?download=1`, download: item.fileName }); document.body.append(a); a.click(); a.remove(); }
};

/* Fill an <img> once its file arrives. Until then the tile shows the photo's afterimage color. */
function loadInto(img, item, kind, onready) {
  if (item.status !== 'ready') return;
  const want = item.id + kind; img._want = want;
  const done = () => { if (img._want !== want) return; img.classList.add('in'); onready && onready(); };
  img.onerror = () => { /* stays on its placeholder color */ };
  img.src = Img.url(item, kind);
  if (img.decode) img.decode().then(done, done); else img.onload = done;
}
