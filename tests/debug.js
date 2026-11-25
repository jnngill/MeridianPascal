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
  ['ENDS', '  i := i + 1;', /^Program ended\.$/, 0],
  ['DIV0', '  i := 0;\n  i := 10 div i;', /^Runtime error 200 at line (\d+)$/, 8],
  ['RANGE', '{$R+}\n  i := 4;\n  a[i] := 1;', /^Runtime error 201 at line (\d+)$/, 9],
  ['HALT', '  Halt;', /^Program ended\.$/, 0],
  ['NOLINES', '{$D-}\n  i := 0;\n  i := 10 div i;', /^Runtime error 200$/, 0],
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
      if (/Open another anyway/.test(m.screenText())) { m.pushKey(89); frames(20); }
      type(name.toLowerCase() + '.pas\n'); frames(30);
      hold(0x03);
      for (let i = 0; i < 800 && !/PRESS A KEY --/.test(m.screenText()); i++) frames(1);
      frames(5);
      m.pushKey(32); frames(80);
      const l = m.screenText().split('\n');
      const msg = (l[29] || '').trim();
      const mm = re.exec(msg);
      const want = line ? line + (schub ? 1 : 0) : 0;
      const at = /Ln (\d+)/.exec(l[1] || '');
      check(`${ed} editor, ${schub ? 'SCHUB' : '65C816'} program, ${name}: ${msg}` + (want ? `, the cursor on line ${want}` : ''),
        !!mm && (!want || (+mm[1] === want && at && +at[1] === want)), `${msg}\n${l[1]}`);
    }
  }
}

// ---- breakpoints, stepping, watches (both editors, both targets)
const dsrc = (schub) => (schub ? '{$SCHUB}\n' : '') + `program D;
var i, total: integer;
    s: string;
procedure Add(n: integer);
begin
  total := total + n;
end;
begin
  total := 0; s := 'HI';
  for i := 1 to 3 do
    Add(i);
  WriteLn('TOTAL ', total);
end.
`;
for (const ed of ['65C816', 'SCHUB']) {
  for (const schub of [false, true]) {
    const m = new Meridian(roms);
    m.insertCartridge(cart.bytes);
    if (ed === '65C816') startPascal816(m); else m.startCartridge();
    const frames = (k) => { for (let i = 0; i < k && m.state === 'running'; i++) m.runFrame(); };
    const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(3); } frames(10); };
    const hold = (scan, k = 8) => { m.keyState(scan, true); frames(k); m.keyState(scan, false); frames(4); };
    const ctrl = (scan) => { m.keyState(0x14, true); hold(scan); m.keyState(0x14, false); frames(6); };
    const msg = () => (m.screenText().split('\n')[29] || '').trim();
    const watches = () => m.screenText().split('\n').slice(20, 28).filter(x => / = /.test(x)).map(x => x.trim()).join(' ; ');
    const off = schub ? 1 : 0;
    const what = `${ed} editor, ${schub ? 'SCHUB' : '65C816'} program`;
    frames(120);
    m.drives[1].set('D.PAS', Buffer.from(dsrc(schub), 'latin1'));
    hold(0x04); frames(20); type('d.pas\n'); frames(40);
    for (let k = 0; k < 10 + off; k++) { m.pushKey(0x1F); frames(4); }
    frames(20);
    ctrl(0x32);                                                 // Ctrl+B on line 11
    ctrl(0x1D); type('total\n'); ctrl(0x1D); type('i\n'); ctrl(0x1D); type('s\n');
    hold(0x03); frames(300);
    check(`${what}: F5 stops at the breakpoint, watches`, msg().startsWith(`Stopped at line ${11 + off}`) &&
      watches() === "TOTAL = 0 ; I = 1 ; S = 'HI'", `${msg()}\n${watches()}`);
    hold(0x03); frames(300);
    check(`${what}: F5 goes on to it again`, msg().startsWith(`Stopped at line ${11 + off}`) && /TOTAL = 1 ; I = 2/.test(watches()), `${msg()}\n${watches()}`);
    hold(0x02); frames(300);
    check(`${what}: F7 goes into the procedure`, msg().startsWith(`Stopped at line ${6 + off}`), msg());
    hold(0x0A); frames(300);
    check(`${what}: F8 comes out of it`, msg().startsWith(`Stopped at line ${11 + off}`) && /TOTAL = 3 ; I = 3/.test(watches()), `${msg()}\n${watches()}`);
    ctrl(0x32); frames(20);                                     // breakpoint off
    hold(0x03);
    for (let i = 0; i < 800 && !/PRESS A KEY --/.test(m.screenText()); i++) frames(1);
    const out = m.screenText();
    frames(5); m.pushKey(32); frames(80);
    check(`${what}: F5 to the end, the program's screen kept`, /TOTAL 6/.test(out) && msg() === 'Program ended.', out + '\n' + msg());
    // Ctrl+F7: trace from the first statement; Ctrl+F2 ends it
    m.keyState(0x14, true); hold(0x02); m.keyState(0x14, false); frames(300);
    check(`${what}: Ctrl+F7 stops at the first statement`, msg().startsWith(`Stopped at line ${9 + off}`), msg());
    // F8 on a for line goes into the loop's body (the loop's end value is on
    // the stack while the body runs: F8 compares frames, not stack pointers)
    hold(0x0A); frames(300);
    check(`${what}: F8 to the for line`, msg().startsWith(`Stopped at line ${10 + off}`), msg());
    hold(0x0A); frames(300);
    check(`${what}: F8 on the for line stops in the loop's body`, msg().startsWith(`Stopped at line ${11 + off}`) && /I = 1/.test(watches()), `${msg()}\n${watches()}`);
    hold(0x0A); frames(300);
    check(`${what}: F8 again: the body's next round`, msg().startsWith(`Stopped at line ${11 + off}`) && /TOTAL = 1 ; I = 2/.test(watches()), `${msg()}\n${watches()}`);
    ctrl(0x06); frames(30);
    check(`${what}: Ctrl+F2 ends the stopped program`, /Program ended \(Ctrl\+F2\)/.test(msg()) && m.state === 'running', msg());
    hold(0x03);
    for (let i = 0; i < 800 && !/PRESS A KEY --/.test(m.screenText()); i++) frames(1);
    frames(5); m.pushKey(32); frames(80);
    check(`${what}: and runs again afterwards`, msg() === 'Program ended.', msg());
  }
}

