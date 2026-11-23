// MERIDIAN Pascal - SCHUB (RV32IM) back end
//
// Memory (MERIDIAN address space = RISC-V address space, bank $04 upwards):
//   $04:0000  65C816 host stub (started by the kernel with JSL)
//   $04:03F0  mailbox (16 bytes; SCHUB uses the uncached alias $8004_03F0)
//   $04:0400  RV32IM code, data, bss, heap ...
//   $08:0000  top of the SCHUB stack (grows down)
//
// Frame (s0 = frame pointer):
//   s0+8 ...       parameters (4 bytes each; static link first)
//   s0+4 / s0+0    return address / caller's s0
//   s0-FS .. s0-1  locals and temporaries
//   below          saved s1..sN
// Expression stack: depth d lives in register s(d+1) (callee-saved),
// so calls never have to spill it. Results come back in a0.

import { assemble816, formatListing } from './asm816.js';

export const RVLAYOUT = {
  LOAD: 0x040000,
  MBOX: 0x0403f0,
  CODE: 0x040400,
  STACK_TOP: 0x07fff0,
  UNCACHED: 0x80000000,
};

const SREGS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11'];
const fits12 = (v) => v >= -2048 && v <= 2047;
const h = (v) => '0x' + (v >>> 0).toString(16);

