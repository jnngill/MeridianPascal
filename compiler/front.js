// MERIDIAN Pascal - front end
// Recursive-descent parser in the style of Turbo Pascal: declarations go
// straight into the symbol table, expressions become typed trees, and
// statements are translated at once into a small stack-machine IR that
// both back ends (65C816 and SCHUB RV32IM) understand.

import { tokenize, CompileError } from './lexer.js';
import {
  T, isOrdinal, isInt, isReal, isNumeric, isPtr, isScalar, isStruct,
  subrange, typeName, intTypeFor, fitsType, wrapTo, realBits, sameType,
} from './types.js';

class Scope {
  constructor(parent, level) {
    this.syms = new Map();
    this.parent = parent;
    this.level = level;
    this.uses = [];      // unit interface scopes searched after the chain
  }
}

class ProcCtx {
  constructor(level, label, name) {
    this.level = level;
    this.label = label;
    this.name = name;
    this.code = [];
    this.locTop = 0;
    this.locMax = 0;
    this.parBytes = 0;
    this.hasSL = false;
    this.exitLabel = null;
    this.loops = [];
    this.retType = null;
    this.retCls = null;
    this.resultLoc = null;
  }
}

const BUILTIN_PROCS = ['write', 'writeln', 'read', 'readln', 'inc', 'dec', 'new',
  'dispose', 'halt', 'exit', 'break', 'continue', 'str', 'val', 'include',
  'exclude', 'getmem', 'freemem', 'reset', 'rewrite', 'blockread', 'blockwrite'];
const BUILTIN_FUNCS = ['ord', 'chr', 'succ', 'pred', 'low', 'high', 'sizeof',
  'length', 'abs', 'sqr', 'odd', 'hi', 'lo', 'swap', 'trunc', 'round',
  'assigned', 'concat', 'addr', 'ptr', 'sqrt', 'int', 'frac'];

export class Front {
  constructor(target, opts = {}) {
    this.target = target;           // see compile.js: TARGETS
    this.loadSource = opts.loadSource;   // (unitName) -> {text, name} | null
    this.loadInclude = opts.loadInclude; // (fileName, fromFile) -> {text, name} | null
    this.objTypes = [];                   // object types with virtual methods (their VMTs)
    this.baseDefines = new Set(opts.defines || []);
    this.units = new Map();
    this.unitInits = [];
    this.procs = [];
    this.data = [];
    this.bss = [];
    this.lbl = 0;
    this.strLits = new Map();
    this.compiling = new Set();
    this.ptrT = { k: 'ptr', to: null, size: target.ptrSize, name: 'pointer' };
    this.root = this.makeRootScope();
    this.ctx = null;
    this.withStack = [];
    this.usedLines = [];
  }

