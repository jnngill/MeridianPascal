// The PASCAL editor, compiler and assembler built for SCHUB (compiler/mkschubide.js):
// it lives in banks $A0-$AF, starts with the cartridge inserted, and compiles
// and assembles for both CPUs exactly like the 65C816 cartridge.
import fs from 'node:fs';
import { buildPascalCart } from '../compiler/mkcart.js';
import { buildSchubIde, IDE_LAYOUT } from '../compiler/mkschubide.js';
import { Meridian } from '../emu/meridian.js';
import { roms, startPascal816 } from './harness.js';

const cart = buildPascalCart();
if (!cart.ok) { console.log(cart.errors); process.exit(1); }
const rv = buildSchubIde();
let fail = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; if (extra) console.log(extra); } };
const hx = (v) => '$' + v.toString(16).toUpperCase();

// the editor stays out of everything SCHUB and 65C816 programs and the
// editor's work areas use: banks $04-$1F and $20-$3C
check(`the SCHUB editor lives at ${hx(IDE_LAYOUT.LOAD)}-${hx(IDE_LAYOUT.STACK_TOP)}, its variables end at ${hx(rv.info.heap)}`,
  IDE_LAYOUT.LOAD >= 0x400000 && rv.info.heap < IDE_LAYOUT.STACK_TOP - 0x10000 && IDE_LAYOUT.STACK_TOP < 0xb00000);

const ex = (n) => fs.readFileSync(new URL(`../examples/${n}`, import.meta.url), 'latin1');
// [file name, text]: 65C816 and SCHUB programs, 65C816 and SCHUB assembly
const jobs = [
  ['SNAKE.PAS', ex('snake.pas')],
  ['SSNAKE.PAS', '{$SCHUB}\n' + ex('snake.pas')],
  ['SPRIMES.PAS', '{$SCHUB}\n' + ex('primes.pas')],
  // objects: the VMTs go into the data image, at odd addresses too
  ['OBJ.PAS', fs.readFileSync(new URL('cases/22_objects.pas', import.meta.url), 'latin1')],
  ['SOBJ.PAS', '{$SCHUB}\n' + fs.readFileSync(new URL('cases/22_objects.pas', import.meta.url), 'latin1')],
  ['HELLO.ASM', ex('hello.asm')],
  ['HELLORV.ASM', ex('hellorv.asm')],
];

// load each text (F3), compile it (F9); the output it leaves in memory
function session(onSchub) {
  const m = new Meridian(roms);
  m.insertCartridge(cart.bytes);
  if (onSchub) m.startCartridge();     // the cartridge starts the SCHUB editor
  else startPascal816(m);
  let n = 0;
  const frames = (k) => { for (let i = 0; i < k && m.state === 'running'; i++) { m.runFrame(); n++; } };
  const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(3); } frames(10); };
  const hold = (scan, k = 8) => { m.keyState(scan, true); frames(k); m.keyState(scan, false); frames(2); };
  const line = (r) => m.screenText().split('\n')[r] || '';
  frames(120);
  const out = { started: /PASCAL +F1 help/.test(line(0)) && /Welcome/.test(line(29)), onSchub: m.rv.running, screen: m.screenText(), jobs: [] };
  for (const [name, text] of jobs) {
    m.drives[1].set(name, Buffer.from(text, 'latin1'));
    hold(0x04); frames(20);                                            // F3
    if (/Open another anyway/.test(m.screenText())) { m.pushKey(89); frames(20); }
    type(name.toLowerCase() + '\n'); frames(30);
    const t0 = n;
    m.keyState(0x01, true); frames(2); m.keyState(0x01, false);         // F9
    let k = 0;
    while (!/^ *(Compiled|Assembled|Error)/.test(line(29)) && k < 4000 && m.state === 'running') { frames(1); k++; }
    const t1 = n; frames(10);                                                        // the whole message drawn
    // code and data of a 65C816 program, of a SCHUB program, of assembly
    const area = /\.ASM$/.test(name) ? [0x330000, 1024] : text.startsWith('{$SCHUB}') ? [0x080000, 8192] : [0x300000, 4096];
    out.jobs.push({
      name, msg: line(29).trim().replace(/, \d+ ms$/, ''), frames: t1 - t0,
      bytes: Buffer.from(m.mem.subarray(area[0], area[0] + area[1])).toString('hex'),
      data: Buffer.from(m.mem.subarray(0x320000, 0x320000 + 2048)).toString('hex'),
      fault: m.schubFault, state: m.state,
    });
    for (let a = 0x300000; a < 0x340000; a++) m.mem[a] = 0;            // a clean slate for the next one
    for (let a = 0x080000; a < 0x082000; a++) m.mem[a] = 0;
  }
  return out;
}

