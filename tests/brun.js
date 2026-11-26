// BRUN in the system ROM ($FF:402D), called the way MERIDIAN BASIC calls it:
// emulation mode, data bank 1, name in bank 1, drive as value 0. The program
// must run, and bank 0 ($2000-$BFFF, BASIC's direct page, page 3) must come
// back exactly as it was, so BASIC can carry on.
//   node tests/brun.js [path to the system ROM dos.bin]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Meridian } from '../emu/meridian.js';
import { roms, build, startPascal816 } from './harness.js';
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
// the Basic unit: read BASIC's variables, change some, make new ones
const bvar = `program BV;
uses Basic;
begin
  WriteLn('PC BUILD 42');
  WriteLn('V ', BasicPresent, ' ', BasicReal('A'):0:2, ' ', BasicReal('SCORE'):0:1, ' ', BasicInt('N%'), ' ', BasicStr('A$'), ' ', BasicReal('Q'):0:1, ' ', BasicExists('Q'));
  WriteLn('W ', BasicArrLen('D'), ' ', BasicArrReal('D', 3):0:2, ' ', BasicArrInt('E%', 2), ' ', BasicArrStr('F$', 1), ' ', BasicArrLen('NO'), ' ', BasicReal('BIG'):0:1);
  SetBasicReal('R', BasicReal('A') * 2);
  SetBasicInt('N%', BasicInt('N%') - 1);
  if SetBasicStr('B$', BasicStr('A$') + ' WORLD') then WriteLn('STR OK');
  SetBasicArrReal('D', 2, -0.15625);
  SetBasicArrInt('E%', 0, 32767);
  if SetBasicArrStr('F$', 0, 'XY') then WriteLn('ARR OK');
  SetBasicReal('BIG', 1.0E30);
  SetBasicReal('SC', 0.0);
end.
`;
const sources = [['PC', src], ['HALT', halt], ['DIVZ', divz], ['GFX', gfx], ['BVAR', bvar]];
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
  startPascal816(m);
  const frames = (n) => { for (let i = 0; i < n && m.state === 'running'; i++) m.runFrame(); };
  const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(3); } };
  const hold = (scan) => { m.keyState(scan, true); frames(4); m.keyState(scan, false); frames(2); };
  frames(60);
  for (const [n, s] of sources) for (const [t, pre] of [['M', ''], ['S', '{$SCHUB}\n']]) {
    const base = `C${n}${t}`;
    m.drives[1].set(base + '.PAS', Buffer.from(pre + s, 'latin1'));
    hold(0x04); frames(20); type(base.toLowerCase() + '\n'); frames(60);        // F3
    const status = m.screenText().split('\n')[1] || '';
    check(`status line of ${base}.PAS says ${t === 'S' ? 'SCHUB' : '65C816'}`, new RegExp(`  ${t === 'S' ? 'SCHUB' : '65C816'}  `).test(status), status);
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
      && /PASCAL +F1 help/.test(m.screenText()) && m.read(0xc000) === 1 && m.state === 'running', ran + '\n---\n' + m.screenText());
  }
}

