// Run a BASIC program interpreted (the real MERIDIAN BASIC) and compiled,
// in the emulator, and compare output and time.
//   node basicc/compare.js PROG.BAS [...]
import fs from 'node:fs';
import { compileBasic } from './bc.js';
import { runBasic, runMer } from './interp.js';

export function compare(src, opts = {}) {
  const res = compileBasic(src);
  if (!res.ok) return { ok: false, errors: res.errors, pascal: res.pascal };
  const a = runBasic(src, opts);
  const b = runMer(res.mer, opts);
  // the interpreter's output starts after RUN and ends with READY.
  const clean = (s) => s.replace(/\r/g, '\n').replace(/^RUN\n/, '').replace(/\n*READY\.\n*$/, '').replace(/\n+$/, '');
  const ia = clean(a.output), cb = clean(b.output);
  return { ok: true, same: ia === cb, interp: { out: ia, cycles: a.cycles, done: a.ready }, compiled: { out: cb, cycles: b.cycles, done: b.ready, state: b.state, message: b.message }, res };
}

if (process.argv[1] && process.argv[1].endsWith('compare.js')) {
  for (const f of process.argv.slice(2)) {
    const r = compare(fs.readFileSync(f, 'latin1'));
    if (!r.ok) { console.log(f, r.errors); continue; }
    const ms = (c) => (c / 8000).toFixed(1) + ' ms';
    console.log(`== ${f}: output ${r.same ? 'identical' : 'DIFFERENT'}; interpreted ${ms(r.interp.cycles)}${r.interp.done ? '' : ' (not finished)'}, compiled ${ms(r.compiled.cycles)}${r.compiled.done ? '' : ' (not finished)'}, x${(r.interp.cycles / r.compiled.cycles).toFixed(1)}`);
    if (!r.same) { console.log('--- interpreted\n' + r.interp.out + '\n--- compiled\n' + r.compiled.out + (r.compiled.message ? '\n(' + r.compiled.message + ')' : '')); }
  }
}
