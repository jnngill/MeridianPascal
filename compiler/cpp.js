// MERIDIAN C - lexer and preprocessor
// Turns C source text into preprocessing tokens and runs the preprocessor
// over them: #include, #define (object and function-like, # and ##,
// variadic), #undef, #if/#ifdef/#ifndef/#elif/#else/#endif, #error,
// #pragma (unit NAME, link "file.c", once). The result is the token
// stream the C front end (cfront.js) parses.
//
// A pp-token: { k: 'id'|'num'|'str'|'chr'|'op'|'asm'|'eof', v: spelling,
//               pos: {file, line, col}, sp: whitespace before, bol: first on
//               its line, hide: Set of macro names (no re-expansion) }

import { CompileError } from './lexer.js';

const OPS = [
  '...', '<<=', '>>=',
  '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '*=', '/=', '%=',
  '+=', '-=', '&=', '^=', '|=', '##',
  '[', ']', '(', ')', '{', '}', '.', '&', '*', '+', '-', '~', '!', '/', '%', '<', '>',
  '^', '|', '?', ':', ';', '=', ',', '#',
];

// physical lines joined by backslash-newline; the lines taken away are put
// back after the joined line so the line numbers of what follows stay right
function splice(text) {
  if (!text.includes('\\')) return text;
  const lines = text.split('\n');
  const out = [];
  let cur = null, extra = 0;
  for (const raw of lines) {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (l.endsWith('\\')) { cur = (cur === null ? '' : cur) + l.slice(0, -1); extra++; continue; }
    out.push((cur === null ? '' : cur) + l);
    for (; extra > 0; extra--) out.push('');
    cur = null;
  }
  if (cur !== null) out.push(cur);
  return out.join('\n');
}

export function lexC(text, file) {
  text = splice(text);
  const toks = [];
  let i = 0, line = 1, lineStart = 0;
  let bol = true, sp = false;
  const n = text.length;
  const pos = (at) => ({ file, line, col: at - lineStart + 1 });
  const err = (msg, at) => { throw new CompileError(msg, pos(at)); };
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; lineStart = i; bol = true; sp = false; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; sp = true; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const at = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') { line++; lineStart = i + 1; }
        i++;
      }
      if (i >= n) err('unterminated comment', at);
      i += 2; sp = true; continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      sp = true; continue;
    }
    const start = i;
    const p = pos(i);
    const push = (k, v) => { toks.push({ k, v, pos: p, sp, bol, hide: null }); bol = false; sp = false; };
    if (/[A-Za-z_$]/.test(c)) {
      while (i < n && /[\w$]/.test(text[i])) i++;
      let v = text.slice(start, i);
      // wide / prefixed literals: L'x' L"x" u8"x" - the prefix is dropped
      if ((v === 'L' || v === 'u' || v === 'U' || v === 'u8') && (text[i] === '"' || text[i] === "'")) {
        continue;   // the literal follows as its own token
      }
      // asm { ... } : the raw text up to the closing brace
      if (v === 'asm' || v === '__asm' || v === '__asm__') {
        let j = i;
        while (j < n && /[ \t\r\n]/.test(text[j])) j++;
        if (text[j] === '{') {
          const open = j;
          let k = j + 1;
          while (k < n && text[k] !== '}') k++;
          if (k >= n) err('asm block without its closing }', open);
          const body = text.slice(open + 1, k);
          const t = { k: 'asm', v: body, pos: p, sp, bol, hide: null, bodyLine: line + (text.slice(i, open + 1).split('\n').length - 1) };
          toks.push(t); bol = false; sp = false;
          for (let q = i; q < k; q++) if (text[q] === '\n') { line++; lineStart = q + 1; }
          i = k + 1;
          continue;
        }
      }
      push('id', v);
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      i++;
      while (i < n) {
        const d = text[i];
        if ((d === '+' || d === '-') && (/[pP]/.test(text[i - 1]) || (/[eE]/.test(text[i - 1]) && !/^0[xX]/.test(text.slice(start, i))))) { i++; continue; }
        if (/[\w.]/.test(d)) { i++; continue; }
        break;
      }
      push('num', text.slice(start, i));
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && text[i] !== c) {
        if (text[i] === '\\') i++;
        if (text[i] === '\n') err(c === '"' ? 'unterminated string' : 'unterminated character constant', start);
        i++;
      }
      if (i >= n) err(c === '"' ? 'unterminated string' : 'unterminated character constant', start);
      i++;
      push(c === '"' ? 'str' : 'chr', text.slice(start, i));
      continue;
    }
    let op = null;
    for (const o of OPS) if (text.startsWith(o, i)) { op = o; break; }
    if (!op) err(`unexpected character '${c}'`, i);
    i += op.length;
    push('op', op);
  }
  toks.push({ k: 'eof', v: '', pos: { file, line, col: i - lineStart + 1 }, sp: false, bol: true, hide: null });
  return toks;
}

