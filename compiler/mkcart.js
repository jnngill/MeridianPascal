#!/usr/bin/env node
// Build the PASCAL cartridge: the on-device IDE and compiler with all
// library units, as a MERIDIAN 816 module (.MOD, ROM at $40:0000).
//   node compiler/mkcart.js [-o PASCAL.MOD] [-l]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchubIde } from './mkschubide.js';
import { buildCartridge } from './cart.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
export const LIB_UNITS = ['crt', 'graph', 'sprites', 'audio', 'input', 'dos', 'blitter', 'copper', 'schub', 'basic'];

export function buildPascalCart(opts = {}) {
  const dirs = [path.join(root, 'cart'), path.join(root, 'lib')];
  const main = path.join(root, 'cart', 'ide.pas');
  return buildCartridge(fs.readFileSync(main, 'latin1'), main, {
    loadUnit: (name) => {
      for (const d of dirs) {
        const p = path.join(d, name + '.pas');
        if (fs.existsSync(p)) return { text: fs.readFileSync(p, 'latin1'), name: p };
      }
      return null;
    },
    libUnits: LIB_UNITS,
    name: 'PASCAL',
    listing: !!opts.listing,
    // the SCHUB build of the editor, started instead when the core has SCHUB
    schubEditor: opts.schub === false ? undefined : buildSchubIde(),
  });
}

if (process.argv[1] && process.argv[1].endsWith('mkcart.js')) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('-o');
  const out = oi >= 0 ? args[oi + 1] : path.join(root, 'PASCAL.MOD');
  const r = buildPascalCart({ listing: args.includes('-l'), schub: !args.includes('--no-schub') });
  if (!r.ok) {
    for (const e of r.errors) console.error(`${e.file ? path.relative(process.cwd(), e.file) : ''}${e.line ? `(${e.line},${e.col})` : ''}: error: ${e.msg}`);
    process.exit(1);
  }
  fs.writeFileSync(out, r.bytes);
  if (args.includes('-l')) fs.writeFileSync(out.replace(/\.mod$/i, '') + '.lst', r.listing);
  const hx = (v) => '$' + v.toString(16).toUpperCase();
  console.log(`${out}: ${r.bytes.length} bytes ROM, ${r.exports} library symbols, bank 0 data up to ${hx(r.info.progEnd)}, programs from ${hx(r.info.libEnd)}`);
}
