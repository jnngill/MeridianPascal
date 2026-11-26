// The Workshop unit, against the core's ROMs (kernel, BASIC, workshop):
// - WsLoad distributes a workshop file (format of rom/ws_datei.asm) like LOAD
// - MAP / TILE / TILE() / LOOK / SFX from Pascal leave the machine as the same
//   commands in the real BASIC interpreter do
// Needs ../MERIDIAN_SCHUB_MiSTer/rom (or MERIDIAN_CORE_ROM).
import fs from 'node:fs';
import { compile } from '../compiler/compile.js';
import { loader } from './harness.js';
import { coreMachine, runBasic, CORE_ROM } from '../basicc/interp.js';

let fail = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; if (extra) console.log(extra); } };
if (!fs.existsSync(CORE_ROM)) { console.log(`skipped: no core ROMs in ${CORE_ROM}`); process.exit(0); }

// ---- a workshop file: program, sections (kind, length 3 bytes, data), program length, "MWS1"
let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed >>> 16; };
const bytes = (n, f = () => rnd() & 255) => Uint8Array.from({ length: n }, (_, i) => f(i));
const sections = {
  1: bytes(0x4080, (i) => i < 0x4000 ? rnd() & 255 : rnd() & 15),     // patterns, bank per pattern
  2: bytes(0x2100, (i) => i < 0x2000 ? rnd() & 255 : rnd() & 15),     // tiles, bank per tile
  3: bytes(0x2000, (i) => i & 1 ? 0 : rnd() & 255),                   // maps: tile numbers, no flags
  4: bytes(64 * 132),
  5: bytes(0x240, (i) => i === 0 ? 3 : rnd() & 255),                  // look: look and font changed
  6: bytes(2048),
};
const program = Uint8Array.from([1, 8, 7, 8, 10, 0, 128, 0, 0, 0]);   // stands for a BASIC program
const parts = [program];
for (const [k, d] of Object.entries(sections)) parts.push(Uint8Array.from([+k, d.length & 255, (d.length >> 8) & 255, d.length >> 16]), d);
parts.push(Uint8Array.from([program.length, 0, 0, 0x4d, 0x57, 0x53, 0x31]));
const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
{ let o = 0; for (const p of parts) { file.set(p, o); o += p.length; } }

function buildPas(src) {
  const r = compile(src, 'ws.pas', { target: 'm816', loadUnit: loader(process.cwd()) });
  if (!r.ok) { console.log(r.errors); process.exit(1); }
  return r;
}
function runPas(src, frames, setup) {
  const r = buildPas(src);
  const m = coreMachine();
  m.mem[0x20] = 0xff; m.mem[0x21] = 0;
  m.drives[1].set('GAME.BAS', file);
  if (setup) setup(m);
  m.startProgram(m.loadMer(r.mer).start);
  for (let i = 0; i < frames && m.state === 'running'; i++) m.runFrame();
  return m;
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const firstDiff = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `at +$${i.toString(16)}: ${a[i]} / ${b[i]}`; return ''; };

// ---- 1: WsLoad
{
  const m = runPas(`program L; uses Workshop;
begin
  if WsLoad('GAME') then WriteLn('LOADED') else WriteLn('ERROR ', WsResult);
  WriteLn('BANKS ', PatternBank(5), ' ', TileBank(200));
  if not WsLoad('NOSUCH') then WriteLn('MISSING ', WsResult);
end.`, 400);
  check('WsLoad reads a workshop file', /LOADED/.test(m.output), m.output);
  const s1 = sections[1], s2 = sections[2];
  check('sprite patterns in $F8:0000 and their banks', same(m.mem.subarray(0xf80000, 0xf80000 + 0x4080), s1), firstDiff(m.mem.subarray(0xf80000, 0xf84080), s1));
  check('sprite patterns in KOBOLD', same(m.pattern.subarray(0, 0x4000), s1.subarray(0, 0x4000)), firstDiff(m.pattern.subarray(0, 0x4000), s1));
  check('tiles in $03:4000, their banks in $F8:4200', same(m.mem.subarray(0x034000, 0x036000), s2.subarray(0, 0x2000)) && same(m.mem.subarray(0xf84200, 0xf84300), s2.subarray(0x2000)));
  check('maps in $03:6000', same(m.mem.subarray(0x036000, 0x038000), sections[3]));
  check('sounds in $F8:8000', same(m.mem.subarray(0xf88000, 0xf88000 + 64 * 132), sections[4]));
  check('look in $F8:4800, font in $F8:C000', same(m.mem.subarray(0xf84800, 0xf84a40), sections[5]) && same(m.mem.subarray(0xf8c000, 0xf8c800), sections[6]));
  check('PatternBank / TileBank', new RegExp(`BANKS ${s1[0x4000 + 5]} ${s2[0x2000 + 200]}`).test(m.output), m.output);
  check('a missing file: false, WsResult = the DOS error', /MISSING 2/.test(m.output), m.output);
}

