// MERIDIAN Pascal IDE - code editor (textarea over a highlighted layer)

const KW = new Set(('and array asm begin case const div do downto else end file for function goto if ' +
  'implementation in interface label mod nil not of or packed procedure program record repeat set shl shr ' +
  'string then to type unit until uses var while with xor initialization finalization forward external absolute assembler').split(' '));
const TYPES = new Set(('integer word byte shortint longint longword cardinal smallint dword char boolean real ' +
  'single pointer ptruint ptrint shortstring true false').split(' '));
const BUILTIN = new Set(('write writeln read readln inc dec new dispose halt exit break continue str val include ' +
  'exclude getmem freemem ord chr succ pred low high sizeof length abs sqr odd hi lo swap trunc round assigned ' +
  'concat addr ptr sqrt int frac mem memw meml result copy pos delete insert upcase move fillchar random ' +
  'randomize inttostr sin cos arctan exp ln').split(' '));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// where the asm block starting at i ends: the word END outside ; comments,
// { } comments, "strings" and 'c' characters (compiler/lexer.js asmBlock)
function asmEnd(src, i) {
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ';') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '{') { const e = src.indexOf('}', i + 1); if (e < 0) return n; i = e + 1; continue; }
    if (c === '(' && src[i + 1] === '*') { const e = src.indexOf('*)', i + 2); if (e < 0) return n; i = e + 2; continue; }
    if (c === '"') { const e = src.indexOf('"', i + 1); i = e < 0 ? n : e + 1; continue; }
    if (c === "'" && src[i + 2] === "'") { i += 3; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      if (src.slice(i, j).toLowerCase() === 'end' && !/[.$%@]/.test(src[i - 1] || '')) return i;
      i = j; continue;
    }
    i++;
  }
  return n;
}

// the text of an asm block: the first word of an instruction (after a label)
// like a keyword, .directives, numbers, strings, comments
function highlightAsm(s) {
  const re = /(;[^\n]*|\{[^}]*\}?|\(\*[\s\S]*?(?:\*\)|$))|("[^"\n]*"?|'[^\n]')|(\$[0-9A-Fa-f]+|%[01]+|0x[0-9A-Fa-f]+|\d+)|(\.?[A-Za-z_][A-Za-z0-9_]*)(:?)|(\n)|([\s\S])/g;
  let out = '', first = true, m;
  while ((m = re.exec(s))) {
    if (m[1]) out += `<span class="t-com">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="t-str">${esc(m[2])}</span>`;
    else if (m[3]) { out += `<span class="t-num">${m[3]}</span>`; first = false; }
    else if (m[4]) {
      if (m[5]) out += m[4] + ':';                                  // a label
      else if (m[4][0] === '.') out += `<span class="t-dir">${m[4]}</span>`;
      else if (first) out += `<span class="t-kw">${m[4]}</span>`;
      else out += m[4];
      if (!m[5]) first = false;
    } else if (m[6]) { out += '\n'; first = true; }
    else out += esc(m[0]);
  }
  return out;
}

export function highlight(src) {
  const re = /(\{\$[^}]*\}|\(\*\$[\s\S]*?\*\))|(\{[^}]*\}?|\(\*[\s\S]*?(?:\*\)|$)|\/\/[^\n]*)|((?:'(?:[^'\n]|'')*'?|#\$?[0-9A-Fa-f]+)+)|(\$[0-9A-Fa-f]+|%[01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([^A-Za-z0-9_\s{('#$%/]+|[\s\S])/g;
  let out = '';
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) out += `<span class="t-dir">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="t-com">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="t-str">${esc(m[3])}</span>`;
    else if (m[4]) out += `<span class="t-num">${esc(m[4])}</span>`;
    else if (m[5]) {
      const w = m[5].toLowerCase();
      if (w === 'asm') {
        // an asm block: up to the word END (as the compiler's lexer finds it)
        out += `<span class="t-kw">${m[5]}</span>`;
        const e = asmEnd(src, re.lastIndex);
        out += highlightAsm(src.slice(re.lastIndex, e));
        re.lastIndex = e;
      } else if (KW.has(w)) out += `<span class="t-kw">${m[5]}</span>`;
      else if (TYPES.has(w)) out += `<span class="t-type">${m[5]}</span>`;
      else if (BUILTIN.has(w)) out += `<span class="t-fn">${m[5]}</span>`;
      else out += m[5];
    } else out += esc(m[0]);
  }
  return out;
}

