// Run the real MERIDIAN BASIC interpreter in the MERIDIAN Pascal emulator,
// to compare interpreted and compiled programs. Uses the ROMs of the core
// repository next to this one (kern.bin, BASIC, Werkstatt, SONG, DOS).
// The emulator does not model two things BASIC needs, so they are added here:
//  - SYSTEM ($C800) bit 0 SPIEGEL: bank 1 $0000-$1FFF shows bank 0
//  - WAI wakes up at the frame interrupt
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Meridian } from '../emu/meridian.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CORE_ROM = process.env.MERIDIAN_CORE_ROM || path.join(here, '..', '..', 'MERIDIAN_SCHUB_MiSTer', 'rom');
const BASIC_KALT = 0xe48c;     // kern.lbl: basic_kalt

const bin = (f) => new Uint8Array(fs.readFileSync(path.join(CORE_ROM, f)));
const hex = (f) => Uint8Array.from(fs.readFileSync(path.join(CORE_ROM, f), 'latin1').trim().split(/\s+/).map(h => parseInt(h, 16)));

export function coreRoms() {
  return { kern: bin('kern.bin'), sys: bin('dos.bin'), basic: hex('basic.hex').subarray(0, 16384), werkstatt: bin('werkstatt.bin'), song: bin('song.bin') };
}

// a machine that behaves like the core where BASIC needs it
export function coreMachine(roms = coreRoms()) {
  const m = new Meridian({ kern: roms.kern, sys: roms.sys });
  const R = m.read.bind(m), W = m.write.bind(m);
  const mirror = (a) => (m.io[0x800] & 1) && (a & 0xffe000) === 0x010000;
  m.read = (a) => mirror(a) ? R(a & 0x1fff) : R(a);
  m.write = (a, v) => mirror(a) ? W(a & 0x1fff, v) : W(a, v);
  const rf = m.runFrame.bind(m);
  m.runFrame = () => { rf(); m.cpu.waiting = false; };
  m.loadBasicRoms = () => {
    m.mem.set(roms.basic, 0xff0000);
    m.mem.set(roms.song, 0xff8000);
    m.mem.set(roms.werkstatt, 0xffc000);
  };
  m.loadBasicRoms();
  return m;
}

// run a compiled .MER on the same machine; cycles from start to its end
export function runMer(mer, { maxFrames = 20000, keys = null } = {}) {
  const m = coreMachine();
  m.mem[0x20] = 0xff; m.mem[0x21] = 0;
  const info = m.loadMer(mer);
  m.startProgram(info.start);
  const c0 = m.totalCycles, f0 = m.frame;
  for (let i = 0; i < maxFrames && m.state === 'running'; i++) {
    if (keys) keys(m, m.frame - f0);
    m.runFrame();
  }
  return { m, frames: m.frame - f0, cycles: m.totalCycles - c0, ready: m.state !== 'running', state: m.state, message: m.message, output: m.output, screen: m.screenText() };
}

// boot BASIC, type a program, RUN it; returns frames until READY comes back
export function runBasic(program, { maxFrames = 20000, keys = null } = {}) {
  const m = coreMachine();
  m.mem[0x20] = 0xff; m.mem[0x21] = 0;          // memory banks (SDRAM module)
  m.startProgram(BASIC_KALT);
  const fr = (n) => { for (let i = 0; i < n && m.state === 'running'; i++) m.runFrame(); };
  fr(30);
  const type = (s) => { for (const ch of s) { m.pushKey(ch === '\n' ? 13 : ch.charCodeAt(0)); fr(ch === '\n' ? 4 : 1); } };
  const lines = program.replace(/\r/g, '').split('\n').filter(l => l.trim());
  for (const l of lines) type(l + '\n');
  m.output = '';
  m.mem[0x29] = 0;
  // READY. ($234B in emulation mode) marks the end of RUN
  const c = m.cpu; let ready = false;
  const st = m.step816.bind(m);
  m.step816 = () => { if (c.pbr === 0 && c.pc === 0x234b) ready = true; return st(); };
  type('RUN');
  ready = false;
  m.pushKey(13);
  const f0 = m.frame, c0 = m.totalCycles;
  let cycles = 0;
  m.step816 = () => { if (!ready && c.pbr === 0 && c.pc === 0x234b) { ready = true; cycles = m.totalCycles - c0; } return st(); };
  for (let i = 0; i < maxFrames && !ready && m.state === 'running'; i++) {
    if (keys) keys(m, m.frame - f0);
    m.runFrame();
  }
  return { m, frames: m.frame - f0, cycles, ready, output: m.output, screen: m.screenText() };
}
