// MERIDIAN Pascal - the PASCAL cartridge's editor, compiler and assembler
// (cart/ide.pas) built as a SCHUB program: a test of running them on the
// RV32IM co-processor instead of the 65C816.
//
//   node compiler/mkschubide.js [-o PASCALRV.MER]
//
// The result is an ordinary SCHUB .MER (65C816 host stub at $04:0000, RV32
// code from $04:0400). It needs the PASCAL cartridge inserted: the on-device
// compiler links programs against the library and tables in its ROM.
// Not done yet: F5 / Ctrl+R (running a program from the editor).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Front } from './front.js';
import { TARGETS, makeMer } from './compile.js';
import { genRV, RVLAYOUT } from './backrv.js';
import { assembleRV } from './asmrv.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// the routines cart/ide.pas, ncomp.pas and nasm.pas declare external.
// Arguments are on the stack, the last one at 0(sp); results in a0;
// s0..s11 and sp must survive (the expression stack lives in s1..s11).
// The text is in bank $20 (offsets below 64 KB), read through the uncached
// alias because the editor writes it with Mem[] and the blitter.
const EXTERNALS_RV = String.raw`
# ---- cartridge externals (SCHUB)
TEXT_U = 0x80200000

# findlf(p, limit: word): word - offset of the first LF in $20:p..limit-1, or limit
rt_findlf:
	lw a1, 0(sp)
	lw a0, 4(sp)
	li t0, TEXT_U
	li t3, 10
	add t1, t0, a0
	add t4, t0, a1
.fl_loop:
	bgeu t1, t4, .fl_end
	lbu t2, 0(t1)
	beq t2, t3, .fl_end
	addi t1, t1, 1
	j .fl_loop
.fl_end:
	sub a0, t1, t0
	ret

# linestart(p: word): word - offset of the start of the line that holds $20:p
rt_linestart:
	lw a0, 0(sp)
	li t0, TEXT_U
	li t3, 10
	add t1, t0, a0
.ls_loop:
	beq t1, t0, .ls_end
	lbu t2, -1(t1)
	beq t2, t3, .ls_end
	addi t1, t1, -1
	j .ls_loop
.ls_end:
	sub a0, t1, t0
	ret

# drawrow(scr, text, n: word; attr: pointer; plain: word) - one screen row of
# 80 cells at $00:scr: n characters from $20:text with the colours at attr,
# then blanks with the word plain
rt_drawrow:
	lw a0, 16(sp)
	lw a1, 12(sp)
	lw a2, 8(sp)
	lw a3, 4(sp)
	lw a4, 0(sp)
	li t0, 0x80000000
	add a0, a0, t0
	li t0, TEXT_U
	add a1, a1, t0
	li t4, 80
.dr_loop:
	beqz t4, .dr_end
	beqz a2, .dr_blank
	lbu t1, 0(a1)
	lbu t2, 0(a3)
	slli t2, t2, 8
	or t1, t1, t2
	sh t1, 0(a0)
	addi a1, a1, 1
	addi a3, a3, 1
	addi a2, a2, -1
	j .dr_next
.dr_blank:
	sh a4, 0(a0)
.dr_next:
	addi a0, a0, 2
	addi t4, t4, -1
	j .dr_loop
.dr_end:
	ret

# catch: integer - 0 now, 1 when throw comes back here (the on-device
# compiler and assembler stop at their first error this way)
rt_catch:
	la t0, .catch_buf
	sw sp, 0(t0)
	sw ra, 4(t0)
	sw s0, 8(t0)
	sw s1, 12(t0)
	sw s2, 16(t0)
	sw s3, 20(t0)
	sw s4, 24(t0)
	sw s5, 28(t0)
	sw s6, 32(t0)
	sw s7, 36(t0)
	sw s8, 40(t0)
	sw s9, 44(t0)
	sw s10, 48(t0)
	sw s11, 52(t0)
	li a0, 0
	ret
rt_throw:
	la t0, .catch_buf
	lw sp, 0(t0)
	lw ra, 4(t0)
	lw s0, 8(t0)
	lw s1, 12(t0)
	lw s2, 16(t0)
	lw s3, 20(t0)
	lw s4, 24(t0)
	lw s5, 28(t0)
	lw s6, 32(t0)
	lw s7, 36(t0)
	lw s8, 40(t0)
	lw s9, 44(t0)
	lw s10, 48(t0)
	lw s11, 52(t0)
	li a0, 1
	ret

# runuser(entry: longint), runmer: integer - running programs from the
# editor is not there yet: nothing happens / DOS error 255
rt_runuser:
	ret
rt_runmer:
	li a0, 255
	ret

	.align 4
.catch_buf:
	.fill 56
`;

export function buildSchubIde() {
  const dirs = [path.join(root, 'cart'), path.join(root, 'lib')];
  const loadUnit = (name) => {
    for (const d of dirs) {
      const p = path.join(d, name + '.pas');
      if (fs.existsSync(p)) return { text: fs.readFileSync(p, 'latin1'), name: p };
    }
    return null;
  };
  const tgt = TARGETS.schub;
  const front = new Front(tgt, { loadSource: loadUnit, defines: [...tgt.defines] });
  const main = path.join(root, 'cart', 'ide.pas');
  const prog = front.compileProgram(fs.readFileSync(main, 'latin1'), main);
  // the code reaches past $08:0000, so the stack goes higher than usual.
  // Not solved yet: a SCHUB program compiled on the device goes to
  // $08:0000 (NComp.RvCode), over this code.
  const stackTop = 0x0ffff0;
  let { asm, stub } = genRV(prog, { stackTop });
  // the externals go before the bss (which is cleared at start, not saved)
  const at = asm.indexOf('\nPAS_BSS:');
  if (at < 0) throw new Error('PAS_BSS not found');
  asm = asm.slice(0, at) + '\n' + EXTERNALS_RV + asm.slice(at);
  const a = assembleRV(asm, { org: RVLAYOUT.CODE });
  const bss = a.symbols.get('PAS_BSS');
  const code = a.bytes.slice(0, bss - RVLAYOUT.CODE);
  const img = new Uint8Array(RVLAYOUT.CODE - RVLAYOUT.LOAD + code.length);
  img.set(stub.bytes, 0);
  img.set(code, RVLAYOUT.CODE - RVLAYOUT.LOAD);
  return {
    mer: makeMer(img, RVLAYOUT.LOAD, RVLAYOUT.LOAD, true),
    symbols: a.symbols,
    info: { codeEnd: bss, heap: a.symbols.get('PAS_HEAP'), stackTop },
  };
}

if (process.argv[1] && process.argv[1].endsWith('mkschubide.js')) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('-o');
  const out = oi >= 0 ? args[oi + 1] : path.join(root, 'PASCALRV.MER');
  const r = buildSchubIde();
  fs.writeFileSync(out, r.mer);
  const hx = (v) => '$' + v.toString(16).toUpperCase();
  console.log(`${out}: ${r.mer.length} bytes, code and data to ${hx(r.info.codeEnd)}, variables to ${hx(r.info.heap)}, stack top ${hx(r.info.stackTop)}`);
}
