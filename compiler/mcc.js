#!/usr/bin/env node
// MERIDIAN C command-line compiler
//   node compiler/mcc.js prog.c [more.c ...] [-t m816|schub] [-o out.mer] [-S] [-l] [-I dir] [-D NAME[=v]]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from './compile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

// the file finder for C: headers ("x.h" next to the file first), the
// library sources (clib/src) and the Pascal units (lib/)
export function cLoaders(extraDirs = []) {
  const inc = [...extraDirs, path.join(ROOT, 'clib', 'include')];
  const src = path.join(ROOT, 'clib', 'src');
  const read = (p) => ({ text: fs.readFileSync(p, 'latin1'), name: p });
  const loadC = (name, from, system) => {
    const dirs = [];
    if (/\.c$/i.test(name)) { if (from) dirs.push(path.dirname(from)); dirs.push(...extraDirs, src); }
    else { if (!system && from) dirs.push(path.dirname(from)); dirs.push(...inc); }
    for (const d of dirs) {
      const p = path.resolve(d, name);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return read(p);
    }
    return null;
  };
  const loadUnit = (name) => {
    for (const d of [...extraDirs, path.join(ROOT, 'lib')]) {
      const p = path.join(d, name + '.pas');
      if (fs.existsSync(p)) return read(p);
    }
    return null;
  };
  return { loadC, loadUnit };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    console.log(`MERIDIAN C compiler
usage: mcc <program.c> [more.c ...] [options]
  -t, --target m816|schub   65C816 (default) or the SCHUB RV32IM co-processor
  -o <file>                 output .MER file (default: program.mer)
  -S                        also write the assembly (.asm)
  -l                        also write a listing (.lst)
  -I <dir>                  extra include / unit directory
  -D <name>[=value]         define a macro
  -w                        no warnings`);
    process.exit(0);
  }
  const files = [];
  let out = null, target = 'm816', wantAsm = false, wantLst = false, quiet = false;
  const inc = [], defs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-t' || a === '--target') target = args[++i];
    else if (a === '-o') out = args[++i];
    else if (a === '-S') wantAsm = true;
    else if (a === '-l') wantLst = true;
    else if (a === '-w') quiet = true;
    else if (a === '-I') inc.push(path.resolve(args[++i]));
    else if (a.startsWith('-I')) inc.push(path.resolve(a.slice(2)));
    else if (a === '-D') defs.push(args[++i]);
    else if (a.startsWith('-D')) defs.push(a.slice(2));
    else files.push(a);
  }
  const src = files[0];
  const text = fs.readFileSync(src, 'latin1');
  const { loadC, loadUnit } = cLoaders([path.dirname(path.resolve(src)), ...inc]);
  const r = compile(text, path.resolve(src), {
    target, lang: 'c', cdefines: defs, loadC, loadUnit,
    sources: files.slice(1).map(f => ({ text: fs.readFileSync(f, 'latin1'), name: path.resolve(f) })),
  });
  const where = (e) => `${e.file ? path.relative(process.cwd(), e.file) : src}${e.line ? `:${e.line}:${e.col || 1}` : ''}`;
  if (!quiet) for (const w of r.warnings || []) console.error(`${where(w)}: warning: ${w.msg}`);
  if (!r.ok) {
    for (const e of r.errors) {
      console.error(`${where(e)}: error: ${e.msg}`);
      if (e.stack && process.env.MCC_DEBUG) console.error(e.stack);
    }
    process.exit(1);
  }
  out = out || src.replace(/\.c$/i, '') + '.mer';
  fs.writeFileSync(out, r.mer);
  if (wantAsm) fs.writeFileSync(out.replace(/\.mer$/i, '') + '.asm', r.asm);
  if (wantLst) fs.writeFileSync(out.replace(/\.mer$/i, '') + '.lst', r.listing);
  const hx = (v) => '$' + v.toString(16).toUpperCase().padStart(6, '0');
  console.log(`${out}: ${r.bytes.length} bytes, load ${hx(r.load)}, start ${hx(r.start)}, target ${target} (${r.procCount.used}/${r.procCount.total} routines, ${r.ms} ms)`);
}
