'use strict';
// Tiny, safe markdown renderer for assistant replies. Everything is HTML-escaped first, so
// model output can never inject markup; only http(s)/mailto links are allowed.
(function (root) {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

  function inline(src) {
    const codes = [];
    let s = src.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = esc(s);
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
  }

  function render(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
        i++; // closing fence (or end of a still-streaming block)
        out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
        continue;
      }
      if (/^\s*$/.test(line)) { i++; continue; }
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) { out.push(`<p class="md-h">${inline(heading[2])}</p>`); i++; continue; }
      if (/^\s*([-*_])\1\1+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^>\s?/.test(line)) {
        const q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`);
        continue;
      }
      const ul = /^\s*[-*+]\s+/;
      const ol = /^\s*\d+[.)]\s+/;
      if (ul.test(line) || ol.test(line)) {
        const ordered = ol.test(line);
        const re = ordered ? ol : ul;
        const items = [];
        while (i < lines.length && re.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(re, ''))}</li>`);
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      const para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^```/.test(lines[i]) && !/^(#{1,4})\s+/.test(lines[i]) && !ul.test(lines[i]) && !ol.test(lines[i]) && !/^>\s?/.test(lines[i])) para.push(lines[i++]);
      out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }
    return out.join('');
  }

  const api = { render, esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MuserMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
