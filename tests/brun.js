// BRUN in the system ROM ($FF:4030), called the way MERIDIAN BASIC calls it:
// emulation mode, data bank 1, name in bank 1, drive as value 0. The program
// must run, and bank 0 ($2000-$BFFF, BASIC's direct page, page 3) must come
// back exactly as it was, so BASIC can carry on.
//   node tests/brun.js [path to the system ROM dos.bin]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Meridian } from '../emu/meridian.js';
import { roms, build } from './harness.js';
import { buildPascalCart } from '../compiler/mkcart.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sysPath = process.argv[2] || path.join(here, '..', 'emu', 'rom', 'dos.bin');
const sys = new Uint8Array(fs.readFileSync(sysPath));
let fail = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; if (extra) console.log(extra); } };

const src = "program PC;\nvar a: array[0..9999] of byte; i: integer;\nbegin\n  for i := 0 to 9999 do a[i] := 0;\n  WriteLn('PC BUILD ', 6 * 7);\nend.\n";
// ways a program can end: Halt deep inside procedures, a runtime error, and
// leaving the screen in graphics mode
const halt = `program H;
procedure Deep(n: integer);
var pad: array[0..99] of byte;
begin
  pad[0] := n;
  if n = 0 then begin WriteLn('PC BUILD 42'); Halt(3); end;
  Deep(n - 1);
  WriteLn('NOT HERE');
end;
begin
  Deep(20);
  WriteLn('NOT HERE');
end.
`;
const divz = `program D;
var a, b: integer;
begin
  WriteLn('PC BUILD 42');
  a := 7; b := 0;
  WriteLn(a div b);
  WriteLn('NOT HERE');
end.
`;
const gfx = `program G;
uses Graph;
var i: integer;
begin
  WriteLn('PC BUILD 42');
  InitGraph;
  for i := 0 to 99 do PutPixel(i, i, 5);
end.
`;
const sources = [['PC', src], ['HALT', halt], ['DIVZ', divz], ['GFX', gfx]];
const files = {};
for (const [n, s] of sources)
  for (const t of ['m816', 'schub']) files[`${n}${t === 'm816' ? 'M816' : 'SCHUB'}.MER`] = build(s, t).mer;

// the same programs made on the MERIDIAN: loaded with F3 into the PASCAL
// cartridge's IDE and saved with F7 ({$SCHUB} at the top selects SCHUB)
{
  const cart = buildPascalCart();
  if (!cart.ok) { console.log(cart.errors); process.exit(1); }
  const m = new Meridian(roms);
  m.insertCartridge(cart.bytes);
  m.startCartridge();
  const frames = (n) => { for (let i = 0; i < n && m.state === 'running'; i++) m.runFrame(); };
  const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(3); } };
  const hold = (scan) => { m.keyState(scan, true); frames(4); m.keyState(scan, false); frames(2); };
  frames(60);
  for (const [n, s] of sources) for (const [t, pre] of [['M', ''], ['S', '{$SCHUB}\n']]) {
    const base = `C${n}${t}`;
    m.drives[1].set(base + '.PAS', Buffer.from(pre + s, 'latin1'));
    hold(0x04); frames(20); type(base.toLowerCase() + '\n'); frames(60);        // F3
    hold(0x02); frames(300); type('\n'); frames(200);                            // F7, keep the name
    const mer = m.drives[1].get(base + '.MER');
    check(`cartridge F7 saved ${base}.MER`, !!mer, m.screenText());
    if (mer) files[base + '.MER'] = mer;
    // F5 in the IDE: however the program ends, PRESS A KEY and back to the editor
    hold(0x03); frames(400);
    const ran = m.screenText();
    const err = n !== 'DIVZ' || /RUNTIME ERROR 200/.test(ran);
    m.pushKey(32); frames(60);
    check(`cartridge F5 ${base}: ran, PRESS A KEY, back in the editor`, /PC BUILD 42/.test(ran) && /PRESS A KEY/.test(ran) && err && !/NOT HERE/.test(ran)
      && /MERIDIAN PASCAL/.test(m.screenText()) && m.read(0xc000) === 1 && m.state === 'running', ran + '\n---\n' + m.screenText());
  }
}

