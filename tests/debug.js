// Debugging in the PASCAL cartridge editor: after F5, a runtime error is
// shown with its line (and the cursor goes there), in both editors (65C816
// and SCHUB) for both targets.
import { buildPascalCart } from '../compiler/mkcart.js';
import { Meridian } from '../emu/meridian.js';
import { roms, startPascal816 } from './harness.js';

const cart = buildPascalCart();
if (!cart.ok) { console.log(cart.errors); process.exit(1); }
let fail = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; if (extra) console.log(extra); } };

// line 5: i := 2; line 6: WriteLn; the case's lines from 7 (8 with $SCHUB on top)
const prog = (schub, body) => `${schub ? '{$SCHUB}\n' : ''}program E;\nvar a: array[1..3] of integer;\n    i: integer;\nbegin\n  i := 2;\n  WriteLn('START');\n${body}\n  WriteLn('END');\nend.\n`;
const cases = [
  ['ENDS', '  i := i + 1;', /^PROGRAM ENDED\.$/, 0],
  ['DIV0', '  i := 0;\n  i := 10 div i;', /^RUNTIME ERROR 200 AT LINE (\d+)$/, 8],
  ['RANGE', '{$R+}\n  i := 4;\n  a[i] := 1;', /^RUNTIME ERROR 201 AT LINE (\d+)$/, 9],
  ['HALT', '  Halt;', /^PROGRAM ENDED\.$/, 0],
  ['NOLINES', '{$D-}\n  i := 0;\n  i := 10 div i;', /^RUNTIME ERROR 200$/, 0],
];

for (const ed of ['65C816', 'SCHUB']) {
  for (const schub of [false, true]) {
    const m = new Meridian(roms);
    m.insertCartridge(cart.bytes);
    if (ed === '65C816') startPascal816(m); else m.startCartridge();
    const frames = (k) => { for (let i = 0; i < k && m.state === 'running'; i++) m.runFrame(); };
    const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(3); } frames(10); };
    const hold = (scan, k = 8) => { m.keyState(scan, true); frames(k); m.keyState(scan, false); frames(2); };
    frames(120);
    for (const [name, body, re, line] of cases) {
      m.drives[1].set(name + '.PAS', Buffer.from(prog(schub, body), 'latin1'));
      hold(0x04); frames(20);
      if (/LOAD ANYWAY/.test(m.screenText())) { m.pushKey(89); frames(20); }
      type(name.toLowerCase() + '.pas\n'); frames(30);
      hold(0x03);
      for (let i = 0; i < 800 && !/PRESS A KEY/.test(m.screenText()); i++) frames(1);
      m.pushKey(32); frames(80);
      const l = m.screenText().split('\n');
      const msg = (l[29] || '').trim();
      const mm = re.exec(msg);
      const want = line ? line + (schub ? 1 : 0) : 0;
      const at = /LINE (\d+)/.exec(l[28] || '');
      check(`${ed} editor, ${schub ? 'SCHUB' : '65C816'} program, ${name}: ${msg}` + (want ? `, the cursor on line ${want}` : ''),
        !!mm && (!want || (+mm[1] === want && at && +at[1] === want)), `${msg}\n${l[28]}`);
    }
  }
}

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
