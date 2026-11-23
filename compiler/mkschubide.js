// MERIDIAN Pascal - the PASCAL cartridge's editor, compiler and assembler
// (cart/ide.pas) built as a SCHUB program: a test of running them on the
// RV32IM co-processor instead of the 65C816.
//
//   node compiler/mkschubide.js [-o PASCALRV.MER]
//
// The result is a SCHUB .MER that lives in banks $A0-$AF, away from
// everything a program on the MERIDIAN uses: the 65C816 host stub at
// $A0:0000, its mailbox at $A0:03F0, the RV32 code from $A0:0400 and the
// stack below $B0:0000. So SCHUB programs compiled with it can keep their
// usual places ($04:0000-$1F:FFFF), and the editor's work areas stay in
// banks $20-$3C as on the 65C816. (Officially SONG may use $80-$BF for the
// song it plays; the editor plays none.) It needs the PASCAL cartridge
// inserted: the on-device compiler links programs against the library and
// tables in its ROM.
// F5 and Ctrl+R run programs through its host stub (request 8), which keeps
// bank 0 in bank $B0 meanwhile.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Front } from './front.js';
import { TARGETS, makeMer } from './compile.js';
import { genRV } from './backrv.js';
import { assembleRV } from './asmrv.js';

// RUN: its host stub can run programs while the editor waits (request 8)
export const IDE_LAYOUT = { LOAD: 0xa00000, MBOX: 0xa003f0, CODE: 0xa00400, STACK_TOP: 0xaffff0, RUN: true };

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

# runuser(entry: longint): run the program at entry (JSL on the 65C816);
# runmer: integer: load and run the .MER named at $16C0, the DOS error or 0.
# The host stub does it (request 8): it stops SCHUB, runs the program -
# which may be a SCHUB program, so SCHUB cannot simply wait - and restarts
# SCHUB at .run_resume, which takes the registers back and returns.
rt_runuser:
	lw a1, 0(sp)
	j .run_go
rt_runmer:
	li a1, 0xffffff
.run_go:
	la t0, .run_buf
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
	li t0, MBOX_U
	sw a1, 8(t0)
	la t1, .run_resume
	sw t1, 12(t0)
	li t1, 8
	sw t1, 4(t0)
	li t1, 1
	sw t1, 0(t0)
.run_wait:
	j .run_wait              # the 65C816 stops SCHUB here
.run_resume:
	la t0, .run_buf
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
	li t0, MBOX_U
	lw a0, 12(t0)
	ret

	.align 4
.catch_buf:
	.fill 56
.run_buf:
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
  const L = IDE_LAYOUT;
  const stackTop = L.STACK_TOP;
  let { asm, stub } = genRV(prog, { stackTop, layout: L });
  // the externals go before the bss (which is cleared at start, not saved)
  const at = asm.indexOf('\nPAS_BSS:');
  if (at < 0) throw new Error('PAS_BSS not found');
  const ext = `MBOX_U = 0x${((L.MBOX | 0x80000000) >>> 0).toString(16)}\n` + EXTERNALS_RV;
  asm = asm.slice(0, at) + '\n' + ext + asm.slice(at);
  const a = assembleRV(asm, { org: L.CODE });
  const bss = a.symbols.get('PAS_BSS');
  const code = a.bytes.slice(0, bss - L.CODE);
  if (a.symbols.get('PAS_HEAP') > stackTop - 0x10000) throw new Error('the SCHUB editor does not fit below its stack');
  const img = new Uint8Array(L.CODE - L.LOAD + code.length);
  img.set(stub.bytes, 0);
  img.set(code, L.CODE - L.LOAD);
  return {
    mer: makeMer(img, L.LOAD, L.LOAD, true),
    image: img,            // for the cartridge, which copies it to L.LOAD
    load: L.LOAD,
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
