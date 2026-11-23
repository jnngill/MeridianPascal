// The mouse in the cartridge editor: pointer, click and drag to place the
// cursor, the wheel, clicks on the F-key names and on an error message.
// The editor uses a 640 x 240 mouse range: a character cell is 8 x 8.
import { buildPascalCart } from '../compiler/mkcart.js';
import { Meridian } from '../emu/meridian.js';
import { roms, startPascal816 } from './harness.js';

const r = buildPascalCart();
if (!r.ok) { console.log(r.errors); process.exit(1); }
let fail = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; if (extra) console.log(extra); } };

const m = new Meridian(roms);
m.insertCartridge(r.bytes);
startPascal816(m);
const frames = (n) => { for (let i = 0; i < n && m.state === 'running'; i++) m.runFrame(); };
const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(3); } frames(10); };
const hold = (scan, n = 8) => { m.keyState(scan, true); frames(n); m.keyState(scan, false); frames(2); };
const ctrl = (scan) => { m.keyState(0x14, true); hold(scan); m.keyState(0x14, false); frames(10); };
const status = () => m.screenText().split('\n')[28];
const lineCol = () => { const x = /LINE (\d+)\s+COL (\d+)/.exec(status()); return x ? [+x[1], +x[2]] : [0, 0]; };
const attr = (row, col) => m.mem[0x400 + 2 * ((row - 1) * 80 + col) + 1];
const pointerCells = () => { const a = []; for (let i = 0; i < 2400; i++) if (m.mem[0x400 + 2 * i + 1] === 0xF0) a.push(i); return a; };
// mouse to the middle of a character cell (row 1..30, col 0..79)
const moveTo = (row, col) => { m.mouse.x = col * 8 + 3; m.mouse.y = (row - 1) * 8 + 3; frames(6); };
const click = (row, col) => { moveTo(row, col); m.mouse.b = 1; frames(6); m.mouse.b = 0; frames(10); };
const load = (name, text) => {
  m.drives[1].set(name, Buffer.from(text, 'latin1'));
  hold(0x04); frames(20);
  if (/LOAD ANYWAY/.test(m.screenText())) { m.pushKey(89); frames(20); }
  type(name.replace(/\.PAS$/, '').toLowerCase() + '\n'); frames(60);
};
frames(60);

check('no pointer before the mouse moves', pointerCells().length === 0);
moveTo(6, 10);
check('the pointer shows in the cell under the mouse (black on light grey)', JSON.stringify(pointerCells()) === JSON.stringify([5 * 80 + 10]), pointerCells().join(','));
const before = attr(6, 10);
moveTo(8, 20);
check('moved on: the old cell has its colour back, one pointer', pointerCells().length === 1 && attr(6, 10) !== 0xF0 && attr(8, 21) !== 0xF0);

const lines = ['program Mouse;', 'var i: integer;', 'begin'];
for (let i = 0; i < 60; i++) lines.push(`  i := ${i}; { line ${i + 4} }`);
lines.push('end.', '');
load('MOUSE.PAS', lines.join('\n'));
click(5, 6);
check('click in the text places the cursor (row 5, col 6 = line 4, col 7)', JSON.stringify(lineCol()) === '[4,7]', status());
click(3, 70);
check('click right of the end of a line: the end of that line', JSON.stringify(lineCol()) === '[2,16]', status());
moveTo(10, 3); m.mouse.b = 1; frames(6);
moveTo(12, 9); frames(6); m.mouse.b = 0; frames(10);
check('drag: the cursor follows the pointer', JSON.stringify(lineCol()) === '[11,10]', status());

// wheel: back (towards you) = down the text, three lines a notch
const topText = () => m.screenText().split('\n')[1];
m.mouse.wheel = (m.mouse.wheel - 1) & 255; frames(20);
check('wheel one notch back: the view moves 3 lines down', topText().startsWith('  i := 0;'), topText());
m.mouse.wheel = (m.mouse.wheel - 10) & 255; frames(30);
check('ten notches: the cursor stays on the screen', /i := 30;/.test(topText()) && lineCol()[0] >= 34, topText() + '\n' + status());
// the screen must be exactly what a full redraw gives (Ctrl+K twice)
{
  frames(10);
  const a = Array.from(m.mem.subarray(0x400 + 160, 0x400 + 160 * 28));
  ctrl(0x42); ctrl(0x42); frames(20);
  const b = Array.from(m.mem.subarray(0x400 + 160, 0x400 + 160 * 28));
  let d = -1; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { d = i; break; }
  check('after the wheel the screen equals a full redraw', d < 0, `first difference at row ${2 + Math.floor(d / 160)} col ${(d % 160) >> 1}`);
}
m.mouse.wheel = (m.mouse.wheel + 20) & 255; frames(30);
check('wheel forward: back to the start', topText().startsWith('program Mouse;'), topText());

// the F-key names on the top line
const title = m.screenText().split('\n')[0];
click(1, title.indexOf('F1 HELP') + 2);
check('click on F1 HELP shows the help', /MERIDIAN PASCAL - ON THE MERIDIAN 816/.test(m.screenText()) && /MOUSE: CLICK/.test(m.screenText()));
click(15, 40);
check('a click closes the help', /program Mouse;/.test(m.screenText()) && !/THIS HELP/.test(m.screenText()));
click(1, title.indexOf('F5 RUN') + 1);
frames(300);
check('click on F5 RUN compiles and runs the program', /PRESS A KEY/.test(m.screenText()), m.screenText());
click(10, 10);
check('a click goes back to the editor', /PROGRAM ENDED/.test(m.screenText()) && /program Mouse;/.test(m.screenText()));

// an error message: click it to go back to the error
load('BAD.PAS', ['program Bad;', 'var i: integer;', 'begin', '  i := 1;', '  i := ;', 'end.', ''].join('\n'));
hold(0x01); frames(200);                                                        // F9
check('F9 reports the error', /ERROR LINE 5/.test(m.screenText()), m.screenText().split('\n')[29]);
ctrl(0x80 + 0x6c); frames(10);                                                  // Ctrl+Home
click(30, 5);
check('click on the error message: the cursor goes back to line 5', lineCol()[0] === 5, status());

// keyboard still fine with the pointer on screen; nothing left behind
moveTo(4, 2);
type('xyz');
check('typing under the pointer', /xyz/.test(m.screenText()) && pointerCells().length === 1);

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
