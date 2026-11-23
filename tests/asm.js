// The assembler in the PASCAL cartridge: the same source must give the same
// bytes as the PC assemblers (compiler/asm816.js, compiler/asmrv.js), and
// assembled programs must run (F5), save as .MER (F7) and report errors.
import { buildPascalCart } from '../compiler/mkcart.js';
import { assemble816 } from '../compiler/asm816.js';
import { assembleRV } from '../compiler/asmrv.js';
import { Meridian } from '../emu/meridian.js';
import { roms, startPascal816 } from './harness.js';

const r = buildPascalCart();
if (!r.ok) { console.log(r.errors); process.exit(1); }
const S = r.symbols;
let fail = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; if (extra) console.log(extra); } };

const m = new Meridian(roms);
m.insertCartridge(r.bytes);
startPascal816(m);
const frames = (n) => { for (let i = 0; i < n && m.state === 'running'; i++) m.runFrame(); };
// the stack must stay above the editor's data (bank 0, from the cartridge build)
let minS = 0xffff, minAt = '';
{
  const labs = [...S].filter(([k, v]) => v >= 0x400000 && v < 0x500000 && /^(Pd+_|rt_)/.test(k)).sort((a, b) => a[1] - b[1]);
  const nameOf = (a) => { let best = '?'; for (const [k, v] of labs) { if (v <= a) best = k; else break; } return best; };
  const st = m.step816.bind(m);
  m.step816 = () => { const c = m.cpu; if (c.s < minS && c.s > 0x2000 && c.pbr >= 0x40) { minS = c.s; minAt = nameOf((c.pbr << 16) | c.pc); } return st(); };
}
const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(3); } frames(10); };
const hold = (scan, n = 8) => { m.keyState(scan, true); frames(n); m.keyState(scan, false); frames(2); };
const g = (name, n = 4) => { let v = 0; for (let i = 0; i < n; i++) v += m.mem[S.get(name) + i] * 2 ** (8 * i); return v; };
const status = () => m.screenText().split('\n')[28];
const message = () => m.screenText().split('\n')[29].trim();
frames(60);

// load a text into the editor (F3), assemble it (F9); the bytes from $33:0000
function onDevice(name, text, frm = 600) {
  m.drives[1].set(name, Buffer.from(text, 'latin1'));
  hold(0x04); frames(20);
  if (/LOAD ANYWAY/.test(m.screenText())) { m.pushKey(89); frames(20); }
  type(name.toLowerCase() + '\n'); frames(60);
  hold(0x01); frames(frm);                                                   // F9
  const size = g('G_nasm_asmsize'), origin = g('G_nasm_asmorigin');
  return { msg: message(), size, origin, bytes: Array.from(m.mem.subarray(0x330000, 0x330000 + size)) };
}
function compare(what, dev, pc) {
  const a = dev.bytes, b = Array.from(pc.bytes);
  let d = -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { d = i; break; }
  check(`${what}: ${b.length} bytes, same as the PC assembler`, d < 0 && dev.origin === pc.origin && /^OK/.test(dev.msg),
    `${dev.msg}\norigin ${dev.origin.toString(16)} vs ${pc.origin.toString(16)}, size ${a.length} vs ${b.length}` +
    (d >= 0 ? `, first difference at +${d}: ${a.slice(d, d + 6).map(x => x?.toString(16))} vs ${b.slice(d, d + 6).map(x => x.toString(16))}` : ''));
}