export function genRV(prog, opts = {}) {
  opts = opts || {};
  const out = [];
  const E = (s) => out.push('\t' + s);
  const LBL = (s) => out.push(s + ':');
  let uniq = 0;
  const u = (p = 'l') => `.${p}${++uniq}`;
  const procByLabel = new Map(prog.procs.map(p => [p.label, p]));

  out.push('# MERIDIAN Pascal - SCHUB RV32IM output');
  LBL('PAS_START');
  E(`li sp, ${h(opts.stackTop || RVLAYOUT.STACK_TOP)}`);
  E('la t0, PAS_BSS');
  E('la t1, PAS_BSS_END');
  const lc = u('c');
  LBL(lc);
  E('sw zero, 0(t0)');
  E('addi t0, t0, 4');
  E(`bltu t0, t1, ${lc}`);
  for (const l of prog.inits) E(`call ${l}`);
  if (opts.userEntry) {
    // library build for the on-device compiler: the program follows at userEntry
    E(`li t0, ${h(opts.userEntry)}`);
    E('jalr ra, 0(t0)');
  } else E(`call ${prog.main}`);
  E('li a0, 0');
  E('j rt_exit');

  for (const p of prog.procs) genProc(p);

  // opts.layout { LOAD, MBOX, CODE }: a program that does not live at $04:0000
  const layout = opts.layout || RVLAYOUT;
  let rt = RUNTIME_RV.replace(/MBOXADDR/g, h((layout.MBOX | RVLAYOUT.UNCACHED) >>> 0));
  // the heap starts where the loader says (programs compiled on the MERIDIAN)
  if (opts.heapVar) rt = rt.replace(/rt_heaporg:\n\tla a0, PAS_HEAP\n/, `rt_heaporg:\n\tli t0, ${h(opts.heapVar)}\n\tlw a0, 0(t0)\n`);
  out.push(rt);
  if (opts.debugHook) out.push(DEBUG_RV);

  out.push('# ---- data');
  E('.align 4');
  for (const d of prog.data) {
    E(`.align ${Math.max(d.align || 1, 1)}`);
    LBL(d.label);
    for (let i = 0; i < d.bytes.length; i += 16) E('.byte ' + d.bytes.slice(i, i + 16).join(','));
  }
  E('.align 4');
  LBL('PAS_BSS');
  for (const b of prog.bss) {
    E(`.align ${Math.max(b.align || 1, 1)}`);
    LBL(b.label);
    E(`.fill ${b.size}`);
  }
  E('.align 4');
  LBL('PAS_BSS_END');
  LBL('PAS_HEAP');

  return { asm: out.join('\n') + '\n', stub: buildStub(layout) };

  // ================================================================
  function genProc(p) {
    const FS = Math.ceil(p.locSize / 4) * 4;
    const body = [];
    const B = (s) => body.push('\t' + s);
    const BL = (s) => body.push(s + ':');
    let depth = 0, maxDepth = 0;
    const consts = new Map(); // depth index -> pending constant value
    const labelDepth = new Map();
    const reg = (d) => {
      if (d >= SREGS.length) throw new Error(`expression too complex in ${p.name} (more than ${SREGS.length} values)`);
      return SREGS[d];
    };
    const pushR = () => { const r = reg(depth); depth++; if (depth > maxDepth) maxDepth = depth; consts.delete(depth - 1); return r; };
    const pushC = (v) => { reg(depth); consts.set(depth, v); depth++; if (depth > maxDepth) maxDepth = depth; };
    const isC = (d) => consts.has(d);
    const mat = (d) => { if (consts.has(d)) { B(`li ${reg(d)}, ${fmtV(consts.get(d))}`); consts.delete(d); } return reg(d); };
    const matAll = () => { for (let d = 0; d < depth; d++) mat(d); };
    const popR = () => { depth--; const r = mat(depth); return r; };
    const fmtV = (v) => typeof v === 'number' ? String(v | 0) : v;
    const norm = (r, mt) => {
      switch (mt) {
        case 's16': B(`slli ${r}, ${r}, 16`); B(`srai ${r}, ${r}, 16`); break;
        case 'u16': B(`slli ${r}, ${r}, 16`); B(`srli ${r}, ${r}, 16`); break;
        case 's8': B(`slli ${r}, ${r}, 24`); B(`srai ${r}, ${r}, 24`); break;
        case 'u8': B(`andi ${r}, ${r}, 255`); break;
      }
    };
    const normW = (r, unsigned) => norm(r, unsigned ? 'u16' : 's16');
    const LD = { u8: 'lbu', s8: 'lb', u16: 'lhu', s16: 'lh', '32': 'lw' };
    const ST = { u8: 'sb', s8: 'sb', u16: 'sh', s16: 'sh', '32': 'sw' };
    // memory access at base register + offset
    const memOp = (op, r, base, off) => {
      if (fits12(off)) B(`${op} ${r}, ${off}(${base})`);
      else { B(`li t2, ${off}`); B(`add t2, t2, ${base}`); B(`${op} ${r}, 0(t2)`); }
    };
    // t0 = frame pointer `hops` levels out; returns owning proc
    const frameT0 = (hops) => {
      B('lw t0, 8(s0)');
      let cur = procByLabel.get(p.parent);
      for (let i = 1; i < hops; i++) { B('lw t0, 8(t0)'); cur = procByLabel.get(cur.parent); }
      return cur;
    };
    // address of a frame slot: returns [base, offset or symbolic]
    const slot = (hops, kind, off) => {
      if (hops === 0) return ['s0', kind === 'loc' ? off - FS : 8 + off, true];
      const owner = frameT0(hops);
      if (kind === 'par') return ['t0', 8 + off, true];
      // local of an outer frame: offset depends on its frame size
      B(`li t1, ${off}-FS_${owner.label}`);
      B('add t0, t0, t1');
      return ['t0', 0, true];
    };
    const branch = (c, unsigned, a, b, target) => {
      const U = unsigned ? 'u' : '';
      switch (c) {
        case 'eq': B(`beq ${a}, ${b}, ${target}`); break;
        case 'ne': B(`bne ${a}, ${b}, ${target}`); break;
        case 'lt': B(`blt${U} ${a}, ${b}, ${target}`); break;
        case 'ge': B(`bge${U} ${a}, ${b}, ${target}`); break;
        case 'gt': B(`blt${U} ${b}, ${a}, ${target}`); break;
        case 'le': B(`bge${U} ${b}, ${a}, ${target}`); break;
      }
    };
    const setJumpDepth = (l) => { labelDepth.set(l, depth); };

    for (const ins of p.code) {
      switch (ins.o) {
        case 'line': body.push(`# line ${ins.line} ${ins.file || ''}`); break;
        case 'lit': pushC(ins.v); break;
        case 'gaddr': {
          if (typeof ins.g === 'number') pushC(ins.g + ins.off);
          else { const r = pushR(); B(`la ${r}, ${ins.g}${ins.off ? '+' + ins.off : ''}`); }
          break;
        }
        case 'laddr': {
          const r = reg(depth);
          if (ins.hops === 0) {
            const o = ins.kind === 'loc' ? ins.off - FS : 8 + ins.off;
            if (fits12(o)) B(`addi ${r}, s0, ${o}`); else { B(`li ${r}, ${o}`); B(`add ${r}, ${r}, s0`); }
          } else {
            const [base, o] = slot(ins.hops, ins.kind, ins.off);
            B(`addi ${r}, ${base}, ${o}`);
          }
          pushR();
          break;
        }
        case 'fp': {
          const r = reg(depth);
          if (ins.hops === 0) B(`mv ${r}, s0`);
          else { frameT0(ins.hops); B(`mv ${r}, t0`); }
          pushR();
          break;
        }
        case 'ldl': {
          const r = reg(depth);
          const [base, o] = slot(ins.hops, ins.kind, ins.off);
          memOp(LD[ins.mt], r, base, o);
          pushR();
          break;
        }
        case 'stl': {
          const v = popR();
          const [base, o] = slot(ins.hops, ins.kind, ins.off);
          memOp(ST[ins.mt], v, base, o);
          break;
        }
        case 'ldg': {
          const r = reg(depth);
          if (typeof ins.g === 'number') B(`li t0, ${h((ins.g + ins.off) >>> 0)}`);
          else B(`la t0, ${ins.g}${ins.off ? '+' + ins.off : ''}`);
          B(`${LD[ins.mt]} ${r}, 0(t0)`);
          pushR();
          break;
        }
        case 'stg': {
          const v = popR();
          if (typeof ins.g === 'number') B(`li t0, ${h((ins.g + ins.off) >>> 0)}`);
          else B(`la t0, ${ins.g}${ins.off ? '+' + ins.off : ''}`);
          B(`${ST[ins.mt]} ${v}, 0(t0)`);
          break;
        }
        case 'ldabs': {
          const r = reg(depth);
          B(`li t0, ${h((ins.a | RVLAYOUT.UNCACHED) >>> 0)}`);
          B(`${LD[ins.mt]} ${r}, 0(t0)`);
          pushR();
          break;
        }
        case 'stabs': {
          const v = popR();
          B(`li t0, ${h((ins.a | RVLAYOUT.UNCACHED) >>> 0)}`);
          B(`${ST[ins.mt]} ${v}, 0(t0)`);
          break;
        }
        case 'ld': {
          const a = popR();
          memOp(LD[ins.mt], reg(depth), a, ins.off);
          pushR();
          break;
        }
        case 'st': {
          const v = popR();
          const a = popR();
          memOp(ST[ins.mt], v, a, ins.off);
          break;
        }
        case 'ldfar': {
          const a = popR();
          B(`li t1, ${h(RVLAYOUT.UNCACHED)}`);
          B(`or t0, ${a}, t1`);
          memOp(LD[ins.mt], reg(depth), 't0', ins.off);
          pushR();
          break;
        }
        case 'stfar': {
          const v = popR();
          const a = popR();
          B(`li t1, ${h(RVLAYOUT.UNCACHED)}`);
          B(`or t0, ${a}, t1`);
          memOp(ST[ins.mt], v, 't0', ins.off);
          break;
        }
        case 'add': case 'sub': case 'and': case 'or': case 'xor': {
          const W = ins.s === 'W';
          if (isC(depth - 1)) {
            const c = consts.get(depth - 1);
            if (typeof c === 'number') {
              const v = ins.o === 'sub' ? -(c | 0) : (c | 0);
              const imm = { add: 'addi', sub: 'addi', and: 'andi', or: 'ori', xor: 'xori' }[ins.o];
              if (fits12(v)) {
                consts.delete(depth - 1); depth--;
                const a = popR();
                B(`${imm} ${a}, ${a}, ${v}`);
                pushR();
                if (W && (ins.o === 'add' || ins.o === 'sub' || (ins.o === 'xor' && v < 0) || (ins.o === 'or' && v < 0))) normW(a, ins.u);
                break;
              }
            }
          }
          const b = popR(), a = popR();
          B(`${ins.o} ${a}, ${a}, ${b}`);
          pushR();
          if (W && (ins.o === 'add' || ins.o === 'sub')) normW(a, ins.u);
          break;
        }
        case 'mul': case 'div': case 'mod': {
          const b = popR(), a = popR();
          if (ins.o !== 'mul') {
            const ok = u('dz');
            B(`bnez ${b}, ${ok}`);
            B('li a0, 200');
            B('j rt_error');
            BL(ok);
          }
          const op = ins.o === 'mul' ? 'mul' : ins.o === 'div' ? (ins.u ? 'divu' : 'div') : (ins.u ? 'remu' : 'rem');
          B(`${op} ${a}, ${a}, ${b}`);
          pushR();
          if (ins.s === 'W') normW(a, ins.u);
          break;
        }
        case 'shl': case 'shr': {
          const W = ins.s === 'W';
          if (isC(depth - 1) && typeof consts.get(depth - 1) === 'number') {
            const n = consts.get(depth - 1) & 31;
            consts.delete(depth - 1); depth--;
            const a = popR();
            if (ins.o === 'shr' && W) { B(`slli ${a}, ${a}, 16`); B(`srli ${a}, ${a}, ${16 + n}`); }
            else B(`${ins.o === 'shl' ? 'slli' : 'srli'} ${a}, ${a}, ${n}`);
            pushR();
            if (W) normW(a, ins.u);
            break;
          }
          const b = popR(), a = popR();
          if (ins.o === 'shr' && W) { B(`slli ${a}, ${a}, 16`); B(`srli ${a}, ${a}, 16`); }
          B(`${ins.o === 'shl' ? 'sll' : 'srl'} ${a}, ${a}, ${b}`);
          pushR();
          if (W) normW(a, ins.u);
          break;
        }
        case 'neg': {
          if (isC(depth - 1) && typeof consts.get(depth - 1) === 'number') { consts.set(depth - 1, -consts.get(depth - 1)); break; }
          const a = popR(); B(`sub ${a}, zero, ${a}`); pushR();
          if (ins.s === 'W') normW(a, false);
          break;
        }
        case 'not': {
          if (isC(depth - 1) && typeof consts.get(depth - 1) === 'number') {
            let v = ~consts.get(depth - 1);
            if (ins.s === 'W') v = ins.u ? v & 0xffff : ((v & 0xffff) ^ 0x8000) - 0x8000;
            consts.set(depth - 1, v); break;
          }
          const a = popR(); B(`xori ${a}, ${a}, -1`); pushR();
          if (ins.s === 'W') normW(a, ins.u);
          break;
        }
        case 'ext': break; // W values are already sign/zero extended
        case 'trunc': case 'narrow': {
          if (isC(depth - 1) && typeof consts.get(depth - 1) === 'number') {
            let v = consts.get(depth - 1) >>> 0;
            if (ins.mt === 'u8') v &= 0xff;
            else if (ins.mt === 's8') v = ((v & 0xff) ^ 0x80) - 0x80;
            else if (ins.mt === 'u16') v &= 0xffff;
            else if (ins.mt === 's16') v = ((v & 0xffff) ^ 0x8000) - 0x8000;
            consts.set(depth - 1, v);
            break;
          }
          const a = popR(); norm(a, ins.mt); pushR();
          break;
        }
        case 'cmp': {
          const b = popR(), a = popR();
          const U = ins.u ? 'u' : '';
          switch (ins.c) {
            case 'eq': B(`sub ${a}, ${a}, ${b}`); B(`seqz ${a}, ${a}`); break;
            case 'ne': B(`sub ${a}, ${a}, ${b}`); B(`snez ${a}, ${a}`); break;
            case 'lt': B(`slt${U} ${a}, ${a}, ${b}`); break;
            case 'gt': B(`slt${U} ${a}, ${b}, ${a}`); break;
            case 'le': B(`slt${U} ${a}, ${b}, ${a}`); B(`xori ${a}, ${a}, 1`); break;
            case 'ge': B(`slt${U} ${a}, ${a}, ${b}`); B(`xori ${a}, ${a}, 1`); break;
          }
          pushR();
          break;
        }
        case 'jc': {
          let b;
          if (isC(depth - 1) && consts.get(depth - 1) === 0) { consts.delete(depth - 1); depth--; b = 'zero'; }
          else b = popR();
          const a = popR();
          matAll();
          setJumpDepth(ins.l);
          branch(ins.c, ins.u, a, b, ins.l);
          break;
        }
        case 'jz': case 'jnz': {
          if (isC(depth - 1) && typeof consts.get(depth - 1) === 'number') {
            const v = consts.get(depth - 1);
            consts.delete(depth - 1); depth--;
            matAll();
            if ((v === 0) === (ins.o === 'jz')) { setJumpDepth(ins.l); B(`j ${ins.l}`); }
            break;
          }
          const a = popR();
          matAll();
          setJumpDepth(ins.l);
          B(`${ins.o === 'jz' ? 'beqz' : 'bnez'} ${a}, ${ins.l}`);
          break;
        }
        case 'jmp':
          matAll();
          setJumpDepth(ins.l);
          B(`j ${ins.l}`);
          break;
        case 'label':
          matAll();
          if (labelDepth.has(ins.l)) depth = labelDepth.get(ins.l);
          BL(ins.l);
          break;
        case 'dup': {
          if (isC(depth - 1)) { pushC(consts.get(depth - 1)); break; }
          const a = reg(depth - 1);
          const r = pushR();
          B(`mv ${r}, ${a}`);
          break;
        }
        case 'drop':
          if (isC(depth - 1)) consts.delete(depth - 1);
          depth--;
          break;
        case 'arg': {
          let r;
          if (isC(depth - 1) && consts.get(depth - 1) === 0) { consts.delete(depth - 1); depth--; r = 'zero'; }
          else r = popR();
          B('addi sp, sp, -4');
          B(`sw ${r}, 0(sp)`);
          break;
        }
        case 'copy': {
          const src = popR(), dst = popR();
          B(`mv a0, ${dst}`);
          B(`mv a1, ${src}`);
          B(`li a2, ${ins.n}`);
          B('call rt_memcpy');
          break;
        }
        case 'call': {
          matAll();
          B(`call ${ins.l}`);
          if (ins.args) {
            if (fits12(ins.args)) B(`addi sp, sp, ${ins.args}`);
            else { B(`li t0, ${ins.args}`); B('add sp, sp, t0'); }
          }
          if (ins.ret) { const r = pushR(); B(`mv ${r}, a0`); }
          break;
        }
        default:
          throw new Error(`internal: unknown IR op ${ins.o}`);
      }
    }
    if (depth !== 0) throw new Error(`internal: expression stack not empty at end of ${p.name}`);
    // assemble prologue / epilogue around the body
    const nsave = maxDepth;
    out.push('');
    out.push(`# ---- ${p.name} (${p.module})`);
    out.push(`FS_${p.label} = ${FS}`);
    LBL(p.label);
    E('addi sp, sp, -8');
    E('sw ra, 4(sp)');
    E('sw s0, 0(sp)');
    E('mv s0, sp');
    const frame = FS + nsave * 4;
    if (frame) {
      if (fits12(-frame)) E(`addi sp, sp, ${-frame}`);
      else { E(`li t0, ${frame}`); E('sub sp, sp, t0'); }
    }
    for (let i = 0; i < nsave; i++) {
      const o = -FS - 4 * (i + 1);
      if (fits12(o)) E(`sw ${SREGS[i]}, ${o}(s0)`);
      else { E(`li t0, ${o}`); E('add t0, t0, s0'); E(`sw ${SREGS[i]}, 0(t0)`); }
    }
    out.push(...body);
    if (p.retCls) {
      const o = p.resultLoc.off - FS;
      if (fits12(o)) E(`${LD[p.resultLoc.mt]} a0, ${o}(s0)`);
      else { E(`li t0, ${o}`); E('add t0, t0, s0'); E(`${LD[p.resultLoc.mt]} a0, 0(t0)`); }
    }
    for (let i = 0; i < nsave; i++) {
      const o = -FS - 4 * (i + 1);
      if (fits12(o)) E(`lw ${SREGS[i]}, ${o}(s0)`);
      else { E(`li t0, ${o}`); E('add t0, t0, s0'); E(`lw ${SREGS[i]}, 0(t0)`); }
    }
    E('mv sp, s0');
    E('lw s0, 0(sp)');
    E('lw ra, 4(sp)');
    E('addi sp, sp, 8');
    E('ret');
  }
}

