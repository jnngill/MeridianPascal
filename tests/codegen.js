// The code generator's shortcuts (inline 32-bit compares and shifts,
// multiplies by constants, the peephole pass) must not change results: the
// benchmark programs print what the compiler printed before them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, run } from './harness.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'bench');
const expect = {
  'calls.pas': '6765', 'check.pas': '-949717856', 'grid.pas': '-18880', 'longs.pas': '25032508 3659537',
  'mandel.pas': '11595', 'sieve.pas': '1899', 'strs.pas': '48 BCJKLMNOPQRYZABCDEFGNOPQRSTUVWXY',
};
let fail = 0;
for (const [f, want] of Object.entries(expect)) {
  const r = build(fs.readFileSync(path.join(dir, f), 'latin1'), 'm816', f, dir);
  const out = r.ok ? run(r, { frames: 100000 }).output.trim() : JSON.stringify(r.errors);
  const ok = out === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f}: ${ok ? want : `got ${out}, want ${want}`}`);
}
console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