  // ------------------------------------------------------------------ util
  err(msg, pos) { throw new CompileError(msg, pos || (this.tk && this.tk.pos)); }
  newLabel(pfx = 'L') { return `${pfx}${++this.lbl}`; }
  get tk() { return this.toks[this.p]; }
  peekTok(k = 1) { return this.toks[this.p + k]; }
  next() { const t = this.toks[this.p]; if (t.k !== 'eof') this.p++; return t; }
  is(v) { const t = this.tk; return (t.k === 'op' || t.k === 'kw') && t.v === v; }
  isId(v) { return this.tk.k === 'id' && (v === undefined || this.tk.v === v); }
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
    if (t.k === 'str') return `string '${t.v}'`;
    return `'${t.raw || t.v}'`;
  }
  emit(ins) { this.ctx.code.push(ins); return ins; }

  // per-target layout -------------------------------------------------------
  alignOf(t) {
    if (!this.target.align) return 1;
    switch (t.k) {
      case 'int': case 'enum': return t.size;
      case 'real': return 4;
      case 'ptr': case 'nil': case 'proc': return this.target.ptrSize;
      case 'record': return t.align || 1;
      case 'array': return this.alignOf(t.elem);
      default: return 1;
    }
  }
  mtOf(t) {
    switch (t.k) {
      case 'int':
        if (t.size === 1) return t.signed ? 's8' : 'u8';
        if (t.size === 2) return t.signed ? 's16' : 'u16';
        return '32';
      case 'char': case 'bool': return 'u8';
      case 'enum': return t.size === 1 ? 'u8' : 'u16';
      case 'real': return '32';
      case 'ptr': case 'nil': case 'proc': return this.target.ptrSize === 2 ? 'u16' : '32';
      default: this.err(`no scalar access for ${typeName(t)}`);
    }
  }
  clsOf(t) { return this.mtOf(t) === '32' ? 'L' : 'W'; }
  get P() { return this.target.ptrSize === 2 ? 'W' : 'L'; }
  argBytes(cls) { return this.target.argSlot ? this.target.argSlot : (cls === 'L' ? 4 : 2); }
  signedOf(t) { return t.k === 'int' ? t.signed : false; }

  // ---------------------------------------------------------------- scopes
  makeRootScope() {
    const s = new Scope(null, 0);
    const add = (n, sym) => s.syms.set(n, sym);
    for (const n of ['integer', 'word', 'byte', 'shortint', 'longint', 'longword',
      'char', 'boolean', 'real', 'string']) add(n, { kind: 'type', type: T[n] });
    add('cardinal', { kind: 'type', type: T.longword });
    add('smallint', { kind: 'type', type: T.integer });
    add('dword', { kind: 'type', type: T.longword });
    add('single', { kind: 'type', type: T.real });
    add('shortstring', { kind: 'type', type: T.string });
    add('pointer', { kind: 'type', type: this.ptrT });
    add('ptruint', { kind: 'type', type: this.target.ptrSize === 2 ? T.word : T.longword });
    add('ptrint', { kind: 'type', type: this.target.ptrSize === 2 ? T.integer : T.longint });
    add('true', { kind: 'const', type: T.boolean, v: 1 });
    add('false', { kind: 'const', type: T.boolean, v: 0 });
    add('maxint', { kind: 'const', type: T.integer, v: 32767 });
    add('maxlongint', { kind: 'const', type: T.longint, v: 2147483647 });
    add('pi', { kind: 'const', type: T.real, v: Math.PI });
    for (const n of BUILTIN_PROCS) add(n, { kind: 'bproc', name: n });
    for (const n of BUILTIN_FUNCS) add(n, { kind: 'bfunc', name: n });
    add('mem', { kind: 'memarr', mt: 'u8', type: T.byte });
    add('memw', { kind: 'memarr', mt: 'u16', type: T.word });
    add('meml', { kind: 'memarr', mt: '32', type: T.longint });
    return s;
  }

  lookup(name) {
    // with-statement record fields first
    for (let i = this.withStack.length - 1; i >= 0; i--) {
      const w = this.withStack[i];
      const f = w.recType.fields.find(f => f.name === name);
      if (f) return { kind: 'withfield', w, f };
      const m = w.recType.methods && w.recType.methods.get(name);
      if (m) return { kind: 'method', w, m };
    }
    for (let s = this.scope; s; s = s.parent) {
      const sym = s.syms.get(name);
      if (sym) return sym;
      for (let u = s.uses.length - 1; u >= 0; u--) {
        const us = s.uses[u].syms.get(name);
        if (us) return us;
      }
    }
    return null;
  }
  declare(name, sym, pos) {
    if (this.scope.syms.has(name)) {
      const old = this.scope.syms.get(name);
      if (!(old.kind === 'proc' && old.forward && sym.kind === 'proc')) {
        this.err(`duplicate identifier '${name}'`, pos);
      }
    }
    this.scope.syms.set(name, sym);
    return sym;
  }

  // ---------------------------------------------------------------- driver
  compileProgram(text, fileName) {
    this.compileUnit('system');
    const st = this.saveState();
    this.toks = tokenize(text, fileName, new Set(this.baseDefines), this.loadInclude);
    this.p = 0;
    this.moduleName = 'main';
    this.scope = new Scope(this.root, 0);
    this.scope.uses.push(this.units.get('system').iface);
    if (this.accept('program')) {
      this.moduleName = this.expectId().v;
      if (this.accept('(')) { while (!this.accept(')')) this.next(); }
      this.expect(';');
    }
    if (this.is('unit')) this.err('this file is a unit; open the program that uses it, or build a program');
    this.parseUses();
    const ctx = new ProcCtx(1, 'PMAIN', 'main');
    ctx.vmtInit = true;
    this.parseDecls(false);
    this.beginProc(ctx);
    this.expect('begin');
    this.parseStmtSeq('end');
    this.expect('end');
    this.expect('.');
    this.endProc();
    this.restoreState(st);
    return {
      target: this.target.name,
      procs: this.procs,
      data: this.data,
      bss: this.bss,
      inits: this.unitInits,
      main: 'PMAIN',
      units: [...this.units.keys()],
    };
  }

  saveState() {
    return { toks: this.toks, p: this.p, scope: this.scope, ctx: this.ctx,
      moduleName: this.moduleName, withStack: this.withStack };
  }
  restoreState(s) {
    this.toks = s.toks; this.p = s.p; this.scope = s.scope; this.ctx = s.ctx;
    this.moduleName = s.moduleName; this.withStack = s.withStack;
  }

  parseUses() {
    if (!this.accept('uses')) return;
    do {
      const t = this.expectId();
      if (t.v === 'system') continue;
      const u = this.compileUnit(t.v, t.pos);
      this.scope.uses.push(u.iface);
      this.scope.syms.set(t.v, { kind: 'unit', name: t.v, iface: u.iface });
    } while (this.accept(','));
    this.expect(';');
  }

  compileUnit(name, pos) {
    if (this.units.has(name)) return this.units.get(name);
    if (this.compiling.has(name)) this.err(`circular unit reference to '${name}'`, pos);
    const src = this.loadSource(name);
    if (!src) this.err(`unit '${name}' not found`, pos);
    if (/^\s*(\{[^}]*\}\s*|\(\*[\s\S]*?\*\)\s*|\/\/[^\n]*\n\s*)*program\b/i.test(src.text)) {
      this.err(`'${name}' is a program, not a unit - rename the program file, it hides the unit '${name}'`, pos);
    }
    this.compiling.add(name);
    const st = this.saveState();
    this.toks = tokenize(src.text, src.name, new Set(this.baseDefines), this.loadInclude);
    this.p = 0;
    this.moduleName = name;
    this.withStack = [];
    this.ctx = null;
    const iface = new Scope(this.root, 0);
    this.scope = iface;
    if (name !== 'system') iface.uses.push(this.units.get('system').iface);
    this.expect('unit');
    const nm = this.expectId();
    if (nm.v !== name) this.err(`unit name '${nm.raw}' does not match file name '${name}'`, nm.pos);
    this.expect(';');
    this.expect('interface');
    this.parseUses();
    this.parseDecls(true);
    this.expect('implementation');
    const impl = new Scope(iface, 0);
    this.scope = impl;
    this.parseUses();
    this.parseDecls(false);
    // check all interface procedures have bodies
    for (const [n, s] of iface.syms) {
      if (s.kind === 'proc' && s.forward && !s.external) this.err(`procedure '${n}' declared in interface but not implemented`);
    }
    const info = { name, iface, init: null };
    if (this.is('initialization') || this.is('begin')) {
      this.next();
      const ctx = new ProcCtx(1, `U_${name}_init`, name + '.init');
      this.beginProc(ctx);
      this.parseStmtSeq('end');
      this.endProc();
      info.init = ctx.label;
    }
    this.expect('end');
    this.expect('.');
    this.restoreState(st);
    this.compiling.delete(name);
    this.units.set(name, info);
    if (info.init) this.unitInits.push(info.init);
    return info;
  }

  // ----------------------------------------------------------- declarations
  parseDecls(isInterface) {
    for (;;) {
      if (this.accept('const')) this.parseConstSection();
      else if (this.accept('type')) this.parseTypeSection();
      else if (this.accept('var')) this.parseVarSection();
      else if (this.is('procedure') || this.is('function') || this.isId('constructor') || this.isId('destructor')) this.parseProcDecl(isInterface);
      else if (this.accept('label')) this.parseLabelSection();
      else break;
    }
  }

  // label 10, done;  (names or numbers; goto stays within the routine)
  parseLabelSection() {
    do {
      const t = this.next();
      if (t.k !== 'id' && t.k !== 'int') this.err('label name expected', t.pos);
      const name = String(t.v);
      this.declare(name, { kind: 'label', name, lbl: this.newLabel('G'), defined: false, used: null, scope: this.scope }, t.pos);
    } while (this.accept(','));
    this.expect(';');
  }

  parseConstSection() {
    while (this.tk.k === 'id' && !this.isId('constructor') && !this.isId('destructor')) {
      const id = this.next();
      if (this.accept(':')) {
        const type = this.parseType();
        this.expect('=');
        const sym = this.declareGlobalOrLocalData(id, type, this.parseTypedConst(type));
        sym.typedConst = true;
      } else {
        this.expect('=');
        const e = this.parseExpr();
        if (e.n !== 'const') this.err('constant expression expected', id.pos);
        this.declare(id.v, { kind: 'const', type: e.type, v: e.v }, id.pos);
      }
      this.expect(';');
    }
  }

  parseTypeSection() {
    const pendingPtrs = [];
    this.pendingPtrs = pendingPtrs;
    while (this.tk.k === 'id' && !this.isId('constructor') && !this.isId('destructor')) {
      const id = this.next();
      this.expect('=');
      const t = this.parseType(id.raw);
      // give named types their name (copy for aliases of built-ins)
      let nt = t;
      if (!t.name || t.name === '?') nt.name = id.raw;
      this.declare(id.v, { kind: 'type', type: nt }, id.pos);
      this.expect(';');
    }
    for (const pp of pendingPtrs) {
      const s = this.lookup(pp.name);
      if (!s || s.kind !== 'type') this.err(`unknown type '${pp.name}'`, pp.pos);
      pp.type.to = s.type;
    }
    this.pendingPtrs = null;
  }

  parseVarSection() {
    while (this.tk.k === 'id' && !this.isId('constructor') && !this.isId('destructor')) {
      const ids = [this.next()];
      while (this.accept(',')) ids.push(this.expectId());
      this.expect(':');
      const type = this.parseType();
      if (this.isId('absolute')) {
        this.next();
        const e = this.parseExpr();
        if (e.n !== 'const') this.err('absolute address must be a constant');
        let addr = e.v >>> 0;
        if (this.target.name === 'm816' && addr > 0xffff) this.err('on the 65C816 target, absolute variables must be in bank 0 ($0000-$FFFF); use Mem[]/MemW[] for other banks');
        for (const id of ids) {
          this.declare(id.v, { kind: 'var', type, loc: { k: 'global', addr: this.target.uncached ? (addr | this.target.uncached) >>> 0 : addr } }, id.pos);
        }
      } else if (this.accept('=')) {
        if (ids.length > 1) this.err('only one variable can be initialised at a time');
        this.declareGlobalOrLocalData(ids[0], type, this.parseTypedConst(type));
      } else {
        for (const id of ids) this.declareVar(id, type);
      }
      this.expect(';');
    }
  }

  declareVar(id, type) {
    if (type.size === 0 && type.k !== 'record') this.err('variable of this type not allowed', id.pos);
    if (this.scope.level === 0) {
      const label = `G_${this.moduleName}_${id.v}`;
      this.bss.push({ label, size: Math.max(type.size, 1), align: this.alignOf(type), module: this.moduleName });
      return this.declare(id.v, { kind: 'var', type, loc: { k: 'global', label } }, id.pos);
    }
    const off = this.allocLocal(type.size, this.alignOf(type));
    return this.declare(id.v, { kind: 'var', type, loc: { k: 'local', lvl: this.scope.level, off } }, id.pos);
  }

  // typed constants are always static data (also inside procedures)
  declareGlobalOrLocalData(id, type, bytes) {
    const label = `D_${this.moduleName}_${id.v}_${++this.lbl}`;
    this.data.push({ label, bytes, align: this.alignOf(type), module: this.moduleName });
    return this.declare(id.v, { kind: 'var', type, loc: { k: 'global', label } }, id.pos);
  }

  allocLocal(size, align) {
    const c = this.ctx || this.pendingCtx;
    if (!c) this.err('internal: no procedure for local');
    let off = c.locTop;
    if (align > 1) off = Math.ceil(off / align) * align;
    c.locTop = off + size;
    if (c.locTop > c.locMax) c.locMax = c.locTop;
    return off;
  }

  // --- typed constant values -> bytes ---
  parseTypedConst(type) {
    const out = new Array(type.size).fill(0);
    this.writeConst(type, out, 0);
    return out;
  }
  writeConst(type, out, off) {
    if (type.k === 'array') {
      if (type.elem.k === 'char' && this.tk.k === 'str') {
        const s = this.next().v;
        const n = type.hi - type.lo + 1;
        if (s.length > n) this.err('string constant too long for array');
        for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i) & 255;
        return;
      }
      this.expect('(');
      const n = type.hi - type.lo + 1;
      const es = type.elem.size;
      for (let i = 0; i < n; i++) {
        this.writeConst(type.elem, out, off + i * es);
        if (i < n - 1) this.expect(',');
      }
      this.expect(')');
      return;
    }
    if (type.k === 'record') {
      this.expect('(');
      while (!this.is(')')) {
        const fid = this.expectId();
        const f = type.fields.find(f => f.name === fid.v);
        if (!f) this.err(`unknown field '${fid.raw}'`, fid.pos);
        this.expect(':');
        this.writeConst(f.type, out, off + f.off);
        if (!this.accept(';')) break;
      }
      this.expect(')');
      return;
    }
    const e = this.parseExpr();
    if (e.n !== 'const' && !(e.n === 'setc' && e.isConst)) this.err('constant expected');
    if (type.k === 'string') {
      let s = e.type.k === 'char' ? String.fromCharCode(e.v) : e.v;
      if (typeof s !== 'string') this.err('string constant expected');
      if (s.length > type.max) this.err('string constant too long');
      out[off] = s.length;
      for (let i = 0; i < s.length; i++) out[off + 1 + i] = s.charCodeAt(i) & 255;
      return;
    }
    if (type.k === 'set') {
      for (const r of e.elems) for (let v = r.lo; v <= r.hi; v++) out[off + (v >> 3)] |= 1 << (v & 7);
      return;
    }
    let v;
    if (type.k === 'real') {
      if (!isNumeric(e.type)) this.err('number expected');
      v = realBits(e.v);
    } else if (isPtr(type)) {
      if (e.type.k !== 'nil') this.err('only nil allowed as pointer constant');
      v = 0;
    } else {
      if (!isOrdinal(e.type)) this.err('ordinal constant expected');
      this.checkAssignable(type, e);
      v = e.v;
    }
    for (let i = 0; i < type.size; i++) out[off + i] = (v >>> (8 * i)) & 255;
  }

  // ------------------------------------------------------------------ types
  parseType(nameHint) {
    const t = this.tk;
    if (this.accept('packed')) return this.parseType(nameHint);
    if (t.k === 'op' && t.v === '^') {
      this.next();
      if (this.accept('string')) return { k: 'ptr', to: T.string, size: this.target.ptrSize, name: nameHint };
      const id = this.expectId();
      const s = this.lookup(id.v);
      const pt = { k: 'ptr', to: null, size: this.target.ptrSize, name: nameHint };
      if (s && s.kind === 'type') pt.to = s.type;
      else if (this.pendingPtrs) this.pendingPtrs.push({ name: id.v, type: pt, pos: id.pos });
      else this.err(`unknown type '${id.raw}'`, id.pos);
      return pt;
    }
    if (this.accept('string')) {
      if (this.accept('[')) {
        const e = this.parseExpr();
        this.expect(']');
        if (e.n !== 'const' || e.v < 1 || e.v > 255) this.err('string length must be 1..255');
        return { k: 'string', max: e.v, size: e.v + 1 };
      }
      return T.string;
    }
    if (this.accept('array')) {
      if (!this.accept('[')) this.err('open arrays / dynamic arrays are not supported; give the bounds, e.g. array[0..9] of ...');
      const idxs = [this.parseOrdinalType()];
      while (this.accept(',')) idxs.push(this.parseOrdinalType());
      this.expect(']');
      this.expect('of');
      let elem = this.parseType();
      for (let i = idxs.length - 1; i >= 0; i--) {
        const ix = idxs[i];
        const n = ix.hi - ix.lo + 1;
        if (n <= 0) this.err('array has no elements');
        elem = { k: 'array', idx: ix, lo: ix.lo, hi: ix.hi, elem, size: n * elem.size };
        if (elem.size > 65535) this.err('array too large');
      }
      if (nameHint) elem.name = nameHint;
      return elem;
    }
    if (this.accept('record')) return this.parseRecord(nameHint);
    if (this.accept('set')) {
      this.expect('of');
      const b = this.parseOrdinalType();
      if (b.lo < 0 || b.hi > 255) this.err('set base type must be in 0..255');
      return { k: 'set', base: b, size: 32, name: nameHint };
    }
    if (this.isId('object')) return this.parseObject(nameHint);
    if (this.is('file')) {
      // file of T / file: System's _TFile record, with the record type (null: untyped)
      this.next();
      let of = null;
      if (this.accept('of')) of = this.parseType();
      const fr = this.fileRec();
      return { ...fr, fileOf: of, name: of ? 'file of ' + typeName(of) : 'file' };
    }
    if (this.is('procedure') || this.is('function')) {
      // procedure(...) / function(...): T: the address of a global routine
      const isFunc = this.next().v === 'function';
      const params = this.is('(') ? this.parseParams() : [];
      let ret = null;
      if (isFunc) {
        this.expect(':');
        ret = this.parseTypeIdent();
        if (ret.k === 'string' || isStruct(ret)) this.err('a procedural function returns a scalar, a real or a pointer');
      }
      if (params.some(p => p.hiddenHigh)) this.err('open arrays in a procedural type are not supported');
      const ps = { kind: 'proc', name: '(procedural)', params, ret, level: 1, procType: true };
      this.layoutParams(ps);
      return { k: 'proc', params, ret, sym: ps, size: this.target.ptrSize, name: nameHint || (isFunc ? 'function' : 'procedure') };
    }
    if (t.k === 'op' && t.v === '(') {
      this.next();
      const names = [];
      const et = { k: 'enum', size: 1, lo: 0, hi: 0, names, name: nameHint };
      do {
        const id = this.expectId();
        this.declare(id.v, { kind: 'const', type: et, v: names.length }, id.pos);
        names.push(id.raw);
      } while (this.accept(','));
      this.expect(')');
      et.hi = names.length - 1;
      if (names.length > 256) et.size = 2;
      return et;
    }
    if (t.k === 'id') {
      const s = this.lookup(t.v);
      if (s && s.kind === 'type' && !(this.peekTok().k === 'op' && this.peekTok().v === '..')) {
        this.next();
        return s.type;
      }
    }
    return this.parseOrdinalType();
  }

  parseOrdinalType() {
    const t = this.tk;
    if (t.k === 'id') {
      const s = this.lookup(t.v);
      if (s && s.kind === 'type' && !(this.peekTok().k === 'op' && this.peekTok().v === '..')) {
        this.next();
        if (!isOrdinal(s.type)) this.err(`ordinal type expected, '${typeName(s.type)}' found`, t.pos);
        if (s.type.size > 2 && s.type.k === 'int') this.err('index type too large', t.pos);
        return s.type;
      }
    }
    if (t.k === 'op' && t.v === '(') return this.parseType();
    const a = this.parseSimple();
    this.expect('..');
    const b = this.parseSimple();
    if (a.n !== 'const' || b.n !== 'const') this.err('constant subrange bounds expected', t.pos);
    if (!isOrdinal(a.type) || !isOrdinal(b.type)) this.err('ordinal bounds expected', t.pos);
    if (a.v > b.v) this.err('lower bound greater than upper bound', t.pos);
    const base = a.type.k === 'int' ? T.longint : a.type;
    return subrange(base, a.v, b.v);
  }

  // object [(Parent)] fields; methods [virtual;] end
  parseObject(nameHint) {
    this.next();
    let parent = null;
    if (this.accept('(')) {
      parent = this.parseTypeIdent();
      if (!parent.isObject) this.err('object type expected');
      this.expect(')');
    }
    const P = this.target.ptrSize;
    const ot = {
      k: 'record', isObject: true, name: nameHint, parent, fields: parent ? [...parent.fields] : [],
      size: parent ? parent.size : 0, align: parent ? parent.align : 1,
      methods: new Map(parent ? parent.methods : []), slots: parent ? [...parent.slots] : [],
      vmtOff: parent ? parent.vmtOff : -1, vmtLabel: null,
    };
    let o = ot.size;
    const skipSection = () => { while (this.isId('private') || this.isId('public')) this.next(); };
    skipSection();
    // fields
    while (this.tk.k === 'id' && !['procedure', 'function'].includes(this.tk.v) && !this.isId('constructor') && !this.isId('destructor') &&
           !this.isId('private') && !this.isId('public')) {
      const ids = [this.next()];
      while (this.accept(',')) ids.push(this.expectId());
      this.expect(':');
      const type = this.parseType();
      for (const id of ids) {
        if (ot.fields.some(f => f.name === id.v)) this.err(`duplicate field '${id.raw}'`, id.pos);
        const al = this.alignOf(type);
        if (al > ot.align) ot.align = al;
        o = Math.ceil(o / al) * al;
        ot.fields.push({ name: id.v, type, off: o });
        o += type.size;
      }
      this.expect(';');
      skipSection();
    }
    // methods
    const own = [];
    for (;;) {
      skipSection();
      let kind;
      if (this.is('procedure') || this.is('function')) kind = this.next().v;
      else if (this.isId('constructor') || this.isId('destructor')) kind = this.next().v;
      else break;
      const id = this.expectId();
      const params = this.is('(') ? this.parseParams() : [];
      let ret = null;
      if (kind === 'function') { this.expect(':'); ret = this.parseTypeIdent(); }
      this.expect(';');
      let virt = false;
      if (this.isId('virtual')) { this.next(); if (this.tk.k === 'int') this.next(); this.expect(';'); virt = true; }
      own.push({ kind, id, params, ret, virt });
    }
    this.expect('end');
    // the VMT link: after the fields of the first type with virtual methods
    if (ot.vmtOff < 0 && own.some(m => m.virt)) {
      o = Math.ceil(o / P) * P;
      ot.vmtOff = o;
      o += P;
      if (P > ot.align) ot.align = P;
    }
    ot.size = this.target.align ? Math.ceil(o / ot.align) * ot.align : o;
    for (const m of own) {
      const old = ot.methods.get(m.id.v);
      const self = { name: 'self', type: ot, mode: 'var', isSelf: true };
      const sym = {
        kind: 'proc', name: `${nameHint}.${m.id.raw}`, label: `P${++this.lbl}_${(nameHint || 'obj').toLowerCase()}_${m.id.v}`,
        params: [...m.params, self], ret: m.ret, level: 1, forward: true, external: null, isFunc: !!m.ret,
        method: { obj: ot, name: m.id.v, kind: m.kind },
      };
      this.layoutParams(sym);
      let slot = -1;
      if (m.virt || (old && old.virtual)) {
        slot = old && old.virtual ? old.slot : ot.slots.length;
        ot.slots[slot] = sym;
      }
      ot.methods.set(m.id.v, { sym, virtual: slot >= 0, slot, kind: m.kind, obj: ot });
    }
    if (ot.slots.length) {
      ot.vmtLabel = `VMT${++this.lbl}_${(nameHint || 'obj').toLowerCase()}`;
      this.bss.push({ label: ot.vmtLabel, size: (ot.slots.length + 1) * P, align: P, module: this.moduleName });
      this.objTypes.push(ot);
    }
    return ot;
  }
  // is a an object type derived from b (or b itself)?
  isDescendant(a, b) {
    for (let t = a; t; t = t.parent) if (t === b) return true;
    return false;
  }

  parseRecord(nameHint) {
    const rec = { k: 'record', fields: [], size: 0, align: 1, name: nameHint };
    let off = 0;
    const addField = (id, type, at) => {
      if (rec.fields.some(f => f.name === id.v)) this.err(`duplicate field '${id.raw}'`, id.pos);
      const al = this.alignOf(type);
      if (al > rec.align) rec.align = al;
      let o = Math.ceil(at / al) * al;
      rec.fields.push({ name: id.v, type, off: o });
      return o + type.size;
    };
    const parseFieldList = (start) => {
      let o = start;
      while (this.tk.k === 'id') {
        const ids = [this.next()];
        while (this.accept(',')) ids.push(this.expectId());
        this.expect(':');
        const type = this.parseType();
        for (const id of ids) o = addField(id, type, o);
        if (!this.accept(';')) break;
      }
      if (this.accept('case')) {
        // variant part: case [tag:] type of c: (fields); ...
        let tagType;
        if (this.tk.k === 'id' && this.peekTok().k === 'op' && this.peekTok().v === ':') {
          const tid = this.next();
          this.expect(':');
          tagType = this.parseOrdinalType();
          o = addField(tid, tagType, o);
        } else tagType = this.parseOrdinalType();
        this.expect('of');
        const vstart = o;
        let vmax = o;
        while (!this.is('end') && !this.is(')')) {
          do { this.parseExpr(); if (this.accept('..')) this.parseExpr(); } while (this.accept(','));
          this.expect(':');
          this.expect('(');
          const e = parseFieldList(vstart);
          this.expect(')');
          if (e > vmax) vmax = e;
          if (!this.accept(';')) break;
        }
        o = vmax;
      }
      return o;
    };
    off = parseFieldList(0);
    this.expect('end');
    rec.size = Math.ceil(off / rec.align) * rec.align;
    return rec;
  }

  // ------------------------------------------------------------- procedures
  parseProcDecl(isInterface) {
    const isFunc = this.next().v === 'function';
    const id = this.expectId();
    let name = id.v;
    let method = null;
    if (this.accept('.')) {
      // TObj.Method: the body of a method declared in the object type
      const ts = this.lookup(name);
      if (!ts || ts.kind !== 'type' || !ts.type.isObject) this.err(`object type expected, '${id.raw}' found`, id.pos);
      const mid = this.expectId();
      method = ts.type.methods.get(mid.v);
      if (!method || method.obj !== ts.type) this.err(`'${mid.raw}' is not a method of ${id.raw}`, mid.pos);
    }
    const params = this.is('(') ? this.parseParams() : [];
    let ret = null;
    if (isFunc) {
      if (this.accept(':')) ret = this.parseTypeIdent();
    }
    this.expect(';');
    if (method) {
      const sym = method.sym;
      if (params.length && !this.sameParams(sym.params.slice(0, -1), params)) this.err(`parameter list of '${sym.name}' differs from the declaration`, id.pos);
      if (!sym.forward) this.err(`'${sym.name}' is already defined`, id.pos);
      return this.parseProcBody(sym, false);
    }
    let existing = this.scope.syms.get(name);
    if (!existing && this.scope.parent && this.scope.level === 0 && this.scope.parent.level === 0) {
      // implementation part of a unit: the interface scope is the parent
      const iface = this.scope.parent.syms.get(name);
      if (iface && iface.kind === 'proc' && iface.forward) existing = iface;
    }
    let sym;
    if (existing && existing.kind === 'proc' && existing.forward) {
      sym = existing;
      if (params.length && !this.sameParams(sym.params, params)) this.err(`parameter list of '${id.raw}' differs from the declaration`, id.pos);
      if (isFunc && ret && sym.ret && !sameType(ret, sym.ret)) this.err(`result type of '${id.raw}' differs from the declaration`, id.pos);
    } else {
      if (existing) this.err(`duplicate identifier '${id.raw}'`, id.pos);
      if (isFunc && !ret) this.err('function result type expected', id.pos);
      if (ret && isStruct(ret) && ret.k !== 'string') this.err('functions can return scalars, reals, pointers and strings only', id.pos);
      const level = this.scope.level + 1;
      sym = {
        kind: 'proc', name: id.raw, label: `P${++this.lbl}_${name}`, params, ret, level,
        forward: true, external: null, isFunc,
      };
      this.layoutParams(sym);
      this.scope.syms.set(name, sym);
    }
    // directives
    for (;;) {
      if (this.isId('forward')) { this.next(); this.expect(';'); return; }
      if (this.isId('external')) {
        this.next();
        const nm = this.tk.k === 'str' ? this.next().v : sym.name.toLowerCase();
        this.expect(';');
        sym.external = nm;
        sym.label = `rt_${nm}`;
        sym.forward = false;
        return;
      }
      if (this.isId('inline') || this.isId('register') || this.isId('pascal') || this.isId('cdecl') || this.isId('assembler')) {
        this.next(); this.expect(';'); continue;
      }
      break;
    }
    if (isInterface) return;
    this.parseProcBody(sym, true);
  }

  parseProcBody(sym, plain) {
    // body
    sym.forward = false;
    const ctx = new ProcCtx(sym.level, sym.label, sym.name);
    ctx.sym = sym;
    const outerScope = this.scope;
    const outerWith = this.withStack;
    this.withStack = [];
    this.scope = new Scope(outerScope, sym.level);
    const parentCtx = this.pendingCtx || this.ctx;
    ctx.parent = sym.level >= 2 && parentCtx ? parentCtx.label : null;
    const savedPending = this.pendingCtx;
    this.pendingCtx = ctx;
    const savedCtx = this.ctx;
    this.ctx = null;
    ctx.hasSL = sym.level >= 2;
    ctx.parBytes = sym.parBytes;
    // parameters
    const copies = [];
    for (const prm of sym.params) {
      const ploc = { k: 'param', lvl: sym.level, off: prm.off };
      if (prm.mode === 'var' || prm.mode === 'const' && (isStruct(prm.type) || prm.type.k === 'untyped' || prm.type.k === 'openarray') ||
          prm.mode === 'val' && isStruct(prm.type)) {
        if (prm.mode === 'val') {
          const off = this.allocLocal(prm.type.size, this.alignOf(prm.type));
          copies.push({ from: prm.off, to: off, size: prm.type.size, type: prm.type });
          this.scope.syms.set(prm.name, { kind: 'var', name: prm.name, type: prm.type, loc: { k: 'local', lvl: sym.level, off } });
        } else {
          this.scope.syms.set(prm.name, { kind: 'var', name: prm.name, type: prm.type, loc: { ...ploc, byRef: true }, isConst: prm.mode === 'const' });
        }
      } else {
        this.scope.syms.set(prm.name, { kind: 'var', name: prm.name, type: prm.type, loc: ploc, isConst: prm.mode === 'const' });
      }
    }
    if (sym.ret) {
      ctx.retType = sym.ret;
      if (sym.ret.k === 'string') {
        ctx.resultSym = { kind: 'var', type: T.string, loc: { k: 'param', lvl: sym.level, off: sym.hiddenOff, byRef: true } };
        ctx.retCls = null;
      } else {
        const off = this.allocLocal(sym.ret.size, this.alignOf(sym.ret));
        ctx.resultSym = { kind: 'var', type: sym.ret, loc: { k: 'local', lvl: sym.level, off } };
        ctx.retCls = this.clsOf(sym.ret);
        ctx.resultLoc = { off, mt: this.mtOf(sym.ret) };
      }
      this.scope.syms.set('result', ctx.resultSym);
    }
    let selfBase = null;
    if (sym.method) {
      const sv = this.scope.syms.get('self');
      selfBase = { n: 'var', sym: sv, type: sym.method.obj, lv: true };
      this.withStack.push({ recType: sym.method.obj, base: selfBase });
      ctx.method = sym.method;
      ctx.selfBase = selfBase;
    }
    this.parseDecls(false);
    this.pendingCtx = null;
    this.beginProc(ctx);

    for (const c of copies) {
      this.emit({ o: 'laddr', hops: 0, off: c.to, kind: 'loc' });
      this.emit({ o: 'ldl', hops: 0, off: c.from, kind: 'par', mt: this.mtOf(this.ptrT) });
      this.emit({ o: 'copy', n: c.size });
    }
    if (this.is('asm')) this.err('asm blocks are not supported; use Mem[], absolute variables or the hardware units');
    this.expect('begin');
    this.parseStmtSeq('end');
    this.expect('end');
    this.expect(';');
    this.endProc();
    this.ctx = savedCtx;
    this.pendingCtx = savedPending;
    this.scope = outerScope;
    this.withStack = outerWith;
  }

  parseTypeIdent() {
    if (this.accept('string')) return T.string;
    const id = this.expectId();
    const s = this.lookup(id.v);
    if (!s || s.kind !== 'type') this.err(`type identifier expected, '${id.raw}' found`, id.pos);
    return s.type;
  }

  parseParams() {
    const params = [];
    this.expect('(');
    if (this.accept(')')) return params;
    do {
      let mode = 'val';
      if (this.accept('var')) mode = 'var';
      else if (this.accept('const')) mode = 'const';
      else if (this.isId('out')) { this.next(); mode = 'var'; }
      const ids = [this.expectId()];
      while (this.accept(',')) ids.push(this.expectId());
      let type;
      if (this.accept(':')) {
        if (this.accept('array')) {
          // array of T: passed by address (value ones like const), with a
          // hidden parameter name$high = the last index (they count from 0)
          this.expect('of');
          const elem = this.parseTypeIdent();
          const oa = { k: 'openarray', elem, size: this.target.ptrSize, name: 'array of ' + typeName(elem) };
          for (const id of ids) {
            params.push({ name: id.v, type: oa, mode: mode === 'var' ? 'var' : 'const' });
            params.push({ name: id.v + '$high', type: T.integer, mode: 'val', hiddenHigh: true });
          }
          continue;
        }
        type = this.parseTypeIdent();
      } else {
        if (mode === 'val') this.err('parameter type expected');
        type = T.untyped;
      }
      for (const id of ids) params.push({ name: id.v, type, mode });
    } while (this.accept(';'));
    this.expect(')');
    return params;
  }

  sameParams(a, b) {
    if (a.length !== b.length) return false;
    return a.every((p, i) => p.mode === b[i].mode && (p.type === b[i].type || sameType(p.type, b[i].type)));
  }

  isRefParam(prm) {
    return prm.mode === 'var' || isStruct(prm.type) || prm.type.k === 'untyped' || prm.type.k === 'openarray';
  }
  // args are pushed left to right; the last one ends at the lowest address
  layoutParams(sym) {
    const slots = [];
    if (sym.ret && sym.ret.k === 'string') slots.push({ hidden: true, cls: this.P });
    for (const p of sym.params) {
      p.cls = this.isRefParam(p) ? this.P : this.clsOf(p.type);
      slots.push(p);
    }
    let off = sym.level >= 2 ? this.argBytes(this.P) : 0;
    for (let i = slots.length - 1; i >= 0; i--) {
      const s = slots[i];
      if (s.hidden) sym.hiddenOff = off; else s.off = off;
      off += this.argBytes(s.cls);
    }
    sym.parBytes = off;
  }

  beginProc(ctx) {
    this.ctx = ctx;
    ctx.exitLabel = this.newLabel('X');
    if (ctx.vmtInit) {
      // every object type's VMT: its size, then its virtual methods
      const P = this.target.ptrSize, mt = this.mtOf(this.ptrT);
      for (const ot of this.objTypes) {
        this.emit({ o: 'lit', s: this.P, v: ot.size });
        this.emit({ o: 'stg', g: ot.vmtLabel, off: 0, mt });
        ot.slots.forEach((m, k) => {
          this.emit({ o: 'gaddr', g: m.label, off: 0 });
          this.emit({ o: 'stg', g: ot.vmtLabel, off: (k + 1) * P, mt });
        });
      }
    }
  }
  endProc() {
    const c = this.ctx;
    for (const sym of this.scope.syms.values())
      if (sym.kind === 'label' && sym.used && !sym.defined) this.err(`label '${sym.name}' is used but not placed`, sym.used);
    this.emit({ o: 'label', l: c.exitLabel });
    this.procs.push({
      label: c.label, name: c.name, level: c.level, locSize: c.locMax,
      parBytes: c.parBytes, hasSL: c.hasSL, retCls: c.retCls, resultLoc: c.resultLoc, parent: c.parent || null,
      code: c.code, module: this.moduleName,
    });
    this.ctx = null;
  }

  // ------------------------------------------------------------- statements
  parseStmtSeq(endKw) {
    for (;;) {
      if (this.is(endKw)) return;
      this.parseStatement();
      if (!this.accept(';')) {
        if (!this.is(endKw)) this.err(`';' expected but ${this.desc(this.tk)} found`);
        return;
      }
    }
  }

  tempMark() { return this.ctx.locTop; }
  tempRelease(m) { this.ctx.locTop = m; }
  allocTemp(size, align = 1) {
    const c = this.ctx;
    let off = c.locTop;
    const al = this.target.align ? Math.max(align, 1) : 1;
    off = Math.ceil(off / al) * al;
    c.locTop = off + size;
    if (c.locTop > c.locMax) c.locMax = c.locTop;
    return off;
  }
  tempVar(type) {
    const off = this.allocTemp(type.size, this.alignOf(type));
    return { kind: 'var', type, loc: { k: 'local', lvl: this.ctx.level, off } };
  }

  parseStatement() {
    const t = this.tk;
    const mark = this.tempMark();
    if (t.k !== 'eof') this.emit({ o: 'line', file: t.pos.file, line: t.pos.line });
    // a label in front of the statement
    if ((t.k === 'id' || t.k === 'int') && this.peekTok().k === 'op' && this.peekTok().v === ':') {
      const sym = this.lookup(String(t.v));
      if (sym && sym.kind === 'label') {
        if (sym.scope !== this.scope) this.err(`label '${t.v}' belongs to another routine`, t.pos);
        if (sym.defined) this.err(`label '${t.v}' placed twice`, t.pos);
        sym.defined = true;
        this.emit({ o: 'label', l: sym.lbl });
        this.next(); this.next();
        this.tempRelease(mark);
        this.parseStatement();
        return;
      }
    }
    if (t.k === 'kw') {
      switch (t.v) {
        case 'begin': this.next(); this.parseStmtSeq('end'); this.expect('end'); break;
        case 'if': this.parseIf(); break;
        case 'while': this.parseWhile(); break;
        case 'repeat': this.parseRepeat(); break;
        case 'for': this.parseFor(); break;
        case 'case': this.parseCase(); break;
        case 'with': this.parseWith(); break;
        case 'goto': {
          this.next();
          const g = this.next();
          const sym = this.lookup(String(g.v));
          if (!sym || sym.kind !== 'label') this.err('label expected after goto', g.pos);
          if (sym.scope !== this.scope) this.err(`goto out of the routine to '${g.v}'`, g.pos);
          sym.used = sym.used || g.pos;
          this.emit({ o: 'jmp', l: sym.lbl });
          break;
        }
        case 'asm': this.err('asm blocks are not supported');
        default: break; // empty statement (e.g. before 'end' / 'else' / 'until')
      }
    } else if (t.k === 'id') {
      this.parseSimpleStatement();
    }
    this.tempRelease(mark);
  }

  parseSimpleStatement() {
    const t = this.tk;
    if (this.isId('inherited') && !this.lookup('inherited')) {
      const c = this.parseInherited(t.pos);
      this.genCall(c);
      if (c.type.k !== 'void' && c.type.k !== 'string') this.emit({ o: 'drop', s: this.clsOf(c.type) });
      return;
    }
    const sym = this.lookup(t.v);
    if (!sym) this.err(`unknown identifier '${t.raw}'`);
    if (sym.kind === 'bproc') { this.next(); this.builtinProc(sym.name, t.pos); return; }
    if (sym.kind === 'proc' && !(this.ctx.sym === sym && this.peekTok().k === 'op' && this.peekTok().v === ':=')) {
      this.next();
      const call = this.parseCallArgs(sym, t.pos);
      this.genCall(call);
      if (sym.ret && sym.ret.k !== 'string') this.emit({ o: 'drop', s: this.clsOf(sym.ret) });
      if (this.isFileProc(sym)) this.genIoCheck();
      return;
    }
    const lhs = this.parseDesignator('lhs');
    if (this.accept(':=')) {
      if (lhs.type && lhs.type.k === 'proc') this.wantProc = lhs.type;
      const rhs = this.parseExpr();
      this.wantProc = null;
      this.assign(lhs, rhs, t.pos);
      return;
    }
    if (this.is('+=') || this.is('-=')) {
      const op = this.next().v === '+=' ? '+' : '-';
      const rhs = this.parseExpr();
      this.assign(lhs, this.binop(op, lhs, rhs, t.pos), t.pos);
      return;
    }
    if (lhs.n === 'call') { this.genCall(lhs); if (lhs.type.k !== 'string' && lhs.type.k !== 'void') this.emit({ o: 'drop', s: this.clsOf(lhs.type) }); return; }
    if (lhs.type && lhs.type.k === 'proc') {
      // p; without arguments
      const c = this.parseIndirectCall(lhs, t.pos);
      this.genCall(c);
      if (c.type.k !== 'void') this.emit({ o: 'drop', s: this.clsOf(c.type) });
      return;
    }
    this.err(`':=' expected but ${this.desc(this.tk)} found`);
  }

  parseIf() {
    this.next();
    const c = this.parseExpr();
    this.checkBool(c);
    this.expect('then');
    const lElse = this.newLabel();
    this.genCond(c, lElse);
    this.parseStatement();
    if (this.accept('else')) {
      const lEnd = this.newLabel();
      this.emit({ o: 'jmp', l: lEnd });
      this.emit({ o: 'label', l: lElse });
      this.parseStatement();
      this.emit({ o: 'label', l: lEnd });
    } else {
      this.emit({ o: 'label', l: lElse });
    }
  }

  parseWhile() {
    this.next();
    const lTop = this.newLabel(), lEnd = this.newLabel();
    this.emit({ o: 'label', l: lTop });
    const c = this.parseExpr();
    this.checkBool(c);
    this.expect('do');
    this.genCond(c, lEnd);
    this.ctx.loops.push({ brk: lEnd, cont: lTop });
    this.parseStatement();
    this.ctx.loops.pop();
    this.emit({ o: 'jmp', l: lTop });
    this.emit({ o: 'label', l: lEnd });
  }

  parseRepeat() {
    this.next();
    const lTop = this.newLabel(), lCont = this.newLabel(), lEnd = this.newLabel();
    this.emit({ o: 'label', l: lTop });
    this.ctx.loops.push({ brk: lEnd, cont: lCont });
    this.parseStmtSeq('until');
    this.ctx.loops.pop();
    this.expect('until');
    this.emit({ o: 'label', l: lCont });
    const c = this.parseExpr();
    this.checkBool(c);
    this.genCond(c, lTop);
    this.emit({ o: 'label', l: lEnd });
  }

  parseFor() {
    const pos = this.next().pos;
    const vt = this.expectId();
    const v = this.lookup(vt.v);
    if (!v || v.kind !== 'var') this.err('loop variable must be a simple variable', vt.pos);
    if (!isOrdinal(v.type)) this.err('loop variable must be ordinal', vt.pos);
    if (v.loc.byRef) this.err('loop variable must be a local or global variable', vt.pos);
    const vn = { n: 'var', sym: v, type: v.type, lv: true };
    this.expect(':=');
    const from = this.parseExpr();
    const down = this.is('downto');
    if (!this.accept('to') && !this.accept('downto')) this.err("'to' or 'downto' expected");
    const to = this.parseExpr();
    this.expect('do');
    this.assign(vn, from, pos);
    const lim = this.tempVar(v.type);
    const limN = { n: 'var', sym: lim, type: v.type, lv: true };
    this.assign(limN, to, pos);
    const lEnd = this.newLabel(), lTop = this.newLabel(), lCont = this.newLabel();
    const cls = this.clsOf(v.type), u = !this.signedOf(v.type);
    this.genValue(vn); this.genValue(limN);
    this.emit({ o: 'jc', c: down ? 'lt' : 'gt', s: cls, u, l: lEnd });
    this.emit({ o: 'label', l: lTop });
    this.ctx.loops.push({ brk: lEnd, cont: lCont });
    this.parseStatement();
    this.ctx.loops.pop();
    this.emit({ o: 'label', l: lCont });
    this.genValue(vn); this.genValue(limN);
    this.emit({ o: 'jc', c: 'eq', s: cls, u, l: lEnd });
    this.genIncDec(vn, down ? -1 : 1);
    this.emit({ o: 'jmp', l: lTop });
    this.emit({ o: 'label', l: lEnd });
  }

  parseCase() {
    this.next();
    const sel = this.parseExpr();
    if (!isOrdinal(sel.type)) this.err('ordinal expression expected in case');
    this.expect('of');
    const st = this.tempVar(sel.type.k === 'int' && sel.type.size === 4 ? T.longint : (this.signedOf(sel.type) ? T.integer : T.word));
    const stN = { n: 'var', sym: st, type: st.type, lv: true };
    this.assign(stN, sel.type.k === 'int' ? sel : { n: 'cvt', e: sel, type: T.word, explicit: true });
    const cls = this.clsOf(st.type), u = !st.type.signed;
    const lEnd = this.newLabel();
    while (!this.is('end') && !this.is('else') && !this.isId('otherwise')) {
      const lArm = this.newLabel(), lNext = this.newLabel();
      do {
        const a = this.parseExpr();
        if (a.n !== 'const') this.err('constant expected in case label');
        if (this.accept('..')) {
          const b = this.parseExpr();
          if (b.n !== 'const') this.err('constant expected in case label');
          const lSkip = this.newLabel();
          this.genValue(stN); this.emit({ o: 'lit', s: cls, v: a.v });
          this.emit({ o: 'jc', c: 'lt', s: cls, u, l: lSkip });
          this.genValue(stN); this.emit({ o: 'lit', s: cls, v: b.v });
          this.emit({ o: 'jc', c: 'le', s: cls, u, l: lArm });
          this.emit({ o: 'label', l: lSkip });
        } else {
          this.genValue(stN); this.emit({ o: 'lit', s: cls, v: a.v });
          this.emit({ o: 'jc', c: 'eq', s: cls, u, l: lArm });
        }
      } while (this.accept(','));
      this.expect(':');
      this.emit({ o: 'jmp', l: lNext });
      this.emit({ o: 'label', l: lArm });
      this.parseStatement();
      this.emit({ o: 'jmp', l: lEnd });
      this.emit({ o: 'label', l: lNext });
      if (!this.accept(';')) break;
    }
    if (this.accept('else') || (this.isId('otherwise') && this.next())) {
      this.parseStmtSeq('end');
    }
    this.expect('end');
    this.emit({ o: 'label', l: lEnd });
  }

  parseWith() {
    this.next();
    const n0 = this.withStack.length;
    do {
      const d = this.parseDesignator();
      if (d.type.k !== 'record') this.err('record expected in with');
      let base;
      if (this.isStableLval(d)) base = d;
      else {
        const tmp = this.tempVar(this.ptrT);
        const tn = { n: 'var', sym: tmp, type: this.ptrT, lv: true };
        const dl = this.lvalDesc(tn);
        this.genAddr(d);
        this.storeDesc(dl, this.mtOf(this.ptrT));
        base = { n: 'deref', ptr: tn, type: d.type, lv: true };
      }
      this.withStack.push({ recType: d.type, base });
    } while (this.accept(','));
    this.expect('do');
    this.parseStatement();
    this.withStack.length = n0;
  }

  isStableLval(e) {
    if (e.n === 'var') return !e.sym.loc.byRef || true;
    if (e.n === 'field') return this.isStableLval(e.base);
    if (e.n === 'index') return e.idx.n === 'const' && this.isStableLval(e.base);
    return false;
  }

  // ------------------------------------------------------------ files
  // System's file record (Text is the same type)
  fileRec() {
    const sys = this.units.get('system');
    const s = sys && sys.iface.syms.get('_tfile');
    if (!s) this.err('internal: _TFile missing in System');
    return s.type;
  }
  isFileType(t) { return t && t.k === 'record' && (t === this.fileRec() || t.fileOf !== undefined); }
  isTextType(t) { return t && t.k === 'record' && t.fileOf === undefined && t === this.fileRec(); }
  // a System routine on files (Close, Append, Seek ...): $I+ checks after it
  isFileProc(sym) {
    const sys = this.units.get('system');
    return sys && sym.params && sym.params.length > 0 && sym.params[0].type === this.fileRec() &&
      sys.iface.syms.get(sym.name) === sym;
  }
  genIoCheck() { if (this.sw.I) this.genCall(this.mkRtCall('iocheck', [])); }
  // the record size Reset / Rewrite give a file: 0 = text
  fileRecSize(t) { return t.fileOf === undefined ? 0 : t.fileOf === null ? 128 : t.fileOf.size; }

  // ------------------------------------------------------------ builtins
  builtinProc(name, pos) {
    switch (name) {
      case 'reset': case 'rewrite': {
        this.expect('(');
        const f = this.parseDesignator();
        if (!f.lv || !this.isFileType(f.type)) this.err('file variable expected');
        let rs = this.cint(this.fileRecSize(f.type));
        if (this.accept(',')) rs = this.conv(this.parseExpr(), T.integer);
        this.expect(')');
        this.genCall(this.mkRtCall(name === 'reset' ? 'freset' : 'frewrite', [f, rs]));
        this.genIoCheck();
        return;
      }
      case 'blockread': case 'blockwrite': {
        this.expect('(');
        const f = this.parseDesignator();
        if (!f.lv || !this.isFileType(f.type)) this.err('file variable expected');
        this.expect(',');
        const buf = this.parseDesignator();
        this.expect(',');
        const n = this.conv(this.parseExpr(), T.word);
        let res;
        if (this.accept(',')) res = this.parseDesignator();
        else res = { n: 'var', sym: this.units.get('system').iface.syms.get('_fdummy'), type: T.word, lv: true };
        this.expect(')');
        this.genCall(this.mkRtCall(name === 'blockread' ? 'fblockread' : 'fblockwrite', [f, buf, n, res]));
        this.genIoCheck();
        return;
      }
      case 'write': case 'writeln': return this.genWrite(name === 'writeln');
      case 'read': case 'readln': return this.genRead(name === 'readln');
      case 'inc': case 'dec': {
        this.expect('(');
        const v = this.parseDesignator();
        if (!v.lv) this.err('variable expected');
        let amount = null;
        if (this.accept(',')) amount = this.parseExpr();
        this.expect(')');
        if (isPtr(v.type)) {
          const es = v.type.to ? v.type.to.size : 1;
          const amt = amount ? this.binop('*', amount, this.cint(es)) : this.cint(es);
          this.assign(v, { n: 'cvt', e: this.binop(name === 'inc' ? '+' : '-', { n: 'cvt', e: v, type: this.target.ptrSize === 2 ? T.word : T.longword }, amt), type: v.type, explicit: true });
          return;
        }
        if (!isOrdinal(v.type)) this.err('ordinal variable expected');
        if (!amount || amount.n === 'const') this.genIncDec(v, (name === 'inc' ? 1 : -1) * (amount ? amount.v : 1));
        else this.assign(v, this.binop(name === 'inc' ? '+' : '-', v, amount), pos);
        return;
      }
      case 'new': case 'dispose': {
        this.expect('(');
        const v = this.parseDesignator();
        if (v.type.k !== 'ptr' || !v.type.to) this.err('typed pointer expected');
        if (this.accept(',')) {
          // New(p, Constructor(args)) / Dispose(p, Destructor(args))
          const ot = v.type.to;
          if (!ot.isObject) this.err('a pointer to an object expected');
          const mid = this.expectId();
          const m = ot.methods.get(mid.v);
          if (!m) this.err(`'${mid.raw}' is not a method of ${typeName(ot)}`, mid.pos);
          const self = { n: 'deref', ptr: v, type: ot, lv: true };
          if (name === 'new') {
            if (m.kind !== 'constructor') this.err('a constructor expected');
            this.assign(v, { n: 'cvt', e: this.callRt('getmem', [this.cint(ot.size)]), type: v.type, explicit: true });
            this.genCall(this.methodCall(self, m, mid.pos, true, true));
          } else {
            if (m.kind !== 'destructor') this.err('a destructor expected');
            this.genCall(this.methodCall(self, m, mid.pos, false));
            // the size of what it really is: +0 of its VMT
            const sz = ot.vmtOff >= 0
              ? { n: 'vmtsize', obj: self, off: ot.vmtOff, type: T.word }
              : this.cint(ot.size);
            this.genCall(this.mkRtCall('freemem', [v, sz]));
          }
          this.expect(')');
          return;
        }
        this.expect(')');
        const sz = this.cint(v.type.to.size);
        if (name === 'new') {
          this.assign(v, { n: 'cvt', e: this.callRt('getmem', [sz]), type: v.type, explicit: true });
        } else {
          this.genCall(this.mkRtCall('freemem', [v, sz]));
        }
        return;
      }
      case 'getmem': case 'freemem': {
        this.expect('(');
        const v = this.parseDesignator();
        this.expect(',');
        const sz = this.parseExpr();
        this.expect(')');
        if (!isPtr(v.type)) this.err('pointer expected');
        if (name === 'getmem') this.assign(v, { n: 'cvt', e: this.callRt('getmem', [sz]), type: v.type, explicit: true });
        else this.genCall(this.mkRtCall('freemem', [v, sz]));
        return;
      }
      case 'halt': {
        let code = this.cint(0);
        if (this.accept('(')) { code = this.parseExpr(); this.expect(')'); }
        this.genCall(this.mkRtCall('halt', [code]));
        return;
      }
      case 'exit': {
        if (this.accept('(')) {
          if (!this.ctx.resultSym) this.err('exit with a value is only allowed in functions');
          const v = this.parseExpr();
          this.expect(')');
          this.assign({ n: 'var', sym: this.ctx.resultSym, type: this.ctx.resultSym.type, lv: true }, v);
        }
        this.emit({ o: 'jmp', l: this.ctx.exitLabel });
        return;
      }
      case 'break': case 'continue': {
        const lp = this.ctx.loops[this.ctx.loops.length - 1];
        if (!lp) this.err(`${name} outside of a loop`);
        this.emit({ o: 'jmp', l: name === 'break' ? lp.brk : lp.cont });
        return;
      }
      case 'str': {
        this.expect('(');
        const v = this.parseExpr();
        let w = this.cint(0), d = this.cint(-1);
        if (this.accept(':')) { w = this.parseExpr(); if (this.accept(':')) d = this.parseExpr(); }
        this.expect(',');
        const s = this.parseDesignator();
        this.expect(')');
        if (s.type.k !== 'string') this.err('string variable expected');
        if (isReal(v.type)) this.genCall(this.mkRtCall('strreal', [v, w, d, s, this.cint(s.type.max)]));
        else if (isInt(v.type)) this.genCall(this.mkRtCall('strint', [this.conv(v, T.longint), w, s, this.cint(s.type.max)]));
        else this.err('number expected in Str');
        return;
      }
      case 'val': {
        this.expect('(');
        const s = this.parseExpr();
        this.expect(',');
        const v = this.parseDesignator();
        this.expect(',');
        const code = this.parseDesignator();
        this.expect(')');
        if (!isInt(code.type)) this.err('integer variable expected for the error code');
        const ct = this.tempVar(T.integer);
        const ctN = { n: 'var', sym: ct, type: T.integer, lv: true };
        if (isReal(v.type)) this.assign(v, this.callRt('valreal', [s, ctN]));
        else if (isInt(v.type)) this.assign(v, { n: 'cvt', e: this.callRt('valint', [s, ctN]), type: v.type, explicit: true });
        else this.err('numeric variable expected in Val');
        this.assign(code, ctN);
        return;
      }
      case 'include': case 'exclude': {
        this.expect('(');
        const s = this.parseDesignator();
        this.expect(',');
        const e = this.parseExpr();
        this.expect(')');
        if (s.type.k !== 'set') this.err('set variable expected');
        this.genCall(this.mkRtCall(name === 'include' ? 'setincl' : 'setexcl', [s, this.conv(e, T.integer)]));
        return;
      }
    }
    this.err(`'${name}' cannot be used here`, pos);
  }

  genWrite(ln) {
    const args = [];
    if (this.accept('(')) {
      if (!this.is(')')) {
        do {
          const e = this.parseExpr();
          let w = null, d = null;
          if (this.accept(':')) { w = this.parseExpr(); if (this.accept(':')) d = this.parseExpr(); }
          args.push({ e, w, d });
        } while (this.accept(','));
      }
      this.expect(')');
    }
    // Write(f, ...): a file of records takes variables; a text file the usual
    let file = null;
    if (args.length && this.isFileType(args[0].e.type)) {
      file = args.shift().e;
      if (!file.lv) this.err('file variable expected');
      if (!this.isTextType(file.type)) {
        if (ln) this.err('WriteLn is for text files');
        for (const a of args) {
          if (!a.e.lv) this.err('variable expected');
          this.genCall(this.mkRtCall('fwrite', [file, a.e, this.cint(a.e.type.size)]));
        }
        this.genIoCheck();
        return;
      }
      this.genCall(this.mkRtCall('textout', [file]));
    }
    for (const a of args) {
      const t = a.e.type;
      const w = a.w ? this.conv(a.w, T.integer) : this.cint(0);
      if (t.k === 'char') this.genCall(this.mkRtCall('writechar', [a.e, w]));
      else if (t.k === 'string') this.genCall(this.mkRtCall('writestr', [a.e, w]));
      else if (t.k === 'bool') this.genCall(this.mkRtCall('writebool', [a.e, w]));
      else if (t.k === 'real') this.genCall(this.mkRtCall('writereal', [a.e, w, a.d ? this.conv(a.d, T.integer) : this.cint(-1)]));
      else if (t.k === 'int' && t.size === 4 && !t.signed) this.genCall(this.mkRtCall('writecard', [a.e, w]));
      else if (t.k === 'int') this.genCall(this.mkRtCall('writeint', [this.conv(a.e, T.longint), w]));
      else if (t.k === 'enum') this.genCall(this.mkRtCall('writeint', [this.conv({ n: 'cvt', e: a.e, type: T.word, explicit: true }, T.longint), w]));
      else if (t.k === 'ptr') this.genCall(this.mkRtCall('writecard', [this.conv({ n: 'cvt', e: a.e, type: this.target.ptrSize === 2 ? T.word : T.longword, explicit: true }, T.longword), w]));
      else this.err(`cannot write a value of type ${typeName(t)}`);
    }
    if (ln) this.genCall(this.mkRtCall('writeln', []));
    if (file) { this.genCall(this.mkRtCall('textend', [])); this.genIoCheck(); }
  }

  genRead(ln) {
    const vars = [];
    if (this.accept('(')) {
      if (!this.is(')')) {
        do { vars.push(this.parseDesignator()); } while (this.accept(','));
      }
      this.expect(')');
    }
    let file = null;
    if (vars.length && this.isFileType(vars[0].type)) {
      file = vars.shift();
      if (!this.isTextType(file.type)) {
        if (ln) this.err('ReadLn is for text files');
        for (const v of vars) {
          if (!v.lv) this.err('variable expected in read');
          this.genCall(this.mkRtCall('fread', [file, v, this.cint(v.type.size)]));
        }
        this.genIoCheck();
        return;
      }
      this.genCall(this.mkRtCall('textin', [file]));
    }
    for (const v of vars) {
      if (!v.lv) this.err('variable expected in read');
      const t = v.type;
      if (t.k === 'string') this.genCall(this.mkRtCall('readstr', [v, this.cint(t.max)]));
      else if (t.k === 'char') this.assign(v, this.callRt('readchar', []));
      else if (t.k === 'int') this.assign(v, { n: 'cvt', e: this.callRt('readint', []), type: t, explicit: true });
      else if (t.k === 'real') this.assign(v, this.callRt('readreal', []));
      else this.err(`cannot read a value of type ${typeName(t)}`);
    }
    if (ln) this.genCall(this.mkRtCall('readlnend', []));
    if (file) { this.genCall(this.mkRtCall('textend', [])); this.genIoCheck(); }
  }

  genIncDec(v, amount) {
    const cls = this.clsOf(v.type), mt = this.mtOf(v.type);
    const d = this.lvalDesc(v);
    if (d.k === 'ind' || d.k === 'far') this.emit({ o: 'dup', s: d.k === 'far' ? 'L' : this.P });
    this.loadDesc(d, mt);
    this.emit({ o: 'lit', s: cls, v: Math.abs(amount) });
    this.emit({ o: amount < 0 ? 'sub' : 'add', s: cls, u: !this.signedOf(v.type) });
    this.storeDesc(d, mt);
  }

  // runtime helpers live in the System unit
  rtSym(name) {
    const sys = this.units.get('system');
    let s = sys ? sys.iface.syms.get('_' + name) : null;
    if (!s) s = this.lookup('_' + name);
    if (!s || s.kind !== 'proc') this.err(`internal: runtime routine _${name} missing in System`);
    return s;
  }
  mkRtCall(name, args) {
    const sym = this.rtSym(name);
    return this.checkCall(sym, args, this.tk.pos);
  }
  callRt(name, args) { return this.mkRtCall(name, args); }
  cint(v) { return { n: 'const', type: intTypeFor(v), v }; }

  // ------------------------------------------------------------ expressions
  parseExpr() {
    let l = this.parseSimple();
    for (;;) {
      const t = this.tk;
      if (t.k === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(t.v)) {
        this.next();
        const r = this.parseSimple();
        l = this.binop(t.v, l, r, t.pos);
      } else if (t.k === 'kw' && t.v === 'in') {
        this.next();
        const r = this.parseSimple();
        l = this.binop('in', l, r, t.pos);
      } else return l;
    }
  }
  parseSimple() {
    let l;
    const t0 = this.tk;
    if (t0.k === 'op' && (t0.v === '-' || t0.v === '+')) {
      this.next();
      const e = this.parseTerm();
      l = t0.v === '-' ? this.unop('neg', e, t0.pos) : e;
      if (t0.v === '+' && !isNumeric(e.type)) this.err('number expected');
    } else l = this.parseTerm();
    for (;;) {
      const t = this.tk;
      if ((t.k === 'op' && (t.v === '+' || t.v === '-')) || (t.k === 'kw' && (t.v === 'or' || t.v === 'xor'))) {
        this.next();
        const r = this.parseTerm();
        l = this.binop(t.v, l, r, t.pos);
      } else return l;
    }
  }
  parseTerm() {
    let l = this.parseFactor();
    for (;;) {
      const t = this.tk;
      if ((t.k === 'op' && (t.v === '*' || t.v === '/')) ||
          (t.k === 'kw' && ['div', 'mod', 'and', 'shl', 'shr'].includes(t.v))) {
        this.next();
        const r = this.parseFactor();
        l = this.binop(t.v, l, r, t.pos);
      } else return l;
    }
  }
  parseFactor() {
    const t = this.tk;
    if (this.isId('inherited') && !this.lookup('inherited')) return this.parseInherited(t.pos);
    switch (t.k) {
      case 'int': this.next(); return { n: 'const', type: intTypeFor(t.v), v: t.v };
      case 'real': this.next(); return { n: 'const', type: T.real, v: t.v };
      case 'str':
        this.next();
        if (t.v.length === 1) return { n: 'const', type: T.char, v: t.v.charCodeAt(0) };
        return { n: 'const', type: { k: 'string', max: Math.max(t.v.length, 1), size: t.v.length + 1, isConst: true }, v: t.v };
      case 'op':
        if (t.v === '(') {
          this.next();
          const e = this.parseExpr();
          this.expect(')');
          return this.parsePostfix(e);
        }
        if (t.v === '[') return this.parseSetCons();
        if (t.v === '@') {
          this.next();
          const ps = this.tk.k === 'id' && this.lookup(this.tk.v);
          if (ps && ps.kind === 'proc') {
            // @Routine: its address, an untyped pointer
            this.next();
            const v = this.procValue(ps, null, t.pos);
            return { ...v, type: { k: 'ptr', to: null, size: this.target.ptrSize } };
          }
          const e = this.parseDesignator();
          if (!e.lv) this.err('variable expected after @');
          return { n: 'addr', e, type: { k: 'ptr', to: e.type, size: this.target.ptrSize } };
        }
        if (t.v === '-' || t.v === '+') return this.parseSimple();
        break;
      case 'kw':
        if (t.v === 'not') {
          this.next();
          const e = this.parseFactor();
          return this.unop('not', e, t.pos);
        }
        if (t.v === 'nil') { this.next(); return { n: 'const', type: T.nil, v: 0 }; }
        if (t.v === 'string') {
          // string(x) typecast
          this.next();
          this.expect('(');
          const e = this.parseExpr();
          this.expect(')');
          return this.coerceStr(e);
        }
        break;
      case 'id': return this.parseDesignator(true);
    }
    this.err(`expression expected but ${this.desc(t)} found`);
  }

  coerceStr(e) {
    if (e.type.k === 'string') return e;
    if (e.type.k === 'char') return e.n === 'const' ? { n: 'const', type: { k: 'string', max: 1, size: 2, isConst: true }, v: String.fromCharCode(e.v) } : e;
    this.err('string expected');
  }

  parseSetCons() {
    this.expect('[');
    const elems = [];
    let allConst = true;
    let base = null;
    if (!this.is(']')) {
      do {
        const a = this.parseExpr();
        let b = null;
        if (this.accept('..')) b = this.parseExpr();
        if (!isOrdinal(a.type) || (b && !isOrdinal(b.type))) this.err('ordinal value expected in set');
        if (!base) base = a.type;
        if (a.n !== 'const' || (b && b.n !== 'const')) allConst = false;
        elems.push({ a, b });
      } while (this.accept(','));
    }
    this.expect(']');
    const type = { k: 'set', base: base || T.byte, size: 32 };
    if (allConst) {
      const ranges = elems.map(x => ({ lo: x.a.v, hi: x.b ? x.b.v : x.a.v }));
      for (const r of ranges) if (r.lo < 0 || r.hi > 255) this.err('set element out of range 0..255');
      return { n: 'setc', isConst: true, elems: ranges, type };
    }
    return { n: 'setc', isConst: false, items: elems, type };
  }

  // identifiers with postfix operators: calls, casts, fields, indexes, ^
  parseDesignator(inExpr = false) {
    const t = this.expectId();
    let sym = this.lookup(t.v);
    if (!sym) this.err(`unknown identifier '${t.raw}'`, t.pos);
    if (sym.kind === 'unit') {
      this.expect('.');
      const id = this.expectId();
      sym = sym.iface.syms.get(id.v);
      if (!sym) this.err(`'${id.raw}' not found in unit '${t.raw}'`, id.pos);
    }
    let e;
    switch (sym.kind) {
      case 'const': e = { n: 'const', type: sym.type, v: sym.v }; break;
      case 'var': e = { n: 'var', sym, type: sym.type, lv: true }; break;
      case 'withfield': e = { n: 'field', base: sym.w.base, f: sym.f, type: sym.f.type, lv: true }; break;
      case 'method':
        if (this.ctx && this.ctx.sym === sym.m.sym && inExpr === 'lhs') {
          e = { n: 'var', sym: this.ctx.resultSym, type: this.ctx.resultSym.type, lv: true };
          break;
        }
        e = this.methodCall(sym.w.base, sym.m, t.pos, false);
        break;
      case 'type': {
        if (sym.type.isObject && this.is('.') && this.ctx && this.ctx.method && this.isDescendant(this.ctx.method.obj, sym.type)) {
          // TAncestor.Method(args) inside a method: a static call with this Self
          this.next();
          const mid = this.expectId();
          const m = sym.type.methods.get(mid.v);
          if (!m) this.err(`'${mid.raw}' is not a method of ${t.raw}`, mid.pos);
          e = this.methodCall(this.ctx.selfBase, m, mid.pos, true);
          break;
        }
        if (!this.is('(')) this.err(`'${t.raw}' is a type; use it as Type(value)`, t.pos);
        this.next();
        const v = this.parseExpr();
        this.expect(')');
        e = this.typecast(v, sym.type, t.pos);
        break;
      }
      case 'proc': {
        if (this.wantProc && !(this.ctx && this.ctx.sym === sym && inExpr === 'lhs')) {
          e = this.procValue(sym, this.wantProc, t.pos);
          this.wantProc = null;
          break;
        }
        if (this.ctx && this.ctx.sym === sym && inExpr === 'lhs') {
          e = { n: 'var', sym: this.ctx.resultSym, type: this.ctx.resultSym.type, lv: true };
          break;
        }
        if (!sym.ret) {
          if (inExpr) this.err(`procedure '${sym.name}' does not return a value`, t.pos);
        }
        e = this.parseCallArgs(sym, t.pos);
        break;
      }
      case 'bfunc': e = this.builtinFunc(sym.name, t.pos); break;
      case 'memarr': {
        this.expect('[');
        const a = this.parseExpr();
        this.expect(']');
        if (!isInt(a.type)) this.err('address must be an integer');
        e = { n: 'mem', mt: sym.mt, addr: a, type: sym.type, lv: true };
        break;
      }
      case 'bproc':
        if (sym.name === 'new' && this.is('(')) {
          this.next();
          const pt = this.parseTypeIdent();
          if (pt.k !== 'ptr' || !pt.to || !pt.to.isObject) this.err('a pointer type to an object expected', t.pos);
          this.expect(',');
          const mid = this.expectId();
          const m = pt.to.methods.get(mid.v);
          if (!m || m.kind !== 'constructor') this.err('a constructor expected', mid.pos);
          const tv = this.tempVar(pt);
          const tmp = { n: 'var', sym: tv, type: pt, lv: true };
          const ctor = this.methodCall({ n: 'deref', ptr: tmp, type: pt.to, lv: true }, m, mid.pos, true, true);
          this.expect(')');
          e = { n: 'newobj', ptype: pt, tmp, ctor, type: pt };
          break;
        }
        this.err(`'${t.raw}' is a procedure and has no value`, t.pos);
      default: this.err(`'${t.raw}' cannot be used here`, t.pos);
    }
    return this.parsePostfix(e);
  }

  // a global routine as a procedural value (t: the type expected, or null)
  procValue(sym, t, pos) {
    if (sym.level !== 1 || sym.external || sym.procType) this.err(`'${sym.name}' cannot be used as a procedural value (only routines of the program or a unit, not nested ones)`, pos);
    if (t && (!this.sameParams(sym.params, t.params) || !!sym.ret !== !!t.ret || (t.ret && !sameType(sym.ret, t.ret))))
      this.err(`'${sym.name}' does not fit ${typeName(t)}`, pos);
    return { n: 'procaddr', sym, type: t || { k: 'proc', params: sym.params, ret: sym.ret, size: this.target.ptrSize } };
  }

  // p(args): a call through a procedural value
  parseIndirectCall(fn, pos) {
    const pt = fn.type;
    const args = [];
    if (this.accept('(')) {
      if (!this.is(')')) {
        let i = 0;
        do {
          const want = pt.params[i] && pt.params[i].type.k === 'proc' ? pt.params[i].type : null;
          this.wantProc = want;
          args.push(this.parseExpr());
          this.wantProc = null;
          i++;
        } while (this.accept(','));
      }
      this.expect(')');
    }
    const c = this.checkCall(pt.sym, args, pos);
    return { ...c, n: 'call', fn, type: pt.ret || T.void };
  }

  // o.Method(args) (Self = o); virtual ones through the VMT unless static
  methodCall(obj, m, pos, isStatic, linkVmt) {
    const sym = m.sym;
    const user = sym.params.slice(0, -1);
    const args = [];
    if (this.accept('(')) {
      if (!this.is(')')) {
        do {
          const p = user.filter(q => !q.hiddenHigh)[args.length];
          this.wantProc = p && p.type.k === 'proc' ? p.type : null;
          args.push(this.parseExpr());
          this.wantProc = null;
        } while (this.accept(','));
      }
      this.expect(')');
    }
    if (!obj.lv) this.err('object variable expected', pos);
    const c = this.checkCall(sym, [...args, obj], pos);
    if (m.virtual && !isStatic) c.virt = { obj, slot: m.slot, vmtOff: m.obj.vmtOff };
    // o.Init(...), New(p, Init): the object gets its type's VMT before the
    // constructor runs (an inherited constructor leaves it as it is)
    if (linkVmt && m.kind === 'constructor' && obj.type.vmtOff >= 0) c.linkVmt = { obj, ot: obj.type };
    return c;
  }
  // inherited Name(args) inside a method
  parseInherited(pos) {
    this.next();
    const ctx = this.ctx;
    if (!ctx || !ctx.method) this.err('inherited outside a method', pos);
    const parent = ctx.method.obj.parent;
    const id = this.expectId();
    const m = parent && parent.methods.get(id.v);
    if (!m) this.err(`no inherited method '${id.raw}'`, id.pos);
    return this.methodCall(ctx.selfBase, m, pos, true);
  }

  parsePostfix(e) {
    for (;;) {
      if (e.type && e.type.k === 'proc' && e.n !== 'procaddr' && this.is('(')) { e = this.parseIndirectCall(e, this.tk.pos); continue; }
      const t = this.tk;
      if (t.k !== 'op') return e;
      if (t.v === '^') {
        this.next();
        if (e.type.k !== 'ptr' || !e.type.to) this.err('typed pointer expected before ^', t.pos);
        e = { n: 'deref', ptr: e, type: e.type.to, lv: true };
      } else if (t.v === '[') {
        this.next();
        do {
          const idx = this.parseExpr();
          if (e.type.k === 'string') {
            if (!isOrdinal(idx.type)) this.err('index must be ordinal');
            e = { n: 'index', base: e, idx, type: T.char, lv: e.lv, lo: 0, hi: e.type.max, esz: 1 };
          } else if (e.type.k === 'array') {
            this.checkIndex(e.type, idx, t.pos);
            e = { n: 'index', base: e, idx, type: e.type.elem, lv: e.lv, lo: e.type.lo, hi: e.type.hi, esz: e.type.elem.size };
          } else if (e.type.k === 'openarray') {
            if (!isInt(idx.type) && !isOrdinal(idx.type)) this.err('index must be ordinal');
            const h = e.n === 'var' && this.lookup(e.sym.name + '$high');
            e = { n: 'index', base: e, idx, type: e.type.elem, lv: e.lv, lo: 0, esz: e.type.elem.size, hiSym: h || undefined };
          } else if (e.type.k === 'ptr' && e.type.to) {
            // p[i] on typed pointers (pointer arithmetic)
            if (!isInt(idx.type)) this.err('integer index expected');
            e = { n: 'index', base: { n: 'deref', ptr: e, type: e.type.to, lv: true }, idx, type: e.type.to, lv: true, lo: 0, esz: e.type.to.size };
          } else this.err('array expected before [', t.pos);
        } while (this.accept(','));
        this.expect(']');
      } else if (t.v === '.') {
        if (e.type.k !== 'record') return e;
        this.next();
        const id = this.expectId();
        const f = e.type.fields.find(f => f.name === id.v);
        if (!f && e.type.isObject && e.type.methods.has(id.v)) { e = this.methodCall(e, e.type.methods.get(id.v), id.pos, false, true); continue; }
        if (!f) this.err(`unknown field '${id.raw}'`, id.pos);
        e = { n: 'field', base: e, f, type: f.type, lv: e.lv };
      } else return e;
    }
  }

  checkIndex(at, idx, pos) {
    if (!isOrdinal(idx.type)) this.err('index must be ordinal', pos);
    const ix = at.idx;
    if (ix.k === 'enum' && idx.type.k === 'enum' && (ix.base || ix) !== (idx.type.base || idx.type)) this.err('wrong index type', pos);
    if ((ix.k === 'char') !== (idx.type.k === 'char')) this.err(`index type mismatch: ${typeName(ix)} expected`, pos);
    if (idx.n === 'const' && (idx.v < at.lo || idx.v > at.hi)) this.err(`index ${idx.v} out of range ${at.lo}..${at.hi}`, pos);
  }

  typecast(v, type, pos) {
    if (isOrdinal(type) || isPtr(type) || type.k === 'real') {
      if (v.n === 'const' && isOrdinal(type) && isOrdinal(v.type)) {
        return { n: 'const', type, v: type.k === 'int' ? wrapTo(v.v, type) : v.v & ((1 << (8 * type.size)) - 1 || 0xffffffff) };
      }
      if (type.k === 'real' && isNumeric(v.type)) return this.conv(v, T.real);
      if (!isScalar(v.type)) {
        if (v.lv && v.type.size === type.size) return { n: 'retype', e: v, type, lv: true };
        this.err(`invalid type cast from ${typeName(v.type)} to ${typeName(type)}`, pos);
      }
      if (v.type.k === 'real' && type.k !== 'real') {
        if (v.lv && type.size === 4) return { n: 'retype', e: v, type, lv: true };
        this.err('use Trunc or Round to convert a real to an integer', pos);
      }
      if (v.lv && v.type.size === type.size) return { n: 'retype', e: v, type, lv: true };
      return { n: 'cvt', e: v, type, explicit: true };
    }
    if (v.lv && v.type.size === type.size) return { n: 'retype', e: v, type, lv: true };
    if (v.lv && (type.k === 'record' || type.k === 'array')) return { n: 'retype', e: v, type, lv: true };
    this.err(`invalid type cast to ${typeName(type)}`, pos);
  }

  builtinFunc(name, pos) {
    const args = [];
    if (this.accept('(')) {
      if (!this.is(')')) {
        do {
          if (['sizeof', 'low', 'high'].includes(name) && this.tk.k === 'id') {
            const s = this.lookup(this.tk.v);
            if (s && s.kind === 'type' && !(this.peekTok().k === 'op' && this.peekTok().v === '(')) {
              this.next(); args.push({ n: 'typeref', type: s.type }); continue;
            }
          }
          if (name === 'sizeof' && this.is('string')) { this.next(); args.push({ n: 'typeref', type: T.string }); continue; }
          args.push(this.parseExpr());
        } while (this.accept(','));
      }
      this.expect(')');
    }
    const need = (n) => { if (args.length !== n) this.err(`${name} expects ${n} argument${n === 1 ? '' : 's'}`, pos); };
    const a = args[0];
    switch (name) {
      case 'ord': {
        need(1);
        if (!isOrdinal(a.type)) this.err('ordinal expected', pos);
        if (a.n === 'const') return { n: 'const', type: intTypeFor(a.v), v: a.v };
        const rt = a.type.k === 'int' ? (a.type.size === 4 ? a.type : (a.type.size === 1 ? (a.type.signed ? T.integer : T.word) : a.type)) : (a.type.size === 2 ? T.word : T.byte);
        return { n: 'cvt', e: a, type: rt.k === 'int' && rt.size === 1 ? T.integer : rt };
      }
      case 'chr':
        need(1);
        if (!isInt(a.type)) this.err('integer expected', pos);
        if (a.n === 'const') return { n: 'const', type: T.char, v: a.v & 255 };
        return { n: 'cvt', e: a, type: T.char, explicit: true };
      case 'succ': case 'pred': {
        need(1);
        if (!isOrdinal(a.type)) this.err('ordinal expected', pos);
        const r = this.binop(name === 'succ' ? '+' : '-', { n: 'cvt', e: a, type: a.type.k === 'int' ? a.type : T.integer }, this.cint(1), pos);
        if (r.n === 'const') return { n: 'const', type: a.type, v: r.v };
        return { n: 'cvt', e: r, type: a.type, explicit: true };
      }
      case 'low': case 'high': {
        need(1);
        const t = a.n === 'typeref' ? a.type : a.type;
        if (t.k === 'openarray') return name === 'low' ? this.cint(0) : this.openHigh(a);
        if (t.k === 'array') return { n: 'const', type: t.idx.k === 'int' ? intTypeFor(t.lo) : t.idx, v: name === 'low' ? t.lo : t.hi };
        if (t.k === 'string') return { n: 'const', type: T.integer, v: name === 'low' ? 0 : t.max };
        if (isOrdinal(t)) return { n: 'const', type: t.k === 'int' ? intTypeFor(name === 'low' ? t.lo : t.hi) : t, v: name === 'low' ? t.lo : t.hi };
        this.err('ordinal type, array or string expected', pos);
      }
      case 'sizeof': {
        need(1);
        if (a.type.k === 'openarray')
          return this.binop('*', this.binop('+', this.openHigh(a), this.cint(1), pos), this.cint(a.type.elem.size), pos);
        return this.cint(a.type.size);
      }
      case 'length': {
        need(1);
        if (a.type.k === 'char') return this.cint(1);
        if (a.type.k !== 'string') this.err('string expected', pos);
        if (a.n === 'const') return this.cint(a.v.length);
        return { n: 'strlen', e: a, type: T.byte };
      }
      case 'abs': {
        need(1);
        if (a.n === 'const') return { n: 'const', type: a.type, v: Math.abs(a.v) };
        if (isReal(a.type)) return this.callRt('absreal', [a]);
        if (!isInt(a.type)) this.err('number expected', pos);
        if (a.type.size === 4) return this.callRt('abslong', [a]);
        return { n: 'cvt', e: this.callRt('absint', [this.conv(a, T.integer)]), type: T.integer };
      }
      case 'sqr': {
        need(1);
        if (isReal(a.type)) return this.callRt('mulreal', [a, a]);
        return this.binop('*', a, a, pos);
      }
      case 'odd':
        need(1);
        if (!isInt(a.type)) this.err('integer expected', pos);
        if (a.n === 'const') return { n: 'const', type: T.boolean, v: a.v & 1 };
        return { n: 'cvt', e: this.binop('and', a, this.cint(1), pos), type: T.boolean, explicit: true };
      case 'hi': case 'lo': {
        need(1);
        if (!isOrdinal(a.type)) this.err('ordinal expected', pos);
        if (a.type.size === 4) {
          const r = name === 'hi' ? this.binop('shr', a, this.cint(16), pos) : this.binop('and', a, { n: 'const', type: T.longint, v: 0xffff }, pos);
          return { n: 'cvt', e: r, type: T.word, explicit: true };
        }
        const w = { n: 'cvt', e: a, type: T.word, explicit: a.type.k !== 'int' };
        const r = name === 'hi' ? this.binop('shr', w, this.cint(8), pos) : this.binop('and', w, this.cint(255), pos);
        return { n: 'cvt', e: r, type: T.byte, explicit: true };
      }
      case 'swap': {
        need(1);
        const w = { n: 'cvt', e: a, type: T.word, explicit: true };
        return { n: 'cvt', e: this.binop('or', this.binop('shl', this.binop('and', w, this.cint(255)), this.cint(8)), this.binop('shr', w, this.cint(8))), type: a.type.k === 'int' && a.type.size === 2 ? a.type : T.word, explicit: true };
      }
      case 'trunc': case 'round': case 'int': case 'frac': {
        need(1);
        if (isInt(a.type)) return name === 'frac' ? { n: 'const', type: T.real, v: 0 } : (name === 'int' ? this.conv(a, T.real) : this.conv(a, T.longint));
        if (!isReal(a.type)) this.err('real expected', pos);
        if (a.n === 'const') {
          const v = name === 'trunc' ? Math.trunc(a.v) : name === 'round' ? Math.sign(a.v) * Math.round(Math.abs(a.v)) : name === 'int' ? Math.trunc(a.v) : a.v - Math.trunc(a.v);
          return { n: 'const', type: name === 'trunc' || name === 'round' ? T.longint : T.real, v };
        }
        return this.callRt(name + 'real', [a]);
      }
      case 'sqrt': need(1); return this.callRt('sqrtreal', [this.conv(a, T.real)]);
      case 'assigned':
        need(1);
        if (!isPtr(a.type) && a.type.k !== 'proc') this.err('pointer expected', pos);
        return this.binop('<>', a, { n: 'const', type: T.nil, v: 0 }, pos);
      case 'concat': {
        if (!args.length) this.err('concat needs arguments', pos);
        let r = this.coerceStr(args[0]);
        for (let i = 1; i < args.length; i++) r = this.binop('+', r, args[i], pos);
        return r;
      }
      case 'addr':
        need(1);
        if (!a.lv) this.err('variable expected', pos);
        return { n: 'addr', e: a, type: this.ptrT };
      case 'ptr': {
        // Ptr(seg, ofs) is DOS-specific; Ptr(address) gives a pointer
        need(1);
        return { n: 'cvt', e: a, type: this.ptrT, explicit: true };
      }
    }
    this.err(`'${name}' cannot be used here`, pos);
  }

  parseCallArgs(sym, pos) {
    const args = [];
    const user = (sym.params || []).filter(p => !p.hiddenHigh);
    if (this.accept('(')) {
      if (!this.is(')')) {
        do {
          const p = user[args.length];
          this.wantProc = p && p.type.k === 'proc' ? p.type : null;
          args.push(this.parseExpr());
          this.wantProc = null;
        } while (this.accept(','));
      }
      this.expect(')');
    }
    return this.checkCall(sym, args, pos);
  }

  checkCall(sym, args, pos) {
    const nUser = sym.params.filter(p => !p.hiddenHigh).length;
    if (args.length !== nUser) this.err(`wrong number of arguments for '${sym.name}': ${nUser} expected, ${args.length} given`, pos);
    const out = [];
    let k = 0;
    sym.params.forEach((p) => {
      if (p.hiddenHigh) { out.push(this.openHigh(out[out.length - 1])); return; }
      const i = k++;
      let a = args[i];
      if (p.type.k === 'openarray') {
        const at = a.type;
        const el = at.k === 'array' ? at.elem : at.k === 'openarray' ? at.elem : null;
        if (!a.lv || !el || !(el === p.type.elem || (sameType(el, p.type.elem) && el.size === p.type.elem.size)))
          this.err(`argument ${i + 1} of '${sym.name}': an array of ${typeName(p.type.elem)} expected`, pos);
        out.push(a);
        return;
      }
      if (p.mode === 'var') {
        if (!a.lv) this.err(`argument ${i + 1} of '${sym.name}' must be a variable`, pos);
        if (p.type.k !== 'untyped' && !this.varCompat(p.type, a.type)) this.err(`argument ${i + 1} of '${sym.name}': ${typeName(p.type)} expected, ${typeName(a.type)} found`, pos);
      } else if (p.type.k === 'untyped') {
        if (!a.lv) this.err(`argument ${i + 1} of '${sym.name}' must be a variable`, pos);
      } else {
        a = this.convAssign(p.type, a, pos, `argument ${i + 1} of '${sym.name}'`);
      }
      out.push(a);
    });
    return { n: 'call', proc: sym, args: out, type: sym.ret || T.void };
  }

  // the last index of an array passed to an open array parameter
  openHigh(a) {
    if (a.type.k === 'array') return this.cint(a.type.hi - a.type.lo);
    const h = a.n === 'var' && this.lookup(a.sym.name + '$high');
    if (!h) this.err('open array expected');
    return { n: 'var', sym: h, type: T.integer, lv: true };
  }

  varCompat(pt, at) {
    if (pt === at) return true;
    if (pt.isObject && at.isObject && this.isDescendant(at, pt)) return true;
    if (pt.k === 'record' && at.k === 'record' && at.fileOf !== undefined && pt === this.fileRec()) return true;
    if (pt.k === 'string' && at.k === 'string') return true;
    if (pt.k === 'ptr' && at.k === 'ptr') return !pt.to || !at.to || pt.to === at.to;
    if (pt.k === 'array' || pt.k === 'record' || pt.k === 'set') return pt === at || (pt.k === at.k && pt.size === at.size && pt.k !== 'record');
    return sameType(pt, at) && pt.size === at.size;
  }

  // --- type rules ---
  checkBool(e) { if (e.type.k !== 'bool') this.err(`boolean expression expected, ${typeName(e.type)} found`); }

  checkAssignable(dt, e, pos, what = 'assignment') {
    const st = e.type;
    const bad = () => this.err(`incompatible types in ${what}: ${typeName(dt)} expected, ${typeName(st)} found`, pos);
    if (dt.k === 'int') {
      if (st.k !== 'int') bad();
      if (e.n === 'const' && !fitsType(e.v, dt)) this.err(`constant ${e.v} out of range for ${typeName(dt)}`, pos);
      return;
    }
    if (dt.k === 'real') { if (!isNumeric(st)) bad(); return; }
    if (dt.k === 'char') {
      if (st.k !== 'char') bad();
      return;
    }
    if (dt.k === 'bool') { if (st.k !== 'bool') bad(); return; }
    if (dt.k === 'ptr' && st.k === 'ptr' && dt.to && st.to && dt.to.isObject && st.to.isObject && this.isDescendant(st.to, dt.to)) return;
    if (dt.isObject && st.isObject && this.isDescendant(st, dt)) return;
    if (dt.k === 'proc') {
      if (st.k === 'nil' || (st.k === 'ptr' && !st.to)) return;
      if (st.k !== 'proc' || !this.sameParams(dt.params, st.params) || !!dt.ret !== !!st.ret) bad();
      return;
    }
    if (dt.k === 'enum') { if (st.k !== 'enum' || (st.base || st) !== (dt.base || dt)) bad(); return; }
    if (dt.k === 'string') { if (st.k !== 'string' && st.k !== 'char') bad(); return; }
    if (dt.k === 'ptr') {
      if (st.k === 'nil') return;
      if (st.k !== 'ptr') bad();
      if (dt.to && st.to && dt.to !== st.to && !sameType(dt.to, st.to)) bad();
      return;
    }
    if (dt.k === 'set') { if (st.k !== 'set') bad(); return; }
    if (dt.k === 'array' || dt.k === 'record') { if (dt !== st && !(dt.size === st.size && e.n === 'retype')) bad(); return; }
    bad();
  }

  convAssign(dt, e, pos, what) {
    this.checkAssignable(dt, e, pos, what);
    if (isScalar(dt)) return this.conv(e, dt);
    return e;
  }

  // implicit conversion of a scalar to another scalar type
  conv(e, t) {
    if (e.type === t) return e;
    if (e.n === 'const') {
      if (t.k === 'real' && isNumeric(e.type)) return { n: 'const', type: T.real, v: e.v };
      if (isOrdinal(t) && isOrdinal(e.type)) return { n: 'const', type: t, v: e.v };
      if (isPtr(t) && e.type.k === 'nil') return { n: 'const', type: t, v: 0 };
    }
    if (t.k === 'real' && e.type.k === 'real') return e;
    if (isScalar(t)) return { n: 'cvt', e, type: t };
    return e;
  }

  // integer result type for an arithmetic operation
  intResult(l, r) {
    const a = l.type, b = r.type;
    if (l.n === 'const' && r.n !== 'const') {
      const pb = b.size === 1 ? (b.signed ? T.integer : T.word) : b;
      if (fitsType(l.v, pb)) return pb;
    }
    if (r.n === 'const' && l.n !== 'const') {
      const pa = a.size === 1 ? (a.signed ? T.integer : T.word) : a;
      if (fitsType(r.v, pa)) return pa;
    }
    if (a.size === 4 || b.size === 4) {
      if (a.size === 4 && b.size === 4 && !a.signed && !b.signed) return T.longword;
      if ((a.size === 4 && !a.signed && b.size < 4 && !b.signed) || (b.size === 4 && !b.signed && a.size < 4 && !a.signed)) return T.longword;
      return T.longint;
    }
    if (!a.signed && !b.signed) return T.word;
    if (a.signed && b.signed) return T.integer;
    const u = a.signed ? b : a;
    return u.size === 1 ? T.integer : T.longint;
  }

  foldInt(op, a, b) {
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case 'div': if (b === 0) this.err('division by zero'); return Math.trunc(a / b);
      case 'mod': if (b === 0) this.err('division by zero'); return a % b;
      case 'and': return Number(BigInt.asIntN(64, BigInt(a) & BigInt(b)));
      case 'or': return Number(BigInt.asIntN(64, BigInt(a) | BigInt(b)));
      case 'xor': return Number(BigInt.asIntN(64, BigInt(a) ^ BigInt(b)));
      case 'shl': return Number(BigInt.asUintN(32, BigInt(a) << BigInt(b)));
      case 'shr': return Number(BigInt.asUintN(32, BigInt(a >>> 0) >> BigInt(b)));
    }
  }

  unop(op, e, pos) {
    if (op === 'neg') {
      if (isReal(e.type)) {
        if (e.n === 'const') return { n: 'const', type: T.real, v: -e.v };
        return { n: 'un', op: 'rneg', e, type: T.real };
      }
      if (!isInt(e.type)) this.err('number expected', pos);
      if (e.n === 'const') return { n: 'const', type: intTypeFor(-e.v), v: -e.v };
      const t = e.type.size === 4 ? T.longint : (e.type.size === 2 && !e.type.signed ? T.longint : T.integer);
      return { n: 'un', op: 'neg', e: this.conv(e, t), type: t };
    }
    // not
    if (e.type.k === 'bool') {
      if (e.n === 'const') return { n: 'const', type: T.boolean, v: e.v ? 0 : 1 };
      return { n: 'un', op: 'lnot', e, type: T.boolean };
    }
    if (!isInt(e.type)) this.err('boolean or integer expected after not', pos);
    if (e.n === 'const') return { n: 'const', type: e.type, v: wrapTo(~e.v, e.type.size < 2 ? T.integer : e.type) };
    const t = e.type.size === 1 ? (e.type.signed ? T.integer : T.word) : e.type;
    return { n: 'un', op: 'not', e: this.conv(e, t), type: t };
  }

  binop(op, l, r, pos) {
    const lt = l.type, rt = r.type;
    const rel = ['=', '<>', '<', '<=', '>', '>='].includes(op);
    // ---- sets
    if (op === 'in') {
      if (rt.k !== 'set' || !isOrdinal(lt)) this.err('ordinal in set expected', pos);
      return { n: 'in', l, r, type: T.boolean };
    }
    if (lt.k === 'set' || rt.k === 'set') {
      if (lt.k !== 'set' || rt.k !== 'set') this.err('set operands expected', pos);
      if (op === '+' || op === '-' || op === '*') return { n: 'setop', op, l, r, type: lt };
      if (['=', '<>', '<=', '>='].includes(op)) return { n: 'setcmp', op, l, r, type: T.boolean };
      this.err(`operator ${op} not allowed on sets`, pos);
    }
    // ---- strings
    if ((lt.k === 'string' || rt.k === 'string') || (op === '+' && lt.k === 'char' && rt.k === 'char')) {
      if (!(lt.k === 'string' || lt.k === 'char') || !(rt.k === 'string' || rt.k === 'char')) this.err(`string operands expected for ${op}`, pos);
      if (op === '+') {
        if (l.n === 'const' && r.n === 'const') {
          const s = (lt.k === 'char' ? String.fromCharCode(l.v) : l.v) + (rt.k === 'char' ? String.fromCharCode(r.v) : r.v);
          if (s.length > 255) this.err('string constant too long');
          return { n: 'const', type: { k: 'string', max: Math.max(s.length, 1), size: s.length + 1, isConst: true }, v: s };
        }
        return { n: 'concat', parts: [...(l.n === 'concat' ? l.parts : [l]), r], type: T.string };
      }
      if (rel) return { n: 'strcmp', op, l, r, type: T.boolean };
      this.err(`operator ${op} not allowed on strings`, pos);
    }
    // ---- booleans
    if (lt.k === 'bool' && rt.k === 'bool' && ['and', 'or', 'xor'].includes(op)) {
      if (l.n === 'const' && r.n === 'const') return { n: 'const', type: T.boolean, v: this.foldInt(op, l.v, r.v) & 1 };
      return { n: 'bin', op, l, r, type: T.boolean, ot: T.boolean };
    }
    // ---- relational
    if (rel) {
      if (isNumeric(lt) && isNumeric(rt)) {
        if (isReal(lt) || isReal(rt)) {
          if (l.n === 'const' && r.n === 'const') return { n: 'const', type: T.boolean, v: this.foldRel(op, l.v, r.v) };
          return { n: 'rcmp', op, l: this.conv(l, T.real), r: this.conv(r, T.real), type: T.boolean };
        }
        const ot = this.intResult(l, r);
        if (l.n === 'const' && r.n === 'const') return { n: 'const', type: T.boolean, v: this.foldRel(op, l.v, r.v) };
        return { n: 'bin', op, l: this.conv(l, ot), r: this.conv(r, ot), type: T.boolean, ot };
      }
      if (isOrdinal(lt) && isOrdinal(rt)) {
        if (lt.k !== rt.k || (lt.k === 'enum' && (lt.base || lt) !== (rt.base || rt))) this.err(`incompatible types: ${typeName(lt)} and ${typeName(rt)}`, pos);
        if (l.n === 'const' && r.n === 'const') return { n: 'const', type: T.boolean, v: this.foldRel(op, l.v, r.v) };
        const ot = lt.size === 2 || rt.size === 2 ? T.word : T.byte;
        return { n: 'bin', op, l: this.conv(l, ot), r: this.conv(r, ot), type: T.boolean, ot };
      }
      if (isPtr(lt) && isPtr(rt)) {
        if (op !== '=' && op !== '<>') this.err('pointers can only be compared with = and <>', pos);
        const ot = this.target.ptrSize === 2 ? T.word : T.longword;
        return { n: 'bin', op, l: { n: 'cvt', e: l, type: ot, explicit: true }, r: { n: 'cvt', e: r, type: ot, explicit: true }, type: T.boolean, ot };
      }
      this.err(`cannot compare ${typeName(lt)} with ${typeName(rt)}`, pos);
    }
    // ---- arithmetic
    if (op === '/' || ((isReal(lt) || isReal(rt)) && ['+', '-', '*'].includes(op))) {
      if (!isNumeric(lt) || !isNumeric(rt)) this.err(`numbers expected for ${op}`, pos);
      if (l.n === 'const' && r.n === 'const') {
        if (op === '/' && r.v === 0) this.err('division by zero', pos);
        const v = op === '+' ? l.v + r.v : op === '-' ? l.v - r.v : op === '*' ? l.v * r.v : l.v / r.v;
        return { n: 'const', type: T.real, v };
      }
      return { n: 'rbin', op, l: this.conv(l, T.real), r: this.conv(r, T.real), type: T.real };
    }
    if (!isInt(lt) || !isInt(rt)) {
      if (isReal(lt) || isReal(rt)) this.err(`operator ${op} needs integers`, pos);
      this.err(`integer operands expected for ${op}, found ${typeName(lt)} and ${typeName(rt)}`, pos);
    }
    if (op === 'shl' || op === 'shr') {
      const t = lt.size === 1 ? (lt.signed ? T.integer : T.word) : lt;
      if (l.n === 'const' && r.n === 'const') { const v = this.foldInt(op, l.v, r.v); return { n: 'const', type: intTypeFor(wrapTo(v, T.longint)), v: wrapTo(v, T.longint) }; }
      return { n: 'bin', op, l: this.conv(l, t), r: this.conv(r, T.integer), type: t, ot: t };
    }
    const ot = this.intResult(l, r);
    if (l.n === 'const' && r.n === 'const') {
      const v = this.foldInt(op, l.v, r.v);
      return { n: 'const', type: intTypeFor(v), v };
    }
    return { n: 'bin', op, l: this.conv(l, ot), r: this.conv(r, ot), type: ot, ot };
  }

  foldRel(op, a, b) {
    switch (op) {
      case '=': return a === b ? 1 : 0;
      case '<>': return a !== b ? 1 : 0;
      case '<': return a < b ? 1 : 0;
      case '<=': return a <= b ? 1 : 0;
      case '>': return a > b ? 1 : 0;
      case '>=': return a >= b ? 1 : 0;
    }
  }

  // ================================================================ codegen
  assign(lhs, rhs, pos) {
    if (!lhs.lv) this.err('cannot assign to this expression', pos);
    if (lhs.n === 'var' && lhs.sym.isConst) this.err('cannot assign to a const parameter', pos);
    const dt = lhs.type;
    this.checkAssignable(dt, rhs, pos);
    if (dt.k === 'string') {
      const call = this.mkRtCall('strasg', [lhs, rhs, this.cint(dt.max)]);
      this.genCall(call);
      return;
    }
    if (dt.k === 'array' || dt.k === 'record') {
      if (!rhs.lv) this.err('variable expected on the right side', pos);
      this.genAddr(lhs);
      this.genAddr(rhs);
      this.emit({ o: 'copy', n: dt.size });
      return;
    }
    if (dt.k === 'set') {
      this.genAddr(lhs);
      this.genSet(rhs);
      this.emit({ o: 'copy', n: 32 });
      return;
    }
    const mt = this.mtOf(dt);
    const d = this.lvalDesc(lhs);
    if (this.sw.R && isOrdinal(dt) && isOrdinal(rhs.type) && rhs.n !== 'const' &&
        (rhs.type.lo < dt.lo || rhs.type.hi > dt.hi)) {
      // {$R+}: the value within the range of the variable's type
      this.genValue(rhs);
      this.genRangeCheck(dt.lo, dt.hi, this.clsOf(rhs.type), !this.signedOf(rhs.type), 201);
      this.genValue({ n: 'cvt', e: { n: 'onstack', type: rhs.type }, type: dt, explicit: true });
    } else this.genValue(this.conv(rhs, dt));
    this.storeDesc(d, mt);
  }

  // address of an lvalue as a descriptor. ind/far emit their address now.
  lvalDesc(e) {
    switch (e.n) {
      case 'var': {
        const l = e.sym.loc;
        if (l.k === 'global') return l.addr !== undefined ? { k: 'glob', g: l.addr, off: 0 } : { k: 'glob', g: l.label, off: 0 };
        const hops = this.ctx.level - l.lvl;
        if (l.byRef) {
          this.emit({ o: 'ldl', hops, off: l.off, kind: 'par', mt: this.mtOf(this.ptrT) });
          return { k: 'ind', off: 0 };
        }
        return { k: 'loc', hops, off: l.off, kind: l.k === 'param' ? 'par' : 'loc' };
      }
      case 'retype': return this.lvalDesc(e.e);
      case 'field': {
        const d = this.lvalDesc(e.base);
        d.off += e.f.off;
        return d;
      }
      case 'index': {
        if (e.idx.n === 'const') {
          const d = this.lvalDesc(e.base);
          d.off += (e.idx.v - e.lo) * e.esz;
          return d;
        }
        const d = this.lvalDesc(e.base);
        let off = 0;
        if (d.k === 'loc') this.emit({ o: 'laddr', hops: d.hops, off: d.off, kind: d.kind });
        else if (d.k === 'glob') this.emit({ o: 'gaddr', g: d.g, off: d.off });
        else if (d.k === 'ind') off = d.off;
        else this.err('cannot index this');
        // index -> pointer-sized, scaled
        let ie = e.idx;
        if (ie.type.k !== 'int') ie = { n: 'cvt', e: ie, type: T.word, explicit: true };
        const P = this.P;
        // {$R+}: the index within the bounds (pointer indexing has none)
        const chk = this.sw.R && e.hi !== undefined;
        if (P === 'W') {
          this.genValue(ie);
          if (chk) this.genRangeCheck(e.lo, e.hi, this.clsOf(ie.type), !this.signedOf(ie.type), 201);
          if (this.clsOf(ie.type) === 'L') this.emit({ o: 'trunc', mt: 'u16' });
          if (this.sw.R && e.hiSym) this.genOpenCheck(e.hiSym, 'W');
        } else {
          this.genValue(this.conv(ie, T.longint));
          if (chk) this.genRangeCheck(e.lo, e.hi, 'L', false, 201);
          if (this.sw.R && e.hiSym) this.genOpenCheck(e.hiSym, 'L');
        }
        if (e.esz !== 1) this.genMulConst(e.esz, P);
        this.emit({ o: 'add', s: P, u: true });
        return { k: 'ind', off: off - e.lo * e.esz };
      }
      case 'deref': {
        this.genValue(e.ptr);
        return { k: 'ind', off: 0 };
      }
      case 'mem': {
        if (e.addr.n === 'const') return { k: 'abs', a: e.addr.v >>> 0, off: 0 };
        this.genValue(this.conv(e.addr, T.longint));
        return { k: 'far', off: 0 };
      }
      case 'call':
        if (e.type.k === 'string') {
          this.genStr(e);
          return { k: 'ind', off: 0 };
        }
    }
    this.err('variable expected');
  }

  genMulConst(n, cls) {
    if ((n & (n - 1)) === 0) {
      const sh = Math.log2(n);
      this.emit({ o: 'lit', s: 'W', v: sh });
      this.emit({ o: 'shl', s: cls, u: true });
    } else {
      this.emit({ o: 'lit', s: cls, v: n });
      this.emit({ o: 'mul', s: cls, u: true });
    }
  }

  loadDesc(d, mt) {
    switch (d.k) {
      case 'loc': this.emit({ o: 'ldl', hops: d.hops, off: d.off, kind: d.kind, mt }); break;
      case 'glob': this.emit({ o: 'ldg', g: d.g, off: d.off, mt }); break;
      case 'ind': this.emit({ o: 'ld', off: d.off, mt }); break;
      case 'abs': this.emit({ o: 'ldabs', a: d.a + d.off, mt }); break;
      case 'far': this.emit({ o: 'ldfar', off: d.off, mt }); break;
    }
  }
  storeDesc(d, mt) {
    switch (d.k) {
      case 'loc': this.emit({ o: 'stl', hops: d.hops, off: d.off, kind: d.kind, mt }); break;
      case 'glob': this.emit({ o: 'stg', g: d.g, off: d.off, mt }); break;
      case 'ind': this.emit({ o: 'st', off: d.off, mt }); break;
      case 'abs': this.emit({ o: 'stabs', a: d.a + d.off, mt }); break;
      case 'far': this.emit({ o: 'stfar', off: d.off, mt }); break;
    }
  }

  genAddr(e) {
    if (e.n === 'const' && e.type.k === 'string') { this.genStr(e); return; }
    if (e.n === 'setc') { this.genSet(e); return; }
    if (!e.lv && !(e.n === 'call')) this.err('variable expected');
    const d = this.lvalDesc(e);
    switch (d.k) {
      case 'loc': this.emit({ o: 'laddr', hops: d.hops, off: d.off, kind: d.kind }); break;
      case 'glob': this.emit({ o: 'gaddr', g: d.g, off: d.off }); break;
      case 'ind':
        if (d.off) { this.emit({ o: 'lit', s: this.P, v: d.off }); this.emit({ o: 'add', s: this.P, u: true }); }
        break;
      case 'abs':
        if (this.target.ptrSize === 2 && d.a + d.off > 0xffff) this.err('address outside bank 0 cannot be a pointer on the 65C816');
        this.emit({ o: 'lit', s: this.P, v: this.target.uncached ? ((d.a + d.off) | this.target.uncached) >>> 0 : d.a + d.off });
        break;
      case 'far':
        if (d.off) { this.emit({ o: 'lit', s: 'L', v: d.off }); this.emit({ o: 'add', s: 'L', u: true }); }
        if (this.target.ptrSize === 2) this.emit({ o: 'trunc', mt: 'u16' });
        else if (this.target.uncached) { this.emit({ o: 'lit', s: 'L', v: this.target.uncached }); this.emit({ o: 'or', s: 'L', u: true }); }
        break;
    }
  }

  strLabel(s) {
    const key = this.moduleName + '|' + s;
    if (this.strLits.has(key)) return this.strLits.get(key);
    const label = `S${++this.lbl}`;
    const bytes = [s.length, ...[...s].map(c => c.charCodeAt(0) & 255)];
    this.data.push({ label, bytes, align: 1, ro: true, module: this.moduleName });
    this.strLits.set(key, label);
    return label;
  }

  // push the address of a string value
  genStr(e) {
    const t = e.type;
    if (e.n === 'const') {
      const s = t.k === 'char' ? String.fromCharCode(e.v) : e.v;
      this.emit({ o: 'gaddr', g: this.strLabel(s), off: 0 });
      return;
    }
    if (t.k === 'char') {
      const off = this.allocTemp(2);
      this.emit({ o: 'lit', s: 'W', v: 1 });
      this.emit({ o: 'stl', hops: 0, off, kind: 'loc', mt: 'u8' });
      this.genValue(e);
      this.emit({ o: 'stl', hops: 0, off: off + 1, kind: 'loc', mt: 'u8' });
      this.emit({ o: 'laddr', hops: 0, off, kind: 'loc' });
      return;
    }
    if (e.n === 'concat') {
      const tmp = this.tempVar(T.string);
      const tn = { n: 'var', sym: tmp, type: T.string, lv: true };
      this.genCall(this.mkRtCall('strasg', [tn, e.parts[0], this.cint(255)]));
      for (let i = 1; i < e.parts.length; i++) this.genCall(this.mkRtCall('strcat', [tn, e.parts[i], this.cint(255)]));
      this.genAddr(tn);
      return;
    }
    if (e.n === 'call') {
      const tmp = this.tempVar(T.string);
      const tn = { n: 'var', sym: tmp, type: T.string, lv: true };
      this.genCall(e, tn);
      this.genAddr(tn);
      return;
    }
    if (t.k === 'string' && e.lv) { this.genAddr(e); return; }
    this.err('string expected');
  }

  // push the address of a 32-byte set
  genSet(e) {
    if (e.n === 'setc') {
      if (e.isConst) {
        const bytes = new Array(32).fill(0);
        for (const r of e.elems) for (let v = r.lo; v <= r.hi; v++) bytes[v >> 3] |= 1 << (v & 7);
        const label = `C${++this.lbl}`;
        this.data.push({ label, bytes, align: 1, ro: true, module: this.moduleName });
        this.emit({ o: 'gaddr', g: label, off: 0 });
        return;
      }
      const tmp = this.tempVar({ k: 'set', size: 32 });
      const tn = { n: 'var', sym: tmp, type: e.type, lv: true };
      this.genAddr(tn);
      this.emit({ o: 'arg', s: this.P });
      this.emit({ o: 'lit', s: 'W', v: 32 });
      this.emit({ o: 'arg', s: 'W' });
      this.emit({ o: 'lit', s: 'W', v: 0 });
      this.emit({ o: 'arg', s: 'W' });
      this.emitCall(this.rtSym('fill'));
      for (const it of e.items) {
        if (it.b) this.genCall(this.mkRtCall('setrange', [tn, this.conv(it.a, T.integer), this.conv(it.b, T.integer)]));
        else this.genCall(this.mkRtCall('setincl', [tn, this.conv(it.a, T.integer)]));
      }
      this.genAddr(tn);
      return;
    }
    if (e.n === 'setop') {
      const tmp = this.tempVar({ k: 'set', size: 32 });
      const tn = { n: 'var', sym: tmp, type: e.type, lv: true };
      this.genCall(this.mkRtCall('setop', [tn, e.l, e.r, this.cint({ '+': 0, '-': 1, '*': 2 }[e.op])]));
      this.genAddr(tn);
      return;
    }
    if (e.lv) { this.genAddr(e); return; }
    this.err('set expected');
  }

  emitCall(sym, fn) {
    if (fn) {
      // through a procedural value: its address last
      this.genValue(fn);
      this.emit({ o: 'calli', args: sym.parBytes, ret: sym.ret ? this.clsOf(sym.ret) : null });
      return;
    }
    this.emit({ o: 'call', l: sym.label, args: sym.parBytes, ret: sym.ret && sym.ret.k !== 'string' ? this.clsOf(sym.ret) : null, ext: sym.external });
  }

  // call node -> IR. For string functions `strDst` is the result buffer.
  genCall(c, strDst) {
    const sym = c.proc;
    if (c.linkVmt) {
      const { obj, ot } = c.linkVmt;
      this.assign({ n: 'field', base: obj, f: { name: '$vmt', type: this.ptrT, off: ot.vmtOff }, type: this.ptrT, lv: true },
        { n: 'vmtaddr', label: ot.vmtLabel, type: this.ptrT });
    }
    const P = this.P;
    if (sym.ret && sym.ret.k === 'string') {
      if (!strDst) {
        const tmp = this.tempVar(T.string);
        strDst = { n: 'var', sym: tmp, type: T.string, lv: true };
      }
      this.genAddr(strDst);
      this.emit({ o: 'arg', s: P });
    }
    sym.params.forEach((p, i) => {
      const a = c.args[i];
      if (p.mode === 'var' || p.type.k === 'untyped' || p.type.k === 'openarray') {
        this.genAddr(a);
        this.emit({ o: 'arg', s: P });
      } else if (p.type.k === 'string') {
        this.genStr(a);
        this.emit({ o: 'arg', s: P });
      } else if (p.type.k === 'set') {
        this.genSet(a);
        this.emit({ o: 'arg', s: P });
      } else if (isStruct(p.type)) {
        this.genAddr(a);
        this.emit({ o: 'arg', s: P });
      } else {
        const cls = this.clsOf(p.type);
        this.genValue(a);
        this.emit({ o: 'arg', s: cls });
      }
    });
    if (sym.level >= 2) {
      const hops = this.ctx.level - (sym.level - 1);
      if (hops < 0) this.err('internal: bad static link');
      this.emit({ o: 'fp', hops });
      this.emit({ o: 'arg', s: P });
    }
    if (c.virt) {
      // the method's address from the object's VMT (+0 is the size)
      const P = this.P;
      this.genValue({ n: 'field', base: c.virt.obj, f: { name: '$vmt', type: this.ptrT, off: c.virt.vmtOff }, type: this.ptrT, lv: true });
      this.emit({ o: 'ld', off: (c.virt.slot + 1) * this.target.ptrSize, mt: this.mtOf(this.ptrT) });
      this.emit({ o: 'calli', args: sym.parBytes, ret: sym.ret && sym.ret.k !== 'string' ? this.clsOf(sym.ret) : null });
    } else this.emitCall(sym, c.fn);
  }

  // push a scalar value
  // ---- {$R+} {$Q+}: checks that stop the program with a runtime error
  get sw() { return (this.tk && this.tk.pos && this.tk.pos.sw) || {}; }

  genRunError(code) {
    const sys = this.units.get('system');
    const s = sys && sys.iface.syms.get('runerror');
    if (!s) this.err('internal: RunError missing in System');
    this.genCall(this.checkCall(s, [this.cint(code)], this.tk.pos));
  }

  // the value on top of the stack (class cls, unsigned u) within lo..hi,
  // else runtime error code; the value stays
  genRangeCheck(lo, hi, cls, u, code) {
    const min = cls === 'L' ? (u ? 0 : -2147483648) : (u ? 0 : -32768);
    const max = cls === 'L' ? (u ? 4294967295 : 2147483647) : (u ? 65535 : 32767);
    const needLo = lo > min, needHi = hi < max;
    if (!needLo && !needHi) return;
    const bad = this.newLabel(), ok = this.newLabel();
    if (needLo) {
      this.emit({ o: 'dup' }); this.emit({ o: 'lit', s: cls, v: lo });
      this.emit({ o: 'cmp', c: 'lt', s: cls, u }); this.emit({ o: 'jnz', l: bad });
    }
    if (needHi) {
      this.emit({ o: 'dup' }); this.emit({ o: 'lit', s: cls, v: hi });
      this.emit({ o: 'cmp', c: 'gt', s: cls, u }); this.emit({ o: 'jnz', l: bad });
    }
    this.emit({ o: 'jmp', l: ok });
    this.emit({ o: 'label', l: bad });
    this.genRunError(code);
    this.emit({ o: 'label', l: ok });
  }

  // {$R+}: an index of an open array in 0..its high (the hidden parameter)
  genOpenCheck(hs, cls) {
    const bad = this.newLabel(), ok = this.newLabel();
    this.emit({ o: 'dup' }); this.emit({ o: 'lit', s: cls, v: 0 });
    this.emit({ o: 'cmp', c: 'lt', s: cls, u: false }); this.emit({ o: 'jnz', l: bad });
    this.emit({ o: 'dup' });
    this.genValue(this.conv({ n: 'var', sym: hs, type: T.integer, lv: true }, cls === 'L' ? T.longint : T.integer));
    this.emit({ o: 'cmp', c: 'gt', s: cls, u: false }); this.emit({ o: 'jnz', l: bad });
    this.emit({ o: 'jmp', l: ok });
    this.emit({ o: 'label', l: bad });
    this.genRunError(201);
    this.emit({ o: 'label', l: ok });
  }

  // + - * with {$Q+}: runtime error 215 when the result does not fit
  genOverflowOp(e, ot) {
    const op = { '+': 'add', '-': 'sub', '*': 'mul' }[e.op];
    const u = !this.signedOf(ot);
    if (this.clsOf(ot) === 'W') {
      // 16 bit: in 32 bits, then the range of the type
      const wide = u ? T.longword : T.longint;
      this.genValue(this.conv(e.l, wide));
      this.genValue(this.conv(e.r, wide));
      this.emit({ o: op, s: 'L', u });
      this.genRangeCheck(ot.lo, ot.hi, 'L', u, 215);
      this.emit({ o: 'trunc', mt: this.mtOf(ot) });
      return;
    }
    // 32 bit: operands and result in temporaries
    const mt = this.mtOf(ot);
    const ta = this.allocTemp(4, 4), tb = this.allocTemp(4, 4), tr = this.allocTemp(4, 4);
    const st = (off) => this.emit({ o: 'stl', hops: 0, off, kind: 'loc', mt });
    const ld = (off) => this.emit({ o: 'ldl', hops: 0, off, kind: 'loc', mt });
    const E = (o, x = {}) => this.emit({ o, s: 'L', u, ...x });
    this.genValue(e.l); st(ta);
    this.genValue(e.r); st(tb);
    ld(ta); ld(tb); E(op); st(tr);
    const ok = this.newLabel();
    if (op === 'mul') {
      // a = 0, or r div a = b
      ld(ta); E('lit', { v: 0 }); E('cmp', { c: 'eq' }); this.emit({ o: 'jnz', l: ok });
      ld(tr); ld(ta); E('div'); ld(tb); E('cmp', { c: 'eq' }); this.emit({ o: 'jnz', l: ok });
    } else if (u) {
      // unsigned: no carry (r >= a) / no borrow (a >= b)
      if (op === 'add') { ld(tr); ld(ta); } else { ld(ta); ld(tb); }
      E('cmp', { c: 'ge' }); this.emit({ o: 'jnz', l: ok });
    } else {
      // signed: (a xor r) and (b xor r) >= 0 / (a xor b) and (a xor r) >= 0
      if (op === 'add') { ld(ta); ld(tr); E('xor'); ld(tb); ld(tr); E('xor'); }
      else { ld(ta); ld(tb); E('xor'); ld(ta); ld(tr); E('xor'); }
      E('and'); this.emit({ o: 'lit', s: 'L', v: 0 }); this.emit({ o: 'cmp', c: 'ge', s: 'L', u: false });
      this.emit({ o: 'jnz', l: ok });
    }
    this.genRunError(215);
    this.emit({ o: 'label', l: ok });
    ld(tr);
  }

  genValue(e) {
    const t = e.type;
    switch (e.n) {
      case 'onstack': return;     // a value already computed (see assign)
      case 'procaddr': this.emit({ o: 'gaddr', g: e.sym.label, off: 0 }); return;
      case 'vmtaddr': this.emit({ o: 'gaddr', g: e.label, off: 0 }); return;
      case 'vmtsize':
        this.genValue({ n: 'field', base: e.obj, f: { name: '$vmt', type: this.ptrT, off: e.off }, type: this.ptrT, lv: true });
        this.emit({ o: 'ld', off: 0, mt: 'u16' });
        if (this.P === 'L') this.emit({ o: 'trunc', mt: 'u16' });
        return;
      case 'newobj': {
        // New(PType, Constructor(args)): the memory, the constructor, the pointer
        this.assign(e.tmp, { n: 'cvt', e: this.callRt('getmem', [this.cint(e.ptype.to.size)]), type: e.ptype, explicit: true });
        this.genCall(e.ctor);
        this.genValue(e.tmp);
        return;
      }
      case 'const': {
        if (t.k === 'real') { this.emit({ o: 'lit', s: 'L', v: realBits(e.v) }); return; }
        if (t.k === 'string') this.err('string constant used as a value');
        if (isPtr(t)) { this.emit({ o: 'lit', s: this.P, v: 0 }); return; }
        this.emit({ o: 'lit', s: this.clsOf(t), v: e.v });
        return;
      }
      case 'var': case 'field': case 'index': case 'deref': case 'mem': case 'retype': {
        if (!isScalar(t)) this.err(`${typeName(t)} used as a value`);
        const d = this.lvalDesc(e);
        this.loadDesc(d, this.mtOf(t));
        return;
      }
      case 'addr': this.genAddr(e.e); return;
      case 'call': {
        if (t.k === 'void') this.err(`procedure '${e.proc.name}' has no value`);
        if (t.k === 'string') this.err('string function result used as a value');
        this.genCall(e);
        return;
      }
      case 'strlen': {
        this.genStr(e.e);
        this.emit({ o: 'ld', off: 0, mt: 'u8' });
        return;
      }
      case 'cvt': this.genCvt(e); return;
      case 'un': {
        if (e.op === 'rneg') { this.genCallArgs('negreal', [e.e]); return; }
        this.genValue(e.e);
        const cls = this.clsOf(t);
        if (e.op === 'neg') this.emit({ o: 'neg', s: cls, u: false });
        else if (e.op === 'not') this.emit({ o: 'not', s: cls, u: !this.signedOf(t) });
        else { this.emit({ o: 'lit', s: 'W', v: 1 }); this.emit({ o: 'xor', s: 'W', u: true }); }
        return;
      }
      case 'bin': {
        const ot = e.ot;
        const cls = this.clsOf(ot);
        const u = !this.signedOf(ot);
        const rel = { '=': 'eq', '<>': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' }[e.op];
        if (this.sw.Q && ot.k === 'int' && (e.op === '+' || e.op === '-' || e.op === '*')) { this.genOverflowOp(e, ot); return; }
        if (e.op === 'shl' || e.op === 'shr') {
          this.genValue(e.l);
          if (e.r.n === 'const') this.emit({ o: 'lit', s: 'W', v: e.r.v & 31 });
          else this.genValue(e.r);
          this.emit({ o: e.op, s: cls, u });
          return;
        }
        this.genValue(e.l);
        this.genValue(e.r);
        if (rel) { this.emit({ o: 'cmp', c: rel, s: cls, u }); return; }
        const op = { '+': 'add', '-': 'sub', '*': 'mul', div: 'div', mod: 'mod', and: 'and', or: 'or', xor: 'xor' }[e.op];
        this.emit({ o: op, s: cls, u });
        return;
      }
      case 'rbin': {
        this.genCallArgs({ '+': 'addreal', '-': 'subreal', '*': 'mulreal', '/': 'divreal' }[e.op], [e.l, e.r]);
        return;
      }
      case 'rcmp': case 'strcmp': case 'setcmp': case 'in': {
        const off = this.allocTemp(2, 2);
        const lF = this.newLabel();
        this.emit({ o: 'lit', s: 'W', v: 0 });
        this.emit({ o: 'stl', hops: 0, off, kind: 'loc', mt: 'u16' });
        this.genCond(e, lF);
        this.emit({ o: 'lit', s: 'W', v: 1 });
        this.emit({ o: 'stl', hops: 0, off, kind: 'loc', mt: 'u16' });
        this.emit({ o: 'label', l: lF });
        this.emit({ o: 'ldl', hops: 0, off, kind: 'loc', mt: 'u16' });
        return;
      }
      case 'concat': case 'setc': case 'setop':
        this.err('structured value used as a scalar');
    }
    this.err(`internal: cannot generate value for ${e.n}`);
  }

  genCallArgs(rt, args) {
    const sym = this.rtSym(rt);
    this.genCall(this.checkCall(sym, args, this.tk.pos));
  }

  genCvt(e) {
    const from = e.e.type, to = e.type;
    if (to.k === 'real') {
      if (from.k === 'real') { this.genValue(e.e); return; }
      if (!isInt(from)) this.err('cannot convert to real');
      const name = from.size === 4 && !from.signed ? 'cardtoreal' : 'inttoreal';
      this.genCall(this.checkCall(this.rtSym(name), [from.size === 4 ? e.e : { n: 'cvt', e: e.e, type: T.longint }], this.tk.pos));
      return;
    }
    if (from.k === 'real') this.err('cannot convert a real here; use Trunc or Round');
    this.genValue(e.e);
    const fc = this.clsOf(from), tc = this.clsOf(to);
    const tmt = this.mtOf(to);
    if (fc === 'W' && tc === 'L') {
      this.emit({ o: 'ext', u: !this.signedOf(from) || from.k !== 'int' });
    } else if (fc === 'L' && tc === 'W') {
      this.emit({ o: 'trunc', mt: tmt });
    } else if (fc === 'W' && tc === 'W' && e.explicit) {
      const fmt = this.mtOf(from);
      if (fmt !== tmt && !(tmt === 'u16' && fmt === 'u8') && !(tmt === 's16' && (fmt === 'u8' || fmt === 's8'))) {
        this.emit({ o: 'narrow', mt: tmt });
      }
    } else if (fc === 'W' && tc === 'W' && this.target.normalize) {
      // implicit W->W on targets that keep 16-bit values sign/zero extended
      const fmt = this.mtOf(from);
      if ((fmt === 's16' && tmt === 'u16') || (fmt === 'u16' && tmt === 's16')) this.emit({ o: 'narrow', mt: tmt });
    }
  }

  // jump to lF if e is false
  genCond(e, lF) {
    if (e.n === 'const') { if (!e.v) this.emit({ o: 'jmp', l: lF }); return; }
    if (e.n === 'bin' && e.op === 'and' && e.type.k === 'bool') { this.genCond(e.l, lF); this.genCond(e.r, lF); return; }
    if (e.n === 'bin' && e.op === 'or' && e.type.k === 'bool') {
      const lT = this.newLabel();
      this.genCondTrue(e.l, lT);
      this.genCond(e.r, lF);
      this.emit({ o: 'label', l: lT });
      return;
    }
    if (e.n === 'un' && e.op === 'lnot') { this.genCondTrue(e.e, lF); return; }
    const inv = { '=': 'ne', '<>': 'eq', '<': 'ge', '<=': 'gt', '>': 'le', '>=': 'lt' };
    if (this.genCmpJump(e, lF, inv)) return;
    this.genValue(e);
    this.emit({ o: 'jz', l: lF });
  }
  // jump to lT if e is true
  genCondTrue(e, lT) {
    if (e.n === 'const') { if (e.v) this.emit({ o: 'jmp', l: lT }); return; }
    if (e.n === 'bin' && e.op === 'or' && e.type.k === 'bool') { this.genCondTrue(e.l, lT); this.genCondTrue(e.r, lT); return; }
    if (e.n === 'bin' && e.op === 'and' && e.type.k === 'bool') {
      const lF = this.newLabel();
      this.genCond(e.l, lF);
      this.genCondTrue(e.r, lT);
      this.emit({ o: 'label', l: lF });
      return;
    }
    if (e.n === 'un' && e.op === 'lnot') { this.genCond(e.e, lT); return; }
    const same = { '=': 'eq', '<>': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
    if (this.genCmpJump(e, lT, same)) return;
    this.genValue(e);
    this.emit({ o: 'jnz', l: lT });
  }
  genCmpJump(e, l, map) {
    if (e.n === 'bin' && map[e.op]) {
      const cls = this.clsOf(e.ot), u = !this.signedOf(e.ot);
      this.genValue(e.l);
      this.genValue(e.r);
      this.emit({ o: 'jc', c: map[e.op], s: cls, u, l });
      return true;
    }
    if (e.n === 'rcmp' || e.n === 'strcmp') {
      if (e.n === 'rcmp') this.genCallArgs('cmpreal', [e.l, e.r]);
      else this.genCallArgs('strcmp', [e.l, e.r]);
      this.emit({ o: 'lit', s: 'W', v: 0 });
      this.emit({ o: 'jc', c: map[e.op], s: 'W', u: false, l });
      return true;
    }
    if (e.n === 'setcmp') {
      // = / <> via setcmp(a,b)=0 ; <= : a subset of b ; >= : b subset of a
      const [a, b, fn] = e.op === '>=' ? [e.r, e.l, 'setle'] : e.op === '<=' ? [e.l, e.r, 'setle'] : [e.l, e.r, 'seteq'];
      this.genCallArgs(fn, [a, b]);
      // fn returns true (nonzero) for '=', '<=', '>='; '<>' is the negation
      const jumpIfTrue = map['='] === 'eq';
      const c = (e.op === '<>') === jumpIfTrue ? 'eq' : 'ne';
      this.emit({ o: 'lit', s: 'W', v: 0 });
      this.emit({ o: 'jc', c, s: 'W', u: true, l });
      return true;
    }
    if (e.n === 'in') {
      const jumpIfTrue = map['='] === 'eq';
      if (e.r.n === 'setc' && e.r.isConst) {
        // inline range tests
        const elT = e.l.type;
        const tmp = this.tempVar(elT.size === 4 ? T.longint : T.integer);
        const tn = { n: 'var', sym: tmp, type: tmp.type, lv: true };
        this.assign(tn, this.conv(elT.k === 'int' ? e.l : { n: 'cvt', e: e.l, type: T.word, explicit: true }, tmp.type));
        const cls = this.clsOf(tmp.type);
        const lHit = jumpIfTrue ? l : this.newLabel();
        for (const r of e.r.elems) {
          if (r.lo === r.hi) {
            this.genValue(tn); this.emit({ o: 'lit', s: cls, v: r.lo });
            this.emit({ o: 'jc', c: 'eq', s: cls, u: false, l: lHit });
          } else {
            const lNo = this.newLabel();
            this.genValue(tn); this.emit({ o: 'lit', s: cls, v: r.lo });
            this.emit({ o: 'jc', c: 'lt', s: cls, u: false, l: lNo });
            this.genValue(tn); this.emit({ o: 'lit', s: cls, v: r.hi });
            this.emit({ o: 'jc', c: 'le', s: cls, u: false, l: lHit });
            this.emit({ o: 'label', l: lNo });
          }
        }
        if (!jumpIfTrue) { this.emit({ o: 'jmp', l }); this.emit({ o: 'label', l: lHit }); }
        return true;
      }
      this.genCallArgs('setin', [this.conv(e.l.type.k === 'int' ? e.l : { n: 'cvt', e: e.l, type: T.word, explicit: true }, T.integer), e.r]);
      this.emit({ o: jumpIfTrue ? 'jnz' : 'jz', l });
      return true;
    }
    return false;
  }
}

export { CompileError };