function brun(name, drive) {
  const m = new Meridian({ ...roms, sys });
  for (const [n, b] of Object.entries(files)) m.drives[1].set(n, b);
  const mem = m.mem;
  // what BASIC has in bank 0: a pattern everywhere BRUN promises to keep
  const pat = (a) => (a * 7 + 3) & 255;
  for (let a = 0x2000; a < 0xc000; a++) mem[a] = pat(a);
  for (let a = 0x55; a < 0x100; a++) mem[a] = pat(a);
  for (let a = 0x0310; a < 0x0398; a++) mem[a] = pat(a);
  // the name in bank 1, as FRESTR leaves it
  for (let i = 0; i < name.length; i++) mem[0x015000 + i] = name.charCodeAt(i);
  mem[0x039c] = name.length; mem[0x039d] = 0x00; mem[0x039e] = 0x50;
  mem[0x039f] = drive === undefined ? 0 : 1;
  mem[0x03a0] = drive || 0; mem[0x03a1] = 0; mem[0x03a2] = 0;
  mem[0x16ff] = 1;                                     // DRIVE 1
  mem[0x20] = 0xff; mem[0x21] = 0;                     // the kernel's count of memory banks (SDRAM module)
  const keep = Uint8Array.from(mem.subarray(0, 0xc000));
  const layerA = m.read ? m.read(0xc000) : mem[0xc000];
  // JSL $FF4030 from BASIC: emulation mode, data bank 1
  m.startProgram(0xff4030);
  const c = m.cpu;
  c.e = 1; c.p = 0x34; c.dbr = 1; c.s = 0x01fc;
  let back = null;                                     // registers at the RTL back to the caller
  const st = m.step816.bind(m);
  const rtl = (() => { for (let a = 0x7400; a < 0x7f00; a++) if (sys[a - 0x4000] === 0x6b && sys[a - 0x4000 - 1] === 0x28 && sys[a - 0x4000 - 3] === 0x2b) return a; return -1; })();
  m.step816 = () => { if (c.pbr === 0xff && c.pc === rtl) back = { a: c.a & 255, e: c.e, dbr: c.dbr, s: c.s }; return st(); };
  for (let i = 0; i < 1500 && m.state === 'running'; i++) m.runFrame();
  const diff = [];
  const same = (lo, hi) => { for (let a = lo; a < hi; a++) if (mem[a] !== keep[a]) { diff.push(a); if (diff.length > 5) return; } };
  same(0x2000, 0xc000); same(0x55, 0x100); same(0x0310, 0x0398);
  back = back || { a: -1, e: -1, dbr: -1, s: -1 };
  const layerAafter = m.read ? m.read(0xc000) : mem[0xc000];
  return { m, layerA, layerAafter, a: back.a, e: back.e, dbr: back.dbr, s: back.s, diff };
}

const kinds = [['PC', 'ends normally'], ['HALT', 'Halt inside 21 nested calls'], ['DIVZ', 'runtime error (div by 0)'], ['GFX', 'ends in graphics mode']];
const builds = [['', 'M816', '65C816'], ['', 'SCHUB', 'SCHUB'], ['C', 'M', 'cartridge 65C816'], ['C', 'S', 'cartridge SCHUB']];
for (const [k, how] of kinds) for (const [p, t, tn] of builds) {
  const name = p + k + t, what = `${tn}, ${how},`;
  const r = brun(name);
  if (k === 'HALT' || k === 'DIVZ') check(`BRUN "${name}": stopped where it should`, !/NOT HERE/.test(r.m.output) && (k !== 'DIVZ' || /RUNTIME ERROR 200/.test(r.m.output)), r.m.output);
  if (k === 'GFX') check(`BRUN "${name}": text screen back afterwards`, r.layerAafter === r.layerA, `before $${r.layerA.toString(16)} after $${r.layerAafter.toString(16)}`);
  check(`BRUN "${name}": ${what} ran`, /PC BUILD 42/.test(r.m.output), `${r.m.state} ${r.m.message}\n${r.m.output}`);
  check(`BRUN "${name}": back in BASIC's mode (emulation, bank 1), A = 0`, r.e === 1 && r.dbr === 1 && r.a === 0 && r.s === 0x01fc,
    `${r.m.state} ${r.m.message} e=${r.e} db=${r.dbr} a=${r.a} s=${r.s.toString(16)}`);
  check(`BRUN "${name}": bank 0 restored`, r.diff.length === 0, 'differs at ' + r.diff.map(a => '$' + a.toString(16)).join(' '));
}
const r = brun('NOTHERE', 1);
check('BRUN of a missing file returns DOS error 2 and changes nothing', r.a === 2 && r.diff.length === 0 && !/PC BUILD/.test(r.m.output), `a=${r.a} ${r.m.message}`);

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
