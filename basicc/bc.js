#!/usr/bin/env node
// MERIDIAN BASIC compiler (prototype). Reads a MERIDIAN BASIC program as
// text, the way it is typed (line numbers, Microsoft BASIC 1.1 rules), and
// translates it to Pascal, which MERIDIAN Pascal compiles for the 65C816.
//   node basicc/bc.js PROG.BAS [-o PROG.MER] [--pas]
//
// What it does differently from the interpreter, on purpose:
//  - a numeric variable that only ever holds whole numbers is a 32-bit
//    integer; the others are reals (IEEE single, ~7 digits, not 9)
//  - FOR/NEXT, WHILE/WEND and REPEAT/UNTIL are matched when compiling
//  - arrays need DIM with constant sizes (or get the default 10)
// The MERIDIAN commands call the same kernel routines BASIC calls.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../compiler/compile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

export class BasicError extends Error {
  constructor(msg, line) { super(line !== undefined ? `line ${line}: ${msg}` : msg); this.line = line; }
}

// keyword lists in BASIC's search order: Microsoft's, then MERIDIAN's
const MS_KW = ['END', 'FOR', 'NEXT', 'DATA', 'INPUT', 'DIM', 'READ', 'LET', 'GOTO', 'RUN', 'IF', 'RESTORE', 'GOSUB',
  'RETURN', 'REM', 'STOP', 'ON', 'WAIT', 'LOAD', 'SAVE', 'DEF', 'POKE', 'PRINT', 'CONT', 'LIST', 'CLEAR', 'GET', 'NEW',
  'TAB(', 'TO', 'FN', 'SPC(', 'THEN', 'NOT', 'STEP', '+', '-', '*', '/', '^', 'AND', 'OR', '>', '=', '<', 'SGN', 'INT',
  'ABS', 'USR', 'FRE', 'POS', 'SQR', 'RND', 'LOG', 'EXP', 'COS', 'SIN', 'TAN', 'ATN', 'PEEK', 'LEN', 'STR$', 'VAL',
  'ASC', 'CHR$', 'LEFT$', 'RIGHT$', 'MID$', 'GO'];
const M_KW = ['MONITOR', 'CLS', 'COLOR', 'MODE', 'GRAPHIC', 'PLOT', 'LINE', 'SOUND', 'SILENCE', 'PAUSE', 'PALETTE',
  'BLIT', 'STAMP', 'SPRITE', 'PATTERN', 'SAMPLE', 'GRADIENT', 'DIR', 'SCRATCH', 'BLOAD', 'BSAVE', 'HEADER', 'DRIVE',
  'PLAY', 'MOUSE', 'JOY', 'KEY', 'HIT', 'CLOCK', 'NET$', 'NET', 'ELSE', 'WHILE', 'WEND', 'REPEAT', 'UNTIL', 'RENUMBER',
  'SONG', 'SHINE', 'GLOW', 'INK', 'MAP', 'TILE', 'SFX', 'LOOK'];
const KEYWORDS = [...MS_KW, ...M_KW];

// MERIDIAN commands that are only numbers for the kernel: number, most values
const KCMDS = { BLIT: [0, 3], STAMP: [1, 5], SPRITE: [2, 5], GRADIENT: [5, 8], MOUSE: [14, 2], PALETTE: [28, 4] };
// MERIDIAN functions: kernel function number
const KFUNCS = { MOUSE: 0, JOY: 1, KEY: 2, HIT: 3, CLOCK: 4 };

