// 65C816 CPU emulator (complete instruction set, emulation + native mode)
// bus: { read(addr24) -> byte, write(addr24, byte) }

const C = 0x01, Z = 0x02, I = 0x04, D = 0x08, X = 0x10, M = 0x20, V = 0x40, N = 0x80;

// base cycle counts (8-bit / emulation); +1 per extra byte in 16-bit mode is added in ops
const CYC = [
  7,6,7,4,5,3,5,6,3,2,2,4,6,4,6,5, 2,5,5,7,5,4,6,6,2,4,2,2,6,4,7,5,
  6,6,8,4,3,3,5,6,4,2,2,5,4,4,6,5, 2,5,5,7,4,4,6,6,2,4,2,2,4,4,7,5,
  6,6,2,4,7,3,5,6,3,2,2,3,3,4,6,5, 2,5,5,7,7,4,6,6,2,4,3,2,4,4,7,5,
  6,6,6,4,3,3,5,6,4,2,2,6,5,4,6,5, 2,5,5,7,4,4,6,6,2,4,4,2,6,4,7,5,
  3,6,4,4,3,3,3,6,2,2,2,3,4,4,4,5, 2,6,5,7,4,4,4,6,2,5,2,2,4,5,5,5,
  2,6,2,4,3,3,3,6,2,2,2,4,4,4,4,5, 2,5,5,7,4,4,4,6,2,4,2,2,4,4,4,5,
  2,6,3,4,3,3,5,6,2,2,2,3,4,4,6,5, 2,5,5,7,6,4,6,6,2,4,3,3,6,4,7,5,
  2,6,3,4,3,3,5,6,2,2,2,3,4,4,6,5, 2,5,5,7,5,4,6,6,2,4,4,2,8,4,7,5,
];

export class CPU65816 {
  constructor(bus) {
    this.bus = bus;
    this.reset();
  }
  reset() {
    this.a = 0; this.x = 0; this.y = 0; this.s = 0x01ff; this.d = 0;
    this.dbr = 0; this.pbr = 0; this.p = M | X | I; this.e = 1;
    this.pc = this.rd16(0xfffc);
    this.cycles = 0;
    this.stopped = false; this.waiting = false;
    this.nmiPending = false; this.irqLine = false;
  }
  get m8() { return (this.p & M) !== 0; }
  get x8() { return (this.p & X) !== 0; }