// ----------------------------------------------------------- literals
// the value of a C escape sequence at s[i] (after the backslash)
export function unescape(s, file, pos) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out.push(c.charCodeAt(0) & 255); continue; }
    const d = s[++i];
    switch (d) {
      case 'n': out.push(10); break;
      case 't': out.push(9); break;
      case 'r': out.push(13); break;
      case 'a': out.push(7); break;
      case 'b': out.push(8); break;
      case 'f': out.push(12); break;
      case 'v': out.push(11); break;
      case 'e': out.push(27); break;
      case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': {
        let v = 0, k = 0;
        while (k < 3 && /[0-7]/.test(s[i] || '')) { v = v * 8 + (+s[i]); i++; k++; }
        i--;
        out.push(v & 255);
        break;
      }
      case 'x': {
        let v = 0, k = 0;
        i++;
        while (/[0-9a-fA-F]/.test(s[i] || '')) { v = v * 16 + parseInt(s[i], 16); i++; k++; }
        if (!k) throw new CompileError('\\x used with no following hex digits', pos);
        i--;
        out.push(v & 255);
        break;
      }
      default: out.push((d || '\\').charCodeAt(0) & 255);
    }
  }
  return out;
}

// ------------------------------------------------------------- the preprocessor
export class Preprocessor {
  // opts.defines: {name: value}; opts.loadInclude(name, fromFile, system) -> {text, name} | null
  constructor(opts = {}) {
    this.macros = new Map();
    this.loadInclude = opts.loadInclude || (() => null);
    this.frames = [];
    this.pending = [];
    this.pragmas = [];       // {kind: 'unit'|'link', v, pos}
    this.once = new Set();
    this.warnings = [];
    this.noRaw = 0;
    for (const [k, v] of Object.entries(opts.defines || {})) this.define(k, String(v));
  }

  define(name, text) {
    const body = lexC(text, '<command line>').filter(t => t.k !== 'eof');
    for (const t of body) { t.bol = false; }
    this.macros.set(name, { name, fn: false, params: [], body });
  }

  err(msg, pos) { throw new CompileError(msg, pos); }

  // the whole program text -> tokens after preprocessing
  run(text, file) {
    this.pushFile(text, file, null);
    const out = [];
    for (;;) {
      const t = this.next();
      if (t.k === 'eof') { out.push(t); break; }
      out.push(t);
    }
    return out;
  }

  pushFile(text, file, pos) {
    if (this.frames.length > 40) this.err('#include nested too deeply', pos);
    this.frames.push({ toks: lexC(text, file), i: 0, file, conds: [] });
  }

  get frame() { return this.frames[this.frames.length - 1]; }
  active() { return this.frame.conds.every(c => c.active); }

