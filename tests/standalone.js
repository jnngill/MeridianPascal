// Standalone .MER from the cartridge IDE: write a program in the on-device
// IDE, F7 saves it as a .MER; that file must run on a MERIDIAN without the
// cartridge, with the PASCAL cartridge inserted, and must refuse politely
// when a different cartridge occupies $40:0000.
import { buildPascalCart } from '../compiler/mkcart.js';
import { Meridian } from '../emu/meridian.js';
import { roms } from './harness.js';
import { compile } from '../compiler/compile.js';
import fs from 'node:fs';

const r = buildPascalCart();
if (!r.ok) { console.log(r.errors); process.exit(1); }
let fail = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; if (extra) console.log(extra); } };

// ---- make the .MER in the IDE
const m = new Meridian(roms);
m.insertCartridge(r.bytes);
m.startCartridge();
const frames = (n) => { for (let i = 0; i < n && m.state === 'running'; i++) m.runFrame(); };
const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(c === '\n' ? 8 : 3); } frames(30); };
const hold = (scan, n = 4) => { m.keyState(scan, true); frames(n); m.keyState(scan, false); frames(2); };
frames(60);
m.drives[1].set('GREET.PAS', Buffer.from('unit Greet;\ninterface\nfunction Hello(const n: string): string;\nimplementation\nfunction Hello;\nbegin\n  Hello := \'HELLO \' + n;\nend;\nend.\n', 'latin1'));
hold(0x0c); frames(20);                       // F4: new text
for (let i = 0; i < 7; i++) { m.pushKey(25); frames(6); }   // Ctrl+Y: remove the starter lines
frames(20);
type([
  'program Alone;',
  'uses Crt, Greet;',
  'type PNode = ^TNode; TNode = record v: integer; next: PNode; end;',
  'var p, q: PNode; i, s: integer; r: real; c: set of char;',
  'begin',
  'WriteLn(Hello(\'MER\'));',
  'p := nil; for i := 1 to 10 do begin New(q); q^.v := i; q^.next := p; p := q; end;',
  's := 0; while p <> nil do begin s := s + p^.v; q := p; p := p^.next; Dispose(q); end;',
  'r := Sqrt(2.0); c := [\'A\'..\'F\'];',
  'WriteLn(s, \' \', r:0:4, \' \', \'C\' in c, \' \', Copy(UpperCase(\'standalone\'), 1, 5), \' \', IntToStr(Round(Sin(Pi / 2) * 100)));',
  'end.', ''].join('\n'));
hold(0x02);                                   // F7
frames(150);
type('alone\n');
frames(120);
check('saved ALONE.MER', /SAVED ALONE.MER \(\d+ BYTES\)/.test(m.screenText()) && m.drives[1].has('ALONE.MER'), m.screenText());
const mer = m.drives[1].get('ALONE.MER');
if (!mer) { console.log(`${fail} failed`); process.exit(1); }
console.log(`     ALONE.MER: ${mer.length} bytes`);

const EXPECT = 'HELLO MER\n55 1.4142 TRUE STAND 100';
const runMer = (cart) => {
  const x = new Meridian(roms);
  if (cart) x.insertCartridge(cart);
  const info = x.loadMer(mer);
  x.startProgram(info.start);
  for (let i = 0; i < 600 && x.state === 'running'; i++) x.runFrame();
  return x;
};
const clean = (s) => s.replace(/\r/g, '\n').split('\n').map(l => l.trimEnd()).filter(l => l).join('\n');

let x = runMer(null);
check('runs without the cartridge', x.state === 'idle' && clean(x.output).includes(EXPECT), `${x.state} ${x.message}\n${x.output}`);
check('library is now in RAM at $40:0000', x.mem[0x400020] === 0x4d && x.mem[0x400023] === 0x53);

x = runMer(r.bytes);
check('runs with the PASCAL cartridge inserted', x.state === 'idle' && clean(x.output).includes(EXPECT), `${x.state} ${x.message}\n${x.output}`);

const other = Uint8Array.from(r.bytes);
other[0x46] ^= 0xff;                          // a different library build
x = runMer(other);
check('refuses with another cartridge inserted', /ANOTHER CARTRIDGE IS INSERTED/.test(x.output) && x.state === 'idle', `${x.state} ${x.message}\n${x.output}`);

