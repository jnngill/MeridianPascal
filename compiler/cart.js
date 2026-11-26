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
import { helpAsm816 } from './helptext.js';
import { genRV, buildStub, RVLAYOUT } from './backrv.js';
import { assembleRV } from './asmrv.js';
import { CFront } from './cfront.js';
import { cLoaders } from './mcc.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// {$I file}: next to the file that includes it (cart/ncomp.pas includes ccomp.inc)
export function includeNextTo(fn, from) {
  const p = path.resolve(from ? path.dirname(from) : '.', fn);
  return fs.existsSync(p) ? { text: fs.readFileSync(p, 'latin1'), name: p } : null;
}

const CLIB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'clib');

// The C library (clib/src), compiled with the PC C compiler into the
// cartridge's library block, so C programs compiled on the MERIDIAN
// (cart/ccomp.pas) link against it like Pascal programs against the units.
// Its routines and variables are exported as ".name" (a name no Pascal
// identifier can have); its address constants in data are stored by the
// routine CLIBINIT, which runs with the units' initialisation.
const CLIB_FILES = ['crt0.c', 'stdio.c', 'stdlib.c', 'string.c', 'ctype.c', 'math.c', 'time.c'];
function buildCLib(target, front, loadC) {
  const cf = new CFront(target, front, { loadC, farFnPtr: true });
  for (const f of CLIB_FILES) {
    const s = loadC(f, null, true);
    if (!s) throw new CompileError(`C library: ${f} not found`);
    cf.compileTU(s.text, s.name);
  }
  for (const g of cf.pendingGlobals) if (!g.emitted) cf.emitGlobal(g, null, null);
  const defined = new Set(cf.procs.map(p => p.label));
  for (const [, e] of cf.ext) if (e.kind === 'var' && e.emitted) defined.add(e.label);
  for (const u of cf.uses) if (!defined.has(u.label)) throw new CompileError(`C library: undefined reference to '${u.name}'`);
  const P = target.ptrSize;
  const code = [];
  for (const r of cf.relocs) {
    if (r.fn) { code.push({ o: 'faddr', g: r.target }, { o: 'stg', g: r.g, off: r.off, mt: '32' }); continue; }
    code.push({ o: 'gaddr', g: r.target, off: r.toff });
    if (r.far && P === 2) code.push({ o: 'ext', u: true });
    code.push({ o: 'stg', g: r.g, off: r.off, mt: r.far || P === 4 ? '32' : 'u16' });
  }
  const init = { label: 'CLIBINIT', name: 'C library init', level: 1, locSize: 0, parBytes: 0, hasSL: false, retCls: null, resultLoc: null, parent: null, code, module: 'c' };
  const procs = [...cf.procs, init];
  const modules = new Set(['c']);
  for (const x of [...procs, ...cf.data, ...cf.bss]) modules.add(x.module);
  const exports = [];
  for (const [name, e] of cf.ext) {
    if (e.isStatic || name.length > 14) continue;
    if (e.kind === 'func' && defined.has(e.label)) exports.push({ name: '.' + name, kind: 7, label: e.label });
    else if (e.kind === 'var' && e.emitted) exports.push({ name: '.' + name, kind: 8, label: e.label });
  }
  return { procs, data: cf.data, bss: cf.bss, modules, exports };
}