// ---- 65C816: every instruction in every mode it has
const lines = ['; every 65C816 instruction', '* = $2000', 'zp = $12', 'ab = $1234', 'lg = $123456', 'start'];
const G1 = ['ora', 'and', 'eor', 'adc', 'sta', 'lda', 'cmp', 'sbc'];
for (const mn of G1) {
  if (mn !== 'sta') lines.push(`\t${mn} #$1234`);
  lines.push(`\t${mn} zp`, `\t${mn} zp,x`, `\t${mn} ab`, `\t${mn} ab,x`, `\t${mn} ab,y`, `\t${mn} lg`, `\t${mn} lg,x`,
    `\t${mn} (zp)`, `\t${mn} (zp,x)`, `\t${mn} (zp),y`, `\t${mn} [zp]`, `\t${mn} [zp],y`, `\t${mn} 3,s`, `\t${mn} (5,s),y`);
}
for (const mn of ['asl', 'lsr', 'rol', 'ror', 'dec', 'inc']) lines.push(`\t${mn}`, `\t${mn} a`, `\t${mn} zp`, `\t${mn} zp,x`, `\t${mn} ab`, `\t${mn} ab,x`);
lines.push('\tbit #$8000', '\tbit zp', '\tbit zp,x', '\tbit ab', '\tbit ab,x');
lines.push('\tcpx #$100', '\tcpx zp', '\tcpx ab', '\tcpy #$100', '\tcpy zp', '\tcpy ab');
lines.push('\tldx #$200', '\tldx zp', '\tldx zp,y', '\tldx ab', '\tldx ab,y', '\tldy #$300', '\tldy zp', '\tldy zp,x', '\tldy ab', '\tldy ab,x');
lines.push('\tstx zp', '\tstx zp,y', '\tstx ab', '\tsty zp', '\tsty zp,x', '\tsty ab', '\tstz zp', '\tstz zp,x', '\tstz ab', '\tstz ab,x');
lines.push('\ttrb zp', '\ttrb ab', '\ttsb zp', '\ttsb ab');
lines.push('\tjmp ab', '\tjmp lg', '\tjmp (ab)', '\tjmp (ab,x)', '\tjmp [ab]', '\tjml lg', '\tjml [ab]', '\tjsr ab', '\tjsr (ab,x)', '\tjsr lg', '\tjsl lg');
lines.push('\tpea $1234', '\tpei (zp)', '\trep #$30', '\tsep #$20', '\tcop #$12', '\tbrk');
lines.push('back');
for (const b of ['bpl', 'bmi', 'bvc', 'bvs', 'bcc', 'bcs', 'bne', 'beq', 'bra', 'blt', 'bge']) lines.push(`\t${b} back`, `\t${b} fwd`);
lines.push('\tbrl back', '\tbrl fwd', '\tper back', '\tmvn #$01,#$02', '\tmvp $03,$04');
for (const mn of 'clc cld cli clv sec sed sei dex dey inx iny nop pha phb phd phk php phx phy pla plb pld plp plx ply rti rtl rts stp tax tay tcd tcs tdc tsc tsx txa txs txy tya tyx wai wdm xba xce'.split(' ')) lines.push(`\t${mn}`);
lines.push('fwd');
// register widths and size prefixes
lines.push('\t.as', '\t.xs', '\tlda #$12', '\tldx #$34', '\tcpy #$56', '\t.al', '\t.xl', '\tlda #$1234', '\tldx #$5678');
lines.push('\tlda @w zp', '\tlda @l zp', '\tlda @b ab', '\tlda @b #$12', '\tjmp @l later', '\tlda later', '\tlda later,x');
// directives and expressions
lines.push('\t.byte 1, $ff, %1010, \'A\', <ab, >ab, ^lg, -1');
lines.push('\t.word ab, ab+1, (ab+2)*3, ab/2, ab<<1, ab>>4, ab&$ff0, ab|$f, *');
lines.push('\t.long lg, lg-1', '\t.dword $12345678', '\t.text "HELLO", 13, 0', '\t.fill 5, $aa', '\t.align 16');
// anonymous labels
lines.push('-\tdex', '\tbne -', '\tbeq +', '\tnop', '+\tnop', '-\tinx', '-\tiny', '\tbne --', '\tbra +', '+\trts');
lines.push('later\t.byte 0');
const src816 = lines.join('\n') + '\n';
compare("65C816, every instruction and mode", onDevice("ALL816.ASM", src816, +(process.env.F || 1200)), assemble816(src816));
check('the status line says ASM 65C816', /ASM 65C816\s*$/.test(status()), status());

// ---- RV32IM
const rv = ['; every RV32IM instruction', '.schub', 'k = 100', 'big = $12345', 'start:'];
for (const mn of ['add', 'sub', 'sll', 'slt', 'sltu', 'xor', 'srl', 'sra', 'or', 'and', 'mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'])
  rv.push(`\t${mn} a0, a1, a2`);
