// where a Pascal program spends its cycles (65C816), by routine/label
//   node tests/profile.js PROG.PAS
import fs from 'node:fs';
import path from 'node:path';
import { build, roms } from './harness.js';
import { Meridian } from '../emu/meridian.js';
const f = process.argv[2];
const r = build(fs.readFileSync(f, 'latin1'), 'm816', path.basename(f), path.dirname(f));
if (!r.ok) { console.log(r.errors); process.exit(1); }
const syms = [...r.symbols].filter(([n, a]) => a >= 0x2000 && a < 0xc000 && /^(rt_|P\d|PMAIN|ASM)/.test(n)).sort((a, b) => a[1] - b[1]);
const owner = (pc) => { let lo = 0, hi = syms.length - 1, o = '?'; while (lo <= hi) { const k = (lo + hi) >> 1; if (syms[k][1] <= pc) { o = syms[k][0]; lo = k + 1; } else hi = k - 1; } return o; };
const m = new Meridian(roms);
m.startProgram(m.loadMer(r.mer).start);
const c = m.cpu, cyc = new Map(), st = m.step816.bind(m);
m.step816 = () => { const a = (c.pbr << 16) | c.pc; const n = st(); const k = a >= 0xd000 && a < 0x10000 ? 'kernel' : owner(a); cyc.set(k, (cyc.get(k) || 0) + n); return n; };
for (let i = 0; i < 100000 && m.state === 'running'; i++) m.runFrame();
const tot = [...cyc.values()].reduce((a, b) => a + b, 0);
for (const [k, v] of [...cyc].sort((a, b) => b[1] - a[1]).slice(0, +(process.argv[3] || 12))) console.log(`${(100 * v / tot).toFixed(1).padStart(5)}%  ${k}`);
