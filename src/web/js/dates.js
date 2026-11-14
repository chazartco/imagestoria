/* ---------- date dialog: fix the date of a whole selection ----------
   Two cases. A camera whose clock was wrong, or set to another time zone: shift everything by an amount.
   Scans and files with no date of their own: give them all one date.
   Dates are wall-clock times with no time zone, so a shift is plain arithmetic on what the clock showed. */
const DateDialog = {
  sheet: null, items: [], mode: 'shift',
  /* move a wall-clock moment by minutes, without the browser's own time zone or daylight saving getting in the way */
  shifted(ms, minutes) {
    const d = new Date(ms), u = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) + minutes * 60000);
    return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds()).getTime();
  },
  say(ms) { return `${fmt.day(ms)} at ${fmt.time(ms)}`; },
  amount(minutes) {
    const m = Math.abs(minutes), parts = [[Math.floor(m / 1440), 'day'], [Math.floor(m % 1440 / 60), 'hour'], [m % 60, 'minute']].filter(p => p[0]).map(p => fmt.plural(p[0], p[1]));
    return (parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0] || '') + (minutes < 0 ? ' earlier' : ' later');
  },

  open(items) {
    items = items.filter(Boolean); if (!items.length || !can('tag')) return;
    this.close(); this.items = items; this.mode = 'shift';
    const n = items.length, sample = items.reduce((a, b) => (b.date < a.date ? b : a)), name = sample.title || sample.fileName;
    const num = (id, label, max) => el('label', { class: 'dt-num' }, el('input', { class: 'inp', id, type: 'number', min: 0, max, step: 1, value: 0, inputmode: 'numeric', 'aria-label': label }), label);
    const dir = el('select', { class: 'inp', id: 'dtDir', 'aria-label': 'Direction' }, el('option', { value: '1', text: 'Later' }), el('option', { value: '-1', text: 'Earlier' }));
    const p2 = v => String(v).padStart(2, '0'), d0 = new Date(sample.date);
    const when = el('input', { class: 'inp', id: 'dtWhen', type: 'datetime-local', 'aria-label': 'Date and time', value: `${d0.getFullYear()}-${p2(d0.getMonth() + 1)}-${p2(d0.getDate())}T${p2(d0.getHours())}:${p2(d0.getMinutes())}` });
    const example = el('p', { class: 'dt-example', id: 'dtExample', 'aria-live': 'polite' });
    const apply = el('button', { class: 'btn primary', id: 'dtApply', onclick: e => this.apply(e.currentTarget) });
    const shiftPane = el('div', { class: 'dt-pane', id: 'dtShift' }, el('p', { class: 'vi-note', text: 'For a camera whose clock was wrong, or set to another time zone. Every selected item moves by the same amount.' }),
      el('div', { class: 'dt-row' }, dir, num('dtDays', 'days', 36500), num('dtHours', 'hours', 23), num('dtMins', 'minutes', 59)));
    const setPane = el('div', { class: 'dt-pane', id: 'dtSet', hidden: true }, el('p', { class: 'vi-note', text: 'For scans and files with no date of their own. Every selected item gets this date and time.' }), when);
    const seg = el('div', { class: 'seg dt-seg', role: 'tablist' }, ['shift', 'set'].map(m => el('button', { role: 'tab', data: { m }, class: m === 'shift' ? 'on' : '', text: m === 'shift' ? 'Shift by an amount' : 'Set one date', onclick: () => { this.mode = m; $$('.dt-seg button', sheet).forEach(b => b.classList.toggle('on', b.dataset.m === m)); shiftPane.hidden = m !== 'shift'; setPane.hidden = m !== 'set'; paint(); } })));
    const paint = () => {
      const mins = this.minutes(), v = when.value;
      if (this.mode === 'shift') {
        apply.textContent = `Shift ${fmt.plural(n, 'item')}`; apply.disabled = !mins;
        example.textContent = mins ? `${name} was ${this.say(sample.date)} and becomes ${this.say(this.shifted(sample.date, mins))}.` : 'Choose how far to move them.';
      } else {
        apply.textContent = `Set ${fmt.plural(n, 'item')}`; apply.disabled = !v;
        example.textContent = v ? `${name} was ${this.say(sample.date)} and becomes ${this.say(new Date(v).getTime())}.` : 'Choose a date and time.';
      }
    };
    const sheet = this.sheet = el('div', { class: 'overlay sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Date', onclick: e => { if (e.target === sheet) this.close(); } },
      el('div', { class: 'sheet-box dt-box' },
        el('header', {}, el('h2', { text: n > 1 ? `Fix the date of ${fmt.n(n)} items` : 'Fix the date of this item' }), el('button', { class: 'iconbtn modal-x', id: 'dtClose', title: 'Close', 'aria-label': 'Close', html: icon('x'), onclick: () => this.close() })),
        seg, shiftPane, setPane, example,
        el('p', { class: 'vi-note', text: 'The files themselves are not changed, and they stay in the storage folder of the month they were added under.' }),
        el('div', { class: 'rowr' }, el('button', { class: 'btn', text: 'Cancel', onclick: () => this.close() }), apply)));
    sheet._close = () => this.close();
    sheet.addEventListener('input', paint); sheet.addEventListener('change', paint);
    document.body.append(sheet); paint(); $('#dtHours').focus(); $('#dtHours').select();
  },
  close() { if (!this.sheet) return; closePop(); this.sheet.remove(); this.sheet = null; this.items = []; },
  minutes() { const v = id => Math.max(0, Math.floor(+$(id).value || 0)); return (+$('#dtDir').value) * (v('#dtDays') * 1440 + v('#dtHours') * 60 + v('#dtMins')); },

  apply(btn) {
    const items = this.items, n = fmt.plural(items.length, 'item');
    if (this.mode === 'shift') { const mins = this.minutes(); if (!mins) return; this.close(); return this.shift(items, mins, true); }
    const v = $('#dtWhen').value; if (!v) return;
    const go = () => {
      closePop(); this.close();
      attempt(Lib.send(items, 'setdate', { d: v }), `Set ${n} to ${this.say(new Date(v).getTime())}`).then(() => { const t = new Date(v).getTime(); items.forEach(i => { i.date = t; i.dateSrc = 'manual'; i.hay = null; }); this.after(); }, () => { });
    };
    /* giving many items one date throws their own dates away, and there is no way back */
    if (items.length > 1) popover(btn, el('div', { class: 'confirm' }, el('p', { text: `Give all ${n} the same date and time? Their own dates are replaced, and this cannot be undone.` }), el('div', { class: 'rowr' }, el('button', { class: 'btn small', text: 'Keep', onclick: closePop }), el('button', { class: 'btn small danger', id: 'dtYes', text: `Set ${n}`, onclick: go }))), { up: true });
    else go();
  },
  /* a shift can always be taken back by the opposite shift */
  shift(items, mins, offerUndo) {
    const n = fmt.plural(items.length, 'item');
    return Lib.send(items, 'shiftdate', { minutes: mins }).then(() => {
      items.forEach(i => { i.date = this.shifted(i.date, mins); i.hay = null; }); this.after();
      toast(offerUndo ? `Moved ${n} ${this.amount(mins)}` : `Put ${n} back where they were`, offerUndo ? { label: 'Undo', fn: () => this.shift(items, -mins, false) } : undefined);
    }, e => toast(e.message));
  },
  after() { Lib.refresh(); Sync.soon(); if (Viewer.item) { Viewer.dirty = true; Viewer.info(true); } }
};
