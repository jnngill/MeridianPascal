// C compile errors: each snippet must fail with the message and on the line given.
import path from 'node:path';
import { compile } from '../compiler/compile.js';
import { cLoaders } from '../compiler/mcc.js';

const cases = [
  ['int main(void) { return x; }', "'x' undeclared", 1],
  ['int main(void) {\n  int a;\n  a = ;\n}', 'expression expected', 3],
  ['int main(void) {\n  int a[3];\n  a = 0;\n}', 'an array cannot be assigned', 3],
  ['struct s { int a; };\nint main(void) {\n  struct s v;\n  return v.b;\n}', "has no member 'b'", 4],
  ['int f(int a, int b);\nint main(void) {\n  return f(1);\n}', 'too few arguments', 3],
  ['int main(void) {\n  break;\n}', "'break' outside a loop", 2],
  ['int main(void) {\n  int a;\n  int a;\n}', "redefinition of 'a'", 3],
  ['#include <stdio.h>\nint main(void) {\n  printf("%d\\n", 1)\n}', "';' expected", 4],
  ['int main(void) {\n  goto nowhere;\n}', "label 'nowhere' is used but not defined", 2],
  ['#if 1\nint main(void) { return 0; }\n', '#if without #endif', 1],
  ['#include "missing.h"\nint main(void) { return 0; }', "include file 'missing.h' not found", 1],
  ['int g(void);\nint main(void) {\n  return g();\n}', "undefined reference to 'g'", 3],
  ['int x;', 'no main function', 1],
  ['#include <crt.h>\nint main(void) {\n  GotoXY(1);\n}', 'takes 2 arguments', 3],
  ['int main(void) {\n  int *p;\n  return *p.x;\n}', "'.' needs a struct", 3],
  ['#error stop here\nint main(void) { return 0; }', '#error stop here', 1],
];

let pass = 0, fail = 0;
for (const [src, msg, line] of cases) {
  for (const target of ['m816', 'schub']) {
    const file = path.resolve('err.c');
    const r = compile(src, file, { target, lang: 'c', ...cLoaders([]) });
    const e = r.errors[0];
    if (!r.ok && e && e.msg.includes(msg) && e.line === line) { pass++; continue; }
    fail++;
    console.log(`FAIL [${target}] ${JSON.stringify(src.slice(0, 50))}\n   expected "${msg}" at line ${line}, got ${r.ok ? 'no error' : `"${e.msg}" at line ${e.line}`}`);
  }
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
