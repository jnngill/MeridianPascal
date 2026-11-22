// MERIDIAN Pascal - RV32IM assembler (GNU-like syntax subset)
// Pseudo-instructions: li la mv not neg seqz snez j jr ret call tail nop
// beqz bnez bltz bgez bgtz blez bgt ble bgtu bleu. Branches out of range are
// relaxed to an inverted branch over a jal.

import { evalExpr, splitArgs, AsmError } from './asm816.js';

const REGS = {};
'zero ra sp gp tp t0 t1 t2 s0 s1 a0 a1 a2 a3 a4 a5 a6 a7 s2 s3 s4 s5 s6 s7 s8 s9 s10 s11 t3 t4 t5 t6'
  .split(' ').forEach((n, i) => { REGS[n] = i; REGS['x' + i] = i; });
REGS.fp = 8;

const R = { add: [0, 0], sub: [0, 0x20], sll: [1, 0], slt: [2, 0], sltu: [3, 0], xor: [4, 0], srl: [5, 0],
  sra: [5, 0x20], or: [6, 0], and: [7, 0], mul: [0, 1], mulh: [1, 1], mulhsu: [2, 1], mulhu: [3, 1],
  div: [4, 1], divu: [5, 1], rem: [6, 1], remu: [7, 1] };
const I = { addi: 0, slti: 2, sltiu: 3, xori: 4, ori: 6, andi: 7 };
const SH = { slli: [1, 0], srli: [5, 0], srai: [5, 0x20] };
const LD = { lb: 0, lh: 1, lw: 2, lbu: 4, lhu: 5 };
const ST = { sb: 0, sh: 1, sw: 2 };
const BR = { beq: 0, bne: 1, blt: 4, bge: 5, bltu: 6, bgeu: 7 };
const BRINV = { beq: 'bne', bne: 'beq', blt: 'bge', bge: 'blt', bltu: 'bgeu', bgeu: 'bltu' };