  // next token from the files (directives handled), unexpanded
  rawNext() {
    for (;;) {
      const f = this.frame;
      if (!f) return { k: 'eof', v: '', pos: { file: '', line: 0, col: 0 }, hide: null };
      const t = f.toks[f.i];
      if (t.k === 'eof') {
        if (f.conds.length) this.err('#if without #endif', f.conds[f.conds.length - 1].pos);
        if (this.frames.length === 1) return t;
        this.frames.pop();
        continue;
      }
      if (t.k === 'op' && t.v === '#' && t.bol) {
        f.i++;
        const line = [];
        while (!f.toks[f.i].bol && f.toks[f.i].k !== 'eof') line.push(f.toks[f.i++]);
        this.directive(t, line);
        continue;
      }
      f.i++;
      if (!this.active()) continue;
      return t;
    }
  }

  directive(hash, line) {
    const f = this.frame;
    if (!line.length) return;                     // the null directive
    const d = line[0];
    const name = d.k === 'id' || d.k === 'num' ? d.v : '';
    const rest = line.slice(1);
    const act = this.active();
    switch (name) {
      case 'if': case 'ifdef': case 'ifndef': {
        if (!act) { f.conds.push({ active: false, taken: true, pos: d.pos }); return; }
        let v;
        if (name === 'if') v = this.evalIf(rest, d.pos);
        else {
          if (!rest.length || rest[0].k !== 'id') this.err(`#${name} needs a macro name`, d.pos);
          v = this.macros.has(rest[0].v);
          if (name === 'ifndef') v = !v;
        }
        f.conds.push({ active: !!v, taken: !!v, pos: d.pos });
        return;
      }
      case 'elif': {
        const c = f.conds[f.conds.length - 1];
        if (!c) this.err('#elif without #if', d.pos);
        if (c.sawElse) this.err('#elif after #else', d.pos);
        const outer = f.conds.slice(0, -1).every(x => x.active);
        if (c.taken || !outer) { c.active = false; return; }
        c.active = !!this.evalIf(rest, d.pos);
        c.taken = c.active;
        return;
      }
      case 'else': {
        const c = f.conds[f.conds.length - 1];
        if (!c) this.err('#else without #if', d.pos);
        if (c.sawElse) this.err('#else after #else', d.pos);
        c.sawElse = true;
        c.active = !c.taken;
        c.taken = true;
        return;
      }
      case 'endif':
        if (!f.conds.length) this.err('#endif without #if', d.pos);
        f.conds.pop();
        return;
    }
    if (!act) return;
    switch (name) {
      case 'define': return this.parseDefine(rest, d.pos);
      case 'undef':
        if (!rest.length || rest[0].k !== 'id') this.err('#undef needs a macro name', d.pos);
        this.macros.delete(rest[0].v);
        return;
      case 'include': return this.include(rest, d.pos);
      case 'error':
        this.err(`#error ${rest.map(t => (t.sp ? ' ' : '') + t.v).join('').trim()}`, d.pos);
        return;
      case 'warning':
        this.warnings.push({ msg: rest.map(t => (t.sp ? ' ' : '') + t.v).join('').trim(), pos: d.pos });
        return;
      case 'line': return;
      case 'pragma': {
        if (!rest.length) return;
        const p = rest[0].v;
        if (p === 'once') { this.once.add(f.file); return; }
        if (p === 'unit' && rest[1] && rest[1].k === 'id') { this.pragmas.push({ kind: 'unit', v: rest[1].v.toLowerCase(), pos: d.pos }); return; }
        if (p === 'link' && rest[1] && rest[1].k === 'str') { this.pragmas.push({ kind: 'link', v: rest[1].v.slice(1, -1), pos: d.pos, from: f.file }); return; }
        return;     // other pragmas are ignored
      }
    }
    this.err(`unknown directive #${name}`, d.pos);
  }

