#!/usr/bin/env node
// MERIDIAN Pascal command-line compiler
//   node compiler/mpc.js program.pas [-t m816|schub] [-o out.mer] [-S] [-l]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from './compile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(here, '..', 'lib');

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) {
  console.log(`MERIDIAN Pascal compiler
usage: mpc <program.pas> [options]
  -t, --target m816|schub   65C816 (default) or the SCHUB RV32IM co-processor
  -o <file>                 output .MER file (default: program.mer)
  -S                        also write the assembly (.asm)
  -l                        also write a listing (.lst)
  -I <dir>                  extra unit search directory
  -D <name>                 define a conditional symbol`);
  process.exit(0);
}
let src = null, out = null, target = 'm816', wantAsm = false, wantLst = false;
const inc = [], defs = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-t' || a === '--target') target = args[++i];
  else if (a === '-o') out = args[++i];
  else if (a === '-S') wantAsm = true;
  else if (a === '-l') wantLst = true;
  else if (a === '-I') inc.push(args[++i]);
  else if (a === '-D') defs.push(args[++i].toUpperCase());
  else src = a;
}
const text = fs.readFileSync(src, 'latin1');
const dirs = [path.dirname(path.resolve(src)), ...inc, LIB];
const find = (name) => {
  for (const d of dirs) {
    for (const f of [name + '.pas', name.toUpperCase() + '.PAS', name + '.pp']) {
      const p = path.join(d, f);
      if (fs.existsSync(p)) return { text: fs.readFileSync(p, 'latin1'), name: p };
    }
  }
  return null;
};
const r = compile(text, path.resolve(src), {
  target,
  defines: defs,
  loadUnit: find,
  loadInclude: (fn, from) => {
    const p = path.resolve(path.dirname(from), fn);
    return fs.existsSync(p) ? { text: fs.readFileSync(p, 'latin1'), name: p } : null;
  },
});
if (!r.ok) {
  for (const e of r.errors) {
    console.error(`${e.file ? path.relative(process.cwd(), e.file) : src}${e.line ? `(${e.line},${e.col})` : ''}: error: ${e.msg}`);
    if (e.stack && process.env.MPC_DEBUG) console.error(e.stack);
  }
  process.exit(1);
}
out = out || src.replace(/\.(pas|pp)$/i, '') + '.mer';
fs.writeFileSync(out, r.mer);
if (wantAsm) fs.writeFileSync(out.replace(/\.mer$/i, '') + '.asm', r.asm);
if (wantLst) fs.writeFileSync(out.replace(/\.mer$/i, '') + '.lst', r.listing);
const hx = (v) => '$' + v.toString(16).toUpperCase().padStart(6, '0');
console.log(`${out}: ${r.bytes.length} bytes, load ${hx(r.load)}, start ${hx(r.start)}, target ${target} (${r.procCount.used}/${r.procCount.total} routines, ${r.ms} ms)`);
