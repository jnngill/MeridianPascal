// MERIDIAN C - front end
//
// A C compiler (C89 with the common C99 parts) for the MERIDIAN 816 and
// SCHUB. It parses preprocessed tokens (cpp.js) into typed expression trees
// and translates statements at once into the same stack-machine IR as the
// Pascal front end (front.js), so both back ends (back816.js, backrv.js),
// the assemblers and the runtime are shared. The Pascal library units
// (Crt, Graph, Sprites, ...) can be called from C: `#pragma unit crt`
// (the <crt.h> header has it) makes the unit's routines, constants,
// variables and types visible under their names (any case).
//
// Data model: char 8 bit (unsigned), short and int 16 bit, long 32 bit,
// float, double and long double are the 32-bit reals of the runtime.
// Pointers: 16 bit into bank 0 on the 65C816, 32 bit on SCHUB; a pointer
// declared __far is 32 bit on both and reaches all of memory (on SCHUB
// through the uncached alias, for the chips' registers).
//
// Calling convention: arguments are pushed from the last to the first, so
// the first one is next to the frame and variadic functions work; the
// caller removes them. A struct argument is copied by the caller and
// passed by address; a function returning a struct gets the address of
// the result as a hidden first argument and returns it.

import { Preprocessor, unescape } from './cpp.js';
import { CompileError } from './lexer.js';
import { realBits, decimalToReal } from './types.js';

const KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return',
  'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void',
  'volatile', 'while', '_Bool', '_Noreturn', '__far', '_far', '__inline', '__inline__', '__restrict',
  '__volatile__', '__const', '__attribute__', '__signed__', '_Static_assert', '__typeof__', 'typeof',
]);
const TYPE_KW = new Set(['void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned',
  '_Bool', 'struct', 'union', 'enum', '__signed__', '__typeof__', 'typeof']);
const QUAL_KW = new Set(['const', 'volatile', 'restrict', 'inline', '_Noreturn', '__inline', '__inline__',
  '__restrict', '__volatile__', '__const', '__far', '_far', '__attribute__']);
const STORAGE_KW = new Set(['typedef', 'extern', 'static', 'auto', 'register']);

const PERSIST = 0x100000;      // frame offsets from here on are placed after the other locals

// ---------------------------------------------------------------- types
const mkInt = (name, size, signed, rank) => ({ k: 'int', name, size, signed, rank });
export const CT = {
  void: { k: 'void', name: 'void', size: 1 },
  bool: { ...mkInt('_Bool', 1, false, 0), bool: true },
  char: mkInt('char', 1, false, 1),
  schar: mkInt('signed char', 1, true, 1),
  uchar: mkInt('unsigned char', 1, false, 1),
  short: mkInt('short', 2, true, 2),
  ushort: mkInt('unsigned short', 2, false, 2),
  int: mkInt('int', 2, true, 3),
  uint: mkInt('unsigned int', 2, false, 3),
  long: mkInt('long', 4, true, 4),
  ulong: mkInt('unsigned long', 4, false, 4),
  float: { k: 'float', name: 'float', size: 4 },
  double: { k: 'float', name: 'double', size: 4 },
};
const isInt = (t) => t && t.k === 'int';
const isFloat = (t) => t && t.k === 'float';
const isArith = (t) => isInt(t) || isFloat(t);
const isPtr = (t) => t && t.k === 'ptr';
const isScalar = (t) => isArith(t) || isPtr(t);
const isStruct = (t) => t && t.k === 'struct';
const isArray = (t) => t && t.k === 'array';
const isFunc = (t) => t && t.k === 'func';
const isVoid = (t) => t && t.k === 'void';
const isAggregate = (t) => isStruct(t) || isArray(t);
const isCharT = (t) => isInt(t) && t.size === 1 && !t.bool;

export function ctypeName(t) {
  if (!t) return '?';
  switch (t.k) {
    case 'ptr': return isFunc(t.to) ? `${ctypeName(t.to.ret)} (*)(${t.to.params.map(p => ctypeName(p.type)).join(', ')}${t.to.variadic ? ', ...' : ''})` : `${ctypeName(t.to)} ${t.far ? '__far ' : ''}*`;
    case 'array': return `${ctypeName(t.of)}[${t.n === null ? '' : t.n}]`;
    case 'struct': return `${t.union ? 'union' : 'struct'} ${t.tag || '(anonymous)'}`;
    case 'func': return `${ctypeName(t.ret)} ()(${t.params.map(p => ctypeName(p.type)).join(', ')})`;
    default: return t.name || t.k;
  }
}

class Scope {
  constructor(parent) { this.parent = parent; this.syms = new Map(); this.tags = new Map(); }
}

class FnCtx {
  constructor(label, name) {
    this.label = label;
    this.name = name;
    this.code = [];
    this.locTop = 0;
    this.locMax = 0;
    this.persist = 0;
    this.labels = new Map();
    this.breaks = [];
    this.conts = [];
    this.switches = [];
  }
}

export class CFront {
  // pf: the Pascal front end (System compiled), used for the library units
  constructor(target, pf, opts = {}) {
    this.target = target;
    this.pf = pf;
    this.loadC = opts.loadC || (() => null);      // (name, fromFile, system) -> {text, name}
    this.defines = opts.defines || [];
    this.fn4 = !!opts.farFnPtr && target.ptrSize === 2;
    this.procs = [];
    this.data = [];
    this.bss = [];
    this.relocs = [];         // address constants in data: patched at start
    this.ext = new Map();     // external names (all translation units)
    this.lbl = 0;
    this.warnings = [];
    this.tus = new Set();
    this.unitsUsed = new Set();
    this.uses = [];           // {label, pos} references to check at the end
    this.pendingGlobals = []; // tentative definitions: room in the bss at the end
    const P = target.ptrSize;
    this.P = P === 2 ? 'W' : 'L';
    this.ptrInt = P === 2 ? CT.uint : CT.ulong;
    this.sizeT = P === 2 ? CT.uint : CT.ulong;
    this.ptrdiffT = P === 2 ? CT.int : CT.long;
  }

  err(msg, pos) { throw new CompileError(msg, pos || (this.tk && this.tk.pos)); }
  warn(msg, pos) { this.warnings.push({ msg, pos: pos || (this.tk && this.tk.pos) }); }
  newLabel(p = 'CL') { return `${p}${++this.lbl}`; }

  // ---------------------------------------------------------- types
  // (opts.farFnPtr, the far code model: a function's address is 24 bit, its pointers 32)
  ptr(to, far = false) { return { k: 'ptr', to, far: !!far, size: far || (this.fn4 && isFunc(to)) ? 4 : this.target.ptrSize }; }
  arr(of, n) { return { k: 'array', of, n, size: n === null ? 0 : n * of.size }; }
  alignOf(t) {
    if (!this.target.align) return 1;
    switch (t.k) {
      case 'int': case 'float': return t.size;
      case 'ptr': return t.size;
      case 'struct': return t.align || 1;
      case 'array': return this.alignOf(t.of);
      default: return 1;
    }
  }
  mt(t) {
    switch (t.k) {
      case 'int': return t.size === 1 ? (t.signed ? 's8' : 'u8') : t.size === 2 ? (t.signed ? 's16' : 'u16') : '32';
      case 'float': return '32';
      case 'ptr': return t.size === 4 ? '32' : 'u16';
    }
    this.err(`${ctypeName(t)} is not a scalar`);
  }
  cls(t) { return this.mt(t) === '32' ? 'L' : 'W'; }
  uns(t) { return isPtr(t) || (isInt(t) && !t.signed); }
  slot(t) { return this.target.argSlot || (this.cls(t) === 'L' ? 4 : 2); }
  promote(t) {
    if (isInt(t) && t.size < 2) return CT.int;
    if (isInt(t) && t.size === 2) return t.signed ? CT.int : CT.uint;
    return t;
  }
  arithType(a, b) {
    if (isFloat(a) || isFloat(b)) return CT.float;
    a = this.promote(a); b = this.promote(b);
    if (a.size === 4 || b.size === 4) {
      if ((a.size === 4 && !a.signed) || (b.size === 4 && !b.signed)) return CT.ulong;
      return CT.long;
    }
    return (!a.signed || !b.signed) ? CT.uint : CT.int;
  }
  // the same struct in two files: the same tag (or the same members)
  sameStruct(a, b) {
    if (a === b) return true;
    if (!isStruct(a) || !isStruct(b) || a.union !== b.union) return false;
    if (a.tag || b.tag) return a.tag === b.tag;
    return a.size === b.size && a.fields.length === b.fields.length && a.fields.every((f, i) => f.name === b.fields[i].name && f.off === b.fields[i].off);
  }
  sameType(a, b) {
    if (a === b) return true;
    if (!a || !b || a.k !== b.k) return false;
    switch (a.k) {
      case 'int': return a.size === b.size && a.signed === b.signed && !!a.bool === !!b.bool;
      case 'float': case 'void': return true;
      case 'ptr': return a.far === b.far && (isVoid(a.to) || isVoid(b.to) || this.sameType(a.to, b.to));
      case 'array': return this.sameType(a.of, b.of) && (a.n === null || b.n === null || a.n === b.n);
      case 'struct': return this.sameStruct(a, b);
      case 'func': return this.sameType(a.ret, b.ret);
    }
    return false;
  }

  // ---------------------------------------------------------- tokens
  get tk() { return this.toks[this.p]; }
  peek(k = 1) { return this.toks[Math.min(this.p + k, this.toks.length - 1)]; }
  next() { const t = this.toks[this.p]; if (t.k !== 'eof') this.p++; return t; }
  is(v) { const t = this.tk; return (t.k === 'op' || t.k === 'kw') && t.v === v; }
  isAt(k, v) { const t = this.peek(k); return (t.k === 'op' || t.k === 'kw') && t.v === v; }
  accept(v) { if (this.is(v)) { this.next(); return true; } return false; }
  expect(v) {
    if (!this.is(v)) this.err(`'${v}' expected but ${this.desc(this.tk)} found`);
    return this.next();
  }
  expectId() {
    if (this.tk.k !== 'id') this.err(`identifier expected but ${this.desc(this.tk)} found`);
    return this.next();
  }
  desc(t) {
    if (t.k === 'eof') return 'end of file';
    if (t.k === 'str') return 'a string';
    if (t.k === 'asm') return 'an asm block';
    return `'${t.raw || t.v}'`;
  }

  // pp-tokens -> C tokens: keywords, numbers, characters, joined strings
  cook(pp) {
    const out = [];
    for (let i = 0; i < pp.length; i++) {
      const t = pp[i];
      switch (t.k) {
        case 'id': out.push({ k: KEYWORDS.has(t.v) ? 'kw' : 'id', v: t.v, pos: t.pos }); break;
        case 'num': out.push(this.number(t)); break;
        case 'chr': {
          const b = unescape(t.v.slice(1, -1), t.pos.file, t.pos);
          if (!b.length) this.err('empty character constant', t.pos);
          let v = 0;
          for (const x of b) v = (v << 8) | x;
          out.push({ k: 'int', v: b.length > 1 ? v & 0xffff : v, type: CT.int, pos: t.pos, raw: t.v });
          break;
        }
        case 'str': {
          let bytes = unescape(t.v.slice(1, -1), t.pos.file, t.pos);
          while (pp[i + 1] && pp[i + 1].k === 'str') { i++; bytes = bytes.concat(unescape(pp[i].v.slice(1, -1), pp[i].pos.file, pp[i].pos)); }
          out.push({ k: 'str', bytes, pos: t.pos });
          break;
        }
        default: out.push({ ...t });
      }
    }
    return out;
  }
  number(t) {
    const s = t.v;
    const pos = t.pos;
    if (/^(0[xX][0-9a-fA-F]+|[0-9]+)([uU]?[lL]{0,2}|[lL]{1,2}[uU])$/.test(s) && !/^0[xX].*[pP]/.test(s)) {
      const m = /^(.*?)([uUlL]*)$/.exec(s);
      const digits = m[1], suf = m[2].toLowerCase();
      let v;
      if (/^0[xX]/.test(digits)) v = parseInt(digits.slice(2), 16);
      else if (/^0[0-7]*$/.test(digits)) v = parseInt(digits, 8);
      else if (/^0/.test(digits) && digits.length > 1) this.err(`bad octal number '${s}'`, pos);
      else v = parseInt(digits, 10);
      const u = suf.includes('u'), l = suf.includes('l');
      const dec = !/^0/.test(digits) || digits === '0';
      let type;
      if (!u && !l && v <= 32767) type = CT.int;
      else if (!l && (u || !dec) && v <= 65535) type = CT.uint;
      else if (!u && v <= 2147483647) type = CT.long;
      else if (v <= 4294967295) type = CT.ulong;
      else this.err(`number '${s}' is too large (more than 32 bits)`, pos);
      if (u && type === CT.long) type = CT.ulong;
      return { k: 'int', v, type, pos, raw: s };
    }
    if (/^0[bB][01]+[uUlL]*$/.test(s)) {
      const v = parseInt(s.slice(2).replace(/[uUlL]+$/, ''), 2);
      return { k: 'int', v, type: v <= 32767 ? CT.int : v <= 65535 ? CT.uint : v <= 2147483647 ? CT.long : CT.ulong, pos, raw: s };
    }
    const f = /^([0-9]*\.?[0-9]*(?:[eE][+-]?[0-9]+)?)[fFlL]?$/.exec(s);
    if (f && /[0-9]/.test(f[1])) {
      let txt = f[1];
      if (txt.startsWith('.')) txt = '0' + txt;
      if (/\.$/.test(txt)) txt += '0';
      txt = txt.replace(/\.(?=[eE])/, '.0');
      const v = decimalToReal(txt);
      if (Number.isNaN(v)) this.err(`bad number '${s}'`, pos);
      return { k: 'float', v, pos, raw: s };
    }
    if (/^0[xX][0-9a-fA-F]*\.?[0-9a-fA-F]*[pP][+-]?[0-9]+[fFlL]?$/.test(s)) {
      const m = /^0[xX]([0-9a-fA-F]*)\.?([0-9a-fA-F]*)[pP]([+-]?[0-9]+)/.exec(s);
      const v = (parseInt(m[1] || '0', 16) + (m[2] ? parseInt(m[2], 16) / 16 ** m[2].length : 0)) * 2 ** +m[3];
      return { k: 'float', v: Math.fround(v), pos, raw: s };
    }
    this.err(`bad number '${s}'`, pos);
  }

  // ---------------------------------------------------------- translation units
  compileTU(text, fileName) {
    if (this.tus.has(fileName)) return;
    this.tus.add(fileName);
    const defs = { __STDC__: 1, __STDC_VERSION__: '199901L', __MERIDIAN__: 1, __MERIDIAN_C__: 1, __CHAR_UNSIGNED__: 1,
      __SIZEOF_INT__: 2, __SIZEOF_LONG__: 4, __SIZEOF_POINTER__: this.target.ptrSize, __SIZEOF_FLOAT__: 4, __SIZEOF_DOUBLE__: 4 };
    if (this.target.name === 'm816') { defs.__M816__ = 1; defs.__65C816__ = 1; } else { defs.__SCHUB__ = 1; defs.__riscv = 1; }
    for (const d of this.defines) {
      const m = /^([A-Za-z_]\w*)(?:=(.*))?$/.exec(d);
      if (m) defs[m[1]] = m[2] === undefined ? 1 : m[2];
    }
    const pp = new Preprocessor({ defines: defs, loadInclude: (n, from, sys) => this.loadC(n, from, sys) });
    const ptoks = pp.run(text, fileName);
    for (const w of pp.warnings) this.warnings.push(w);
    this.toks = this.cook(ptoks);
    this.p = 0;
    this.module = 'c:' + fileName.split(/[\\/]/).pop();
    this.tuUnits = ['system'];       // like Pascal programs, C sees the System unit
    const links = [];
    for (const pr of pp.pragmas) {
      if (pr.kind === 'unit') {
        if (!this.pf.units.has(pr.v)) {
          try { this.pf.compileUnit(pr.v, pr.pos); }
          catch (e) { if (e instanceof CompileError && e.pos === pr.pos) this.err(`Pascal unit '${pr.v}' not found`, pr.pos); throw e; }
        }
        this.unitsUsed.add(pr.v);
        if (!this.tuUnits.includes(pr.v)) this.tuUnits.push(pr.v);
      } else links.push(pr);
    }
    this.pasCache = new Map();
    this.strLits = new Map();
    this.fileScope = new Scope(null);
    this.scope = this.fileScope;
    this.ctx = null;
    while (this.tk.k !== 'eof') this.externalDecl();
    // the files the headers asked for (#pragma link "x.c")
    for (const l of links) {
      const src = this.loadC(l.v, l.from, true);
      if (!src) this.err(`file '${l.v}' to link not found`, l.pos);
      if (this.tus.has(src.name)) continue;
      const st = { toks: this.toks, p: this.p, module: this.module, tuUnits: this.tuUnits, pasCache: this.pasCache, strLits: this.strLits, fileScope: this.fileScope, scope: this.scope };
      this.compileTU(src.text, src.name);
      Object.assign(this, st);
    }
  }