for (const mn of ['addi', 'slti', 'sltiu', 'xori', 'ori', 'andi']) rv.push(`\t${mn} t0, t1, -5`, `\t${mn} s1, s2, 2047`);
rv.push('\tslli a0, a1, 3', '\tsrli a0, a1, 31', '\tsrai x5, x6, 7');
for (const mn of ['lb', 'lh', 'lw', 'lbu', 'lhu']) rv.push(`\t${mn} a0, 4(sp)`, `\t${mn} a1, -8(s0)`, `\t${mn} a2, (a3)`);
for (const mn of ['sb', 'sh', 'sw']) rv.push(`\t${mn} a0, 12(sp)`, `\t${mn} zero, -4(fp)`);
rv.push('back:');
for (const mn of ['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu']) rv.push(`\t${mn} a0, a1, back`, `\t${mn} t0, t1, fwd`);
rv.push('\tlui a0, 0x12345', '\tauipc t0, 1', '\tjal back', '\tjal ra, fwd', '\tjalr t0', '\tjalr ra, 8(t1)', '\tjalr a0, a1, 4');
rv.push('\tecall', '\tebreak', '\tfence', '\tnop', '\tli a0, 5', '\tli a1, -2048', '\tli a2, big', '\tli a3, later', '\tla a4, later');
rv.push('\tmv s0, sp', '\tnot a0, a1', '\tneg a0, a1', '\tseqz a0, a1', '\tsnez a0, a1', '\tj back', '\tjr t0', '\tret', '\tcall fwd', '\ttail back');
for (const mn of ['beqz', 'bnez', 'bltz', 'bgez', 'bgtz', 'blez']) rv.push(`\t${mn} a0, back`);
for (const mn of ['bgt', 'ble', 'bgtu', 'bleu']) rv.push(`\t${mn} a0, a1, fwd`);
rv.push('fwd:', '\t.byte 1, 2, k', '\t.half $1234', '\t.word big, fwd', '\t.fill 3', '\t.align 4', 'later:', '\t.word 0  # a comment');
const srcRV = rv.join('\n') + '\n';
const pcRV = assembleRV(srcRV.replace('.schub', ''), { org: 0x40400 });
pcRV.origin = 0x40400;
compare('SCHUB RV32IM, every instruction and pseudo-instruction', onDevice('ALLRV.ASM', srcRV, 1200), pcRV);
check('the status line says ASM SCHUB', /ASM SCHUB\s*$/.test(status()), status());

// ---- the examples: F5 runs them, F7 saves a .MER that runs without the cartridge
import fs from 'node:fs';
const ex = (n) => fs.readFileSync(new URL(`../examples/${n}`, import.meta.url), 'latin1');
const lineCol = () => { const x = /LINE (\d+)\s+COL (\d+)/.exec(status()); return x ? [+x[1], +x[2]] : [0, 0]; };
function f5(frm = 400) { hold(0x03); frames(frm); const scr = m.screenText(); m.pushKey(32); frames(60); return scr; }
function f7(name) { hold(0x02); frames(300); type('\n'); frames(200); return m.drives[1].get(name); }
function runMer(mer, frm = 600) {
  const x = new Meridian(roms);
  x.startProgram(x.loadMer(mer).start);
  for (let i = 0; i < frm && x.state === 'running'; i++) x.runFrame();
  return x;
}
// the examples show the mouse position until a click: run one (F5 or a .MER),
// move the mouse, look, click; returns the screen before and after the click
function mouseRun(x, frm, start) {
  const fr = (n) => { for (let i = 0; i < n && x.state === 'running'; i++) x.runFrame(); };
  start(); fr(frm);
  x.mouse.x = 0xc8; x.mouse.y = 0x64; fr(30);
  x.mouse.x = 0x123; x.mouse.y = 0xef; fr(30);
  const moved = x.screenText();
  x.mouse.b = 1; fr(10); x.mouse.b = 0; fr(frm);
  return [moved, x.screenText()];
}
const MOVED = /^X \$0123  Y \$00EF$/m;
{
  const src = ex('hello.asm');
  const dev = onDevice('HELLO.ASM', src);
  compare('examples/hello.asm', dev, assemble816(src));
  const [moved, scr] = mouseRun(m, 200, () => hold(0x03));
  check('F5 runs HELLO.ASM: it shows the mouse position on one line', /HELLO FROM THE MERIDIAN!/.test(moved) && MOVED.test(moved) && !/\$00C8/.test(moved), moved);
  check('a click ends HELLO.ASM, back to the editor', /PRESS A KEY/.test(scr), scr);
  m.pushKey(32); frames(60);
  check('the editor is back', /PROGRAM ENDED/.test(m.screenText()), m.screenText());
  const mer = f7('HELLO.MER');
  check('F7 saves HELLO.MER (load and start $002000)', !!mer && mer[0] === 0x4d && mer[4] === 0 && mer[5] === 0x20 && mer[8] === 0 && mer[9] === 0x20, m.screenText().split('\n')[29]);
  if (mer) {
    const x = new Meridian(roms);
    const [mv] = mouseRun(x, 100, () => x.startProgram(x.loadMer(mer).start));
    check('HELLO.MER runs without the cartridge, a click ends it', x.state === 'idle' && /HELLO FROM THE MERIDIAN!/.test(x.output) && MOVED.test(mv), `${x.state} ${x.message}\n${mv}`);
  }
}
{
  const dev = onDevice('HELLORV.ASM', ex('hellorv.asm'));
  check('examples/hellorv.asm assembles for SCHUB at $040400', /^OK/.test(dev.msg) && dev.origin === 0x40400 && /ASM SCHUB/.test(status()), dev.msg + '\n' + status());
  const [moved, scr] = mouseRun(m, 300, () => hold(0x03));
  check('F5 runs HELLORV.ASM on SCHUB: it reads the mouse itself', /HELLO FROM SCHUB!/.test(moved) && MOVED.test(moved), moved);
  check('a click ends HELLORV.ASM', /PRESS A KEY/.test(scr), scr);
  m.pushKey(32); frames(60);
  const mer = f7('HELLORV.MER');
  if (mer) {
    const x = new Meridian(roms);
    const [mv] = mouseRun(x, 300, () => x.startProgram(x.loadMer(mer).start));
    check('HELLORV.MER runs without the cartridge, a click ends it', x.state === 'idle' && /HELLO FROM SCHUB!/.test(x.output) && MOVED.test(mv), `${x.state} ${x.message}\n${mv}`);
  }
  else check('F7 saves HELLORV.MER', false, m.screenText().split('\n')[29]);
}
{
  // a program elsewhere in bank 0 with its entry in the middle (START), and data before it
  const src = '; t\n\t* = $3000\ntext\t.text "AT 3000", 13, 0\nSTART\tsep #$20\n\trep #$10\n\t.as\n\t.xl\n\tldx #0\n-\tlda text,x\n\tbeq +\n\tjsl $FFC1\n\tinx\n\tbra -\n+\trtl\n';
  const dev = onDevice('AT3000.ASM', src);
  compare('a program at $3000', dev, assemble816(src));
  const scr = f5();
  check('F5 starts it at START, not at its first byte', /AT 3000/.test(scr), scr);
}