// ---- SCHUB: Ctrl+T switches the target; F5 runs on the co-processor, F7 saves a .MER
hold(0x0c); frames(20);
if (/CLEAR IT\?/.test(m.screenText())) { m.pushKey(89); frames(20); }   // Y
for (let i = 0; i < 20; i++) { m.pushKey(25); frames(6); }
frames(20);
m.keyState(0x14, true); hold(0x2c); m.keyState(0x14, false); frames(10);
check('Ctrl+T selects SCHUB', /TARGET: SCHUB/.test(m.screenText()) && /SCHUB\s*$/m.test(m.screenText().split('\n')[28] || ''), m.screenText());
type([
  'program RV;',
  'uses Greet;',
  'var big: array[0..14999] of longint; i: longint; s: longint;',
  'begin',
  'for i := 0 to 14999 do big[i] := i;',
  's := 0; for i := 0 to 14999 do s := s + big[i];',
  'WriteLn(Hello(\'RISC-V\'), \' \', s, \' \', SizeOf(pointer));',
  'end.', ''].join('\n'));
hold(0x03); frames(400);                       // F5
check('F5 runs it on SCHUB', /HELLO RISC-V 112492500 4/.test(m.screenText()), m.screenText());
m.pushKey(32); frames(40);
hold(0x02); frames(150); type('rvmer\n'); frames(150);
check('saved RVMER.MER', /SAVED RVMER.MER/.test(m.screenText()) && m.drives[1].has('RVMER.MER'), m.screenText());
const rvmer = m.drives[1].get('RVMER.MER');
if (rvmer) {
  const x2 = new Meridian(roms);
  const info = x2.loadMer(rvmer);
  x2.startProgram(info.start);
  for (let i = 0; i < 800 && x2.state === 'running'; i++) x2.runFrame();
  check('SCHUB .MER runs without the cartridge', x2.state === 'idle' && /HELLO RISC-V 112492500 4/.test(x2.output), `${x2.state} ${x2.message}\n${x2.output}`);
  console.log(`     RVMER.MER: ${rvmer.length} bytes`);
}

// ---- Ctrl+R runs .MER files from the drive: the two made above and two from the PC compiler
const pcSrc = "program PC;\nbegin\n  WriteLn('PC BUILD ', 6 * 7);\nend.\n";
for (const t of ['m816', 'schub']) {
  const c = compile(pcSrc, 'pc.pas', { target: t, loadUnit: (n) => {
    const f = new URL(`../lib/${n.toLowerCase()}.pas`, import.meta.url);
    return fs.existsSync(f) ? { text: fs.readFileSync(f, 'latin1'), name: f.pathname } : null;
  } });
  if (!c.ok) console.log(c.errors);
  m.drives[1].set(`PC${t.toUpperCase()}.MER`, c.mer);
}
const ctrlR = (name) => {
  m.pushKey(32); frames(30);
  m.keyState(0x14, true); hold(0x2d); m.keyState(0x14, false); frames(10);
  for (let i = 0; i < 12; i++) { m.pushKey(8); frames(3); }   // clear the suggested name
  type(name + '\n');
  frames(500);
  return m.screenText();
};
let scr = ctrlR('alone');
check('Ctrl+R runs ALONE.MER (65C816, F7)', /HELLO MER/.test(scr) && /PRESS A KEY/.test(scr), scr);
scr = ctrlR('rvmer');
check('Ctrl+R runs RVMER.MER (SCHUB, F7)', /HELLO RISC-V 112492500 4/.test(scr), scr);
scr = ctrlR('pcm816');
check('Ctrl+R runs a 65C816 .MER from the PC compiler', /PC BUILD 42/.test(scr), scr);
scr = ctrlR('pcschub');
check('Ctrl+R runs a SCHUB .MER from the PC compiler', /PC BUILD 42/.test(scr), scr);
m.pushKey(32); frames(40);
check('editor is back after the runs', /PCSCHUB.MER ENDED/.test(m.screenText()) && /MERIDIAN PASCAL/.test(m.screenText()), m.screenText());
scr = ctrlR('nothere');
m.pushKey(32); frames(20);
check('a missing file is reported', /CANNOT RUN NOTHERE.MER/.test(m.screenText()), m.screenText());

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
