// Minimal, dependency-free Markdown renderer.
// Raw HTML is always escaped. Task checkboxes carry data-line (0-based source line).
'use strict';
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
  const blank = (t) => /^\s*$/.test(t);
  const leadW = (t) => t.length - t.replace(/^\s+/, '').length;

  function slug(s) {
    return s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
  }

  function isBlockStart(t) {
    return /^\s{0,3}(#{1,6}\s|```|~~~|>|([-*_])(\s*\2){2,}\s*$)/.test(t) || LIST_RE.test(t) && !/^\s*\d{1,9}[.)]\S/.test(t);
  }

  function splitRow(row) {
    let s = row.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
      if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  function createRenderer(opts) {
    opts = opts || {};
    const resolveImg = opts.resolveImg || ((s) => s);

    function inline(src) {
      const keep = [];
      const hold = (html) => { keep.push(html); return '\u0000' + (keep.length - 1) + '\u0000'; };
      let s = src;
      // backslash escapes
      s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|~<>])/g, (_, c) => hold(esc(c)));
      // code spans
      s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, a, c) => hold('<code>' + esc(c.length > 2 && c[0] === ' ' && c[c.length - 1] === ' ' ? c.slice(1, -1) : c) + '</code>'));
      s = esc(s);
      // images then links
      s = s.replace(/!\[([^\]]*)\]\(\s*(?:&lt;)?([^\s)]*?)(?:&gt;)?(?:\s+&quot;(.*?)&quot;)?\s*\)/g, (_, alt, url, title) =>
        hold('<img src="' + esc(resolveImg(decodeEnt(url))) + '" alt="' + alt + '"' + (title ? ' title="' + title + '"' : '') + ' loading="lazy">'));
      s = s.replace(/\[([^\]]+)\]\(\s*(?:&lt;)?([^\s)]*?)(?:&gt;)?(?:\s+&quot;(.*?)&quot;)?\s*\)/g, (_, txt, url, title) =>
        hold('<a href="#" data-href="' + url + '"' + (title ? ' title="' + title + '"' : ' title="' + url + '"') + '>') + txt + hold('</a>'));
      s = s.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, (_, u) => hold('<a href="#" data-href="' + u + '" title="' + u + '">' + u + '</a>'));
      s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (_, pre, u) => pre + hold('<a href="#" data-href="' + u + '" title="' + u + '">' + u + '</a>'));
      // emphasis
      s = s.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>');
      s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
      s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>');
      s = s.replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
      s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
      s = s.replace(/==(?=\S)([^=]*?\S)==/g, '<mark>$1</mark>');
      // hard breaks
      s = s.replace(/( {2,}|\\)\n/g, '<br>');
      s = s.replace(/\n/g, ' ');
      for (let k = 0; k < 3 && s.includes('\u0000'); k++) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
      return s;
    }

    function decodeEnt(s) {
      return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    }

    function parseList(L, i, loose0) {
      const m0 = L[i].t.match(LIST_RE);
      const base = m0[1].length;
      const ordered = /\d/.test(m0[2]);
      const start = ordered ? parseInt(m0[2], 10) : 1;
      const items = [];
      let loose = false;
      while (i < L.length) {
        const m = L[i].t.match(LIST_RE);
        if (!m) break;
        const ind = m[1].length;
        if (ind < base || ind > base + 1) break;
        if (/\d/.test(m[2]) !== ordered) break;
        const offset = m[1].length + m[2].length + Math.max(1, Math.min(m[3].length || 1, 4));
        const sub = [{ t: m[4], ln: L[i].ln }];
        const itemLn = L[i].ln;
        i++;
        let lastWasText = true;
        while (i < L.length) {
          const t = L[i].t;
          if (blank(t)) {
            let j = i + 1;
            while (j < L.length && blank(L[j].t)) j++;
            if (j < L.length && leadW(L[j].t) > base) {
              while (i < j) { sub.push({ t: '', ln: L[i].ln }); i++; }
              loose = loose || !LIST_RE.test(L[j].t);
              lastWasText = false;
              continue;
            }
            if (j < L.length && LIST_RE.test(L[j].t) && leadW(L[j].t) <= base + 1 && leadW(L[j].t) >= base && /\d/.test(L[j].t.match(LIST_RE)[2]) === ordered) loose = true;
            i = j;
            break;
          }
          const w = leadW(t);
          if (w > base) {
            const cut = Math.min(w, offset);
            sub.push({ t: t.slice(cut), ln: L[i].ln });
            lastWasText = !LIST_RE.test(t) && !isBlockStart(t);
            i++;
            continue;
          }
          if (lastWasText && !LIST_RE.test(t) && !isBlockStart(t)) { // lazy continuation
            sub.push({ t: t.trim(), ln: L[i].ln });
            i++;
            continue;
          }
          break;
        }
        items.push({ sub, ln: itemLn });
      }
      let html = ordered ? (start !== 1 ? '<ol start="' + start + '">' : '<ol>') : '<ul>';
      for (const it of items) {
        let first = it.sub[0].t;
        let cls = '';
        let box = '';
        const tm = first.match(/^\[([ xX])\](?:\s+|$)(.*)$/);
        if (tm) {
          const done = tm[1] !== ' ';
          cls = ' class="task' + (done ? ' done' : '') + '"';
          box = '<input type="checkbox" data-line="' + it.ln + '"' + (done ? ' checked' : '') + '> ';
          first = tm[2];
        }
        // first paragraph = first line + following text lines
        const para = [first];
        let k = 1;
        while (k < it.sub.length && !blank(it.sub[k].t) && !isBlockStart(it.sub[k].t)) { para.push(it.sub[k].t); k++; }
        const rest = it.sub.slice(k);
        let body = inline(para.join('\n'));
        if (loose && body) body = '<p>' + body + '</p>';
        html += '<li' + cls + ' data-line="' + it.ln + '">' + box + body + (rest.some((r) => !blank(r.t)) ? blocks(rest) : '') + '</li>';
      }
      html += ordered ? '</ol>' : '</ul>';
      return { html, next: i };
    }

    function blocks(L) {
      let out = '';
      let i = 0;
      while (i < L.length) {
        const t = L[i].t;
        if (blank(t)) { i++; continue; }
        let m;
        if ((m = t.match(/^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)?.*$/))) {
          const fence = m[2];
          const lang = m[3] || '';
          const ind = m[1].length;
          const buf = [];
          const ln = L[i].ln;
          i++;
          while (i < L.length && !(L[i].t.trim().startsWith(fence) && L[i].t.trim().replace(/[`~]/g, '') === '')) {
            const line = L[i].t;
            buf.push(line.slice(Math.min(ind, leadW(line))));
            i++;
          }
          i++;
          out += '<pre data-line="' + ln + '"><code' + (lang ? ' class="lang-' + esc(lang) + '"' : '') + '>' + esc(buf.join('\n')) + '</code></pre>';
          continue;
        }
        if ((m = t.match(/^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/)) || (m = t.match(/^\s{0,3}(#{1,6})$/))) {
          const lvl = m[1].length;
          const txt = m[2] || '';
          out += '<h' + lvl + ' id="' + esc(slug(txt)) + '" data-line="' + L[i].ln + '">' + inline(txt) + '</h' + lvl + '>';
          i++;
          continue;
        }
        if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(t)) { out += '<hr>'; i++; continue; }
        if (/^\s{0,3}>/.test(t)) {
          const buf = [];
          while (i < L.length && (/^\s{0,3}>/.test(L[i].t) || (!blank(L[i].t) && buf.length && !isBlockStart(L[i].t)))) {
            buf.push({ t: L[i].t.replace(/^\s{0,3}>\s?/, ''), ln: L[i].ln });
            i++;
          }
          const inner = blocks(buf);
          const alert = inner.match(/^<p data-line="\d+">\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i);
          if (alert) {
            const kind = alert[1].toLowerCase();
            out += '<blockquote class="alert alert-' + kind + '"><div class="alert-title">' + alert[1].toUpperCase() + '</div>' + inner.replace(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(<br>)?/i, '') + '</blockquote>';
          } else out += '<blockquote>' + inner + '</blockquote>';
          continue;
        }
        if (t.includes('|') && i + 1 < L.length) {
          const sep = L[i + 1].t;
          if (/^[\s|:-]+$/.test(sep) && sep.includes('-') && (sep.includes('|') || t.trim().startsWith('|'))) {
            const head = splitRow(t);
            const al = splitRow(sep).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
            let h = '<div class="table-wrap"><table data-line="' + L[i].ln + '"><thead><tr>';
            head.forEach((c, k) => { h += '<th' + (al[k] ? ' style="text-align:' + al[k] + '"' : '') + '>' + inline(c) + '</th>'; });
            h += '</tr></thead><tbody>';
            i += 2;
            while (i < L.length && !blank(L[i].t) && L[i].t.includes('|')) {
              const row = splitRow(L[i].t);
              h += '<tr>';
              for (let k = 0; k < head.length; k++) h += '<td' + (al[k] ? ' style="text-align:' + al[k] + '"' : '') + '>' + inline(row[k] || '') + '</td>';
              h += '</tr>';
              i++;
            }
            out += h + '</tbody></table></div>';
            continue;
          }
        }
        if (LIST_RE.test(t) && !/^\s*\d{1,9}[.)]\S/.test(t)) {
          const r = parseList(L, i);
          out += r.html;
          i = r.next;
          continue;
        }
        const ln = L[i].ln;
        const buf = [t];
        i++;
        while (i < L.length && !blank(L[i].t) && !isBlockStart(L[i].t)) {
          // a table starting mid-paragraph
          if (L[i].t.includes('|') && i + 1 < L.length && /^[\s|:-]+$/.test(L[i + 1].t) && L[i + 1].t.includes('-')) break;
          buf.push(L[i].t);
          i++;
        }
        // setext headings
        if (buf.length > 1 && /^\s{0,3}(=+|-+)\s*$/.test(buf[buf.length - 1])) {
          const lvl = buf[buf.length - 1].trim()[0] === '=' ? 1 : 2;
          const txt = buf.slice(0, -1).join('\n');
          out += '<h' + lvl + ' id="' + esc(slug(txt)) + '" data-line="' + ln + '">' + inline(txt) + '</h' + lvl + '>';
          continue;
        }
        out += '<p data-line="' + ln + '">' + inline(buf.join('\n')) + '</p>';
      }
      return out;
    }

    return function render(src) {
      const lines = String(src).replace(/\r\n?/g, '\n').split('\n').map((t, ln) => ({
        t: t.replace(/^[\t ]+/, (w) => w.replace(/\t/g, '    ')),
        ln,
      }));
      // YAML front matter
      let start = 0;
      let front = '';
      if (lines.length && lines[0].t === '---') {
        const end = lines.findIndex((l, k) => k > 0 && (l.t === '---' || l.t === '...'));
        if (end > 0) {
          front = '<pre class="front-matter"><code>' + esc(lines.slice(1, end).map((l) => l.t).join('\n')) + '</code></pre>';
          start = end + 1;
        }
      }
      return front + blocks(lines.slice(start));
    };
  }

  window.DashMD = { createRenderer, esc, slug };
})();