// the C headers (clib/include) for the on-device compiler, without their
// comments. The directory: the count (2 bytes), then 20 bytes an entry:
// the name (length byte, 12 characters, upper case), the offset of the
// text from the directory (4 bytes) and its length (3 bytes)
export function cHeaderBlob() {
  const dir = path.join(CLIB_ROOT, 'include');
  const files = fs.readdirSync(dir).filter(f => /\.h$/.test(f)).sort();
  const texts = files.map(f => stripC(fs.readFileSync(path.join(dir, f), 'latin1')));
  files.push('_predef.h'); texts.push(C_PREDEF);
  const head = 2 + 20 * files.length;
  const total = head + texts.reduce((a, t) => a + t.length, 0);
  const b = new Uint8Array(total);
  b[0] = files.length & 255; b[1] = files.length >> 8;
  let off = head;
  files.forEach((f, i) => {
    const e = 2 + 20 * i;
    const n = f.toUpperCase().slice(0, 12);
    b[e] = n.length;
    for (let k = 0; k < n.length; k++) b[e + 1 + k] = n.charCodeAt(k);
    for (let k = 0; k < 4; k++) b[e + 13 + k] = (off >>> (8 * k)) & 255;
    for (let k = 0; k < 3; k++) b[e + 17 + k] = (texts[i].length >>> (8 * k)) & 255;
    for (let k = 0; k < texts[i].length; k++) b[off + k] = texts[i].charCodeAt(k) & 255;
    off += texts[i].length;
  });
  return { bytes: b, count: files.length };
}
// The on-device C compiler's other tables (cart/cpre.inc reads them):
// CMSGS its error messages (cart/cmsgs.txt, numbered from 1 as the ce...
// constants), then the spellings of the tokens 101..147; CKEYWORDS an index
// by the first letter (a..z, _: 27 words, offsets from CKEYWORDS) and the
// keywords (length, the characters, the token); CUNITS the units' names in
// the order of the export table's unit numbers.
const C_TOKENS = ['+', '-', '*', '/', '%', '++', '--', '==', '!=', '<', '<=', '>', '>=', '&&', '||', '!', '~', '&',
  '|', '^', '<<', '>>', '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '?', ':', ';', ',', '.', '->',
  '(', ')', '[', ']', '{', '}', '...', 'end of line'];
export const C_KEYWORDS = [['auto', 160], ['break', 161], ['case', 162], ['char', 163], ['const', 164], ['continue', 165],
  ['default', 166], ['do', 167], ['double', 168], ['else', 169], ['enum', 170], ['extern', 171], ['float', 172],
  ['for', 173], ['goto', 174], ['if', 175], ['int', 176], ['long', 177], ['register', 178], ['return', 179],
  ['short', 180], ['signed', 181], ['sizeof', 182], ['static', 183], ['struct', 184], ['switch', 185],
  ['typedef', 186], ['union', 187], ['unsigned', 188], ['void', 189], ['volatile', 190], ['while', 191],
  ['_Bool', 192], ['__far', 193], ['_far', 193], ['inline', 194], ['__inline', 194], ['__inline__', 194],
  ['restrict', 195], ['__restrict', 195], ['__builtin_va_arg', 196], ['_Noreturn', 197], ['__attribute__', 198],
  ['__signed__', 181], ['__const', 164], ['__volatile__', 190]];
// the macros the PC compiler defines (cfront.js compileTU), for the on-device one
const C_PREDEF = [
  '#define __STDC__ 1', '#define __STDC_VERSION__ 199901L', '#define __MERIDIAN__ 1', '#define __MERIDIAN_C__ 1',
  '#define __CHAR_UNSIGNED__ 1', '#define __SIZEOF_INT__ 2', '#define __SIZEOF_LONG__ 4', '#define __SIZEOF_FLOAT__ 4',
  '#define __SIZEOF_DOUBLE__ 4', '#ifdef __SCHUB__', '#define __SIZEOF_POINTER__ 4', '#define __riscv 1', '#else',
  '#define __SIZEOF_POINTER__ 2', '#define __M816__ 1', '#define __65C816__ 1', '#endif', ''].join('\n');

export function cTablesAsm(unitOrder) {
  const cartDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cart');
  const msgs = fs.readFileSync(path.join(cartDir, 'cmsgs.txt'), 'latin1').replace(/\r/g, '').split('\n');
  while (msgs.length && msgs[msgs.length - 1] === '') msgs.pop();
  const last = /ceLast = (\d+);/.exec(fs.readFileSync(path.join(cartDir, 'cpre.inc'), 'latin1'));
  if (!last || +last[1] !== msgs.length) throw new CompileError(`cart/cmsgs.txt has ${msgs.length} messages, cart/cpre.inc ceLast says ${last && last[1]}`);
  const all = [...msgs, ...C_TOKENS];
  const bytes = [all.length & 255, all.length >> 8];
  for (const m of all) { bytes.push(m.length); for (const c of m) bytes.push(c.charCodeAt(0)); }
  const kw = [];
  const index = [];
  const buckets = 'abcdefghijklmnopqrstuvwxyz_';
  for (const b of buckets) {
    index.push(2 * buckets.length + kw.length);
    for (const [n, code] of C_KEYWORDS.filter(([n]) => n[0] === b)) { kw.push(n.length); for (const c of n) kw.push(c.charCodeAt(0)); kw.push(code); }
    kw.push(0);
  }
  const kwBytes = [];
  for (const o of index) kwBytes.push(o & 255, o >> 8);
  kwBytes.push(...kw);
  const units = [unitOrder.length];
  for (const u of unitOrder) { units.push(u.length); for (const c of u) units.push(c.charCodeAt(0)); }
  const lines = (b) => byteLines(Uint8Array.from(b));
  return `\t.bankfit\nCMSGS\n${lines(bytes)}\nCKEYWORDS\n${lines(kwBytes)}\nCUNITS\n${lines(units)}\n`;
}

