// RV32IM emulator for SCHUB
// bus: { read8(a), write8(a,v) } on the 24-bit MERIDIAN space. Bit 31 selects
// the uncached alias (same memory here); any other bit 24..30 is a bus error.

export class RV32 {
  constructor(bus) {
    this.bus = bus;
    this.x = new Int32Array(32);
    this.pc = 0;
    this.running = false;
    this.error = null;
    this.instret = 0;
  }
  reset(pc) {
    this.x.fill(0);
    this.pc = pc >>> 0;
    this.error = null;
    this.running = true;
  }
  addr(a) {
    a >>>= 0;
    if (a & 0x7f000000) { this.fault(`bus error at $${a.toString(16)}`); return -1; }
    return a & 0xffffff;
  }
  fault(msg) { this.error = msg; this.running = false; }
  r8(a) { const p = this.addr(a); return p < 0 ? 0 : this.bus.read8(p); }
  r16(a) {
    if (a & 1) { this.fault(`misaligned halfword read at $${(a >>> 0).toString(16)}`); return 0; }
    const p = this.addr(a); if (p < 0) return 0;
    return this.bus.read8(p) | (this.bus.read8(p + 1) << 8);
  }
  r32(a) {
    if (a & 3) { this.fault(`misaligned word read at $${(a >>> 0).toString(16)}`); return 0; }
    const p = this.addr(a); if (p < 0) return 0;
    return (this.bus.read8(p) | (this.bus.read8(p + 1) << 8) | (this.bus.read8(p + 2) << 16) | (this.bus.read8(p + 3) << 24)) | 0;
  }
  w8(a, v) { const p = this.addr(a); if (p >= 0) this.bus.write8(p, v & 255); }
  w16(a, v) {
    if (a & 1) { this.fault(`misaligned halfword write at $${(a >>> 0).toString(16)}`); return; }
    const p = this.addr(a); if (p < 0) return;
    this.bus.write8(p, v & 255); this.bus.write8(p + 1, (v >> 8) & 255);
  }
  w32(a, v) {
    if (a & 3) { this.fault(`misaligned word write at $${(a >>> 0).toString(16)}`); return; }
    const p = this.addr(a); if (p < 0) return;
    this.bus.write8(p, v & 255); this.bus.write8(p + 1, (v >> 8) & 255);
    this.bus.write8(p + 2, (v >> 16) & 255); this.bus.write8(p + 3, (v >>> 24) & 255);
  }

