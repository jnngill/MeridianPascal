// Crash protection in the cartridge editor, in both editors (the 65C816
// editor and the SCHUB editor): a program hangs, the machine is reset; the
// editor finds the unsaved text in expansion RAM (which a real reset leaves
// alone) and offers it back. The emulator's reset clears all memory, so a
// "reset" here is a new machine with the old expansion RAM ($20:0000-$3F:FFFF).
import { buildPascalCart } from '../compiler/mkcart.js';
import { Meridian } from '../emu/meridian.js';
import { roms } from './harness.js';

const cart = buildPascalCart();
if (!cart.ok) { console.log(cart.errors); process.exit(1); }
let fail = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; if (extra) console.log(extra); } };

const TT = 3;
const STARTER = ['program Hello;', 'uses Crt;', '', 'begin', '  ClrScr;', "  WriteLn('HELLO FROM THE MERIDIAN!');", 'end.'];
const HANG = ['program Hang;', 'begin', 'while true do ;', 'end.'];
const SCRIBBLE = ['program Wild;', 'begin', 'Mem[$200003] := 0;', 'while true do ;', 'end.'];

function editor(schub, expansion, drives) {
  const m = new Meridian(roms);
  m.insertCartridge(cart.bytes);
  if (expansion) m.mem.set(expansion, 0x200000);
  if (drives) m.drives = drives;
  const frames = (n) => { for (let i = 0; i < n && m.state === 'running'; i++) m.runFrame(); };
  if (!schub) m.keyState(0x14, true);          // Ctrl held at the start: the 65C816 editor
  m.startCartridge();
  m.runFrame();
  m.keyState(0x14, false);
  frames(schub ? 120 : 60);
  return { m, frames };
}

function session(schub) {
  const who = schub ? 'SCHUB editor' : '65C816 editor';
  let { m, frames } = editor(schub);
  const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(c === '\n' ? 8 : 3); } frames(30); };
  const key = (code, n = 1) => { for (let i = 0; i < n; i++) { m.pushKey(code); frames(4); } frames(10); };
  const hold = (scan, n = 6) => { m.keyState(scan, true); frames(n); m.keyState(scan, false); frames(4); };
  const row = (n) => (m.screenText().split('\n')[n] || '').trimEnd();
  const text = (n) => m.screenText().split('\n').slice(TT - 1, TT - 1 + n).map(l => l.trimEnd());
  const msg = () => row(29).trim();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const t = (what, cond) => check(`${who}: ${what}`, cond && m.state === 'running' && !m.schubFault, m.screenText() + (m.schubFault ? `\n${m.schubFault}` : ''));
  const newText = () => { hold(0x0c); frames(20); if (/Clear it\?/.test(m.screenText())) { m.pushKey(89); frames(30); } m.keyState(0x14, true); hold(0x1c); m.keyState(0x14, false); frames(10); key(127); frames(20); };   // F4, ^A, Delete
  // F5, the program hangs; then the reset
  const runAndReset = () => {
    hold(0x03); frames(400);
    const hung = !/PASCAL +F1 help/.test(row(0));
    const exp = m.mem.slice(0x200000, 0x400000);
    ({ m, frames } = editor(schub, exp, m.drives));
    return hung;
  };

  // an unsaved program that hangs: the reset offers it back
  newText();
  type(HANG.join('\n'));
  let hung = runAndReset();
  t('the program hangs (the editor is gone)', hung);
  t('after the reset: the editor asks', /Unsaved text from before the restart: a new text, 4\d bytes\. Recover it\? \(Y\/N\)/.test(row(29)));
  m.pushKey(89); frames(40);
  t('Y: the text is back, unsaved', same(text(4), HANG) && /Recovered/.test(msg()) && /\(new\) +drive 1 +\*/.test(row(1)));

  // saved first: nothing to offer
  hold(0x06); frames(10); type('hang\n'); frames(60);
  t('saved as HANG.PAS', /Saved HANG.PAS/.test(msg()) && m.drives[1].has('HANG.PAS'));
  hung = runAndReset();
  t('a saved text: after the reset no question, the starter text', hung && same(text(7), STARTER) && !/Recover/.test(m.screenText()));

  // an opened file, changed, a program that writes into the text and hangs
  hold(0x04); frames(20); type('hang\n'); frames(60);
  key(0x1f); key(0x1f); key(0x01);               // line 3
  newText();
  type(SCRIBBLE.join('\n'));
  hold(0x06); frames(10); for (let i = 0; i < 12; i++) { m.pushKey(8); frames(3); } type('wild\n'); frames(60);
  key(0x1e, 4); key(0x01); type('{ changed }');
  hung = runAndReset();
  t('the program wrote into the text: the question says it is damaged', hung && /WILD\.PAS, \d+ bytes, damaged\. Recover it\?/.test(row(29)));
  m.pushKey(89); frames(40);
  t('Y: recovered with a warning, under its name (with the byte the program wrote)', /1 byte looks damaged/.test(msg()) && /WILD\.PAS +drive 1 +\*/.test(row(1)) && row(TT - 1) === '{ c\0anged }program Wild;');

  // N: the starter text, and the next reset asks no more
  hung = runAndReset();
  t('asked again after another reset', /Recover it\?/.test(row(29)));
  m.pushKey(78); frames(40);
  t('N: the starter text', same(text(7), STARTER));
  ({ m, frames } = editor(schub, m.mem.slice(0x200000, 0x400000), m.drives));
  t('then a reset asks nothing', !/Recover/.test(m.screenText()) && same(text(7), STARTER));

  // F10 on purpose (leave anyway): nothing to offer
  type('x');
  hold(0x09); frames(20);
  if (/Leave anyway\?/.test(m.screenText())) { m.pushKey(89); frames(60); }
  check(`${who}: F10 leaves the editor`, !/PASCAL +F1 help/.test(row(0)), m.screenText());
  ({ m, frames } = editor(schub, m.mem.slice(0x200000, 0x400000), m.drives));
  t('after leaving with F10 the editor starts fresh', !/Recover/.test(m.screenText()) && same(text(7), STARTER));
}

session(false);
session(true);
console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