// ---- 2: the commands, Pascal and BASIC on the same data
const prep = (m) => {
  // the state after LOAD: the data where WsLoad / LOAD put it
  m.mem.set(sections[1], 0xf80000); m.mem.set(sections[2].subarray(0, 0x2000), 0x034000);
  m.mem.set(sections[2].subarray(0x2000), 0xf84200); m.mem.set(sections[3], 0x036000);
  m.mem.set(sections[4], 0xf88000); m.mem.set(sections[5], 0xf84800); m.mem.set(sections[6], 0xf8c000);
};
const state = (m) => ({
  io: Array.from(m.io.subarray(0, 0x100)).map((v, i) => i === 0x0f ? 0 : v),   // PINSEL (not $0F, the frame counter)
  pal: Array.from(m.palRaw),
  ws: Array.from(m.mem.subarray(0xf84300, 0xf84500)),  // MAP state, SFX players
  maps: Array.from(m.mem.subarray(0x036000, 0x038000)),
  font: Array.from(m.mem.subarray(0x1800, 0x2000)),
  out: (m.output.match(/T=\s*-?\d+/g) || []).join(' ').replace(/\s+/g, ''),
});
const pas = runPas(`program C; uses Workshop;
var t: integer;
begin
  UseLook;
  MapShow(1); MapScroll(2, 10, 5);
  SetTile(1, 3, 4, 7); SetTileFlags(2, 5, 6, 9, 18);
  t := GetTile(1, 3, 4); WriteLn('T=', t);
  t := GetTile(2, 63, 31); WriteLn('T=', t);
  Sfx(3); SfxOn(4, 2);
  repeat until false;
end.`, 120, prep);
const bas = runBasic(`10 LOOK
20 MAP 1:MAP 2,10,5
30 TILE 1,3,4,7:TILE 2,5,6,9,18
40 PRINT "T=";TILE(1,3,4)
50 PRINT "T=";TILE(2,63,31)
60 SFX 3:SFX 4,2
70 GOTO 70`, { maxFrames: 120, setup: prep });
const A = state(pas), B = state(bas.m);
check('TILE() reads the same', A.out === B.out && A.out.length > 0, `Pascal ${A.out} / BASIC ${B.out}`);
for (const k of ['io', 'pal', 'ws', 'maps', 'font']) check(`after MAP/TILE/LOOK/SFX: ${k} as with BASIC`, same(A[k], B[k]), firstDiff(A[k], B[k]));

// ---- 3: off again
{
  const m = runPas(`program O; uses Workshop;
begin
  UseLook; MapShow(1); MapShow(2);
  MapOff; LookOff; SfxStop;
  WriteLn('R ', WsResult);
  repeat until false;
end.`, 60, prep);
  const b = runBasic('10 LOOK:MAP 1:MAP 2\n20 MAP 0:LOOK 0:SFX -1\n30 GOTO 30', { maxFrames: 60, setup: prep });
  const a = state(m), c = state(b.m);
  check('MapOff / LookOff / SfxStop: as MAP 0 / LOOK 0 / SFX -1', /R 0/.test(m.output) && same(a.io, c.io) && same(a.pal, c.pal) && same(a.ws, c.ws), firstDiff(a.io, c.io) + ' ' + firstDiff(a.pal, c.pal) + ' ' + firstDiff(a.ws, c.ws));
}

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