  run(n) {
    const x = this.x;
    let i = 0;
    for (; i < n && this.running; i++) {
      const pc = this.pc;
      const ins = this.r32(pc);
      if (!this.running) break;
      const op = ins & 0x7f, rd = (ins >> 7) & 31, f3 = (ins >> 12) & 7;
      const rs1 = (ins >> 15) & 31, rs2 = (ins >> 20) & 31, f7 = ins >>> 25;
      let next = (pc + 4) >>> 0;
      let v = 0, wr = true;
      switch (op) {
        case 0x37: v = ins & 0xfffff000; break;                         // lui
        case 0x17: v = (pc + (ins & 0xfffff000)) | 0; break;            // auipc
        case 0x6f: {                                                    // jal
          const imm = (((ins >> 31) & 1) << 20) | (((ins >> 12) & 0xff) << 12) | (((ins >> 20) & 1) << 11) | (((ins >> 21) & 0x3ff) << 1);
          v = next; next = (pc + ((imm << 11) >> 11)) >>> 0; break;
        }
        case 0x67: v = next; next = ((x[rs1] + (ins >> 20)) & ~1) >>> 0; break; // jalr
        case 0x63: {                                                    // branches
          wr = false;
          const a = x[rs1], b = x[rs2];
          let t;
          switch (f3) {
            case 0: t = a === b; break;
            case 1: t = a !== b; break;
            case 4: t = a < b; break;
            case 5: t = a >= b; break;
            case 6: t = (a >>> 0) < (b >>> 0); break;
            case 7: t = (a >>> 0) >= (b >>> 0); break;
            default: this.fault('illegal branch'); t = false;
          }
          if (t) {
            const imm = (((ins >> 31) & 1) << 12) | (((ins >> 7) & 1) << 11) | (((ins >> 25) & 0x3f) << 5) | (((ins >> 8) & 0xf) << 1);
            next = (pc + ((imm << 19) >> 19)) >>> 0;
          }
          break;
        }
        case 0x03: {                                                    // loads
          const a = (x[rs1] + (ins >> 20)) | 0;
          switch (f3) {
            case 0: v = (this.r8(a) << 24) >> 24; break;
            case 1: v = (this.r16(a) << 16) >> 16; break;
            case 2: v = this.r32(a); break;
            case 4: v = this.r8(a); break;
            case 5: v = this.r16(a); break;
            default: this.fault('illegal load');
          }
          break;
        }
        case 0x23: {                                                    // stores
          wr = false;
          const imm = ((ins >> 25) << 5) | ((ins >> 7) & 31);
          const a = (x[rs1] + imm) | 0;
          switch (f3) {
            case 0: this.w8(a, x[rs2]); break;
            case 1: this.w16(a, x[rs2]); break;
            case 2: this.w32(a, x[rs2]); break;
            default: this.fault('illegal store');
          }
          break;
        }
        case 0x13: {                                                    // op-imm
          const imm = ins >> 20, a = x[rs1];
          switch (f3) {
            case 0: v = (a + imm) | 0; break;
            case 2: v = a < imm ? 1 : 0; break;
            case 3: v = (a >>> 0) < (imm >>> 0) ? 1 : 0; break;
            case 4: v = a ^ imm; break;
            case 6: v = a | imm; break;
            case 7: v = a & imm; break;
            case 1: v = a << (imm & 31); break;
            case 5: v = (f7 & 0x20) ? a >> (imm & 31) : (a >>> (imm & 31)) | 0; break;
          }
          break;
        }
        case 0x33: {                                                    // op
          const a = x[rs1], b = x[rs2];
          if (f7 === 1) {
            switch (f3) {
              case 0: v = Math.imul(a, b); break;
              case 1: v = Number((BigInt(a) * BigInt(b)) >> 32n) | 0; break;
              case 2: v = Number((BigInt(a) * BigInt(b >>> 0)) >> 32n) | 0; break;
              case 3: v = Number((BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n) | 0; break;
              case 4: v = b === 0 ? -1 : (a === -2147483648 && b === -1) ? a : (a / b) | 0; break;
              case 5: v = b === 0 ? -1 : ((a >>> 0) / (b >>> 0)) | 0; break;
              case 6: v = b === 0 ? a : (a === -2147483648 && b === -1) ? 0 : (a % b) | 0; break;
              case 7: v = b === 0 ? a : ((a >>> 0) % (b >>> 0)) | 0; break;
            }
          } else {
            switch (f3) {
              case 0: v = f7 & 0x20 ? (a - b) | 0 : (a + b) | 0; break;
              case 1: v = a << (b & 31); break;
              case 2: v = a < b ? 1 : 0; break;
              case 3: v = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
              case 4: v = a ^ b; break;
              case 5: v = f7 & 0x20 ? a >> (b & 31) : (a >>> (b & 31)) | 0; break;
              case 6: v = a | b; break;
              case 7: v = a & b; break;
            }
          }
          break;
        }
        case 0x0f: wr = false; break;                                   // fence
        case 0x73: wr = false; if (ins === 0x00100073) this.fault('ebreak'); break;
        default:
          this.fault(`illegal instruction ${(ins >>> 0).toString(16)} at $${pc.toString(16)}`);
          wr = false;
      }
      if (wr && rd) x[rd] = v;
      this.pc = next;
    }
    this.instret += i;
    return i;
  }
}
