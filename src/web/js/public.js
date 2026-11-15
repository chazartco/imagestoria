/* ---------- published stories: the library's public page ----------
   Two halves, like share.js. Public.block is what an owner (or an editor the owner allowed) sees in the Share sheet:
   whether the story is public, featured, downloadable, and its address. Public.boot is what a visitor's browser runs
   at /p, /p/<name>, and at the library's own address when nobody is signed in: one published story open as a page,
   the others as covers under it, and nothing else of the app. It reads a story exactly as a share link does. */
const Public = {
  /* the Share sheet's "Public" part */
  block(box, s, st) {
    const set = (body, done) => attempt(api('PATCH', `/api/stories/${s.id}/public`, body), done).then(n => {
      if (n.featured) S.stories.forEach(x => { x.featured = false; });
      Object.assign(s, { public: n.public, featured: n.featured, slug: n.slug }); this.block(box, s, n);
      if (Stories.cur === s) Stories.repaint();
    }, () => this.block(box, s, st));
    const opt = (key, text, on, off, disabled) => el('label', { class: 'sl-opt' }, el('input', { type: 'checkbox', checked: st[key], disabled: !!disabled, data: { opt: key }, onchange: e => set({ [key]: e.target.checked }, e.target.checked ? on : off) }), text);
    const sec = el('section', { class: 'sh-sec', id: 'shPub' }, el('h3', { text: 'Public' }),
      el('p', { class: 'vi-note', text: 'A public story can be read by anyone at this library’s own address, without signing in and without a link. They see this story and nothing else in the library. Turning it off ends that at once.' }),
      el('div', { class: 'sl-opts' }, opt('public', 'Public', 'This story is now public', 'This story is no longer public'),
        opt('featured', 'Featured on the front page', 'This story now opens the public page', 'This story no longer opens the public page', !st.public),
        opt('allowDownload', 'Download the originals', 'Visitors can now download the originals', 'Visitors can no longer download the originals', !st.public)));
    if (st.public && st.url) {
      const url = el('input', { class: 'inp sl-url', id: 'shPubUrl', readonly: true, value: st.url, 'aria-label': 'Public address of this story', onfocus: e => e.target.select() });
      const copy = () => { const ok = () => toast('Address copied'); if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(st.url).then(ok, () => url.select()); else { url.select(); document.execCommand('copy'); ok(); } };
      const slug = el('input', { class: 'inp', id: 'shPubSlug', value: st.slug, maxlength: 60, 'aria-label': 'The name in the address', onkeydown: e => { if (e.key === 'Enter') e.target.blur(); e.stopPropagation(); }, onchange: e => { const v = e.target.value.trim(); if (v && v !== st.slug) set({ slug: v }, 'Address changed'); else e.target.value = st.slug; } });
      sec.append(el('div', { class: 'sl-row pub-row' }, url, el('button', { class: 'btn small primary', text: 'Copy address', onclick: copy })),
        el('label', { class: 'pub-slug' }, el('span', { class: 'muted', text: 'Name in the address. It stays the same when the title changes. Changing it breaks the old address.' }), slug));
    }
    box.innerHTML = ''; box.append(sec);
  },

  /* A visitor. slug is the story asked for, or null for the front page. Gives false when there is nothing public to show. */
  async boot(slug, signedIn) {
    let r = null;
    if (slug) { try { r = await api('GET', '/api/public/stories/' + encodeURIComponent(slug)); } catch (e) { slug = null; } }
    /* a name nobody uses, or a story that is not published, shows the front page instead, and says nothing about why */
    if (!r) { try { r = await api('GET', '/api/public'); } catch (e) { return false; } if (location.pathname !== '/') history.replaceState(null, '', '/p'); }
    S.share = { token: null, base: '/api/public/stories/' + r.slug, can: {}, pub: { site: r.site, others: r.others, slug: r.slug, signedIn: !!signedIn } };
    document.body.classList.add('share-mode', 'public-mode');
    Share.start(r);
    document.title = slug ? r.story.title : (r.site.title || r.story.title);
    return true;
  },
  /* the library's name over the story, and the other published stories under it, each cover whole */
  frame(rd) {
    const p = S.share.pub, boxes = [];
    rd.prepend(el('div', { class: 'pub-top', id: 'pubTop' },
      el('a', { class: 'pub-site', href: '/p' },
        /* the owner's own logo, whole, in its own shape. If it cannot be loaded it steps aside. */
        p.site.logo ? el('img', { class: 'pub-logo', id: 'pubLogo', src: p.site.logo, alt: '', onerror: e => e.target.remove() }) : null,
        el('span', { class: 'pub-names' }, el('b', { text: p.site.title || 'Stories' }), p.site.line ? el('span', { class: 'muted', text: p.site.line }) : null)),
      el('a', { class: 'btn small', id: 'pubSignIn', href: p.signedIn ? '/' : '/?signin=1', text: p.signedIn ? 'Open the library' : 'Sign in' })));
    if (!p.others.length) return;
    const grid = el('div', { class: 'st-grid' });
    p.others.forEach(o => {
      const via = '/api/public/stories/' + o.slug;
      const cov = o.covers.map(c => Object.assign(hydrate({ id: c.id, kind: 'photo', status: 'ready', w: c.w, h: c.h, palette: c.palette, d: '2000-01-01T00:00:00', title: o.title, fileName: 'photo', space: 'share' }), { via }));
      if (!cov.length) return;
      const cb = el('div', { class: 'st-cover', style: { background: `linear-gradient(135deg, ${mix(cov[0].palette[0], '#111214', .55)}, ${mix(cov[0].palette[1] || cov[0].palette[0], '#111214', .7)})` } });
      boxes.push([cb, cov]);
      grid.append(el('a', { class: 'st-card pub-card', href: '/p/' + o.slug, data: { slug: o.slug } }, cb, el('h3', { text: o.title }), el('p', { text: fmt.plural(o.count, 'item') })));
    });
    rd.append(el('section', { class: 'pub-more', id: 'pubMore' }, el('h2', { class: 'st-sub', text: 'More stories' }), grid));
    boxes.forEach(([cb, cov]) => Stories.paintCover(cb, cov, false));
  }
};
