// C in the PASCAL cartridge's editor, driven through the keyboard: F3 opens
// a NAME.C, the status line shows the C target, F5 compiles it with the
// on-device C compiler and runs it (65C816, then SCHUB with Ctrl+T), an
// error puts the cursor on its line, F7 saves a standalone .MER that runs
// without the cartridge.
import { buildPascalCart } from '../compiler/mkcart.js';
import { Meridian } from '../emu/meridian.js';
import { roms, startPascal816 } from './harness.js';

const r = buildPascalCart();
if (!r.ok) { console.log(r.errors); process.exit(1); }
const m = new Meridian(roms);
m.insertCartridge(r.bytes);
startPascal816(m);
const frames = (n) => { for (let i = 0; i < n && m.state === 'running'; i++) m.runFrame(); };
const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(c === '\n' ? 8 : 3); } frames(30); };
const key = (code, n = 1) => { for (let i = 0; i < n; i++) { m.pushKey(code); frames(4); } frames(10); };
const hold = (scan, n = 4) => { m.keyState(scan, true); frames(n); m.keyState(scan, false); frames(2); };
const ctrl = (scan) => { m.keyState(0x14, true); frames(2); hold(scan); m.keyState(0x14, false); frames(4); };
const screen = () => m.screenText();
const line = (n) => screen().split('\n')[n] || '';
let fail = 0;
const check = (what, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; console.log(screen()); } };

const PROG = [
  '/* the on-device C compiler */',
  '#include <stdio.h>',
  '#include <string.h>',
  '#define N 6',
  'struct pt { int x, y; };',
  'static long fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }',
  'int main(void)',
  '{',
  '    struct pt p = { 3, 4 };',
  '    char buf[32];',
  '    int i;',
  '    sprintf(buf, "%s-%d", "C", p.x * p.y);',
  '    for (i = 1; i <= N; i++) printf("%ld ", fact(i));',
  '    printf("\\n%s %d\\n", buf, (int)strlen(buf));',
  '    return 0;',
  '}',
  ''].join('\n');
const OUT = /1 2 6 24 120 720\s+C-12 4/;

frames(60);
m.drives[1].set('FACT.C', Buffer.from(PROG, 'latin1'));
hold(0x04); frames(5); type('fact.c\n'); frames(30);
check('F3 opens FACT.C', /Opened FACT.C/.test(screen()) && /#include <stdio.h>/.test(screen()));
check('the status line names the C target', /FACT\.C .*C 65C816/.test(line(1)));

hold(0x03);                                   // F5
frames(300);
check('F5: compiled on the MERIDIAN and run', OUT.test(screen()) && /PRESS A KEY/.test(screen()));
key(32); frames(30);
check('back in the editor', /Program ended/.test(screen()));

ctrl(0x2c);                                   // Ctrl+T: SCHUB
check('Ctrl+T: the C SCHUB target', /C SCHUB/.test(line(1)));
hold(0x03);
frames(300);
check('F5 for SCHUB', OUT.test(screen()));
key(32); frames(30);
ctrl(0x2c);                                   // back to the 65C816
check('Ctrl+T again: the 65C816', /C 65C816/.test(line(1)));

// an error on line 13: an undeclared name
key(0x1e, 30);                                // up to the top
key(0x1f, 12); key(0x01);                     // line 13
type('    nothing = 1;\n');
hold(0x01);                                   // F9: compile
frames(120);
check('an error: its line in the status line', /Error line 13: undeclared: nothing/.test(line(29)) && /Ln 13 /.test(line(1)));
ctrl(0x35); frames(20);                       // Ctrl+Y: the line goes
hold(0x01); frames(120);
check('compiles again', /Compiled: \d+ lines/.test(line(29)));

// F7: a standalone .MER
hold(0x02);
frames(200);
type('\n');                                   // the name it offers: FACT
frames(120);
check('F7 saved FACT.MER', /Saved FACT.MER/.test(screen()) && m.drives[1].has('FACT.MER'));
const mer = m.drives[1].get('FACT.MER');
if (mer) {
  const x = new Meridian(roms);
  const info = x.loadMer(mer);
  x.startProgram(info.start);
  for (let i = 0; i < 600 && x.state === 'running'; i++) x.runFrame();
  check('FACT.MER runs without the cartridge', OUT.test(x.output.replace(/\r/g, '\n')));
}

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
