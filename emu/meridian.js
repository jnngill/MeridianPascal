// MERIDIAN 816 (+ SCHUB) machine model for MERIDIAN Pascal.
// Runs the real kernel ROM (kern.bin at $00:D000) for text output and
// keyboard input; the kernel's interrupt work (frame counter, key buffer)
// is done here directly. DOS calls (JSL $FF4000) are served from virtual
// drives held in JavaScript.

import { CPU65816 } from './cpu65816.js';
import { RV32 } from './rv32.js';

export const CYCLES_PER_FRAME = Math.round(8000000 / 59.95);
const LINES = 262;
const TRAP = 0xfefff0;          // return address of programs started by the emulator
const KEYBUF = 0x0200, TB_RD = 0x23, TB_WR = 0x24;
const TASTEN_AN = 0x033e00;

// browser KeyboardEvent.code -> PS/2 set 2 (E0 keys + 128) for TASTEN_AN
export const SCANCODES = {
  KeyA: 0x1c, KeyB: 0x32, KeyC: 0x21, KeyD: 0x23, KeyE: 0x24, KeyF: 0x2b, KeyG: 0x34, KeyH: 0x33,
  KeyI: 0x43, KeyJ: 0x3b, KeyK: 0x42, KeyL: 0x4b, KeyM: 0x3a, KeyN: 0x31, KeyO: 0x44, KeyP: 0x4d,
  KeyQ: 0x15, KeyR: 0x2d, KeyS: 0x1b, KeyT: 0x2c, KeyU: 0x3c, KeyV: 0x2a, KeyW: 0x1d, KeyX: 0x22,
  KeyY: 0x35, KeyZ: 0x1a, Digit0: 0x45, Digit1: 0x16, Digit2: 0x1e, Digit3: 0x26, Digit4: 0x25,
  Digit5: 0x2e, Digit6: 0x36, Digit7: 0x3d, Digit8: 0x3e, Digit9: 0x46, Space: 0x29, Enter: 0x5a,
  Escape: 0x76, Backspace: 0x66, Tab: 0x0d, ShiftLeft: 0x12, ShiftRight: 0x59, ControlLeft: 0x14,
  AltLeft: 0x11, Minus: 0x4e, Equal: 0x55, Comma: 0x41, Period: 0x49, Slash: 0x4a,
  F1: 0x05, F2: 0x06, F3: 0x04, F4: 0x0c, F5: 0x03, F6: 0x0b, F8: 0x0a, F9: 0x01, F10: 0x09,
  ArrowUp: 128 + 0x75, ArrowDown: 128 + 0x72, ArrowLeft: 128 + 0x6b, ArrowRight: 128 + 0x74,
  ControlRight: 128 + 0x14, AltRight: 128 + 0x11, Delete: 128 + 0x71, Home: 128 + 0x6c, End: 128 + 0x69,
  PageUp: 128 + 0x7d, PageDown: 128 + 0x7a, Insert: 128 + 0x70, F7: 0x02, F11: 0x78, F12: 0x07,
};

export class Meridian {
  constructor(roms, opts = {}) {
    this.mem = new Uint8Array(0x1000000);
    this.io = new Uint8Array(0x1000);
    this.pattern = new Uint8Array(0x4000);   // KOBOLD sprite patterns
    this.palette = new Uint32Array(256);     // 0xAARRGGBB-like packed RGB
    this.palRaw = new Uint16Array(256);
    this.roms = roms;
    this.onOutput = opts.onOutput || null;   // (charCode) for headless runs
    this.drives = [new Map(), new Map(), new Map(), new Map()];
    this.drive = 1;
    this.cpu = new CPU65816({
      read: (a) => this.read(a),
      write: (a, v) => this.write(a, v),
    });
    this.cpu.onBrk = () => { this.halt(`BRK at $${((this.cpu.pbr << 16) | ((this.cpu.pc - 2) & 0xffff)).toString(16).toUpperCase().padStart(6, '0')}`); return true; };
    this.rv = new RV32({ read8: (a) => this.read(a), write8: (a, v) => this.write(a, v) });
    this.schub = { enabled: false, start: 0, arg: 0, res: 0, cycles: 0, present: opts.schub !== false };
    this.joy = [0, 0];
    this.mouse = { x: 160, y: 120, b: 0, wheel: 0 };
    this.frame = 0;
    this.frameCycle = 0;
    this.totalCycles = 0;
    this.usLatch = 0;
    this.state = 'idle';
    this.message = '';
    this.kran = { done: true };
    this.reset();
  }

