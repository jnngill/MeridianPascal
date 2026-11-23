// Syntax colours in the cartridge editor: the colour byte of each character
// on the text screen ($0400, 2 bytes per character: code, colour).
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
frames(60);

// screen row (1-based) as text, and the text colour (low nibble) of each column
const rowText = (row) => { let s = ''; for (let c = 0; c < 80; c++) s += String.fromCharCode(m.mem[0x400 + 2 * ((row - 1) * 80 + c)]); return s; };
const rowCol = (row) => { const a = []; for (let c = 0; c < 80; c++) a.push(m.mem[0x400 + 2 * ((row - 1) * 80 + c) + 1] & 15); return a; };
const rowOf = (needle) => { for (let row = 2; row <= 28; row++) if (rowText(row).includes(needle)) return row; return -1; };
// colour of the text `word` in the row that contains `needle` (every character must agree)
function colourOf(needle, word = needle) {
  const row = rowOf(needle);
  if (row < 0) return `no row with ${needle}`;
  const t = rowText(row), at = t.indexOf(word, t.indexOf(needle) >= 0 && word !== needle ? 0 : 0);
  // the text cursor swaps the colours of its cell (background no longer blue): leave it out
  const cols = rowCol(row).slice(at, at + word.length).filter((c, i) => (m.mem[0x400 + 2 * ((row - 1) * 80 + at + i) + 1] >> 4) === 6);
  return cols.every(c => c === cols[0]) ? cols[0] : `mixed ${cols.join(',')}`;
}
const K = 1, NAME = 14, COMMENT = 13, STRING = 7, NUMBER = 3, DIRECTIVE = 8;

const load = (name, text) => {
  m.drives[1].set(name, Buffer.from(text, 'latin1'));
  hold(0x04); frames(20);
  if (/LOAD ANYWAY/.test(m.screenText())) { m.pushKey(89); frames(20); }
  type(name.replace(/\.PAS$/, '').toLowerCase() + '\n'); frames(60);
};

load('COL.PAS', [
  '{$SCHUB}',
  'program Colours;',
  'const Big = 12345; Hx = $1F; Cr = #13; Pi2 = 6.28;',
  'var s: string;',
  'begin',
  "  s := 'it''s { not a comment }';",
  '  { a brace comment }',
  '  (* a comment',
  '     over two lines *)',
  '  WriteLn(s); // to the end of the line',
  'end.', ''].join('\n'));

check('directive {$SCHUB} in orange', colourOf('{$SCHUB}') === DIRECTIVE, rowCol(2).slice(0, 8).join(','));
check('keywords in white (program, const, begin, end)', colourOf('program Colours', 'program') === K && colourOf('const Big', 'const') === K
  && colourOf('begin') === K && colourOf('end.', 'end') === K);
check('names in light blue (Colours, WriteLn)', colourOf('program Colours', 'Colours') === NAME && colourOf('WriteLn(s)', 'WriteLn') === NAME);
check('numbers in turquoise (12345, $1F, 6.28)', colourOf('Big = 12345', '12345') === NUMBER && colourOf('$1F') === NUMBER && colourOf('6.28') === NUMBER);
check('character codes like strings (#13)', colourOf('#13') === STRING);
check("strings in yellow, with '' and { } inside", colourOf("'it''s { not a comment }'") === STRING);
check('brace comment in green', colourOf('{ a brace comment }') === COMMENT);
check('(* *) comment over two lines in green', colourOf('(* a comment') === COMMENT && colourOf('over two lines *)') === COMMENT);
check('// comment to the end of the line', colourOf('// to the end of the line') === COMMENT && colourOf('WriteLn(s); //', 'WriteLn') === NAME);
check('after the comments: normal again', colourOf('end.', 'end') === K);

// typing { at the start of the "begin" line: everything below up to the next } turns green
const beginRow = rowOf('begin');
for (let i = 0; i < 40 && rowOf('begin') >= 0; i++) { m.pushKey(30); frames(3); }   // cursor up to the top
for (let i = 0; i < beginRow - 2; i++) { m.pushKey(31); frames(3); }                // down to "begin"
m.pushKey(1); frames(5);                                                           // Home
type('{');
check('typing { colours the rows below as comment', colourOf('{begin', 'begin') === COMMENT && colourOf("  s := '", 's :=') === COMMENT
  && colourOf('{ a brace comment }', 'a brace') === COMMENT, `${rowText(beginRow)}\n${rowCol(beginRow + 1).join(',')}`);
check('... up to the first }', colourOf('(* a comment') === COMMENT && colourOf('end.', 'end') === K);
m.pushKey(8); frames(10);                                                          // Backspace
check('deleting it colours them back', colourOf('begin') === K && colourOf("'it''s { not a comment }'") === STRING);

ctrl(0x42);                                                                        // Ctrl+K
check('Ctrl+K: all light blue', colourOf('begin') === NAME && colourOf('{ a brace comment }') === NAME && /COLOURS OFF/.test(m.screenText()));
ctrl(0x42);
check('Ctrl+K again: colours back', colourOf('begin') === K && /COLOURS ON/.test(m.screenText()));