  // the program: the start routine, the data, the checks
  finish() {
    const main = this.ext.get('main');
    if (!main || main.kind !== 'func' || !main.defined) this.err('the program has no main function', { file: this.mainFile, line: 1, col: 1 });
    for (const g of this.pendingGlobals) if (!g.emitted) this.emitGlobal(g, null, null);
    // references to things never defined
    const defined = new Set(this.procs.map(p => p.label));
    for (const [, e] of this.ext) if (e.kind === 'var' && e.emitted) defined.add(e.label);
    for (const u of this.uses) {
      if (!defined.has(u.label)) this.err(`undefined reference to '${u.name}'`, u.pos);
    }
    // the start routine: address constants into the data, then main(argc, argv)
    const ctx = new FnCtx('PMAIN', 'C start');
    this.ctx = ctx;
    for (const r of this.relocs) {
      if (r.fn) { this.emit({ o: 'faddr', g: r.target }); this.emit({ o: 'stg', g: r.g, off: r.off, mt: '32' }); continue; }
      this.emit({ o: 'gaddr', g: r.target, off: r.toff });
      if (r.far && this.target.ptrSize === 2) this.emit({ o: 'ext', u: true });
      this.emit({ o: 'stg', g: r.g, off: r.off, mt: r.far || this.target.ptrSize === 4 ? '32' : 'u16' });
    }
    const mt = main.type;
    let args = 0;
    if (mt.params.length >= 2) {
      const nm = this.strLabel([...'MAIN'].map(c => c.charCodeAt(0)));
      const argv = this.newLabel('CARGV');
      this.data.push({ label: argv, bytes: new Array(2 * this.target.ptrSize).fill(0), align: this.target.ptrSize, module: 'c' });
      this.emit({ o: 'gaddr', g: nm, off: 0 });
      this.emit({ o: 'stg', g: argv, off: 0, mt: this.mt(this.ptr(CT.char)) });
      this.emit({ o: 'gaddr', g: argv, off: 0 });
      this.emit({ o: 'arg', s: this.P });
      this.emit({ o: 'lit', s: 'W', v: 1 });
      this.emit({ o: 'arg', s: 'W' });
      args = this.target.ptrSize === 2 ? 4 : 8;
      if (this.target.argSlot) args = 2 * this.target.argSlot;
    }
    this.emit({ o: 'call', l: main.label, args, ret: isVoid(mt.ret) ? null : this.cls(mt.ret) });
    if (!isVoid(mt.ret)) {
      const ec = this.pf.units.get('system').iface.syms.get('exitcode');
      if (isInt(mt.ret) && ec && ec.loc && ec.loc.label) {
        if (this.cls(mt.ret) === 'L') this.emit({ o: 'trunc', mt: 's16' });
        this.emit({ o: 'stg', g: ec.loc.label, off: 0, mt: 's16' });
      } else this.emit({ o: 'drop' });
    }
    const exit = this.newLabel('CX');
    this.emit({ o: 'label', l: exit });
    this.procs.push({ label: 'PMAIN', name: 'C start', level: 1, locSize: 0, parBytes: 0, hasSL: false, retCls: null, resultLoc: null, parent: null, code: ctx.code, module: 'c' });
    this.ctx = null;
  }

  // ---------------------------------------------------------- scopes and names
  lookup(name) {
    for (let s = this.scope; s; s = s.parent) {
      const v = s.syms.get(name);
      if (v) return v;
    }
    return this.pasLookup(name);
  }
  lookupTag(name) {
    for (let s = this.scope; s; s = s.parent) {
      const v = s.tags.get(name);
      if (v) return v;
    }
    return null;
  }
  isTypedefName(t) {
    if (!t || t.k !== 'id') return false;
    const s = this.lookup(t.v);
    return !!s && s.kind === 'typedef';
  }
  isTypeStart(t = this.tk) {
    if (t.k === 'kw') return TYPE_KW.has(t.v) || QUAL_KW.has(t.v) || STORAGE_KW.has(t.v);
    return this.isTypedefName(t);
  }

  // a name from one of the Pascal units this file uses
  pasLookup(name) {
    if (!this.tuUnits || !this.tuUnits.length) return null;
    const ln = name.toLowerCase();
    if (this.pasCache.has(ln)) return this.pasCache.get(ln);
    for (let i = this.tuUnits.length - 1; i >= 0; i--) {
      const u = this.pf.units.get(this.tuUnits[i]);
      const s = u && u.iface.syms.get(ln);
      if (!s) continue;
      let r = null;
      switch (s.kind) {
        case 'proc': r = { kind: 'pfunc', psym: s, name }; break;
        case 'var':
          if (s.loc && s.loc.k === 'global') {
            r = { kind: 'var', name, type: this.pas2c(s.type), loc: s.loc.addr !== undefined ? { k: 'abs', a: s.loc.addr } : { k: 'glob', g: s.loc.label } };
          }
          break;
        case 'const': {
          const t = s.type;
          if (t.k === 'real') r = { kind: 'fconst', v: s.v };
          else if (t.k === 'string') r = { kind: 'strconst', bytes: [...s.v].map(c => c.charCodeAt(0) & 255) };
          else if (t.k === 'set') r = null;
          else r = { kind: 'enumc', v: s.v, type: (s.v >= -32768 && s.v <= 32767) ? CT.int : (s.v >= 0 && s.v <= 65535) ? CT.uint : s.v < 0 || s.v <= 2147483647 ? CT.long : CT.ulong };
          break;
        }
        case 'type': r = { kind: 'typedef', type: this.pas2c(s.type) }; break;
      }
      if (r) { this.pasCache.set(ln, r); return r; }
    }
    this.pasCache.set(ln, null);
    return null;
  }
  pas2c(t) {
    if (!this.pasTypes) this.pasTypes = new Map();
    if (this.pasTypes.has(t)) return this.pasTypes.get(t);
    let r;
    switch (t.k) {
      case 'int': r = t.size === 1 ? (t.signed ? CT.schar : CT.uchar) : t.size === 2 ? (t.signed ? CT.int : CT.uint) : (t.signed ? CT.long : CT.ulong); break;
      case 'char': r = CT.char; break;
      case 'bool': r = CT.bool; break;
      case 'real': r = CT.float; break;
      case 'enum': r = t.size === 1 ? CT.uchar : CT.uint; break;
      case 'ptr': case 'nil': {
        r = this.ptr(CT.void);
        this.pasTypes.set(t, r);
        if (t.to) r.to = this.pas2c(t.to);
        return r;
      }
      case 'string': r = this.arr(CT.uchar, (t.max || 255) + 1); break;
      case 'array': r = this.arr(this.pas2c(t.elem), t.hi - t.lo + 1); break;
      case 'record': {
        r = { k: 'struct', tag: t.name || 'record', union: false, fields: [], size: t.size, align: 1, complete: true, ci: true };
        this.pasTypes.set(t, r);
        r.fields = (t.fields || []).filter(f => f.name && !f.name.startsWith('$')).map(f => ({ name: f.name, type: this.pas2c(f.type), off: f.off }));
        return r;
      }
      case 'proc': r = this.ptr({ k: 'func', ret: t.ret ? this.pas2c(t.ret) : CT.void, params: [], variadic: false, proto: false }); break;
      default: r = this.arr(CT.uchar, t.size || 1);
    }
    this.pasTypes.set(t, r);
    return r;
  }

  // ---------------------------------------------------------- declarations
  externalDecl() {
    if (this.accept(';')) return;
    if (this.is('_Static_assert')) { this.staticAssert(); return; }
    if (this.tk.k === 'asm') this.err('an asm block belongs in a function');
    const pos = this.tk.pos;
    const spec = this.parseSpecs(true);
    if (!spec) {
      // int is the default (old C): f(x) { ... }
      if (this.tk.k !== 'id') this.err(`declaration expected but ${this.desc(this.tk)} found`);
    }
    const sp = spec || { type: CT.int, storage: null, pos };
    if (this.accept(';')) return;     // struct/enum declaration
    let first = true;
    for (;;) {
      const d = this.declarator(sp.type, sp, false);
      if (first && isFunc(d.type) && this.is('{')) {
        if (sp.storage === 'typedef') this.err('a typedef cannot have a body', d.pos);
        this.funcDef(d, sp);
        return;
      }
      first = false;
      this.declareName(d, sp, true);
      if (!this.accept(',')) break;
    }
    this.expect(';');
  }

  staticAssert() {
    const pos = this.next().pos;
    this.expect('(');
    const v = this.constInt(this.assignExpr());
    let msg = 'static assertion failed';
    if (this.accept(',')) { const s = this.next(); if (s.k === 'str') msg = String.fromCharCode(...s.bytes); }
    this.expect(')');
    this.expect(';');
    if (!v) this.err(msg, pos);
  }

  skipAttribute() {
    // __attribute__((...)): ignored
    this.next();
    this.expect('(');
    let depth = 1;
    while (depth && this.tk.k !== 'eof') {
      if (this.is('(')) depth++;
      else if (this.is(')')) depth--;
      this.next();
    }
  }

  // declaration specifiers -> {type, storage, far} or null if there are none
  parseSpecs(allowStorage) {
    let storage = null, far = false, any = false, isInline = false;
    let base = null, signed = null, nShort = 0, nLong = 0, nInt = 0, nChar = 0, nOther = null;
    const pos = this.tk.pos;
    for (;;) {
      const t = this.tk;
      if (t.k === 'kw') {
        if (STORAGE_KW.has(t.v)) {
          if (!allowStorage) this.err(`'${t.v}' is not allowed here`);
          if (storage && storage !== t.v) this.err('two storage classes in one declaration');
          storage = t.v; this.next(); any = true; continue;
        }
        if (t.v === '__attribute__') { this.skipAttribute(); continue; }
        if (t.v === '__far' || t.v === '_far') { far = true; this.next(); any = true; continue; }
        if (t.v === 'inline' || t.v === '__inline' || t.v === '__inline__') { isInline = true; this.next(); any = true; continue; }
        if (QUAL_KW.has(t.v)) { this.next(); any = true; continue; }
        switch (t.v) {
          case 'void': case 'float': case 'double': case '_Bool':
            if (nOther || base) this.err('two types in one declaration');
            nOther = t.v; this.next(); any = true; continue;
          case 'char': nChar++; this.next(); any = true; continue;
          case 'short': nShort++; this.next(); any = true; continue;
          case 'long': nLong++; this.next(); any = true; continue;
          case 'int': nInt++; this.next(); any = true; continue;
          case 'signed': case '__signed__': signed = true; this.next(); any = true; continue;
          case 'unsigned': signed = false; this.next(); any = true; continue;
          case 'struct': case 'union':
            if (base || nOther) this.err('two types in one declaration');
            base = this.structSpec(); any = true; continue;
          case 'enum':
            if (base || nOther) this.err('two types in one declaration');
            base = this.enumSpec(); any = true; continue;
          case 'typeof': case '__typeof__': {
            if (base || nOther) this.err('two types in one declaration');
            this.next();
            this.expect('(');
            if (this.isTypeStart()) base = this.typeName();
            else base = this.expr().type;
            this.expect(')');
            any = true; continue;
          }
        }
        break;
      }
      if (t.k === 'id' && !base && !nOther && !nChar && !nShort && !nLong && !nInt && signed === null) {
        const s = this.lookup(t.v);
        if (s && s.kind === 'typedef') {
          // `T x` declares x; `T;` at the start of a statement is an expression
          base = s.type; this.next(); any = true; continue;
        }
      }
      break;
    }
    if (!any) return null;
    let type;
    if (base) {
      if (nChar || nShort || nLong || nInt || signed !== null || nOther) this.err('two types in one declaration', pos);
      type = base;
    } else if (nOther) {
      if (nChar || nShort || nInt || signed !== null || (nLong && nOther !== 'double')) this.err('two types in one declaration', pos);
      type = nOther === 'void' ? CT.void : nOther === '_Bool' ? CT.bool : nOther === 'float' ? CT.float : CT.double;
    } else if (nChar) {
      if (nShort || nLong || nInt > 0 && false) this.err('two types in one declaration', pos);
      type = signed === null ? CT.char : signed ? CT.schar : CT.uchar;
    } else if (nShort) {
      type = signed === false ? CT.ushort : CT.short;
    } else if (nLong) {
      type = signed === false ? CT.ulong : CT.long;     // long long is 32 bit as well
    } else type = signed === false ? CT.uint : CT.int;
    return { type, storage, far, pos, isInline };
  }

  structSpec() {
    const isUnion = this.next().v === 'union';
    while (this.is('__attribute__')) this.skipAttribute();
    let tag = null;
    const pos = this.tk.pos;
    if (this.tk.k === 'id') tag = this.next().v;
    if (!this.is('{')) {
      if (!tag) this.err('struct name or { expected');
      let t = this.lookupTag(tag);
      if (t && t.k === 'struct' && t.union === isUnion) return t;
      if (t) this.err(`'${tag}' is declared as a different kind of tag`, pos);
      t = { k: 'struct', tag, union: isUnion, fields: [], size: 0, align: 1, complete: false };
      // `struct S;` alone or a first use: in this scope
      this.scope.tags.set(tag, t);
      return t;
    }
    let t = tag ? this.scope.tags.get(tag) : null;
    if (t && (t.k !== 'struct' || t.union !== isUnion)) this.err(`'${tag}' is declared as a different kind of tag`, pos);
    if (t && t.complete) this.err(`redefinition of '${isUnion ? 'union' : 'struct'} ${tag}'`, pos);
    if (!t) { t = { k: 'struct', tag, union: isUnion, fields: [], size: 0, align: 1, complete: false }; if (tag) this.scope.tags.set(tag, t); }
    this.expect('{');
    let off = 0, maxAlign = 1, size = 0;
    let bf = null;     // the open bit-field unit: {off, size, used}
    const fields = [];
    const addField = (name, type, fpos, width) => {
      if (name && fields.some(f => f.name === name)) this.err(`duplicate member '${name}'`, fpos);
      if (width !== undefined) {
        if (!isInt(type)) this.err('a bit-field must have an integer type', fpos);
        if (width > type.size * 8) this.err(`bit-field '${name}' is wider than its type`, fpos);
        if (isUnion) { fields.push({ name, type, off: 0, bits: width, bitoff: 0, unit: type.size }); size = Math.max(size, type.size); return; }
        if (width === 0) { bf = null; return; }
        if (!bf || bf.size !== type.size || bf.used + width > bf.size * 8) {
          const al = this.alignOf(type);
          off = Math.ceil(off / al) * al;
          bf = { off, size: type.size, used: 0 };
          off += type.size;
          maxAlign = Math.max(maxAlign, al);
        }
        if (name) fields.push({ name, type, off: bf.off, bits: width, bitoff: bf.used, unit: bf.size });
        bf.used += width;
        size = Math.max(size, off);
        return;
      }
      bf = null;
      if (isFunc(type)) this.err(`member '${name}' cannot be a function`, fpos);
      if (isStruct(type) && !type.complete) this.err(`member '${name}' has an incomplete type`, fpos);
      const al = this.alignOf(type);
      maxAlign = Math.max(maxAlign, al);
      if (isUnion) {
        fields.push({ name, type, off: 0 });
        size = Math.max(size, type.size);
      } else {
        off = Math.ceil(off / al) * al;
        fields.push({ name, type, off });
        off += type.size;
        size = off;
      }
    };
    while (!this.accept('}')) {
      if (this.is('_Static_assert')) { this.staticAssert(); continue; }
      const sp = this.parseSpecs(false);
      if (!sp) this.err(`member declaration expected but ${this.desc(this.tk)} found`);
      if (this.accept(';')) {
        // an anonymous struct or union: its members belong to this one
        if (isStruct(sp.type) && !sp.type.tag || isStruct(sp.type) && sp.type.anon) {
          const inner = sp.type;
          const al = this.alignOf(inner);
          maxAlign = Math.max(maxAlign, al);
          let base;
          if (isUnion) { base = 0; size = Math.max(size, inner.size); }
          else { off = Math.ceil(off / al) * al; base = off; off += inner.size; size = off; }
          bf = null;
          for (const f of inner.fields) fields.push({ ...f, off: f.off + base });
          continue;
        }
        continue;
      }
      for (;;) {
        let d;
        if (this.is(':')) d = { name: null, type: sp.type, pos: this.tk.pos };
        else d = this.declarator(sp.type, sp, false);
        let width;
        if (this.accept(':')) width = this.constInt(this.condExpr());
        if (isArray(d.type) && d.type.n === null && this.is('}') === false && this.isAt(1, '}') === false) {
          // a flexible array member: size 0
        }
        addField(d.name, isArray(d.type) && d.type.n === null ? this.arr(d.type.of, 0) : d.type, d.pos, width);
        if (!this.accept(',')) break;
      }
      this.expect(';');
    }
    while (this.is('__attribute__')) this.skipAttribute();
    t.fields = fields;
    t.align = maxAlign;
    t.size = Math.ceil(size / maxAlign) * maxAlign;
    t.complete = true;
    if (!tag) t.anon = true;
    return t;
  }

  enumSpec() {
    this.next();
    let tag = null;
    if (this.tk.k === 'id') tag = this.next().v;
    const et = { ...CT.int, name: tag ? `enum ${tag}` : 'enum', enumTag: tag };
    if (!this.is('{')) {
      if (!tag) this.err('enum name or { expected');
      const t = this.lookupTag(tag);
      return t || et;
    }
    if (tag) this.scope.tags.set(tag, et);
    this.expect('{');
    let v = 0;
    while (!this.accept('}')) {
      const id = this.expectId();
      if (this.accept('=')) v = this.constInt(this.condExpr());
      if (this.scope.syms.has(id.v)) this.err(`redefinition of '${id.v}'`, id.pos);
      this.scope.syms.set(id.v, { kind: 'enumc', v, type: CT.int });
      v++;
      if (!this.accept(',')) { this.expect('}'); break; }
    }
    return et;
  }

