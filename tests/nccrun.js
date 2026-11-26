// Tests for the on-device C compiler: tests/ccases/*.c (those in ON_DEVICE,
// or all with --all) are compiled by the compiler inside the PASCAL
// cartridge (in the emulator), run, and their output compared with the
// /* EXPECT ... */ block, as tests/crun.js does for the PC compiler.
//   node tests/nccrun.js [--schub] [--all] [name-part]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ncRun } from './nc.js';

// the cases the cartridge's C compiles (it has no bit-fields, compound
// literals, asm blocks, units of your own or several files at once)
export const ON_DEVICE = ['01_hello', '02_arith', '03_control', '04_funcs', '05_pointers', '07_float', '08_preproc',
  '09_stdlib', '11_pascal', '12_memory', '13_files', '14_input', '17_tricky', '18_headers'];

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'ccases');
const schub = process.argv.includes('--schub');
const all = process.argv.includes('--all');
const only = process.argv.slice(2).find(a => !a.startsWith('--'));
let pass = 0, fail = 0;
for (const f of fs.readdirSync(dir).filter(f => /^\d.*\.c$/.test(f)).sort()) {
  if (only && !f.includes(only)) continue;
  if (!all && !only && !ON_DEVICE.includes(f.replace(/\.c$/, ''))) continue;
  const src = fs.readFileSync(path.join(dir, f), 'latin1');
  const m = /\/\*\s*EXPECT\r?\n([\s\S]*?)\*\//.exec(src);
  const keys = ((/\/\*\s*KEYS:(.*)\*\//.exec(src) || [])[1] || '').trim().replace(/\\r/g, '\r');
  // the other files a case includes ("x.h") are on the drive
  const files = {};
  for (const inc of src.matchAll(/#include\s+"([^"]+)"/g)) {
    const p = path.join(dir, inc[1]);
    if (fs.existsSync(p)) files[inc[1].toUpperCase()] = fs.readFileSync(p, 'latin1');
  }
  const o = ncRun((schub ? '#pragma schub\n#line 1\n' : '') + src, { frames: 8000, keys, files, name: f.toUpperCase() });
  const lines = o.output.split('\n');
  const first = lines.shift();
  if (!first.startsWith('COMPILED')) { fail++; console.log(`FAIL ${f}: ${first}`); continue; }
  const backAt = lines.lastIndexOf('BACK');
  const got = lines.slice(0, backAt < 0 ? lines.length : backAt).map(l => l.replace(/\s+$/, '')).join('\n').replace(/\s+$/, '');
  const exp = m[1].replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\s+$/, '');
  if (got === exp && backAt >= 0) { pass++; console.log(`ok   ${f} (${first.slice(9)} code/data bytes, ${o.frames} frames)`); }
  else {
    fail++;
    console.log(`FAIL ${f} ${o.state} ${o.message || ''} ${backAt < 0 ? '(no return to the IDE)' : ''}`);
    const g = got.split('\n'), x = exp.split('\n');
    for (let i = 0; i < Math.max(g.length, x.length); i++) {
      if (g[i] !== x[i]) console.log(`   line ${i + 1}: expected ${JSON.stringify(x[i])}\n           got      ${JSON.stringify(g[i])}`);
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
