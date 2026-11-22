// MERIDIAN Pascal - cartridge builder
//
// Builds a MERIDIAN 816 cartridge (.MOD, ROM image at $40:0000) from a
// main program in the far code model: code runs from the cartridge ROM,
// data lives in bank 0 from $2000 (copied from the ROM at start).
//
// Bank 0 layout:
//   $2000 RTVARS      runtime variables (never overwritten by the library init)
//         LIBDATA     data + variables of the library units (re-initialised
//                     for every program the on-device compiler runs)
//         LIBEND      first byte for the main program / user programs
//
// The cartridge also carries an export table of every library symbol, so
// the on-device compiler can link programs against the library code in ROM.
//
// ROM directory at $40:0020 (after the 32-byte module header):
//   +0 "MPAS"  +4 version  +5 EXPORTS (3)  +8 count (2)  +10 PARAMS (3)
//   +13 TYPES (3)  +16 LIBEND (2)  +18 rt_libinit (3)  +21 rt_exit (3)
//   +24 rt_runuser (3)  +27 LIBCODE_END (3)  +30 DATAROM (3)
//   +33 MERSTUB (3)  +36 stub length (2)  +38 LIBSTAMP (4, a hash of the library)
//
// The library code and the runtime come first ($40:0000..LIBCODE_END), so a
// program compiled on the MERIDIAN can be saved as a standalone .MER: it
// carries that block, the library's bank 0 data and the loader MERSTUB, which
// puts the library back at $40:0000 when no cartridge is inserted.

import { Front, CompileError } from './front.js';
import { TARGETS } from './compile.js';
import { gen816 } from './back816.js';
import { RT_VARS_CART } from './rt816.js';
import { realBits } from './types.js';
import { assemble816, formatListing, AsmError } from './asm816.js';
import { genRV, buildStub, RVLAYOUT } from './backrv.js';
import { assembleRV } from './asmrv.js';

// SCHUB programs compiled on the MERIDIAN (RISC-V addresses = MERIDIAN addresses)
export const RVC = {
  STUB: 0x040000,      // 65C816 host stub (RVLAYOUT.LOAD)
  HEAPVAR: 0x0403e0,   // word: start of the heap (written by the loader)
  LIB: 0x040400,       // RV32 library, started by the stub
  LIBMAX: 0x070000,
  CODE: 0x080000,      // program code (up to 128 KB)
  DATA: 0x0a0000,      // program variables, then the heap
  STACK: 0x1ffff0,     // stack top (grows down towards the heap)
};
const RT_EXPORTS_RV = ['rt_error', 'rt_exit', 'rt_memcpy', 'rt_memmove', 'rt_sys'];

// the whole library compiled for SCHUB, linked at RVC.LIB; the program
// compiled on the MERIDIAN is entered at RVC.CODE after the unit inits
function buildRvLibrary(opts, libUnits) {
  const tgt = TARGETS.schub;
  const front = new Front(tgt, { loadSource: opts.loadUnit, loadInclude: opts.loadInclude, defines: [...tgt.defines] });
  const src = `program RVLIB;\nuses ${libUnits.join(', ')};\nbegin\nend.\n`;
  const prog = front.compileProgram(src, 'rvlib.pas');
  const { asm } = genRV(prog, { userEntry: RVC.CODE, heapVar: RVC.HEAPVAR, stackTop: RVC.STACK });
  const a = assembleRV(asm, { org: RVC.LIB });
  const end = a.symbols.get('PAS_BSS');
  if (a.symbols.get('PAS_HEAP') > RVC.LIBMAX) throw new CompileError('SCHUB library too large');
  const stub = buildStub();
  return { front, symbols: a.symbols, bytes: a.bytes.slice(0, end - RVC.LIB), stub: stub.bytes };
}
const byteLines = (b) => { const o = []; for (let i = 0; i < b.length; i += 32) o.push('\t.byte ' + Array.from(b.subarray(i, i + 32)).join(',')); return o.join('\n'); };