  // declarator: {name, type, pos, params (names of a function's parameters)}
  declarator(base, spec, abstract) {
    const ptrs = [];
    let farNext = spec && spec.far;
    while (this.accept('*')) {
      let far = farNext;
      farNext = false;
      for (;;) {
        if (this.is('__far') || this.is('_far')) { this.next(); far = true; continue; }
        if (this.is('const') || this.is('volatile') || this.is('restrict') || this.is('__restrict') || this.is('__const') || this.is('__volatile__')) { this.next(); continue; }
        if (this.is('__attribute__')) { this.skipAttribute(); continue; }
        break;
      }
      ptrs.push(far);
    }
    let name = null, pos = this.tk.pos, inner = null;
    if (this.tk.k === 'id' && !(abstract && this.isTypedefName(this.tk))) {
      const t = this.next();
      name = t.v; pos = t.pos;
    } else if (this.is('(') && (this.isAt(1, '*') || this.isAt(1, '(') || this.isAt(1, '[') || this.isAt(1, '__far') ||
      (this.peek().k === 'id' && !this.isTypedefName(this.peek())))) {
      this.next();
      inner = this.declarator(null, null, abstract);
      this.expect(')');
      name = inner.name; pos = inner.pos;
    } else if (!abstract) {
      this.err(`identifier expected but ${this.desc(this.tk)} found`);
    }
    const suffixes = [];
    let params = null;
    for (;;) {
      if (this.accept('[')) {
        while (this.is('static') || this.is('const') || this.is('restrict') || this.is('volatile')) this.next();
        let n = null;
        if (!this.is(']')) {
          n = this.constInt(this.assignExpr());
          if (n < 0) this.err('an array cannot have a negative size');
        }
        this.expect(']');
        suffixes.push({ k: 'array', n });
        continue;
      }
      if (this.is('(')) {
        this.next();
        const f = this.paramList();
        suffixes.push({ k: 'func', ...f });
        if (!params && !inner) params = f.params;
        else if (!params && inner && !inner.params) params = f.params;
        continue;
      }
      break;
    }
    while (this.is('__attribute__')) this.skipAttribute();
    const apply = (t) => {
      for (const far of ptrs) t = this.ptr(t, far);
      for (let i = suffixes.length - 1; i >= 0; i--) {
        const s = suffixes[i];
        if (s.k === 'array') {
          if (isFunc(t)) this.err('an array of functions is not possible', pos);
          if (isVoid(t)) this.err('an array of void is not possible', pos);
          if (isArray(t) && t.n === null) this.err('the inner dimension of an array must be given', pos);
          t = this.arr(t, s.n);
        } else {
          if (isFunc(t) || isArray(t)) this.err('a function cannot return an array or a function', pos);
          t = { k: 'func', ret: t, params: s.params, variadic: s.variadic, proto: s.proto, size: 1 };
        }
      }
      return t;
    };
    const res = { name, pos, apply, params: inner && inner.params ? inner.params : params };
    if (base) res.type = inner ? inner.apply(apply(base)) : apply(base);
    else res.apply = inner ? (t) => inner.apply(apply(t)) : apply;
    return res;
  }

  paramList() {
    const params = [];
    let variadic = false, proto = true;
    if (this.accept(')')) return { params, variadic, proto: false };
    if (this.is('void') && this.isAt(1, ')')) { this.next(); this.next(); return { params, variadic, proto: true }; }
    // old-style list of names: f(a, b) - the types come later (not supported)
    if (this.tk.k === 'id' && !this.isTypedefName(this.tk) && (this.isAt(1, ',') || this.isAt(1, ')'))) {
      this.err('old-style (K&R) parameter lists are not supported; give the types in the parentheses');
    }
    for (;;) {
      if (this.accept('...')) { variadic = true; break; }
      const sp = this.parseSpecs(true);
      if (!sp) this.err(`parameter type expected but ${this.desc(this.tk)} found`);
      const d = this.declarator(sp.type, sp, true);
      let t = d.type;
      if (isArray(t)) t = this.ptr(t.of);
      else if (isFunc(t)) t = this.ptr(t);
      if (isVoid(t)) this.err("'void' must be the only parameter", d.pos);
      params.push({ name: d.name, type: t, pos: d.pos });
      if (!this.accept(',')) break;
    }
    this.expect(')');
    return { params, variadic, proto };
  }

  typeName() {
    const sp = this.parseSpecs(false);
    if (!sp) this.err(`type expected but ${this.desc(this.tk)} found`);
    const d = this.declarator(sp.type, sp, true);
    if (d.name) this.err('a type name has no identifier', d.pos);
    return d.type;
  }

  // a declared name: file scope (global) or block scope (local)
  declareName(d, sp, fileScope) {
    if (!d.name) this.err('a declaration needs a name', d.pos);
    const sc = this.scope;
    const t = d.type;
    if (sp.storage === 'typedef') {
      const old = sc.syms.get(d.name);
      if (old && !(old.kind === 'typedef' && this.sameType(old.type, t))) this.err(`redefinition of '${d.name}'`, d.pos);
      sc.syms.set(d.name, { kind: 'typedef', type: t });
      return;
    }
    if (isFunc(t)) {
      // a function declaration (in a block too)
      const f = this.declareFunc(d.name, t, sp.storage === 'static', d.pos);
      sc.syms.set(d.name, f);
      return;
    }
    if (fileScope || sp.storage === 'extern') {
      if (!fileScope) {
        const g = this.globalVar(d.name, t, sp, d.pos, false);
        sc.syms.set(d.name, g);
        if (this.is('=')) this.err('an extern declaration in a block cannot be initialized');
        return;
      }
      const g = this.globalVar(d.name, t, sp, d.pos, this.is('='));
      if (this.accept('=')) {
        const init = this.initializer();
        if (g.defined) this.err(`redefinition of '${d.name}'`, d.pos);
        g.defined = true;
        g.init = init;
        this.emitGlobal(g, init, d.pos);
      }
      return;
    }
    // a local
    if (this.scope.syms.has(d.name)) {
      const o = this.scope.syms.get(d.name);
      if (o.kind === 'var' || o.kind === 'enumc' || o.kind === 'typedef') this.err(`redefinition of '${d.name}'`, d.pos);
    }
    if (sp.storage === 'static') {
      // a static local: a global with a name of its own
      let type = t;
      let init = null;
      if (this.accept('=')) init = this.initializer();
      if (isArray(type) && type.n === null) {
        if (!init) this.err(`array '${d.name}' needs a size`, d.pos);
        type = this.arr(type.of, this.initCount(type, init));
      }
      const g = { kind: 'var', name: d.name, type, label: `G${++this.lbl}_${d.name}`, loc: null, defined: true, isStatic: true };
      g.loc = { k: 'glob', g: g.label };
      sc.syms.set(d.name, g);
      this.emitGlobal(g, init, d.pos);
      return;
    }
    let type = t;
    let init = null;
    if (this.accept('=')) init = this.initializer();
    if (isArray(type) && type.n === null) {
      if (!init) this.err(`array '${d.name}' needs a size`, d.pos);
      type = this.arr(type.of, this.initCount(type, init));
    }
    if (isStruct(type) && !type.complete) this.err(`'${d.name}' has an incomplete type`, d.pos);
    if (isVoid(type)) this.err(`variable '${d.name}' cannot be void`, d.pos);
    const big = type.size > 4;
    const off = big ? this.allocPersist(type.size, this.alignOf(type)) : this.allocLocal(type.size, this.alignOf(type));
    const v = { kind: 'var', name: d.name, type, loc: { k: 'loc', off } };
    sc.syms.set(d.name, v);
    if (init) {
      this.line(d.pos);
      const m = this.tempMark();
      this.genLocalInit(v, init, d.pos);
      this.tempRelease(m);
    }
  }

  declareFunc(name, t, isStatic, pos) {
    if (!isStatic || this.scope !== this.fileScope) {
      const e = this.ext.get(name);
      if (e) {
        if (e.kind !== 'func') this.err(`'${name}' redeclared as a different kind of symbol`, pos);
        if (t.proto && e.type.proto && !this.sameSig(e.type, t)) this.err(`conflicting types for '${name}'`, pos);
        if (t.proto && !e.type.proto) e.type = t;
        return e;
      }
      const fileSym = this.fileScope.syms.get(name);
      if (fileSym && fileSym.kind === 'func' && fileSym.isStatic) return fileSym;
      const f = { kind: 'func', name, type: t, label: `C_${name}`, defined: false, isStatic: false };
      this.ext.set(name, f);
      return f;
    }
    const old = this.fileScope.syms.get(name);
    if (old && old.kind === 'func') {
      if (t.proto && old.type.proto && !this.sameSig(old.type, t)) this.err(`conflicting types for '${name}'`, pos);
      return old;
    }
    return { kind: 'func', name, type: t, label: `C${++this.lbl}_${name}`, defined: false, isStatic: true };
  }
  sameSig(a, b) {
    if (!this.sameType(a.ret, b.ret) && !(isVoid(a.ret) && isVoid(b.ret))) return false;
    if (a.params.length !== b.params.length || a.variadic !== b.variadic) return false;
    return a.params.every((p, i) => this.sameType(p.type, b.params[i].type) || (isInt(p.type) && isInt(b.params[i].type) && p.type.size === b.params[i].type.size));
  }

  globalVar(name, t, sp, pos, hasInit) {
    if (sp.storage === 'static') {
      const old = this.fileScope.syms.get(name);
      if (old && old.kind === 'var' && old.isStatic) return old;
      const g = { kind: 'var', name, type: t, label: `G${++this.lbl}_${name}`, defined: false, isStatic: true, tentative: true };
      g.loc = { k: 'glob', g: g.label };
      this.fileScope.syms.set(name, g);
      this.pendingGlobals.push(g);
      return g;
    }
    let g = this.ext.get(name);
    if (g) {
      if (g.kind !== 'var') this.err(`'${name}' redeclared as a different kind of symbol`, pos);
      if (!this.sameType(g.type, t)) this.err(`conflicting types for '${name}'`, pos);
      if (isArray(t) && t.n !== null && g.type.n === null) g.type = t;
    } else {
      g = { kind: 'var', name, type: t, label: `G_${name}`, defined: false, isStatic: false, tentative: false };
      g.loc = { k: 'glob', g: g.label };
      this.ext.set(name, g);
    }
    if (this.scope === this.fileScope) this.fileScope.syms.set(name, g);
    if (sp.storage !== 'extern' && !g.tentative) { g.tentative = true; this.pendingGlobals.push(g); }
    else if (sp.storage === 'extern' && !g.used) { g.used = true; this.uses.push({ label: g.label, name, pos }); }
    return g;
  }

  // a defined global: its bytes in the data, or room in the bss
  emitGlobal(g, init, pos) {
    if (g.emitted) return;
    let type = g.type;
    if (isArray(type) && type.n === null) {
      if (!init) { type = this.arr(type.of, 1); this.warn(`array '${g.name}' assumed to have one element`, pos); }
      else type = this.arr(type.of, this.initCount(type, init));
      g.type = type;
    }
    if (isStruct(type) && !type.complete) this.err(`'${g.name}' has an incomplete type`, pos);
    g.emitted = true;
    const align = this.alignOf(type);
    if (!init) {
      this.bss.push({ label: g.label, size: type.size || 1, align, module: this.module });
      return;
    }
    const bytes = new Array(type.size).fill(0);
    for (const it of this.flatInit(type, init)) this.staticItem(bytes, it, g.label);
    this.data.push({ label: g.label, bytes, align, module: this.module });
  }
  staticItem(bytes, it, label) {
    if (it.str) {
      for (let i = 0; i < it.max && i < it.str.length; i++) bytes[it.off + i] = it.str[i];
      return;
    }
    if (it.copy) this.err('initializer element is not constant', it.pos);
    const v = this.staticValue(this.conv(it.expr, it.type), it.pos);
    if (v.label) {
      if (!isPtr(it.type) && !(isInt(it.type) && it.type.size >= this.target.ptrSize)) this.err('an address does not fit here', it.pos);
      this.relocs.push({ g: label, off: it.off, target: v.label, toff: v.off, far: it.type.size === 4 && this.target.ptrSize === 2, fn: !!(v.fn && this.fn4) });
      return;
    }
    let n = v.v;
    if (isFloat(it.type)) n = realBits(n);
    if (it.bits) {
      const mask = (2 ** it.bits) - 1;
      let unit = 0;
      for (let k = 0; k < it.unit; k++) unit += bytes[it.off + k] * 2 ** (8 * k);
      unit = (unit & ~(mask * 2 ** it.bitoff) >>> 0) + ((n & mask) * 2 ** it.bitoff);
      for (let k = 0; k < it.unit; k++) bytes[it.off + k] = Math.floor(unit / 2 ** (8 * k)) & 255;
      return;
    }
    for (let k = 0; k < it.type.size; k++) bytes[it.off + k] = Math.floor((n >>> 0) / 2 ** (8 * k)) & 255;
  }
  // a constant (number) or an address constant ({label, off})
  staticValue(e, pos) {
    const r = this.addrConst(e);
    if (r) return r;
    this.err('initializer element is not constant', pos || e.pos);
  }
  addrConst(e) {
    switch (e.n) {
      case 'const': return { v: e.v };
      case 'str': return { label: this.strLabel(e.bytes), off: 0 };
      case 'fnaddr': return { label: e.sym.label, off: 0, fn: true };
      case 'addr': case 'decay': return this.lvConst(e.e);
      case 'cvt': {
        const r = this.addrConst(e.e);
        if (r && r.label && (isPtr(e.type) || (isInt(e.type) && e.type.size >= this.target.ptrSize))) return r;
        if (r && !r.label) return r;
        return null;
      }
      case 'bin': {
        if ((e.op === '+' || e.op === '-') && isPtr(e.type)) {
          const a = this.addrConst(e.l), b = this.addrConst(e.r);
          if (a && a.label && b && !b.label) return { label: a.label, off: a.off + (e.op === '+' ? b.v : -b.v) };
          if (b && b.label && a && !a.label && e.op === '+') return { label: b.label, off: b.off + a.v };
        }
        return null;
      }
    }
    return null;
  }
  lvConst(e) {
    switch (e.n) {
      case 'var':
        if (e.sym.loc.k === 'glob') { this.noteUse(e.sym, e.pos); return { label: e.sym.loc.g, off: 0 }; }
        if (e.sym.loc.k === 'abs') return { v: e.sym.loc.a };
        return null;
      case 'member': { const r = this.lvConst(e.e); return r ? (r.label ? { label: r.label, off: r.off + e.f.off } : { v: r.v + e.f.off }) : null; }
      case 'deref': return this.addrConst(e.e);
      case 'str': return { label: this.strLabel(e.bytes), off: 0 };
    }
    return null;
  }