// --------------------------------------------------------------------------
// The debugger hook (in the cartridge's SCHUB library): a statement of an F5
// build with breakpoints calls it. The state is at $3D:7F00 (see cart.js,
// DEBUG_ASM): +0 line, +2 mode (0 breakpoints, 1 into, 2 over, 3 to the line
// at +8), +3 stopped, +4 sp of the last stop; breakpoints in a bitmap at
// $3D:7000 (lines of the program, unit 0). To stop, it keeps the registers
// and asks the host stub (request 10) to stop SCHUB and return; the stub's
// entry +2 later starts SCHUB again at .dh_resume.
const DEBUG_RV = String.raw`
# ---- debugger hook (a0-a7, t0-t2 free; s0-s11, sp, gp kept)
rt_dbghook:
	li t0, 0x803D7F00
	lbu t1, 2(t0)
	beqz t1, .dh_bp
	li t2, 1
	beq t1, t2, .dh_stop
	li t2, 2
	bne t1, t2, .dh_to
	lw t2, 4(t0)
	bgeu sp, t2, .dh_stop
	j .dh_bp
.dh_to:
	lhu t1, 0(t0)
	lhu t2, 8(t0)
	beq t1, t2, .dh_stop
.dh_bp:
	lhu t1, 0(t0)
	srli t2, t1, 12
	bnez t2, .dh_ret
	srli t2, t1, 3
	li a0, 0x803D7000
	add a0, a0, t2
	lbu a0, 0(a0)
	andi t1, t1, 7
	srl a0, a0, t1
	andi a0, a0, 1
	bnez a0, .dh_stop
.dh_ret:
	ret
.dh_stop:
	la t0, rt_dbgregs
	sw ra, 0(t0)
	sw sp, 4(t0)
	sw gp, 8(t0)
	sw s0, 12(t0)
	sw s1, 16(t0)
	sw s2, 20(t0)
	sw s3, 24(t0)
	sw s4, 28(t0)
	sw s5, 32(t0)
	sw s6, 36(t0)
	sw s7, 40(t0)
	sw s8, 44(t0)
	sw s9, 48(t0)
	sw s10, 52(t0)
	sw s11, 56(t0)
	li t0, 0x803D7F00
	sw sp, 4(t0)
	li t1, 1
	sb t1, 3(t0)
	li a0, 10
	la a1, .dh_resume
	call rt_sys
.dh_resume:
	la t0, rt_dbgregs
	lw ra, 0(t0)
	lw sp, 4(t0)
	lw gp, 8(t0)
	lw s0, 12(t0)
	lw s1, 16(t0)
	lw s2, 20(t0)
	lw s3, 24(t0)
	lw s4, 28(t0)
	lw s5, 32(t0)
	lw s6, 36(t0)
	lw s7, 40(t0)
	lw s8, 44(t0)
	lw s9, 48(t0)
	lw s10, 52(t0)
	lw s11, 56(t0)
	li t0, 0x803D7F00
	sb zero, 3(t0)
	ret
	.align 4
rt_dbgregs:
	.fill 64
`;