  rd(a) { return this.bus.read(a & 0xffffff); }
  wr(a, v) { this.bus.write(a & 0xffffff, v & 0xff); }
  rd16(a) { return this.rd(a) | (this.rd(a + 1) << 8); }
  // bank-0 wrapping 16-bit read (direct page, stack)
  rd16z(a) { return this.rd(a & 0xffff) | (this.rd((a + 1) & 0xffff) << 8); }
  fetch() { const v = this.rd((this.pbr << 16) | this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  fetch16() { const lo = this.fetch(); return lo | (this.fetch() << 8); }
  fetch24() { const lo = this.fetch16(); return lo | (this.fetch() << 16); }

  push8(v) {
    this.wr(this.s, v);
    if (this.e) this.s = 0x100 | ((this.s - 1) & 0xff); else this.s = (this.s - 1) & 0xffff;
  }
  pull8() {
    if (this.e) this.s = 0x100 | ((this.s + 1) & 0xff); else this.s = (this.s + 1) & 0xffff;
    return this.rd(this.s);
  }
  push16(v) { this.push8(v >> 8); this.push8(v); }
  pull16() { const lo = this.pull8(); return lo | (this.pull8() << 8); }
  // native-style pushes that ignore emulation wrapping (PEA/PEI/PER/PHD/PLD/JSL/RTL...)
  pushN8(v) { this.wr(this.s, v); this.s = (this.s - 1) & 0xffff; }
  pullN8() { this.s = (this.s + 1) & 0xffff; return this.rd(this.s); }
  pushN16(v) { this.pushN8(v >> 8); this.pushN8(v); }
  pullN16() { const lo = this.pullN8(); return lo | (this.pullN8() << 8); }
  fixS() { if (this.e) this.s = 0x100 | (this.s & 0xff); }

  setP(v) {
    if (this.e) v |= M | X;
    this.p = v & 0xff;
    if (this.p & X) { this.x &= 0xff; this.y &= 0xff; }
  }
  nz8(v) { this.p = (this.p & ~(N | Z)) | (v & 0x80) | ((v & 0xff) === 0 ? Z : 0); }
  nz16(v) { this.p = (this.p & ~(N | Z)) | ((v >> 8) & 0x80) | ((v & 0xffff) === 0 ? Z : 0); }
  nzM(v) { if (this.m8) this.nz8(v); else this.nz16(v); }
  nzX(v) { if (this.x8) this.nz8(v); else this.nz16(v); }

  // ---- effective addresses (24 bit)
  aDp() { return (this.d + this.fetch()) & 0xffff; }
  // emulation mode with DL = 0: indexed direct page wraps within the page, as on a 6502
  aDpX() { const n = this.fetch(); return this.e && !(this.d & 0xff) ? this.d | ((n + this.x) & 0xff) : (this.d + n + this.x) & 0xffff; }
  aDpY() { const n = this.fetch(); return this.e && !(this.d & 0xff) ? this.d | ((n + this.y) & 0xff) : (this.d + n + this.y) & 0xffff; }
  aAbs() { return (this.dbr << 16) | this.fetch16(); }
  aAbsX() { return (((this.dbr << 16) | this.fetch16()) + this.x) & 0xffffff; }
  aAbsY() { return (((this.dbr << 16) | this.fetch16()) + this.y) & 0xffffff; }
  aLong() { return this.fetch24(); }
  aLongX() { return (this.fetch24() + this.x) & 0xffffff; }
  aInd() { const p = this.rd16z(this.aDp()); return (this.dbr << 16) | p; }
  aIndX() { const p = this.rd16z(this.aDpX()); return (this.dbr << 16) | p; }
  aIndY() { const p = this.rd16z(this.aDp()); return (((this.dbr << 16) | p) + this.y) & 0xffffff; }
  aIndL() { const z = this.aDp(); return this.rd16z(z) | (this.rd((z + 2) & 0xffff) << 16); }
  aIndLY() { return (this.aIndL() + this.y) & 0xffffff; }
  aSr() { return (this.s + this.fetch()) & 0xffff; }
  aSrY() { const p = this.rd16z(this.aSr()); return (((this.dbr << 16) | p) + this.y) & 0xffffff; }

  // ---- reads/writes by register width
  rdM(a) { return this.m8 ? this.rd(a) : this.rd(a) | (this.rd((a + 1) & 0xffffff) << 8); }
  wrM(a, v) { this.wr(a, v); if (!this.m8) this.wr((a + 1) & 0xffffff, v >> 8); }
  rdX(a) { return this.x8 ? this.rd(a) : this.rd(a) | (this.rd((a + 1) & 0xffffff) << 8); }
  wrX(a, v) { this.wr(a, v); if (!this.x8) this.wr((a + 1) & 0xffffff, v >> 8); }
  // direct page / stack relative: wrap in bank 0
  rdMz(a) { return this.m8 ? this.rd(a) : this.rd(a) | (this.rd((a + 1) & 0xffff) << 8); }
  wrMz(a, v) { this.wr(a, v); if (!this.m8) this.wr((a + 1) & 0xffff, v >> 8); }
  rdXz(a) { return this.x8 ? this.rd(a) : this.rd(a) | (this.rd((a + 1) & 0xffff) << 8); }
  wrXz(a, v) { this.wr(a, v); if (!this.x8) this.wr((a + 1) & 0xffff, v >> 8); }
  immM() { return this.m8 ? this.fetch() : this.fetch16(); }
  immX() { return this.x8 ? this.fetch() : this.fetch16(); }

  getA() { return this.m8 ? this.a & 0xff : this.a; }
  setA(v) { if (this.m8) this.a = (this.a & 0xff00) | (v & 0xff); else this.a = v & 0xffff; }

  // ---- ALU
  adc(v) {
    const c = this.p & C;
    if (this.m8) {
      const a = this.a & 0xff;
      let r;
      if (this.p & D) {
        let lo = (a & 0x0f) + (v & 0x0f) + c;
        if (lo > 9) lo += 6;
        let hi = (a >> 4) + (v >> 4) + (lo > 0x0f ? 1 : 0);
        const vr = ((~(a ^ v) & (a ^ (hi << 4))) & 0x80);
        if (hi > 9) hi += 6;
        r = ((hi << 4) | (lo & 0x0f)) & 0xff;
        this.p = (this.p & ~(C | V)) | (hi > 0x0f ? C : 0) | (vr ? V : 0);
      } else {
        const s = a + v + c;
        r = s & 0xff;
        this.p = (this.p & ~(C | V)) | (s > 0xff ? C : 0) | ((~(a ^ v) & (a ^ r) & 0x80) ? V : 0);
      }
      this.nz8(r);
      this.a = (this.a & 0xff00) | r;
    } else {
      const a = this.a;
      let r;
      if (this.p & D) {
        let carry = c, res = 0;
        for (let i = 0; i < 16; i += 4) {
          let d = ((a >> i) & 15) + ((v >> i) & 15) + carry;
          carry = d > 9 ? 1 : 0;
          if (carry) d += 6;
          res |= (d & 15) << i;
        }
        r = res;
        this.p = (this.p & ~(C | V)) | (carry ? C : 0) | ((~(a ^ v) & (a ^ r) & 0x8000) ? V : 0);
      } else {
        const s = a + v + c;
        r = s & 0xffff;
        this.p = (this.p & ~(C | V)) | (s > 0xffff ? C : 0) | ((~(a ^ v) & (a ^ r) & 0x8000) ? V : 0);
      }
      this.nz16(r);
      this.a = r;
    }
  }
  sbc(v) {
    if (this.p & D) {
      // decimal subtract
      const w = this.m8 ? 8 : 16;
      const a = this.getA();
      let borrow = (this.p & C) ? 0 : 1, res = 0;
      for (let i = 0; i < w; i += 4) {
        let d = ((a >> i) & 15) - ((v >> i) & 15) - borrow;
        borrow = d < 0 ? 1 : 0;
        if (borrow) d += 10;
        res |= (d & 15) << i;
      }
      const bin = a - v - ((this.p & C) ? 0 : 1);
      const mask = w === 8 ? 0x80 : 0x8000;
      this.p = (this.p & ~(C | V)) | (borrow ? 0 : C) | (((a ^ v) & (a ^ bin) & mask) ? V : 0);
      this.setA(res);
      this.nzM(res);
      return;
    }
    this.adc((this.m8 ? ~v & 0xff : ~v & 0xffff));
  }
  cmpR(r, v, eight) {
    const t = r - v;
    this.p = (this.p & ~C) | (t >= 0 ? C : 0);
    if (eight) this.nz8(t & 0xff); else this.nz16(t & 0xffff);
  }
  // read-modify-write helpers
  rmw(addr, fn, z) {
    const v = z ? this.rdMz(addr) : this.rdM(addr);
    const r = fn(v);
    if (z) this.wrMz(addr, r); else this.wrM(addr, r);
  }
  asl(v) {
    if (this.m8) { this.p = (this.p & ~C) | ((v >> 7) & 1); v = (v << 1) & 0xff; }
    else { this.p = (this.p & ~C) | ((v >> 15) & 1); v = (v << 1) & 0xffff; }
    this.nzM(v); return v;
  }
  lsr(v) { this.p = (this.p & ~C) | (v & 1); v >>= 1; this.nzM(v); return v; }
  rol(v) {
    const c = this.p & C;
    if (this.m8) { this.p = (this.p & ~C) | ((v >> 7) & 1); v = ((v << 1) | c) & 0xff; }
    else { this.p = (this.p & ~C) | ((v >> 15) & 1); v = ((v << 1) | c) & 0xffff; }
    this.nzM(v); return v;
  }
  ror(v) {
    const c = this.p & C;
    this.p = (this.p & ~C) | (v & 1);
    v = (v >> 1) | (c ? (this.m8 ? 0x80 : 0x8000) : 0);
    this.nzM(v); return v;
  }
  inc(v) { v = (v + 1) & (this.m8 ? 0xff : 0xffff); this.nzM(v); return v; }
  dec(v) { v = (v - 1) & (this.m8 ? 0xff : 0xffff); this.nzM(v); return v; }
  bit(v, imm) {
    const a = this.getA();
    this.p = (this.p & ~Z) | ((a & v) === 0 ? Z : 0);
    if (!imm) {
      if (this.m8) this.p = (this.p & ~(N | V)) | (v & 0xc0);
      else this.p = (this.p & ~(N | V)) | ((v >> 8) & 0xc0);
    }
  }
  tsb(v) { const a = this.getA(); this.p = (this.p & ~Z) | ((a & v) === 0 ? Z : 0); return v | a; }
  trb(v) { const a = this.getA(); this.p = (this.p & ~Z) | ((a & v) === 0 ? Z : 0); return v & ~a; }

  branch(cond) {
    const off = this.fetch();
    if (cond) {
      this.pc = (this.pc + ((off << 24) >> 24)) & 0xffff;
      this.cycles++;
    }
  }

  interrupt(vecNative, vecEmu, isBrk) {
    if (!this.e) this.pushN8(this.pbr);
    this.push16(this.pc);
    this.push8(this.e && !isBrk ? this.p & ~0x10 : this.p);
    this.p = (this.p | I) & ~D;
    this.pbr = 0;
    this.pc = this.rd16(this.e ? vecEmu : vecNative);
    this.cycles += 7;
  }
  nmi() { this.waiting = false; this.interrupt(0xffea, 0xfffa, false); }
  irq() { if (!(this.p & I)) { this.waiting = false; this.interrupt(0xffee, 0xfffe, false); } }

  // run one instruction, returns cycles used
  step() {
    if (this.stopped) return 1;
    if (this.waiting) return 1;
    const c0 = this.cycles;
    const op = this.fetch();
    this.cycles += CYC[op] + ((!this.m8 && MEXTRA[op]) ? 1 : 0) + ((!this.x8 && XEXTRA[op]) ? 1 : 0);
    this.exec(op);
    return this.cycles - c0;
  }

  exec(op) {
    let a, v;
    switch (op) {
      // ---- group 1: ORA AND EOR ADC STA LDA CMP SBC
      case 0x01: case 0x03: case 0x05: case 0x07: case 0x09: case 0x0d: case 0x0f:
      case 0x11: case 0x12: case 0x13: case 0x15: case 0x17: case 0x19: case 0x1d: case 0x1f:
      case 0x21: case 0x23: case 0x25: case 0x27: case 0x29: case 0x2d: case 0x2f:
      case 0x31: case 0x32: case 0x33: case 0x35: case 0x37: case 0x39: case 0x3d: case 0x3f:
      case 0x41: case 0x43: case 0x45: case 0x47: case 0x49: case 0x4d: case 0x4f:
      case 0x51: case 0x52: case 0x53: case 0x55: case 0x57: case 0x59: case 0x5d: case 0x5f:
      case 0x61: case 0x63: case 0x65: case 0x67: case 0x69: case 0x6d: case 0x6f:
      case 0x71: case 0x72: case 0x73: case 0x75: case 0x77: case 0x79: case 0x7d: case 0x7f:
      case 0x81: case 0x83: case 0x85: case 0x87: case 0x8d: case 0x8f:
      case 0x91: case 0x92: case 0x93: case 0x95: case 0x97: case 0x99: case 0x9d: case 0x9f:
      case 0xa1: case 0xa3: case 0xa5: case 0xa7: case 0xa9: case 0xad: case 0xaf:
      case 0xb1: case 0xb2: case 0xb3: case 0xb5: case 0xb7: case 0xb9: case 0xbd: case 0xbf:
      case 0xc1: case 0xc3: case 0xc5: case 0xc7: case 0xc9: case 0xcd: case 0xcf:
      case 0xd1: case 0xd2: case 0xd3: case 0xd5: case 0xd7: case 0xd9: case 0xdd: case 0xdf:
      case 0xe1: case 0xe3: case 0xe5: case 0xe7: case 0xe9: case 0xed: case 0xef:
      case 0xf1: case 0xf2: case 0xf3: case 0xf5: case 0xf7: case 0xf9: case 0xfd: case 0xff: {
        const grp = op >> 5;
        const mode = op & 0x1f;
        let z = false, imm = false;
        switch (mode) {
          case 0x01: a = this.aIndX(); break;
          case 0x03: a = this.aSr(); z = true; break;
          case 0x05: a = this.aDp(); z = true; break;
          case 0x07: a = this.aIndL(); break;
          case 0x09: imm = true; break;
          case 0x0d: a = this.aAbs(); break;
          case 0x0f: a = this.aLong(); break;
          case 0x11: a = this.aIndY(); break;
          case 0x12: a = this.aInd(); break;
          case 0x13: a = this.aSrY(); break;
          case 0x15: a = this.aDpX(); z = true; break;
          case 0x17: a = this.aIndLY(); break;
          case 0x19: a = this.aAbsY(); break;
          case 0x1d: a = this.aAbsX(); break;
          case 0x1f: a = this.aLongX(); break;
        }
        if (grp === 4) { // STA
          if (z) this.wrMz(a, this.a); else this.wrM(a, this.a);
          break;
        }
        v = imm ? this.immM() : (z ? this.rdMz(a) : this.rdM(a));
        switch (grp) {
          case 0: v = this.getA() | v; this.setA(v); this.nzM(v); break;
          case 1: v = this.getA() & v; this.setA(v); this.nzM(v); break;
          case 2: v = this.getA() ^ v; this.setA(v); this.nzM(v); break;
          case 3: this.adc(v); break;
          case 5: this.setA(v); this.nzM(v); break;
          case 6: this.cmpR(this.getA(), v, this.m8); break;
          case 7: this.sbc(v); break;
        }
        break;
      }
      // ---- shifts / inc / dec
      case 0x0a: this.setA(this.asl(this.getA())); break;
      case 0x06: a = this.aDp(); this.rmw(a, v => this.asl(v), true); break;
      case 0x16: a = this.aDpX(); this.rmw(a, v => this.asl(v), true); break;
      case 0x0e: a = this.aAbs(); this.rmw(a, v => this.asl(v)); break;
      case 0x1e: a = this.aAbsX(); this.rmw(a, v => this.asl(v)); break;
      case 0x4a: this.setA(this.lsr(this.getA())); break;
      case 0x46: a = this.aDp(); this.rmw(a, v => this.lsr(v), true); break;
      case 0x56: a = this.aDpX(); this.rmw(a, v => this.lsr(v), true); break;
      case 0x4e: a = this.aAbs(); this.rmw(a, v => this.lsr(v)); break;
      case 0x5e: a = this.aAbsX(); this.rmw(a, v => this.lsr(v)); break;
      case 0x2a: this.setA(this.rol(this.getA())); break;
      case 0x26: a = this.aDp(); this.rmw(a, v => this.rol(v), true); break;
      case 0x36: a = this.aDpX(); this.rmw(a, v => this.rol(v), true); break;
      case 0x2e: a = this.aAbs(); this.rmw(a, v => this.rol(v)); break;
      case 0x3e: a = this.aAbsX(); this.rmw(a, v => this.rol(v)); break;
      case 0x6a: this.setA(this.ror(this.getA())); break;
      case 0x66: a = this.aDp(); this.rmw(a, v => this.ror(v), true); break;
      case 0x76: a = this.aDpX(); this.rmw(a, v => this.ror(v), true); break;
      case 0x6e: a = this.aAbs(); this.rmw(a, v => this.ror(v)); break;
      case 0x7e: a = this.aAbsX(); this.rmw(a, v => this.ror(v)); break;
      case 0x1a: this.setA(this.inc(this.getA())); break;
      case 0xe6: a = this.aDp(); this.rmw(a, v => this.inc(v), true); break;
      case 0xf6: a = this.aDpX(); this.rmw(a, v => this.inc(v), true); break;
      case 0xee: a = this.aAbs(); this.rmw(a, v => this.inc(v)); break;
      case 0xfe: a = this.aAbsX(); this.rmw(a, v => this.inc(v)); break;
      case 0x3a: this.setA(this.dec(this.getA())); break;
      case 0xc6: a = this.aDp(); this.rmw(a, v => this.dec(v), true); break;
      case 0xd6: a = this.aDpX(); this.rmw(a, v => this.dec(v), true); break;
      case 0xce: a = this.aAbs(); this.rmw(a, v => this.dec(v)); break;
      case 0xde: a = this.aAbsX(); this.rmw(a, v => this.dec(v)); break;
      // ---- bit / tsb / trb
      case 0x89: this.bit(this.immM(), true); break;
      case 0x24: this.bit(this.rdMz(this.aDp())); break;
      case 0x34: this.bit(this.rdMz(this.aDpX())); break;
      case 0x2c: this.bit(this.rdM(this.aAbs())); break;
      case 0x3c: this.bit(this.rdM(this.aAbsX())); break;
      case 0x04: a = this.aDp(); this.rmw(a, v => this.tsb(v), true); break;
      case 0x0c: a = this.aAbs(); this.rmw(a, v => this.tsb(v)); break;
      case 0x14: a = this.aDp(); this.rmw(a, v => this.trb(v), true); break;
      case 0x1c: a = this.aAbs(); this.rmw(a, v => this.trb(v)); break;
      // ---- index registers
      case 0xa2: this.x = this.immX(); this.nzX(this.x); break;
      case 0xa6: this.x = this.rdXz(this.aDp()); this.nzX(this.x); break;
      case 0xb6: this.x = this.rdXz(this.aDpY()); this.nzX(this.x); break;
      case 0xae: this.x = this.rdX(this.aAbs()); this.nzX(this.x); break;
      case 0xbe: this.x = this.rdX(this.aAbsY()); this.nzX(this.x); break;
      case 0xa0: this.y = this.immX(); this.nzX(this.y); break;
      case 0xa4: this.y = this.rdXz(this.aDp()); this.nzX(this.y); break;
      case 0xb4: this.y = this.rdXz(this.aDpX()); this.nzX(this.y); break;
      case 0xac: this.y = this.rdX(this.aAbs()); this.nzX(this.y); break;
      case 0xbc: this.y = this.rdX(this.aAbsX()); this.nzX(this.y); break;
      case 0x86: this.wrXz(this.aDp(), this.x); break;
      case 0x96: this.wrXz(this.aDpY(), this.x); break;
      case 0x8e: this.wrX(this.aAbs(), this.x); break;
      case 0x84: this.wrXz(this.aDp(), this.y); break;
      case 0x94: this.wrXz(this.aDpX(), this.y); break;
      case 0x8c: this.wrX(this.aAbs(), this.y); break;
      case 0x64: this.wrMz(this.aDp(), 0); break;
      case 0x74: this.wrMz(this.aDpX(), 0); break;
      case 0x9c: this.wrM(this.aAbs(), 0); break;
      case 0x9e: this.wrM(this.aAbsX(), 0); break;
      case 0xe0: this.cmpR(this.x, this.immX(), this.x8); break;
      case 0xe4: this.cmpR(this.x, this.rdXz(this.aDp()), this.x8); break;
      case 0xec: this.cmpR(this.x, this.rdX(this.aAbs()), this.x8); break;
      case 0xc0: this.cmpR(this.y, this.immX(), this.x8); break;
      case 0xc4: this.cmpR(this.y, this.rdXz(this.aDp()), this.x8); break;
      case 0xcc: this.cmpR(this.y, this.rdX(this.aAbs()), this.x8); break;
      case 0xe8: this.x = (this.x + 1) & (this.x8 ? 0xff : 0xffff); this.nzX(this.x); break;
      case 0xc8: this.y = (this.y + 1) & (this.x8 ? 0xff : 0xffff); this.nzX(this.y); break;
      case 0xca: this.x = (this.x - 1) & (this.x8 ? 0xff : 0xffff); this.nzX(this.x); break;
      case 0x88: this.y = (this.y - 1) & (this.x8 ? 0xff : 0xffff); this.nzX(this.y); break;
      // ---- transfers
      case 0xaa: this.x = this.x8 ? this.a & 0xff : this.a; this.nzX(this.x); break;
      case 0xa8: this.y = this.x8 ? this.a & 0xff : this.a; this.nzX(this.y); break;
      case 0x8a: this.setA(this.x); this.nzM(this.getA()); break;
      case 0x98: this.setA(this.y); this.nzM(this.getA()); break;
      case 0x9b: this.y = this.x; this.nzX(this.y); break;
      case 0xbb: this.x = this.y; this.nzX(this.x); break;
      case 0xba: this.x = this.x8 ? this.s & 0xff : this.s; this.nzX(this.x); break;
      case 0x9a: this.s = this.e ? 0x100 | (this.x & 0xff) : this.x; break;
      case 0x5b: this.d = this.a; this.nz16(this.d); break;
      case 0x7b: this.a = this.d; this.nz16(this.a); break;
      case 0x1b: this.s = this.e ? 0x100 | (this.a & 0xff) : this.a; break;
      case 0x3b: this.a = this.s; this.nz16(this.a); break;
      case 0xeb: this.a = ((this.a >> 8) | (this.a << 8)) & 0xffff; this.nz8(this.a & 0xff); break;
      case 0xfb: {
        const c = this.p & C;
        this.p = (this.p & ~C) | this.e;
        this.e = c;
        if (this.e) { this.p |= M | X; this.x &= 0xff; this.y &= 0xff; this.s = 0x100 | (this.s & 0xff); }
        break;
      }
      // ---- stack
      case 0x48: if (this.m8) this.push8(this.a); else this.push16(this.a); break;
      case 0x68: if (this.m8) { this.setA(this.pull8()); } else { this.a = this.pull16(); } this.nzM(this.getA()); break;
      case 0xda: if (this.x8) this.push8(this.x); else this.push16(this.x); break;
      case 0xfa: this.x = this.x8 ? this.pull8() : this.pull16(); this.nzX(this.x); break;
      case 0x5a: if (this.x8) this.push8(this.y); else this.push16(this.y); break;
      case 0x7a: this.y = this.x8 ? this.pull8() : this.pull16(); this.nzX(this.y); break;
      case 0x08: this.push8(this.p | (this.e ? 0x30 : 0)); break;
      case 0x28: this.setP(this.pull8()); break;
      case 0x8b: this.push8(this.dbr); break;
      case 0xab: this.dbr = this.pull8(); this.nz8(this.dbr); break;
      case 0x4b: this.push8(this.pbr); break;
      case 0x0b: this.pushN16(this.d); this.fixS(); break;
      case 0x2b: this.d = this.pullN16(); this.fixS(); this.nz16(this.d); break;
      case 0xf4: this.pushN16(this.fetch16()); this.fixS(); break;
      case 0xd4: { const z = this.aDp(); this.pushN16(this.rd16z(z)); this.fixS(); break; }
      case 0x62: { const o = this.fetch16(); this.pushN16((this.pc + o) & 0xffff); this.fixS(); break; }
      // ---- flags
      case 0x18: this.p &= ~C; break;
      case 0x38: this.p |= C; break;
      case 0x58: this.p &= ~I; break;
      case 0x78: this.p |= I; break;
      case 0xd8: this.p &= ~D; break;
      case 0xf8: this.p |= D; break;
      case 0xb8: this.p &= ~V; break;
      case 0xc2: this.setP(this.p & ~this.fetch()); break;
      case 0xe2: this.setP(this.p | this.fetch()); break;
      // ---- branches
      case 0x10: this.branch(!(this.p & N)); break;
      case 0x30: this.branch(this.p & N); break;
      case 0x50: this.branch(!(this.p & V)); break;
      case 0x70: this.branch(this.p & V); break;
      case 0x90: this.branch(!(this.p & C)); break;
      case 0xb0: this.branch(this.p & C); break;
      case 0xd0: this.branch(!(this.p & Z)); break;
      case 0xf0: this.branch(this.p & Z); break;
      case 0x80: this.branch(true); break;
      case 0x82: { const o = this.fetch16(); this.pc = (this.pc + o) & 0xffff; break; }
      // ---- jumps
      case 0x4c: this.pc = this.fetch16(); break;
      case 0x5c: { const t = this.fetch24(); this.pc = t & 0xffff; this.pbr = t >> 16; break; }
      case 0x6c: { const p = this.fetch16(); this.pc = this.rd16(p); break; }
      case 0x7c: { const p = this.fetch16(); this.pc = this.rd16((this.pbr << 16) | ((p + this.x) & 0xffff)); break; }
      case 0xdc: { const p = this.fetch16(); this.pc = this.rd16(p); this.pbr = this.rd(p + 2); break; }
      case 0x20: { const t = this.fetch16(); this.push16((this.pc - 1) & 0xffff); this.pc = t; break; }
      case 0xfc: { const p = this.fetch16(); this.pushN16((this.pc - 1) & 0xffff); this.fixS(); this.pc = this.rd16((this.pbr << 16) | ((p + this.x) & 0xffff)); break; }
      case 0x22: { const t = this.fetch24(); this.pushN8(this.pbr); this.pushN16((this.pc - 1) & 0xffff); this.fixS(); this.pc = t & 0xffff; this.pbr = t >> 16; break; }
      case 0x60: this.pc = (this.pull16() + 1) & 0xffff; break;
      case 0x6b: { const r = this.pullN16(); this.pbr = this.pullN8(); this.fixS(); this.pc = (r + 1) & 0xffff; break; }
      case 0x40: {
        this.setP(this.pull8());
        this.pc = this.pull16();
        if (!this.e) this.pbr = this.pull8();
        break;
      }
      // ---- block moves
      case 0x54: case 0x44: {
        const dst = this.fetch(), src = this.fetch();
        this.dbr = dst;
        const vv = this.rd((src << 16) | this.x);
        this.wr((dst << 16) | this.y, vv);
        const mask = this.x8 ? 0xff : 0xffff;
        if (op === 0x54) { this.x = (this.x + 1) & mask; this.y = (this.y + 1) & mask; }
        else { this.x = (this.x - 1) & mask; this.y = (this.y - 1) & mask; }
        this.a = (this.a - 1) & 0xffff;
        if (this.a !== 0xffff) this.pc = (this.pc - 3) & 0xffff;
        break;
      }
      // ---- misc
      case 0xea: break;
      case 0x42: this.fetch(); break;
      case 0x00: this.fetch(); if (this.onBrk && this.onBrk()) break; this.interrupt(0xffe6, 0xfffe, true); break;
      case 0x02: this.fetch(); this.interrupt(0xffe4, 0xfff4, true); break;
      case 0xdb: this.stopped = true; break;
      case 0xcb: this.waiting = true; break;
      default: throw new Error(`unhandled opcode ${op.toString(16)}`);
    }
  }
}

// opcodes that take one extra cycle with 16-bit A / 16-bit index
const MEXTRA = new Uint8Array(256), XEXTRA = new Uint8Array(256);
for (let op = 0; op < 256; op++) {
  const lo = op & 0x1f;
  if ([0x01, 0x03, 0x05, 0x07, 0x09, 0x0d, 0x0f, 0x11, 0x12, 0x13, 0x15, 0x17, 0x19, 0x1d, 0x1f].includes(lo)) MEXTRA[op] = 1;
}
for (const op of [0xa2, 0xa6, 0xb6, 0xae, 0xbe, 0xa0, 0xa4, 0xb4, 0xac, 0xbc, 0x86, 0x96, 0x8e, 0x84, 0x94, 0x8c, 0xe0, 0xe4, 0xec, 0xc0, 0xc4, 0xcc, 0xda, 0xfa, 0x5a, 0x7a]) XEXTRA[op] = 1;
for (const op of [0x48, 0x68, 0x64, 0x74, 0x9c, 0x9e, 0x89, 0x24, 0x34, 0x2c, 0x3c]) MEXTRA[op] = 1;