// a long text: a comment opened 3 KB above the screen must still colour it
const filler = [];
for (let i = 0; i < 120; i++) filler.push(`  x${i} := x${i} + ${i};`);
const far = ['program Far;', 'var x: integer;', '(* starts here', ...filler, 'still inside the comment *)', 'begin', '  x := 1;', 'end.', ''].join('\n');
load('FAR.PAS', far);
ctrl(0x80 + 0x69);                                                                  // Ctrl+End
frames(30);
check(`far text (${far.length} bytes): comment begun far above the screen still green`,
  colourOf('x119 := x119', 'x119') === COMMENT && colourOf('still inside the comment *)') === COMMENT && colourOf('begin') === K,
  `${rowText(rowOf('x119'))}\n${rowCol(rowOf('x119')).join(',')}`);
// an edit at the top changes the colours far below: close the comment early
ctrl(0x80 + 0x6c);                                                                  // Ctrl+Home
m.pushKey(31); m.pushKey(31); frames(6); m.pushKey(1); frames(4);                  // to "(* starts here"
type('(* *)');                                                                     // now "(* *)(* starts here": still a comment
m.pushKey(1); frames(4);
type('// ');                                                                       // "// (* *)(* ...": the comment is gone
ctrl(0x80 + 0x69);
frames(30);
check('an edit at the top changes the colours at the end (checkpoints renewed)', colourOf('x119 := x119', 'x119') === NAME
  && colourOf('still inside the comment *)', 'still') === NAME, `${rowText(rowOf('x119'))}\n${rowCol(rowOf('x119')).join(',')}`);

// a long line scrolled sideways: the colours move with the text
load('WIDE.PAS', ['program Wide;', 'begin', ' '.repeat(100) + "WriteLn('far right'); { comment } end;", 'end.', ''].join('\n'));
m.pushKey(31); m.pushKey(31); frames(8);                                            // to the long line
hold(0x80 + 0x69); frames(20);                                                      // End: scrolls sideways
check('long line scrolled sideways: string, comment and keyword coloured in place',
  colourOf("'far right'") === STRING && colourOf('{ comment }') === COMMENT && colourOf('WriteLn(', 'WriteLn') === NAME,
  rowText(rowOf('far right')) + '\n' + rowCol(rowOf('far right')).join(','));

// ---- scrolling by moving screen rows, and several keys handled at once:
// after each step the screen must be exactly what a full redraw gives
// (Ctrl+K twice redraws everything)
const screenBytes = () => Array.from(m.mem.subarray(0x400 + 160, 0x400 + 160 * 28));
const cursorCell = () => { const b = screenBytes(); for (let i = 1; i < b.length; i += 2) if ((b[i] >> 4) !== 6) return i; return -1; };
function sameAsFullRedraw(what) {
  frames(20);
  const a = screenBytes();
  ctrl(0x42); ctrl(0x42); frames(20);
  const b = screenBytes();
  const diff = []; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
  check(`${what}: screen equals a full redraw`, diff.length === 0,
    diff.slice(0, 6).map(i => `row ${2 + Math.floor(i / 160)} col ${(i % 160) >> 1}: ${a[i]} vs ${b[i]}`).join('\n'));
}
const lines = ['program Scroll;', '(* a comment', '   over lines *)', 'var i: integer;'];
for (let i = 0; i < 70; i++) lines.push(i % 9 === 4 ? `  { comment ${i} }` : i % 9 === 6 ? `  (* opens ${i}` : i % 9 === 7 ? `     closes ${i} *)` : `  i := ${i}; WriteLn('line ${i}');`);
lines.push('end.', '');
load('SCROLL.PAS', lines.join('\n'));
const push = (code, n) => { for (let i = 0; i < n; i++) m.pushKey(code); frames(30); };
for (let i = 0; i < 26; i++) { m.pushKey(31); frames(3); }                         // to the bottom row
push(31, 1);  sameAsFullRedraw('scroll down 1 line');
push(31, 7);  sameAsFullRedraw('7 cursor-downs at once (scroll 7)');
push(30, 30); sameAsFullRedraw('30 cursor-ups at once (scroll up)');
push(30, 1);  sameAsFullRedraw('scroll up 1 line');
push(31, 40); sameAsFullRedraw('40 cursor-downs at once (more than a screen)');
ctrl(0x80 + 0x6c);                                                                  // Ctrl+Home
hold(0x80 + 0x7a); frames(10); hold(0x80 + 0x7a); frames(10);                        // PgDn twice
sameAsFullRedraw('page down twice');
hold(0x80 + 0x7d); frames(10);                                                      // PgUp
sameAsFullRedraw('page up (state at the top from the checkpoints)');
hold(0x80 + 0x7a); frames(10); push(31, 3);
// edits on three lines in one batch: a, down, b, down, c
for (const c of 'a') m.pushKey(c.charCodeAt(0)); m.pushKey(31); m.pushKey(98); m.pushKey(31); m.pushKey(99);
frames(30);
sameAsFullRedraw('edits on three lines handled at once');
// { typed and the cursor moved down in the same batch: the rows below turn green
m.pushKey(1); m.pushKey(123); m.pushKey(31); m.pushKey(31); frames(30);
sameAsFullRedraw('{ typed, then two cursor-downs at once');
m.pushKey(30); m.pushKey(30); m.pushKey(1); m.pushKey(127); m.pushKey(31); frames(30);   // delete it again
sameAsFullRedraw('{ deleted, then a cursor-down at once');

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
