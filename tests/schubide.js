// The PASCAL editor, compiler and assembler built for SCHUB (compiler/mkschubide.js):
// it lives in banks $A0-$AF, starts with the cartridge inserted, and compiles
// and assembles for both CPUs exactly like the 65C816 cartridge.
import fs from 'node:fs';
import { buildPascalCart } from '../compiler/mkcart.js';
import { buildSchubIde, IDE_LAYOUT } from '../compiler/mkschubide.js';
import { Meridian } from '../emu/meridian.js';
import { roms } from './harness.js';

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
  ['HELLO.ASM', ex('hello.asm')],
  ['HELLORV.ASM', ex('hellorv.asm')],
];

// load each text (F3), compile it (F9); the output it leaves in memory
function session(onSchub) {
  const m = new Meridian(roms);
  m.insertCartridge(cart.bytes);
  if (onSchub) m.startProgram(m.loadMer(rv.mer).start);
  else m.startCartridge();
  let n = 0;
  const frames = (k) => { for (let i = 0; i < k && m.state === 'running'; i++) { m.runFrame(); n++; } };
  const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(3); } frames(10); };
  const hold = (scan, k = 8) => { m.keyState(scan, true); frames(k); m.keyState(scan, false); frames(2); };
  const line = (r) => m.screenText().split('\n')[r] || '';
  frames(120);
  const out = { started: /MERIDIAN PASCAL/.test(line(0)) && /WELCOME/.test(line(29)), screen: m.screenText(), jobs: [] };
  for (const [name, text] of jobs) {
    m.drives[1].set(name, Buffer.from(text, 'latin1'));
    hold(0x04); frames(20);                                            // F3
    if (/LOAD ANYWAY/.test(m.screenText())) { m.pushKey(89); frames(20); }
    type(name.toLowerCase() + '\n'); frames(30);
    const t0 = n;
    m.keyState(0x01, true); frames(2); m.keyState(0x01, false);         // F9
    let k = 0;
    while (!/^ *OK|ERROR/.test(line(29)) && k < 4000 && m.state === 'running') { frames(1); k++; }
    // code and data of a 65C816 program, of a SCHUB program, of assembly
    const area = /\.ASM$/.test(name) ? [0x330000, 1024] : text.startsWith('{$SCHUB}') ? [0x080000, 8192] : [0x300000, 4096];
    out.jobs.push({
      name, msg: line(29).trim().replace(/, \d+ MS$/, ''), frames: n - t0,
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
check('the SCHUB editor starts (with the cartridge inserted)', b.started, b.screen);
for (let i = 0; i < jobs.length; i++) {
  const x = a.jobs[i], y = b.jobs[i];
  check(`${y.name}: ${y.msg} - same as on the 65C816 (${x.frames} frames there, ${y.frames} on SCHUB)`,
    /^OK/.test(y.msg) && y.msg === x.msg && y.bytes === x.bytes && y.data === x.data && !y.fault && y.state === 'running',
    `65C816: ${x.msg}\nSCHUB:  ${y.msg} ${y.fault || ''} ${y.state}`);
}

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