  // ---------------------------------------------------------- initializers
  initializer() {
    const pos = this.tk.pos;
    if (this.accept('{')) {
      const items = [];
      while (!this.accept('}')) {
        const desig = [];
        for (;;) {
          if (this.is('.') && this.peek().k === 'id') { this.next(); desig.push({ field: this.next().v, pos }); continue; }
          if (this.is('[')) { this.next(); const v = this.constInt(this.condExpr()); this.expect(']'); desig.push({ index: v }); continue; }
          break;
        }
        if (desig.length) this.expect('=');
        items.push({ desig, init: this.initializer() });
        if (!this.accept(',')) { this.expect('}'); break; }
      }
      return { list: items, pos };
    }
    return { expr: this.assignExpr(), pos };
  }
  // the number of elements an initializer gives an array of unknown size
  initCount(type, init) {
    if (!init.list) {
      if (isCharT(type.of) && init.expr.n === 'str') return init.expr.bytes.length + 1;
      this.err('an array needs a { } initializer', init.pos);
    }
    if (isCharT(type.of) && init.list.length === 1 && init.list[0].init.expr && init.list[0].init.expr.n === 'str') return init.list[0].init.expr.bytes.length + 1;
    const t = this.arr(type.of, null);
    const out = [];
    const r = this.initAgg(t, 0, init.list, 0, out, true);
    return r.count;
  }
  // initializer -> [{off, type, expr} | {off, str, max} | {off, type, expr, copy}]
  flatInit(type, init) {
    const out = [];
    this.initInto(type, 0, init, out);
    return out;
  }
  initInto(type, off, init, out) {
    if (!init.list) {
      const e = init.expr;
      if (isArray(type) && isCharT(type.of) && e.n === 'str') { out.push({ off, str: e.bytes.concat([0]), max: type.n, pos: init.pos }); return; }
      if (isStruct(type)) {
        if (isStruct(e.type) && this.sameStruct(e.type, type)) { out.push({ off, type, expr: e, copy: true, pos: init.pos }); return; }
        this.err(`a ${ctypeName(type)} needs a { } initializer`, init.pos);
      }
      if (isArray(type)) this.err('an array needs a { } initializer', init.pos);
      out.push({ off, type, expr: e, pos: init.pos });
      return;
    }
    if (isArray(type) && isCharT(type.of) && init.list.length === 1 && !init.list[0].desig.length && init.list[0].init.expr && init.list[0].init.expr.n === 'str') {
      this.initInto(type, off, init.list[0].init, out);
      return;
    }
    if (!isAggregate(type)) {
      if (!init.list.length) { out.push({ off, type, expr: this.mkConst(0, CT.int), pos: init.pos }); return; }
      this.initInto(type, off, init.list[0].init, out);
      return;
    }
    const r = this.initAgg(type, off, init.list, 0, out, true);
    if (r.i < init.list.length) this.err('too many initializers', init.list[r.i].init.pos);
  }
  initAgg(type, off, items, i, out, braced) {
    if (isArray(type)) {
      let k = 0, max = 0;
      const n = type.n;
      const es = type.of.size;
      while (i < items.length) {
        const it = items[i];
        if (it.desig.length) {
          if (!braced) break;
          if (it.desig[0].index === undefined) this.err('a [index] designator is needed in an array initializer', it.init.pos);
          k = it.desig[0].index;
        }
        if (n !== null && k >= n) { if (braced) this.err('too many initializers for the array', it.init.pos); break; }
        if (it.desig.length > 1) { this.initDesig(type.of, off + k * es, it.desig.slice(1), it.init, out); i++; }
        else i = this.initElem(type.of, off + k * es, items, i, out);
        k++;
        if (k > max) max = k;
      }
      return { i, count: max };
    }
    const fields = type.fields.filter(f => f.name);
    let k = 0, any = false;
    while (i < items.length) {
      const it = items[i];
      if (it.desig.length) {
        if (!braced) break;
        const nm = it.desig[0].field;
        if (nm === undefined) this.err('a .member designator is needed in a struct initializer', it.init.pos);
        k = fields.findIndex(f => f.name === nm);
        if (k < 0) this.err(`${ctypeName(type)} has no member '${nm}'`, it.init.pos);
      } else if (type.union && any) { if (braced) this.err('too many initializers for the union', it.init.pos); break; }
      if (k >= fields.length) { if (braced) this.err('too many initializers for the struct', it.init.pos); break; }
      const f = fields[k];
      if (it.desig.length > 1) { this.initDesig(f.type, off + f.off, it.desig.slice(1), it.init, out); i++; }
      else i = this.initElem(f.type, off + f.off, items, i, out, f);
      k++;
      any = true;
    }
    return { i, count: k };
  }
  initDesig(type, off, desig, init, out) {
    const d = desig[0];
    if (d.index !== undefined) {
      if (!isArray(type)) this.err('[index] designator for something that is not an array', init.pos);
      off += d.index * type.of.size;
      type = type.of;
    } else {
      if (!isStruct(type)) this.err('.member designator for something that is not a struct', init.pos);
      const f = type.fields.find(x => x.name === d.field);
      if (!f) this.err(`${ctypeName(type)} has no member '${d.field}'`, init.pos);
      off += f.off; type = f.type;
      if (desig.length === 1 && f.bits) { out.push({ off, type, expr: init.expr, bits: f.bits, bitoff: f.bitoff, unit: f.unit, pos: init.pos }); return; }
    }
    if (desig.length > 1) this.initDesig(type, off, desig.slice(1), init, out);
    else this.initInto(type, off, init, out);
  }
  initElem(type, off, items, i, out, field) {
    const it = items[i];
    if (it.init.list) { this.initInto(type, off, it.init, out); return i + 1; }
    const e = it.init.expr;
    if (isAggregate(type)) {
      if (isArray(type) && isCharT(type.of) && e.n === 'str') { out.push({ off, str: e.bytes.concat([0]), max: type.n, pos: it.init.pos }); return i + 1; }
      if (isStruct(type) && this.sameStruct(e.type, type)) { out.push({ off, type, expr: e, copy: true, pos: it.init.pos }); return i + 1; }
      return this.initAgg(type, off, items, i, out, false).i;
    }
    if (field && field.bits) out.push({ off, type, expr: e, bits: field.bits, bitoff: field.bitoff, unit: field.unit, pos: it.init.pos });
    else out.push({ off, type, expr: e, pos: it.init.pos });
    return i + 1;
  }

  genLocalInit(v, init, pos) {
    const t = v.type;
    const lv = { n: 'var', sym: v, type: t, lv: true, pos };
    if (!isAggregate(t)) {
      if (init.list) {
        const items = this.flatInit(t, init);
        this.genAssign(lv, this.assignConv(t, items.length ? items[0].expr : this.mkConst(0, CT.int), pos, 'initialization'), false, pos);
      } else this.genAssign(lv, this.assignConv(t, init.expr, pos, 'initialization'), false, pos);
      return;
    }
    if (!init.list && isStruct(t)) { this.genAssign(lv, init.expr, false, pos); return; }
    const items = this.flatInit(t, init);
    // all constant: a copy of an image in the data
    const bytes = new Array(t.size).fill(0);
    let constant = true;
    for (const it of items) {
      if (it.str) continue;
      if (it.copy) { constant = false; break; }
      const c = this.conv(it.expr, it.type);
      if (c.n !== 'const') { constant = false; break; }
    }
    if (constant && t.size >= 8) {
      for (const it of items) this.staticItem(bytes, it, null);
      const label = `CI${++this.lbl}`;
      this.data.push({ label, bytes, align: this.alignOf(t), ro: true, module: this.module });
      this.emit({ o: 'laddr', hops: 0, off: v.loc.off, kind: 'loc' });
      this.emit({ o: 'gaddr', g: label, off: 0 });
      this.emit({ o: 'copy', n: t.size });
      return;
    }
    // zero, then the elements one by one
    this.genFill(() => this.emit({ o: 'laddr', hops: 0, off: v.loc.off, kind: 'loc' }), t.size, 0);
    for (const it of items) {
      if (it.str) {
        const n = Math.min(it.max === null ? it.str.length : it.max, it.str.length);
        this.emit({ o: 'laddr', hops: 0, off: v.loc.off + it.off, kind: 'loc' });
        this.emit({ o: 'gaddr', g: this.strLabel(it.str.slice(0, -1)), off: 0 });
        this.emit({ o: 'copy', n });
        continue;
      }
      if (!it.copy && !it.bits) {
        const c = this.conv(it.expr, it.type);
        if (c.n === 'const' && c.v === 0) continue;
      }
      const target = { n: 'var', sym: { kind: 'var', type: it.type, loc: { k: 'loc', off: v.loc.off + it.off } }, type: it.type, lv: true, pos: it.pos };
      if (it.bits) { target.n = 'member'; target.e = { n: 'var', sym: { kind: 'var', type: CT.uchar, loc: { k: 'loc', off: v.loc.off + it.off } }, type: CT.uchar, lv: true }; target.f = { name: '', type: it.type, off: 0, bits: it.bits, bitoff: it.bitoff, unit: it.unit }; }
      this.genAssign(target, it.copy ? it.expr : this.assignConv(it.type, it.expr, it.pos, 'initialization'), false, it.pos);
    }
  }
  genFill(addr, n, val) {
    const fill = this.pf.units.get('system').iface.syms.get('_fill');
    addr();
    this.emit({ o: 'arg', s: this.P });
    this.emit({ o: 'lit', s: 'W', v: n });
    this.emit({ o: 'arg', s: 'W' });
    this.emit({ o: 'lit', s: 'W', v: val });
    this.emit({ o: 'arg', s: 'W' });
    this.emit({ o: 'call', l: fill.label, args: fill.parBytes, ret: null, ext: fill.external });
  }

  strLabel(bytes) {
    const key = this.module + '|' + bytes.join(',');
    if (this.strLits.has(key)) return this.strLits.get(key);
    const label = `CS${++this.lbl}`;
    this.data.push({ label, bytes: bytes.concat([0]), align: 1, ro: true, module: this.module });
    this.strLits.set(key, label);
    return label;
  }

  // ---------------------------------------------------------- functions
  funcDef(d, sp) {
    const t = d.type;
    if (isStruct(t.ret) && !t.ret.complete) this.err(`'${d.name}' returns an incomplete type`, d.pos);
    const f = this.declareFunc(d.name, t, sp.storage === 'static', d.pos);
    this.fileScope.syms.set(d.name, f);
    if (f.defined) this.err(`redefinition of '${d.name}'`, d.pos);
    f.defined = true;
    f.type = t;
    const ctx = new FnCtx(f.label, d.name);
    ctx.fn = f;
    ctx.retType = t.ret;
    this.ctx = ctx;
    const outer = this.scope;
    this.scope = new Scope(this.fileScope);
    // parameters: the first one next to the frame
    let off = 0;
    const sret = isStruct(t.ret);
    if (sret) { ctx.sretOff = 0; off += this.target.argSlot || this.target.ptrSize; }
    const names = d.params || [];
    t.params.forEach((p, i) => {
      const nm = names[i] ? names[i].name : p.name;
      if (isStruct(p.type) && !p.type.complete) this.err(`parameter '${nm}' has an incomplete type`, p.pos);
      if (isStruct(p.type)) {
        if (nm) this.scope.syms.set(nm, { kind: 'var', name: nm, type: p.type, loc: { k: 'par', off, byRef: true } });
        off += this.target.argSlot || this.target.ptrSize;
        return;
      }
      if (nm) {
        if (this.scope.syms.has(nm)) this.err(`two parameters named '${nm}'`, p.pos);
        this.scope.syms.set(nm, { kind: 'var', name: nm, type: p.type, loc: { k: 'par', off } });
      }
      off += this.slot(p.type);
    });
    ctx.parBytes = off;
    ctx.exitLabel = this.newLabel('CX');
    if (!isVoid(t.ret)) {
      const rt = sret ? this.ptr(t.ret) : t.ret;
      const roff = this.allocLocal(rt.size, this.alignOf(rt));
      ctx.resultLoc = { off: roff, mt: this.mt(rt) };
      ctx.retCls = this.cls(rt);
    }
    if (d.name === 'main' && isInt(t.ret)) {
      this.emit({ o: 'lit', s: ctx.retCls, v: 0 });
      this.emit({ o: 'stl', hops: 0, off: ctx.resultLoc.off, kind: 'loc', mt: ctx.resultLoc.mt });
    }
    this.scope.syms.set('__func__', { kind: 'strconst', bytes: [...d.name].map(c => c.charCodeAt(0) & 255) });
    this.compound(true);
    for (const [nm, l] of ctx.labels) if (!l.defined) this.err(`label '${nm}' is used but not defined`, l.pos);
    this.emit({ o: 'label', l: ctx.exitLabel });
    // the big locals go after the others
    const al = 4;
    const base = Math.ceil(ctx.locMax / al) * al;
    if (ctx.persist) {
      for (const ins of ctx.code) {
        if ((ins.o === 'laddr' || ins.o === 'ldl' || ins.o === 'stl') && ins.kind === 'loc' && ins.off >= PERSIST) ins.off = ins.off - PERSIST + base;
        if (ins.o === 'asm') for (const l of ins.lines) for (const q of l.parts) if (typeof q === 'object' && q.kind === 'loc' && q.off >= PERSIST) q.off = q.off - PERSIST + base;
      }
      if (ctx.resultLoc && ctx.resultLoc.off >= PERSIST) ctx.resultLoc.off = ctx.resultLoc.off - PERSIST + base;
    }
    const locSize = ctx.persist ? base + ctx.persist : ctx.locMax;
    this.procs.push({
      label: f.label, name: d.name, level: 1, locSize, parBytes: ctx.parBytes, hasSL: false,
      retCls: ctx.retCls || null, resultLoc: ctx.resultLoc || null, parent: null, code: ctx.code, module: this.module,
    });
    this.scope = outer;
    this.ctx = null;
  }

  emit(ins) { this.ctx.code.push(ins); return ins; }
  line(pos) { if (pos && this.ctx) this.emit({ o: 'line', file: pos.file, line: pos.line }); }
  allocLocal(size, align = 1) {
    const c = this.ctx;
    let off = c.locTop;
    if (align > 1) off = Math.ceil(off / align) * align;
    c.locTop = off + size;
    if (c.locTop > c.locMax) c.locMax = c.locTop;
    return off;
  }
  allocPersist(size, align = 1) {
    const c = this.ctx;
    const al = Math.max(align, this.target.align ? 4 : 1);
    c.persist = Math.ceil(c.persist / al) * al;
    const off = PERSIST + c.persist;
    c.persist += size;
    return off;
  }
  tempMark() { return this.ctx.locTop; }
  tempRelease(m) { this.ctx.locTop = m; }
  temp(type) {
    if (type.size > 4) return { kind: 'var', type, loc: { k: 'loc', off: this.allocPersist(type.size, this.alignOf(type)) } };
    return { kind: 'var', type, loc: { k: 'loc', off: this.allocLocal(type.size, this.alignOf(type)) } };
  }
  tvar(sym) { return { n: 'var', sym, type: sym.type, lv: true }; }

