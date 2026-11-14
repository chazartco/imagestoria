/* ---------- adding files ----------
   Each file goes to the server as it is. The server keeps the original untouched, reads its date,
   place and camera, and makes the display copy and the thumbnail. Two files travel at a time.
   The list keeps the files that are travelling on top, then the ones waiting, then any that failed,
   then the ones that are done (the order is set in the style sheet from each row's class). When a
   batch ends with nothing failed the sheet closes by itself. */
const MEDIA_RE = /\.(jpe?g|png|webp|gif|avif|heic|heif|tiff?|bmp|mp4|m4v|mov|webm|mkv|avi)$/i;
const Upload = {
  queue: [], active: 0, rows: new Map(), batch: null,
  open() {
    if (!can('upload')) return toast('You can view this library but not add to it.');
    const sel = $('#upSpace'); sel.innerHTML = ''; S.spaces.forEach(s => sel.append(el('option', { value: s.id, text: s.name, selected: s.id === S.space })));
    $('#upLimit').textContent = `Photos and videos up to ${fmt.bytes(S.cfg.limits.maxUploadMb * 1048576)} each. iPhone HEIC files are fine.`;
    if (!this.batch) this.clear();   // what an earlier batch left behind
    $('#upload').hidden = false;
  },
  close() { $('#upload').hidden = true; },
  clear() { $('#upList').innerHTML = ''; this.rows.clear(); this.tell(); },
  /* one line above the list that says how far the batch is */
  tell() {
    const b = this.batch, p = $('#upProgress'), left = b ? b.total - b.done : 0;
    $('#upload').classList.toggle('busy', !!b);
    p.hidden = !b; if (!b) return;
    p.textContent = left ? `${b.done} of ${fmt.plural(b.total, 'file')} done. ${this.active ? `Sending ${this.active} now.` : ''}` : `All ${fmt.plural(b.total, 'file')} done.`;
  },
  row(file) {
    const st = el('span', { class: 'up-st', text: 'Waiting' }), th = el('span', { class: 'up-th' }), bar = el('i', { class: 'up-bar' });
    const r = el('li', { class: 'up-row' }, th, el('div', { class: 'up-n' }, el('b', { text: file.name }), el('small', { class: 'muted', text: fmt.bytes(file.size) })), st, bar);
    $('#upList').append(r);
    return { r, st, th, set(t, cls, pct) { st.textContent = t; r.className = 'up-row ' + (cls || ''); bar.style.width = pct == null ? '0' : pct + '%'; } };
  },
  add(fileList) {
    if (!can('upload')) return;
    const all = [...fileList], files = all.filter(f => MEDIA_RE.test(f.name) || /^(image|video)\//.test(f.type));
    if (!files.length) return toast(all.length ? 'None of those are photos or videos.' : 'Nothing was chosen.');
    if ($('#upload').hidden) this.open();
    const space = $('#upSpace').value || S.space, max = S.cfg.limits.maxUploadMb * 1048576;
    if (!this.batch) this.batch = { added: 0, dup: 0, failed: 0, total: 0, done: 0, space };
    this.batch.total += files.length;
    for (const f of files) {
      const row = this.row(f);
      if (f.size > max) { row.set(`Larger than the ${fmt.bytes(max)} limit`, 'err'); this.batch.failed++; this.batch.done++; continue; }
      this.queue.push({ f, row, space });
    }
    if (all.length > files.length) toast(`${fmt.plural(all.length - files.length, 'file')} skipped: not a photo or video.`);
    this.pump();
  },
  pump() {
    while (this.active < 2 && this.queue.length) { const job = this.queue.shift(); this.active++; this.send(job).then(() => { this.active--; this.batch.done++; this.pump(); }); }
    this.tell();
    if (!this.active && !this.queue.length && this.batch) this.finished();
  },
  send({ f, row, space }) {
    return new Promise(done => {
      const fd = new FormData();   // the fields must come before the file: the server reads the form in order
      fd.append('space', space); fd.append('lastModified', String(f.lastModified || Date.now())); fd.append('tzOffset', String(new Date(f.lastModified || Date.now()).getTimezoneOffset())); fd.append('file', f, f.name);
      const x = new XMLHttpRequest(); x.open('POST', '/api/upload'); x.setRequestHeader('x-afterimage', '1'); x.responseType = 'json';
      x.upload.onprogress = e => { if (e.lengthComputable) { const p = Math.round(e.loaded / e.total * 100); row.set(p < 100 ? `Uploading ${p}%` : 'Storing the original', 'run', p); } };
      const fail = msg => { row.set(msg, 'err'); this.batch.failed++; done(); };
      x.onerror = () => fail('The connection dropped. Add it again.');
      x.onload = () => {
        const r = x.response || {};
        if (x.status === 401) return location.reload();
        if (x.status < 200 || x.status >= 300) return fail(r.error || 'The server did not accept this file.');
        if (r.duplicate) { row.set('Already in the library, skipped', 'skip'); this.batch.dup++; this.thumb(row, r.id); return done(); }
        row.set('Stored. Making the display copy and thumbnail', 'run done'); this.batch.added++; this.rows.set(r.id, row); Sync.soon(); done();
      };
      row.set('Uploading', 'run', 0); x.send(fd);
    });
  },
  thumb(row, id) { const it = S.byId.get(id); if (it && it.status === 'ready') row.th.style.background = `center / contain no-repeat url("${Img.url(it, 'thumb')}") ${it.ghost}`; },
  /* called after every sync: mark rows whose item has finished processing */
  synced() {
    for (const [id, row] of this.rows) {
      const it = S.byId.get(id); if (!it || it.status === 'processing') continue;
      this.rows.delete(id);
      if (it.status === 'ready') { row.set('Ready', 'ok'); this.thumb(row, id); } else row.set('Stored, but it could not be read. ' + (it.error || ''), 'err');
    }
  },
  finished() {
    const b = this.batch; this.batch = null;
    if (b.added) {
      const sp = S.spaces.find(s => s.id === b.space);
      if (S.space !== b.space) setSpace(b.space);
      S.sort = 'added'; $('#selSort').value = 'added'; Lib.refresh();
      toast(`Added ${fmt.plural(b.added, 'file')}${sp ? ' to ' + sp.name : ''}. ${b.dup ? `${b.dup} ${b.dup === 1 ? 'was' : 'were'} already in the library. ` : ''}Sorted by recently added so you can see them.`);
    } else if (b.dup && !b.failed) toast(`${b.dup === 1 ? 'That file is' : 'Those files are'} already in the library.`);
    /* nothing failed: there is nothing left to read here, so the sheet closes. A failure keeps it open,
       or opens it again, with the failed files above the finished ones. */
    if (b.failed) { this.tell(); $('#upProgress').hidden = false; $('#upProgress').textContent = `${fmt.plural(b.failed, 'file')} could not be added. The reason is next to each one.`; $('#upload').hidden = false; }
    else { this.close(); this.clear(); }
    Sync.soon();
  }
};
Bus.on('synced', () => Upload.synced());
