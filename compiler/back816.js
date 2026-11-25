// MERIDIAN Pascal - 65C816 back end
//
// Machine model while Pascal code runs: native mode, A and X/Y 16 bit,
// data bank 0, D = frame pointer of the current procedure.
//
// Frame (stack grows down; D = S after the prologue):
//   D+1 .. D+FS        locals and temporaries
//   D+FS+1/2           caller's D
//   D+FS+3/4           return address (JSR)
//   D+FS+5 ...         parameters; the static link (if any) comes first
// Results: 16 bit in A, 32 bit in A (low) / X (high).
//
// Expression stack: the top entry lives in A (or A/X) when it was just
// computed, or is a pending constant; everything below is on the hardware
// stack. Arguments are pushed straight onto the hardware stack.

import { runtime816, RT_VARS, RT_VARS_CART } from './rt816.js';
import { CompileError } from './lexer.js';
const hex = (v, n = 4) => '$' + ((v >>> 0) & (n === 2 ? 0xff : n === 4 ? 0xffff : n === 6 ? 0xffffff : 0xffffffff)).toString(16).padStart(n, '0');
const isNum = (v) => typeof v === 'number';
const lo16 = (v) => isNum(v) ? hex(v & 0xffff) : `${v}`;
const hi16 = (v) => isNum(v) ? hex((v >>> 16) & 0xffff) : `(${v})>>16`;

export const M816 = {
  ORG: 0x2000,
  STACK_TOP: 0xb7ff,
};

