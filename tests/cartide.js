// End-to-end test of the PASCAL cartridge in the emulator, driven only
// through the keyboard: edit the starter program, F5 compiles and runs it,
// a key brings back the editor; then a program with an error, F9 must put
// the error into the status line and the cursor on its line; F2 saves.
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
const screen = () => m.screenText();
let fail = 0;
const check = (what, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; console.log(screen()); } };

frames(60);
check('editor starts', /PASCAL +F1 help/.test(screen()) && /program Hello;/.test(screen()));

// line 6 is the WriteLn: insert a line in front of it
key(0x1f, 5);                       // cursor down x5
key(0x01);                          // Home
type('  WriteLn(6 * 7, \' \', Copy(\'PASCAL\', 1, 3));\n');
check('text edited', /WriteLn\(6 \* 7/.test(screen()) && /Ln 7 /.test(screen()) && /end\./.test(screen()));

hold(0x03);                         // F5: compile and run
frames(200);
check('program ran', /42 PAS/.test(screen()) && /HELLO FROM THE MERIDIAN!/.test(screen()) && /PRESS A KEY/.test(screen()));
key(32);
frames(30);
check('back in the editor', /Program ended/.test(screen()) && /WriteLn\(6 \* 7/.test(screen()));

// an error: unknown identifier on line 7
key(0x1e, 10);                      // up to the top
key(0x01); type('x');               // "xprogram Hello;" -> error at line 1
hold(0x01);                         // F9: compile
frames(60);
check('error reported', /Error line 1/.test(screen()));
key(0x01); key(0x7f);               // Home, delete the x
hold(0x01);
frames(60);
check('compiles again', /Compiled: \d+ lines/.test(screen()));

// F2: save on drive 1
hold(0x06);
frames(5);
type('demo\n');
frames(30);
check('saved', /Saved DEMO.PAS/.test(screen()) && m.drives[1].has('DEMO.PAS'));
const saved = Buffer.from(m.drives[1].get('DEMO.PAS') || []).toString('latin1');
check('saved text is the program', saved.startsWith('program Hello;\nuses Crt;') && saved.includes('WriteLn(6 * 7'));

// F4 new, F3 load it back
hold(0x0c); frames(20);
hold(0x04); frames(5); type('demo\n'); frames(30);
check('loaded', /Opened DEMO.PAS/.test(screen()) && /WriteLn\(6 \* 7/.test(screen()));

// a unit of your own on the disk
m.drives[1].set('MYLIB.PAS', Buffer.from('unit MyLib;\ninterface\nfunction Twice(n: integer): integer;\nimplementation\nfunction Twice;\nbegin\n  Twice := 2 * n;\nend;\nend.\n', 'latin1'));
m.drives[1].set('BROKEN.PAS', Buffer.from('unit Broken;\ninterface\nimplementation\nbegin\n  nothing := 1;\nend.\n', 'latin1'));
hold(0x0c); frames(20);
type('program U;\nuses MyLib;\nbegin\nWriteLn(\'UNIT \', Twice(21));\nend.\n');
hold(0x03);
frames(200);
check('program with a unit ran', /UNIT 42/.test(screen()));
key(32); frames(30);
key(0x1e, 10); key(0x1f); key(0x01); key(0x1c, 5);
type('Broken, ');                                     // uses Broken, MyLib;
hold(0x01); frames(60);
const line = (n) => screen().split('\n')[n] || '';
check('an error in a unit: the editor offers to open it', /Error in BROKEN\.PAS line 5\. Open BROKEN\.PAS there\? \(Y\/N\)/.test(line(29)));
m.pushKey(78); frames(30);                            // N
check('N: the error is reported, the program stays', /Error in BROKEN.PAS line 5/.test(line(29)) && /\(new\)/.test(line(1)));
hold(0x01); frames(60);
m.pushKey(89); frames(30);                            // Y: the program has no name yet: save it first
check('Y: the program is saved first', /Save as:/.test(line(29)));
type('useprog\n'); frames(120);
check('the unit is open at the error', m.drives[1].has('USEPROG.PAS') && /BROKEN\.PAS/.test(line(1)) && /Ln 5 /.test(line(1)) &&
  /^ *Error line 5: .*\(F9: back to USEPROG\.PAS\)/.test(line(29)) && /nothing := 1;/.test(line(6)));
m.keyState(0x14, true); hold(0x35); m.keyState(0x14, false); frames(20);   // ^Y: the wrong line goes
hold(0x01); frames(150);                              // F9: save the unit, back to the program, compile
const unitNow = Buffer.from(m.drives[1].get('BROKEN.PAS') || []).toString('latin1');
check('F9 in the unit saves it and compiles the program', !unitNow.includes('nothing') && /USEPROG\.PAS/.test(line(1)) &&
  /^ *Compiled: \d+ lines/.test(line(29)) && /uses Broken, MyLib;/.test(screen()));

// EDIT's keys: ^L go to line, ^X cut (in a row they collect), ^V paste, ^G find next
const ctrl = (scan) => { m.keyState(0x14, true); hold(scan, 6); m.keyState(0x14, false); frames(6); };
const row = (n) => screen().split('\n')[n] || '';
const textRows = () => screen().split('\n').slice(2, 10).map(l => l.trimEnd());
hold(0x0c); frames(20); key(89); frames(20);          // F4, Y: the starter text
ctrl(0x4b); type('4\n');                               // ^L 4: begin
check('^L goes to line 4', /Ln 4 /.test(row(1)));
ctrl(0x22); ctrl(0x22);                                // ^X ^X: begin and ClrScr
check('^X ^X cuts two lines', textRows()[3].includes('WriteLn') && /Cut/.test(row(29)));
ctrl(0x4b); type('5\n');                               // ^L 5: end.
ctrl(0x2a);                                            // ^V
const t = textRows();
check('^V pastes both in front of the line', t[3].includes('WriteLn') && t[4] === 'begin' && t[5] === '  ClrScr;' && t[6] === 'end.');
ctrl(0x4b); type('1\n');                               // ^L 1
ctrl(0x2b); type('clrscr\n');                          // ^F
check('^F finds', /Ln 6 /.test(row(1)));
ctrl(0x34);                                            // ^G: no further one
check('^G: not found', /Not found: CLRSCR/.test(row(29)));

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
