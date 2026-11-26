// C regression tests: every tests/ccases/*.c is built for both targets, run
// in the emulator, and its output compared with the /* EXPECT ... */ block.
//   node tests/crun.js [name-part] [m816,schub]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../compiler/compile.js';
import { cLoaders } from '../compiler/mcc.js';
import { run } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'ccases');
const only = process.argv[2];
const targets = (process.argv[3] || 'm816,schub').split(',');
let pass = 0, fail = 0;

export function buildC(src, file, target) {
  const { loadC, loadUnit } = cLoaders([path.dirname(file)]);
  return compile(src, file, { target, lang: 'c', loadC, loadUnit });
}

for (const f of fs.readdirSync(dir).filter(f => /^\d.*\.c$/.test(f)).sort()) {
  if (only && only !== 'all' && !f.includes(only)) continue;
  const file = path.join(dir, f);
  const src = fs.readFileSync(file, 'latin1');
  const m = /\/\*\s*EXPECT\r?\n([\s\S]*?)\*\//.exec(src);
  const keys = (/\/\*\s*KEYS:(.*)\*\//.exec(src) || [])[1] || '';
  const expect = m ? m[1].replace(/\r/g, '').replace(/\s+$/, '') : '';
  for (const t of targets) {
    const r = buildC(src, file, t);
    if (!r.ok) {
      const e = r.errors[0];
      console.log(`FAIL ${f} [${t}] compile: ${e.msg} ${e.file ? path.basename(e.file) : ''}${e.line ? '@' + e.line : ''}`);
      if (e.stack && process.env.DEBUG) console.log(e.stack);
      fail++; continue;
    }
    if (process.env.WARN) for (const w of r.warnings) console.log(`   warning ${w.file ? path.basename(w.file) : ''}@${w.line}: ${w.msg}`);
    const o = run(r, { frames: 4000, keys: keys.trim().replace(/\\r/g, '\r') });
    const got = o.output.replace(/\s+$/, '').split('\n').map(l => l.replace(/\s+$/, '')).join('\n');
    const exp = expect.split('\n').map(l => l.replace(/\s+$/, '')).join('\n');
    if (o.state === 'running') { console.log(`FAIL ${f} [${t}] still running after 4000 frames`); fail++; continue; }
    if (got === exp) { pass++; console.log(`ok   ${f} [${t}] (${r.bytes.length} bytes, ${o.frames} frames)`); }
    else {
      fail++;
      console.log(`FAIL ${f} [${t}] ${o.message || ''}`);
      const g = got.split('\n'), x = exp.split('\n');
      for (let i = 0; i < Math.max(g.length, x.length); i++) {
        if (g[i] !== x[i]) console.log(`   line ${i + 1}: expected ${JSON.stringify(x[i])}\n           got      ${JSON.stringify(g[i])}`);
      }
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
