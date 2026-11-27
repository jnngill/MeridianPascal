// The Schub unit on a core without SCHUB (the plain MERIDIAN 816 core):
// there $CD09 is not decoded and reads $FF, so status bits alone would claim
// a running co-processor. SchubStop/SchubStart/SchubCall must return at once
// and SchubRunning must be false, and SchubCall must give 0, not the result a
// SCHUB-core run left in the mailbox ($FE:1800 survives a core switch). Also
// checked on the SCHUB core, where nothing at $08:0000 answers.
//   node tests/noschub.js
import { Meridian } from '../emu/meridian.js';
import { roms, build } from './harness.js';

let fail = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fail++; if (extra) console.log(extra); } };

const src = `program NoSchub; uses Schub;
begin
  writeln('P', ord(SchubPresent), ' R', ord(SchubRunning), ' S', SchubStatus);
  SchubStop; writeln('STOP OK');
  SchubStart($080000); writeln('START OK');
  writeln('CALL ', SchubCall(0, 6, 7, 0));
end.
`;
const res = build(src);
for (const [schub, first] of [[false, 'P0 R0 S255'], [true, 'P1 R0 S128']]) {
  const m = new Meridian(roms, { schub });
  m.write(0xfe1814, 0xd6); m.write(0xfe1815, 0x08);   // stale result 2262
  m.startProgram(m.loadMer(res.mer).start);
  let f = 0;
  for (; f < 300 && m.state === 'running'; f++) m.runFrame();
  const want = `${first}\nSTOP OK\nSTART OK\nCALL 0\n`;
  check(`${schub ? 'SCHUB core' : 'plain core'}: Schub unit returns`, m.state !== 'running' && m.output === want, JSON.stringify(m.output));
}
if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('noschub: all ok');
