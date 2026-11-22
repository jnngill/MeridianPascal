// Run the on-device compiler in the emulator on a Pascal source.
//   node tests/nc.js prog.pas [frames]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCart } from './cart.js';
import { Meridian } from '../emu/meridian.js';
import { roms } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let cached = null;
export function ncCart() {
  if (cached) return cached;
  const r = buildCart(path.join(here, 'nctest.pas'), [path.join(here, '..', 'cart')]);
  if (!r.ok) { console.log(r.errors); throw new Error('cartridge build failed'); }
  cached = r;
  return r;
}

export function ncRun(src, { frames = 3000, keys = '', files = {} } = {}) {
  const r = ncCart();
  const m = new Meridian(roms);
  m.insertCartridge(r.bytes);
  const b = Buffer.from(src.replace(/\r/g, ''), 'latin1');
  m.mem.set(b, 0x200000);
  const n = b.length;
  for (let i = 0; i < 4; i++) m.mem[0x21fffc + i] = (n >>> (8 * i)) & 255;
  for (const [name, text] of Object.entries(files)) {
    for (const d of m.drives) d.set(name, new Uint8Array(Buffer.from(text, 'latin1')));
  }
  m.startCartridge();
  let k = 0, f = 0;
  for (; f < frames && m.state === 'running'; f++) {
    if (keys && k < keys.length && f % 3 === 0) m.pushKey(keys.charCodeAt(k++));
    m.runFrame();
  }
  return { output: m.output, state: m.state, message: m.message, frames: f, m };
}

if (process.argv[1] && process.argv[1].endsWith('nc.js')) {
  const r = ncCart();
  console.log(`cartridge ${r.bytes.length} bytes, PROGEND $${r.info.progEnd.toString(16)}`);
  const o = ncRun(fs.readFileSync(process.argv[2], 'latin1'), { frames: +(process.argv[3] || 3000) });
  console.log(o.output);
  console.log(`--- ${o.state} ${o.message} (${o.frames} frames)`);
}