  // ---------------------------------------------------------- statements
  compound(fnBody) {
    this.expect('{');
    const outer = this.scope;
    if (!fnBody) this.scope = new Scope(outer);
    const mark = this.ctx.locTop;
    while (!this.accept('}')) {
      if (this.tk.k === 'eof') this.err("'}' expected but end of file found");
      this.blockItem();
    }
    this.ctx.locTop = mark;
    this.scope = outer;
  }
  blockItem() {
    if (this.is('_Static_assert')) { this.staticAssert(); return; }
    if (this.isTypeStart() && !(this.tk.k === 'id' && this.isAt(1, ':'))) {
      const sp = this.parseSpecs(true);
      if (this.accept(';')) return;
      for (;;) {
        const d = this.declarator(sp.type, sp, false);
        this.declareName(d, sp, false);
        if (!this.accept(',')) break;
      }
      this.expect(';');
      return;
    }
    this.statement();
  }
  statement() {
    const t = this.tk;
    const pos = t.pos;
    if (t.k === 'id' && this.isAt(1, ':')) {
      this.next(); this.next();
      const l = this.labelFor(t.v, pos);
      if (l.defined) this.err(`label '${t.v}' defined twice`, pos);
      l.defined = true;
      this.emit({ o: 'label', l: l.l });
      if (this.is('}')) return;
      this.statement();
      return;
    }
    if (t.k === 'asm') { this.next(); this.line(pos); this.asmBlock(t.v, t.bodyLine, pos); this.accept(';'); return; }
    if (t.k === 'kw') {
      switch (t.v) {
        case 'if': {
          this.next();
          this.line(pos);
          this.expect('(');
          const m = this.tempMark();
          const c = this.expr();
          this.expect(')');
          const lF = this.newLabel();
          this.genCond(this.scalarCond(c), lF);
          this.tempRelease(m);
          this.statement();
          if (this.accept('else')) {
            const lE = this.newLabel();
            this.emit({ o: 'jmp', l: lE });
            this.emit({ o: 'label', l: lF });
            this.statement();
            this.emit({ o: 'label', l: lE });
          } else this.emit({ o: 'label', l: lF });
          return;
        }
        case 'while': {
          this.next();
          this.expect('(');
          const lTop = this.newLabel(), lEnd = this.newLabel();
          this.emit({ o: 'label', l: lTop });
          this.line(pos);
          const m = this.tempMark();
          const c = this.expr();
          this.expect(')');
          this.genCond(this.scalarCond(c), lEnd);
          this.tempRelease(m);
          this.loopBody(lEnd, lTop);
          this.emit({ o: 'jmp', l: lTop });
          this.emit({ o: 'label', l: lEnd });
          return;
        }
        case 'do': {
          this.next();
          const lTop = this.newLabel(), lCont = this.newLabel(), lEnd = this.newLabel();
          this.emit({ o: 'label', l: lTop });
          this.loopBody(lEnd, lCont);
          this.expect('while');
          this.emit({ o: 'label', l: lCont });
          this.line(this.tk.pos);
          this.expect('(');
          const m = this.tempMark();
          const c = this.expr();
          this.expect(')');
          this.expect(';');
          this.genCondTrue(this.scalarCond(c), lTop);
          this.tempRelease(m);
          this.emit({ o: 'label', l: lEnd });
          return;
        }
        case 'for': {
          this.next();
          this.expect('(');
          const outer = this.scope;
          this.scope = new Scope(outer);
          const mark0 = this.ctx.locTop;
          this.line(pos);
          if (!this.accept(';')) {
            if (this.isTypeStart()) {
              const sp = this.parseSpecs(true);
              for (;;) {
                const d = this.declarator(sp.type, sp, false);
                this.declareName(d, sp, false);
                if (!this.accept(',')) break;
              }
              this.expect(';');
            } else {
              const m = this.tempMark();
              this.genVoid(this.expr());
              this.tempRelease(m);
              this.expect(';');
            }
          }
          const lTop = this.newLabel(), lCont = this.newLabel(), lEnd = this.newLabel();
          this.emit({ o: 'label', l: lTop });
          if (!this.is(';')) {
            const m = this.tempMark();
            const c = this.expr();
            this.genCond(this.scalarCond(c), lEnd);
            this.tempRelease(m);
          }
          this.expect(';');
          // the step is generated after the body
          let stepToks = null;
          if (!this.is(')')) {
            const start = this.p;
            let depth = 0;
            while (!(depth === 0 && this.is(')'))) {
              if (this.tk.k === 'eof') this.err("')' expected");
              if (this.is('(')) depth++;
              if (this.is(')')) depth--;
              this.next();
            }
            stepToks = [start, this.p];
          }
          this.expect(')');
          this.loopBody(lEnd, lCont);
          this.emit({ o: 'label', l: lCont });
          if (stepToks) {
            const save = this.p;
            this.p = stepToks[0];
            const m = this.tempMark();
            const e = this.expr();
            if (this.p !== stepToks[1]) this.err("')' expected");
            this.genVoid(e);
            this.tempRelease(m);
            this.p = save;
          }
          this.emit({ o: 'jmp', l: lTop });
          this.emit({ o: 'label', l: lEnd });
          this.ctx.locTop = mark0;
          this.scope = outer;
          return;
        }
        case 'switch': {
          this.next();
          this.line(pos);
          this.expect('(');
          const e0 = this.rv(this.expr());
          this.expect(')');
          if (!isInt(e0.type)) this.err('switch needs an integer value', pos);
          const st = this.promote(e0.type);
          const tmp = this.temp(st);
          this.genAssign(this.tvar(tmp), this.conv(e0, st), false, pos);
          const sw = { type: st, cases: [], def: null, tmp };
          const lDisp = this.newLabel(), lEnd = this.newLabel();
          this.emit({ o: 'jmp', l: lDisp });
          this.ctx.switches.push(sw);
          this.ctx.breaks.push(lEnd);
          this.statement();
          this.ctx.breaks.pop();
          this.ctx.switches.pop();
          this.emit({ o: 'jmp', l: lEnd });
          this.emit({ o: 'label', l: lDisp });
          const cls = this.cls(st);
          for (const c of sw.cases) {
            this.genValue(this.tvar(tmp));
            this.emit({ o: 'lit', s: cls, v: c.v });
            this.emit({ o: 'jc', c: 'eq', s: cls, u: !st.signed, l: c.l });
          }
          if (sw.def) this.emit({ o: 'jmp', l: sw.def });
          this.emit({ o: 'label', l: lEnd });
          return;
        }
        case 'case': {
          this.next();
          const sw = this.ctx.switches[this.ctx.switches.length - 1];
          if (!sw) this.err("'case' outside a switch", pos);
          let v = this.constInt(this.condExpr());
          let hi = v;
          if (this.accept('...')) hi = this.constInt(this.condExpr());     // GNU case ranges
          this.expect(':');
          const l = this.newLabel();
          for (let x = v; x <= hi; x++) {
            const w = this.wrapInt(x, sw.type);
            if (sw.cases.some(c => c.v === w)) this.err(`duplicate case value ${x}`, pos);
            sw.cases.push({ v: w, l });
            if (hi - v > 1024) this.err('case range too large', pos);
          }
          this.emit({ o: 'label', l });
          if (this.is('}')) return;
          this.statement();
          return;
        }
        case 'default': {
          this.next();
          this.expect(':');
          const sw = this.ctx.switches[this.ctx.switches.length - 1];
          if (!sw) this.err("'default' outside a switch", pos);
          if (sw.def) this.err("two 'default' labels in one switch", pos);
          sw.def = this.newLabel();
          this.emit({ o: 'label', l: sw.def });
          if (this.is('}')) return;
          this.statement();
          return;
        }
        case 'break': {
          this.next(); this.expect(';');
          const l = this.ctx.breaks[this.ctx.breaks.length - 1];
          if (!l) this.err("'break' outside a loop or switch", pos);
          this.emit({ o: 'jmp', l });
          return;
        }
        case 'continue': {
          this.next(); this.expect(';');
          const l = this.ctx.conts[this.ctx.conts.length - 1];
          if (!l) this.err("'continue' outside a loop", pos);
          this.emit({ o: 'jmp', l });
          return;
        }
        case 'goto': {
          this.next();
          const id = this.expectId();
          this.expect(';');
          this.emit({ o: 'jmp', l: this.labelFor(id.v, id.pos).l });
          return;
        }
        case 'return': {
          this.next();
          this.line(pos);
          const ctx = this.ctx;
          if (!this.is(';')) {
            const m = this.tempMark();
            const e = this.expr();
            if (isVoid(ctx.retType)) {
              if (!isVoid(e.type)) this.err(`'${ctx.name}' returns void; it cannot return a value`, pos);
              this.genVoid(e);
            } else if (isStruct(ctx.retType)) {
              const r = this.rv(e);
              if (!this.sameStruct(r.type, ctx.retType)) this.err(`return of ${ctypeName(r.type)} from a function returning ${ctypeName(ctx.retType)}`, pos);
              this.emit({ o: 'ldl', hops: 0, off: ctx.sretOff, kind: 'par', mt: this.mt(this.ptr(CT.void)) });
              this.genAddr(r);
              this.emit({ o: 'copy', n: ctx.retType.size });
              this.emit({ o: 'ldl', hops: 0, off: ctx.sretOff, kind: 'par', mt: this.mt(this.ptr(CT.void)) });
              this.emit({ o: 'stl', hops: 0, off: ctx.resultLoc.off, kind: 'loc', mt: ctx.resultLoc.mt });
            } else {
              const c = this.assignConv(ctx.retType, e, pos, 'return');
              this.genValue(c);
              this.emit({ o: 'stl', hops: 0, off: ctx.resultLoc.off, kind: 'loc', mt: ctx.resultLoc.mt });
            }
            this.tempRelease(m);
          } else if (!isVoid(ctx.retType) && ctx.name !== 'main') {
            this.warn(`'return' without a value in '${ctx.name}', which returns ${ctypeName(ctx.retType)}`, pos);
          }
          this.expect(';');
          this.emit({ o: 'jmp', l: ctx.exitLabel });
          return;
        }
      }
    }
    if (this.is('{')) { this.compound(false); return; }
    if (this.accept(';')) return;
    if (t.k === 'id' && (t.v === 'asm' || t.v === '__asm' || t.v === '__asm__') && this.isAt(1, '(')) {
      this.next(); this.next();
      const s = this.next();
      if (s.k !== 'str') this.err('asm("...") needs a string');
      this.expect(')');
      this.expect(';');
      this.line(pos);
      this.asmBlock(String.fromCharCode(...s.bytes), pos.line, pos);
      return;
    }
    this.line(pos);
    const m = this.tempMark();
    const e = this.expr();
    this.expect(';');
    this.genVoid(e);
    this.tempRelease(m);
  }
  loopBody(lBreak, lCont) {
    this.ctx.breaks.push(lBreak);
    this.ctx.conts.push(lCont);
    this.statement();
    this.ctx.breaks.pop();
    this.ctx.conts.pop();
  }
  labelFor(name, pos) {
    let l = this.ctx.labels.get(name);
    if (!l) { l = { l: this.newLabel('CG'), defined: false, pos }; this.ctx.labels.set(name, l); }
    return l;
  }

