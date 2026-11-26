#!/usr/bin/env node
// Writes clib/include/<unit>.h for each library unit in lib/: the header
// makes the unit visible to C (#pragma unit) and quotes its interface.
//   node clib/mkheaders.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.join(here, '..', 'lib');
const inc = path.join(here, 'include');

for (const f of fs.readdirSync(lib).filter(f => f.endsWith('.pas') && f !== 'system.pas')) {
  const name = f.replace(/\.pas$/, '');
  const text = fs.readFileSync(path.join(lib, f), 'latin1').replace(/\r/g, '');
  const m = /\binterface\b([\s\S]*?)\bimplementation\b/i.exec(text);
  const head = /^\{([\s\S]*?)\}/.exec(text);
  const iface = (m ? m[1] : '').replace(/\*\//g, '* /').trim();
  const guard = `_${name.toUpperCase()}_H`;
  const out = `/* <${name}.h> - the ${name} unit of the MERIDIAN library (lib/${f}), for C.
${head ? head[1].split('\n').map(l => '   ' + l.trim()).join('\n').replace(/\*\//g, '* /') + '\n' : ''}
   Its routines, constants, variables and types can be used from C under
   their Pascal names (in any case): integer is int, word unsigned, byte
   unsigned char, longint long, boolean a 0/1 int, real float; a string
   parameter takes a C string, a function returning a string gives a
   char * (valid until the calling function returns); a var parameter
   takes an address (&x).

   The interface of the unit:

${iface.split('\n').map(l => '   ' + l).join('\n')}
*/
#ifndef ${guard}
#define ${guard}
#pragma unit ${name}
#endif
`;
  fs.writeFileSync(path.join(inc, name + '.h'), out.replace(/[ \t]+$/gm, ''));
  console.log(`clib/include/${name}.h`);
}
