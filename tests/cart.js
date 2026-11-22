// Build a cartridge from a main program and run it in the emulator.
//   node tests/cart.js [main.pas] [frames]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCartridge } from '../compiler/cart.js';
import { Meridian } from '../emu/meridian.js';
import { roms } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
export { LIB_UNITS } from '../compiler/mkcart.js';
import { LIB_UNITS } from '../compiler/mkcart.js';

export function cartLoader(dirs) {
  return (name) => {
    for (const d of dirs) {
      const p = path.join(d, name + '.pas');
      if (fs.existsSync(p)) return { text: fs.readFileSync(p, 'latin1'), name: p };
    }
    return null;
  };
}

export function buildCart(file, extraDirs = []) {
  return buildCartridge(fs.readFileSync(file, 'latin1'), file, {
    loadUnit: cartLoader([path.dirname(file), ...extraDirs, path.join(root, 'lib')]),
    libUnits: LIB_UNITS,
    listing: true,
  });
}

if (process.argv[1] && process.argv[1].endsWith('cart.js')) {
  const file = process.argv[2] || path.join(here, 'cartsmoke.pas');
  const r = buildCart(file);
  if (!r.ok) { console.log(r.errors); process.exit(1); }
  console.log(`ROM ${r.bytes.length} bytes, ${r.exports} exports, LIBEND $${r.info.libEnd.toString(16)}, PROGEND $${r.info.progEnd.toString(16)}`);
  const m = new Meridian(roms);
  m.insertCartridge(r.bytes);
  m.startCartridge();
  const frames = +(process.argv[3] || 300);
  for (let f = 0; f < frames && m.state === 'running'; f++) m.runFrame();
  console.log(m.output);
  console.log(`--- ${m.state} ${m.message}`);
}
