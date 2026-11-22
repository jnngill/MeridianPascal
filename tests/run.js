// Regression tests: every tests/cases/*.pas is built for both targets, run
// in the emulator, and its output compared with the (* EXPECT ... *) block.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, run } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'cases');
const only = process.argv[2];
const targets = (process.argv[3] || 'm816,schub').split(',');
let pass = 0, fail = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.pas')).sort()) {
  if (only && only !== 'all' && !f.includes(only)) continue;
  const src = fs.readFileSync(path.join(dir, f), 'latin1');
  const m = /\(\*\s*EXPECT\r?\n([\s\S]*?)\*\)/.exec(src);
  const keys = (/\(\*\s*KEYS:(.*)\*\)/.exec(src) || [])[1] || '';
  const expect = m ? m[1].replace(/\r/g, '').replace(/\s+$/, '') : null;
  for (const t of targets) {
    const r = build(src, t, path.join(dir, f), dir);
    if (!r.ok) {
      const e = r.errors[0];
      console.log(`FAIL ${f} [${t}] compile: ${e.msg} ${e.file ? path.basename(e.file) : ""}${e.line ? "@" + e.line : ""}`);
      if (e.stack && process.env.DEBUG) console.log(e.stack);
      fail++; continue;
    }
    const o = run(r, { frames: 3000, keys: keys.trim().replace(/\\r/g, '\r') });
    const got = o.output.replace(/\s+$/, '').split('\n').map(l => l.replace(/\s+$/, '')).join('\n');
    const exp = expect.split('\n').map(l => l.replace(/\s+$/, '')).join('\n');
    if (o.state === 'running') { console.log(`FAIL ${f} [${t}] still running after 3000 frames`); fail++; continue; }
    if (got === exp) { pass++; console.log(`ok   ${f} [${t}] (${r.bytes.length} bytes, ${o.frames} frames)`); }
    else {
      fail++;
      console.log(`FAIL ${f} [${t}] ${o.message}`);
      const g = got.split('\n'), x = exp.split('\n');
      for (let i = 0; i < Math.max(g.length, x.length); i++) {
        if (g[i] !== x[i]) console.log(`   line ${i + 1}: expected ${JSON.stringify(x[i])}\n           got      ${JSON.stringify(g[i])}`);
      }
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