// FNV-1a over the library block and its bank 0 data image: a standalone .MER
// compares it with $40:LIBSTAMP to see whether the library is already there
function stampLibrary(bytes, sym) {
  const B = 0x400000;
  let h = 0x811c9dc5;
  const add = (from, to) => { for (let i = from; i < to; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0; };
  add(sym.get('cart_start') - B, sym.get('LIBCODE_END') - B);
  add(sym.get('DATAROM') - B, sym.get('DATAROM') - B + sym.get('LIBEND') - 0x2000);
  if (h === 0) h = 1;
  const at = sym.get('LIBSTAMP') - B;
  for (let i = 0; i < 4; i++) bytes[at + i] = (h >>> (8 * i)) & 255;
}

// The loader at the front of a standalone .MER (loaded and started at $22:0000).
// The on-device compiler fills the table: five pieces (source, destination,
// length; 4 bytes each), the library stamp and the entry address.
// 65C816: 0 library code -> $40:0000, 1 library data image -> DATAROM,
// 2 program code -> $30:0000, 3 program data image -> $32:0000, 4 library data
// image -> $00:2000; pieces 0 and 1 only when $40:LIBSTAMP differs, entry $30:0000.
// SCHUB (stamp 0): 0 RV library -> $04:0400, 1 host stub -> $04:0000, 2 code ->
// $08:0000, 3 variables -> $0A:0000, 4 heap start -> $04:03E0; entry $04:0000.
const MER_STUB = `
MERSTUB
	.logical $220000
	brl mer_go
	.byte 0
mer_tab
	.fill 60
mer_stamp
	.fill 4
mer_entry
	.fill 4
mer_go
	phb
	phd
	php
	rep #$30
	lda #$B000              ; scratch direct page (the program's string area)
	tcd
	lda @l mer_stamp
	ora @l mer_stamp+2
	beq mer_plain
	jsr @w mer_same
	beq mer_have
	ldx #0
	jsr @w mer_piece
	ldx #12
	jsr @w mer_piece
	jsr @w mer_same
	bne mer_fail
	bra mer_have
mer_plain
	ldx #0
	jsr @w mer_piece
	ldx #12
	jsr @w mer_piece
mer_have
	ldx #24
	jsr @w mer_piece
	ldx #36
	jsr @w mer_piece
	ldx #48
	jsr @w mer_piece
	lda @l mer_entry
	sta @l mer_jsl+1
	sep #$20
	lda @l mer_entry+2
	sta @l mer_jsl+3
	rep #$20
	lda #0
	tcd
mer_jsl
	jsl $300000
	plp
	pld
	plb
	rtl
mer_fail
	sep #$20
	ldx #0
-	lda @l mer_msg,x
	beq +
	phx
	jsl L_CHROUT
	plx
	inx
	bra -
+	rep #$20
	plp
	pld
	plb
	rtl
; Z set when the library at $40:0000 is the one this program was made with
mer_same
	lda @l LIBSTAMP
	cmp @l mer_stamp
	bne +
	lda @l LIBSTAMP+2
	cmp @l mer_stamp+2
+	rts
; copy piece X: dp 0..3 source, 4..7 destination, 8..11 length
mer_piece
	lda @l mer_tab,x
	sta 0
	lda @l mer_tab+2,x
	sta 2
	lda @l mer_tab+4,x
	sta 4
	lda @l mer_tab+6,x
	sta 6
	lda @l mer_tab+8,x
	sta 8
	lda @l mer_tab+10,x
	sta 10
mer_blk
	lda 10
	bne mer_big
	lda 8
	beq mer_done
	tax
	sep #$20
	ldy #0
-	lda [0],y
	sta [4],y
	iny
	dex
	bne -
	rep #$20
mer_done
	rts
mer_big
	sep #$20
	ldy #0
-	lda [0],y
	sta [4],y
	iny
	bne -
	inc 2
	inc 6
	rep #$20
	dec 10
	bra mer_blk
mer_msg
	.text 13, "THIS PROGRAM NEEDS THE PASCAL LIBRARY AT $40:0000,", 13
	.text "BUT ANOTHER CARTRIDGE IS INSERTED.", 13, 0
	.here
MERSTUB_END
`;

export const CART = {
  BASE: 0x400000,
  STACK_TOP: 0xb7ff,
  ENTRY_SIZE: 40,
};

// type codes shared with the on-device compiler (cart/ncomp.pas)
export const TC = {
  integer: 1, word: 2, byte: 3, shortint: 4, longint: 5, longword: 6, char: 7, boolean: 8,
  string: 9, pointer: 10, untyped: 11, real: 12, struct: 13, shortstr: 14, set: 15,
};
const RT_EXPORTS = ['rt_mul16', 'rt_div16s', 'rt_div16u', 'rt_mod16s', 'rt_mod16u', 'rt_shl16', 'rt_shr16',
  'rt_mul32', 'rt_div32s', 'rt_div32u', 'rt_mod32s', 'rt_mod32u', 'rt_shl32', 'rt_shr32', 'rt_cmp32s',
  'rt_cmp32u', 'rt_ldf8', 'rt_ldf16', 'rt_ldf32', 'rt_stf8', 'rt_stf16', 'rt_stf32', 'rt_exit',
  'rt_libinit', 'rt_error', 'rt_runuser', ...RT_VARS_CART.map(v => v[0])];

export function buildCartridge(source, fileName, opts) {
  const target = TARGETS.m816;
  const res = { ok: false, errors: [] };
  try {
    const front = new Front(target, {
      loadSource: opts.loadUnit, loadInclude: opts.loadInclude,
      defines: [...target.defines, 'CARTRIDGE'],
    });
    let prog = front.compileProgram(source, fileName);
    const libModules = new Set(['system', ...(opts.libUnits || [])]);
    for (const u of libModules) if (!front.units.has(u)) throw new CompileError(`the cartridge program must use unit '${u}'`);

    // keep every library routine (programs compiled on the MERIDIAN may call
    // any of them) and what the main program reaches
    const procs = new Map(prog.procs.map(p => [p.label, p]));
    const live = new Set();
    const work = [prog.main, ...prog.inits, ...prog.procs.filter(p => libModules.has(p.module)).map(p => p.label)];
    while (work.length) {
      const l = work.pop();
      if (live.has(l)) continue;
      const p = procs.get(l);
      if (!p) continue;
      live.add(l);
      for (const ins of p.code) if (ins.o === 'call') work.push(ins.l);
      if (p.parent) work.push(p.parent);
    }
    prog = { ...prog, procs: prog.procs.filter(p => live.has(p.label)) };

    const libInits = prog.inits.filter(l => libModules.has(l.replace(/^U_|_init$/g, '')));
    const progInits = prog.inits.filter(l => !libInits.includes(l));
    const exp = buildExports(front, libModules);
    const rv = buildRvLibrary(opts, [...libModules].filter(u => u !== 'system'));
    const rvExp = buildExports(rv.front, libModules, {
      prefix: 'R', rt: RT_EXPORTS_RV,
      resolve: (l) => { const v = rv.symbols.get(l); if (v === undefined) throw new CompileError(`SCHUB library: no symbol ${l}`); return v; },
    });
    const rvAsm = `${rvExp.asm}\t.bankfit\nRVLIBIMG\n${byteLines(rv.bytes)}\nRVLIBIMG_END\nRVSTUBIMG\n${byteLines(rv.stub)}\nRVSTUBIMG_END\n`;
    const name = (opts.name || 'PASCAL').toUpperCase().slice(0, 16);

    const header = `
	* = $400000
	.text "MODUL816"
	.byte 1, 0
	.long cart_start
	.byte 0, 0, 0
	.text "${name}"
	.fill ${16 - name.length}
; directory for the on-device compiler
	.text "MPAS"
	.byte 1
	.long EXPORTS
	.word ${exp.count}
	.long EXPPARAMS
	.long EXPTYPES
	.word LIBEND
	.long rt_libinit
	.long rt_exit
	.long rt_runuser
	.long LIBCODE_END
	.long DATAROM
	.long MERSTUB
	.word MERSTUB_END-MERSTUB
LIBSTAMP
	.dword 0
; SCHUB: export table, library image (for $04:0400), host stub (for $04:0000)
	.long REXPORTS
	.word ${rvExp.count}
	.long REXPPARAMS
	.long REXPTYPES
	.long RVLIBIMG
	.long RVLIBIMG_END-RVLIBIMG
	.long RVSTUBIMG
	.word RVSTUBIMG_END-RVSTUBIMG
	.al
	.xl
cart_start
	phb
	phd
	php
	rep #$30
	lda #0
	tcd
	ldx #0
-	stz @w RTVARS,x
	inx
	inx
	cpx #LIBDATA-RTVARS
	bcc -
	tsc
	sta @w rt_savesp
	lda #$${CART.STACK_TOP.toString(16)}
	tcs
	phb
	ldx #(DATAROM+LIBDATA-$2000) & $ffff
	ldy #LIBDATA
	lda #PROGEND-LIBDATA-1
	mvn #^DATAROM,#$00
	plb
	lda #PAS_HEAP
	sta @w rt_heapbase
${libInits.map(l => `\tjsl ${l}`).join('\n')}
${progInits.map(l => `\tjsl ${l}`).join('\n')}
	jsl ${prog.main}
rt_exit
	rep #$30
	lda @w rt_savesp
	tcs
	plp
	pld
	plb
	rtl
; library re-initialisation for programs compiled on the MERIDIAN
rt_libinit
	php
	rep #$30
	phb
	ldx #(DATAROM+LIBDATA-$2000) & $ffff
	ldy #LIBDATA
	lda #LIBEND-LIBDATA-1
	mvn #^DATAROM,#$00
	plb
${libInits.map(l => `\tjsl ${l}`).join('\n')}
	plp
	rtl
`;
    const asm = gen816(prog, { far: true, cart: { header, libModules, tailAsm: exp.asm + rvAsm + MER_STUB } });
    res.asm = asm;
    const a = assemble816(asm, { listing: !!opts.listing });
    res.symbols = a.symbols;
    if (opts.listing) res.listing = formatListing(a.listing);
    res.bytes = a.bytes;
    stampLibrary(res.bytes, a.symbols);
    res.exports = exp.count;
    res.info = {
      romSize: a.bytes.length,
      libEnd: a.symbols.get('LIBEND'),
      progEnd: a.symbols.get('PROGEND'),
      dataRom: a.symbols.get('DATAROM'),
    };
    if (res.info.progEnd > CART.STACK_TOP - 2048) throw new CompileError(`cartridge data too large: bank 0 up to $${res.info.progEnd.toString(16)}`);
    if (a.bytes.length > 4 * 1024 * 1024) throw new CompileError('cartridge larger than 4 MB');
    res.ok = true;
  } catch (e) {
    if (e instanceof CompileError) res.errors.push({ msg: e.message, file: e.pos && e.pos.file, line: e.pos && e.pos.line, col: e.pos && e.pos.col });
    else if (e instanceof AsmError) res.errors.push({ msg: `assembler: ${e.message} (line ${e.line}: ${e.src && e.src.trim()})` });
    else res.errors.push({ msg: `internal error: ${e.message}`, stack: e.stack });
  }
  return res;
}

// ---------------------------------------------------------------- exports
function buildExports(front, libModules, o = {}) {
  const P = o.prefix || '';
  const val = (l) => (o.resolve && typeof l === 'string' && !/^-?\d+$/.test(l) ? `${o.resolve(l) >>> 0}` : l);
  const types = [];       // {key, asm}
  const typeIdx = new Map();
  const params = [];      // flat list of [mode, code, ref]
  const entries = new Map();
  const tcode = (t) => {
    switch (t.k) {
      case 'int':
        if (t.size === 1) return [t.signed ? TC.shortint : TC.byte, 0];
        if (t.size === 2) return [t.signed ? TC.integer : TC.word, 0];
        return [t.signed ? TC.longint : TC.longword, 0];
      case 'char': return [TC.char, 0];
      case 'bool': return [TC.boolean, 0];
      case 'enum': return [t.size === 1 ? TC.byte : TC.word, 0];
      case 'string': return t.max === 255 ? [TC.string, 0] : [TC.shortstr, t.max];
      case 'ptr': case 'nil': return [TC.pointer, 0];
      case 'untyped': return [TC.untyped, 0];
      case 'real': return [TC.real, 0];
      case 'set': return [TC.set, 0];
      case 'array': case 'record': {
        const r = structRef(t);
        return r === null ? null : [TC.struct, r];
      }
      default: return null;
    }
  };
  const structRef = (t) => {
    if (typeIdx.has(t)) return typeIdx.get(t);
    let body;
    if (t.k === 'array') {
      const ec = tcode(t.elem);
      if (!ec || ec[0] === TC.struct) return null;
      body = `\t.byte 1\n\t.word ${t.size}\n\t.word ${t.lo & 0xffff}, ${t.hi & 0xffff}\n\t.byte ${ec[0]}, ${ec[1]}`;
    } else {
      const fl = [];
      for (const f of t.fields) {
        const fc = tcode(f.type);
        if (!fc || fc[0] === TC.struct && false) return null;
        const nm = f.name.slice(0, 15);
        fl.push(`\t.byte ${nm.length}\n\t.text "${nm}"\n\t.fill ${15 - nm.length}\n\t.word ${f.off}\n\t.byte ${fc[0]}, ${fc[1]}`);
      }
      body = `\t.byte 2\n\t.word ${t.size}\n\t.byte ${fl.length}\n${fl.join('\n')}`;
    }
    const i = types.length;
    typeIdx.set(t, i);
    types.push(body);
    return i;
  };
  const add = (name, e) => { if (!entries.has(name)) entries.set(name, e); };
  for (const [uname, u] of front.units) {
    if (!libModules.has(uname)) continue;
    for (const [name, s] of u.iface.syms) {
      if (name.length > 19) continue;
      if (s.kind === 'const') {
        const c = tcode(s.type);
        if (!c || typeof s.v !== 'number' || c[0] === TC.string || c[0] === TC.shortstr || c[0] === TC.set) continue;
        add(name, { kind: 1, code: c[0], ref: c[1], value: `${c[0] === TC.real ? realBits(s.v) : s.v | 0}` });
      } else if (s.kind === 'var') {
        const c = tcode(s.type);
        if (!c) continue;
        const adr = s.loc.addr !== undefined ? `${s.loc.addr}` : s.loc.label;
        add(name, { kind: 2, code: c[0], ref: c[1], value: val(adr) });
      } else if (s.kind === 'type') {
        const c = tcode(s.type);
        if (!c) continue;
        add(name, { kind: 5, code: c[0], ref: c[1], value: `${s.type.size}` });
      } else if (s.kind === 'proc') {
        let ok = true;
        const ps = [];
        for (const p of s.params) {
          const c = tcode(p.type);
          if (!c) { ok = false; break; }
          ps.push([p.mode === 'var' ? 1 : p.mode === 'const' ? 2 : 0, c[0], c[1]]);
        }
        let rc = [0, 0];
        if (s.ret) { rc = tcode(s.ret); if (!rc || rc[0] === TC.struct || rc[0] === TC.set) ok = false; }
        if (!ok) continue;
        const pi = params.length;
        params.push(...ps);
        const strRet = s.ret && s.ret.k === 'string';
        add(name, { kind: s.ret ? 4 : 3, code: rc[0], ref: rc[1], value: val(s.label), npar: ps.length, flags: strRet ? 1 : 0, pidx: pi });
      }
    }
  }
  for (const r of (o.rt || RT_EXPORTS)) add(r, { kind: 6, code: 0, ref: 0, value: val(r) });
  const names = [...entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = ['\t.bankfit', '; ---- export table for the on-device compiler', `${P}EXPORTS`];
  for (const n of names) {
    const e = entries.get(n);
    lines.push(`\t.byte ${n.length}\n\t.text "${n}"\n\t.fill ${19 - n.length}\n\t.byte ${e.kind}, ${e.code}\n\t.dword ${e.value}\n\t.word ${e.ref}\n\t.byte ${e.npar || 0}, ${e.flags || 0}\n\t.word ${e.pidx || 0}\n\t.fill 8`);
  }
  lines.push(`${P}EXPPARAMS`);
  for (const p of params) lines.push(`\t.byte ${p.join(', ')}`);
  lines.push('\t.byte 0');
  lines.push(`${P}EXPTYPES`);
  types.forEach((_, i) => lines.push(`\t.word ${P}EXPT${i}-${P}EXPTYPES`));
  types.forEach((b, i) => { lines.push(`${P}EXPT${i}`); lines.push(b); });
  lines.push('\t.byte 0');
  return { asm: lines.join('\n') + '\n', count: names.length };
}
