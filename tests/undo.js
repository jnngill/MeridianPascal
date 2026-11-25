// Ctrl+Z in the cartridge editor, in both editors (the 65C816 editor and
// the SCHUB editor): typing, Backspace and Delete in a row, new lines, cut,
// paste and deleted lines come back; a full undo log drops its oldest edits.
import { buildPascalCart } from '../compiler/mkcart.js';
import { Meridian } from '../emu/meridian.js';
import { roms, startPascal816 } from './harness.js';

const cart = buildPascalCart();
if (!cart.ok) { console.log(cart.errors); process.exit(1); }
let fail = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; if (extra) console.log(extra); } };

const TB = 0x200000;
const STARTER = ['program Hello;', 'uses Crt;', '', 'begin', '  ClrScr;', "  WriteLn('HELLO FROM THE MERIDIAN!');", 'end.'];

function session(schub) {
  const who = schub ? 'SCHUB editor' : '65C816 editor';
  const m = new Meridian(roms);
  m.insertCartridge(cart.bytes);
  if (schub) m.startCartridge(); else startPascal816(m);
  const frames = (n) => { for (let i = 0; i < n && m.state === 'running'; i++) m.runFrame(); };
  const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(c === '\n' ? 8 : 3); } frames(30); };
  const key = (code, n = 1) => { for (let i = 0; i < n; i++) { m.pushKey(code); frames(4); } frames(10); };
  const hold = (scan, n = 6) => { m.keyState(scan, true); frames(n); m.keyState(scan, false); frames(4); };
  const ctrl = (scan) => { m.keyState(0x14, true); hold(scan); m.keyState(0x14, false); frames(8); };
  const undo = () => { ctrl(0x1a); frames(20); };
  const goLine = (n) => { ctrl(0x4b); type(`${n}\n`); };
  const row = (n) => (m.screenText().split('\n')[n] || '').trimEnd();
  const text = (n = 7) => m.screenText().split('\n').slice(2, 2 + n).map(l => l.trimEnd());
  const msg = () => row(29).trim();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ok = () => m.state === 'running' && !m.schubFault;
  const t = (what, cond) => check(`${who}: ${what}`, cond && ok(), m.screenText() + (m.schubFault ? `\n${m.schubFault}` : ''));

  frames(schub ? 120 : 60);
  if (schub) t('runs on SCHUB', m.rv.running);
  undo();
  t('^Z with nothing to undo says so', /Nothing to undo/.test(msg()));

  // ^X ^X cuts two lines in a row (one edit, as they collect), then a cut
  // on its own and a paste: three edits, three ^Z
  goLine(4);
  ctrl(0x22); ctrl(0x22);                         // ^X ^X: begin, ClrScr
  goLine(1); ctrl(0x22);                          // ^X: program Hello;
  goLine(4); ctrl(0x2a);                          // ^V in front of end.
  undo();
  t('^Z takes back the paste', same(text(4), [STARTER[1], STARTER[2], STARTER[5], 'end.']));
  undo();
  t('^Z brings back the line cut on its own', same(text(5), [STARTER[0], STARTER[1], STARTER[2], STARTER[5], 'end.']));
  undo();
  t('^Z brings back both lines cut in a row at once', same(text(), STARTER) && /nothing more to undo/.test(msg()));

  // typing in a row is one edit, Backspace in a row another
  goLine(1);
  type('abc ');
  key(8, 2);
  t('typed and rubbed out', row(2) === 'abprogram Hello;');
  undo();
  t('^Z brings back what Backspace took', row(2) === 'abc program Hello;');
  undo();
  t('^Z takes back the typing', row(2) === 'program Hello;');

  // Delete in a row
  goLine(1);
  key(127, 3);
  undo();
  t('^Z brings back three Deletes, the cursor stays', row(2) === 'program Hello;' && /Ln 1 +Col 1/.test(row(1)));

  // a new line ends the typing that came before it
  goLine(3);
  type('xy\nzw');
  t('typed two lines', same(text(5).slice(2), ['xy', 'zw', 'begin']));
  undo();
  t('^Z takes back the second line\'s typing', same(text(5).slice(2), ['xy', '', 'begin']));
  undo();
  t('^Z takes back the new line', same(text(4).slice(2), ['xy', 'begin']));
  undo();
  t('^Z takes back the first line\'s typing', same(text(), STARTER));

  // ^Y
  goLine(6);
  ctrl(0x35);
  undo();
  t('^Z brings back a line deleted with ^Y', same(text(), STARTER) && /Ln 6 /.test(row(1)));

  // a full log: a long line cut and pasted again and again (20 000 bytes
  // each cut); the log holds 64 000 bytes, so the first cut is dropped
  const A = Array.from({ length: 20000 }, (_, i) => String.fromCharCode(97 + (i * 7 + (i >> 5)) % 26)).join('');
  const REST = 'program Long;\nbegin\nend.\n';
  m.drives[1].set('LONG.PAS', Buffer.from(A + '\n' + REST, 'latin1'));
  ctrl(0x42); frames(20);                          // ^K: colours off
  hold(0x04); frames(20);
  if (/Open another anyway/.test(m.screenText())) { m.pushKey(89); frames(20); }
  type('long\n');
  for (let i = 0; i < 3000 && m.state === 'running' && !/Opened LONG/.test(msg()); i++) frames(1);
  t('opened a text with a 20 000-byte line', /Opened LONG.PAS/.test(msg()));
  const buf = (n) => Buffer.from(m.mem.slice(TB, TB + n)).toString('latin1');
  const until = (f) => { for (let i = 0; i < 3000 && m.state === 'running' && !f(); i++) frames(1); frames(10); };
  // with a 20 000-character line a pass of the editor's loop takes many
  // frames: hold the key until the editor has seen it (its table of handled
  // keys at $3C:0000), then let go at once (held longer it would repeat)
  const press = (scan, f) => {
    m.mem[0x3c0000 + scan] = 0;
    m.keyState(0x14, true); m.keyState(scan, true);
    for (let i = 0; i < 3000 && m.state === 'running' && !m.mem[0x3c0000 + scan]; i++) frames(1);
    m.keyState(scan, false); frames(1); m.keyState(0x14, false);
    until(f);
  };
  const LONG = A + '\n' + REST;
  for (let i = 0; i < 4; i++) {
    press(0x22, () => buf(REST.length) === REST && /Cut/.test(msg()));               // ^X the long line
    if (i < 3) {                                                                      // ^V it back, up onto it
      press(0x2a, () => buf(LONG.length) === LONG && /Ln 2 /.test(row(1)));
      key(0x1e); until(() => /Ln 1 /.test(row(1)));
    }
  }
  t('four cuts and three pastes of a 20 000-byte line', buf(REST.length) === REST);
  let all = true, steps = 0;
  for (; steps < 8; steps++) {
    const want = steps % 2 === 0 ? LONG : REST;
    press(0x1a, () => buf(want.length) === want);
    frames(30);
    if (buf(want.length) !== want || !/Undone/.test(msg())) { all = false; break; }
    if (/nothing more to undo/.test(msg())) break;
  }
  t(`^Z goes back through the edits the log kept, byte for byte (${steps + 1} steps)`, all && steps === 5 && /nothing more to undo/.test(msg()));
  press(0x1a, () => /Nothing to undo/.test(msg()));
  t('the first cut is gone from the full log', /Nothing to undo/.test(msg()) && buf(REST.length) === REST);

  // F4: a new text has nothing to undo
  type('q');
  hold(0x0c); frames(20);
  if (/Clear it\?/.test(m.screenText())) { m.pushKey(89); frames(20); }
  undo();
  t('a new text (F4) has nothing to undo', /Nothing to undo/.test(msg()) && same(text(), STARTER));
}

session(false);
session(true);
console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
