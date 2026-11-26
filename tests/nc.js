// Run the on-device compiler in the emulator on a Pascal source.
//   node tests/nc.js prog.pas [frames]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCart } from './cart.js';
import { Meridian } from '../emu/meridian.js';
import { roms, startPascal816 } from './harness.js';
import { buildCDisk, readDisk } from '../compiler/mkcdisk.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cached = [null, null];
// c: the test cartridge built as the C cartridge
export function ncCart(c = false) {
  if (cached[+c]) return cached[+c];
  const r = buildCart(path.join(here, 'nctest.pas'), [path.join(here, '..', 'cart')], c);
  if (!r.ok) { console.log(r.errors); throw new Error('cartridge build failed'); }
  cached[+c] = r;
  return r;
}

// the files of the C disk (C.DSK, compiler/mkcdisk.js), read back from its image
let cdisk = null;
export function cDiskOnDrive() {
  if (!cdisk) cdisk = readDisk(buildCDisk());
  return cdisk;
}

// a C text (name NAME.C): compiled by the C cartridge, the C disk in drive 1
export function ncRun(src, { frames = 3000, keys = '', files = {}, name = '' } = {}) {
  const c = /\.C$/i.test(name);
  const r = ncCart(c);
  const m = new Meridian(roms);
  m.insertCartridge(r.bytes);
  if (c) for (const [n, b] of cDiskOnDrive()) m.drives[1].set(n, b);
  const b = Buffer.from(src.replace(/\r/g, ''), 'latin1');
  m.mem.set(b, 0x200000);
  const n = b.length;
  for (let i = 0; i < 4; i++) m.mem[0x21fffc + i] = (n >>> (8 * i)) & 255;
  // the file's name (a C text: NAME.C)
  m.mem[0x21ff00] = name.length;
  for (let i = 0; i < name.length; i++) m.mem[0x21ff01 + i] = name.charCodeAt(i);
  for (const [name, text] of Object.entries(files)) {
    for (const d of m.drives) d.set(name, new Uint8Array(Buffer.from(text, 'latin1')));
  }
  startPascal816(m);
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