  // ------------------------------------------------------------------ bus
  read(a) {
    if ((a & 0xff0000) === 0 && a >= 0xc000 && a < 0xd000) return this.ioRead(a & 0xfff);
    return this.mem[a];
  }
  write(a, v) {
    if ((a & 0xff0000) === 0) {
      if (a >= 0xd000) return;                       // kernel ROM
      if (a >= 0xc000) { this.ioWrite(a & 0xfff, v); return; }
    } else if ((a >> 16) === 0xff) return;           // ROM bank $FF
    else if (this.cart && a >= 0x400000 && a < 0x800000) return;   // cartridge is write-protected
    this.mem[a] = v;
  }

  ioRead(r) {
    const io = this.io;
    switch (r) {
      case 0x00d: return this.rasterLine() & 0xff;
      case 0x00e: return this.rasterLine() >> 8;
      case 0x00f: return this.frame & 0xff;
      case 0x101: return 0;                           // no raw key events (kernel buffer is filled directly)
      case 0x108: return this.joy[0] & 0xff;
      case 0x109: return this.joy[0] >> 8;
      case 0x10a: return this.joy[1] & 0xff;
      case 0x10b: return this.joy[1] >> 8;
      case 0x110: case 0x111: case 0x112: case 0x113: return (this.usLatch >>> (8 * (r - 0x110))) & 0xff;
      case 0x114: case 0x115: case 0x118: case 0x119: return io[r];
      case 0x120: return this.mouse.x & 0xff;
      case 0x121: return this.mouse.x >> 8;
      case 0x122: return this.mouse.y & 0xff;
      case 0x123: return this.mouse.y >> 8;
      case 0x124: return this.mouse.b;
      case 0x125: return this.mouse.wheel & 0xff;
      case 0x130: case 0x131: case 0x132: case 0x133: case 0x134: case 0x135: case 0x136: return this.rtc(r - 0x130);
      case 0x137: return 1;
      case 0x200: return io[0x200];
      case 0x610: return this.kran.done ? 0x02 : 0x00;
      case 0x704: return 0;
      case 0x906: return 0;
      case 0xc00: case 0xc01: case 0xc02: case 0xc03: case 0xc04: case 0xc05: case 0xc06: case 0xc07:
      case 0xc08: case 0xc09: case 0xc0a: case 0xc0b: case 0xc0c: case 0xc0d: case 0xc0e: case 0xc0f:
        break;
    }
    if (r >= 0xd00 && r < 0xd20) return this.schubRead(r - 0xd00);
    if (r >= 0x801 && r < 0xc00 && !(r >= 0x900 && r < 0xa00)) return 0xff;
    if (r >= 0xd20) return 0xff;
    return io[r];
  }

  ioWrite(r, v) {
    const io = this.io;
    io[r] = v;
    switch (r) {
      case 0x00a: case 0x02a: {                       // palette commit (CPU / copper set)
        const base = r - 2;
        const idx = io[base];
        const raw = io[base + 1] | ((v & 15) << 8);
        this.setPal(idx, raw);
        io[base] = (idx + 1) & 255;
        break;
      }
      case 0x00c: io[0x00c] = 0; break;               // IRQ status: writing clears
      case 0x110: this.usLatch = Math.floor(this.totalCycles / 8) >>> 0; break;
      case 0x120: case 0x121: this.mouse.x = io[0x120] | (io[0x121] << 8); break;
      case 0x122: case 0x123: this.mouse.y = io[0x122] | (io[0x123] << 8); break;
      case 0x402: {                                    // KOBOLD pattern data
        const a = (io[0x400] | (io[0x401] << 8)) & 0x3fff;
        this.pattern[a] = v;
        const n = (a + 1) & 0x3fff;
        io[0x400] = n & 255; io[0x401] = n >> 8;
        break;
      }
      case 0x404: io[0x404] = io[0x405] = io[0x406] = io[0x407] = 0; break;
      case 0x610: this.kranCommand(v); break;
    }
    if (r >= 0xd00 && r < 0xd20) this.schubWrite(r - 0xd00, v);
  }