function brun(name, drive, setup) {
  const m = new Meridian({ ...roms, sys });
  for (const [n, b] of Object.entries(files)) m.drives[1].set(n, b);
  const mem = m.mem;
  // what BASIC has in bank 0: a pattern everywhere BRUN promises to keep
  const pat = (a) => (a * 7 + 3) & 255;
  for (let a = 0x2000; a < 0xc000; a++) mem[a] = pat(a);
  for (let a = 0x55; a < 0x100; a++) mem[a] = pat(a);
  for (let a = 0x0310; a < 0x0398; a++) mem[a] = pat(a);
  if (setup) setup(mem);
  // the name in bank 1, as FRESTR leaves it
  for (let i = 0; i < name.length; i++) mem[0x015000 + i] = name.charCodeAt(i);
  mem[0x039c] = name.length; mem[0x039d] = 0x00; mem[0x039e] = 0x50;
  mem[0x039f] = drive === undefined ? 0 : 1;
  mem[0x03a0] = drive || 0; mem[0x03a1] = 0; mem[0x03a2] = 0;
  mem[0x16ff] = 1;                                     // DRIVE 1
  mem[0x20] = 0xff; mem[0x21] = 0;                     // the kernel's count of memory banks (SDRAM module)
  const keep = Uint8Array.from(mem.subarray(0, 0xc000));
  const layerA = m.read ? m.read(0xc000) : mem[0xc000];
  // JSL $FF402D from BASIC: emulation mode, data bank 1
  m.startProgram(0xff402d);
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
// MER_OUT=dir: also write the programs there (8.3 names), to try them on a MiSTer
if (process.env.MER_OUT) for (const [n, b] of Object.entries(files))
  fs.writeFileSync(path.join(process.env.MER_OUT, n.replace('M816', 'M').replace('SCHUB', 'S')), b);
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

// ---- the Basic unit, against BASIC's variables laid out as MERIDIAN BASIC
// does (basic/basic.s: PTRGET, NOTFDD, MOVMF, GETSPA). Numbers in Microsoft's
// 5-byte format, written and read here independently of the unit.
function mbf(x) {
  if (x === 0) return [0, 0, 0, 0, 0];
  const s = x < 0 ? 0x80 : 0; x = Math.abs(x);
  let e = Math.floor(Math.log2(x)) + 1, m = x / 2 ** e;
  if (m >= 1) { m /= 2; e++; } if (m < 0.5) { m *= 2; e--; }
  let man = Math.round(m * 2 ** 32);
  if (man >= 2 ** 32) { man /= 2; e++; }
  return [e + 128, ((man >>> 24) & 0x7f) | s, (man >>> 16) & 255, (man >>> 8) & 255, man & 255];
}
const unmbf = (b) => b[0] === 0 ? 0 : (b[1] & 0x80 ? -1 : 1) * ((((b[1] | 0x80) * 2 ** 24) + b[2] * 65536 + b[3] * 256 + b[4]) / 2 ** 32) * 2 ** (b[0] - 128);
const ZP = { TXTTAB: 0x87, VARTAB: 0x89, ARYTAB: 0x8b, STREND: 0x8d, FRETOP: 0x8f, FRESPC: 0x91, MEMSIZ: 0x93 };
const nm = (s) => { const k = s.endsWith('$') ? 2 : s.endsWith('%') ? 1 : 0; const n = s.replace(/[$%]$/, '');
  let c1 = n.charCodeAt(0), c2 = n.length > 1 ? n.charCodeAt(1) : 0;
  if (k === 2) c2 |= 0x80; if (k === 1) { c1 |= 0x80; c2 |= 0x80; } return [c1, c2]; };
function basicSetup(mem) {
  const B1 = 0x10000;
  let fre = 0x4f00;
  const str = (t) => { fre -= t.length; for (let i = 0; i < t.length; i++) mem[B1 + fre + i] = t.charCodeAt(i); return [t.length, fre & 255, fre >> 8]; };
  const w16 = (a, v) => { mem[a] = v & 255; mem[a + 1] = v >> 8; };
  for (let a = 0x0801; a < 0x0810; a++) mem[B1 + a] = 0x55;     // stands in for the program text
  let p = 0x2000;
  const simple = (name, val) => { const [c1, c2] = nm(name); const v = [...val, 0, 0, 0, 0, 0].slice(0, 5);
    [c1, c2, ...v].forEach((b, i) => { mem[B1 + p + i] = b; }); p += 7; };
  simple('A', mbf(3.25)); simple('SC', mbf(1234.5)); simple('N%', [(-300 >> 8) & 255, -300 & 255]);
  simple('A$', str('HELLO')); simple('BI', mbf(5));
  const ary = p;
  const array = (name, size, els) => { const [c1, c2] = nm(name); const n = els.length, total = 7 + n * size;
    const bytes = [c1, c2, total & 255, total >> 8, 1, n >> 8, n & 255, ...els.flat()];
    bytes.forEach((b, i) => { mem[B1 + p + i] = b; }); p += total; };
  array('D', 5, [0, 1, 2, 7.5, 4, 5].map(mbf));
  array('E%', 2, [10, 20, -2, 40].map(v => [(v >> 8) & 255, v & 255]));
  array('F$', 3, [str('ONE'), str('HI')]);
  w16(ZP.TXTTAB, 0x0801); w16(ZP.VARTAB, 0x2000); w16(ZP.ARYTAB, ary); w16(ZP.STREND, p);
  w16(ZP.FRETOP, fre); w16(ZP.FRESPC, fre); w16(ZP.MEMSIZ, 0x4f00);
}
// read the variables back the way BASIC would
function basicRead(mem) {
  const B1 = 0x10000, z = (k) => mem[ZP[k]] | mem[ZP[k] + 1] << 8;
  const out = { zp: {}, v: {}, a: {} };
  for (const k of Object.keys(ZP)) out.zp[k] = z(k);
  const val = (name, a) => name.endsWith('$') ? String.fromCharCode(...mem.subarray(B1 + (mem[a + 1] | mem[a + 2] << 8), B1 + (mem[a + 1] | mem[a + 2] << 8) + mem[a]))
    : name.endsWith('%') ? ((mem[a] << 8 | mem[a + 1]) << 16 >> 16) : unmbf(mem.subarray(a, a + 5));
  const nameOf = (c1, c2) => String.fromCharCode(c1 & 0x7f) + (c2 & 0x7f ? String.fromCharCode(c2 & 0x7f) : '') + (c1 & 0x80 ? '%' : c2 & 0x80 ? '$' : '');
  for (let p = z('VARTAB'); p < z('ARYTAB'); p += 7) { const n = nameOf(mem[B1 + p], mem[B1 + p + 1]); out.v[n] = val(n, B1 + p + 2); }
  for (let p = z('ARYTAB'); p < z('STREND');) {
    const n = nameOf(mem[B1 + p], mem[B1 + p + 1]), len = mem[B1 + p + 2] | mem[B1 + p + 3] << 8, cnt = mem[B1 + p + 5] << 8 | mem[B1 + p + 6];
    const size = n.endsWith('$') ? 3 : n.endsWith('%') ? 2 : 5;
    out.a[n] = []; for (let i = 0; i < cnt; i++) out.a[n].push(val(n, B1 + p + 7 + i * size));
    if (!len) break; p += len;
  }
  return out;
}
for (const [p, t, tn] of builds) {
  const name = `${p}BVAR${t}`;
  const r = brun(name, undefined, basicSetup);
  const out = r.m.output.replace(/\r/g, '\n');
  check(`Basic unit (${tn}): reads BASIC's variables`, /V TRUE 3\.25 1234\.5 -300 HELLO 0\.0 FALSE/.test(out) && /W 6 7\.50 -2 HI -1 5\.0/.test(out), out);
  check(`Basic unit (${tn}): sets strings`, /STR OK/.test(out) && /ARR OK/.test(out), out);
  const b = basicRead(r.m.mem);
  const near = (x, y) => Math.abs(x - y) <= Math.abs(y) * 1e-6;
  const ok = b.v.R === 6.5 && b.v['N%'] === -301 && b.v['B$'] === 'HELLO WORLD' && b.v['A$'] === 'HELLO' && b.v.SC === 0 && b.v.A === 3.25
    && near(b.v.BI, 1e30) && JSON.stringify(b.a.D) === JSON.stringify([0, 1, -0.15625, 7.5, 4, 5])
    && JSON.stringify(b.a['E%']) === JSON.stringify([32767, 20, -2, 40]) && JSON.stringify(b.a['F$']) === JSON.stringify(['XY', 'HI']);
  check(`Basic unit (${tn}): BASIC sees the new values, arrays intact after the new variables`, ok, JSON.stringify(b));
  check(`Basic unit (${tn}): pointers in BASIC's page zero updated (2 new variables, 3 new strings)`,
    b.zp.VARTAB === 0x2000 && b.zp.ARYTAB - 0x2000 === 7 * 7 && b.zp.FRETOP === b.zp.FRESPC && 0x4f00 - b.zp.FRETOP === 5 + 3 + 2 + 11 + 2 && b.zp.STREND <= b.zp.FRETOP,
    JSON.stringify(b.zp));
  check(`Basic unit (${tn}): back in BASIC's mode, A = 0`, r.e === 1 && r.dbr === 1 && r.a === 0, `e=${r.e} db=${r.dbr} a=${r.a}`);
}
{
  // not started by BRUN: BasicPresent is false, nothing is read or written
  const x = new Meridian(roms);
  x.startProgram(x.loadMer(files['BVARM816.MER']).start);
  for (let i = 0; i < 600 && x.state === 'running'; i++) x.runFrame();
  check('Basic unit without BRUN: BasicPresent false, reads 0', /V FALSE 0\.00 0\.0 0  0\.0 FALSE/.test(x.output) && !/STR OK/.test(x.output), x.output);
}

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