// --------------------------------------------------------------------------
// RV32 runtime. External routines get their arguments on the stack
// (last argument at 0(sp)) and return in a0.
const RUNTIME_RV = String.raw`
# ======================================================================
# runtime (SCHUB)

# syscall to the 65C816 stub: a0 = command, a1 = argument -> a0 = result
rt_sys:
	li t0, MBOXADDR
	sw a1, 8(t0)
	sw a0, 4(t0)
	li t1, 1
	sw t1, 0(t0)
	li t2, 2
.sys_wait:
	lw t1, 0(t0)
	bne t1, t2, .sys_wait
	lw a0, 12(t0)
	sw zero, 0(t0)
	ret

rt_putchar:
	lw a1, 0(sp)
	li a0, 1
	j rt_sys
rt_getkey:
	li a0, 2
	li a1, 0
	j rt_sys
rt_escape:
	li a0, 3
	li a1, 0
	j rt_sys
rt_kmode:
	lw a1, 0(sp)
	li a0, 5
	j rt_sys
rt_kreset:
	li a0, 6
	li a1, 0
	j rt_sys
rt_dos:
	lw a1, 0(sp)
	li a0, 7
	j rt_sys
rt_halt:
	lw a0, 0(sp)
rt_exit:
	mv a1, a0
	li a0, 4
	call rt_sys
.halt_spin:
	j .halt_spin
rt_heaporg:
	la a0, PAS_HEAP
	ret
rt_sp:
	mv a0, sp
	ret
rt_target:
	li a0, 2
	ret

# move(const src; var dst; count)   8(sp)=src 4(sp)=dst 0(sp)=count
rt_move:
	lw a1, 8(sp)
	lw a0, 4(sp)
	lw a2, 0(sp)
	slli a2, a2, 16
	srli a2, a2, 16
rt_memmove:
	beqz a2, .mv_done
	bltu a1, a0, .mv_back
.mv_fwd:
	lbu t0, 0(a1)
	sb t0, 0(a0)
	addi a1, a1, 1
	addi a0, a0, 1
	addi a2, a2, -1
	bnez a2, .mv_fwd
.mv_done:
	ret
.mv_back:
	add a1, a1, a2
	add a0, a0, a2
.mv_b1:
	addi a1, a1, -1
	addi a0, a0, -1
	lbu t0, 0(a1)
	sb t0, 0(a0)
	addi a2, a2, -1
	bnez a2, .mv_b1
	ret

# a0 = dst, a1 = src, a2 = count (no overlap)
rt_memcpy:
	or t1, a0, a1
	or t1, t1, a2
	andi t1, t1, 3
	bnez t1, rt_memmove
	beqz a2, .mc_done
.mc_w:
	lw t0, 0(a1)
	sw t0, 0(a0)
	addi a1, a1, 4
	addi a0, a0, 4
	addi a2, a2, -4
	bnez a2, .mc_w
.mc_done:
	ret

# fill(var dst; count; value)   8(sp)=dst 4(sp)=count 0(sp)=value
rt_fill:
	lw a0, 8(sp)
	lw a2, 4(sp)
	lw a1, 0(sp)
	slli a2, a2, 16
	srli a2, a2, 16
	beqz a2, .fi_done
.fi_l:
	sb a1, 0(a0)
	addi a0, a0, 1
	addi a2, a2, -1
	bnez a2, .fi_l
.fi_done:
	ret

# runtime error: a0 = code
rt_error:
	mv s1, a0
	li a0, 1
	li a1, 13
	call rt_sys
	la s2, .err_text
.err_l:
	lbu a1, 0(s2)
	beqz a1, .err_num
	li a0, 1
	call rt_sys
	addi s2, s2, 1
	j .err_l
.err_num:
	# decimal digits of s1 (< 1000)
	li s3, 100
.err_d:
	divu a1, s1, s3
	remu s1, s1, s3
	addi a1, a1, 48
	li a0, 1
	call rt_sys
	li t0, 10
	divu s3, s3, t0
	bnez s3, .err_d
	li a0, 1
	li a1, 13
	call rt_sys
	li a0, 0
	j rt_exit
.err_text:
	.byte 82,85,78,84,73,77,69,32,69,82,82,79,82,32,0
	.align 4
`;