const a = session(false);
const b = session(true);
check('the cartridge starts the SCHUB editor on a core with SCHUB', b.started && b.onSchub, b.screen);
check('with Ctrl held down it starts the 65C816 editor', a.started && !a.onSchub, a.screen);
for (let i = 0; i < jobs.length; i++) {
  const x = a.jobs[i], y = b.jobs[i];
  check(`${y.name}: ${y.msg} - same as on the 65C816 (${x.frames} frames there, ${y.frames} on SCHUB)`,
    /^(Compiled|Assembled)/.test(y.msg) && y.msg === x.msg && y.bytes === x.bytes && y.data === x.data && !y.fault && y.state === 'running',
    `65C816: ${x.msg}\nSCHUB:  ${y.msg} ${y.fault || ''} ${y.state}`);
}

// ---- F5 (compile and run), F7 (save a standalone .MER) and running a .MER
// (F3 with a .MER name, like Ctrl+R) in the SCHUB editor. The host stub stops
// SCHUB, runs the program on the 65C816 or on SCHUB, and the editor carries on.
{
  const m = new Meridian(roms);
  m.insertCartridge(cart.bytes);
  m.startCartridge();
  const frames = (k) => { for (let i = 0; i < k && m.state === 'running'; i++) m.runFrame(); };
  const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(3); } frames(10); };
  const hold = (scan, k = 8) => { m.keyState(scan, true); frames(k); m.keyState(scan, false); frames(2); };
  const line = (r) => m.screenText().split('\n')[r] || '';
  const until = (re, k = 3000) => { for (let i = 0; i < k && !re.test(m.screenText()) && m.state === 'running'; i++) frames(1); return re.test(m.screenText()); };
  frames(120);
  const load = (name, text) => {
    m.drives[1].set(name, Buffer.from(text, 'latin1'));
    hold(0x04); frames(20);
    if (/Open another anyway/.test(m.screenText())) { m.pushKey(89); frames(20); }
    type(name.toLowerCase() + '\n'); frames(30);
  };
  // F5, the program's screen, a key back to the editor
  const f5 = (expect, during) => {
    hold(0x03);
    const ran = until(expect, 4000);
    if (during) during();
    const ended = until(/PRESS A KEY --/, 4000); frames(5);
    const scr = m.screenText();
    m.pushKey(32); frames(60);
    return { ran, ended, scr, back: /Program ended/.test(line(29)) && /PASCAL +F1 help/.test(line(0)) };
  };
  const ok = () => m.state === 'running' && !m.schubFault;
  const prog = (who) => `program R;\nvar i: integer;\nbegin\n  for i := 1 to 3 do WriteLn('${who} LINE ', i * 7);\nend.\n`;

  load('R816.PAS', prog('65C816'));
  let r = f5(/65C816 LINE 21/);
  check('F5 runs a 65C816 program from the SCHUB editor and comes back', r.ran && r.ended && r.back && ok(), r.scr + '\n' + m.screenText() + (m.schubFault || ''));
  check('the editor still has its text', /65C816 LINE/.test(m.screenText()) && /R816\.PAS/.test(line(1)), m.screenText());

  load('RRV.PAS', '{$SCHUB}\n' + prog('SCHUB'));
  r = f5(/SCHUB LINE 21/);
  check('F5 runs a SCHUB program (SCHUB stops for it and the editor resumes)', r.ran && r.ended && r.back && ok(), r.scr + '\n' + m.screenText() + (m.schubFault || ''));
  // after that the editor still compiles
  hold(0x01); until(/^ *(Compiled|Error)/m, 600);
  check('the editor compiles again after a SCHUB program ran', /^ *Compiled/.test(line(29)), line(29));

  // the assembly examples wait for a click
  const click = () => { m.mouse.b = 1; frames(10); m.mouse.b = 0; };
  load('HELLO.ASM', ex('hello.asm'));
  r = f5(/HELLO FROM THE MERIDIAN!/, click);
  check('F5 runs HELLO.ASM (65C816) from the SCHUB editor', r.ran && r.ended && r.back && ok(), r.scr);
  load('HELLORV.ASM', ex('hellorv.asm'));
  r = f5(/HELLO FROM SCHUB!/, click);
  check('F5 runs HELLORV.ASM (SCHUB) from the SCHUB editor', r.ran && r.ended && r.back && ok(), r.scr);

  // F7: standalone .MER files, run without the cartridge
  const f7 = (name) => { m.drives[1].delete(name); hold(0x02); frames(300); type('\n'); frames(200); return m.drives[1].get(name); };
  const alone = (mer, re) => {
    const x = new Meridian(roms);
    x.startProgram(x.loadMer(mer).start);
    for (let i = 0; i < 1500 && x.state === 'running' && !re.test(x.output); i++) x.runFrame();
    return re.test(x.output);
  };
  load('R816.PAS', prog('65C816'));
  const m1 = f7('R816.MER');
  check('F7 in the SCHUB editor saves R816.MER, which runs without the cartridge', !!m1 && alone(m1, /65C816 LINE 21/), line(29));
  load('RRV.PAS', '{$SCHUB}\n' + prog('SCHUB'));
  const m2 = f7('RRV.MER');
  check('F7 saves RRV.MER (SCHUB), which runs without the cartridge', !!m2 && alone(m2, /SCHUB LINE 21/), line(29));

  // a .MER from the drive (F3 with a .MER name, like Ctrl+R)
  const runMer = (name, re) => {
    hold(0x04); frames(20);
    type(name.toLowerCase() + '\n');
    const ran = until(re, 4000);
    const ended = until(/PRESS A KEY --/, 4000); frames(5);
    m.pushKey(32); frames(60);
    return ran && ended && new RegExp(name.replace('.', '\\.') + ' ended').test(line(29)) && ok();
  };
  if (m1) check('the SCHUB editor runs R816.MER from the drive', runMer('R816.MER', /65C816 LINE 21/), m.screenText());
  if (m2) check('the SCHUB editor runs RRV.MER (SCHUB) from the drive', runMer('RRV.MER', /SCHUB LINE 21/), m.screenText());
  hold(0x04); frames(20); type('nothere.mer\n'); frames(60);
  check('a missing .MER gives a DOS error, and the editor carries on', /Cannot run NOTHERE\.MER/.test(line(29)) && ok(), m.screenText() + `\n${m.state} ${m.schubFault || ''}`);
  // F10: back to BASIC, as from the 65C816 editor (the cartridge returns to the kernel)
  hold(0x09); frames(120);
  check('F10 leaves the SCHUB editor: the cartridge returns, SCHUB is stopped', m.state === 'idle' && !m.rv.running, `${m.state} ${m.message}\n${m.screenText()}`);
}

// Ctrl+F10 in the SCHUB editor: on to the 65C816 editor
{
  const m = new Meridian(roms);
  m.insertCartridge(cart.bytes);
  m.startCartridge();
  const frames = (k) => { for (let i = 0; i < k && m.state === 'running'; i++) m.runFrame(); };
  frames(120);
  const welcome = m.screenText().split('\n')[29] || '';
  m.keyState(0x14, true); m.keyState(0x09, true); frames(8); m.keyState(0x09, false); frames(4); m.keyState(0x14, false);
  frames(200);
  const scr = m.screenText().split('\n');
  check('the SCHUB editor says so when it starts', /on SCHUB/.test(welcome), welcome);
  check('Ctrl+F10 leaves the SCHUB editor for the 65C816 editor', m.state === 'running' && !m.rv.running &&
    /PASCAL +F1 help/.test(scr[0]) && /^ *Welcome to MERIDIAN Pascal\. F1/.test(scr[29] || ''), `${m.state} ${m.message}\n${scr.join('\n')}`);
}

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