// ---- errors point at their line
for (const [what, src, line, re] of [
  ['undefined symbol', '; t\n\tlda #1\n\tlda nothere\n', 3, /UNDEFINED SYMBOL NOTHERE/],
  ['unknown instruction', '; t\n\tnop\n\tnop\n\tfoo #1\n', 4, /UNKNOWN INSTRUCTION FOO/],
  ['branch out of range', '; t\nl\tnop\n\t.fill 200\n\tbne l\n', 4, /BRANCH OUT OF RANGE/],
  ['addressing mode', '; t\n\tstx $1234,x\n', 2, /ADDRESSING MODE NOT AVAILABLE/],
  ['symbol twice', '; t\na\tnop\na\tnop\n', 3, /DEFINED TWICE/],
  ['bad register (SCHUB)', '; t\n\t.schub\n\tadd a0, a1, q9\n', 3, /BAD REGISTER/],
]) {
  const dev = onDevice('ERR.ASM', src);
  check(`error: ${what}, line ${line}`, re.test(dev.msg) && new RegExp(`ERROR LINE ${line}:`).test(dev.msg) && lineCol()[0] === line, dev.msg + ' / ' + status());
}

// ---- colours for assembly
onDevice('COL.ASM', '; a comment\n\tlda #$12\t; and more\n\t.byte "AB", 7\n');
const colAt = (row, needle) => { const t = m.screenText().split('\n')[row - 1]; const c = t.indexOf(needle); return m.mem[0x400 + 2 * ((row - 1) * 80 + c) + 1] & 15; };
check('assembly colours: comment green, mnemonic white, number turquoise, directive orange, string yellow',
  colAt(2, 'comment') === 13 && colAt(3, 'lda') === 1 && colAt(3, '$12') === 3 && colAt(3, 'and more') === 13 && colAt(4, '.byte') === 8 && colAt(4, '"AB"') === 7,
  [colAt(2, 'comment'), colAt(3, 'lda'), colAt(3, '$12'), colAt(3, 'and more'), colAt(4, '.byte'), colAt(4, '"AB"')].join(',') + '\n' +
  [2, 3, 4].map(row => { let t = '', a = ''; for (let c = 0; c < 24; c++) { const o = 0x400 + 2 * ((row - 1) * 80 + c); t += String.fromCharCode(m.mem[o]); a += (m.mem[o + 1] & 15).toString(16); } return JSON.stringify(t) + ' ' + a; }).join('\n') + '\n' + m.screenText().split('\n')[1]);

check(`the editor's stack stays above its data (lowest ${minS.toString(16)} in ${minAt}, data ends ${r.info.progEnd.toString(16)})`, minS > r.info.progEnd + 128);

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