export class Editor {
  constructor(host, opts = {}) {
    this.host = host;
    host.classList.add('ed');
    host.innerHTML = `<div class="ed-gutter"><div class="ed-lines"></div></div>
      <div class="ed-main"><div class="ed-marks"></div><pre class="ed-hl" aria-hidden="true"></pre>
      <textarea class="ed-ta" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea></div>`;
    this.ta = host.querySelector('.ed-ta');
    this.hl = host.querySelector('.ed-hl');
    this.lines = host.querySelector('.ed-lines');
    this.gutter = host.querySelector('.ed-gutter');
    this.marks = host.querySelector('.ed-marks');
    this.onChange = opts.onChange || (() => {});
    this.onCursor = opts.onCursor || (() => {});
    this.errors = [];
    this.lineCount = 0;
    this.pending = false;
    this.ta.addEventListener('input', () => { this.schedule(); this.onChange(); });
    this.ta.addEventListener('scroll', () => this.syncScroll());
    this.ta.addEventListener('keydown', (e) => this.keydown(e));
    for (const ev of ['keyup', 'click', 'select']) this.ta.addEventListener(ev, () => this.cursorMoved());
    this.setValue(opts.value || '');
  }

  get value() { return this.ta.value; }
  setValue(v, keepScroll) {
    const st = this.ta.scrollTop;
    this.ta.value = v;
    this.errors = [];
    this.render();
    if (keepScroll) this.ta.scrollTop = st; else { this.ta.scrollTop = 0; this.ta.setSelectionRange(0, 0); }
    this.syncScroll();
  }
  set readOnly(v) { this.ta.readOnly = v; this.host.classList.toggle('ed-ro', v); }
  focus() { this.ta.focus(); }

  schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.render(); });
  }
  render() {
    const v = this.ta.value;
    this.hl.innerHTML = highlight(v) + '\n';
    const n = v.split('\n').length;
    if (n !== this.lineCount) {
      this.lineCount = n;
      let s = '';
      for (let i = 1; i <= n; i++) s += `<div data-l="${i}">${i}</div>`;
      this.lines.innerHTML = s;
    }
    this.renderMarks();
    this.syncScroll();
  }
  lineHeight() {
    return parseFloat(getComputedStyle(this.ta).lineHeight) || 18;
  }
  renderMarks() {
    const lh = this.lineHeight();
    const pad = parseFloat(getComputedStyle(this.ta).paddingTop) || 0;
    let s = '';
    for (const e of this.errors) s += `<div class="ed-err" style="top:${pad + (e.line - 1) * lh}px;height:${lh}px" title="${esc(e.msg)}"></div>`;
    const cl = this.cursorLine();
    s += `<div class="ed-cur" style="top:${pad + (cl - 1) * lh}px;height:${lh}px"></div>`;
    this.marks.innerHTML = s;
    for (const d of this.lines.querySelectorAll('.err')) d.classList.remove('err');
    for (const e of this.errors) {
      const d = this.lines.querySelector(`[data-l="${e.line}"]`);
      if (d) { d.classList.add('err'); d.title = e.msg; }
    }
  }
  syncScroll() {
    const t = this.ta.scrollTop, l = this.ta.scrollLeft;
    this.hl.style.transform = `translate(${-l}px, ${-t}px)`;
    this.marks.style.transform = `translate(0, ${-t}px)`;
    this.lines.style.transform = `translateY(${-t}px)`;
  }
  setErrors(errs) { this.errors = errs || []; this.renderMarks(); }

  cursorLine() {
    const p = this.ta.selectionStart;
    let n = 1;
    const v = this.ta.value;
    for (let i = 0; i < p; i++) if (v.charCodeAt(i) === 10) n++;
    return n;
  }
  cursorPos() {
    const p = this.ta.selectionStart;
    const v = this.ta.value;
    const ls = v.lastIndexOf('\n', p - 1) + 1;
    return { line: this.cursorLine(), col: p - ls + 1 };
  }
  cursorMoved() {
    this.renderMarks();
    this.onCursor(this.cursorPos());
  }

  goTo(line, col = 1) {
    const v = this.ta.value;
    let p = 0;
    for (let l = 1; l < line && p >= 0; l++) { p = v.indexOf('\n', p); if (p < 0) { p = v.length; break; } p++; }
    p = Math.min(v.length, p + Math.max(0, col - 1));
    this.ta.focus();
    this.ta.setSelectionRange(p, p);
    const lh = this.lineHeight();
    const want = (line - 1) * lh - this.ta.clientHeight / 3;
    this.ta.scrollTop = Math.max(0, want);
    this.syncScroll();
    this.cursorMoved();
  }

  // replace selection range [a,b) with text, keep undo history when possible
  replace(a, b, text, selA, selB) {
    this.ta.focus();
    this.ta.setSelectionRange(a, b);
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
    if (!ok) {
      const v = this.ta.value;
      this.ta.value = v.slice(0, a) + text + v.slice(b);
      this.onChange();
    }
    if (selA !== undefined) this.ta.setSelectionRange(selA, selB === undefined ? selA : selB);
    this.schedule();
  }

  keydown(e) {
    const ta = this.ta;
    if (ta.readOnly) return;
    const v = ta.value;
    const s = ta.selectionStart, en = ta.selectionEnd;
    if (e.key === 'Tab') {
      e.preventDefault();
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      if (s === en && !e.shiftKey) { this.replace(s, en, '  '); return; }
      // indent / unindent lines of the selection
      const le = en > s && v[en - 1] === '\n' ? en - 1 : en;
      const block = v.slice(ls, le);
      const lines = block.split('\n');
      const out = lines.map(l => e.shiftKey ? l.replace(/^ {1,2}/, '') : '  ' + l).join('\n');
      this.replace(ls, le, out, ls, ls + out.length);
      return;
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      const line = v.slice(ls, s);
      let ind = /^\s*/.exec(line)[0];
      if (/\b(begin|do|then|else|repeat|record|of|var|const|type|try)\s*$/i.test(line.replace(/\{[^}]*\}|\/\/.*$/g, '').trimEnd())) ind += '  ';
      this.replace(s, en, '\n' + ind);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      let le = v.indexOf('\n', en > s ? en - 1 : en);
      if (le < 0) le = v.length;
      const lines = v.slice(ls, le).split('\n');
      const all = lines.every(l => /^\s*\/\//.test(l) || !l.trim());
      const out = lines.map(l => all ? l.replace(/^(\s*)\/\/ ?/, '$1') : (l.trim() ? l.replace(/^(\s*)/, '$1// ') : l)).join('\n');
      this.replace(ls, le, out, ls, ls + out.length);
      return;
    }
    // "end" typed: outdent to match the opening line
    if (e.key === 'd' && !e.ctrlKey && s === en) {
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      const before = v.slice(ls, s);
      if (/^\s+en$/i.test(before)) {
        const cur = before.length - 2;
        if (cur >= 2) {
          e.preventDefault();
          this.replace(ls, s, ' '.repeat(cur - 2) + before.trim() + 'd');
        }
      }
    }
  }

  find(text, from, backwards) {
    if (!text) return false;
    const v = this.ta.value.toLowerCase();
    const t = text.toLowerCase();
    let p = backwards ? v.lastIndexOf(t, (from === undefined ? this.ta.selectionStart : from) - 1) : v.indexOf(t, from === undefined ? this.ta.selectionEnd : from);
    if (p < 0) p = backwards ? v.lastIndexOf(t) : v.indexOf(t);
    if (p < 0) return false;
    this.ta.focus();
    this.ta.setSelectionRange(p, p + t.length);
    const line = this.ta.value.slice(0, p).split('\n').length;
    const lh = this.lineHeight();
    const top = (line - 1) * lh;
    if (top < this.ta.scrollTop || top > this.ta.scrollTop + this.ta.clientHeight - lh * 2) this.ta.scrollTop = Math.max(0, top - this.ta.clientHeight / 3);
    this.syncScroll();
    this.cursorMoved();
    return true;
  }
  replaceSel(text) {
    const s = this.ta.selectionStart, en = this.ta.selectionEnd;
    if (s === en) return false;
    this.replace(s, en, text);
    return true;
  }
}
