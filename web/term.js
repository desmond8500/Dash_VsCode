// ANSI-aware output model for terminal / command sessions.
'use strict';
(function () {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const TOKEN = /\x1b\[([0-9;?:]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]|\r\n|\r|\n|\x08|\x07|[^\x1b\r\n\x08\x07]+|\x1b/g;
  const MAX_LINES = 5000;

  function color256(n) {
    if (n < 16) return null;
    if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
    n -= 16;
    const c = [0, 95, 135, 175, 215, 255];
    return `rgb(${c[Math.floor(n / 36)]},${c[Math.floor(n / 6) % 6]},${c[n % 6]})`;
  }

  class TermModel {
    constructor() {
      this.el = document.createElement('div');
      this.el.className = 'term-lines';
      this.cur = document.createElement('div');
      this.cur.className = 'l cur';
      this.el.appendChild(this.cur);
      this.reset();
    }
    reset() {
      this.st = { fg: null, bg: null, b: false, d: false, i: false, u: false, inv: false, s: false };
      this.line = [];
      this.cr = false;
      this.done = [];
      this.count = 0;
      while (this.el.firstChild !== this.cur) this.el.removeChild(this.el.firstChild);
      this.cur.innerHTML = '';
      this.dirty = false;
    }
    span(t) {
      const st = this.st;
      let cls = '';
      let style = '';
      let fg = st.fg, bg = st.bg;
      if (st.inv) { [fg, bg] = [bg == null ? 'd-bg' : bg, fg == null ? 'd-fg' : fg]; }
      const put = (v, kind) => {
        if (v == null) return;
        if (typeof v === 'number') cls += ` ${kind}${v}`;
        else if (v === 'd-bg' || v === 'd-fg') cls += ` ${kind}-${v}`;
        else style += `${kind === 'f' ? 'color' : 'background'}:${v};`;
      };
      put(fg, 'f');
      put(bg, 'b');
      if (st.b) cls += ' bold';
      if (st.d) cls += ' dim';
      if (st.i) cls += ' ital';
      if (st.u) cls += ' und';
      if (st.s) cls += ' strike';
      return { t, cls: cls.trim(), style };
    }
    sgr(params) {
      const p = params === '' ? [0] : params.split(/[;:]/).map((x) => (x === '' ? 0 : parseInt(x, 10)));
      const st = this.st;
      for (let k = 0; k < p.length; k++) {
        const n = p[k];
        if (n === 0) Object.assign(st, { fg: null, bg: null, b: false, d: false, i: false, u: false, inv: false, s: false });
        else if (n === 1) st.b = true;
        else if (n === 2) st.d = true;
        else if (n === 3) st.i = true;
        else if (n === 4) st.u = true;
        else if (n === 7) st.inv = true;
        else if (n === 9) st.s = true;
        else if (n === 22) { st.b = false; st.d = false; }
        else if (n === 23) st.i = false;
        else if (n === 24) st.u = false;
        else if (n === 27) st.inv = false;
        else if (n === 29) st.s = false;
        else if (n >= 30 && n <= 37) st.fg = n - 30;
        else if (n === 39) st.fg = null;
        else if (n >= 40 && n <= 47) st.bg = n - 40;
        else if (n === 49) st.bg = null;
        else if (n >= 90 && n <= 97) st.fg = n - 90 + 8;
        else if (n >= 100 && n <= 107) st.bg = n - 100 + 8;
        else if (n === 38 || n === 48) {
          let v = null;
          if (p[k + 1] === 5) { const c = p[k + 2]; v = c < 16 ? c : color256(c); k += 2; }
          else if (p[k + 1] === 2) { v = `rgb(${p[k + 2] | 0},${p[k + 3] | 0},${p[k + 4] | 0})`; k += 4; }
          if (n === 38) st.fg = v; else st.bg = v;
        }
      }
    }
    newline() {
      this.done.push(this.html(this.line));
      this.line = [];
      this.cr = false;
    }
    html(segs) {
      if (!segs.length) return '';
      let h = '';
      for (const s of segs) {
        const t = esc(s.t);
        if (!s.cls && !s.style) h += t;
        else h += `<span${s.cls ? ` class="${s.cls}"` : ''}${s.style ? ` style="${s.style}"` : ''}>${t}</span>`;
      }
      return h;
    }
    text() {
      // plain text of the visible line (used for copy-all)
      return this.el.innerText;
    }
    feed(data) {
      TOKEN.lastIndex = 0;
      let m;
      while ((m = TOKEN.exec(data))) {
        const tok = m[0];
        if (tok === '\n' || tok === '\r\n') { this.newline(); continue; }
        if (tok === '\r') { this.cr = true; continue; }
        if (tok === '\x07') continue;
        if (tok === '\x08') {
          const last = this.line[this.line.length - 1];
          if (last) { last.t = last.t.slice(0, -1); if (!last.t) this.line.pop(); }
          continue;
        }
        if (tok[0] === '\x1b') {
          if (m[2] === 'm') this.sgr(m[1]);
          else if (m[2] === 'K') { if (m[1] === '2' || this.cr) { this.line = []; this.cr = false; } }
          else if (m[2] === 'G' && (m[1] === '' || m[1] === '1' || m[1] === '0')) this.cr = true;
          else if (m[2] === 'J' && (m[1] === '2' || m[1] === '3')) { this.reset(); }
          continue;
        }
        if (this.cr) { this.line = []; this.cr = false; }
        let t = tok.replace(/\t/g, '    ');
        this.line.push(this.span(t));
      }
      this.dirty = true;
    }
    flush() {
      if (!this.dirty) return;
      this.dirty = false;
      if (this.done.length) {
        const html = this.done.map((h) => `<div class="l">${h || '&#8203;'}</div>`).join('');
        this.cur.insertAdjacentHTML('beforebegin', html);
        this.count += this.done.length;
        this.done = [];
        let extra = this.count - MAX_LINES;
        while (extra-- > 0 && this.el.firstChild !== this.cur) { this.el.removeChild(this.el.firstChild); this.count--; }
      }
      this.cur.innerHTML = this.html(this.line);
    }
  }

  window.DashTerm = { TermModel };
})();