const encR = (f7, f3, rd, rs1, rs2) => (f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | 0x33;
const encI = (op, f3, rd, rs1, imm) => ((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op;
const encS = (f3, rs2, rs1, imm) => (((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((imm & 0x1f) << 7) | 0x23;
const encB = (f3, rs1, rs2, off) => {
  const o = off & 0x1fff;
  return (((o >> 12) & 1) << 31) | (((o >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) |
    (((o >> 1) & 0xf) << 8) | (((o >> 11) & 1) << 7) | 0x63;
};
const encU = (op, rd, imm20) => ((imm20 & 0xfffff) << 12) | (rd << 7) | op;
const encJ = (rd, off) => {
  const o = off & 0x1fffff;
  return (((o >> 20) & 1) << 31) | (((o >> 1) & 0x3ff) << 21) | (((o >> 11) & 1) << 20) | (((o >> 12) & 0xff) << 12) | (rd << 7) | 0x6f;
};
const hiLo = (v) => {
  v = v | 0;
  const lo = ((v & 0xfff) ^ 0x800) - 0x800;
  const hi = ((v - lo) >>> 12) & 0xfffff;
  return [hi, lo];
};

function stripComment(line) {
  const i1 = line.indexOf('#'), i2 = line.indexOf(';');
  let i = -1;
  if (i1 >= 0) i = i1;
  if (i2 >= 0 && (i < 0 || i2 < i)) i = i2;
  return i >= 0 ? line.slice(0, i) : line;
}

export function assembleRV(text, opts = {}) {
  const lines = text.split(/\r?\n/);
  const parsed = [];
  lines.forEach((raw, idx) => {
    const line = stripComment(raw).trim();
    if (!line) { parsed.push({ idx, raw, kind: 'none' }); return; }
    let m;
    if ((m = /^([A-Za-z_.][A-Za-z0-9_.$]*)\s*=\s*(.+)$/.exec(line))) { parsed.push({ idx, raw, kind: 'equ', name: m[1], e: m[2] }); return; }
    let label = null, rest = line;
    if ((m = /^([A-Za-z_.][A-Za-z0-9_.$]*):/.exec(line))) { label = m[1]; rest = line.slice(m[0].length).trim(); }
    if (!rest) { parsed.push({ idx, raw, kind: 'label', label }); return; }
    const sp = /^(\S+)\s*(.*)$/.exec(rest);
    parsed.push({ idx, raw, kind: sp[1].startsWith('.') ? 'dir' : 'ins', label, mn: sp[1].toLowerCase(), arg: sp[2] });
  });

  const syms = new Map(Object.entries(opts.symbols || {}));
  const longLi = new Set();
  const relaxed = new Set();
  let out, listing, pc;

  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    const final = pass > 0;
    out = []; listing = [];
    pc = opts.org || 0;
    const setSym = (n, v) => { if (syms.get(n) !== v) { changed = true; syms.set(n, v); } };
    let cur;
    const ev = (e) => {
      try { return evalExpr(e, syms, pc, pass === 0); }
      catch (err) { throw new AsmError(err.message, cur.idx + 1, cur.raw); }
    };
    const rg = (s) => {
      const r = REGS[s.trim().toLowerCase()];
      if (r === undefined) throw new AsmError(`bad register '${s}'`, cur.idx + 1, cur.raw);
      return r;
    };
    const memArg = (s) => {
      const m = /^(.*)\((\w+)\)$/.exec(s.trim());
      if (!m) throw new AsmError(`bad memory operand '${s}'`, cur.idx + 1, cur.raw);
      return [m[1].trim() ? ev(m[1]).v : 0, rg(m[2])];
    };
    for (let li = 0; li < parsed.length; li++) {
      const L = cur = parsed[li];
      if (L.kind === 'none') continue;
      if (L.kind === 'equ') { setSym(L.name, ev(L.e).v); continue; }
      if (L.label) setSym(L.label, pc);
      if (L.kind === 'label') continue;
      const start = pc;
      const bytes = [];
      const w32 = (v) => { bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); };
      const a = splitArgs(L.arg);
      if (L.kind === 'dir') {
        switch (L.mn) {
          case '.byte': for (const x of a) bytes.push(ev(x).v & 255); break;
          case '.half': for (const x of a) { const v = ev(x).v; bytes.push(v & 255, (v >> 8) & 255); } break;
          case '.word': for (const x of a) w32(ev(x).v); break;
          case '.fill': { const n = ev(a[0]).v; for (let k = 0; k < n; k++) bytes.push(0); break; }
          case '.align': { const n = ev(a[0]).v; while ((pc + bytes.length) % n) bytes.push(0); break; }
          default: throw new AsmError(`unknown directive ${L.mn}`, L.idx + 1, L.raw);
        }
      } else {
        const mn = L.mn;
        const emitLi = (rd, val, undef) => {
          if (!undef && fits(val) && !longLi.has(li)) { w32(encI(0x13, 0, rd, 0, val)); return; }
          if (undef || !fits(val)) longLi.add(li);
          const [hi, lo] = hiLo(val);
          w32(encU(0x37, rd, hi));
          w32(encI(0x13, 0, rd, rd, lo));
        };
        const fits = (v) => v >= -2048 && v <= 2047;
        const branchTo = (op, rs1, rs2, target) => {
          const t = ev(target).v;
          if (relaxed.has(li)) {
            w32(encB(BR[BRINV[op]], rs1, rs2, 8));
            w32(encJ(0, t - (pc + 4)));
            return;
          }
          const off = t - pc;
          if (final && (off < -4096 || off > 4094)) { relaxed.add(li); changed = true; }
          w32(encB(BR[op], rs1, rs2, off));
        };
        if (R[mn]) { const [f3, f7] = R[mn]; w32(encR(f7, f3, rg(a[0]), rg(a[1]), rg(a[2]))); }
        else if (I[mn] !== undefined) { const v = ev(a[2]).v; if (final && !fits(v)) throw new AsmError('immediate out of range', L.idx + 1, L.raw); w32(encI(0x13, I[mn], rg(a[0]), rg(a[1]), v)); }
        else if (SH[mn]) { const [f3, f7] = SH[mn]; w32(encI(0x13, f3, rg(a[0]), rg(a[1]), (ev(a[2]).v & 31) | (f7 << 5))); }
        else if (LD[mn] !== undefined) { const [off, base] = memArg(a[1]); w32(encI(0x03, LD[mn], rg(a[0]), base, off)); }
        else if (ST[mn] !== undefined) { const [off, base] = memArg(a[1]); w32(encS(ST[mn], rg(a[0]), base, off)); }
        else if (BR[mn] !== undefined) branchTo(mn, rg(a[0]), rg(a[1]), a[2]);
        else switch (mn) {
          case 'lui': w32(encU(0x37, rg(a[0]), ev(a[1]).v)); break;
          case 'auipc': w32(encU(0x17, rg(a[0]), ev(a[1]).v)); break;
          case 'jal':
            if (a.length === 1) w32(encJ(1, ev(a[0]).v - pc));
            else w32(encJ(rg(a[0]), ev(a[1]).v - pc));
            break;
          case 'jalr':
            if (a.length === 1) w32(encI(0x67, 0, 1, rg(a[0]), 0));
            else if (a.length === 2 && /\(/.test(a[1])) { const [off, base] = memArg(a[1]); w32(encI(0x67, 0, rg(a[0]), base, off)); }
            else w32(encI(0x67, 0, rg(a[0]), rg(a[1]), a[2] ? ev(a[2]).v : 0));
            break;
          case 'ecall': w32(0x73); break;
          case 'ebreak': w32(0x00100073); break;
          case 'fence': w32(0x0ff0000f); break;
          case 'nop': w32(encI(0x13, 0, 0, 0, 0)); break;
          case 'li': { const r = ev(a[1]); emitLi(rg(a[0]), r.v, r.undef); break; }
          case 'la': {
            const r = ev(a[1]);
            const [hi, lo] = hiLo(r.v);
            const rd = rg(a[0]);
            w32(encU(0x37, rd, hi));
            w32(encI(0x13, 0, rd, rd, lo));
            break;
          }
          case 'mv': w32(encI(0x13, 0, rg(a[0]), rg(a[1]), 0)); break;
          case 'not': w32(encI(0x13, 4, rg(a[0]), rg(a[1]), -1)); break;
          case 'neg': w32(encR(0x20, 0, rg(a[0]), 0, rg(a[1]))); break;
          case 'seqz': w32(encI(0x13, 3, rg(a[0]), rg(a[1]), 1)); break;
          case 'snez': w32(encR(0, 3, rg(a[0]), 0, rg(a[1]))); break;
          case 'j': w32(encJ(0, ev(a[0]).v - pc)); break;
          case 'jr': w32(encI(0x67, 0, 0, rg(a[0]), 0)); break;
          case 'ret': w32(encI(0x67, 0, 0, 1, 0)); break;
          case 'call': w32(encJ(1, ev(a[0]).v - pc)); break;
          case 'tail': w32(encJ(0, ev(a[0]).v - pc)); break;
          case 'beqz': branchTo('beq', rg(a[0]), 0, a[1]); break;
          case 'bnez': branchTo('bne', rg(a[0]), 0, a[1]); break;
          case 'bltz': branchTo('blt', rg(a[0]), 0, a[1]); break;
          case 'bgez': branchTo('bge', rg(a[0]), 0, a[1]); break;
          case 'bgtz': branchTo('blt', 0, rg(a[0]), a[1]); break;
          case 'blez': branchTo('bge', 0, rg(a[0]), a[1]); break;
          case 'bgt': branchTo('blt', rg(a[1]), rg(a[0]), a[2]); break;
          case 'ble': branchTo('bge', rg(a[1]), rg(a[0]), a[2]); break;
          case 'bgtu': branchTo('bltu', rg(a[1]), rg(a[0]), a[2]); break;
          case 'bleu': branchTo('bgeu', rg(a[1]), rg(a[0]), a[2]); break;
          default: throw new AsmError(`unknown instruction '${mn}'`, L.idx + 1, L.raw);
        }
      }
      for (const b of bytes) out.push(b);
      pc += bytes.length;
      if (opts.listing) listing.push({ addr: start, bytes, src: L.raw, line: L.idx + 1 });
    }
    if (!changed && pass > 0) break;
    if (pass === 11) throw new AsmError('assembler did not converge', 0, '');
  }
  return { bytes: Uint8Array.from(out), origin: opts.org || 0, symbols: syms, listing };
}

export function formatListingRV(listing) {
  const hx = (v, n) => (v >>> 0).toString(16).padStart(n, '0');
  return listing.map(l => {
    let b = '';
    for (let i = 0; i < Math.min(l.bytes.length, 8); i += 4) {
      const w = l.bytes[i] | (l.bytes[i + 1] << 8) | (l.bytes[i + 2] << 16) | (l.bytes[i + 3] << 24);
      b += hx(w, 8) + ' ';
    }
    if (l.bytes.length > 8) b += '..';
    return `${l.bytes.length || l.src.trim() ? hx(l.addr, 6) : '      '}  ${b.padEnd(19)} ${l.src}`;
  }).join('\n');
}