// ---------------------------------------------------------------- lexing
// Microsoft's CRUNCH: keywords are found anywhere outside strings, also
// inside names (SCORE is SC OR E); digits, ':' ';' and spaces are copied.
function crunch(text, line) {
  const items = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = text.indexOf('"', i + 1);
      if (j < 0) j = text.length;
      items.push({ str: text.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (ch === '?') { items.push({ kw: 'PRINT' }); i++; continue; }
    if (ch === ' ' || (ch >= '0' && ch <= ';')) { items.push({ ch }); i++; continue; }
    const kw = KEYWORDS.find(k => text.startsWith(k, i));
    if (kw) {
      items.push({ kw });
      i += kw.length;
      if (kw === 'REM') { items.push({ raw: text.slice(i) }); break; }
      if (kw === 'DATA') {
        let j = i, q = false;
        while (j < text.length && (q || text[j] !== ':')) { if (text[j] === '"') q = !q; j++; }
        items.push({ raw: text.slice(i, j) });
        i = j;
      }
      continue;
    }
    items.push({ ch });
    i++;
  }
  return items;
}

const isLetter = (c) => c >= 'A' && c <= 'Z';
const isDigit = (c) => c >= '0' && c <= '9';

function lex(text, line) {
  const items = crunch(text, line).filter(it => it.ch !== ' ');
  const toks = [];
  for (let i = 0; i < items.length;) {
    const it = items[i];
    if (it.str !== undefined) { toks.push({ t: 'str', v: it.str }); i++; continue; }
    if (it.raw !== undefined) { toks.push({ t: 'raw', v: it.raw }); i++; continue; }
    if (it.kw) {
      if (it.kw === 'GO' && items[i + 1] && items[i + 1].kw === 'TO') { toks.push({ t: 'kw', v: 'GOTO' }); i += 2; continue; }
      toks.push({ t: 'kw', v: it.kw }); i++; continue;
    }
    const c = it.ch;
    if (isDigit(c) || c === '.') {
      let s = '';
      while (i < items.length && items[i].ch !== undefined && (isDigit(items[i].ch) || items[i].ch === '.')) s += items[i++].ch;
      if (i < items.length && items[i].ch === 'E') {
        let j = i + 1, e = 'E';
        if (items[j] && (items[j].kw === '+' || items[j].kw === '-')) { e += items[j].kw; j++; }
        if (items[j] && items[j].ch !== undefined && isDigit(items[j].ch)) {
          while (j < items.length && items[j].ch !== undefined && isDigit(items[j].ch)) e += items[j++].ch;
          s += e; i = j;
        }
      }
      const v = s === '.' ? 0 : parseFloat(s.startsWith('.') ? '0' + s : s);
      toks.push({ t: 'num', v, text: s });
      continue;
    }
    if (isLetter(c)) {
      let s = c; i++;
      while (i < items.length && items[i].ch !== undefined && (isLetter(items[i].ch) || isDigit(items[i].ch))) s += items[i++].ch;
      let suf = '';
      if (i < items.length && (items[i].ch === '$' || items[i].ch === '%')) suf = items[i++].ch;
      toks.push({ t: 'id', v: s.slice(0, 2) + suf, full: s + suf });
      continue;
    }
    toks.push({ t: 'p', v: c });
    i++;
  }
  return toks;
}

// ---------------------------------------------------------------- parsing
class Parser {
  constructor(toks, line) { this.toks = toks; this.p = 0; this.line = line; }
  peek(o = 0) { return this.toks[this.p + o]; }
  err(msg) { throw new BasicError(msg, this.line); }
  isKw(v, o = 0) { const t = this.peek(o); return t && t.t === 'kw' && t.v === v; }
  isP(v, o = 0) { const t = this.peek(o); return t && t.t === 'p' && t.v === v; }
  acceptKw(v) { if (this.isKw(v)) { this.p++; return true; } return false; }
  acceptP(v) { if (this.isP(v)) { this.p++; return true; } return false; }
  expectKw(v) { if (!this.acceptKw(v)) this.err(`${v} expected (SYNTAX ERROR)`); }
  expectP(v) { if (!this.acceptP(v)) this.err(`'${v}' expected (SYNTAX ERROR)`); }
  atEnd() { return this.p >= this.toks.length; }
  atStmtEnd() { return this.atEnd() || this.isP(':') || this.isKw('ELSE'); }

  // statements up to the end of the line (an IF takes the rest of the line)
  statements() {
    const out = [];
    while (!this.atEnd()) {
      if (this.acceptP(':')) continue;
      if (this.isKw('ELSE')) break;
      out.push(this.statement());
      if (out[out.length - 1].k === 'if') break;
      if (!this.atEnd() && !this.isP(':') && !this.isKw('ELSE')) this.err('SYNTAX ERROR');
    }
    return out;
  }

  lineNumber() {
    const t = this.peek();
    if (!t || t.t !== 'num') this.err('line number expected (SYNTAX ERROR)');
    this.p++;
    return t.v;
  }

  statement() {
    const t = this.peek();
    const line = this.line;
    if (t.t === 'id') return this.assignment();
    if (t.t !== 'kw') this.err('SYNTAX ERROR');
    this.p++;
    switch (t.v) {
      case 'LET': return this.assignment();
      case 'REM': if (this.peek() && this.peek().t === 'raw') this.p++; return { k: 'nop' };
      case 'DATA': if (this.peek() && this.peek().t === 'raw') this.p++; return { k: 'nop' };
      case 'PRINT': return this.print();
      case 'IF': {
        const cond = this.expr();
        let then, els = null;
        if (this.acceptKw('GOTO')) then = [{ k: 'goto', target: this.lineNumber(), line }];
        else {
          this.expectKw('THEN');
          if (this.peek() && this.peek().t === 'num') then = [{ k: 'goto', target: this.lineNumber(), line }];
          else then = this.statements();
        }
        this.acceptP(':');
        if (this.acceptKw('ELSE')) {
          if (this.peek() && this.peek().t === 'num') els = [{ k: 'goto', target: this.lineNumber(), line }];
          else els = this.statements();
        }
        return { k: 'if', cond, then, els };
      }
      case 'GOTO': return { k: 'goto', target: this.lineNumber(), line };
      case 'GOSUB': return { k: 'gosub', target: this.lineNumber(), line };
      case 'RETURN': return { k: 'return', line };
      case 'ON': {
        const e = this.expr();
        let sub;
        if (this.acceptKw('GOTO')) sub = false; else { this.expectKw('GOSUB'); sub = true; }
        const targets = [this.lineNumber()];
        while (this.acceptP(',')) targets.push(this.lineNumber());
        return { k: 'on', e, sub, targets, line };
      }
      case 'FOR': {
        const v = this.peek();
        if (!v || v.t !== 'id' || v.v.endsWith('$')) this.err('FOR needs a number variable (SYNTAX ERROR)');
        this.p++;
        this.expectKw('=');
        const from = this.expr();
        this.expectKw('TO');
        const to = this.expr();
        const step = this.acceptKw('STEP') ? this.expr() : null;
        return { k: 'for', v: v.v, from, to, step, line };
      }
      case 'NEXT': {
        const vars = [];
        if (this.peek() && this.peek().t === 'id') {
          vars.push(this.peek().v); this.p++;
          while (this.acceptP(',')) { const n = this.peek(); if (!n || n.t !== 'id') this.err('SYNTAX ERROR'); vars.push(n.v); this.p++; }
        }
        return { k: 'next', vars, line };
      }
      case 'WHILE': return { k: 'while', cond: this.expr(), line };
      case 'WEND': return { k: 'wend', line };
      case 'REPEAT': return { k: 'repeat', line };
      case 'UNTIL': return { k: 'until', cond: this.expr(), line };
      case 'END': return { k: 'end' };
      case 'STOP': return { k: 'stop', line };
      case 'DIM': {
        const arrs = [];
        do {
          const n = this.peek();
          if (!n || n.t !== 'id') this.err('SYNTAX ERROR');
          this.p++;
          this.expectP('(');
          const dims = [this.expr()];
          while (this.acceptP(',')) dims.push(this.expr());
          this.expectP(')');
          arrs.push({ name: n.v, dims });
        } while (this.acceptP(','));
        return { k: 'dim', arrs };
      }
      case 'READ': {
        const vars = [this.lvalue()];
        while (this.acceptP(',')) vars.push(this.lvalue());
        return { k: 'read', vars, line };
      }
      case 'RESTORE': return { k: 'restore', target: null, line };   // no line number in BASIC 1.1
      case 'INPUT': {
        let prompt = null;
        if (this.peek() && this.peek().t === 'str') { prompt = this.peek().v; this.p++; this.expectP(';'); }
        const vars = [this.lvalue()];
        while (this.acceptP(',')) vars.push(this.lvalue());
        return { k: 'input', prompt, vars, line };
      }
      case 'GET': return { k: 'get', v: this.lvalue(), line };
      case 'POKE': { const a = this.expr(); this.expectP(','); return { k: 'poke', a, v: this.expr() }; }
      case 'CLS': return { k: 'cls' };
      case 'COLOR': { const f = this.expr(); const b = this.acceptP(',') ? this.expr() : null; return { k: 'color', f, b }; }
      case 'PAUSE': return { k: 'pause', n: this.expr() };
      case 'GRAPHIC': return { k: 'graphic', n: this.expr() };
      case 'PLOT': { const a = this.args(); if (a.length < 2 || a.length > 3) this.err('PLOT x,y[,c]'); return { k: 'plot', a }; }
      case 'LINE': { const a = this.args(); if (a.length < 4 || a.length > 5) this.err('LINE x1,y1,x2,y2[,c]'); return { k: 'lineg', a }; }
      case 'SILENCE': return { k: 'kcmd', n: 16, a: [] };
      case 'PATTERN': {
        const m = this.expr(); this.expectP(','); const row = this.expr(); this.expectP(',');
        return { k: 'pattern', m, row, s: this.expr(), line };
      }
      default:
        if (KCMDS[t.v]) {
          const a = this.atStmtEnd() ? [] : this.args();
          if (a.length > KCMDS[t.v][1]) this.err(`${t.v}: too many values`);
          return { k: 'kcmd', n: KCMDS[t.v][0], a, name: t.v };
        }
        this.err(`${t.v} is not in the prototype compiler yet`);
    }
  }

  args() {
    const a = [this.expr()];
    while (this.acceptP(',')) a.push(this.expr());
    return a;
  }

  assignment() {
    const target = this.lvalue();
    this.expectKw('=');
    return { k: 'let', target, e: this.expr(), line: this.line };
  }

  lvalue() {
    const t = this.peek();
    if (!t || t.t !== 'id') this.err('variable expected (SYNTAX ERROR)');
    this.p++;
    if (this.acceptP('(')) {
      const idx = [this.expr()];
      while (this.acceptP(',')) idx.push(this.expr());
      this.expectP(')');
      return { k: 'arr', name: t.v, idx };
    }
    return { k: 'var', name: t.v };
  }

  print() {
    const items = [];
    let lastSep = null;
    while (!this.atStmtEnd()) {
      if (this.acceptP(';')) { items.push({ sep: ';' }); lastSep = ';'; continue; }
      if (this.acceptP(',')) { items.push({ sep: ',' }); lastSep = ','; continue; }
      if (this.acceptKw('TAB(')) { const e = this.expr(); this.expectP(')'); items.push({ tab: e }); lastSep = ';'; continue; }
      if (this.acceptKw('SPC(')) { const e = this.expr(); this.expectP(')'); items.push({ spc: e }); lastSep = ';'; continue; }
      items.push({ e: this.expr() });
      lastSep = null;
    }
    return { k: 'print', items, newline: lastSep === null };
  }

  // ---- expressions, Microsoft's precedence
  expr() { return this.orExpr(); }
  orExpr() { let a = this.andExpr(); while (this.acceptKw('OR')) a = { k: 'bin', op: 'OR', a, b: this.andExpr() }; return a; }
  andExpr() { let a = this.notExpr(); while (this.acceptKw('AND')) a = { k: 'bin', op: 'AND', a, b: this.notExpr() }; return a; }
  notExpr() { if (this.acceptKw('NOT')) return { k: 'not', a: this.notExpr() }; return this.relExpr(); }
  relop() {
    const ops = [];
    while (this.isKw('<') || this.isKw('=') || this.isKw('>')) { ops.push(this.peek().v); this.p++; }
    if (!ops.length) return null;
    const s = new Set(ops);
    if (ops.length === 1) return ops[0];
    if (ops.length === 2 && s.has('<') && s.has('>')) return '<>';
    if (ops.length === 2 && s.has('<') && s.has('=')) return '<=';
    if (ops.length === 2 && s.has('>') && s.has('=')) return '>=';
    this.err('SYNTAX ERROR');
  }
  relExpr() {
    let a = this.addExpr();
    for (;;) {
      const op = this.relop();
      if (!op) return a;
      a = { k: 'rel', op, a, b: this.addExpr() };
    }
  }
  addExpr() {
    let a = this.mulExpr();
    for (;;) {
      if (this.acceptKw('+')) a = { k: 'bin', op: '+', a, b: this.mulExpr() };
      else if (this.acceptKw('-')) a = { k: 'bin', op: '-', a, b: this.mulExpr() };
      else return a;
    }
  }
  mulExpr() {
    let a = this.unary();
    for (;;) {
      if (this.acceptKw('*')) a = { k: 'bin', op: '*', a, b: this.unary() };
      else if (this.acceptKw('/')) a = { k: 'bin', op: '/', a, b: this.unary() };
      else return a;
    }
  }
  unary() {
    if (this.acceptKw('-')) return { k: 'neg', a: this.unary() };
    if (this.acceptKw('+')) return this.unary();
    return this.power();
  }
  power() {
    let a = this.primary();
    while (this.acceptKw('^')) {
      let neg = false;
      if (this.acceptKw('-')) neg = true; else this.acceptKw('+');
      const b = this.primary();
      a = { k: 'bin', op: '^', a, b: neg ? { k: 'neg', a: b } : b };
    }
    return a;
  }
  primary() {
    const t = this.peek();
    if (!t) this.err('SYNTAX ERROR');
    if (t.t === 'num') { this.p++; return { k: 'num', v: t.v }; }
    if (t.t === 'str') { this.p++; return { k: 'str', v: t.v }; }
    if (t.t === 'id') return this.lvalue();
    if (this.acceptP('(')) { const e = this.expr(); this.expectP(')'); return e; }
    if (t.t === 'kw') {
      const f = t.v;
      const FUNCS = ['SGN', 'INT', 'ABS', 'FRE', 'SQR', 'RND', 'LOG', 'EXP', 'COS', 'SIN', 'TAN', 'ATN', 'PEEK', 'LEN',
        'STR$', 'VAL', 'ASC', 'CHR$', 'LEFT$', 'RIGHT$', 'MID$', ...Object.keys(KFUNCS)];
      if (FUNCS.includes(f)) {
        this.p++;
        this.expectP('(');
        const args = [this.expr()];
        while (this.acceptP(',')) args.push(this.expr());
        this.expectP(')');
        return { k: 'call', f, args };
      }
      this.err(`${f} can't be used in an expression here (prototype)`);
    }
    this.err('SYNTAX ERROR');
  }
}

// ---------------------------------------------------------------- program
export function parseProgram(src) {
  const lines = [];
  let prev = -1;
  for (const raw of src.replace(/\r/g, '').split('\n')) {
    if (!raw.trim()) continue;
    const m = /^\s*(\d+)\s?(.*)$/.exec(raw);
    if (!m) throw new BasicError(`not a program line: ${raw.trim().slice(0, 30)}`);
    const num = +m[1];
    // capitals outside quotes, as BASIC does when the line is entered
    let text = '', q = false;
    for (const c of m[2]) { if (c === '"') q = !q; text += q ? c : c.toUpperCase(); }
    if (num <= prev) throw new BasicError('line numbers must go up', num);
    prev = num;
    const toks = lex(text, num);
    const p = new Parser(toks, num);
    const stmts = p.statements();
    if (!p.atEnd()) p.err('SYNTAX ERROR');
    lines.push({ num, stmts, toks });
  }
  return lines;
}

// DATA items in program order: [{line, text, isStr}]
function collectData(lines) {
  const items = [];
  for (const l of lines) for (const t of l.toks) {
    if (t.t !== 'raw') continue;
    const prevKw = l.toks[l.toks.indexOf(t) - 1];
    if (!prevKw || prevKw.v !== 'DATA') continue;
    let s = t.v, i = 0;
    while (i <= s.length) {
      while (i < s.length && s[i] === ' ') i++;
      let item = '';
      if (s[i] === '"') {
        const j = s.indexOf('"', i + 1);
        item = s.slice(i + 1, j < 0 ? s.length : j);
        i = j < 0 ? s.length : j + 1;
        while (i < s.length && s[i] !== ',') i++;
        items.push({ line: l.num, text: item, quoted: true });
      } else {
        const j = s.indexOf(',', i);
        item = s.slice(i, j < 0 ? s.length : j).trimEnd();
        i = j < 0 ? s.length : j;
        items.push({ line: l.num, text: item, quoted: false });
      }
      if (s[i] !== ',') break;
      i++;
    }
  }
  return items;
}

const isIntLit = (v) => Number.isInteger(v) && Math.abs(v) < 2 ** 31;

// fold arithmetic on constants, as BASIC would compute it (in floating point)
function fold(e) {
  if (!e || typeof e !== 'object') return e;
  for (const k of ['a', 'b', 'e', 'cond', 'from', 'to', 'step', 'f', 'm', 'row', 's']) if (e[k] && typeof e[k] === 'object' && !Array.isArray(e[k])) e[k] = fold(e[k]);
  for (const k of ['idx', 'args']) if (e[k]) e[k] = e[k].map(fold);
  if (e.k === 'neg' && e.a.k === 'num') return { k: 'num', v: -e.a.v };
  if (e.k === 'bin' && e.a.k === 'num' && e.b.k === 'num' && '+-*/'.includes(e.op)) {
    const a = e.a.v, b = e.b.v;
    if (e.op === '/' && b === 0) return e;
    const v = e.op === '+' ? a + b : e.op === '-' ? a - b : e.op === '*' ? a * b : a / b;
    return { k: 'num', v };
  }
  return e;
}
function foldStmts(stmts) {
  for (const s of stmts) {
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (k === 'then' || k === 'els') { if (v) foldStmts(v); continue; }
      if (Array.isArray(v)) s[k] = v.map(x => x && typeof x === 'object' && x.k ? fold(x) : x);
      else if (v && typeof v === 'object' && v.k) s[k] = fold(v);
    }
    if (s.items) for (const it of s.items) for (const k of ['e', 'tab', 'spc']) if (it[k]) it[k] = fold(it[k]);
  }
}

