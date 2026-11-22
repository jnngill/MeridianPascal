// End-to-end test of the PASCAL cartridge in the emulator, driven only
// through the keyboard: edit the starter program, F5 compiles and runs it,
// a key brings back the editor; then a program with an error, F9 must put
// the error into the status line and the cursor on its line; F2 saves.
import { buildPascalCart } from '../compiler/mkcart.js';
import { Meridian } from '../emu/meridian.js';
import { roms } from './harness.js';

const r = buildPascalCart();
if (!r.ok) { console.log(r.errors); process.exit(1); }
const m = new Meridian(roms);
m.insertCartridge(r.bytes);
m.startCartridge();
const frames = (n) => { for (let i = 0; i < n && m.state === 'running'; i++) m.runFrame(); };
const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(c === '\n' ? 8 : 3); } frames(30); };
const key = (code, n = 1) => { for (let i = 0; i < n; i++) { m.pushKey(code); frames(4); } frames(10); };
const hold = (scan, n = 4) => { m.keyState(scan, true); frames(n); m.keyState(scan, false); frames(2); };
const screen = () => m.screenText();
let fail = 0;
const check = (what, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; console.log(screen()); } };

frames(60);
check('editor starts', /MERIDIAN PASCAL/.test(screen()) && /program Hello;/.test(screen()));

// line 6 is the WriteLn: insert a line in front of it
key(0x1f, 5);                       // cursor down x5
key(0x01);                          // Home
type('  WriteLn(6 * 7, \' \', Copy(\'PASCAL\', 1, 3));\n');
check('text edited', /WriteLn\(6 \* 7/.test(screen()) && /LINE 7/.test(screen()) && /end\./.test(screen()));

hold(0x03);                         // F5: compile and run
frames(200);
check('program ran', /42 PAS/.test(screen()) && /HELLO FROM THE MERIDIAN!/.test(screen()) && /PRESS A KEY/.test(screen()));
key(32);
frames(30);
check('back in the editor', /PROGRAM ENDED/.test(screen()) && /WriteLn\(6 \* 7/.test(screen()));

// an error: unknown identifier on line 7
key(0x1e, 10);                      // up to the top
key(0x01); type('x');               // "xprogram Hello;" -> error at line 1
hold(0x01);                         // F9: compile
frames(60);
check('error reported', /ERROR LINE 1/.test(screen()));
key(0x01); key(0x7f);               // Home, delete the x
hold(0x01);
frames(60);
check('compiles again', /OK: \d+ LINES/.test(screen()));

// F2: save on drive 1
hold(0x06);
frames(5);
type('demo\n');
frames(30);
check('saved', /SAVED DEMO.PAS/.test(screen()) && m.drives[1].has('DEMO.PAS'));
const saved = Buffer.from(m.drives[1].get('DEMO.PAS') || []).toString('latin1');
check('saved text is the program', saved.startsWith('program Hello;\nuses Crt;') && saved.includes('WriteLn(6 * 7'));

// F4 new, F3 load it back
hold(0x0c); frames(20);
hold(0x04); frames(5); type('demo\n'); frames(30);
check('loaded', /LOADED DEMO.PAS/.test(screen()) && /WriteLn\(6 \* 7/.test(screen()));

// a unit of your own on the disk
m.drives[1].set('MYLIB.PAS', Buffer.from('unit MyLib;\ninterface\nfunction Twice(n: integer): integer;\nimplementation\nfunction Twice;\nbegin\n  Twice := 2 * n;\nend;\nend.\n', 'latin1'));
m.drives[1].set('BROKEN.PAS', Buffer.from('unit Broken;\ninterface\nimplementation\nbegin\n  nothing := 1;\nend.\n', 'latin1'));
hold(0x0c); frames(20);
type('program U;\nuses MyLib;\nbegin\nWriteLn(\'UNIT \', Twice(21));\nend.\n');
hold(0x03);
frames(200);
check('program with a unit ran', /UNIT 42/.test(screen()));
key(32); frames(30);
key(0x1e, 10); key(0x1f); key(0x01);
type('uses Broken;\n');
hold(0x01); frames(60);
check('error in a unit reported', /ERROR IN BROKEN.PAS LINE 5/.test(screen()));

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