// C text without its comments (strings and characters kept); the lines stay
// where they were (the directives need them)
export function stripC(t) {
  let o = '';
  const NL = '\n', BS = String.fromCharCode(92);
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < t.length && t[j] !== c && t[j] !== NL) { if (t[j] === BS) j++; j++; }
      o += t.slice(i, j + 1); i = j;
    } else if (c === '/' && t[i + 1] === '*') {
      let j = t.indexOf('*/', i + 2);
      if (j < 0) j = t.length;
      o += ' ' + NL.repeat(t.slice(i, j).split(NL).length - 1);
      i = j + 1;
    } else if (c === '/' && t[i + 1] === '/') {
      while (i + 1 < t.length && t[i + 1] !== NL) i++;
    } else if (c !== '\r') o += c;
  }
  return o.split(NL).map(l => l.replace(/\s+$/, '')).join(NL);
}

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
const RT_EXPORTS_RV = ['rt_error', 'rt_exit', 'rt_memcpy', 'rt_memmove', 'rt_sys', 'rt_dbghook'];

// the whole library compiled for SCHUB, linked at RVC.LIB; the program
// compiled on the MERIDIAN is entered at RVC.CODE after the unit inits
function buildRvLibrary(opts, libUnits) {
  const tgt = TARGETS.schub;
  const front = new Front(tgt, { loadSource: opts.loadUnit, loadInclude: opts.loadInclude, defines: [...tgt.defines] });
  const src = `program RVLIB;\nuses ${libUnits.join(', ')};\nbegin\nend.\n`;
  let prog = front.compileProgram(src, 'rvlib.pas');
  const clib = buildCLib(tgt, front, opts.loadC);
  prog = { ...prog, procs: [...prog.procs, ...clib.procs], data: [...prog.data, ...clib.data], bss: [...prog.bss, ...clib.bss], inits: [...prog.inits, 'CLIBINIT'] };
  const { asm } = genRV(prog, { userEntry: RVC.CODE, heapVar: RVC.HEAPVAR, stackTop: RVC.STACK, debugHook: true });
  const a = assembleRV(asm, { org: RVC.LIB });
  const end = a.symbols.get('PAS_BSS');
  if (a.symbols.get('PAS_HEAP') > RVC.LIBMAX) throw new CompileError('SCHUB library too large');
  const stub = buildStub();
  return { front, clib, symbols: a.symbols, bytes: a.bytes.slice(0, end - RVC.LIB), stub: stub.bytes };
}
const byteLines = (b) => { const o = []; for (let i = 0; i < b.length; i += 32) o.push('\t.byte ' + Array.from(b.subarray(i, i + 32)).join(',')); return o.join('\n'); };