  parseDefine(rest, pos) {
    if (!rest.length || rest[0].k !== 'id') this.err('#define needs a macro name', pos);
    const nm = rest[0];
    let i = 1;
    const m = { name: nm.v, fn: false, params: [], variadic: false, body: [] };
    if (rest[1] && rest[1].k === 'op' && rest[1].v === '(' && !rest[1].sp) {
      m.fn = true;
      i = 2;
      if (!(rest[i] && rest[i].v === ')')) {
        for (;;) {
          const t = rest[i++];
          if (!t) this.err('unterminated macro parameter list', pos);
          if (t.k === 'op' && t.v === '...') { m.variadic = true; m.params.push('__VA_ARGS__'); }
          else if (t.k === 'id') {
            if (rest[i] && rest[i].v === '...') { i++; m.variadic = true; }
            m.params.push(t.v);
          } else this.err(`macro parameter name expected, '${t.v}' found`, t.pos);
          const s = rest[i++];
          if (!s) this.err('unterminated macro parameter list', pos);
          if (s.v === ')') break;
          if (s.v !== ',') this.err(`',' or ')' expected in the parameters of ${nm.v}`, s.pos);
          if (m.variadic) this.err('... must be the last macro parameter', s.pos);
        }
      } else i++;
    }
    m.body = rest.slice(i).map(t => ({ ...t, bol: false }));
    if (m.body.length) m.body[0].sp = false;
    this.macros.set(nm.v, m);
  }

  include(rest, pos) {
    let name = null, system = false;
    let toks = rest;
    if (toks.length && !(toks[0].k === 'str' || (toks[0].k === 'op' && toks[0].v === '<'))) toks = this.expandList(toks);
    if (toks.length && toks[0].k === 'str') name = toks[0].v.slice(1, -1);
    else if (toks.length && toks[0].v === '<') {
      system = true;
      name = '';
      let j = 1;
      for (; j < toks.length && toks[j].v !== '>'; j++) name += (toks[j].sp && name ? ' ' : '') + toks[j].v;
      if (j >= toks.length) this.err("#include <...> without '>'", pos);
    }
    if (!name) this.err('#include needs a file name', pos);
    const src = this.loadInclude(name, this.frame.file, system);
    if (!src) this.err(`include file '${name}' not found`, pos);
    if (this.once.has(src.name)) return;
    this.pushFile(src.text, src.name, pos);
  }