// Request 8, only in the stub of the SCHUB build of the PASCAL editor
// (layout.RUN): run a program while the editor waits. a1 (+8) is the entry
// (JSL), or $FFFFFF to load and run the .MER that the DOS parameter block at
// $16C0 names; +12 is where SCHUB carries on afterwards. SCHUB is stopped
// meanwhile (its data cache writes through, so nothing is lost), as the
// program may be a SCHUB program itself. Bank 0 $2000-$B7FF is kept in bank
// $B0 while it runs (bank $31 may hold the 65C816 editor's copy). Then SCHUB
// restarts at +12, with the result (a DOS error, or 0) in +12.
const RUN_REQUEST = String.raw`
c_run
	ldx #0
-	lda @l MBOX+8,x
	sta @l run_par,x
	inx
	cpx #8
	bne -
	jsr @w stop
	lda #0
	ldx #0
-	sta @l MBOX,x
	inx
	cpx #16
	bne -
	rep #$30
	.al
	phb
	ldx #$2000
	ldy #$2000
	lda #$97FF
	mvn #$00,#$B0
	plb
	lda #0
	tcd
	sep #$20
	.as
	lda @l run_par+2
	cmp #$FF
	bne run_direct
	lda #0                  ; A = 0: load the file
	phb
	jsl $FF4000
	plb
	sta @l run_res
	cmp #0                  ; (plb set the flags from the bank)
	bne run_back
	bra run_go
run_direct
	lda @l run_par          ; the entry, where the DOS would put a loaded file
	sta @w $16E4
	lda @l run_par+1
	sta @w $16E5
	lda @l run_par+2
	sta @w $16E6
run_go
	rep #$30
	.al
	tsc                       ; the program's stack below the stub's (a stop
	sta @l run_sp             ; comes back to the stub at run_sp)
	sec
	sbc #64
	tcs
	lda #dbg_stop_stub & $ffff  ; the debugger hook's stop handler
	sta @l DBG+10
	sep #$20
	.as
	lda #^dbg_stop_stub
	sta @l DBG+12
	phk
	pea run_ret-1
	jml [$16E4]
run_ret
	rep #$30
	.al
	lda @l run_sp
	tcs
	sep #$20
	rep #$10
	.as
	.xl
	lda #0
	sta @l run_res
run_back
	rep #$30
	.al
	ldx #$2000
	ldy #$2000
	lda #$97FF
	mvn #$B0,#$00
	lda #0
	tcd
	sep #$20
	.as
	pha
	plb
	lda @l run_res
	sta @l MBOX+12
	lda #0
	sta @l MBOX+13
	sta @l MBOX+14
	sta @l MBOX+15
	sta @l escn
	lda @l run_par+4
	sta @w SCHUB_START
	lda @l run_par+5
	sta @w SCHUB_START+1
	lda @l run_par+6
	sta @w SCHUB_START+2
	lda #0
	sta @w SCHUB_START+3
	lda #3                  ; enable + run
	sta @w SCHUB_CTL
	jmp @w loop
run_par
	.fill 8
run_res
	.byte 0
run_sp
	.word 0

; the debugger hook stopped the 65C816 program: its bank 0 to bank $34,
; then as if it had ended (run_back), with $3D:7F03 = 1
dbg_stop_stub
	rep #$30
	.al
	.xl
	phb
	ldx #$2000
	ldy #$2000
	lda #$97FF
	mvn #$00,#$34
	plb
	lda @l run_sp
	tcs
	sep #$20
	.as
	lda #0
	sta @l run_res
	jmp @w run_back

; request 9: continue the stopped 65C816 program (+12: where SCHUB carries on
; when it stops again or ends)
c_dres
	ldx #0
-	lda @l MBOX+8,x
	sta @l run_par,x
	inx
	cpx #8
	bne -
	jsr @w stop
	lda #0
	ldx #0
-	sta @l MBOX,x
	inx
	cpx #16
	bne -
	rep #$30
	.al
	tsc
	sta @l run_sp
	phb
	ldx #$2000
	ldy #$2000
	lda #$97FF
	mvn #$00,#$B0
	ldx #$2000
	ldy #$2000
	lda #$97FF
	mvn #$34,#$00
	lda @l DBG+16             ; the program's registers (see cart.js)
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
`;

