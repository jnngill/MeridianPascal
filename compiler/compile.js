// MERIDIAN Pascal - compiler driver
import { Front, CompileError } from './front.js';
import { CFront } from './cfront.js';
import { gen816, M816 } from './back816.js';
import { assemble816, formatListing, AsmError } from './asm816.js';
import { genRV, RVLAYOUT } from './backrv.js';
import { assembleRV, formatListingRV } from './asmrv.js';

export const TARGETS = {
  m816: {
    name: 'm816', title: '65C816 (MERIDIAN 816)', ptrSize: 2, align: false, argSlot: null,
    normalize: false, uncached: 0, defines: ['MERIDIAN', 'M816', 'CPU65C816'],
  },
  schub: {
    name: 'schub', title: 'SCHUB RV32IM co-processor', ptrSize: 4, align: true, argSlot: 4,
    normalize: true, uncached: 0x80000000, defines: ['MERIDIAN', 'SCHUB', 'CPURV32'],
  },
};

// keep only procedures / data reachable from main and the unit inits
function prune(prog) {
  const procs = new Map(prog.procs.map(p => [p.label, p]));
  const live = new Set();
  const liveData = new Set();
  const work = [prog.main, ...prog.inits];
  while (work.length) {
    const l = work.pop();
    if (live.has(l)) continue;
    const p = procs.get(l);
    if (!p) continue;
    live.add(l);
    for (const ins of p.code) {
      if (ins.o === 'call' && !live.has(ins.l)) work.push(ins.l);
      if (ins.o === 'asm') {
        for (const l of ins.lines) for (const q of l.parts) if (typeof q === 'object' && q.r === 'glob' && typeof q.g === 'string') liveData.add(q.g);
      }
      if ((ins.o === 'gaddr' || ins.o === 'ldg' || ins.o === 'stg') && typeof ins.g === 'string') { liveData.add(ins.g); if (ins.o === 'gaddr' && procs.has(ins.g) && !live.has(ins.g)) work.push(ins.g); }
    }
    // parents of nested procedures are needed for frame sizes
    if (p.parent && !live.has(p.parent)) work.push(p.parent);
  }
  return {
    ...prog,
    procs: prog.procs.filter(p => live.has(p.label)),
    data: prog.data.filter(d => liveData.has(d.label)),
    bss: prog.bss.filter(b => liveData.has(b.label)),
  };
}

export function makeMer(bytes, load, start, autostart = true) {
  const h = new Uint8Array(16);
  h.set([0x4d, 0x45, 0x52, 0x01]);
  h[4] = load & 255; h[5] = (load >> 8) & 255; h[6] = (load >> 16) & 255;
  h[7] = autostart ? 1 : 0;
  h[8] = start & 255; h[9] = (start >> 8) & 255; h[10] = (start >> 16) & 255;
  const n = bytes.length;
  h[12] = n & 255; h[13] = (n >> 8) & 255; h[14] = (n >> 16) & 255; h[15] = (n >>> 24) & 255;
  const out = new Uint8Array(16 + n);
  out.set(h);
  out.set(bytes, 16);
  return out;
}

export function compile(source, fileName, opts = {}) {
  if (/\.[ch]$/i.test(fileName || '') || opts.lang === 'c') return compileC(source, fileName, opts);
  const target = TARGETS[opts.target || 'm816'];
  if (!target) return { ok: false, errors: [{ msg: `unknown target ${opts.target}` }] };
  const t0 = Date.now();
  const res = { ok: false, errors: [], target: target.name };
  try {
    const front = new Front(target, {
      loadSource: opts.loadUnit,
      loadInclude: opts.loadInclude,
      defines: [...target.defines, ...(opts.defines || [])],
    });
    const prog = front.compileProgram(source, fileName);
    backEnd(prog, target, opts, res);
  } catch (e) {
    catchError(e, res);
  }
  res.ms = Date.now() - t0;
  return res;
}

// a C program: opts.loadC(name, fromFile, system) finds headers and the
// library sources (clib/), opts.loadUnit the Pascal units it may use
export function compileC(source, fileName, opts = {}) {
  const target = TARGETS[opts.target || 'm816'];
  if (!target) return { ok: false, errors: [{ msg: `unknown target ${opts.target}` }] };
  const t0 = Date.now();
  const res = { ok: false, errors: [], warnings: [], target: target.name, lang: 'c' };
  let cf = null;
  try {
    const front = new Front(target, {
      loadSource: opts.loadUnit,
      loadInclude: opts.loadInclude,
      defines: [...target.defines, ...(opts.defines || [])],
    });
    front.compileUnit('system');
    const loadC = opts.loadC || (() => null);
    cf = new CFront(target, front, { loadC, defines: opts.cdefines || [] });
    cf.mainFile = fileName;
    // the C runtime first: the compiler calls its helpers
    const crt = loadC('crt0.c', fileName, true);
    if (!crt) throw new CompileError('the C runtime (clib/src/crt0.c) was not found');
    cf.compileTU(crt.text, crt.name);
    cf.compileTU(source, fileName);
    for (const extra of opts.sources || []) cf.compileTU(extra.text, extra.name);
    cf.finish();
    const prog = {
      target: target.name,
      procs: [...front.procs, ...cf.procs],
      data: [...front.data, ...cf.data],
      bss: [...front.bss, ...cf.bss],
      inits: front.unitInits,
      main: 'PMAIN',
      units: [...front.units.keys()],
      usesInt: !!front.usesInt,
    };
    backEnd(prog, target, opts, res);
  } catch (e) {
    catchError(e, res);
  }
  if (cf) res.warnings = cf.warnings.map(w => ({ msg: w.msg, file: w.pos && w.pos.file, line: w.pos && w.pos.line, col: w.pos && w.pos.col }));
  res.ms = Date.now() - t0;
  return res;
}

