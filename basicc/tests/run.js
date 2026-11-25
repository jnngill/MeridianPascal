// MERIDIAN BASIC compiler: every test program must print the same as the
// real MERIDIAN BASIC interpreter (run in the emulator with the core's ROMs).
//   node basicc/tests/run.js [--bench]   (--bench: also the b*.bas timings)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare } from '../compare.js';
import { compileBasic } from '../bc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bench = process.argv.includes('--bench');
let fail = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; if (extra) console.log(extra); } };

const files = fs.readdirSync(here).filter(f => f.endsWith('.bas') && (bench || f.startsWith('t'))).sort();
for (const f of files) {
  const r = compare(fs.readFileSync(path.join(here, f), 'latin1'));
  if (!r.ok) { check(`${f} compiles`, false, JSON.stringify(r.errors)); continue; }
  const x = (r.interp.cycles / r.compiled.cycles).toFixed(1);
  check(`${f}: same output as the interpreter${bench ? ` (interpreted ${(r.interp.cycles / 8e3).toFixed(0)} ms, compiled ${(r.compiled.cycles / 8e3).toFixed(0)} ms, x${x})` : ''}`,
    r.same && r.interp.done && r.compiled.done, `--- interpreted\n${r.interp.out}\n--- compiled\n${r.compiled.out}`);
}

// what the compiler refuses, with BASIC's own words where BASIC has them
const refuse = [
  ['10 GOTO 99', /UNDEF'D STATEMENT 99/],
  ['10 NEXT', /NEXT WITHOUT FOR/],
  ['10 WEND', /WEND WITHOUT WHILE/],
  ['10 A$=1', /TYPE MISMATCH/],
  ['10 DIM A(N)', /constant sizes/],
  ['10 SOUND 1,440', /not in the prototype/],
];
for (const [src, re] of refuse) {
  const r = compileBasic(src);
  check(`refuses ${JSON.stringify(src)}`, !r.ok && re.test(r.errors[0].msg), JSON.stringify(r.errors));
}
console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