  // #if: defined, then macros, then the rest of the names are 0
  evalIf(toks, pos) {
    const t1 = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.k === 'id' && t.v === 'defined') {
        let nm, j = i + 1;
        if (toks[j] && toks[j].v === '(') { nm = toks[j + 1]; if (!toks[j + 2] || toks[j + 2].v !== ')') this.err("')' expected after defined(", pos); i = j + 2; }
        else { nm = toks[j]; i = j; }
        if (!nm || nm.k !== 'id') this.err('macro name expected after defined', pos);
        t1.push({ k: 'num', v: this.macros.has(nm.v) ? '1' : '0', pos: t.pos, hide: null });
        continue;
      }
      t1.push(t);
    }
    const ex = this.expandList(t1);
    let p = 0;
    const peek = () => ex[p];
    const isOp = (v) => ex[p] && ex[p].k === 'op' && ex[p].v === v;
    const val = (t) => {
      if (t.k === 'num') {
        const s = t.v.replace(/[uUlL]+$/, '');
        if (/^0[xX]/.test(s)) return parseInt(s.slice(2), 16);
        if (/^0[bB]/.test(s)) return parseInt(s.slice(2), 2);
        if (/^0[0-7]+$/.test(s)) return parseInt(s, 8);
        if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
        this.err(`bad number '${t.v}' in #if`, t.pos);
      }
      if (t.k === 'chr') { const b = unescape(t.v.slice(1, -1), '', t.pos); return b[0] || 0; }
      if (t.k === 'id') return 0;
      this.err(`'${t.v}' in #if`, t.pos);
    };
    const prim = () => {
      const t = ex[p++];
      if (!t) this.err('#if expression ends too soon', pos);
      if (t.k === 'op') {
        if (t.v === '(') { const v = cond(); if (!isOp(')')) this.err("')' expected in #if", pos); p++; return v; }
        if (t.v === '!') return prim() ? 0 : 1;
        if (t.v === '-') return -prim();
        if (t.v === '+') return prim();
        if (t.v === '~') return ~prim();
        this.err(`'${t.v}' in #if`, t.pos);
      }
      return val(t);
    };
    const BIN = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
    const bin = (lv) => {
      if (lv >= BIN.length) return prim();
      let a = bin(lv + 1);
      while (ex[p] && ex[p].k === 'op' && BIN[lv].includes(ex[p].v)) {
        const op = ex[p++].v;
        const b = bin(lv + 1);
        switch (op) {
          case '||': a = (a || b) ? 1 : 0; break;
          case '&&': a = (a && b) ? 1 : 0; break;
          case '|': a = a | b; break;
          case '^': a = a ^ b; break;
          case '&': a = a & b; break;
          case '==': a = a === b ? 1 : 0; break;
          case '!=': a = a !== b ? 1 : 0; break;
          case '<': a = a < b ? 1 : 0; break;
          case '>': a = a > b ? 1 : 0; break;
          case '<=': a = a <= b ? 1 : 0; break;
          case '>=': a = a >= b ? 1 : 0; break;
          case '<<': a = a << b; break;
          case '>>': a = a >> b; break;
          case '+': a = a + b; break;
          case '-': a = a - b; break;
          case '*': a = a * b; break;
          case '/': if (!b) this.err('division by zero in #if', pos); a = Math.trunc(a / b); break;
          case '%': if (!b) this.err('division by zero in #if', pos); a = a % b; break;
        }
      }
      return a;
    };
    const cond = () => {
      const c = bin(0);
      if (isOp('?')) {
        p++;
        const a = cond();
        if (!isOp(':')) this.err("':' expected in #if", pos);
        p++;
        const b = cond();
        return c ? a : b;
      }
      return c;
    };
    if (!ex.length) this.err('#if with no expression', pos);
    const v = cond();
    if (p < ex.length) this.err(`'${ex[p].v}' unexpected in #if`, ex[p].pos);
    return v;
  }

  // ---- macro expansion
  srcNext() {
    if (this.pending.length) return this.pending.pop();
    if (this.noRaw) return { k: 'eof', v: '', pos: null, hide: null, end: true };
    return this.rawNext();
  }
  srcPeek() {
    if (this.pending.length) return this.pending[this.pending.length - 1];
    if (this.noRaw) return null;
    const t = this.rawNext();
    this.pending.push(t);
    return t;
  }

  // the next token after macro expansion
  next() {
    for (;;) {
      const t = this.srcNext();
      if (t.k !== 'id') return t;
      if (t.v === '__LINE__') return { ...t, k: 'num', v: String(t.pos ? t.pos.line : 0) };
      if (t.v === '__FILE__') return { ...t, k: 'str', v: JSON.stringify((t.pos && t.pos.file || '').split(/[\\/]/).pop()) };
      const m = this.macros.get(t.v);
      if (!m || (t.hide && t.hide.has(t.v))) return t;
      let args = null;
      if (m.fn) {
        const n = this.srcPeek();
        if (!n || n.k !== 'op' || n.v !== '(') return t;
        this.srcNext();
        args = this.collectArgs(m, t);
      }
      const hide = new Set(t.hide || []);
      hide.add(m.name);
      const body = this.subst(m, args, hide, t);
      for (let i = body.length - 1; i >= 0; i--) this.pending.push(body[i]);
    }
  }

  collectArgs(m, t) {
    const args = [[]];
    let depth = 0;
    for (;;) {
      const a = this.srcNext();
      if (a.k === 'eof') this.err(`unterminated call of macro ${m.name}`, t.pos);
      if (a.k === 'op') {
        if (a.v === '(') depth++;
        else if (a.v === ')') { if (depth === 0) break; depth--; }
        else if (a.v === ',' && depth === 0 && !(m.variadic && args.length >= m.params.length)) { args.push([]); continue; }
      }
      args[args.length - 1].push(a);
    }
    if (m.params.length === 0 && args.length === 1 && args[0].length === 0) return [];
    if (m.variadic && args.length === m.params.length - 1) args.push([]);
    if (args.length !== m.params.length) this.err(`macro ${m.name} takes ${m.params.length} argument${m.params.length === 1 ? '' : 's'}, ${args.length} given`, t.pos);
    return args;
  }

  // fully expand a list of tokens on its own
  expandList(toks) {
    const saved = this.pending;
    this.pending = [];
    for (let i = toks.length - 1; i >= 0; i--) this.pending.push(toks[i]);
    this.noRaw++;
    const out = [];
    try {
      for (;;) {
        const t = this.next();
        if (t.k === 'eof' && t.end) break;
        out.push(t);
      }
    } finally {
      this.noRaw--;
      this.pending = saved;
    }
    return out;
  }

  subst(m, args, hide, inv) {
    const body = m.body;
    const pi = (t) => (m.fn && t.k === 'id') ? m.params.indexOf(t.v) : -1;
    const out = [];
    const expanded = new Map();
    for (let i = 0; i < body.length; i++) {
      const t = body[i];
      if (m.fn && t.k === 'op' && t.v === '#' && body[i + 1] && pi(body[i + 1]) >= 0) {
        const a = args[pi(body[i + 1])];
        let s = '';
        a.forEach((x, k) => { s += (k && x.sp ? ' ' : '') + x.v; });
        out.push({ k: 'str', v: '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"', pos: inv.pos, sp: t.sp, hide: null });
        i++;
        continue;
      }
      const k = pi(t);
      if (k >= 0) {
        const pasteNext = body[i + 1] && body[i + 1].k === 'op' && body[i + 1].v === '##';
        const pastePrev = i > 0 && body[i - 1].k === 'op' && body[i - 1].v === '##';
        let rep;
        if (pasteNext || pastePrev) rep = args[k].map(x => ({ ...x }));
        else {
          if (!expanded.has(k)) expanded.set(k, this.expandList(args[k]));
          rep = expanded.get(k).map(x => ({ ...x }));
        }
        if (!rep.length) out.push({ k: 'placemarker', v: '', pos: inv.pos, hide: null, va: t.v === '__VA_ARGS__' });
        else { rep[0] = { ...rep[0], sp: t.sp }; out.push(...rep); }
        continue;
      }
      if (t.k === 'op' && t.v === '##') { out.push({ ...t, paste: true }); continue; }
      out.push({ ...t });
    }
    // ## : paste the tokens on both sides into one
    const res = [];
    for (let i = 0; i < out.length; i++) {
      const t = out[i];
      if (t.paste && res.length && i + 1 < out.length) {
        const l = res.pop(), r = out[++i];
        if (l.k === 'op' && l.v === ',' && r.k === 'placemarker' && r.va) continue;   // , ## __VA_ARGS__
        if (l.k === 'placemarker') { res.push(r); continue; }
        if (r.k === 'placemarker') { res.push(l); continue; }
        const s = l.v + r.v;
        const lx = lexC(s, inv.pos.file).filter(x => x.k !== 'eof');
        if (lx.length !== 1) this.err(`pasting '${l.v}' and '${r.v}' does not give a valid token`, inv.pos);
        res.push({ ...lx[0], pos: l.pos, sp: l.sp, hide: null });
        continue;
      }
      res.push(t);
    }
    const fin = res.filter(t => t.k !== 'placemarker');
    for (const t of fin) {
      const h = new Set(t.hide || []);
      for (const x of hide) h.add(x);
      t.hide = h;
      t.bol = false;
      t.pos = inv.pos;
    }
    if (fin.length) fin[0].sp = inv.sp;
    return fin;
  }
}