  // asm { ... }: one instruction a line, like Pascal's asm blocks. Names of
  // the function's locals and parameters stand for their place in the frame,
  // globals for their address, enum constants for their value.
  asmBlock(text, firstLine, pos) {
    const lines = [];
    text.split('\n').forEach((raw, k) => {
      let s = raw.replace(/\r$/, '');
      // a comment: ; (or # on SCHUB, // on both)
      let inq = false, cut = -1;
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "'" || c === '"') inq = !inq;
        if (!inq && (c === ';' || (c === '/' && s[i + 1] === '/'))) { cut = i; break; }
      }
      if (cut >= 0) s = s.slice(0, cut);
      const l = { label: null, parts: [], line: firstLine + k };
      const lm = /^\s*([A-Za-z_.@][\w.@]*):(?!=)/.exec(s);
      if (lm) { l.label = lm[1]; s = s.slice(lm[0].length); }
      s = s.trim();
      if (s) {
        const m = /^(\S+)(\s*)(.*)$/.exec(s);
        const parts = [m[1] + (m[3] ? ' ' : '')];
        const rest = m[3];
        const re = /[A-Za-z_][\w]*|[^A-Za-z_]+/g;
        let x;
        while ((x = re.exec(rest))) {
          const w = x[0];
          if (/^[A-Za-z_]/.test(w)) {
            const sym = this.lookup(w);
            if (sym && sym.kind === 'var' && sym.loc) {
              if (sym.loc.k === 'loc') { parts.push({ kind: 'loc', off: sym.loc.off }); continue; }
              if (sym.loc.k === 'par') { parts.push({ kind: 'par', off: sym.loc.off }); continue; }
              if (sym.loc.k === 'glob') { this.noteUse(sym, pos); parts.push({ r: 'glob', g: sym.loc.g }); continue; }
              if (sym.loc.k === 'abs') { parts.push({ r: 'glob', g: sym.loc.a }); continue; }
            }
            if (sym && sym.kind === 'enumc') { parts.push(String(sym.v)); continue; }
            if (sym && sym.kind === 'func') { this.noteFn(sym, pos); parts.push(sym.label); continue; }
          }
          parts.push(w);
        }
        l.parts = parts;
      }
      if (l.label || l.parts.length) lines.push(l);
    });
    this.emit({ o: 'asm', lines, file: pos.file });
  }

  // ---------------------------------------------------------- expressions (trees)
  mkConst(v, type) {
    if (isFloat(type)) return { n: 'const', v: Math.fround(v), type };
    return { n: 'const', v: this.wrapInt(v, type), type };
  }
  wrapInt(v, t) {
    if (isPtr(t)) t = t.size === 4 ? CT.ulong : CT.uint;
    if (t.bool) return v ? 1 : 0;
    const bits = t.size * 8;
    if (bits === 32) return t.signed ? (v | 0) : (v >>> 0);
    const m = 2 ** bits;
    let r = ((Math.trunc(v) % m) + m) % m;
    if (t.signed && r >= m / 2) r -= m;
    return r;
  }
  constInt(e) {
    const c = this.rv(e);
    if (c.n !== 'const' || !isInt(c.type)) this.err('an integer constant is needed here', e.pos);
    return c.v;
  }

  expr() {
    let e = this.assignExpr();
    while (this.is(',')) {
      const pos = this.next().pos;
      const r = this.assignExpr();
      e = { n: 'comma', l: e, r: this.rv(r), type: this.rv(r).type, pos };
    }
    return e;
  }

  assignExpr() {
    const l = this.condExpr();
    const t = this.tk;
    if (t.k === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|='].includes(t.v)) {
      this.next();
      const r = this.assignExpr();
      return this.mkAssign(t.v, l, r, t.pos);
    }
    return l;
  }

  condExpr() {
    const c = this.binExpr(0);
    if (!this.is('?')) return c;
    const pos = this.next().pos;
    const a = this.expr();
    this.expect(':');
    const b = this.condExpr();
    return this.mkCond(c, a, b, pos);
  }

  binExpr(lv) {
    const LV = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
    if (lv >= LV.length) return this.castExpr();
    let l = this.binExpr(lv + 1);
    while (this.tk.k === 'op' && LV[lv].includes(this.tk.v)) {
      const t = this.next();
      const r = this.binExpr(lv + 1);
      l = this.mkBin(t.v, l, r, t.pos);
    }
    return l;
  }

  castExpr() {
    if (this.is('(') && this.isTypeStart(this.peek())) {
      const pos = this.next().pos;
      const t = this.typeName();
      this.expect(')');
      if (this.is('{')) {
        // a compound literal: (T){ ... }
        const init = this.initializer();
        return this.compoundLiteral(t, init, pos);
      }
      const e = this.castExpr();
      return this.mkCast(t, e, pos);
    }
    return this.unary();
  }

  compoundLiteral(t, init, pos) {
    if (!this.ctx) {
      if (isArray(t) && t.n === null) t = this.arr(t.of, this.initCount(t, init));
      const g = { kind: 'var', name: '(literal)', type: t, label: `CL${++this.lbl}_lit`, defined: true, isStatic: true };
      g.loc = { k: 'glob', g: g.label };
      this.emitGlobal(g, init, pos);
      return { n: 'var', sym: g, type: t, lv: true, pos };
    }
    if (isArray(t) && t.n === null) t = this.arr(t.of, this.initCount(t, init));
    const v = { kind: 'var', name: '(literal)', type: t, loc: { k: 'loc', off: this.allocPersist(t.size, this.alignOf(t)) } };
    return { n: 'lit', sym: v, init, type: t, lv: true, pos };
  }

  unary() {
    const t = this.tk;
    const pos = t.pos;
    if (t.k === 'op') {
      switch (t.v) {
        case '++': case '--': { this.next(); const e = this.unary(); return this.mkAssign(t.v === '++' ? '+=' : '-=', e, this.mkConst(1, CT.int), pos); }
        case '&': {
          this.next();
          const e = this.castExpr();
          if (e.n === 'fn') return this.rv(e);
          if (e.n === 'pfn') this.err('the address of a Pascal routine cannot be taken', pos);
          if (!e.lv) this.err("'&' needs a variable", pos);
          if (e.n === 'member' && e.f.bits) this.err('the address of a bit-field cannot be taken', pos);
          return { n: 'addr', e, type: this.ptr(e.type, this.isFarLv(e)), pos };
        }
        case '*': {
          this.next();
          const e = this.rv(this.castExpr());
          if (!isPtr(e.type)) this.err(`'*' needs a pointer, ${ctypeName(e.type)} found`, pos);
          if (isFunc(e.type.to)) return e;   // *f is f
          if (isVoid(e.type.to)) this.err("a void pointer cannot be dereferenced", pos);
          return { n: 'deref', e, type: e.type.to, lv: true, pos };
        }
        case '+': { this.next(); const e = this.rv(this.castExpr()); if (!isArith(e.type)) this.err("'+' needs a number", pos); return this.conv(e, this.promote(e.type)); }
        case '-': {
          this.next();
          const e = this.rv(this.castExpr());
          if (!isArith(e.type)) this.err("'-' needs a number", pos);
          const pt = this.promote(e.type);
          const c = this.conv(e, pt);
          if (c.n === 'const') return this.mkConst(-c.v, pt);
          return { n: 'un', op: '-', e: c, type: pt, pos };
        }
        case '~': {
          this.next();
          const e = this.rv(this.castExpr());
          if (!isInt(e.type)) this.err("'~' needs an integer", pos);
          const pt = this.promote(e.type);
          const c = this.conv(e, pt);
          if (c.n === 'const') return this.mkConst(~c.v, pt);
          return { n: 'un', op: '~', e: c, type: pt, pos };
        }
        case '!': {
          this.next();
          const e = this.scalarCond(this.castExpr());
          if (e.n === 'const') return this.mkConst(e.v ? 0 : 1, CT.int);
          return { n: 'not', e, type: CT.int, pos };
        }
      }
    }
    if (t.k === 'kw' && t.v === 'sizeof') {
      this.next();
      let ty;
      if (this.is('(') && this.isTypeStart(this.peek())) {
        this.next();
        ty = this.typeName();
        this.expect(')');
        if (this.is('{')) { const init = this.initializer(); ty = this.compoundLiteral(ty, init, pos).type; }
      } else {
        const e = this.unary();
        ty = e.type;
        if (e.n === 'member' && e.f.bits) this.err('sizeof of a bit-field', pos);
      }
      if (isFunc(ty)) this.err('sizeof of a function', pos);
      if (isArray(ty) && ty.n === null) this.err('sizeof of an array of unknown size', pos);
      if (isStruct(ty) && !ty.complete) this.err(`sizeof of the incomplete ${ctypeName(ty)}`, pos);
      return this.mkConst(isVoid(ty) ? 1 : ty.size, this.sizeT);
    }
    if (t.k === 'id' && (t.v === '_Alignof' || t.v === '__alignof__')) {
      this.next(); this.expect('('); const ty = this.typeName(); this.expect(')');
      return this.mkConst(this.alignOf(ty), this.sizeT);
    }
    return this.postfix(this.primary());
  }

  primary() {
    const t = this.tk;
    const pos = t.pos;
    switch (t.k) {
      case 'int': this.next(); return { n: 'const', v: t.v, type: t.type, pos };
      case 'float': this.next(); return { n: 'const', v: Math.fround(t.v), type: CT.double, pos };
      case 'str': this.next(); return { n: 'str', bytes: t.bytes, type: this.arr(CT.char, t.bytes.length + 1), lv: true, pos };
      case 'id': {
        this.next();
        if (t.v === '__builtin_va_arg') {
          this.expect('(');
          const ap = this.assignExpr();
          this.expect(',');
          const ty = this.typeName();
          this.expect(')');
          // *(T *)((ap += slot) - slot)
          const s = this.target.argSlot || (ty.size <= 2 ? 2 : 4);
          const step = this.mkAssign('+=', ap, this.mkConst(s, CT.int), pos);
          const back = this.mkBin('-', step, this.mkConst(s, CT.int), pos);
          return { n: 'deref', e: this.mkCast(this.ptr(ty), back, pos), type: ty, lv: true, pos };
        }
        const s = this.lookup(t.v);
        if (!s) {
          if (this.is('(')) {
            // an undeclared function: int f() (old C)
            this.warn(`implicit declaration of function '${t.v}'`, pos);
            const f = this.declareFunc(t.v, { k: 'func', ret: CT.int, params: [], variadic: false, proto: false, size: 1 }, false, pos);
            this.fileScope.syms.set(t.v, f);
            return { n: 'fn', sym: f, type: f.type, pos };
          }
          this.err(`'${t.v}' undeclared`, pos);
        }
        switch (s.kind) {
          case 'var': return { n: 'var', sym: s, type: s.type, lv: true, pos };
          case 'func': return { n: 'fn', sym: s, type: s.type, pos };
          case 'enumc': return { n: 'const', v: s.v, type: s.type, pos };
          case 'fconst': return { n: 'const', v: Math.fround(s.v), type: CT.float, pos };
          case 'strconst': return { n: 'str', bytes: s.bytes, type: this.arr(CT.char, s.bytes.length + 1), lv: true, pos };
          case 'pfunc': return { n: 'pfn', psym: s.psym, name: s.name, type: CT.void, pos };
          case 'typedef': this.err(`'${t.v}' is a type, a value is needed here`, pos);
        }
        this.err(`'${t.v}' cannot be used here`, pos);
        break;
      }
      case 'op':
        if (t.v === '(') {
          this.next();
          if (this.is('{')) this.err('statement expressions are not supported');
          const e = this.expr();
          this.expect(')');
          return e.n === 'const' ? { ...e, paren: true } : e;
        }
        break;
    }
    this.err(`expression expected but ${this.desc(t)} found`);
  }

  postfix(e) {
    for (;;) {
      const t = this.tk;
      const pos = t.pos;
      if (this.is('[')) {
        this.next();
        const i = this.expr();
        this.expect(']');
        const a = this.rv(e), b = this.rv(i);
        let p, idx;
        if (isPtr(a.type)) { p = a; idx = b; } else if (isPtr(b.type)) { p = b; idx = a; } else this.err('subscript of something that is neither an array nor a pointer', pos);
        if (!isInt(idx.type)) this.err('array subscript is not an integer', pos);
        if (isVoid(p.type.to)) this.err('subscript of a void pointer', pos);
        e = { n: 'deref', e: this.ptrAdd(p, idx, '+', pos), type: p.type.to, lv: true, pos };
        continue;
      }
      if (this.is('(')) {
        this.next();
        const args = [];
        if (!this.accept(')')) {
          for (;;) {
            args.push(this.assignExpr());
            if (!this.accept(',')) break;
          }
          this.expect(')');
        }
        e = this.mkCall(e, args, pos);
        continue;
      }
      if (this.is('.') || this.is('->')) {
        const arrow = this.next().v === '->';
        const id = this.expectId();
        let base = e;
        if (arrow) {
          const p = this.rv(e);
          if (!isPtr(p.type) || !isStruct(p.type.to)) this.err(`'->' needs a pointer to a struct, ${ctypeName(p.type)} found`, pos);
          base = { n: 'deref', e: p, type: p.type.to, lv: true, pos };
        }
        if (!isStruct(base.type)) this.err(`'.' needs a struct, ${ctypeName(base.type)} found`, pos);
        if (!base.type.complete) this.err(`use of the incomplete ${ctypeName(base.type)}`, pos);
        const f = base.type.fields.find(f => f.name === id.v) || (base.type.ci && base.type.fields.find(f => f.name === id.v.toLowerCase()));
        if (!f) this.err(`${ctypeName(base.type)} has no member '${id.v}'`, id.pos);
        if (!base.lv) {
          // a member of a struct value (a function result): through its address
          base = { n: 'deref', e: { n: 'addrv', e: base, type: this.ptr(base.type) }, type: base.type, lv: true, pos };
        }
        e = { n: 'member', e: base, f, type: f.type, lv: true, pos };
        continue;
      }
      if (this.is('++') || this.is('--')) {
        const op = this.next().v;
        e = this.mkPost(op, e, pos);
        continue;
      }
      return e;
    }
  }

  isFarLv(e) {
    switch (e.n) {
      case 'deref': return isPtr(e.e.type) && e.e.type.far;
      case 'member': return this.isFarLv(e.e);
      case 'var': return e.sym.loc && e.sym.loc.k === 'abs' && e.sym.loc.a > 0xffff;
    }
    return false;
  }

  // a value: arrays become pointers, functions function pointers
  rv(e) {
    if (!e) return e;
    if (isArray(e.type)) {
      if (e.n === 'str') return { n: 'decay', e, type: this.ptr(CT.char), pos: e.pos };
      return { n: 'decay', e, type: this.ptr(e.type.of, this.isFarLv(e)), pos: e.pos };
    }
    if (e.n === 'fn') { this.noteFn(e.sym, e.pos); return { n: 'fnaddr', sym: e.sym, type: this.ptr(e.type), pos: e.pos }; }
    if (e.n === 'pfn') this.err(`'${e.name}' (Pascal) can only be called`, e.pos);
    return e;
  }
  noteFn(f, pos) {
    if (!f.defined && !f.noted) { f.noted = true; this.uses.push({ label: f.label, name: f.name, pos }); }
  }
  noteUse(g, pos) {
    if (g.label && /^G_/.test(g.label) && !g.used) { g.used = true; this.uses.push({ label: g.label, name: g.name, pos }); }
  }

  // a condition: any scalar
  scalarCond(e) {
    e = this.rv(e);
    if (!isScalar(e.type)) this.err(`a number or a pointer is needed as a condition, ${ctypeName(e.type)} found`, e.pos);
    return e;
  }

  // implicit/explicit conversion of a value to type t
  conv(e, t) {
    e = this.rv(e);
    const f = e.type;
    if (isVoid(t)) return { n: 'cvt', e, type: t, pos: e.pos };
    if (f === t) return e;
    if (isStruct(t) || isStruct(f)) {
      if (this.sameStruct(f, t)) return e;
      this.err(`cannot convert ${ctypeName(f)} to ${ctypeName(t)}`, e.pos);
    }
    if (!isScalar(f) || !isScalar(t)) this.err(`cannot convert ${ctypeName(f)} to ${ctypeName(t)}`, e.pos);
    if (e.n === 'const') {
      if (isFloat(t)) return { n: 'const', v: Math.fround(e.v), type: t, pos: e.pos };
      if (isFloat(f)) return this.mkConst(Math.trunc(e.v), t);
      if (t.bool) return { n: 'const', v: e.v ? 1 : 0, type: t, pos: e.pos };
      return { ...this.mkConst(e.v, t), pos: e.pos };
    }
    if (isPtr(f) && isPtr(t) && f.far === t.far) return { ...e, type: t };
    if (isInt(f) && isInt(t) && f.size === t.size && f.signed === t.signed && !t.bool) return { ...e, type: t };
    return { n: 'cvt', e, type: t, pos: e.pos };
  }

  // assignment-like conversion with the usual checks
  assignConv(t, e, pos, what = 'assignment') {
    e = this.rv(e);
    const f = e.type;
    if (isStruct(t)) {
      if (!this.sameStruct(f, t)) this.err(`${what}: ${ctypeName(f)} given where ${ctypeName(t)} is needed`, pos);
      return e;
    }
    if (isVoid(f)) this.err(`${what}: a void value cannot be used`, pos);
    if (isPtr(t) && isInt(f) && !(e.n === 'const' && e.v === 0)) this.warn(`${what}: integer to pointer without a cast`, pos);
    if (isInt(t) && isPtr(f) && !t.bool) this.warn(`${what}: pointer to integer without a cast`, pos);
    if (isPtr(t) && isPtr(f) && !isVoid(t.to) && !isVoid(f.to) && !this.sameType(t.to, f.to) && !(isInt(t.to) && isInt(f.to) && t.to.size === f.to.size)) {
      this.warn(`${what}: ${ctypeName(f)} given where ${ctypeName(t)} is expected`, pos);
    }
    if (!isScalar(t) || !isScalar(f)) this.err(`${what}: ${ctypeName(f)} given where ${ctypeName(t)} is needed`, pos);
    return this.conv(e, t);
  }

  mkCast(t, e, pos) {
    e = this.rv(e);
    if (isVoid(t)) return { n: 'cvt', e, type: CT.void, pos };
    if (isStruct(t) && this.sameStruct(e.type, t)) return e;
    if (!isScalar(t)) this.err(`cast to ${ctypeName(t)}`, pos);
    if (!isScalar(e.type)) this.err(`cast of ${ctypeName(e.type)}`, pos);
    if (isFloat(t) && isPtr(e.type) || isPtr(t) && isFloat(e.type)) this.err('cast between a pointer and a float', pos);
    const c = this.conv(e, t);
    return c.n === 'const' ? { ...c, pos } : c;
  }

  ptrAdd(p, i, op, pos) {
    const es = isVoid(p.type.to) ? 1 : p.type.to.size;
    if (isStruct(p.type.to) && !p.type.to.complete) this.err(`arithmetic on a pointer to the incomplete ${ctypeName(p.type.to)}`, pos);
    if (isFunc(p.type.to)) this.err('arithmetic on a function pointer', pos);
    const it = p.type.far || this.target.ptrSize === 4 ? (i.type.signed === false && i.type.size < 4 ? CT.ulong : CT.long) : CT.uint;
    let idx = this.conv(i, it);
    if (idx.n === 'const') idx = this.mkConst(idx.v * es, it);
    else if (es !== 1) idx = this.mkBinRaw('*', idx, this.mkConst(es, it), it, pos);
    if (p.n === 'const' && idx.n === 'const') return this.mkConst(op === '+' ? p.v + idx.v : p.v - idx.v, p.type);
    return { n: 'bin', op, l: p, r: idx, type: p.type, ot: p.type, pos };
  }
  mkBinRaw(op, l, r, t, pos) {
    if (l.n === 'const' && r.n === 'const') return this.foldBin(op, l.v, r.v, t, pos);
    return { n: 'bin', op, l, r, type: t, ot: t, pos };
  }
  foldBin(op, a, b, t, pos) {
    if (isFloat(t)) {
      switch (op) {
        case '+': return this.mkConst(a + b, t);
        case '-': return this.mkConst(a - b, t);
        case '*': return this.mkConst(a * b, t);
        case '/': return this.mkConst(a / b, t);
      }
    }
    const u = !t.signed;
    const ua = u ? (t.size === 4 ? a >>> 0 : a & 0xffff) : a, ub = u ? (t.size === 4 ? b >>> 0 : b & 0xffff) : b;
    switch (op) {
      case '+': return this.mkConst(a + b, t);
      case '-': return this.mkConst(a - b, t);
      case '*': return this.mkConst(t.size === 4 ? Math.imul(a, b) : a * b, t);
      case '/': if (!b) this.err('division by zero', pos); return this.mkConst(Math.trunc(ua / ub), t);
      case '%': if (!b) this.err('division by zero', pos); return this.mkConst(ua % ub, t);
      case '&': return this.mkConst(a & b, t);
      case '|': return this.mkConst(a | b, t);
      case '^': return this.mkConst(a ^ b, t);
      case '<<': return this.mkConst(b >= 32 ? 0 : (t.size === 4 ? a << b : a * 2 ** b), t);
      case '>>': return this.mkConst(u ? (b >= 32 ? 0 : ua >>> b) : (a >> Math.min(b, 31)), t);
    }
    this.err(`internal: fold ${op}`, pos);
  }

  mkBin(op, l0, r0, pos) {
    let l = this.rv(l0), r = this.rv(r0);
    if (op === '&&' || op === '||') {
      l = this.scalarCond(l); r = this.scalarCond(r);
      if (l.n === 'const') {
        if (op === '&&' && !l.v) return this.mkConst(0, CT.int);
        if (op === '||' && l.v) return this.mkConst(1, CT.int);
        if (r.n === 'const') return this.mkConst(r.v ? 1 : 0, CT.int);
      }
      return { n: 'logic', op, l, r, type: CT.int, pos };
    }
    const lt = l.type, rt = r.type;
    if (isVoid(lt) || isVoid(rt)) this.err(`a void value cannot be used with '${op}'`, pos);
    if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
      let ot;
      if (isArith(lt) && isArith(rt)) ot = this.arithType(lt, rt);
      else if (isPtr(lt) && isPtr(rt)) { ot = lt.far || rt.far ? this.ptr(CT.void, true) : lt; }
      else if (isPtr(lt) && isInt(rt)) { ot = lt; if (!(r.n === 'const' && r.v === 0)) this.warn('comparison between a pointer and an integer', pos); }
      else if (isInt(lt) && isPtr(rt)) { ot = rt; if (!(l.n === 'const' && l.v === 0)) this.warn('comparison between a pointer and an integer', pos); }
      else this.err(`'${op}' cannot compare ${ctypeName(lt)} and ${ctypeName(rt)}`, pos);
      const a = this.conv(l, ot), b = this.conv(r, ot);
      if (a.n === 'const' && b.n === 'const') {
        let x = a.v, y = b.v;
        if (isInt(ot) && !ot.signed || isPtr(ot)) { x = x >>> 0; y = y >>> 0; }
        const v = { '==': x === y, '!=': x !== y, '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y }[op];
        return this.mkConst(v ? 1 : 0, CT.int);
      }
      return { n: 'rel', op, l: a, r: b, ot, type: CT.int, pos };
    }
    if (op === '+' || op === '-') {
      if (isPtr(lt) && isInt(rt)) return this.ptrAdd(l, r, op, pos);
      if (op === '+' && isInt(lt) && isPtr(rt)) return this.ptrAdd(r, l, op, pos);
      if (op === '-' && isPtr(lt) && isPtr(rt)) {
        const es = isVoid(lt.to) ? 1 : lt.to.size;
        const far = lt.far || rt.far;
        const it = far || this.target.ptrSize === 4 ? CT.long : CT.int;
        const pa = far ? this.conv(l, this.ptr(CT.void, true)) : l;
        const pb = far ? this.conv(r, this.ptr(CT.void, true)) : r;
        let d;
        if (pa.n === 'const' && pb.n === 'const') d = this.mkConst(pa.v - pb.v, it);
        else d = { n: 'bin', op: '-', l: pa, r: pb, type: it, ot: it, pos };
        return es === 1 ? d : this.mkBinRaw('/', d, this.mkConst(es, it), it, pos);
      }
    }
    if (!isArith(lt) || !isArith(rt)) this.err(`'${op}' needs numbers, ${ctypeName(lt)} and ${ctypeName(rt)} found`, pos);
    if (op === '<<' || op === '>>') {
      if (!isInt(lt) || !isInt(rt)) this.err(`'${op}' needs integers`, pos);
      const t = this.promote(lt);
      const a = this.conv(l, t), b = this.conv(r, CT.int);
      if (a.n === 'const' && b.n === 'const') return this.foldBin(op, a.v, b.v, t, pos);
      return { n: 'bin', op, l: a, r: b, type: t, ot: t, pos };
    }
    const t = this.arithType(lt, rt);
    if ((op === '%' || op === '&' || op === '|' || op === '^') && isFloat(t)) this.err(`'${op}' needs integers`, pos);
    const a = this.conv(l, t), b = this.conv(r, t);
    if (a.n === 'const' && b.n === 'const') return { ...this.foldBin(op, a.v, b.v, t, pos), pos };
    return { n: 'bin', op, l: a, r: b, type: t, ot: t, pos };
  }

  mkCond(c, a0, b0, pos) {
    c = this.scalarCond(c);
    let a = this.rv(a0), b = this.rv(b0);
    let t;
    if (isArith(a.type) && isArith(b.type)) t = this.arithType(a.type, b.type);
    else if (isVoid(a.type) && isVoid(b.type)) t = CT.void;
    else if (isStruct(a.type) && this.sameStruct(a.type, b.type)) t = a.type;
    else if (isPtr(a.type) && isPtr(b.type)) t = isVoid(a.type.to) ? b.type : a.type;
    else if (isPtr(a.type) && isInt(b.type)) t = a.type;
    else if (isInt(a.type) && isPtr(b.type)) t = b.type;
    else this.err(`the two sides of ?: do not match (${ctypeName(a.type)} and ${ctypeName(b.type)})`, pos);
    if (!isVoid(t) && !isStruct(t)) { a = this.conv(a, t); b = this.conv(b, t); }
    if (c.n === 'const' && !isStruct(t)) return c.v ? a : b;
    return { n: 'cond', c, a, b, type: t, pos };
  }

  pure(e) {
    switch (e.n) {
      case 'const': case 'str': case 'fnaddr': return true;
      case 'var': return true;
      case 'member': return this.pure(e.e);
      case 'deref': case 'decay': case 'addr': case 'cvt': return this.pure(e.e);
      case 'bin': return this.pure(e.l) && this.pure(e.r);
    }
    return false;
  }

  mkAssign(op, l, r, pos) {
    if (l.n === 'fn' || l.n === 'pfn' || !l.lv || l.n === 'str') this.err('the left side of an assignment must be a variable', pos);
    if (isArray(l.type)) this.err('an array cannot be assigned; copy its elements', pos);
    if (isFunc(l.type)) this.err('a function cannot be assigned', pos);
    if (op === '=') {
      const v = this.assignConv(l.type, r, pos);
      return { n: 'assign', l, r: v, type: l.type, pos };
    }
    const bop = op.slice(0, -1);
    if (!isScalar(l.type)) this.err(`'${op}' needs a number or a pointer`, pos);
    let target = l, pre = null;
    if (!this.pure(l)) {
      // the address once, into a temporary
      const pt = this.ptr(l.type, this.isFarLv(l));
      const tmp = this.temp(pt);
      pre = { n: 'assign', l: this.tvar(tmp), r: { n: 'addr', e: l, type: pt }, type: pt, pos };
      target = { n: 'deref', e: this.tvar(tmp), type: l.type, lv: true, pos };
      if (l.n === 'member' && l.f.bits) {
        const ut = this.ptr(l.e.type, this.isFarLv(l.e));
        const t2 = this.temp(ut);
        pre = { n: 'assign', l: this.tvar(t2), r: { n: 'addr', e: l.e, type: ut }, type: ut, pos };
        target = { n: 'member', e: { n: 'deref', e: this.tvar(t2), type: l.e.type, lv: true }, f: l.f, type: l.type, lv: true, pos };
      }
    }
    let val = this.mkBin(bop, target, r, pos);
    val = this.assignConv(target.type, val, pos);
    const a = { n: 'assign', l: target, r: val, type: target.type, pos };
    return pre ? { n: 'comma', l: pre, r: a, type: a.type, pos, keepLv: true } : a;
  }
  mkPost(op, e, pos) {
    if (!e.lv || e.n === 'str') this.err(`'${op}' needs a variable`, pos);
    if (!isScalar(e.type)) this.err(`'${op}' needs a number or a pointer`, pos);
    const inc = this.mkAssign(op === '++' ? '+=' : '-=', e, this.mkConst(1, CT.int), pos);
    return { n: 'post', e, inc, type: e.type, pos };
  }

  mkCall(f0, args, pos) {
    if (f0.n === 'pfn') return this.mkPCall(f0, args, pos);
    const f = this.rv(f0);
    let ft;
    if (isPtr(f.type) && isFunc(f.type.to)) ft = f.type.to;
    else this.err(`called object is not a function (${ctypeName(f.type)})`, pos);
    const cargs = [];
    const np = ft.params.length;
    if (ft.proto) {
      if (args.length < np) this.err(`too few arguments to ${f.n === 'fnaddr' ? `'${f.sym.name}'` : 'the function'} (${np} needed, ${args.length} given)`, pos);
      if (args.length > np && !ft.variadic) this.err(`too many arguments to ${f.n === 'fnaddr' ? `'${f.sym.name}'` : 'the function'} (${np} needed, ${args.length} given)`, pos);
    }
    args.forEach((a, i) => {
      if (ft.proto && i < np) {
        cargs.push(this.assignConv(ft.params[i].type, a, a.pos || pos, `argument ${i + 1}`));
        return;
      }
      // default promotions
      const v = this.rv(a);
      if (isVoid(v.type)) this.err(`argument ${i + 1} has no value`, pos);
      if (isInt(v.type)) cargs.push(this.conv(v, this.promote(v.type)));
      else cargs.push(v);
    });
    return { n: 'call', f, ft, args: cargs, type: ft.ret, pos };
  }

  // a call of a Pascal routine from a unit
  mkPCall(f, args, pos) {
    const ps = f.psym;
    if (args.length !== ps.params.length) this.err(`'${f.name}' (Pascal) takes ${ps.params.length} argument${ps.params.length === 1 ? '' : 's'}, ${args.length} given`, pos);
    const cargs = ps.params.map((p, i) => {
      const a = args[i];
      const pt = p.type;
      if (pt.k === 'openarray') this.err(`'${f.name}': open array parameters cannot be passed from C`, pos);
      if (pt.k === 'string' && p.mode !== 'var') {
        const v = this.rv(a);
        if (!isPtr(v.type)) this.err(`argument ${i + 1} of '${f.name}' must be a string`, a.pos || pos);
        return { k: 'cstr', e: v };
      }
      const byRef = p.mode === 'var' || pt.k === 'untyped' || pt.k === 'string' || pt.k === 'array' || pt.k === 'record' || pt.k === 'set';
      if (byRef) {
        if (a.lv && isAggregate(a.type) && !isArray(a.type)) return { k: 'ref', e: { n: 'addr', e: a, type: this.ptr(a.type) } };
        const v = this.rv(a);
        if (!isPtr(v.type)) this.err(`argument ${i + 1} of '${f.name}' is a var parameter: pass an address (&x)`, a.pos || pos);
        if (v.type.far) this.err(`argument ${i + 1} of '${f.name}': a __far pointer cannot be passed`, a.pos || pos);
        return { k: 'ref', e: v };
      }
      const ct = this.pas2c(pt);
      if (pt.k === 'bool') return { k: 'val', e: this.conv(this.scalarCond(a), CT.bool), cls: p.cls };
      return { k: 'val', e: this.assignConv(ct, a, a.pos || pos, `argument ${i + 1} of '${f.name}'`), cls: p.cls };
    });
    let type = CT.void;
    if (ps.ret) type = ps.ret.k === 'string' ? this.ptr(CT.char) : this.pas2c(ps.ret);
    if (ps.ret && ps.ret.k === 'bool') type = CT.int;
    return { n: 'pcall', psym: ps, args: cargs, type, strRet: ps.ret && ps.ret.k === 'string', boolRet: ps.ret && ps.ret.k === 'bool', pos };
  }

  // ---------------------------------------------------------- code
  // where an lvalue is: a frame place, a global, an address on the stack,
  // a fixed address, or a 24/32-bit address on the stack (__far)
  lvalDesc(e) {
    switch (e.n) {
      case 'var': {
        const l = e.sym.loc;
        if (l.k === 'glob') { this.noteUse(e.sym, e.pos); return { k: 'glob', g: l.g, off: 0 }; }
        if (l.k === 'abs') return { k: 'abs', a: l.a, off: 0 };
        if (l.byRef) {
          this.emit({ o: 'ldl', hops: 0, off: l.off, kind: 'par', mt: this.mt(this.ptr(CT.void)) });
          return { k: 'ind', off: 0 };
        }
        return { k: 'loc', off: l.off, kind: l.k === 'par' ? 'par' : 'loc' };
      }
      case 'lit': {
        this.genLocalInit(e.sym, e.init, e.pos);
        return { k: 'loc', off: e.sym.loc.off, kind: 'loc' };
      }
      case 'str': return { k: 'glob', g: this.strLabel(e.bytes), off: 0 };
      case 'member': {
        const d = this.lvalDesc(e.e);
        if (d.k === 'abs') d.a += e.f.off; else d.off += e.f.off;
        return d;
      }
      case 'deref': {
        const p = e.e;
        const far = isPtr(p.type) && p.type.far;
        if (p.n === 'const') return { k: 'abs', a: p.v >>> 0, off: 0 };
        if ((p.n === 'addr' || p.n === 'decay') && p.e.lv) return this.lvalDesc(p.e);
        if (p.n === 'bin' && (p.op === '+' || p.op === '-') && isPtr(p.type) && p.r.n === 'const') {
          const k = p.op === '+' ? p.r.v : -p.r.v;
          const inner = { n: 'deref', e: p.l, type: e.type, lv: true };
          if (isPtr(p.l.type) && p.l.type.far === far) {
            const d = this.lvalDesc(inner);
            if (d.k === 'abs') d.a += k; else d.off += k;
            return d;
          }
        }
        this.genValue(p);
        return far ? { k: 'far', off: 0 } : { k: 'ind', off: 0 };
      }
      case 'call': case 'cond': case 'comma': case 'assign':
        if (isStruct(e.type)) { this.genAddr(e); return { k: 'ind', off: 0 }; }
    }
    this.err('a variable is needed here', e.pos);
  }
  loadDesc(d, mt) {
    switch (d.k) {
      case 'loc': this.emit({ o: 'ldl', hops: 0, off: d.off, kind: d.kind, mt }); break;
      case 'glob': this.emit({ o: 'ldg', g: d.g, off: d.off, mt }); break;
      case 'ind': this.emit({ o: 'ld', off: d.off, mt }); break;
      case 'abs': this.emit({ o: 'ldabs', a: (d.a + d.off) >>> 0, mt }); break;
      case 'far': this.emit({ o: 'ldfar', off: d.off, mt }); break;
    }
  }
  storeDesc(d, mt) {
    switch (d.k) {
      case 'loc': this.emit({ o: 'stl', hops: 0, off: d.off, kind: d.kind, mt }); break;
      case 'glob': this.emit({ o: 'stg', g: d.g, off: d.off, mt }); break;
      case 'ind': this.emit({ o: 'st', off: d.off, mt }); break;
      case 'abs': this.emit({ o: 'stabs', a: (d.a + d.off) >>> 0, mt }); break;
      case 'far': this.emit({ o: 'stfar', off: d.off, mt }); break;
    }
  }
  // push the address of an lvalue (L for a far place)
  genAddr(e) {
    if (isStruct(e.type) && !e.lv) {
      switch (e.n) {
        case 'call': case 'pcall': this.genValue(e, true); return;
        case 'cond': {
          const pt = this.ptr(e.type);
          const tmp = this.temp(pt);
          const lF = this.newLabel(), lE = this.newLabel();
          this.genCond(e.c, lF);
          this.genAddr(e.a); this.emit({ o: 'stl', hops: 0, off: tmp.loc.off, kind: 'loc', mt: this.mt(pt) });
          this.emit({ o: 'jmp', l: lE });
          this.emit({ o: 'label', l: lF });
          this.genAddr(e.b); this.emit({ o: 'stl', hops: 0, off: tmp.loc.off, kind: 'loc', mt: this.mt(pt) });
          this.emit({ o: 'label', l: lE });
          this.emit({ o: 'ldl', hops: 0, off: tmp.loc.off, kind: 'loc', mt: this.mt(pt) });
          return;
        }
        case 'comma': this.genVoid(e.l); this.genAddr(e.r); return;
        case 'assign': this.genAssign(e.l, e.r, false, e.pos); this.genAddr(e.l); return;
        case 'addrv': this.genAddr(e.e); return;
      }
    }
    const d = this.lvalDesc(e);
    switch (d.k) {
      case 'loc': this.emit({ o: 'laddr', hops: 0, off: d.off, kind: d.kind }); break;
      case 'glob': this.emit({ o: 'gaddr', g: d.g, off: d.off }); break;
      case 'ind':
        if (d.off) { this.emit({ o: 'lit', s: this.P, v: d.off }); this.emit({ o: 'add', s: this.P, u: true }); }
        break;
      case 'abs': {
        const a = (d.a + d.off) >>> 0;
        if (this.isFarLv(e) || a > 0xffff) this.emit({ o: 'lit', s: 'L', v: a });
        else this.emit({ o: 'lit', s: this.P, v: a });
        break;
      }
      case 'far':
        if (d.off) { this.emit({ o: 'lit', s: 'L', v: d.off }); this.emit({ o: 'add', s: 'L', u: true }); }
        break;
    }
  }

  // push the value of a scalar expression
  genValue(e, wantAddr = false) {
    const t = e.type;
    switch (e.n) {
      case 'const':
        if (isFloat(t)) { this.emit({ o: 'lit', s: 'L', v: realBits(e.v) }); return; }
        this.emit({ o: 'lit', s: this.cls(t), v: e.v });
        return;
      case 'str': this.emit({ o: 'gaddr', g: this.strLabel(e.bytes), off: 0 }); return;
      case 'fnaddr': this.noteFn(e.sym, e.pos); this.emit(this.fn4 ? { o: 'faddr', g: e.sym.label } : { o: 'gaddr', g: e.sym.label, off: 0 }); return;
      case 'decay': case 'addr': {
        this.genAddr(e.e);
        // an address in bank 0 that is wanted as a __far pointer
        if (isPtr(t) && t.far && this.target.ptrSize === 2 && !this.isFarLv(e.e) && !(e.e.n === 'deref' && e.e.e.n === 'const')) this.emit({ o: 'ext', u: true });
        return;
      }
      case 'addrv': this.genAddr(e.e); return;
      case 'var': case 'member': case 'deref': case 'lit': {
        if (isStruct(t)) { this.genAddr(e); return; }
        if (e.n === 'member' && e.f.bits) { this.genBitLoad(e); return; }
        const d = this.lvalDesc(e);
        this.loadDesc(d, this.mt(t));
        return;
      }
      case 'cvt': this.genCvt(e); return;
      case 'un': {
        if (isFloat(t)) { this.rtCall('_negreal', [() => this.genValue(e.e)]); return; }
        this.genValue(e.e);
        this.emit({ o: e.op === '-' ? 'neg' : 'not', s: this.cls(t), u: !t.signed });
        if (this.target.normalize && this.cls(t) === 'W') this.emit({ o: 'narrow', mt: this.mt(t) });
        return;
      }
      case 'not': this.genTruth(e.e, true); return;
      case 'rel': {
        const ot = e.ot;
        if (isFloat(ot)) {
          this.rtCall('_cmpreal', [() => this.genValue(e.l), () => this.genValue(e.r)]);
          this.emit({ o: 'lit', s: 'W', v: 0 });
          this.emit({ o: 'cmp', c: REL[e.op], s: 'W', u: false });
          return;
        }
        this.genValue(e.l);
        this.genValue(e.r);
        this.emit({ o: 'cmp', c: REL[e.op], s: this.cls(ot), u: this.uns(ot) });
        return;
      }
      case 'logic': {
        const tmp = this.temp(CT.int);
        const lF = this.newLabel();
        this.emit({ o: 'lit', s: 'W', v: 0 });
        this.emit({ o: 'stl', hops: 0, off: tmp.loc.off, kind: 'loc', mt: 's16' });
        this.genCond(e, lF);
        this.emit({ o: 'lit', s: 'W', v: 1 });
        this.emit({ o: 'stl', hops: 0, off: tmp.loc.off, kind: 'loc', mt: 's16' });
        this.emit({ o: 'label', l: lF });
        this.emit({ o: 'ldl', hops: 0, off: tmp.loc.off, kind: 'loc', mt: 's16' });
        return;
      }
      case 'bin': this.genBin(e); return;
      case 'cond': {
        if (isStruct(t)) { this.genAddr(e); return; }
        if (isVoid(t)) this.err('a void value cannot be used', e.pos);
        const tmp = this.temp(t);
        const mt = this.mt(t);
        const lF = this.newLabel(), lE = this.newLabel();
        this.genCond(e.c, lF);
        this.genValue(e.a); this.emit({ o: 'stl', hops: 0, off: tmp.loc.off, kind: 'loc', mt });
        this.emit({ o: 'jmp', l: lE });
        this.emit({ o: 'label', l: lF });
        this.genValue(e.b); this.emit({ o: 'stl', hops: 0, off: tmp.loc.off, kind: 'loc', mt });
        this.emit({ o: 'label', l: lE });
        this.emit({ o: 'ldl', hops: 0, off: tmp.loc.off, kind: 'loc', mt });
        return;
      }
      case 'comma': this.genVoid(e.l); this.genValue(e.r); return;
      case 'assign': this.genAssign(e.l, e.r, true, e.pos); return;
      case 'post': this.genPost(e, true); return;
      case 'call': this.genCall(e, true); return;
      case 'pcall': this.genPCall(e, true); return;
    }
    this.err(`internal: cannot generate ${e.n}`, e.pos);
  }

  // !e (neg) or e != 0 as 0/1
  genTruth(e, neg) {
    const t = e.type;
    if (isFloat(t)) {
      this.genValue(e);
      this.emit({ o: 'lit', s: 'L', v: 0x7fffffff });
      this.emit({ o: 'and', s: 'L', u: true });
      this.emit({ o: 'lit', s: 'L', v: 0 });
      this.emit({ o: 'cmp', c: neg ? 'eq' : 'ne', s: 'L', u: true });
      return;
    }
    if (e.n === 'rel' || e.n === 'logic' || e.n === 'not') {
      if (!neg) { this.genValue(e); return; }
    }
    this.genValue(e);
    const cls = this.cls(t);
    this.emit({ o: 'lit', s: cls, v: 0 });
    this.emit({ o: 'cmp', c: neg ? 'eq' : 'ne', s: cls, u: true });
  }

  genBin(e) {
    const t = e.ot;
    const op = e.op;
    if (isFloat(t)) {
      const fn = { '+': '_addreal', '-': '_subreal', '*': '_mulreal', '/': '_divreal' }[op];
      if (!fn) this.err(`'${op}' needs integers`, e.pos);
      this.rtCall(fn, [() => this.genValue(e.l), () => this.genValue(e.r)]);
      return;
    }
    const cls = this.cls(t);
    const u = this.uns(t);
    if (op === '>>' && !u) {
      // arithmetic shift: a negative value as ~(~a >> n)
      if (e.r.n === 'const' && e.r.v >= (cls === 'L' ? 31 : 15)) {
        this.genValue(e.l);
        this.emit({ o: 'lit', s: cls, v: 0 });
        this.emit({ o: 'cmp', c: 'lt', s: cls, u: false });
        if (cls === 'L') this.emit({ o: 'ext', u: true });
        this.emit({ o: 'neg', s: cls, u: false });
        return;
      }
      const ta = this.temp(t), tr = this.temp(t);
      const mt = this.mt(t);
      this.genValue(e.l);
      this.emit({ o: 'stl', hops: 0, off: ta.loc.off, kind: 'loc', mt });
      let n = null;
      if (e.r.n !== 'const') { n = this.temp(CT.int); this.genValue(e.r); this.emit({ o: 'stl', hops: 0, off: n.loc.off, kind: 'loc', mt: 's16' }); }
      const count = () => { if (n) this.emit({ o: 'ldl', hops: 0, off: n.loc.off, kind: 'loc', mt: 's16' }); else this.emit({ o: 'lit', s: 'W', v: e.r.v & 31 }); };
      const lNeg = this.newLabel(), lEnd = this.newLabel();
      this.emit({ o: 'ldl', hops: 0, off: ta.loc.off, kind: 'loc', mt });
      this.emit({ o: 'lit', s: cls, v: 0 });
      this.emit({ o: 'jc', c: 'lt', s: cls, u: false, l: lNeg });
      this.emit({ o: 'ldl', hops: 0, off: ta.loc.off, kind: 'loc', mt });
      count();
      this.emit({ o: 'shr', s: cls, u: true });
      this.emit({ o: 'stl', hops: 0, off: tr.loc.off, kind: 'loc', mt });
      this.emit({ o: 'jmp', l: lEnd });
      this.emit({ o: 'label', l: lNeg });
      this.emit({ o: 'ldl', hops: 0, off: ta.loc.off, kind: 'loc', mt });
      this.emit({ o: 'not', s: cls, u: false });
      count();
      this.emit({ o: 'shr', s: cls, u: true });
      this.emit({ o: 'not', s: cls, u: false });
      if (this.target.normalize && cls === 'W') this.emit({ o: 'narrow', mt });
      this.emit({ o: 'stl', hops: 0, off: tr.loc.off, kind: 'loc', mt });
      this.emit({ o: 'label', l: lEnd });
      this.emit({ o: 'ldl', hops: 0, off: tr.loc.off, kind: 'loc', mt });
      return;
    }
    this.genValue(e.l);
    if (op === '<<' || op === '>>') {
      if (e.r.n === 'const') this.emit({ o: 'lit', s: 'W', v: e.r.v & 31 });
      else this.genValue(e.r);
      this.emit({ o: op === '<<' ? 'shl' : 'shr', s: cls, u: true });
      if (this.target.normalize && cls === 'W' && op === '<<') this.emit({ o: 'narrow', mt: this.mt(t) });
      return;
    }
    this.genValue(e.r);
    const o = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', '&': 'and', '|': 'or', '^': 'xor' }[op];
    this.emit({ o, s: cls, u });
    if (this.target.normalize && cls === 'W' && o === 'mul') this.emit({ o: 'narrow', mt: this.mt(t) });
  }

  genCvt(e) {
    const from = e.e.type, to = e.type;
    if (isVoid(to)) { this.genVoid(e.e); return; }
    if (to.bool) { this.genTruth(e.e, false); return; }
    if (isFloat(to)) {
      if (isFloat(from)) { this.genValue(e.e); return; }
      const unsignedLong = isInt(from) && from.size === 4 && !from.signed;
      this.rtCall(unsignedLong ? '_cardtoreal' : '_inttoreal', [() => {
        this.genValue(e.e);
        if (this.cls(from) === 'W') this.emit({ o: 'ext', u: !from.signed });
      }]);
      return;
    }
    if (isFloat(from)) {
      this.rtCall('_truncreal', [() => this.genValue(e.e)]);
      if (this.cls(to) === 'W') this.emit({ o: 'trunc', mt: this.mt(to) });
      return;
    }
    this.genValue(e.e);
    const fc = this.cls(from), tc = this.cls(to);
    const fmt = this.mt(from), tmt = this.mt(to);
    const fs = isInt(from) ? from.signed : false;
    if (fc === 'W' && tc === 'L') this.emit({ o: 'ext', u: !fs });
    else if (fc === 'L' && tc === 'W') this.emit({ o: 'trunc', mt: tmt });
    else if (fc === 'W' && tc === 'W') {
      if (tmt === 'u8' || tmt === 's8') { if (fmt !== tmt && !(tmt === 's8' && false)) this.emit({ o: 'narrow', mt: tmt }); }
      else if (this.target.normalize) {
        if (tmt === 'u16' && (fmt === 's16' || fmt === 's8')) this.emit({ o: 'narrow', mt: 'u16' });
        else if (tmt === 's16' && fmt === 'u16') this.emit({ o: 'narrow', mt: 's16' });
      }
    }
  }

  // a call of a routine of the System unit (Pascal order: left to right)
  rtCall(name, gens) {
    const s = this.pf.units.get('system').iface.syms.get(name);
    if (!s) this.err(`internal: ${name} missing in System`);
    s.params.forEach((p, i) => { gens[i](); this.emit({ o: 'arg', s: p.cls }); });
    this.emit({ o: 'call', l: s.label, args: s.parBytes, ret: s.ret ? this.pf.clsOf(s.ret) : null, ext: s.external });
  }

  genCall(e, want) {
    const ft = e.ft;
    let pushed = 0;
    const sret = isStruct(ft.ret);
    let tmp = null;
    if (sret) tmp = this.temp(ft.ret);
    for (let i = e.args.length - 1; i >= 0; i--) {
      const a = e.args[i];
      if (isStruct(a.type)) {
        const c = this.temp(a.type);
        this.emit({ o: 'laddr', hops: 0, off: c.loc.off, kind: 'loc' });
        this.genAddr(a);
        this.emit({ o: 'copy', n: a.type.size });
        this.emit({ o: 'laddr', hops: 0, off: c.loc.off, kind: 'loc' });
        this.emit({ o: 'arg', s: this.P });
        pushed += this.target.argSlot || this.target.ptrSize;
        continue;
      }
      this.genValue(a);
      this.emit({ o: 'arg', s: this.cls(a.type) });
      pushed += this.slot(a.type);
    }
    if (sret) {
      this.emit({ o: 'laddr', hops: 0, off: tmp.loc.off, kind: 'loc' });
      this.emit({ o: 'arg', s: this.P });
      pushed += this.target.argSlot || this.target.ptrSize;
    }
    const ret = isVoid(ft.ret) ? null : sret ? this.P : this.cls(ft.ret);
    if (e.f.n === 'fnaddr') {
      this.noteFn(e.f.sym, e.pos);
      this.emit({ o: 'call', l: e.f.sym.label, args: pushed, ret });
    } else {
      if (e.f.type.far) this.err('a __far function pointer cannot be called', e.pos);
      this.genValue(e.f);
      this.emit({ o: 'calli', args: pushed, ret });
    }
    if (!want && ret) this.emit({ o: 'drop' });
  }

  genPCall(e, want) {
    const ps = e.psym;
    let buf = null;
    if (e.strRet) {
      buf = { kind: 'var', type: this.arr(CT.uchar, 256), loc: { k: 'loc', off: this.allocPersist(256) } };
      this.emit({ o: 'laddr', hops: 0, off: buf.loc.off, kind: 'loc' });
      this.emit({ o: 'arg', s: this.P });
    }
    ps.params.forEach((p, i) => {
      const a = e.args[i];
      if (a.k === 'cstr') {
        // a C string as a Pascal string: copied into a buffer
        const sb = this.allocLocal(256);
        this.cHelper('__c2pstr', [() => this.emit({ o: 'laddr', hops: 0, off: sb, kind: 'loc' }), () => this.genValue(a.e)], this.P);
        this.emit({ o: 'arg', s: this.P });
        return;
      }
      if (a.k === 'ref') { this.genValue(a.e); this.emit({ o: 'arg', s: this.P }); return; }
      this.genValue(a.e);
      this.emit({ o: 'arg', s: p.cls });
    });
    let ret = null;
    if (ps.ret && ps.ret.k !== 'string') ret = this.pf.clsOf(ps.ret);
    this.emit({ o: 'call', l: ps.label, args: ps.parBytes, ret, ext: ps.external });
    if (e.strRet) {
      if (!want) return;
      this.cHelper('__p2cstr', [() => this.emit({ o: 'laddr', hops: 0, off: buf.loc.off, kind: 'loc' })], this.P);
      return;
    }
    if (ret && e.boolRet) { this.emit({ o: 'narrow', mt: 'u8' }); }
    if (ret && !want) this.emit({ o: 'drop' });
  }
  // a routine of the C runtime (crt0.c): arguments last to first
  cHelper(name, gens, ret) {
    const f = this.ext.get(name);
    if (!f) this.err(`internal: the C runtime routine ${name} is missing`);
    let n = 0;
    for (let i = gens.length - 1; i >= 0; i--) { gens[i](); this.emit({ o: 'arg', s: this.P }); n += this.target.argSlot || this.target.ptrSize; }
    this.noteFn(f, null);
    this.emit({ o: 'call', l: f.label, args: n, ret });
  }

  genBitLoad(e) {
    const f = e.f;
    const ut = f.unit === 1 ? CT.uchar : f.unit === 2 ? CT.uint : CT.ulong;
    const d = this.lvalDesc(e.e);
    d.off += f.off;
    this.loadDesc(d, this.mt(ut));
    const cls = this.cls(ut);
    if (f.bitoff) { this.emit({ o: 'lit', s: 'W', v: f.bitoff }); this.emit({ o: 'shr', s: cls, u: true }); }
    const mask = f.bits >= 32 ? 0xffffffff : 2 ** f.bits - 1;
    this.emit({ o: 'lit', s: cls, v: mask });
    this.emit({ o: 'and', s: cls, u: true });
    const rc = this.cls(e.type);
    if (cls === 'L' && rc === 'W') this.emit({ o: 'trunc', mt: this.mt(e.type) });
    else if (cls === 'W' && rc === 'L') this.emit({ o: 'ext', u: true });
    if (e.type.signed && f.bits < e.type.size * 8) {
      // sign: (v ^ m) - m
      const m = 2 ** (f.bits - 1);
      this.emit({ o: 'lit', s: rc, v: m });
      this.emit({ o: 'xor', s: rc, u: true });
      this.emit({ o: 'lit', s: rc, v: m });
      this.emit({ o: 'sub', s: rc, u: false });
    }
  }
  genBitStore(lv, val, want) {
    // the unit read, the bits replaced, the unit written
    const f = lv.f;
    const ut = f.unit === 1 ? CT.uchar : f.unit === 2 ? CT.uint : CT.ulong;
    const cls = this.cls(ut), mt = this.mt(ut);
    const mask = f.bits >= 32 ? 0xffffffff : 2 ** f.bits - 1;
    const vt = this.temp(ut);
    this.genValue(this.conv(val, ut));
    this.emit({ o: 'lit', s: cls, v: mask });
    this.emit({ o: 'and', s: cls, u: true });
    this.emit({ o: 'stl', hops: 0, off: vt.loc.off, kind: 'loc', mt });
    const pt = this.ptr(lv.e.type, this.isFarLv(lv.e));
    let base;
    if (this.pure(lv.e)) base = lv.e;
    else {
      const t2 = this.temp(pt);
      this.genAddr(lv.e);
      this.emit({ o: 'stl', hops: 0, off: t2.loc.off, kind: 'loc', mt: this.mt(pt) });
      base = { n: 'deref', e: this.tvar(t2), type: lv.e.type, lv: true };
    }
    const d1 = this.lvalDesc(base); d1.off += f.off;
    // address for the store first (when it is on the stack)
    const d2 = this.lvalDesc(base); d2.off += f.off;
    this.loadDesc(d1, mt);
    const keep = (~(mask * 2 ** f.bitoff)) & (cls === 'L' ? 0xffffffff : 0xffff);
    this.emit({ o: 'lit', s: cls, v: cls === 'L' ? keep >>> 0 : keep });
    this.emit({ o: 'and', s: cls, u: true });
    this.emit({ o: 'ldl', hops: 0, off: vt.loc.off, kind: 'loc', mt });
    if (f.bitoff) { this.emit({ o: 'lit', s: 'W', v: f.bitoff }); this.emit({ o: 'shl', s: cls, u: true }); }
    this.emit({ o: 'or', s: cls, u: true });
    if (d2.k === 'ind' || d2.k === 'far') {
      // d1 and d2 both pushed an address: the load used the top one
    }
    this.storeDesc(d2, mt);
    if (want) {
      this.emit({ o: 'ldl', hops: 0, off: vt.loc.off, kind: 'loc', mt });
      const rc = this.cls(lv.type);
      if (cls === 'L' && rc === 'W') this.emit({ o: 'trunc', mt: this.mt(lv.type) });
      else if (cls === 'W' && rc === 'L') this.emit({ o: 'ext', u: true });
    }
  }

  genAssign(l, r, want, pos) {
    if (isStruct(l.type)) {
      const rr = this.rv(r);
      if (!this.sameStruct(rr.type, l.type)) this.err(`${ctypeName(rr.type)} assigned to ${ctypeName(l.type)}`, pos);
      this.genAddr(l);
      this.genAddr(rr);
      this.emit({ o: 'copy', n: l.type.size });
      if (want) this.genAddr(l);
      return;
    }
    if (l.n === 'member' && l.f.bits) {
      // the load inside genBitStore needs the address pushed twice: keep it simple
      const vtmp = this.temp(l.type);
      this.genValue(this.conv(r, l.type));
      this.emit({ o: 'stl', hops: 0, off: vtmp.loc.off, kind: 'loc', mt: this.mt(l.type) });
      this.genBitStore(l, this.tvar(vtmp), want);
      return;
    }
    const mt = this.mt(l.type);
    const simple = l.n === 'var' && !l.sym.loc.byRef;
    if (want && !simple) {
      const tmp = this.temp(l.type);
      this.genValue(r);
      this.emit({ o: 'stl', hops: 0, off: tmp.loc.off, kind: 'loc', mt });
      const d = this.lvalDesc(l);
      this.emit({ o: 'ldl', hops: 0, off: tmp.loc.off, kind: 'loc', mt });
      this.storeDesc(d, mt);
      this.emit({ o: 'ldl', hops: 0, off: tmp.loc.off, kind: 'loc', mt });
      return;
    }
    const d = this.lvalDesc(l);
    this.genValue(r);
    this.storeDesc(d, mt);
    if (want) this.loadDesc(this.lvalDesc(l), mt);
  }

  genPost(e, want) {
    if (!want) { this.genVoid(e.inc); return; }
    const t = e.type;
    const mt = this.mt(t);
    const a = e.e;
    const tmp = this.temp(t);
    if (this.pure(a)) {
      this.genValue(a);
      this.emit({ o: 'stl', hops: 0, off: tmp.loc.off, kind: 'loc', mt });
      this.genVoid(e.inc);
      this.emit({ o: 'ldl', hops: 0, off: tmp.loc.off, kind: 'loc', mt });
      return;
    }
    // inc is (addr into a temp, assign through it): the old value in between
    const inc = e.inc;   // comma(pre, assign)
    this.genVoid(inc.l);
    this.genValue(inc.r.l);
    this.emit({ o: 'stl', hops: 0, off: tmp.loc.off, kind: 'loc', mt });
    this.genVoid(inc.r);
    this.emit({ o: 'ldl', hops: 0, off: tmp.loc.off, kind: 'loc', mt });
  }

  // an expression for its effect only
  genVoid(e) {
    switch (e.n) {
      case 'assign': this.genAssign(e.l, e.r, false, e.pos); return;
      case 'post': this.genVoid(e.inc); return;
      case 'call': this.genCall(e, false); return;
      case 'pcall': this.genPCall(e, false); return;
      case 'comma': this.genVoid(e.l); this.genVoid(e.r); return;
      case 'cvt': if (isVoid(e.type)) { this.genVoid(e.e); return; } break;
      case 'const': case 'str': case 'fnaddr': case 'var': return;
      case 'cond': {
        const lF = this.newLabel(), lE = this.newLabel();
        this.genCond(e.c, lF);
        this.genVoid(e.a);
        this.emit({ o: 'jmp', l: lE });
        this.emit({ o: 'label', l: lF });
        this.genVoid(e.b);
        this.emit({ o: 'label', l: lE });
        return;
      }
      case 'logic': {
        const lE = this.newLabel();
        if (e.op === '&&') this.genCond(e.l, lE); else this.genCondTrue(e.l, lE);
        this.genVoid(e.r);
        this.emit({ o: 'label', l: lE });
        return;
      }
    }
    if (isVoid(e.type)) { this.err('a void value cannot be used', e.pos); }
    if (isStruct(e.type)) { this.genAddr(e); this.emit({ o: 'drop' }); return; }
    if (e.n === 'member' && e.f.bits) { this.genValue(e); this.emit({ o: 'drop' }); return; }
    this.genValue(e);
    this.emit({ o: 'drop' });
  }

  // jump to lF if e is false (zero)
  genCond(e, lF) {
    if (e.n === 'const') { if (!e.v) this.emit({ o: 'jmp', l: lF }); return; }
    if (e.n === 'logic' && e.op === '&&') { this.genCond(e.l, lF); this.genCond(e.r, lF); return; }
    if (e.n === 'logic' && e.op === '||') {
      const lT = this.newLabel();
      this.genCondTrue(e.l, lT);
      this.genCond(e.r, lF);
      this.emit({ o: 'label', l: lT });
      return;
    }
    if (e.n === 'not') { this.genCondTrue(e.e, lF); return; }
    if (e.n === 'comma') { this.genVoid(e.l); this.genCond(e.r, lF); return; }
    if (e.n === 'rel') { this.genRelJump(e, INV[e.op], lF); return; }
    this.genZeroJump(e, true, lF);
  }
  genCondTrue(e, lT) {
    if (e.n === 'const') { if (e.v) this.emit({ o: 'jmp', l: lT }); return; }
    if (e.n === 'logic' && e.op === '||') { this.genCondTrue(e.l, lT); this.genCondTrue(e.r, lT); return; }
    if (e.n === 'logic' && e.op === '&&') {
      const lF = this.newLabel();
      this.genCond(e.l, lF);
      this.genCondTrue(e.r, lT);
      this.emit({ o: 'label', l: lF });
      return;
    }
    if (e.n === 'not') { this.genCond(e.e, lT); return; }
    if (e.n === 'comma') { this.genVoid(e.l); this.genCondTrue(e.r, lT); return; }
    if (e.n === 'rel') { this.genRelJump(e, REL[e.op], lT); return; }
    this.genZeroJump(e, false, lT);
  }
  genRelJump(e, c, l) {
    const ot = e.ot;
    if (isFloat(ot)) {
      this.rtCall('_cmpreal', [() => this.genValue(e.l), () => this.genValue(e.r)]);
      this.emit({ o: 'lit', s: 'W', v: 0 });
      this.emit({ o: 'jc', c, s: 'W', u: false, l });
      return;
    }
    this.genValue(e.l);
    this.genValue(e.r);
    this.emit({ o: 'jc', c, s: this.cls(ot), u: this.uns(ot), l });
  }
  // jump to l if e is zero (ifZero) or not zero
  genZeroJump(e, ifZero, l) {
    const t = e.type;
    if (isFloat(t)) {
      this.genValue(e);
      this.emit({ o: 'lit', s: 'L', v: 0x7fffffff });
      this.emit({ o: 'and', s: 'L', u: true });
      this.emit({ o: 'lit', s: 'L', v: 0 });
      this.emit({ o: 'jc', c: ifZero ? 'eq' : 'ne', s: 'L', u: true, l });
      return;
    }
    const cls = this.cls(t);
    this.genValue(e);
    if (cls === 'W') { this.emit({ o: ifZero ? 'jz' : 'jnz', l }); return; }
    this.emit({ o: 'lit', s: 'L', v: 0 });
    this.emit({ o: 'jc', c: ifZero ? 'eq' : 'ne', s: 'L', u: true, l });
  }
}

const REL = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
const INV = { '==': 'ne', '!=': 'eq', '<': 'ge', '<=': 'gt', '>': 'le', '>=': 'lt' };
