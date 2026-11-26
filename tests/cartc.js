// The C cartridge (C.MOD, node compiler/mkcart.js --c) and its disk (C.DSK,
// compiler/mkcdisk.js), driven through the keyboard: the editor starts as
// MERIDIAN C, F3 opens a NAME.C, F5 compiles it with the on-device C
// compiler (65C816, then SCHUB with Ctrl+T), an error puts the cursor on
// its line, F7 saves a standalone .MER that runs without the cartridge.
// Without the C disk a header is missing; the SCHUB build of the editor
// (started on a core with SCHUB) compiles the same bytes.
import { buildCCart } from '../compiler/mkcart.js';
import { buildCDisk, readDisk, cDiskFiles } from '../compiler/mkcdisk.js';
import { Meridian } from '../emu/meridian.js';
import { roms, startPascal816 } from './harness.js';

const r = buildCCart();
if (!r.ok) { console.log(r.errors); process.exit(1); }
let fail = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; if (extra) console.log(extra); } };

// ---- the disk: a FAT16 image whose files read back as they went in
const disk = buildCDisk();
const onDisk = readDisk(disk);
const want = cDiskFiles();
check(`C.DSK: ${disk.length} bytes, ${want.length} files (headers, library sources, examples)`,
  disk[510] === 0x55 && disk[511] === 0xaa && onDisk.size === want.length && onDisk.has('STDIO.H') && onDisk.has('MANDEL.C') &&
  want.every(([n, b]) => onDisk.has(n) && Buffer.from(onDisk.get(n)).equals(Buffer.from(b))));

const PROG = [
  '/* the on-device C compiler */',
  '#include <stdio.h>',
  '#include <string.h>',
  '#define N 6',
  'struct pt { int x, y; };',
  'static long fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }',
  'int main(void)',
  '{',
  '    struct pt p = { 3, 4 };',
  '    char buf[32];',
  '    int i;',
  '    sprintf(buf, "%s-%d", "C", p.x * p.y);',
  '    for (i = 1; i <= N; i++) printf("%ld ", fact(i));',
  '    printf("\\n%s %d\\n", buf, (int)strlen(buf));',
  '    return 0;',
  '}',
  ''].join('\n');
const OUT = /1 2 6 24 120 720\s+C-12 4/;

function machine(onSchub, withDisk = true) {
  const m = new Meridian(roms);
  m.insertCartridge(r.bytes);
  if (withDisk) for (const [n, b] of onDisk) m.drives[2].set(n, b);   // the C disk in drive 2
  if (onSchub) m.startCartridge(); else startPascal816(m);
  const frames = (n) => { for (let i = 0; i < n && m.state === 'running'; i++) m.runFrame(); };
  const type = (s) => { for (const c of s) { m.pushKey(c === '\n' ? 13 : c.charCodeAt(0)); frames(c === '\n' ? 8 : 3); } frames(30); };
  const key = (code, n = 1) => { for (let i = 0; i < n; i++) { m.pushKey(code); frames(4); } frames(10); };
  const hold = (scan, n = 4) => { m.keyState(scan, true); frames(n); m.keyState(scan, false); frames(2); };
  const ctrl = (scan) => { m.keyState(0x14, true); frames(2); hold(scan); m.keyState(0x14, false); frames(4); };
  const screen = () => m.screenText();
  const line = (n) => screen().split('\n')[n] || '';
  const until = (re, k = 3000) => { for (let i = 0; i < k && !re.test(screen()) && m.state === 'running'; i++) frames(1); return re.test(screen()); };
  const open = (name, text) => {
    m.drives[1].set(name, Buffer.from(text, 'latin1'));
    hold(0x04); frames(5);
    if (/Open another anyway/.test(screen())) { m.pushKey(89); frames(20); }
    type(name.toLowerCase() + '\n'); frames(30);
  };
  frames(120);
  return { m, frames, type, key, hold, ctrl, screen, line, until, open };
}

