// Tests for the on-device compiler: every tests/ncases/*.pas is compiled by
// the compiler inside the PASCAL cartridge (in the emulator), run, and its
// output compared with the (* EXPECT ... *) block.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ncRun } from './nc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'ncases');
const schub = process.argv.includes('--schub');
const only = process.argv.slice(2).find(a => !a.startsWith('--'));
let pass = 0, fail = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.pas')).sort()) {
  if (only && !f.includes(only)) continue;
  const src = fs.readFileSync(path.join(dir, f), 'latin1');
  const m = /\(\*\s*EXPECT\r?\n([\s\S]*?)\*\)/.exec(src);
  const keys = ((/\(\*\s*KEYS:(.*)\*\)/.exec(src) || [])[1] || '').trim().replace(/\\r/g, '\r');
  const body = src.slice(0, src.indexOf('(* EXPECT') >= 0 ? src.indexOf('(*') : src.length);
  const files = {};
  for (const fm of src.matchAll(/\(\*\s*FILE\s+(\S+)\r?\n([\s\S]*?)\*\)/g)) files[fm[1].toUpperCase()] = fm[2];
  const o = ncRun((schub ? '{$SCHUB}\n' : '') + body, { frames: 6000, keys, files });
  let out = o.output;
  const lines = out.split('\n');
  const first = lines.shift();
  if (!first.startsWith('COMPILED')) { fail++; console.log(`FAIL ${f}: ${first}`); continue; }
  const backAt = lines.lastIndexOf('BACK');
  const got = lines.slice(0, backAt < 0 ? lines.length : backAt).map(l => l.replace(/\s+$/, '')).join('\n').replace(/\s+$/, '');
  const exp = m[1].replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\s+$/, '');
  if (got === exp && backAt >= 0) { pass++; console.log(`ok   ${f} (${first.slice(9)} code/data bytes, ${o.frames} frames)`); }
  else {
    fail++;
    console.log(`FAIL ${f} ${o.state} ${o.message} ${backAt < 0 ? '(no return to the IDE)' : ''}`);
    const g = got.split('\n'), x = exp.split('\n');
    for (let i = 0; i < Math.max(g.length, x.length); i++) {
      if (g[i] !== x[i]) console.log(`   line ${i + 1}: expected ${JSON.stringify(x[i])}\n           got      ${JSON.stringify(g[i])}`);
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