function catchError(e, res) {
  if (e instanceof CompileError) {
    res.errors.push({ msg: e.message, file: e.pos && e.pos.file, line: e.pos && e.pos.line, col: e.pos && e.pos.col });
  } else if (e instanceof AsmError && /; asm (\d+) (.*)$/.test(e.src || '')) {
    // in an asm block of the source text
    const m = /; asm (\d+) (.*)$/.exec(e.src);
    res.errors.push({ msg: `asm: ${e.message}`, file: m[2], line: +m[1], col: 1 });
  } else if (e instanceof AsmError) {
    res.errors.push({ msg: `assembler: ${e.message} (line ${e.line}: ${e.src && e.src.trim()})` });
  } else {
    res.errors.push({ msg: `internal compiler error: ${e.message}`, stack: e.stack });
  }
}

function backEnd(prog0, target, opts, res) {
  const total = prog0.procs.length;
  const prog = prune(prog0);
  res.units = prog.units;
  res.procCount = { total, used: prog.procs.length };
  res.ir = opts.keepIR ? prog : undefined;
  if (target.name === 'm816') {
    const org = opts.org || M816.ORG;
    const asm = gen816(prog, { org, stackTop: opts.stackTop });
    res.asm = asm;
    const a = assemble816(asm, { listing: true, org });
    // the bss is cleared at start and need not be in the file
    res.bytes = a.bytes.slice(0, a.symbols.get('PAS_BSS') - org);
    res.load = org;
    res.start = org;
    res.symbols = a.symbols;
    res.listing = formatListing(a.listing);
    res.lineMap = buildLineMap(a.listing);
    const end = org + res.bytes.length;
    const heap = a.symbols.get('PAS_HEAP');
    res.info = {
      codeStart: org, imageEnd: end, heapStart: heap,
      stackTop: opts.stackTop || M816.STACK_TOP,
    };
    if (heap > (opts.stackTop || M816.STACK_TOP) - 1024) {
      throw new CompileError(`program too large: it ends at $${heap.toString(16)}, the stack starts at $${(opts.stackTop || M816.STACK_TOP).toString(16)}`);
    }
    res.mer = makeMer(res.bytes, org, org, true);
  } else {
    const { asm, stub } = genRV(prog, opts);
    res.asm = asm;
    const a = assembleRV(asm, { listing: true, org: RVLAYOUT.CODE });
    const code = a.bytes.slice(0, a.symbols.get('PAS_BSS') - RVLAYOUT.CODE);
    const img = new Uint8Array(RVLAYOUT.CODE - RVLAYOUT.LOAD + code.length);
    img.set(stub.bytes, 0);
    img.set(code, RVLAYOUT.CODE - RVLAYOUT.LOAD);
    res.bytes = img;
    res.load = RVLAYOUT.LOAD;
    res.start = RVLAYOUT.LOAD;
    res.symbols = a.symbols;
    res.listing = '; ---- 65C816 host stub (bank $04)\n' + stub.listing + '\n; ---- RV32IM program\n' + formatListingRV(a.listing);
    res.asm = '; ---- 65C816 host stub\n' + stub.asm + '\n; ---- RV32IM program\n' + asm;
    res.lineMap = buildLineMap(a.listing);
    res.info = {
      codeStart: RVLAYOUT.CODE, imageEnd: RVLAYOUT.LOAD + img.length,
      heapStart: a.symbols.get('PAS_HEAP'), stackTop: RVLAYOUT.STACK_TOP,
    };
    res.mer = makeMer(img, RVLAYOUT.LOAD, RVLAYOUT.LOAD, true);
  }
  res.ok = true;
}

// map emitted addresses back to Pascal source lines (from "; line N" comments)
function buildLineMap(listing) {
  const map = [];
  let cur = null;
  for (const l of listing) {
    const m = /;\s*line (\d+)/.exec(l.src || '');
    if (m && !(l.bytes && l.bytes.length)) { cur = +m[1]; continue; }
    if (cur !== null && l.bytes && l.bytes.length) { map.push([l.addr, cur]); cur = null; }
  }
  return map;
}