// ---- the 65C816 editor
{
  const { m, frames, type, key, hold, ctrl, screen, line, open } = machine(false);
  check('the C cartridge starts its editor', /^ *C +F1 help/.test(line(0)) && /Welcome to MERIDIAN C/.test(line(29)) && /#include <stdio\.h>/.test(screen()), screen());
  hold(0x03); frames(300);
  check('the starter text runs', /HELLO FROM THE MERIDIAN!/.test(screen()), screen());
  key(32); frames(30);

  open('FACT.C', PROG);
  check('F3 opens FACT.C', /Opened FACT.C/.test(screen()) && /#include <stdio.h>/.test(screen()), screen());
  check('the status line names the C target', /FACT\.C .*C 65C816/.test(line(1)), line(1));
  hold(0x03); frames(300);
  check('F5: compiled on the MERIDIAN (headers from drive 2) and run', OUT.test(screen()) && /PRESS A KEY/.test(screen()), screen());
  key(32); frames(30);
  check('back in the editor', /Program ended/.test(screen()), screen());

  ctrl(0x2c);                                   // Ctrl+T: SCHUB
  check('Ctrl+T: the C SCHUB target', /C SCHUB/.test(line(1)), line(1));
  hold(0x03); frames(300);
  check('F5 for SCHUB', OUT.test(screen()), screen());
  key(32); frames(30);
  ctrl(0x2c);
  check('Ctrl+T again: the 65C816', /C 65C816/.test(line(1)), line(1));

  // an error on line 13: an undeclared name
  key(0x1e, 30); key(0x1f, 12); key(0x01);
  type('    nothing = 1;\n');
  hold(0x01); frames(120);
  check('an error: its line in the status line', /Error line 13: undeclared: nothing/.test(line(29)) && /Ln 13 /.test(line(1)), screen());
  ctrl(0x35); frames(20);                       // Ctrl+Y: the line goes
  hold(0x01); frames(120);
  check('compiles again', /Compiled: \d+ lines/.test(line(29)), line(29));

  // F7: a standalone .MER
  hold(0x02); frames(200);
  type('\n');                                   // the name it offers: FACT
  frames(120);
  check('F7 saved FACT.MER', /Saved FACT.MER/.test(screen()) && m.drives[1].has('FACT.MER'), screen());
  const mer = m.drives[1].get('FACT.MER');
  if (mer) {
    const x = new Meridian(roms);
    const info = x.loadMer(mer);
    x.startProgram(info.start);
    for (let i = 0; i < 600 && x.state === 'running'; i++) x.runFrame();
    check('FACT.MER runs without the cartridge', OUT.test(x.output.replace(/\r/g, '\n')), x.output);
  }

  // an example from the C disk: F6 picks drive 2, F3 opens it there
  hold(0x0b); frames(10);
  check('F6: drive 2', /drive 2/.test(line(1)), line(1));
  hold(0x04); frames(5);
  if (/Open another anyway|not saved/.test(screen())) { m.pushKey(89); frames(20); }
  type('primes.c\n'); frames(30);
  check('F3 opens PRIMES.C from the C disk', /Opened PRIMES\.C/.test(line(29)) && /PRIMES\.C +drive 2/.test(line(1)), screen());
  hold(0x01); frames(400);
  check('PRIMES.C compiles', /Compiled: \d+ lines/.test(line(29)), screen());
}

// ---- no C disk: the header is missing, the message says where it is
{
  const { hold, line, open, frames, screen } = machine(false, false);
  open('FACT.C', PROG);
  hold(0x01); frames(200);
  check('without the C disk: a missing header names C.DSK', /header not found \(is the C disk C\.DSK in a drive\?\): stdio\.h/i.test(line(29)), screen());
}

// ---- the SCHUB build of the editor: the same code, F5
{
  const a = machine(false), b = machine(true);
  check('on a core with SCHUB the C cartridge starts its SCHUB editor', b.m.rv.running && /Welcome to MERIDIAN C on SCHUB/.test(b.line(29)), b.screen());
  const got = [];
  for (const x of [a, b]) {
    x.open('FACT.C', PROG);
    x.hold(0x01); x.until(/^ *(Compiled|Error)/m, 3000); x.frames(10);
    got.push({ msg: x.line(29).trim().replace(/, \d+ ms$/, ''), code: Buffer.from(x.m.mem.subarray(0x300000, 0x301000)).toString('hex') });
  }
  check(`the SCHUB editor compiles FACT.C to the same bytes (${got[1].msg})`, /^Compiled/.test(got[1].msg) && got[0].msg === got[1].msg && got[0].code === got[1].code, `${got[0].msg}\n${got[1].msg}`);
  b.hold(0x03);
  check('F5 in the SCHUB editor', b.until(OUT, 4000) && !b.m.schubFault, b.screen() + (b.m.schubFault || ''));
}

console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