// --------------------------------------------------------------------------
// 65C816 host stub: loaded with the program at $04:0000, started with JSL.
// It starts SCHUB at the RV code and serves its requests through the mailbox.
export function buildStub(layout = RVLAYOUT) {
  const MB = layout.MBOX;
  const hex6 = (v) => '$' + v.toString(16).padStart(6, '0');
  const asm = String.raw`
	.cpu "65816"
	* = ${hex6(layout.LOAD)}
	.as
	.xl
SCHUB_ID   = $CD00
SCHUB_CTL  = $CD08
SCHUB_STAT = $CD09
SCHUB_START = $CD0C
MBOX       = ${hex6(MB)}
DBG        = $3D7F00
stub
	bra stub_go               ; +0: start the program
	phb                       ; +2: continue it after a debugger stop
	phd
	php
	sep #$20
	rep #$10
	lda #0
	pha
	plb
	jsr @w stop
	lda @l resume_adr
	sta @w SCHUB_START
	lda @l resume_adr+1
	sta @w SCHUB_START+1
	lda @l resume_adr+2
	sta @w SCHUB_START+2
	bra stub_run
stub_go
	phb
	phd
	php
	sep #$20
	rep #$10
	lda #0
	pha
	plb
	lda @w SCHUB_ID
	cmp #$53                ; "S"
	bne nosch
	lda @w SCHUB_ID+1
	cmp #$43                ; "C"
	bne nosch
	jsr @w stop
	lda #<${layout.CODE}
	sta @w SCHUB_START
	lda #>${layout.CODE}
	sta @w SCHUB_START+1
	lda #${(layout.CODE >> 16) & 255}
	sta @w SCHUB_START+2
stub_run
	lda #0
	sta @w SCHUB_START+3
	ldx #0
-	sta @l MBOX,x
	inx
	cpx #16
	bne -
	lda #0
	sta @l escn
	lda #3                  ; enable + run
	sta @w SCHUB_CTL
loop
	lda @w SCHUB_STAT
	and #$08                ; address error
	bne adrerr
	lda @l MBOX
	cmp #1
	beq request
	lda @l $033E76          ; Esc held down for 1.5 s stops SCHUB
	beq escno
	lda @w $0050            ; frame counter
	cmp @l lastf
	beq loop
	sta @l lastf
	lda @l escn
	inc a
	sta @l escn
	cmp #90
	bcs brk
	bra loop
escno
	sta @l escn
	bra loop
request
	lda @l MBOX+4
	cmp #1
	beq c_put
	cmp #2
	beq c_get
	cmp #3
	beq c_esc
	cmp #4
	beq c_exit
	cmp #5
	beq c_mode
	cmp #6
	beq c_reset
	cmp #7
	beq c_dos
	cmp #10
	bne +
	jmp @w c_dstop
+
${layout.RUN ? `	cmp #8
	bne +
	jmp @w c_run
+	cmp #9
	bne +
	jmp @w c_dres
+` : ''}
	lda #0
	bra answer
c_put
	lda @l MBOX+8
	jsl $00FFC1
	lda #0
	bra answer
c_get
	jsl $00FFC4
	bra answer
c_esc
	jsl $00FFD0
	cmp #3
	beq +
	lda #0
	bra answer
+	lda #1
	bra answer
c_mode
	lda @l MBOX+8
	jsl $00FFC7
	lda #0
	bra answer
c_reset
	jsl $00FFCA
	lda #0
	bra answer
c_dos
	lda @l MBOX+8
	phb
	jsl $FF4000
	plb
answer
	sta @l MBOX+12
	lda #0
	sta @l MBOX+13
	sta @l MBOX+14
	sta @l MBOX+15
	lda #2
	sta @l MBOX
	jmp loop
c_exit
	jsr @w stop
	bra done
brk
	jsr @w stop
	ldx #0
-	lda @l t_break,x
	beq done
	jsl $00FFC1
	inx
	bra -
adrerr
	jsr @w stop
	ldx #0
-	lda @l t_adr,x
	beq done
	jsl $00FFC1
	inx
	bra -
nosch
	ldx #0
-	lda @l t_nosch,x
	beq done
	jsl $00FFC1
	inx
	bra -
done
	plp
	pld
	plb
	rtl
stop
	lda #0
	sta @w SCHUB_CTL
-	lda @w SCHUB_STAT
	and #$06
	bne -
	rts
; request 10 (the debugger hook): SCHUB stops, the stub returns as if the
; program had ended, with $3D:7F03 = 1; +2 continues it at a1 later
c_dstop
	lda @l MBOX+8
	sta @l resume_adr
	lda @l MBOX+9
	sta @l resume_adr+1
	lda @l MBOX+10
	sta @l resume_adr+2
	jsr @w stop
	lda #1
	sta @l DBG+3
	jmp @w done
resume_adr
	.fill 3
${layout.RUN ? RUN_REQUEST : ''}
escn
	.byte 0
lastf
	.byte 0
t_nosch
	.text "SCHUB NOT AVAILABLE"
	.byte 13,0
t_break
	.byte 13
	.text "BREAK"
	.byte 13,0
t_adr
	.byte 13
	.text "SCHUB ADDRESS ERROR"
	.byte 13,0
`;
  const a = assemble816(asm, { listing: true });
  if (a.bytes.length > MB - layout.LOAD) throw new Error('stub too large');
  return { bytes: a.bytes, asm, listing: formatListing(a.listing) };
}
