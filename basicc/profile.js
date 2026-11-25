// where a compiled BASIC program spends its cycles: by routine (symbols of
// the program) and the kernel ($D000-$FFFF)
import fs from 'node:fs';
import { compileBasic } from './bc.js';
import { coreMachine } from './interp.js';
const res = compileBasic(fs.readFileSync(process.argv[2], 'latin1'));
if (!res.ok) { console.log(res.errors); process.exit(1); }
const syms = [...res.symbols].filter(([n, a]) => a >= 0x2000 && a < 0xc000 && !/^[LGQ]\d|^QS|^QT|^\+|^-/.test(n)).sort((a, b) => a[1] - b[1]);
const m = coreMachine();
m.mem[0x20] = 0xff;
m.startProgram(m.loadMer(res.mer).start);
const c = m.cpu, cyc = new Map();
const st = m.step816.bind(m);
const owner = (pc) => { let lo = 0, hi = syms.length - 1, r = null; while (lo <= hi) { const k = (lo + hi) >> 1; if (syms[k][1] <= pc) { r = syms[k][0]; lo = k + 1; } else hi = k - 1; } return r; };
const stack = [];
m.step816 = () => { const a = (c.pbr << 16) | c.pc; const n = st(); const k = a >= 0xd000 && a < 0x10000 ? 'kernel' : a < 0x10000 ? owner(a) : 'bank' + (a >> 16).toString(16); cyc.set(k, (cyc.get(k) || 0) + n); return n; };
for (let i = 0; i < 60000 && m.state === 'running'; i++) m.runFrame();
const tot = [...cyc.values()].reduce((a, b) => a + b, 0);
for (const [k, v] of [...cyc].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`${(100 * v / tot).toFixed(1).padStart(5)}%  ${k}`);
