// Build every example for both targets and run each for a while in the
// emulator: it must compile, and must not crash (BRK, bus error, ...).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, run } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'examples');
let bad = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.pas')).sort()) {
  for (const t of ['m816', 'schub']) {
    const src = fs.readFileSync(path.join(dir, f), 'latin1');
    const r = build(src, t, path.join(dir, f), dir);
    if (!r.ok) { bad++; console.log(`FAIL ${f} [${t}]: ${r.errors[0].msg} ${r.errors[0].file ? path.basename(r.errors[0].file) : ''}@${r.errors[0].line}`); continue; }
    const o = run(r, { frames: 240, keys: '50\r' });
    const err = o.state === 'stopped' || o.m.rv.error;
    if (err) bad++;
    const last = o.output.trim().split('\n').pop() || '';
    console.log(`${err ? 'FAIL' : 'ok  '} ${f.padEnd(16)} [${t.padEnd(5)}] ${String(r.bytes.length).padStart(6)} bytes  ${o.state.padEnd(8)} ${o.message || ''} ${o.m.rv.error || ''} | ${last.slice(0, 40)}`);
  }
}
console.log(bad ? `${bad} problems` : 'all examples ok');
process.exit(bad ? 1 : 0);
