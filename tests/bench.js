// Pascal benchmarks: cycles on the 65C816 (8 MHz) from start to end.
//   node tests/bench.js [--json FILE] [--base FILE]   (--base: compare with saved numbers)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './harness.js';
import { Meridian } from '../emu/meridian.js';
import { roms } from './harness.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'bench');
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const base = arg('--base') ? JSON.parse(fs.readFileSync(arg('--base'), 'utf8')) : null;
const res = {};
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.pas')).sort()) {
  const r = build(fs.readFileSync(path.join(dir, f), 'latin1'), 'm816', f, dir);
  if (!r.ok) { console.log(f, r.errors); continue; }
  const m = new Meridian(roms);
  m.startProgram(m.loadMer(r.mer).start);
  const c0 = m.totalCycles;
  for (let i = 0; i < 100000 && m.state === 'running'; i++) m.runFrame();
  const cyc = m.totalCycles - c0;
  res[f] = { cycles: cyc, out: m.output.trim(), size: r.bytes.length };
  const b = base && base[f];
  console.log(`${f.padEnd(11)} ${(cyc / 8000).toFixed(1).padStart(8)} ms  ${String(r.bytes.length).padStart(6)} bytes  ${b ? `x${(b.cycles / cyc).toFixed(2)}${b.out !== res[f].out ? '  OUTPUT CHANGED' : ''}` : ''}  ${m.output.trim().slice(0, 40)}`);
}
if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(res, null, 1));