  setPal(idx, raw) {
    this.palRaw[idx] = raw;
    const g = (raw >> 4) & 15, b = raw & 15, rr = (raw >> 8) & 15;
    this.palette[idx] = ((rr * 17) << 16) | ((g * 17) << 8) | (b * 17);
  }

  rasterLine() {
    const l = Math.floor(this.frameCycle / (CYCLES_PER_FRAME / LINES));
    return Math.min(l, LINES - 1);
  }
  rtc(i) {
    const d = new Date();
    const bcd = (n) => ((Math.floor(n / 10) << 4) | (n % 10));
    return [bcd(d.getSeconds()), bcd(d.getMinutes()), bcd(d.getHours()), bcd(d.getDate()),
      bcd(d.getMonth() + 1), bcd(d.getFullYear() % 100), d.getDay()][i];
  }

  // ---------------------------------------------------------------- SCHUB
  schubRead(r) {
    const s = this.schub;
    const ID = [0x53, 0x43, 0x48, 0x42];
    if (!s.present) return 0xff;
    if (r < 4) return ID[r];
    if (r === 4) return 1;
    if (r === 5) return 0x1f;
    if (r === 8) return this.io[0xd08];
    if (r === 9) {
      return 0x80 | (this.rv.error ? 0x08 : 0) | (this.rv.running ? 0x02 : 0) | (s.enabled ? 0x01 : 0);
    }
    if (r >= 0x0c && r < 0x10) return (s.start >>> (8 * (r - 0x0c))) & 0xff;
    if (r >= 0x18 && r < 0x1c) {
      if (r === 0x18) s.latch = Math.floor(this.rv.instret * 1.2) >>> 0;
      return (s.latch >>> (8 * (r - 0x18))) & 0xff;
    }
    if (r >= 0x1c) return (24000000 >>> (8 * (r - 0x1c))) & 0xff;
    return this.io[0xd00 + r];
  }
  schubWrite(r, v) {
    const s = this.schub;
    if (!s.present) return;
    if (r >= 0x0c && r < 0x10 && !this.rv.running) {
      const sh = 8 * (r - 0x0c);
      s.start = ((s.start & ~(0xff << sh)) | (v << sh)) >>> 0;
    }
    if (r === 8) {
      s.enabled = (v & 1) !== 0;
      if (!s.enabled || !(v & 2)) { this.rv.running = false; this.rv.error = null; }
      else if (v & 0x80 || !this.rv.running) this.rv.reset(s.start & ~3);
    }
  }

  // ----------------------------------------------------------------- KRAN
  kranCommand(v) {
    const io = this.io;
    if (v & 0x08) this.kran.done = false;
    if (v & 0x01) { this.kranJob(0x600, io); this.kran.done = true; }
    if (v & 0x02) {
      let la = io[0x611] | (io[0x612] << 8) | (io[0x613] << 16);
      for (let n = 0; n < 4096; n++) {
        const job = new Uint8Array(16);
        for (let i = 0; i < 16; i++) job[i] = this.mem[(la + i) & 0xffffff];
        this.kranJob(0, job);
        if (job[15] & 0x80) break;
        la += 16;
      }
      this.kran.done = true;
    }
  }
  kranJob(o, j) {
    const g24 = (k) => j[o + k] | (j[o + k + 1] << 8) | (j[o + k + 2] << 16);
    const g16 = (k) => j[o + k] | (j[o + k + 1] << 8);
    const s16 = (k) => (g16(k) << 16) >> 16;
    let src = g24(0), dst = g24(3);
    const w = g16(6), hgt = g16(8), qa = s16(10), za = s16(12), val = j[o + 14], mode = j[o + 15];
    const kind = mode & 3, back = mode & 4, column = (mode & 8) && this.schub.enabled && kind === 0;
    for (let y = 0; y < hgt; y++) {
      for (let x = 0; x < w; x++) {
        const xi = back ? w - 1 - x : x;
        const d = (dst + xi) & 0xffffff;
        if (kind === 1) { this.write(d, val); continue; }
        const b = this.read((src + (column ? 0 : xi)) & 0xffffff);
        if (kind === 0) this.write(d, b);
        else if (kind === 2) { if (b !== val) this.write(d, b); }
        else {
          const old = this.read(d);
          let r = old;
          if ((b >> 4) !== (val & 15)) r = (r & 0x0f) | (b & 0xf0);
          if ((b & 15) !== (val & 15)) r = (r & 0xf0) | (b & 0x0f);
          this.write(d, r);
        }
      }
      src = (src + qa) & 0xffffff;
      dst = (dst + za) & 0xffffff;
    }
  }

