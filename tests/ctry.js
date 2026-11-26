// Compile and run one C file (or a snippet given with -e) on both targets.
//   node tests/ctry.js file.c [m816|schub] [-S]     node tests/ctry.js -e "int main(){...}"
import fs from 'node:fs';
import path from 'node:path';
import { compile } from '../compiler/compile.js';
import { cLoaders } from '../compiler/mcc.js';
import { run } from './harness.js';

const args = process.argv.slice(2);
let file, src;
if (args[0] === '-e') { src = '#include <stdio.h>\n' + args[1]; file = path.resolve('snippet.c'); }
else { file = path.resolve(args[0]); src = fs.readFileSync(file, 'latin1'); }
const targets = args.find(a => a === 'm816' || a === 'schub') ? [args.find(a => a === 'm816' || a === 'schub')] : ['m816', 'schub'];
for (const t of targets) {
  const { loadC, loadUnit } = cLoaders([path.dirname(file)]);
  const r = compile(src, file, { target: t, lang: 'c', loadC, loadUnit, keepIR: args.includes('-ir') });
  for (const w of r.warnings || []) console.log(`warning ${w.file ? path.basename(w.file) : ''}:${w.line}: ${w.msg}`);
  if (!r.ok) { for (const e of r.errors) console.log(`[${t}] error ${e.file ? path.basename(e.file) : ''}:${e.line}: ${e.msg}`, e.stack || ''); continue; }
  if (args.includes('-S')) fs.writeFileSync(`ctry_${t}.asm`, r.asm);
  if (args.includes('-ir')) fs.writeFileSync(`ctry_${t}.ir.json`, JSON.stringify(r.ir.procs.filter(p => !/^P\d/.test(p.label)), null, 1));
  const o = run(r, { frames: 4000 });
  console.log(`[${t}] ${r.bytes.length} bytes, ${o.state} ${o.message || ''}\n${o.output}`);
}