export function gen816(prog, opts = {}) {
  const out = [];
  const E = (s) => out.push('\t' + s);
  const LBL = (s) => out.push(s);
  const C = (s) => out.push('; ' + s);
  let uniq = 0;
  const u = (p = 'l') => `Q${p.toUpperCase()}${++uniq}`;
  const procByLabel = new Map(prog.procs.map(p => [p.label, p]));

  const far = !!opts.far;
  const J = far ? 'jsl' : 'jsr';          // call
  const RET = far ? 'rtl' : 'rts';
  const PB = far ? 6 : 5;                 // first parameter byte above D+FS
  const cart = opts.cart || null;

  // -------------------------------------------------------------- header
  out.push('; MERIDIAN Pascal - 65C816 output' + (far ? ' (far code model)' : ''));
  out.push('\t.cpu "65816"');
  if (cart) {
    out.push(cart.header);
  } else {
    out.push(`\t* = ${hex(opts.org || M816.ORG)}`);
    out.push('\t.al');
    out.push('\t.xl');
    LBL('PAS_START');
    E('phb'); E('phd'); E('php');
    E('rep #$30');
    E('tsc');
    E('sta @w rt_savesp');
    E(`lda #${hex(opts.stackTop || M816.STACK_TOP)}`);
    E('tcs');
    E('lda #0');
    E('tcd');
    // clear bss
    E('lda #0');
    E('sta @w PAS_BSS');
    E('ldx #PAS_BSS');
    E('ldy #PAS_BSS+1');
    E('lda #PAS_BSS_END-PAS_BSS-2');
    E('mvn #0,#0');
    if (prog.usesInt) {
      // IntProc: the kernel's interrupt hook ($00:0300) goes to rt_irqentry,
      // which runs IntProc and then the hook that was there
      E('sei');
      E('lda @l $000300');
      E('sta @w rt_oldhook');
      E('lda #rt_irqentry');
      E('sta @l $000300');
      E('cli');
    }
    for (const l of prog.inits) E(`${J} ${l}`);
    E(`${J} ${prog.main}`);
    // the end, however the program ends (Halt, a runtime error, Esc): the
    // interrupt hook back, then ExitProc (each one may set the next)
    LBL('rt_exit');
    E('rep #$30');
    E(`lda #${hex(opts.stackTop || M816.STACK_TOP)}`);
    E('tcs');
    E('lda #0');
    E('tcd');
    E('lda @w rt_oldhook');
    E('beq +');
    E('sei');
    E('sta @l $000300');
    E('stz @w rt_oldhook');
    E('cli');
    LBL('+');
    E('lda @w rt_exitproc');
    E('beq +');
    E('stz @w rt_exitproc');
    E('sta @w rt_t0');
    E('ldx #0');
    E('jsr (rt_t0,x)');
    E('bra rt_exit');
    LBL('+');
    E('rep #$30');
    E('lda @w rt_savesp');
    E('tcs');
    E('plp'); E('pld'); E('plb');
    E('rtl');
    // the interrupt hook: the kernel's JSR with A 8 bit = the graphics chip's
    // interrupt status, X/Y 16 bit, data bank 0. IntProc runs with the
    // runtime's work variables saved (the program may be in the middle of
    // using them); then on to the hook that was there before.
    LBL('rt_irqentry');
    E('php');
    E('sep #$20');
    E('sta @w rt_intstat');
    E('rep #$30');
    E('lda @w rt_intproc');
    E('beq rt_irqdone');
    E('phd');
    E('ldx #RT_SCRATCH_END-rt_t0-2');
    LBL('-');
    E('lda @w rt_t0,x');
    E('pha');
    E('dex');
    E('dex');
    E('bpl -');
    E('ldx #0');
    E('jsr (rt_intproc,x)');
    E('rep #$30');
    E('ldx #0');
    LBL('-');
    E('pla');
    E('sta @w rt_t0,x');
    E('inx');
    E('inx');
    E('cpx #RT_SCRATCH_END-rt_t0');
    E('bne -');
    E('pld');
    LBL('rt_irqdone');
    E('plp');
    E('lda @w rt_intstat');
    E('jmp (rt_oldhook)');
  }

  // ------------------------------------------------------------ procedures
  if (cart) {
    // library and runtime first, in one block: a standalone .MER made on the
    // MERIDIAN carries $40:0000..LIBCODE_END with it
    for (const p of prog.procs) if (cart.libModules.has(p.module)) genProc(p);
    E('.bankfit');
    out.push(runtime816(far, true));
    if (cart.extraAsm) out.push(cart.extraAsm);
    LBL('LIBCODE_END');
    // then the data image (library data first), then the other procedures:
    // the library and its data stay at the same addresses when only the
    // program part of the cartridge changes (see the library stamp)
  } else {
    for (const p of prog.procs) genProc(p);
    if (far) E('.bankfit');
    out.push(runtime816(far, false));
  }

  // ----------------------------------------------------------------- data
  if (cart) {
    // data lives in bank 0 (logical $2000...); its image in ROM is copied at start
    const isLib = (m) => cart.libModules.has(m);
    E('.bankfit');
    LBL('DATAROM');
    E('.logical $2000');
    LBL('RTVARS');
    for (const v of RT_VARS_CART) { LBL(v[0]); E(`.fill ${v[1]}`); }
    LBL('LIBDATA');
    for (const d of prog.data.filter(d => isLib(d.module))) emitData(d);
    for (const b of prog.bss.filter(b => isLib(b.module))) { LBL(b.label); E(`.fill ${b.size}`); }
    E('.fill 2');
    LBL('LIBEND');
    for (const d of prog.data.filter(d => !isLib(d.module))) emitData(d);
    for (const b of prog.bss.filter(b => !isLib(b.module))) { LBL(b.label); E(`.fill ${b.size}`); }
    E('.fill 2');
    LBL('PROGEND');
    LBL('PAS_HEAP');
    E('.here');
    LBL('DATAROM_END');
    E('.bankfit');
    for (const p of prog.procs) if (!cart.libModules.has(p.module)) genProc(p);
    if (cart.tailAsm) out.push(cart.tailAsm);
    return out.join('\n') + '\n';
  }
  out.push('; ---- data');
  for (const d of prog.data) emitData(d);
  out.push('; ---- bss (cleared at start)');
  LBL('PAS_BSS');
  for (const v of RT_VARS) { LBL(v[0]); if (v[1]) E(`.fill ${v[1]}`); }
  for (const b of prog.bss) { LBL(b.label); E(`.fill ${b.size}`); }
  E('.fill 2');
  LBL('PAS_BSS_END');
  LBL('PAS_HEAP');
  return out.join('\n') + '\n';

  function emitData(d) {
    LBL(d.label);
    for (let i = 0; i < d.bytes.length; i += 16) E('.byte ' + d.bytes.slice(i, i + 16).map(b => hex(b, 2)).join(','));
    if (!d.bytes.length) E('.byte 0');
  }

  // =================================================================
  function genProc(p) {
    const FS = p.locSize;
    const fsName = `FS_${p.label}`;
    out.push('');
    out.push(`; ---- ${p.name} (${p.module})`);
    out.push(`${fsName} = ${FS}`);
    if (far) E('.bankfit');
    LBL(p.label);
    E('phd');
    E('tsc');
    if (FS) { E('sec'); E(`sbc #${FS}`); E('tcs'); }
    E('tcd');

    // vs entries: {cls:'W'|'L', k:'reg'|'stk'|'const', v}
    let vs = [];
    const top = () => vs[vs.length - 1];
    const dpOff = (kind, off) => kind === 'loc' ? 1 + off : FS + PB + off;
    const parBase = (proc) => `FS_${proc.label}+${PB}`;

    const spill = () => {
      for (const e of vs) {
        if (e.k === 'reg') {
          if (e.cls === 'L') E('phx');
          E('pha');
          e.k = 'stk';
        } else if (e.k === 'const') {
          if (e.cls === 'L') { E(`pea ${hi16(e.v)}`); E(`pea ${lo16(e.v)}`); }
          else E(`pea ${lo16(e.v)}`);
          e.k = 'stk';
        }
      }
    };
    const pushReg = (cls) => vs.push({ cls, k: 'reg' });
    // before loading anything into A: make room
    const free = () => spill();
    // bring the top entry into A (/X), remove it from vs
    const popA = () => {
      const e = vs.pop();
      if (!e) throw new Error(`internal: expression stack underflow in ${p.name}`);
      if (e.k === 'reg') return e;
      if (e.k === 'const') {
        spill();   // a register value below must go to the stack first
        if (e.cls === 'L') { E(`ldx #${hi16(e.v)}`); E(`lda #${lo16(e.v)}`); }
        else E(`lda #${lo16(e.v)}`);
        return e;
      }
      E('pla');
      if (e.cls === 'L') E('plx');
      return e;
    };
    const popDiscard = () => {
      const e = vs.pop();
      if (e.k === 'stk') { E('ply'); if (e.cls === 'L') E('ply'); }
    };

    // X = D of the frame `hops` levels out (clobbers A if hops > 1)
    const frameX = (hops) => {
      let cur = p;
      E(`ldx ${hex(FS + PB, 2)}`);   // our static link
      if (FS + PB > 255) throw new Error('frame too large for static link');
      cur = procByLabel.get(cur.parent);
      for (let h = 1; h < hops; h++) {
        E(`lda @w ${parBase(cur)},x`);
        E('tax');
        cur = procByLabel.get(cur.parent);
      }
      return cur; // owner of the frame in X
    };
    const frameOffExpr = (owner, kind, off) => kind === 'loc' ? `${1 + off}` : `${parBase(owner)}+${off}`;

    const emitLoadX = (offExpr, mt) => {
      // X = base address; offExpr is added via absolute indexed
      switch (mt) {
        case 'u16': case 's16': E(`lda @w ${offExpr},x`); break;
        case 'u8': E(`lda @w ${offExpr},x`); E('and #$00ff'); break;
        case 's8': E(`lda @w ${offExpr},x`); E('and #$00ff'); E('eor #$0080'); E('sec'); E('sbc #$0080'); break;
        case '32': E(`lda @w ${offExpr}+2,x`); E('tay'); E(`lda @w ${offExpr},x`); E('tyx'); break;
      }
    };
    const emitStoreX = (offExpr, mt, cls) => {
      // value in A (/rt_t0 for 32 bit), X = base
      switch (mt) {
        case 'u16': case 's16': E(`sta @w ${offExpr},x`); break;
        case 'u8': case 's8': E('sep #$20'); E(`sta @w ${offExpr},x`); E('rep #$20'); break;
        case '32': E(`sta @w ${offExpr},x`); E('lda @w rt_t0+2'); E(`sta @w ${offExpr}+2,x`); break;
      }
    };
    const signExt8 = () => { E('and #$00ff'); E('eor #$0080'); E('sec'); E('sbc #$0080'); };
    const narrow = (mt) => {
      if (mt === 'u8') E('and #$00ff');
      else if (mt === 's8') signExt8();
    };
    const foldNarrow = (v, mt) => {
      v = v >>> 0;
      if (mt === 'u8') return v & 0xff;
      if (mt === 's8') return ((v & 0xff) ^ 0x80) - 0x80;
      if (mt === 'u16') return v & 0xffff;
      if (mt === 's16') return ((v & 0xffff) ^ 0x8000) - 0x8000;
      return v;
    };

    // load a local/param of the current frame by dp offset
    const loadDp = (o, mt) => {
      if (o + (mt === '32' ? 3 : 1) <= 255) {
        switch (mt) {
          case 'u16': case 's16': E(`lda ${hex(o, 2)}`); break;
          case 'u8': E(`lda ${hex(o, 2)}`); E('and #$00ff'); break;
          case 's8': E(`lda ${hex(o, 2)}`); signExt8(); break;
          case '32': E(`ldx ${hex(o + 2, 2)}`); E(`lda ${hex(o, 2)}`); break;
        }
      } else {
        E('tdc'); E('tax');
        emitLoadX(`${o}`, mt);
      }
    };
    const storeDp = (o, mt) => {
      // value in A (/X)
      if (o + (mt === '32' ? 3 : 1) <= 255) {
        switch (mt) {
          case 'u16': case 's16': E(`sta ${hex(o, 2)}`); break;
          case 'u8': case 's8': E('sep #$20'); E(`sta ${hex(o, 2)}`); E('rep #$20'); break;
          case '32': E(`sta ${hex(o, 2)}`); E(`stx ${hex(o + 2, 2)}`); break;
        }
      } else {
        if (mt === '32') E('stx @w rt_t0+2');
        E('tay'); E('tdc'); E('tax'); E('tya');
        emitStoreX(`${o}`, mt);
      }
    };

    // compare: operands NOS (a) and TOS (b) -> branch to target if (a c b)
    const cmpBranch = (c, cls, unsigned, target) => {
      if (cls === 'L') {
        const b = vs.pop(), a = vs[vs.length - 1];
        vs.push(b);
        toAB();
        E(`${J} ${unsigned ? 'rt_cmp32u' : 'rt_cmp32s'}`);
        branchOnSign(c, target);
        return;
      }
      const b = vs.pop();
      const flip = !unsigned && c !== 'eq' && c !== 'ne';
      let operand;
      if (b.k === 'const') {
        const a = popA();
        if (flip) E('eor #$8000');
        operand = isNum(b.v) ? `#${hex((b.v ^ (flip ? 0x8000 : 0)) & 0xffff)}` : `#${b.v}${flip ? '^$8000' : ''}`;
      } else {
        vs.push(b);
        popA();             // b in A
        if (flip) E('eor #$8000');
        E('sta @w rt_t0');
        popA();             // a in A
        if (flip) E('eor #$8000');
        operand = '@w rt_t0';
      }
      E(`cmp ${operand}`);
      switch (c) {
        case 'eq': E(`beq ${target}`); break;
        case 'ne': E(`bne ${target}`); break;
        case 'lt': E(`bcc ${target}`); break;
        case 'ge': E(`bcs ${target}`); break;
        case 'gt': { const s = u('s'); E(`beq ${s}`); E(`bcs ${target}`); LBL(s); break; }
        case 'le': E(`bcc ${target}`); E(`beq ${target}`); break;
      }
    };
    const branchOnSign = (c, target) => {
      // A = -1 / 0 / 1 with flags set
      switch (c) {
        case 'eq': E(`beq ${target}`); break;
        case 'ne': E(`bne ${target}`); break;
        case 'lt': E(`bmi ${target}`); break;
        case 'ge': E(`bpl ${target}`); break;
        case 'gt': { const s = u('s'); E(`beq ${s}`); E(`bpl ${target}`); LBL(s); break; }
        case 'le': E(`bmi ${target}`); E(`beq ${target}`); break;
      }
    };
    // 32-bit binary operands: TOS -> rt_b, NOS -> rt_a
    const toAB = () => {
      const b = vs.pop(), a = vs.pop();
      if (a.k === 'reg') { E('sta @w rt_a'); E('stx @w rt_a+2'); }
      if (b.k === 'const') {
        E(`lda #${lo16(b.v)}`); E('sta @w rt_b'); E(`lda #${hi16(b.v)}`); E('sta @w rt_b+2');
      } else {
        if (b.k === 'stk') { E('pla'); E('plx'); }
        E('sta @w rt_b'); E('stx @w rt_b+2');
      }
      if (a.k === 'const') {
        E(`lda #${lo16(a.v)}`); E('sta @w rt_a'); E(`lda #${hi16(a.v)}`); E('sta @w rt_a+2');
      } else if (a.k === 'stk') {
        E('pla'); E('plx');
        E('sta @w rt_a'); E('stx @w rt_a+2');
      }
    };
    // 16-bit: TOS -> X, NOS -> A
    const toAX16 = () => {
      const b = vs.pop();
      if (b.k === 'const') { popA(); E(`ldx #${lo16(b.v)}`); return; }
      vs.push(b);
      popA(); E('tax');
      popA();
    };

    const binW = (op, unsigned) => {
      const b = top();
      const asmOp = { add: 'adc', sub: 'sbc', and: 'and', or: 'ora', xor: 'eor' }[op];
      if (asmOp) {
        if (b.k === 'const') {
          vs.pop();
          const a = top();
          if (a && a.k === 'const' && isNum(a.v) && isNum(b.v)) {
            vs.pop();
            const r = { add: a.v + b.v, sub: a.v - b.v, and: a.v & b.v, or: a.v | b.v, xor: a.v ^ b.v }[op];
            vs.push({ cls: 'W', k: 'const', v: r & 0xffff });
            return;
          }
          popA();
          if (op === 'add' && isNum(b.v) && (b.v & 0xffff) === 1) E('inc a');
          else if (op === 'sub' && isNum(b.v) && (b.v & 0xffff) === 1) E('dec a');
          else if (op === 'add' && isNum(b.v) && (b.v & 0xffff) === 0xffff) E('dec a');
          else {
            if (op === 'add') E('clc');
            if (op === 'sub') E('sec');
            E(`${asmOp} #${lo16(b.v)}`);
          }
          pushReg('W');
          return;
        }
        popA();   // b in A, a on the hardware stack (or const below? cannot be)
        const a = vs.pop();
        if (a.k === 'const') {
          // a op A
          if (op === 'sub') { E('eor #$ffff'); E('sec'); E(`adc #${lo16(a.v)}`); }
          else { if (op === 'add') E('clc'); E(`${asmOp} #${lo16(a.v)}`); }
        } else {
          if (op === 'sub') { E('eor #$ffff'); E('sec'); E('adc 1,s'); }
          else { if (op === 'add') E('clc'); E(`${asmOp} 1,s`); }
          E('ply');
        }
        pushReg('W');
        return;
      }
      if (op === 'shl' || op === 'shr') {
        if (b.k === 'const' && isNum(b.v)) {
          vs.pop();
          popA();
          const n = b.v & 31;
          if (n >= 16) E('lda #0');
          else if (op === 'shl' && n >= 8) { E('and #$00ff'); E('xba'); for (let i = 8; i < n; i++) E('asl a'); }
          else if (op === 'shr' && n >= 8) { E('and #$ff00'); E('xba'); for (let i = 8; i < n; i++) E('lsr a'); }
          else for (let i = 0; i < n; i++) E(op === 'shl' ? 'asl a' : 'lsr a');
          pushReg('W');
          return;
        }
        toAX16();
        E(`${J} ${op === 'shl' ? 'rt_shl16' : 'rt_shr16'}`);
        pushReg('W');
        return;
      }
      // mul, div, mod
      toAX16();
      const r = { mul: 'rt_mul16', div: unsigned ? 'rt_div16u' : 'rt_div16s', mod: unsigned ? 'rt_mod16u' : 'rt_mod16s' }[op];
      E(`${J} ${r}`);
      pushReg('W');
    };

    const binL = (op, unsigned) => {
      const b = top();
      const asmOp = { add: 'adc', sub: 'sbc', and: 'and', or: 'ora', xor: 'eor' }[op];
      if (asmOp) {
        if (b.k === 'const') {
          vs.pop();
          const a = top();
          if (a && a.k === 'const' && isNum(a.v) && isNum(b.v)) {
            vs.pop();
            const r = { add: a.v + b.v, sub: a.v - b.v, and: a.v & b.v, or: a.v | b.v, xor: a.v ^ b.v }[op];
            vs.push({ cls: 'L', k: 'const', v: r >>> 0 });
            return;
          }
          popA();
          if (op === 'add') E('clc');
          if (op === 'sub') E('sec');
          E(`${asmOp} #${lo16(b.v)}`); E('tay'); E('txa'); E(`${asmOp} #${hi16(b.v)}`); E('tax'); E('tya');
          pushReg('L');
          return;
        }
        popA();
        const a = vs.pop();
        if (a.k === 'const') {
          // a op (A/X)
          E('sta @w rt_t0'); E('stx @w rt_t0+2');
          E(`lda #${lo16(a.v)}`);
          if (op === 'add') E('clc'); if (op === 'sub') E('sec');
          E(`${asmOp} @w rt_t0`); E('tay'); E(`lda #${hi16(a.v)}`); E(`${asmOp} @w rt_t0+2`); E('tax'); E('tya');
        } else if (op === 'sub') {
          E('sta @w rt_t0'); E('stx @w rt_t0+2');
          E('pla'); E('sec'); E('sbc @w rt_t0'); E('tay'); E('pla'); E('sbc @w rt_t0+2'); E('tax'); E('tya');
        } else {
          if (op === 'add') E('clc');
          E(`${asmOp} 1,s`); E('sta 1,s'); E('txa'); E(`${asmOp} 3,s`); E('tax'); E('pla'); E('ply');
        }
        pushReg('L');
        return;
      }
      toAB();
      const r = {
        mul: 'rt_mul32', div: unsigned ? 'rt_div32u' : 'rt_div32s', mod: unsigned ? 'rt_mod32u' : 'rt_mod32s',
        shl: 'rt_shl32', shr: 'rt_shr32',
      }[op];
      E(`${J} ${r}`);
      pushReg('L');
    };

    // ---- walk the IR
    const code = p.code;
    for (let i = 0; i < code.length; i++) {
      const ins = code[i];
      switch (ins.o) {
        case 'line': C(`line ${ins.line}`); break;
        case 'asm': {
          // an asm block (front.js parseAsm): locals and parameters are direct page places
          if (vs.length) throw new Error(`internal: expression stack not empty before asm in ${p.name}`);
          for (const l of ins.lines) {
            if (l.label) LBL(l.label);
            if (!l.parts.length) continue;
            const s = l.parts.map(q => {
              if (typeof q === 'string') return q;
              if (q.r === 'glob') return typeof q.g === 'number' ? hex(q.g, q.g > 0xffff ? 6 : 4) : q.g;
              const o = dpOff(q.kind, q.off);
              if (o > 255) throw new CompileError(`a local or parameter beyond the direct page ($${o.toString(16)}) cannot be used in asm`, { file: ins.file, line: l.line, col: 1 });
              return hex(o, 2);
            }).join('');
            E(`${s}\t; asm ${l.line} ${ins.file}`);     // compile.js: an assembler error is at this line
          }
          E('.al'); E('.xl');
          break;
        }
        case 'lit': {
          const t = top();
          if (t && t.k === 'const') spill();
          vs.push({ cls: ins.s, k: 'const', v: ins.s === 'L' ? (isNum(ins.v) ? ins.v >>> 0 : ins.v) : (isNum(ins.v) ? ins.v & 0xffff : ins.v) });
          break;
        }
        case 'gaddr': {
          const t = top();
          if (t && t.k === 'const') spill();
          const v = isNum(ins.g) ? ins.g + ins.off : (ins.off ? `${ins.g}+${ins.off}` : ins.g);
          vs.push({ cls: 'W', k: 'const', v });
          break;
        }
        case 'laddr': {
          free();
          if (ins.hops === 0) {
            const o = dpOff(ins.kind, ins.off);
            E('tdc'); E('clc'); E(`adc #${o}`);
          } else {
            const owner = frameX(ins.hops);
            E('txa'); E('clc'); E(`adc #${frameOffExpr(owner, ins.kind, ins.off)}`);
          }
          pushReg('W');
          break;
        }
        case 'fp': {
          free();
          if (ins.hops === 0) E('tdc');
          else { frameX(ins.hops); E('txa'); }
          pushReg('W');
          break;
        }
        case 'ldl': {
          free();
          if (ins.hops === 0) loadDp(dpOff(ins.kind, ins.off), ins.mt);
          else {
            const owner = frameX(ins.hops);
            emitLoadX(frameOffExpr(owner, ins.kind, ins.off), ins.mt);
          }
          pushReg(ins.mt === '32' ? 'L' : 'W');
          break;
        }
        case 'stl': {
          const e = popA();
          if (ins.hops === 0) storeDp(dpOff(ins.kind, ins.off), ins.mt);
          else {
            if (ins.mt === '32') { E('sta @w rt_t0'); E('stx @w rt_t0+2'); }
            else E('tay');
            const owner = frameX(ins.hops);
            if (ins.mt === '32') E('lda @w rt_t0'); else E('tya');
            emitStoreX(frameOffExpr(owner, ins.kind, ins.off), ins.mt);
          }
          break;
        }
        case 'ldg': {
          free();
          const a = isNum(ins.g) ? hex(ins.g + ins.off) : `${ins.g}+${ins.off}`;
          const hw = isNum(ins.g);
          switch (ins.mt) {
            case 'u16': case 's16': E(`lda @w ${a}`); break;
            case 'u8': if (hw) { E('sep #$20'); E(`lda @w ${a}`); E('rep #$20'); } else E(`lda @w ${a}`); E('and #$00ff'); break;
            case 's8': if (hw) { E('sep #$20'); E(`lda @w ${a}`); E('rep #$20'); } else E(`lda @w ${a}`); signExt8(); break;
            case '32': E(`ldx @w ${a}+2`); E(`lda @w ${a}`); break;
          }
          pushReg(ins.mt === '32' ? 'L' : 'W');
          break;
        }
        case 'stg': {
          popA();
          const a = isNum(ins.g) ? hex(ins.g + ins.off) : `${ins.g}+${ins.off}`;
          switch (ins.mt) {
            case 'u16': case 's16': E(`sta @w ${a}`); break;
            case 'u8': case 's8': E('sep #$20'); E(`sta @w ${a}`); E('rep #$20'); break;
            case '32': E(`sta @w ${a}`); E(`stx @w ${a}+2`); break;
          }
          break;
        }
        case 'ldabs': {
          free();
          const big = ins.a > 0xffff;
          const pre = big ? '@l' : '@w';
          const a = (x) => big ? hex(x, 6) : hex(x);
          switch (ins.mt) {
            case 'u16': case 's16': E(`lda ${pre} ${a(ins.a)}`); break;
            case 'u8': E('sep #$20'); E(`lda ${pre} ${a(ins.a)}`); E('rep #$20'); E('and #$00ff'); break;
            case 's8': E('sep #$20'); E(`lda ${pre} ${a(ins.a)}`); E('rep #$20'); signExt8(); break;
            case '32': E(`lda ${pre} ${a(ins.a + 2)}`); E('tax'); E(`lda ${pre} ${a(ins.a)}`); break;
          }
          pushReg(ins.mt === '32' ? 'L' : 'W');
          break;
        }
        case 'stabs': {
          popA();
          const big = ins.a > 0xffff;
          const pre = big ? '@l' : '@w';
          const a = (x) => big ? hex(x, 6) : hex(x);
          switch (ins.mt) {
            case 'u16': case 's16': E(`sta ${pre} ${a(ins.a)}`); break;
            case 'u8': case 's8': E('sep #$20'); E(`sta ${pre} ${a(ins.a)}`); E('rep #$20'); break;
            case '32': E(`sta ${pre} ${a(ins.a)}`); E('txa'); E(`sta ${pre} ${a(ins.a + 2)}`); break;
          }
          break;
        }
        case 'ld': {
          const e = top();
          let off = ins.off;
          if (e.k === 'const') {
            vs.pop();
            free();
            const a = isNum(e.v) ? hex((e.v + off) & 0xffff) : `${e.v}+${off}`;
            switch (ins.mt) {
              case 'u16': case 's16': E(`lda @w ${a}`); break;
              case 'u8': E(`lda @w ${a}`); E('and #$00ff'); break;
              case 's8': E(`lda @w ${a}`); signExt8(); break;
              case '32': E(`ldx @w ${a}+2`); E(`lda @w ${a}`); break;
            }
          } else {
            popA();
            if (off < 0 || off > 0x0fff) { E('clc'); E(`adc #${hex(off & 0xffff)}`); off = 0; }
            E('tax');
            emitLoadX(`${off}`, ins.mt);
          }
          pushReg(ins.mt === '32' ? 'L' : 'W');
          break;
        }
        case 'st': {
          // NOS = address (W), TOS = value
          const val = vs.pop();
          const adr = vs[vs.length - 1];
          let off = ins.off;
          if (adr.k === 'const') {
            vs.pop();
            vs.push(val);
            popA();
            const a = isNum(adr.v) ? hex((adr.v + off) & 0xffff) : `${adr.v}+${off}`;
            switch (ins.mt) {
              case 'u16': case 's16': E(`sta @w ${a}`); break;
              case 'u8': case 's8': E('sep #$20'); E(`sta @w ${a}`); E('rep #$20'); break;
              case '32': E(`sta @w ${a}`); E(`stx @w ${a}+2`); break;
            }
            break;
          }
          if (adr.k === 'reg') {
            // address in A, value is a constant
            vs.pop();
            E('tax');
            if (ins.mt === '32') { E(`lda #${hi16(val.v)}`); E('sta @w rt_t0+2'); }
            if (off < 0 || off > 0x0fff) { E('txa'); E('clc'); E(`adc #${hex(off & 0xffff)}`); E('tax'); off = 0; }
            E(`lda #${lo16(val.v)}`);
            if (ins.mt === '32') E('sta @w rt_t0');
            emitStoreX(`${off}`, ins.mt);
            break;
          }
          vs.push(val);
          popA();
          if (ins.mt === '32') { E('sta @w rt_t0'); E('stx @w rt_t0+2'); }
          else if (off < 0 || off > 0x0fff) E('tay');
          // address
          vs.pop();
          E('plx');
          if (off < 0 || off > 0x0fff) {
            E('txa'); E('clc'); E(`adc #${hex(off & 0xffff)}`); E('tax'); off = 0;
            if (ins.mt !== '32') E('tya');
          }
          if (ins.mt === '32') E('lda @w rt_t0');
          emitStoreX(`${off}`, ins.mt);
          break;
        }
        case 'ldfar': {
          popA();
          E('sta @w rt_fp'); E('stx @w rt_fp+2');
          E(`ldy #${hex(ins.off & 0xffff)}`);
          E(`${J} ${ins.mt === '32' ? 'rt_ldf32' : (ins.mt === 'u8' || ins.mt === 's8') ? 'rt_ldf8' : 'rt_ldf16'}`);
          if (ins.mt === 's8') signExt8();
          pushReg(ins.mt === '32' ? 'L' : 'W');
          break;
        }
        case 'stfar': {
          popA();
          E('sta @w rt_v'); if (ins.mt === '32') E('stx @w rt_v+2');
          const ad = vs.pop();
          if (ad.k === 'const') { E(`lda #${lo16(ad.v)}`); E('sta @w rt_fp'); E(`lda #${hi16(ad.v)}`); E('sta @w rt_fp+2'); }
          else { if (ad.k === 'stk') { E('pla'); E('plx'); } E('sta @w rt_fp'); E('stx @w rt_fp+2'); }
          E(`ldy #${hex(ins.off & 0xffff)}`);
          E(`${J} ${ins.mt === '32' ? 'rt_stf32' : (ins.mt === 'u8' || ins.mt === 's8') ? 'rt_stf8' : 'rt_stf16'}`);
          break;
        }
        case 'add': case 'sub': case 'mul': case 'div': case 'mod':
        case 'and': case 'or': case 'xor': case 'shl': case 'shr':
          if (ins.s === 'L') {
            if ((ins.o === 'shl' || ins.o === 'shr') && top().cls === 'W') {
              // shift count is 16 bit: widen it for the runtime
              const c = vs.pop();
              if (c.k === 'const') vs.push({ cls: 'L', k: 'const', v: c.v });
              else { vs.push(c); popA(); E('ldx #0'); pushReg('L'); }
            }
            binL(ins.o, ins.u);
          } else {
            if ((ins.o === 'shl' || ins.o === 'shr') && top().cls === 'L') {
              const c = vs.pop();
              if (c.k === 'const') vs.push({ cls: 'W', k: 'const', v: c.v & 0xffff });
              else { vs.push(c); popA(); pushReg('W'); }
            }
            binW(ins.o, ins.u);
          }
          break;
        case 'neg': {
          const t = top();
          if (t.k === 'const' && isNum(t.v)) { t.v = ins.s === 'L' ? (-t.v) >>> 0 : (-t.v) & 0xffff; break; }
          popA();
          if (ins.s === 'L') { E('eor #$ffff'); E('clc'); E('adc #1'); E('tay'); E('txa'); E('eor #$ffff'); E('adc #0'); E('tax'); E('tya'); }
          else { E('eor #$ffff'); E('inc a'); }
          pushReg(ins.s);
          break;
        }
        case 'not': {
          const t = top();
          if (t.k === 'const' && isNum(t.v)) { t.v = ins.s === 'L' ? (~t.v) >>> 0 : (~t.v) & 0xffff; break; }
          popA();
          if (ins.s === 'L') { E('eor #$ffff'); E('tay'); E('txa'); E('eor #$ffff'); E('tax'); E('tya'); }
          else E('eor #$ffff');
          pushReg(ins.s);
          break;
        }
        case 'ext': {
          const t = top();
          if (t.k === 'const' && isNum(t.v)) {
            t.cls = 'L';
            t.v = ins.u ? t.v & 0xffff : (((t.v & 0xffff) ^ 0x8000) - 0x8000) >>> 0;
            break;
          }
          popA();
          if (ins.u) E('ldx #0');
          else { const s = u('e'); E('ldx #0'); E('cmp #$8000'); E(`bcc ${s}`); E('dex'); LBL(s); }
          pushReg('L');
          break;
        }
        case 'trunc': {
          const t = top();
          if (t.k === 'const' && isNum(t.v)) { t.cls = 'W'; t.v = foldNarrow(t.v, ins.mt) & 0xffff; break; }
          if (t.k === 'const') { t.cls = 'W'; t.v = `(${t.v})&$ffff`; break; }
          const e = vs.pop();
          if (e.k === 'stk') { E('pla'); E('ply'); }
          narrow(ins.mt);
          pushReg('W');
          break;
        }
        case 'narrow': {
          const t = top();
          if (t.k === 'const' && isNum(t.v)) { t.v = foldNarrow(t.v, ins.mt) & 0xffff; break; }
          if (ins.mt === 'u16' || ins.mt === 's16') break;
          popA();
          narrow(ins.mt);
          pushReg('W');
          break;
        }
        case 'cmp': {
          const lT = u('t'), lE = u('d');
          cmpBranch(ins.c, ins.s, ins.u, lT);
          spill();
          E('lda #0'); E(`bra ${lE}`);
          LBL(lT); E('lda #1');
          LBL(lE);
          pushReg('W');
          break;
        }
        case 'jc': {
          cmpBranch(ins.c, ins.s, ins.u, ins.l);
          if (vs.some(e => e.k !== 'stk')) throw new Error('internal: values cached across a jump');
          break;
        }
        case 'jz': case 'jnz': {
          const t = vs.pop();
          if (t.k === 'const' && isNum(t.v)) {
            spill();
            if ((t.v === 0) === (ins.o === 'jz')) E(`jmp ${ins.l}`);
            break;
          }
          if (t.k === 'reg') E('tax');
          else if (t.k === 'stk') E('pla');
          else { E(`lda #${t.v}`); }
          if (vs.some(e => e.k !== 'stk')) throw new Error('internal: values cached across a jump');
          E(`${ins.o === 'jz' ? 'beq' : 'bne'} ${ins.l}`);
          break;
        }
        case 'jmp':
          spill();
          E(`bra ${ins.l}`);
          break;
        case 'label':
          spill();
          LBL(ins.l);
          break;
        case 'dup': {
          const t = top();
          if (t.k === 'const') { spill(); vs.push({ ...t, k: 'const' }); vs[vs.length - 2].k = 'stk'; break; }
          if (t.k === 'reg') {
            if (t.cls === 'L') E('phx');
            E('pha');
            t.k = 'stk';
            pushReg(t.cls);
            break;
          }
          if (t.cls === 'L') { E('lda 3,s'); E('tax'); E('lda 1,s'); }
          else E('lda 1,s');
          pushReg(t.cls);
          break;
        }
        case 'drop': popDiscard(); break;
        case 'arg': spill(); vs.pop(); break;
        case 'copy': {
          if (ins.n === 0) { popDiscard(); popDiscard(); break; }
          const src = vs.pop();
          if (src.k === 'const') E(`ldx #${lo16(src.v)}`);
          else if (src.k === 'reg') E('tax');
          else E('plx');
          const dst = vs.pop();
          if (dst.k === 'const') E(`ldy #${lo16(dst.v)}`);
          else if (dst.k === 'reg') E('tay');
          else E('ply');
          E(`lda #${ins.n - 1}`);
          E('mvn #0,#0');
          break;
        }
        case 'calli': {
          // a procedural variable: the address is on top (the arguments are out)
          if (J !== 'jsr') throw new Error('procedural calls are not supported in the far code model');
          popA();
          spill();
          E('sta @w rt_t0');
          E('ldx #0');
          E('jsr (rt_t0,x)');
          const n = ins.args;
          if (n) {
            if (n <= 8) for (let k = 0; k < n; k += 2) E('ply');
            else {
              if (ins.ret) E('tay');
              E('tsc'); E('clc'); E(`adc #${n}`); E('tcs');
              if (ins.ret) E('tya');
            }
          }
          if (ins.ret) pushReg(ins.ret);
          break;
        }
        case 'call': {
          spill();
          E(`${J} ${ins.l}`);
          const n = ins.args;
          if (n) {
            if (n <= 8) for (let k = 0; k < n; k += 2) E('ply');
            else {
              if (ins.ret) E('tay');
              E('tsc'); E('clc'); E(`adc #${n}`); E('tcs');
              if (ins.ret) E('tya');
            }
          }
          if (ins.ret) pushReg(ins.ret);
          break;
        }
        default:
          throw new Error(`internal: unknown IR op ${ins.o}`);
      }
    }
    if (vs.length) throw new Error(`internal: expression stack not empty at end of ${p.name}`);
    // epilogue (the exit label was the last IR op)
    if (p.retCls) {
      loadDp(1 + p.resultLoc.off, p.resultLoc.mt);
      E('tay');
    }
    if (FS) { E('tdc'); E('clc'); E(`adc #${FS}`); E('tcs'); }
    E('pld');
    if (p.retCls) E('tya');
    E(RET);
  }
}

