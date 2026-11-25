// ExitProc and IntProc beyond tests/cases/24_exitint.pas: IntProc only for
// the 65C816 (both compilers); the kernel's interrupt hook is back after the
// program, however it ends; in the cartridge editor a runtime error keeps
// its message and line while ExitProc runs, and a breakpoint inside the
// interrupt procedure does not stop the program there.
import { buildPascalCart } from '../compiler/mkcart.js';
import { Meridian } from '../emu/meridian.js';
import { roms, startPascal816, build } from './harness.js';
import { ncRun } from './nc.js';

let fail = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; if (extra) console.log(extra); } };
const hookOf = (m) => m.mem[0x300] | (m.mem[0x301] << 8);

// ---- IntProc is for the 65C816
const USES_INT = 'program I;\nprocedure T; begin end;\nbegin\n  IntProc := T;\nend.\n';
let r = build(USES_INT, 'schub', 'i.pas');
check('PC compiler: IntProc in a SCHUB program is an error', !r.ok && /65C816 programs/.test(r.errors[0].msg) && r.errors[0].line === 4, JSON.stringify(r.errors[0]));
let o = ncRun('{$SCHUB}\n' + USES_INT, { frames: 2000 });
check('device: IntProc in a SCHUB program is an error', /^ERROR\s+5:\d+ IntProc and IntStatus are for 65C816 programs/.test(o.output), o.output);

// ---- the hook back after the program: ended, Halt, a runtime error
const ENDS = {
  'the end': '',
  'Halt': '  Halt;\n',
  'a runtime error': '  i := 0;\n  i := 10 div i;\n',
};
for (const [how, body] of Object.entries(ENDS)) {
  const src = `program H;\nvar i, n: integer;\nprocedure T; begin n := n + 1; end;\nbegin\n  IntProc := T;\n  repeat until n > 3;\n${body}  WriteLn('N ', n > 3);\nend.\n`;
  r = build(src, 'm816', 'h.pas');
  const m = new Meridian(roms);
  // run by hand to look at $0300 afterwards
  const info = m.loadMer(r.mer); m.startProgram(info.start);
  let set = false;
  for (let f = 0; f < 600 && m.state === 'running'; f++) { m.runFrame(); if (hookOf(m) !== m.stdHook) set = true; }
  check(`PC compiler, ${how}: IntProc ran, the hook is the kernel's again`, set && m.state !== 'running' && hookOf(m) === m.stdHook,
    `${m.output}\nhook $${hookOf(m).toString(16)} std $${m.stdHook.toString(16)} ${m.state}`);
  o = ncRun(src, { frames: 1500 });
  check(`device, ${how}: IntProc ran, the hook is the kernel's again`, /^COMPILED/.test(o.output) && /BACK/.test(o.output) && hookOf(o.m) === o.m.stdHook
    && (how === 'a runtime error' ? /RUNTIME ERROR 200/.test(o.output) : how === 'Halt' ? !/N TRUE/.test(o.output) : /N TRUE/.test(o.output)), `${o.output}\nhook $${hookOf(o.m).toString(16)}`);
}

// ---- the cartridge editor: ExitProc after a runtime error; a breakpoint in IntProc
const cart = buildPascalCart();
const EXIT_ERR = (schub) => (schub ? '{$SCHUB}\n' : '') + [
  'program E;', 'var i: integer;', 'procedure Bye;', 'begin', "  WriteLn('BYE');", 'end;', 'begin',
  '  ExitProc := Bye;', '  i := 0;', '  i := 10 div i;', 'end.', ''].join('\n');
const TICKS = ['program T;', 'var n: integer;', 'procedure Tick;', 'begin', '  n := n + 1;', 'end;', 'begin',
  '  IntProc := Tick;', '  repeat until n > 5;', "  WriteLn('TICKS ', n > 5);", 'end.', ''].join('\n');
for (const ed of ['65C816', 'SCHUB']) {
  const m = new Meridian(roms);
  m.insertCartridge(cart.bytes);
  if (ed === '65C816') startPascal816(m); else m.startCartridge();
  const frames = (k) => { for (let i = 0; i < k && m.state === 'running'; i++) m.runFrame(); };
  const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(3); } frames(10); };
  const hold = (scan, k = 8) => { m.keyState(scan, true); frames(k); m.keyState(scan, false); frames(4); };
  const ctrl = (scan) => { m.keyState(0x14, true); hold(scan); m.keyState(0x14, false); frames(6); };
  const msg = () => (m.screenText().split('\n')[29] || '').trim();
  const load = (name, text) => {
    m.drives[1].set(name, Buffer.from(text, 'latin1'));
    hold(0x04); frames(20);
    if (/Open another anyway/.test(m.screenText())) { m.pushKey(89); frames(20); }
    type(name.toLowerCase() + '\n'); frames(40);
  };
  const f5 = () => {
    hold(0x03);
    for (let i = 0; i < 1500 && !/PRESS A KEY --/.test(m.screenText()) && !/^Stopped/.test(msg()); i++) frames(1);
    const scr = m.screenText();
    if (/PRESS A KEY --/.test(scr)) { frames(5); m.pushKey(32); frames(80); }
    return scr;
  };
  frames(120);
  for (const schub of [false, true]) {
    const what = `${ed} editor, ${schub ? 'SCHUB' : '65C816'} program`;
    load(schub ? 'SE.PAS' : 'E.PAS', EXIT_ERR(schub));
    const scr = f5();
    check(`${what}: ExitProc runs after a runtime error; the message and line stay`,
      /RUNTIME ERROR 200/.test(scr) && /BYE/.test(scr) && msg() === `Runtime error 200 at line ${10 + (schub ? 1 : 0)}`, `${scr}\n${msg()}`);
  }
  load('T.PAS', TICKS);
  ctrl(0x4b); type('5\n'); frames(10);                       // line 5: n := n + 1, in IntProc
  ctrl(0x32);
  const scr = f5();
  check(`${ed} editor: a breakpoint inside IntProc does not stop the program`, /TICKS TRUE/.test(scr) && msg() === 'Program ended.'
    && hookOf(m) === m.stdHook, `${scr}\n${msg()}`);
}

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