export function translate(src, opts = {}) {
  const lines = parseProgram(src);
  for (const l of lines) foldStmts(l.stmts);
  const lineSet = new Set(lines.map(l => l.num));
  const data = collectData(lines);
  const dataAllInt = data.every(d => !d.quoted && /^[-+]?\d+$/.test(d.text.replace(/ /g, '')) && isIntLit(+d.text.replace(/ /g, '')));

  // ---- symbols
  const scalars = new Map();   // key -> {real}
  const arrays = new Map();    // key -> {dims, real}
  const sc = (n) => { if (!scalars.has(n)) scalars.set(n, { real: false }); return scalars.get(n); };
  const ar = (n, dims) => {
    if (!arrays.has(n)) arrays.set(n, { dims: dims || [10], real: false });
    return arrays.get(n);
  };
  const walk = (stmts, fn) => { for (const s of stmts) { fn(s); if (s.k === 'if') { walk(s.then, fn); if (s.els) walk(s.els, fn); } } };
  const all = (fn) => { for (const l of lines) walk(l.stmts, (s) => fn(s, l.num)); };
  const constVal = (e) => e.k === 'num' ? e.v : e.k === 'neg' ? -constVal(e.a) : NaN;

  all((s, ln) => {
    if (s.k === 'dim') for (const a of s.arrs) {
      const dims = a.dims.map(constVal);
      if (dims.some(d => !Number.isInteger(d) || d < 0)) throw new BasicError('DIM needs whole constant sizes in the prototype', ln);
      if (arrays.has(a.name)) throw new BasicError(`REDIM'D ARRAY ${a.name}`, ln);
      ar(a.name, dims.map(Math.floor));
    }
  });
  const visitE = (e, fn) => { if (!e || typeof e !== 'object') return; fn(e); for (const k of ['a', 'b', 'e']) if (e[k]) visitE(e[k], fn); if (e.idx) e.idx.forEach(x => visitE(x, fn)); if (e.args) e.args.forEach(x => visitE(x, fn)); };
  const exprsOf = (s) => [s.e, s.cond, s.from, s.to, s.step, s.a && !Array.isArray(s.a) ? s.a : null, s.v && typeof s.v === 'object' ? s.v : null, s.n && typeof s.n === 'object' ? s.n : null,
    s.f, s.b, s.m, s.row, s.s, s.target && typeof s.target === 'object' ? s.target : null,
    ...(Array.isArray(s.a) ? s.a : []), ...(s.vars && typeof s.vars[0] === 'object' ? s.vars : []), ...(s.items ? s.items.map(i => i.e || i.tab || i.spc) : [])].filter(Boolean);
  all((s) => {
    for (const e of exprsOf(s)) visitE(e, (x) => {
      if (x.k === 'var') sc(x.name);
      if (x.k === 'arr') { const a = ar(x.name); if (a.dims.length !== x.idx.length) throw new BasicError(`BAD SUBSCRIPT ${x.name}`); }
    });
    if (s.k === 'for' || s.k === 'next') for (const v of s.vars || [s.v]) sc(v);
  });

  // ---- types: a number variable is whole unless something real is put in it
  const tyOf = (name) => name.endsWith('$') ? 'str' : name.endsWith('%') ? 'int' : null;
  const symTy = (x) => {
    const t = tyOf(x.name);
    if (t) return t;
    return (x.k === 'arr' ? arrays.get(x.name) : scalars.get(x.name)).real ? 'real' : 'int';
  };
  const ty = (e) => {
    switch (e.k) {
      case 'num': return isIntLit(e.v) ? 'int' : 'real';
      case 'str': return 'str';
      case 'var': case 'arr': return symTy(e);
      case 'neg': return ty(e.a);
      case 'not': case 'rel': return 'int';
      case 'bin':
        if (e.op === 'AND' || e.op === 'OR') return 'int';
        if (e.op === '/' || e.op === '^') return 'real';
        { const a = ty(e.a), b = ty(e.b); if (a === 'str' || b === 'str') return 'str'; return a === 'int' && b === 'int' ? 'int' : 'real'; }
      case 'call':
        switch (e.f) {
          case 'INT': case 'SGN': case 'PEEK': case 'LEN': case 'ASC': case 'FRE': return 'int';
          case 'ABS': return ty(e.args[0]) === 'int' ? 'int' : 'real';
          case 'STR$': case 'CHR$': case 'LEFT$': case 'RIGHT$': case 'MID$': return 'str';
          default: return KFUNCS[e.f] !== undefined ? 'int' : 'real';
        }
    }
    throw new Error('type of ' + e.k);
  };
  const markReal = (t) => {
    if (tyOf(t.name)) return false;
    const s = t.k === 'arr' ? arrays.get(t.name) : scalars.get(t.name);
    if (s.real) return false;
    s.real = true;
    return true;
  };
  for (let changed = true; changed;) {
    changed = false;
    all((s) => {
      const real = (e) => e && ty(e) === 'real';
      if (s.k === 'let' && real(s.e)) changed = markReal(s.target) || changed;
      if (s.k === 'for' && (real(s.from) || real(s.step))) changed = markReal({ k: 'var', name: s.v }) || changed;
      if (s.k === 'read' && !dataAllInt) for (const v of s.vars) changed = markReal(v) || changed;
      if (s.k === 'input' || s.k === 'get') for (const v of s.vars || [s.v]) changed = markReal(v) || changed;
    });
  }

  // ---- Pascal
  const pasName = (x) => {
    const n = x.name.replace('$', '').replace('%', '');
    const kind = x.name.endsWith('$') ? 's' : x.name.endsWith('%') ? 'p' : 'n';
    return (x.k === 'arr' ? 'a' : '') + kind + '_' + n;
  };
  const labels = new Set(['LEND']);
  const lineLabel = (n, from) => {
    if (!lineSet.has(n)) throw new BasicError(`UNDEF'D STATEMENT ${n}`, from);
    labels.add('L' + n);
    return 'L' + n;
  };
  const q = (s) => "'" + s.replace(/'/g, "''") + "'";
  const realLit = (v) => { let s = String(v).toUpperCase(); if (!/[.E]/.test(s)) s += '.0'; if (s.startsWith('.')) s = '0' + s; return s.replace('-.', '-0.'); };

  // g(e) -> {c: Pascal text, t: 'int'|'real'|'str'|'bool'}
  const asInt = (r) => r.t === 'bool' ? `BBool(${r.c})` : r.t === 'real' ? `BFloor(${r.c})` : r.c;
  const asNum = (r) => r.t === 'bool' ? `BBool(${r.c})` : r.c;
  const asBool = (r) => r.t === 'bool' ? r.c : `(${r.c} <> 0)`;
  const g = (e) => {
    switch (e.k) {
      case 'num': return isIntLit(e.v) ? { c: String(e.v), t: 'int' } : { c: realLit(e.v), t: 'real' };
      case 'str': return { c: q(e.v), t: 'str' };
      case 'var': return { c: pasName(e), t: symTy(e) };
      case 'arr': return { c: `${pasName(e)}[${e.idx.map(i => asInt(g(i))).join(', ')}]`, t: symTy(e) };
      case 'neg': { const a = g(e.a); return { c: `(-${asNum(a)})`, t: a.t === 'bool' ? 'int' : a.t }; }
      case 'not': { const a = g(e.a); return a.t === 'bool' ? { c: `(not ${a.c})`, t: 'bool' } : { c: `(not ${asInt(a)})`, t: 'int' }; }
      case 'rel': {
        const a = g(e.a), b = g(e.b);
        if ((a.t === 'str') !== (b.t === 'str')) throw new BasicError('TYPE MISMATCH');
        return { c: `(${asNum(a)} ${e.op} ${asNum(b)})`, t: 'bool' };
      }
      case 'bin': {
        const a = g(e.a), b = g(e.b);
        if (e.op === 'AND' || e.op === 'OR') {
          if (a.t === 'bool' && b.t === 'bool') return { c: `(${a.c} ${e.op.toLowerCase()} ${b.c})`, t: 'bool' };
          return { c: `(${asInt(a)} ${e.op.toLowerCase()} ${asInt(b)})`, t: 'int' };
        }
        if (a.t === 'str' || b.t === 'str') {
          if (e.op !== '+' || a.t !== b.t) throw new BasicError('TYPE MISMATCH');
          return { c: `(${a.c} + ${b.c})`, t: 'str' };
        }
        if (e.op === '^') return { c: `Power(${asNum(a)}, ${asNum(b)})`, t: 'real' };
        const t = e.op === '/' ? 'real' : (a.t === 'real' || b.t === 'real') ? 'real' : 'int';
        return { c: `(${asNum(a)} ${e.op} ${asNum(b)})`, t };
      }
      case 'call': {
        const A = e.args.map(g);
        const n = (k) => { if (A.length !== k) throw new BasicError(`${e.f}: ${k} value(s) expected`); };
        switch (e.f) {
          case 'INT': {
            n(1);
            if (A[0].t === 'int' || A[0].t === 'bool') return { c: asNum(A[0]), t: 'int' };
            const x = e.args[0];
            if (x.k === 'bin' && x.op === '/' && ty(x.a) === 'int' && ty(x.b) === 'int') return { c: `BIDiv(${asInt(g(x.a))}, ${asInt(g(x.b))})`, t: 'int' };
            return { c: `BFloor(${A[0].c})`, t: 'int' };
          }
          case 'ABS': n(1); return { c: `Abs(${asNum(A[0])})`, t: A[0].t === 'real' ? 'real' : 'int' };
          case 'SGN': n(1); { const x = asNum(A[0]); return { c: `(ord(${x} > 0) - ord(${x} < 0))`, t: 'int' }; }
          case 'SQR': n(1); return { c: `Sqrt(${asNum(A[0])})`, t: 'real' };
          case 'SIN': n(1); return { c: `Sin(${asNum(A[0])})`, t: 'real' };
          case 'COS': n(1); return { c: `Cos(${asNum(A[0])})`, t: 'real' };
          case 'TAN': n(1); return { c: `(Sin(${asNum(A[0])}) / Cos(${asNum(A[0])}))`, t: 'real' };
          case 'ATN': n(1); return { c: `ArcTan(${asNum(A[0])})`, t: 'real' };
          case 'LOG': n(1); return { c: `Ln(${asNum(A[0])})`, t: 'real' };
          case 'EXP': n(1); return { c: `Exp(${asNum(A[0])})`, t: 'real' };
          case 'RND': n(1); return { c: `BRnd(${asNum(A[0])})`, t: 'real' };
          case 'FRE': n(1); return { c: 'MemAvail', t: 'int' };
          case 'PEEK': n(1); return { c: `BPeek(${asInt(A[0])})`, t: 'int' };
          case 'LEN': n(1); return { c: `Length(${A[0].c})`, t: 'int' };
          case 'ASC': n(1); return { c: `BAsc(${A[0].c})`, t: 'int' };
          case 'CHR$': n(1); return { c: `Chr(${asInt(A[0])})`, t: 'str' };
          case 'STR$': n(1); return { c: A[0].t === 'real' ? `BStrR(${A[0].c})` : `BStrI(${asNum(A[0])})`, t: 'str' };
          case 'VAL': n(1); return { c: `BVal(${A[0].c})`, t: 'real' };
          case 'LEFT$': n(2); return { c: `Copy(${A[0].c}, 1, ${asInt(A[1])})`, t: 'str' };
          case 'RIGHT$': n(2); return { c: `BRight(${A[0].c}, ${asInt(A[1])})`, t: 'str' };
          case 'MID$': if (A.length === 2) return { c: `Copy(${A[0].c}, ${asInt(A[1])}, 255)`, t: 'str' };
            n(3); return { c: `Copy(${A[0].c}, ${asInt(A[1])}, ${asInt(A[2])})`, t: 'str' };
          default:
            n(1); return { c: `BFun(${KFUNCS[e.f]}, ${asInt(A[0])})`, t: 'int' };
        }
      }
    }
    throw new Error('gen ' + e.k);
  };

  const out = [];
  const emit = (s) => out.push('  ' + s);
  let nid = 0;
  const forStack = [], lastFor = new Map(), forVars = [];
  const whileStack = [], repeatStack = [];
  const gosubIds = [];
  let usesStopCheck = false;
  const stopCheck = (ln) => { usesStopCheck = true; emit(`esc := esc + 1; if esc = 0 then BCheckStop(${ln});`); };
  const assign = (t, r, ln) => {
    const tt = symTy(t);
    const lhs = g(t).c;
    if (tt === 'str') { if (r.t !== 'str') throw new BasicError('TYPE MISMATCH', ln); emit(`${lhs} := ${r.c};`); return; }
    if (r.t === 'str') throw new BasicError('TYPE MISMATCH', ln);
    emit(`${lhs} := ${tt === 'int' ? asInt(r) : asNum(r)};`);
  };

  const genStmts = (stmts, ln) => {
    for (const s of stmts) genStmt(s, ln);
  };
  const genStmt = (s, ln) => {
    switch (s.k) {
      case 'nop': case 'dim': return;
      case 'let': assign(s.target, g(s.e), ln); return;
      case 'print':
        for (const it of s.items) {
          if (it.sep === ',') emit('BComma;');
          else if (it.sep) continue;
          else if (it.tab) emit(`BTab(${asInt(g(it.tab))});`);
          else if (it.spc) emit(`BSpc(${asInt(g(it.spc))});`);
          else { const r = g(it.e); emit(r.t === 'str' ? `BPrintS(${r.c});` : r.t === 'real' ? `BPrintR(${r.c});` : `BPrintI(${asNum(r)});`); }
        }
        if (s.newline) emit('BNewLine;');
        return;
      case 'if': {
        const k = ++nid;
        labels.add(`LE${k}`); labels.add(`LX${k}`);
        const c = g(s.cond);
        if (c.t === 'str') throw new BasicError('TYPE MISMATCH', ln);
        emit(`if not ${asBool(c)} then goto LE${k};`);
        genStmts(s.then, ln);
        if (s.els) { emit(`goto LX${k};`); }
        emit(`LE${k}: ;`);
        if (s.els) genStmts(s.els, ln);
        emit(`LX${k}: ;`);
        return;
      }
      case 'goto':
        if (s.target <= ln) stopCheck(ln);
        emit(`goto ${lineLabel(s.target, ln)};`);
        return;
      case 'gosub': {
        const k = ++nid; gosubIds.push(k); labels.add(`R${k}`);
        emit(`if gsp > 99 then BError('OUT OF MEMORY', ${ln}); gs[gsp] := ${k}; gsp := gsp + 1; goto ${lineLabel(s.target, ln)};`);
        emit(`R${k}: ;`);
        return;
      }
      case 'return':
        emit(`if gsp = 0 then BError('RETURN WITHOUT GOSUB', ${ln}); goto LRET;`);
        labels.add('LRET');
        return;
      case 'on': {
        const sel = asInt(g(s.e));
        const cases = s.targets.map((t, i) => `${i + 1}: goto ${lineLabel(t, ln)};`).join(' ');
        if (!s.sub) { emit(`case ${sel} of ${cases} end;`); return; }
        const k = ++nid; gosubIds.push(k); labels.add(`R${k}`);
        emit(`if gsp > 99 then BError('OUT OF MEMORY', ${ln}); gs[gsp] := ${k}; gsp := gsp + 1;`);
        emit(`case ${sel} of ${cases} else gsp := gsp - 1; end;`);
        emit(`R${k}: ;`);
        return;
      }
      case 'for': {
        const k = ++nid;
        const v = { k: 'var', name: s.v };
        const vt = symTy(v);
        const fromR = g(s.from), toR = g(s.to), stepR = s.step ? g(s.step) : { c: '1', t: 'int' };
        const lim = (toR.t === 'int' && /^-?\d+$/.test(toR.c)) ? { inline: toR.c } : { name: `fl${k}`, t: toR.t === 'real' || vt === 'real' ? 'real' : 'int' };
        const stepC = constVal(s.step || { k: 'num', v: 1 });
        const step = Number.isFinite(stepC) && (vt === 'real' || isIntLit(stepC)) ? { inline: vt === 'real' ? realLit(stepC) : String(stepC), sign: Math.sign(stepC) } : { name: `fs${k}`, t: vt };
        assign(v, fromR, ln);
        if (lim.name) { forVars.push([lim.name, lim.t]); emit(`${lim.name} := ${lim.t === 'int' ? asInt(toR) : asNum(toR)};`); }
        if (step.name) { forVars.push([step.name, step.t]); emit(`${step.name} := ${step.t === 'int' ? asInt(stepR) : asNum(stepR)};`); }
        labels.add(`LF${k}`);
        emit(`LF${k}: ;`);
        const f = { k, v: s.v, vname: pasName(v), lim: lim.inline || lim.name, step };
        for (let i = forStack.length - 1; i >= 0; i--) if (forStack[i].v === s.v) { forStack.length = i; break; }
        forStack.push(f);
        lastFor.set(s.v, f);
        return;
      }
      case 'next': {
        const fors = [];
        if (!s.vars.length) {
          if (forStack.length) fors.push(forStack.pop());
          else throw new BasicError('NEXT WITHOUT FOR', ln);
        }
        for (const v of s.vars) {
          let f = null;
          for (let i = forStack.length - 1; i >= 0; i--) if (forStack[i].v === v) { f = forStack[i]; forStack.length = i; break; }
          if (!f) f = lastFor.get(v);
          if (!f) throw new BasicError('NEXT WITHOUT FOR', ln);
          fors.push(f);
        }
        for (const f of fors) {
          const st = f.step;
          stopCheck(ln);
          if (st.inline !== undefined) {
            emit(`${f.vname} := ${f.vname} + ${st.inline};`);
            emit(`if ${f.vname} ${st.sign < 0 ? '>=' : '<='} ${f.lim} then goto LF${f.k};`);
          } else {
            emit(`${f.vname} := ${f.vname} + ${st.name};`);
            emit(`if ((${st.name} >= 0) and (${f.vname} <= ${f.lim})) or ((${st.name} < 0) and (${f.vname} >= ${f.lim})) then goto LF${f.k};`);
          }
        }
        return;
      }
      case 'while': {
        const k = ++nid; labels.add(`LW${k}`); labels.add(`LWX${k}`);
        whileStack.push(k);
        emit(`LW${k}: if not ${asBool(g(s.cond))} then goto LWX${k};`);
        return;
      }
      case 'wend': {
        if (!whileStack.length) throw new BasicError('WEND WITHOUT WHILE', ln);
        const k = whileStack.pop();
        stopCheck(ln);
        emit(`goto LW${k};`);
        emit(`LWX${k}: ;`);
        return;
      }
      case 'repeat': { const k = ++nid; labels.add(`LR${k}`); repeatStack.push(k); emit(`LR${k}: ;`); return; }
      case 'until': {
        if (!repeatStack.length) throw new BasicError('UNTIL WITHOUT REPEAT', ln);
        const k = repeatStack.pop();
        stopCheck(ln);
        emit(`if not ${asBool(g(s.cond))} then goto LR${k};`);
        return;
      }
      case 'end': emit('goto LEND;'); return;
      case 'stop': emit(`BNewLine; BPrintS('BREAK IN ${ln}'); BNewLine; goto LEND;`); return;
      case 'read':
        for (const v of s.vars) {
          const t = symTy(v);
          if (t === 'str') emit(`${g(v).c} := RdS(${ln});`);
          else if (t === 'int') emit(`${g(v).c} := BFloor(RdN(${ln}));`);
          else emit(`${g(v).c} := RdN(${ln});`);
        }
        return;
      case 'restore': {
        let i = 0;
        if (s.target !== null) { lineLabel(s.target, ln); i = data.findIndex(d => d.line >= s.target); if (i < 0) i = data.length; }
        emit(`dp := ${i};`);
        return;
      }
      case 'input':
        emit(`BPrintS(${q(s.prompt !== null ? s.prompt + '? ' : '? ')});`);
        for (const v of s.vars) {
          emit('ReadLn(inp); BNewLineRead;');
          const t = symTy(v);
          emit(t === 'str' ? `${g(v).c} := inp;` : `${g(v).c} := BVal(inp);`);
        }
        return;
      case 'get': {
        const t = symTy(s.v);
        emit(t === 'str' ? `${g(s.v).c} := BGet;` : `${g(s.v).c} := BVal(BGet);`);
        return;
      }
      case 'poke': emit(`BPoke(${asInt(g(s.a))}, ${asInt(g(s.v))});`); return;
      case 'cls': emit('BCls;'); return;
      case 'color': emit(`BColor(${asInt(g(s.f))}, ${s.b ? 'true' : 'false'}, ${s.b ? asInt(g(s.b)) : 0});`); return;
      case 'pause': emit(`BPause(${asInt(g(s.n))});`); return;
      case 'graphic': emit(`BGraphic(${asInt(g(s.n))});`); return;
      case 'plot': { const a = s.a.map(x => asInt(g(x))); emit(`BPlot(${a[0]}, ${a[1]}, ${a.length > 2}, ${a[2] || 0});`); return; }
      case 'lineg': { const a = s.a.map(x => asInt(g(x))); emit(`BLine(${a[0]}, ${a[1]}, ${a[2]}, ${a[3]}, ${a.length > 4}, ${a[4] || 0});`); return; }
      case 'pattern': {
        const sr = g(s.s);
        if (sr.t !== 'str') throw new BasicError('TYPE MISMATCH', ln);
        emit(`BPattern(${asInt(g(s.m))}, ${asInt(g(s.row))}, ${sr.c});`);
        return;
      }
      case 'kcmd':
        s.a.forEach((x, i) => emit(`BArg(${i}, ${asInt(g(x))});`));
        emit(`BCmd(${s.n}, ${s.a.length});`);
        return;
    }
    throw new Error('statement ' + s.k);
  };

  for (const l of lines) {
    out.push(`  { ${l.num} }`);
    out.push(`  L${l.num}: ;`);
    genStmts(l.stmts, l.num);
  }
  if (forStack.length && opts.warn) opts.warn(`FOR without NEXT: ${forStack.map(f => f.v).join(', ')}`);
  // only the line labels something jumps to
  const body = out.filter(s => { const m = /^\s*(L\d+): ;$/.exec(s); return !m || labels.has(m[1]); });

  const P = [];
  P.push('program BasicProgram;');
  P.push('{ made by the MERIDIAN BASIC compiler (prototype) }');
  P.push('uses BRT;');
  P.push(`label ${[...labels].join(', ')};`);
  P.push('var');
  const typeName = (t) => t === 'str' ? 'string' : t === 'real' ? 'real' : t === 'int' ? 'longint' : t;
  for (const [n] of scalars) {
    const x = { k: 'var', name: n };
    P.push(`  ${pasName(x)}: ${n.endsWith('%') ? 'integer' : typeName(symTy(x))};`);
  }
  for (const [n, a] of arrays) {
    const x = { k: 'arr', name: n };
    const el = n.endsWith('$') ? 'string[80]' : n.endsWith('%') ? 'integer' : typeName(symTy(x));
    P.push(`  ${pasName(x)}: array[${a.dims.map(d => `0..${d}`).join(', ')}] of ${el};`);
  }
  for (const [n, t] of forVars) P.push(`  ${n}: ${typeName(t)};`);
  P.push('  gs: array[0..99] of integer;');
  P.push('  gsp: integer;');
  P.push('  esc: byte;');
  P.push('  inp: string;');
  const maxLen = Math.max(1, ...data.map(d => d.text.length));
  P.push(`  dat: array[0..${Math.max(0, data.length - 1)}] of string[${Math.min(255, maxLen)}];`);
  P.push('  dp: integer;');
  P.push('');
  P.push('procedure InitData;');
  P.push('begin');
  data.forEach((d, i) => P.push(`  dat[${i}] := ${q(d.text)};`));
  P.push('end;');
  P.push('');
  P.push('function RdS(ln: integer): string;');
  P.push(`begin if dp >= ${data.length} then BError('OUT OF DATA', ln); RdS := dat[dp]; dp := dp + 1; end;`);
  P.push('function RdN(ln: integer): real;');
  P.push(`begin if dp >= ${data.length} then BError('OUT OF DATA', ln); RdN := BVal(dat[dp]); dp := dp + 1; end;`);
  P.push('function BRight(const s: string; n: longint): string;');
  P.push('begin if n >= Length(s) then BRight := s else if n <= 0 then BRight := \'\' else BRight := Copy(s, Length(s) - n + 1, n); end;');
  P.push('function BAsc(const s: string): longint;');
  P.push(`begin if s = '' then BError('ILLEGAL QUANTITY', -1); BAsc := ord(s[1]); end;`);
  P.push('procedure BNewLineRead; begin end;');
  P.push('');
  P.push('begin');
  P.push('  InitData; dp := 0; gsp := 0; esc := 0;');
  P.push(...body);
  P.push('  goto LEND;');
  if (labels.has('LRET')) {
    P.push('LRET:');
    P.push('  gsp := gsp - 1;');
    P.push(`  case gs[gsp] of ${gosubIds.map(k => `${k}: goto R${k};`).join(' ')} end;`);
  }
  P.push('LEND: ;');
  P.push('end.');
  return { pascal: P.join('\n') + '\n', lines, scalars, arrays, usesStopCheck };
}

// kernel addresses for the runtime, from kern.lbl of the core
const KLABELS = { KBefehl: 'bb_befehl', KFunkt: 'bb_funktion', KGrafik: 'grafik_setzen', KPunkt: 'punkt', KLinie: 'linie' };
export function runtimeSource(kernLbl) {
  let text = fs.readFileSync(path.join(here, 'brt.pas'), 'latin1');
  if (kernLbl && fs.existsSync(kernLbl)) {
    const lbl = new Map();
    for (const z of fs.readFileSync(kernLbl, 'latin1').split('\n')) {
      const m = /^(\S+)\s*=\s*\$([0-9a-fA-F]+)/.exec(z);
      if (m) lbl.set(m[1], parseInt(m[2], 16));
    }
    for (const [c, l] of Object.entries(KLABELS)) {
      if (!lbl.has(l)) throw new BasicError(`kern.lbl has no ${l}`);
      text = text.replace(new RegExp(`(${c}\\s*=\\s*)\\$[0-9A-Fa-f]+`), `$1$${lbl.get(l).toString(16).toUpperCase()}`);
    }
  }
  return text;
}

export function compileBasic(src, opts = {}) {
  const t0 = Date.now();
  let tr;
  try { tr = translate(src, opts); } catch (e) {
    if (e instanceof BasicError) return { ok: false, errors: [{ msg: e.message, line: e.line }] };
    throw e;
  }
  const kernLbl = opts.kernLbl || path.join(root, '..', 'MERIDIAN_SCHUB_MiSTer', 'rom', 'kern.lbl');
  const brt = runtimeSource(kernLbl);
  const loadUnit = (name) => {
    if (name.toLowerCase() === 'brt') return { text: brt, name: path.join(here, 'brt.pas') };
    const p = path.join(root, 'lib', name.toLowerCase() + '.pas');
    return fs.existsSync(p) ? { text: fs.readFileSync(p, 'latin1'), name: p } : null;
  };
  const res = compile(tr.pascal, 'basic.pas', { target: 'm816', loadUnit });
  res.pascal = tr.pascal;
  res.translateMs = Date.now() - t0 - res.ms;
  res.vars = [...tr.scalars].map(([n, s]) => `${n}:${n.endsWith('$') ? 'str' : n.endsWith('%') || !s.real ? 'int' : 'real'}`);
  return res;
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('-') && args[args.indexOf(a) - 1] !== '-o');
  if (!file) { console.log('usage: node basicc/bc.js PROG.BAS [-o PROG.MER] [--pas]'); process.exit(2); }
  const oi = args.indexOf('-o');
  const outName = oi >= 0 ? args[oi + 1] : file.replace(/\.[^.]*$/, '') + '.MER';
  const res = compileBasic(fs.readFileSync(file, 'latin1'));
  if (args.includes('--pas') && res.pascal) fs.writeFileSync(outName.replace(/\.MER$/i, '.PAS'), res.pascal);
  if (!res.ok) {
    for (const e of res.errors) console.log(`${file}: ${e.msg}${e.line && !/^line/.test(e.msg) ? ` (Pascal line ${e.line})` : ''}`);
    process.exit(1);
  }
  fs.writeFileSync(outName, res.mer);
  console.log(`${outName}: ${res.bytes.length} bytes, $${res.load.toString(16).toUpperCase()}-$${(res.load + res.bytes.length - 1).toString(16).toUpperCase()}; variables ${res.vars.join(' ')}`);
}