// FNV-1a over the library block and its bank 0 data image: a standalone .MER
// compares it with $40:LIBSTAMP to see whether the library is already there
function stampLibrary(bytes, sym) {
  const B = 0x400000;
  let h = 0x811c9dc5;
  const add = (from, to) => { for (let i = from; i < to; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0; };
  add(sym.get('LIBCODE_START') - B, sym.get('LIBCODE_END') - B);
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
// Fast loops for the PASCAL editor (external 'findlf', 'linestart', 'drawrow').
// Outside the library block, so the library stamp does not depend on them.
// The text is in bank $20 at offsets below 64 KB.
const EDIT_ASM = `
	.al
	.xl
; findlf(p, limit: word): word - offset of the first LF in $20:p..limit-1, or limit
rt_findlf
	rep #$30
	phb
	lda 5,s                 ; limit
	sec
	sbc 7,s                 ; - p = bytes to look at
	tay
	lda 7,s
	tax
	cpy #0
	beq _fl_done
	pea $2020
	plb
	plb
	sep #$20
	.as
_fl_loop
	lda @w $0000,x
	cmp #10
	beq _fl_found
	inx
	dey
	bne _fl_loop
_fl_found
	rep #$20
	.al
_fl_done
	plb
	txa
	rtl

; linestart(p: word): word - offset of the start of the line that holds $20:p
rt_linestart
	rep #$30
	phb
	lda 5,s
	tax
	pea $2020
	plb
	plb
	sep #$20
	.as
_ls_loop
	cpx #0
	beq _ls_done
	dex
	lda @w $0000,x
	cmp #10
	bne _ls_loop
	inx
_ls_done
	rep #$20
	.al
	plb
	txa
	rtl

; drawrow(scr, text, n, attr, plain: word) - one screen row of 80 cells at
; $00:scr: n characters from $20:text with the colours from $00:attr, then
; blanks with the word plain (colour * 256 + 32). Pointers in rt_t0..rt_fp.
rt_drawrow
	rep #$30
	phd
	lda #rt_t0
	tcd
	lda 12,s                ; text
	sta $00
	lda #$0020
	sta $02
	lda 8,s                 ; attr
	sta $04
	stz $06
	lda 14,s                ; scr
	sta $08
	stz $0a
	lda 10,s                ; n
	sta $0c
	ldy #0
	ldx #80
_dr_loop
	cpy $0c
	bcs _dr_blank
	sep #$20
	.as
	lda [$04],y
	xba
	lda [$00],y
	rep #$20
	.al
	sta [$08]
	bra _dr_next
_dr_blank
	lda 6,s                 ; plain
	sta [$08]
_dr_next
	inc $08
	inc $08
	iny
	dex
	bne _dr_loop
	pld
	rtl
`;

// The debugger (65C816 programs): every statement of an F5 build with
// breakpoints calls rt_dbghook (JSL). State at $3D:7F00: +0 line (unit in
// bits 12-15), +2 mode (0 breakpoints only, 1 into, 2 over, 3 to the line at
// +8), +3 1 = stopped, +4 D (the frame) of the last stop, +8 line, +10 the host's stop
// handler (3 bytes), +16 S, +18 D, +20 DB of the stopped program (P is on its
// stack, then the return address). Breakpoints: a bitmap at $3D:7000.
// The host (the 65C816 editor here, or the SCHUB editor's stub) swaps bank 0:
// the program's goes to bank $34 while the editor shows where it stopped.
// Outside the library block (the stamp stays).
const DEBUG_ASM = `
DBG = $3D7F00
DBGBITS = $3D7000
rt_dbghook
	php
	rep #$30
	.al
	.xl
	lda @l DBG+24             ; in IntProc (an interrupt): never stop there
	bne dh_ret
	lda @l DBG+2
	and #$00FF
	beq dh_bp
	cmp #1
	beq dh_stop
	cmp #2
	bne dh_to
	tdc                       ; D: the frame pointer (S would also count a
	cmp @l DBG+4              ; for loop's end value on the stack)
	bcs dh_stop               ; the frame of the last stop, or an outer one
	bra dh_bp
dh_to
	lda @l DBG
	cmp @l DBG+8
	beq dh_stop
dh_bp
	lda @l DBG
	cmp #$1000
	bcs dh_ret                ; a unit's line
	pha
	lsr a
	lsr a
	lsr a
	tax
	pla
	and #7
	tay
	lda @l DBGBITS,x
	and #$00FF
	cpy #0
	beq +
-	lsr a
	dey
	bne -
+	lsr a
	bcs dh_stop
dh_ret
	plp
	rtl
dh_stop
	tsc
	sta @l DBG+16
	tdc
	sta @l DBG+4
	sta @l DBG+18
	sep #$20
	.as
	phb
	pla
	sta @l DBG+20
	lda #1
	sta @l DBG+3
	lda @l DBG+12             ; on to the host's handler
	pha
	rep #$20
	.al
	lda @l DBG+10
	dec a
	pha
	rtl

; the 65C816 editor's stop handler: the program's bank 0 to $34, the
; editor's back from $31 (rt_runuser kept it there), then back to the editor
; as if rt_runuser / rt_dbgresume had returned
rt_dbgstop_ed
	rep #$30
	.al
	.xl
	phb
	ldx #$2000
	ldy #$2000
	lda #$97FF
	mvn #$00,#$34
	plb
	ldx #$2000
	ldy #$2000
	lda #$97FF
	mvn #$31,#$00
	lda @l RUNSAVE+4
	tcs
	lda @l RUNSAVE+6
	tcd
	rtl

; external 'dbgresume': the stopped program goes on (like rt_runuser: it
; returns when the program ends or stops again)
rt_dbgresume
	rep #$30
	.al
	.xl
	tsc
	sta @l RUNSAVE+4
	tdc
	sta @l RUNSAVE+6
	ldx #$2000
	ldy #$2000
	lda #$97FF
	mvn #$00,#$31
	ldx #$2000
	ldy #$2000
	lda #$97FF
	mvn #$34,#$00
	lda @l DBG+16
	tcs
	lda @l DBG+18
	tcd
	sep #$20
	.as
	lda @l DBG+20
	pha
	plb
	lda #0
	sta @l DBG+3
	plp
	rtl

; external 'dbgsetvec': the hook stops into rt_dbgstop_ed
rt_dbgsetvec
	php
	rep #$30
	.al
	lda #rt_dbgstop_ed & $ffff
	sta @l DBG+10
	sep #$20
	.as
	lda #^rt_dbgstop_ed
	sta @l DBG+12
	plp
	rtl
`;

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
  'rt_libinit', 'rt_error', 'rt_runuser', 'rt_dbghook', ...RT_VARS_CART.map(v => v[0])];

export function buildCartridge(source, fileName, opts) {
  const target = TARGETS.m816;
  const res = { ok: false, errors: [] };
  try {
    const front = new Front(target, {
      loadSource: opts.loadUnit, loadInclude: opts.loadInclude || includeNextTo,
      defines: [...target.defines, 'CARTRIDGE'],
    });
    let prog = front.compileProgram(source, fileName);
    const libModules = new Set(['system', ...(opts.libUnits || [])]);
    for (const u of libModules) if (!front.units.has(u)) throw new CompileError(`the cartridge program must use unit '${u}'`);
    const unitOrder = [...libModules];
    // the C library joins the library block
    if (!opts.loadC) opts = { ...opts, loadC: cLoaders().loadC };
    const clib = buildCLib(target, front, opts.loadC);
    prog = { ...prog, procs: [...prog.procs, ...clib.procs], data: [...prog.data, ...clib.data], bss: [...prog.bss, ...clib.bss] };
    const codeModules = new Set(libModules);
    for (const m of clib.modules) codeModules.add(m);

    // keep every library routine (programs compiled on the MERIDIAN may call
    // any of them) and what the main program reaches
    const procs = new Map(prog.procs.map(p => [p.label, p]));
    const live = new Set();
    const work = [prog.main, ...prog.inits, ...prog.procs.filter(p => codeModules.has(p.module)).map(p => p.label)];
    while (work.length) {
      const l = work.pop();
      if (live.has(l)) continue;
      const p = procs.get(l);
      if (!p) continue;
      live.add(l);
      for (const ins of p.code) { if (ins.o === 'call') work.push(ins.l); if ((ins.o === 'gaddr' || ins.o === 'faddr') && typeof ins.g === 'string') work.push(ins.g); }
      if (p.parent) work.push(p.parent);
    }
    prog = { ...prog, procs: prog.procs.filter(p => live.has(p.label)) };

    const libInits = prog.inits.filter(l => libModules.has(l.replace(/^U_|_init$/g, '')));
    const progInits = prog.inits.filter(l => !libInits.includes(l));
    libInits.push('CLIBINIT');
    const exp = buildExports(front, libModules, { unitOrder, cExports: clib.exports });
    const rv = buildRvLibrary(opts, [...libModules].filter(u => u !== 'system'));
    const rvExp = buildExports(rv.front, libModules, {
      prefix: 'R', rt: RT_EXPORTS_RV, unitOrder, cExports: rv.clib.exports,
      resolve: (l) => { const v = rv.symbols.get(l); if (v === undefined) throw new CompileError(`SCHUB library: no symbol ${l}`); return v; },
    });
    const hdr = cHeaderBlob();
    const rvAsm = `\t.bankfit\nCHEADERS\n${byteLines(hdr.bytes)}\n${cTablesAsm(unitOrder)}${rvExp.asm}\t.bankfit\nRVLIBIMG\n${byteLines(rv.bytes)}\nRVLIBIMG_END\nRVSTUBIMG\n${byteLines(rv.stub)}\nRVSTUBIMG_END\n`;
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
; the C headers and tables for the on-device C compiler (cart/ccomp.inc)
	.long CHEADERS
	.long CMSGS
	.long CKEYWORDS
	.long CUNITS
	.al
	.xl
; the library block: $40:0000..LIBCODE_END, stamped from here on
LIBCODE_START
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
    // the cartridge's start code, after the program (it names the program,
    // so it stays out of the library block)
    const se = schubEditorAsm(opts.schubEditor);
    const boot = `
	.al
	.xl
cart_start
	phb
	phd
	php
${se.boot}
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
	jml rt_exit
`;
    const asm = gen816(prog, { far: true, cart: { header, libModules: codeModules, tailAsm: boot + EDIT_ASM + helpAsm816() + DEBUG_ASM + exp.asm + rvAsm + MER_STUB + se.image } });
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

// The SCHUB build of the editor (compiler/mkschubide.js), if given: the
// cartridge starts it instead of the 65C816 editor when the core has SCHUB.
// The boot code copies the image (stored bank-aligned) from the ROM to its
// place ($A0:0000) and calls its host stub; when the editor ends with F10 it
// goes back to BASIC like the 65C816 editor, with Ctrl+F10 (flag at $B0:0000)
// on to the 65C816 editor. Ctrl held down at the start also picks the 65C816
// editor; a MiSTer cannot pass on a key held while the core loads, so that
// is for the emulator and the tests. Outside the library block, so the
// library stamp stays.
function schubEditorAsm(ed) {
  if (!ed) return { boot: '', image: '' };
  const n = ed.image.length;
  const banks = Math.ceil(n / 0x10000);
  const dst = ed.load >> 16;
  if (ed.load & 0xffff) throw new CompileError('the SCHUB editor must start at a bank boundary');
  let copy = '';
  for (let k = 0; k < banks; k++) {
    const len = Math.min(0x10000, n - k * 0x10000);
    copy += `\tldx #0\n\tldy #0\n\tlda #$${(len - 1).toString(16)}\n\tmvn #^SCHUBED+${k},#$${(dst + k).toString(16)}\n`;
  }
  const boot = `
	sep #$20
	rep #$10
	.as
	.xl
	lda @l $00CD00          ; SCHUB there ("SC")?
	cmp #$53
	bne cs_816
	lda @l $00CD01
	cmp #$43
	bne cs_816
	lda @l $033E14          ; Ctrl held down at the start (the tests do it): the 65C816 editor
	bne cs_816
	rep #$30
	.al
	phb
${copy}	plb
	sep #$20
	.as
	lda #0
	sta @l $B00000          ; set by the SCHUB editor on Ctrl+F10
	jsl $${ed.load.toString(16)}            ; the SCHUB editor (its host stub)
	sep #$20
	rep #$10
	lda @l $B00000          ; Ctrl+F10: on to the 65C816 editor,
	beq cs_basic
-	lda @l $033E09          ; once F10 is let go (it would end that one, too)
	bne -
	bra cs_816
cs_basic
	plp
	pld
	plb
	rtl
cs_816
	.al
	.xl`;
  const image = `\t.align $10000\nSCHUBED\n${byteLines(ed.image)}\nSCHUBED_END\n`;
  return { boot, image };
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
    // the unit's number (0 System, then as the cartridge lists them): C sees
    // the units it names with #pragma unit
    const unit = o.unitOrder ? o.unitOrder.indexOf(uname) : 0;
    const add = (name, e) => { if (!entries.has(name)) entries.set(name, { ...e, unit }); };
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
  for (const r of (o.rt || RT_EXPORTS)) add(r, { kind: 6, code: 0, ref: 0, value: val(r), unit: 255 });
  // the C library: kind 7 a function, 8 a variable (the headers give the types)
  for (const c of o.cExports || []) add(c.name, { kind: c.kind, code: 0, ref: 0, value: val(c.label), unit: 254 });
  const names = [...entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = ['\t.bankfit', '; ---- export table for the on-device compiler', `${P}EXPORTS`];
  for (const n of names) {
    const e = entries.get(n);
    lines.push(`\t.byte ${n.length}\n\t.text "${n}"\n\t.fill ${19 - n.length}\n\t.byte ${e.kind}, ${e.code}\n\t.dword ${e.value}\n\t.word ${e.ref}\n\t.byte ${e.npar || 0}, ${e.flags || 0}\n\t.word ${e.pidx || 0}\n\t.byte ${e.unit || 0}\n\t.fill 7`);
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