// ---- an asm block is one statement: Ctrl+B on a line inside it puts the
// breakpoint on the block's asm line, where the debugger can stop
const asrc = (schub) => (schub ? '{$SCHUB}\n' : '') + [
  'program B;', 'var n: integer;', 'begin', '  n := 1;', '  asm',
  ...(schub ? ['    la t1, n', '    lh t0, 0(t1)', '    { a comment', '      over lines }', '    addi t0, t0, 1', '    sh t0, 0(t1)']
            : ['    lda n', '    inc a', '    { a comment', '      over lines }', '    nop', '    sta n']),
  '  end;', "  WriteLn('N ', n);", 'end.', ''].join('\n');
for (const ed of ['65C816', 'SCHUB']) {
  for (const schub of [false, true]) {
    const m = new Meridian(roms);
    m.insertCartridge(cart.bytes);
    if (ed === '65C816') startPascal816(m); else m.startCartridge();
    const frames = (k) => { for (let i = 0; i < k && m.state === 'running'; i++) m.runFrame(); };
    const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(3); } frames(10); };
    const hold = (scan, k = 8) => { m.keyState(scan, true); frames(k); m.keyState(scan, false); frames(4); };
    const ctrl = (scan) => { m.keyState(0x14, true); hold(scan); m.keyState(0x14, false); frames(6); };
    const msg = () => (m.screenText().split('\n')[29] || '').trim();
    const watches = () => m.screenText().split('\n').slice(20, 28).filter(x => / = /.test(x)).map(x => x.trim()).join(' ; ');
    const off = schub ? 1 : 0;
    const what = `${ed} editor, ${schub ? 'SCHUB' : '65C816'} program`;
    frames(120);
    m.drives[1].set('B.PAS', Buffer.from(asrc(schub), 'latin1'));
    hold(0x04); frames(20); type('b.pas\n'); frames(40);
    for (let k = 0; k < 8 + off; k++) { m.pushKey(0x1F); frames(4); }       // line 9: inside the brace comment
    frames(20);
    ctrl(0x32);
    check(`${what}: Ctrl+B inside an asm block: the breakpoint goes on its asm line`,
      msg() === `Breakpoint at line ${5 + off} (the asm line)`, msg());
    ctrl(0x1D); type('n\n');
    hold(0x03); frames(400);
    check(`${what}: F5 stops at the asm line, before the block`, msg().startsWith(`Stopped at line ${5 + off}`) && watches() === 'N = 1', `${msg()}\n${watches()}`);
    hold(0x02); frames(300);
    check(`${what}: F7 runs the block in one step`, msg().startsWith(`Stopped at line ${13 + off}`) && watches() === 'N = 2', `${msg()}\n${watches()}`);
    ctrl(0x06); frames(30);
    // Ctrl+B again in the block (on its end line) takes the breakpoint off; on a Pascal line as before
    const goLine = (n) => { ctrl(0x4b); type(`${n}\n`); frames(10); };
    goLine(12 + off);                                                     // end;
    ctrl(0x32);
    check(`${what}: Ctrl+B on the block's end line takes it off again`, msg() === `No breakpoint at line ${5 + off} (the asm line)`, msg());
    goLine(13 + off); ctrl(0x32);
    check(`${what}: on the Pascal line after it: there`, msg() === `Breakpoint at line ${13 + off}`, msg());
  }
}

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
