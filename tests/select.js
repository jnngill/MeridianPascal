// Selections in the cartridge editor, in both editors (the 65C816 editor and
// the SCHUB editor): Shift+cursor keys, a mouse drag, ^A and a find select;
// ^C ^X ^V, typing, Backspace and Delete work on the selection; ^Z takes an
// edit over a selection back in one step.
import { buildPascalCart } from '../compiler/mkcart.js';
import { Meridian } from '../emu/meridian.js';
import { roms, startPascal816 } from './harness.js';
import { HELP_LINES } from '../compiler/helptext.js';

const cart = buildPascalCart();
if (!cart.ok) { console.log(cart.errors); process.exit(1); }
let fail = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; if (extra) console.log(extra); } };

const STARTER = ['program Hello;', 'uses Crt;', '', 'begin', '  ClrScr;', "  WriteLn('HELLO FROM THE MERIDIAN!');", 'end.'];
const TT = 3;                                   // the first text row on screen (1-based)
const SEL = 0xc1;                               // the selection's colour

function session(schub) {
  const who = schub ? 'SCHUB editor' : '65C816 editor';
  const m = new Meridian(roms);
  m.insertCartridge(cart.bytes);
  if (schub) m.startCartridge(); else startPascal816(m);
  const frames = (n) => { for (let i = 0; i < n && m.state === 'running'; i++) m.runFrame(); };
  const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(c === '\n' ? 8 : 3); } frames(30); };
  const key = (code, n = 1) => { for (let i = 0; i < n; i++) { m.pushKey(code); frames(4); } frames(10); };
  const hold = (scan, n = 6) => { m.keyState(scan, true); frames(n); m.keyState(scan, false); frames(4); };
  const ctrl = (scan) => { m.keyState(0x14, true); hold(scan); m.keyState(0x14, false); frames(10); };
  const shift = (f) => { m.keyState(0x12, true); frames(2); f(); m.keyState(0x12, false); frames(10); };
  const goLine = (n) => { ctrl(0x4b); type(`${n}\n`); };
  const row = (n) => (m.screenText().split('\n')[n] || '').trimEnd();
  const text = (n = 7) => m.screenText().split('\n').slice(TT - 1, TT - 1 + n).map(l => l.trimEnd());
  const msg = () => row(29).trim();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // the columns of text line `line` (1-based, as on screen) drawn in the selection's colour;
  // a selected line end is one more column, the cursor's cell is drawn inverted instead
  const selCols = (line) => {
    const r = TT + line - 1, out = [];
    for (let c = 0; c < 80; c++) if (m.mem[0x0400 + ((r - 1) * 80 + c) * 2 + 1] === SEL) out.push(c);
    return out.length ? `${out[0]}-${out[out.length - 1]}` : '';
  };
  const ok = () => m.state === 'running' && !m.schubFault;
  const t = (what, cond) => check(`${who}: ${what}`, cond && ok(), m.screenText() + (m.schubFault ? `\n${m.schubFault}` : ''));
  const undo = () => { ctrl(0x1a); frames(20); };

  frames(schub ? 120 : 60);

  // Shift+Right: part of a line; ^C copies it, ^V puts it in at the cursor
  goLine(6); key(0x01);
  shift(() => key(28, 9));
  t('Shift+Right selects "  WriteLn" (drawn in the selection colour)', selCols(6) === '0-8' && /Ln 6 +Col 10/.test(row(1)));
  ctrl(0x21);
  t('^C copies the selection', /Copied/.test(msg()) && selCols(6) === '0-8');
  key(0x1f);                                    // down, no Shift: the selection ends
  t('a cursor key without Shift ends the selection', selCols(6) === '' && selCols(7) === '');
  key(0x01); ctrl(0x2a);                        // Home, ^V
  t('^V puts the copied part in at the cursor', row(TT - 1 + 6) === '  WriteLnend.' && /Ln 7 +Col 10/.test(row(1)));
  undo();
  t('^Z takes the paste back', same(text(), STARTER));

  // Shift+Down over two lines, typing replaces them; one ^Z
  goLine(4); key(0x01);
  shift(() => key(31, 2));
  t('Shift+Down selects whole lines', selCols(4) === '0-5' && selCols(5) === '0-9');
  type('X');
  t('typing replaces the selection', same(text(5), ['program Hello;', 'uses Crt;', '', `X  WriteLn('HELLO FROM THE MERIDIAN!');`, 'end.']));
  type('YZ');
  undo();
  t('one ^Z brings the lines back and takes the typing away', same(text(), STARTER) && /nothing more to undo/.test(msg()));

  // Shift+End, Backspace
  goLine(1);
  shift(() => hold(0x80 + 0x69));
  t('Shift+End selects to the end of the line', selCols(1) === '0-13');
  key(8);
  t('Backspace deletes just the selection', row(TT - 1) === '' && row(TT) === 'uses Crt;');
  undo();
  t('^Z brings it back', same(text(), STARTER));

  // Shift+Left from the end, Delete
  goLine(1); hold(0x80 + 0x69);
  shift(() => key(29, 6));
  t('Shift+Left selects backwards ("Hello;", the cursor cell inverted)', selCols(1) === '9-13');
  key(127);
  t('Delete deletes the selection', row(TT - 1) === 'program');
  undo();

  // ^X a selection over a line end and ^V it somewhere else
  goLine(2); key(0x01);
  shift(() => key(31));
  ctrl(0x22);
  t('^X cuts the selection', same(text(3), ['program Hello;', '', 'begin']) && /Cut/.test(msg()));
  goLine(6); ctrl(0x2a);
  t('^V puts it in at the cursor', same(text(), ['program Hello;', '', 'begin', '  ClrScr;', "  WriteLn('HELLO FROM THE MERIDIAN!');", 'uses Crt;', 'end.']));
  undo(); undo();
  t('^Z ^Z: as before', same(text(), STARTER));
  // whole lines still work as in EDIT without a selection
  goLine(2); ctrl(0x21); goLine(4); ctrl(0x2a);
  t('without a selection ^C ^V copy whole lines', row(TT - 1 + 3) === 'uses Crt;' && row(TT - 1 + 4) === 'begin');
  undo();

  // ^A, Delete; ^Z
  ctrl(0x1c);
  t('^A selects all', selCols(1) === '0-14' && selCols(7) === '0-4');
  key(127);
  t('Delete then clears the text', /  0 bytes/.test(row(1)) && row(TT - 1) === '');
  undo();
  t('^Z brings all of it back', same(text(), STARTER));

  // a find selects what it found: typing replaces it
  goLine(1);
  ctrl(0x2b); type('hello\n');
  t('^F selects what it finds', selCols(1) === '9-12' && selCols(6) === '');
  type('World');
  t('typing replaces the found text', row(TT - 1) === 'program World;');
  undo();
  t('^Z: the found text is back', row(TT - 1) === 'program Hello;');

  // ^H: replace, asking at each place (N, Y), all (A), Esc; one ^Z each time
  const replace = (what, by, answers) => {
    goLine(1);
    ctrl(0x33);
    key(8, 12); type(what + '\n');
    key(8, 12); type(by + '\n');
    for (const a of answers) { frames(40); type(a); }
    frames(40);
  };
  const BYE = "  WriteLn('Bye FROM THE MERIDIAN!');";
  replace('hello', 'Bye', ['n', 'y']);
  t('^H with N then Y replaces the second place only', row(TT - 1) === 'program Hello;' && row(TT - 1 + 5) === BYE && /Replaced 1 time/.test(msg()));
  t('^H is not taken as a Backspace', same(text().filter((l, i) => i !== 5), STARTER.filter((l, i) => i !== 5)));
  undo();
  t('^Z takes it back', same(text(), STARTER));
  replace('hello', 'Bye', ['a']);
  t('A replaces all of them', row(TT - 1) === 'program Bye;' && row(TT - 1 + 5) === BYE && /Replaced 2 times/.test(msg()));
  undo();
  t('one ^Z takes all of them back', same(text(), STARTER) && /nothing more to undo/.test(msg()));
  replace('hello', 'Bye', ['\x1b']);
  t('Esc stops: nothing replaced', same(text(), STARTER) && /Replaced 0 times/.test(msg()));
  replace('nowhere', 'x', []);
  t('nothing to replace: not found', /Not found: NOWHERE/.test(msg()) && same(text(), STARTER));

  // the mouse: dragging selects, a click ends it
  const at = (r, c) => { m.mouse.x = c * 8 + 3; m.mouse.y = (r - 1) * 8 + 3; frames(8); };
  at(TT, 0); m.mouse.b = 1; frames(8);
  at(TT, 7); frames(8); m.mouse.b = 0; frames(15);
  t('a mouse drag selects ("program")', selCols(1) === '0-6');
  at(TT + 1, 2); m.mouse.b = 1; frames(8); m.mouse.b = 0; frames(15);
  t('a click ends the selection', selCols(1) === '' && /Ln 2 +Col 3/.test(row(1)));
  at(TT + 4, 2); m.mouse.b = 1; frames(8);
  at(TT + 6, 3); frames(8); m.mouse.b = 0; frames(15);
  t('a drag over lines selects across them', selCols(5) === '2-9' && selCols(6) === '0-38' && selCols(7) === '0-2');
  ctrl(0x22);
  t('^X cuts what the mouse selected', same(text(5), ['program Hello;', 'uses Crt;', '', 'begin', '  .']));
  undo();
  t('^Z brings it back', same(text(), STARTER));

  // Tab / Shift+Tab: indent the selected lines, one ^Z each
  goLine(4); key(0x01);
  shift(() => key(31, 2));                      // lines 4 and 5 (ends at the start of 6)
  key(9);
  t('Tab indents the selected lines by two', same(text(), ['program Hello;', 'uses Crt;', '', '  begin', '    ClrScr;', STARTER[5], 'end.'])
    && selCols(4) === '0-7' && selCols(6) === '');
  key(9);
  t('Tab again: two more, still selected', row(TT - 1 + 3) === '    begin' && row(TT - 1 + 4) === '      ClrScr;' && selCols(4) === '0-9');
  shift(() => key(9));
  t('Shift+Tab takes two away', row(TT - 1 + 3) === '  begin' && row(TT - 1 + 4) === '    ClrScr;');
  undo();
  t('^Z takes back the Shift+Tab in one step', row(TT - 1 + 3) === '    begin' && row(TT - 1 + 4) === '      ClrScr;');
  undo(); undo();
  t('^Z ^Z: as before', same(text(), STARTER));
  // the empty line 3 is left alone; Shift+Tab where there are no spaces does nothing
  goLine(2); key(0x01);
  shift(() => key(31, 2));
  key(9);
  t('Tab leaves an empty line empty', row(TT - 1 + 1) === '  uses Crt;' && row(TT - 1 + 2) === '');
  undo();
  goLine(1); shift(() => key(9));
  t('Shift+Tab on a line without spaces changes nothing', same(text(), STARTER));
  // without a selection: Tab puts in two spaces, Shift+Tab takes the line's indent back
  goLine(6); key(0x01); key(28, 9);             // after "  WriteLn"
  shift(() => key(9));
  t('Shift+Tab without a selection: the line two less, the cursor stays on its character',
    row(TT - 1 + 5) === "WriteLn('HELLO FROM THE MERIDIAN!');" && /Ln 6 +Col 8/.test(row(1)));
  key(9);
  t('Tab without a selection: two spaces at the cursor', row(TT - 1 + 5) === "WriteLn  ('HELLO FROM THE MERIDIAN!');");
  undo(); undo();
  t('^Z ^Z: as before', same(text(), STARTER));

  // F1: the help screen, its lines from the cartridge ROM (compiler/helptext.js)
  hold(0x05); frames(40);
  const shown = m.screenText().split('\n').slice(TT + 1, TT + 1 + HELP_LINES.length).map(l => l.slice(1).trimEnd());
  t('F1: the title and every help line from the ROM', same(shown, HELP_LINES) &&
    (schub ? /the editor on SCHUB/ : /on the MERIDIAN 816/).test(row(TT - 1)));
  key(32); frames(30);
  t('a key closes the help', same(text(), STARTER));
}

session(false);
session(true);
console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