  // ------------------------------------------------------------ lifecycle
  reset() {
    this.mem.fill(0);
    this.io.fill(0);
    const k = this.roms.kern;
    this.mem.set(k, 0xd000);
    if (this.roms.sys) this.mem.set(this.roms.sys, 0xff4000);
    this.mem.set(k.subarray(0, 2048), 0x1800);     // character set
    if (this.cart) { this.mem.set(this.cart, 0x400000); this.io[0x200] |= 4; }
    // CHROUT entry ($FF80 is JMP chrout) for the output hook
    this.chroutAddr = this.mem[0xff81] | (this.mem[0xff82] << 8);
    this.output = '';
    this.cpu.reset();
    this.rv.running = false;
    this.schub.enabled = false;
    // kernel zero page like after boot
    this.mem[0x12] = 0x6e;                          // colour: light blue on blue
    this.mem[0x15] = 40;
    // native mode, display reset and MODE 40 through the real kernel
    this.callRoutine(0xffca, { long: true });
    this.callRoutine(0xff92, { a: 40 });
    this.state = 'idle';
    this.message = '';
    for (const c of 'MERIDIAN PASCAL - EMULATOR READY\r') this.kputc(c.charCodeAt(0));
  }

  // run a kernel routine to completion (D=0, DB=0, A8/X16 native)
  callRoutine(addr, o = {}) {
    const c = this.cpu;
    const saved = { s: c.s };
    c.e = 0; c.p = 0x20 | 0x04; c.d = 0; c.dbr = 0;
    c.s = 0x01ff;
    if (o.a !== undefined) c.a = (c.a & 0xff00) | (o.a & 0xff);
    if (o.long) { c.pushN8(TRAP >> 16); c.pushN16((TRAP - 1) & 0xffff); }
    else { c.pushN16(0xfff0 - 1); }
    c.pbr = 0; c.pc = addr;
    for (let n = 0; n < 2000000; n++) {
      const full = (c.pbr << 16) | c.pc;
      if (o.long ? full === TRAP : full === 0xfff0) break;
      this.step816();
    }
    c.s = saved.s;
  }
  kputc(ch) { this.callRoutine(0xff80, { a: ch }); }

  loadMer(bytes) {
    if (bytes[0] !== 0x4d || bytes[1] !== 0x45 || bytes[2] !== 0x52) throw new Error('not a MER file');
    const load = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16);
    const start = bytes[8] | (bytes[9] << 8) | (bytes[10] << 16);
    const len = (bytes[12] | (bytes[13] << 8) | (bytes[14] << 16) | (bytes[15] << 24)) >>> 0;
    for (let i = 0; i < len; i++) this.mem[(load + i) & 0xffffff] = bytes[16 + i];
    return { load, start, len, auto: bytes[7] & 1 };
  }

  // plug in a cartridge (.MOD): ROM image at $40:0000
  insertCartridge(bytes) {
    if (String.fromCharCode(...bytes.subarray(0, 8)) !== 'MODUL816') throw new Error('not a MERIDIAN cartridge (MODUL816 header missing)');
    this.cart = bytes;
    this.mem.set(bytes, 0x400000);
    this.io[0x200] |= 4;
  }
  // start the cartridge like the kernel does at power-on (JSL, native, A8/X16)
  startCartridge() {
    const b = this.cart;
    const start = b[10] | (b[11] << 8) | (b[12] << 16);
    return this.startProgram(start);
  }

  // start a program like BOTE's remote start: JSL start, RTL returns
  startProgram(start) {
    const c = this.cpu;
    c.stopped = false; c.waiting = false;
    c.e = 0; c.p = 0x20 | 0x10 * 0; c.d = 0; c.dbr = 0;
    c.p = 0x20;          // A 8 bit, X 16 bit, interrupts on
    c.s = 0x01ff;
    c.x &= 0xffff;
    c.pushN8(TRAP >> 16); c.pushN16((TRAP - 1) & 0xffff);
    c.pbr = start >> 16; c.pc = start & 0xffff;
    this.mem[0x29] = 0;      // blink_frei: cursor still while a program runs
    this.state = 'running';
    this.message = '';
    this.output = '';
    const hex = start.toString(16).toUpperCase().padStart(6, '0');
    this.runStart = this.totalCycles;
    return hex;
  }

  halt(msg) {
    this.state = 'stopped';
    this.message = msg;
    this.rv.running = false;
  }

  // queue a key for the kernel's GETIN (MERIDIAN codes)
  pushKey(code) {
    const wr = this.mem[TB_WR], rd = this.mem[TB_RD];
    const n = (wr + 1) & 15;
    if (n === rd) return;
    this.mem[KEYBUF + (wr & 15)] = code & 255;
    this.mem[TB_WR] = n;
  }
  keyState(scan, down) {
    if (scan === undefined) return;
    this.mem[TASTEN_AN + scan] = down ? 1 : 0;
  }

  // one 65C816 instruction with the DOS trap and the output hook
  step816() {
    const c = this.cpu;
    if (c.pbr === 0) {
      if (c.pc === this.chroutAddr && this.state === 'running') {
        const ch = c.a & 0xff;
        this.output += ch === 13 ? '\n' : (ch >= 32 ? String.fromCharCode(ch) : '');
        if (this.onOutput) this.onOutput(ch);
      }
    } else if (c.pbr === 0xff && c.pc === 0x4000) { this.dosCall(); return 20; }
    return c.step();
  }

  // run one video frame
  runFrame() {
    if (this.state !== 'running') { this.frameCycle = 0; this.frame++; return; }
    const c = this.cpu;
    const budget = CYCLES_PER_FRAME;
    let used = 0;
    try {
      while (used < budget && this.state === 'running') {
        const sliceEnd = used + 2000;
        while (used < sliceEnd) {
          if (((c.pbr << 16) | c.pc) === TRAP) { this.programEnded(); break; }
          const n = this.step816();
          used += n;
          this.frameCycle = used;
          this.totalCycles += n;
          if (c.stopped) { this.halt('STP executed'); break; }
        }
        if (this.rv.running) {
          this.rv.run(6000);
          if (this.rv.error) {
            this.schubFault = this.rv.error;
          }
        }
      }
    } catch (e) {
      this.halt(e.message);
    }
    this.frameCycle = 0;
    this.frame++;
    // what the kernel's frame interrupt does
    this.io[0x00f] = this.frame & 255;
    let b = this.mem[0x50] | (this.mem[0x51] << 8) | (this.mem[0x52] << 16);
    b = (b + 1) & 0xffffff;
    this.mem[0x50] = b & 255; this.mem[0x51] = (b >> 8) & 255; this.mem[0x52] = b >> 16;
  }

  programEnded() {
    this.state = 'idle';
    this.message = 'program ended';
    // like the kernel: display reset, READY.
    this.callRoutine(0xffca, { long: true });
    for (const ch of '\rREADY.\r') this.kputc(ch.charCodeAt(0));
  }

  // -------------------------------------------------------------- DOS HLE
  dosCall() {
    const c = this.cpu;
    const m = this.mem;
    const cmd = c.a & 0xff;
    const B = 0x16c0;
    const drv = m[B] & 3;
    const files = this.drives[drv];
    const nameOf = () => {
      const n = m[B + 6];
      let s = '';
      for (let i = 0; i < n && i < 16; i++) s += String.fromCharCode(m[B + 7 + i]);
      s = s.toUpperCase().trim();
      if (!s.includes('.')) {
        const ext = String.fromCharCode(m[B + 3], m[B + 4], m[B + 5]).replace(/\0/g, '').trim();
        if (ext) s += '.' + ext.toUpperCase();
      }
      return s;
    };
    const g24 = (a) => m[a] | (m[a + 1] << 8) | (m[a + 2] << 16);
    const g32 = (a) => (m[a] | (m[a + 1] << 8) | (m[a + 2] << 16) | (m[a + 3] << 24)) >>> 0;
    const s32 = (a, v) => { for (let i = 0; i < 4; i++) m[a + i] = (v >>> (8 * i)) & 255; };
    let err = 0;
    const valid = (s) => /^[A-Z0-9_~-]{1,8}(\.[A-Z0-9_~-]{0,3})?$/.test(s);
    switch (cmd) {
      case 0: {
        const name = nameOf();
        const f = files.get(name);
        if (!f) { err = 2; break; }
        let adr = g24(B + 0x24);
        const max = g32(B + 0x28);
        let data = f;
        if (f.length >= 16 && f[0] === 0x4d && f[1] === 0x45 && f[2] === 0x52) {
          if (adr === 0xffffff) adr = f[4] | (f[5] << 8) | (f[6] << 16);
          data = f.subarray(16);
        } else if (adr === 0xffffff) { err = 1; break; }
        const n = Math.min(data.length, max || data.length);
        for (let i = 0; i < n; i++) this.write((adr + i) & 0xffffff, data[i]);
        s32(B + 0x28, n);
        m[B + 0x24] = adr & 255; m[B + 0x25] = (adr >> 8) & 255; m[B + 0x26] = (adr >> 16) & 255;   // D_ADR = target
        break;
      }
      case 1: {
        const name = nameOf();
        if (!valid(name)) { err = 9; break; }
        const adr = g24(B + 0x24);
        const n = g32(B + 0x28);
        const withMer = m[B + 2] === 1;
        const out = new Uint8Array(n + (withMer ? 16 : 0));
        if (withMer) {
          out.set([0x4d, 0x45, 0x52, 1, adr & 255, (adr >> 8) & 255, adr >> 16, 0, adr & 255, (adr >> 8) & 255, adr >> 16, 0,
            n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24]);
        }
        for (let i = 0; i < n; i++) out[(withMer ? 16 : 0) + i] = this.read((adr + i) & 0xffffff);
        files.set(name, out);
        if (this.onFileSaved) this.onFileSaved(drv, name, out);
        break;
      }
      case 2: {
        const name = nameOf();
        if (!files.delete(name)) err = 2;
        else if (this.onFileDeleted) this.onFileDeleted(drv, name);
        break;
      }
      case 3: {
        const idx = m[B + 0x2c] | (m[B + 0x2d] << 8);
        const names = [...files.keys()].sort();
        if (idx >= names.length) { err = 2; break; }
        const nm = names[idx];
        m[B + 6] = nm.length;
        for (let i = 0; i < 16; i++) m[B + 7 + i] = i < nm.length ? nm.charCodeAt(i) : 0;
        s32(B + 0x28, files.get(nm).length);
        m[B + 0x2c] = (idx + 1) & 255; m[B + 0x2d] = (idx + 1) >> 8;
        break;
      }
      case 4: {
        let used = 0;
        for (const f of files.values()) used += f.length;
        s32(B + 0x28, Math.max(0, 3 * 1024 * 1024 - used));
        break;
      }
      default: err = 1;
    }
    m[B + 1] = err;
    c.a = (c.a & 0xff00) | err;
    c.nz8(err);
    // RTL
    const r = c.pullN16();
    c.pbr = c.pullN8();
    c.pc = (r + 1) & 0xffff;
  }

  // ------------------------------------------------------------- display
  // render into a 640x240 RGBA buffer (Uint32 view, little endian ABGR)
  render(buf32) {
    const io = this.io, m = this.mem, pal = this.palette;
    const W = 640;
    const line = new Uint16Array(320 * 2);   // per output pixel: palette index + 256 = transparent
    const abgr = (rgb) => 0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
    const palA = new Uint32Array(256);
    for (let i = 0; i < 256; i++) palA[i] = abgr(pal[i]);
    const sprites = [];
    if (io[0x403] & 1) {
      for (let n = 31; n >= 0; n--) {
        const b = 0x300 + n * 8;
        if (!(io[b + 6] & 1)) continue;
        sprites.push({
          x: ((io[b] | (io[b + 1] << 8)) & 0x1ff) - 32, y: ((io[b + 2] | (io[b + 3] << 8)) & 0x1ff) - 32,
          pat: io[b + 4] & 127, bank: io[b + 5] & 15, fx: io[b + 5] & 16, fy: io[b + 5] & 32,
          behind: io[b + 5] & 64, dbl: io[b + 5] & 128,
        });
      }
    }
    const layer = (base, y, out, isB) => {
      const typ = io[base], opt = io[base + 1];
      const data = io[base + 2] | (io[base + 3] << 8) | (io[base + 4] << 16);
      const pat = io[base + 5] | (io[base + 6] << 8) | (io[base + 7] << 16);
      const sxr = base === 0 ? 0x10 : 0x30;
      switch (typ) {
        case 1: {
          const cols80 = opt & 1;
          const cols = cols80 ? 80 : 40;
          const row = data + (y >> 3) * (cols80 ? 160 : 80);
          const fy = y & 7;
          for (let cx = 0; cx < cols; cx++) {
            const ch = m[(row + cx * 2) & 0xffffff], at = m[(row + cx * 2 + 1) & 0xffffff];
            const bits = m[(pat + ch * 8 + fy) & 0xffffff];
            const fg = at & 15, bg = at >> 4;
            for (let px = 0; px < 8; px++) {
              const on = bits & (0x80 >> px);
              const ci = on ? fg : bg;
              const v = (isB && ci === 0) ? 256 : ci;
              if (cols80) out[cx * 8 + px] = v;
              else { out[cx * 16 + px * 2] = v; out[cx * 16 + px * 2 + 1] = v; }
            }
          }
          break;
        }
        case 2: {
          const sx = (io[sxr] | (io[sxr + 1] << 8)) & 511, sy = io[sxr + 2];
          const wy = (y + sy) & 255;
          const mrow = data + (wy >> 3) * 128;
          for (let x = 0; x < 320; x++) {
            const wx = (x + sx) & 511;
            const e = m[(mrow + (wx >> 3) * 2) & 0xffffff] | (m[(mrow + (wx >> 3) * 2 + 1) & 0xffffff] << 8);
            const tn = e & 1023, bank = e >> 12;
            let tx = wx & 7, ty = wy & 7;
            if (e & 0x400) tx = 7 - tx;
            if (e & 0x800) ty = 7 - ty;
            const byte = m[(pat + tn * 32 + ty * 4 + (tx >> 1)) & 0xffffff];
            const v4 = (tx & 1) ? byte & 15 : byte >> 4;
            const v = v4 === 0 ? (isB ? 256 : 0) : bank * 16 + v4;
            out[x * 2] = v; out[x * 2 + 1] = v;
          }
          break;
        }
        case 3: {
          const bank = opt >> 4;
          const row = data + y * 160;
          for (let x = 0; x < 320; x++) {
            const byte = m[(row + (x >> 1)) & 0xffffff];
            const v4 = (x & 1) ? byte & 15 : byte >> 4;
            const v = (isB && v4 === 0) ? 256 : bank * 16 + v4;
            out[x * 2] = v; out[x * 2 + 1] = v;
          }
          break;
        }
        case 4: {
          const row = data + y * 320;
          for (let x = 0; x < 320; x++) {
            const ci = m[(row + x) & 0xffffff];
            const v = (isB && ci === 0) ? 256 : ci;
            out[x * 2] = v; out[x * 2 + 1] = v;
          }
          break;
        }
        default:
          if (!isB) out.fill(0); else out.fill(256);
      }
    };
    const lb = new Uint16Array(640);
    const drawSprites = (y, behindFlag) => {
      for (const s of sprites) {
        if (!!s.behind !== behindFlag) continue;
        const size = s.dbl ? 32 : 16;
        if (y < s.y || y >= s.y + size) continue;
        let ry = (y - s.y) >> (s.dbl ? 1 : 0);
        if (s.fy) ry = 15 - ry;
        for (let px = 0; px < size; px++) {
          const sx = s.x + px;
          if (sx < 0 || sx >= 320) continue;
          let rx = px >> (s.dbl ? 1 : 0);
          if (s.fx) rx = 15 - rx;
          const byte = this.pattern[s.pat * 128 + ry * 8 + (rx >> 1)];
          const v4 = (rx & 1) ? byte & 15 : byte >> 4;
          if (!v4) continue;
          const ci = s.bank * 16 + v4;
          line[sx * 2] = ci; line[sx * 2 + 1] = ci;
        }
      }
    };
    // LOTSE (copper): run the list in step with the lines being drawn
    let cop = null;
    if (io[0x703] & 1) {
      cop = { pc: io[0x700] | (io[0x701] << 8) | (io[0x702] << 16), wait: -1, done: false, n: 0 };
      // commands before the first wait (and waits for lines >= 240) happen in the blanking
      this.copperRun(cop, 240, palA, abgr);
    }
    for (let y = 0; y < 240; y++) {
      if (cop && !cop.done) this.copperRun(cop, y, palA, abgr);
      layer(0x000, y, line, false);
      for (let i = 0; i < 640; i++) if (line[i] === 256) line[i] = 0;
      if (sprites.length) drawSprites(y, true);
      if (io[0x020]) {
        layer(0x020, y, lb, true);
        for (let i = 0; i < 640; i++) if (lb[i] !== 256) line[i] = lb[i];
      }
      if (sprites.length) drawSprites(y, false);
      const o = y * W;
      for (let i = 0; i < 640; i++) buf32[o + i] = palA[line[i] & 255];
    }
  }

  // execute copper commands up to raster line y (y = 240: frame start)
  copperRun(cop, y, palA, abgr) {
    const m = this.mem;
    const frameOrder = (l) => (l >= 240 ? l - 240 : l + 22);   // 240..261 come first
    while (!cop.done && cop.n < 4000) {
      if (cop.wait >= 0) {
        if (frameOrder(cop.wait) > frameOrder(y)) return;
        cop.wait = -1;
      }
      const a = cop.pc;
      const op = m[a], b1 = m[a + 1], b2 = m[a + 2], b3 = m[a + 3];
      cop.pc = (a + 4) & 0xffffff;
      cop.n++;
      switch (op) {
        case 0: cop.done = true; return;
        case 1: cop.wait = b1 | ((b2 & 1) << 8); break;
        case 2: {
          const reg = b1 | (b2 << 8);
          if (reg >= 0xc000 && reg < 0xc800) {
            this.ioWrite(reg & 0xfff, b3);
            if ((reg & 0xfff) === 0x00a || (reg & 0xfff) === 0x02a) {
              for (let i = 0; i < 256; i++) palA[i] = abgr(this.palette[i]);
            }
          }
          break;
        }
        case 3: cop.pc = b1 | (b2 << 8) | (b3 << 16); break;
        case 6: this.setPal(b1, b2 | ((b3 & 15) << 8)); palA[b1] = abgr(this.palette[b1]); break;
        default: break;   // SIGNAL, WAIT_KRAN: nothing to wait for here
      }
    }
  }

  // text of the 40/80 column screen (for tests and copying)
  screenText() {
    const cols = this.mem[0x15] === 80 ? 80 : 40;
    const stride = cols * 2;
    const lines = [];
    for (let y = 0; y < 30; y++) {
      let s = '';
      for (let x = 0; x < cols; x++) s += String.fromCharCode(this.mem[0x400 + y * stride + x * 2]);
      lines.push(s.replace(/\s+$/, ''));
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join('\n');
  }
}
