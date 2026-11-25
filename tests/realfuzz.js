// The 65C816 real arithmetic is assembly, SCHUB's is the Pascal it was made
// from: both must give the same bits for the same random operands.
//   node tests/realfuzz.js [count]
import { build, run } from './harness.js';
const N = +(process.argv[2] || 1500);
const src = `program RealFuzz;
type TB = record case integer of 0: (r: real); 1: (l: longint); end;
var seed: longint;
    i: integer;
    a, b, c: TB;
    h: array[0..9] of longint;
    k: integer;
    li: longint;

function Rnd: longint;
begin
  seed := seed * 1103515245 + 12345;
  Rnd := (seed shr 8) and $FFFFFF;
end;

{ a real with an exponent in lo..hi, random sign and mantissa; sometimes 0 }
function R(lo, hi: integer): real;
var t: TB;
    e: longint;
begin
  if Rnd and 63 = 0 then begin t.l := 0; R := t.r; exit; end;
  e := lo + Rnd mod (hi - lo + 1);
  t.l := (e shl 23) or (Rnd and $7FFFFF);
  if Rnd and 1 = 1 then t.l := t.l or longint($80000000);
  R := t.r;
end;

procedure Mix(n: integer; v: longint);
begin
  h[n] := ((h[n] shl 5) or ((h[n] shr 27) and 31)) xor v;
end;

begin
  seed := 4711;
  for k := 0 to 9 do h[k] := 0;
  for i := 1 to ${N} do begin
    a.r := R(20, 230); b.r := R(20, 230);
    if i mod 7 = 0 then b.r := R(a.l shr 23 and 255 - 3, a.l shr 23 and 255 + 3);
    if i mod 11 = 0 then b.l := a.l xor longint($80000000);
    c.r := a.r + b.r; Mix(0, c.l);
    c.r := a.r - b.r; Mix(1, c.l);
    a.r := R(1, 200); b.r := R(1, 180);
    c.r := a.r * b.r; Mix(2, c.l);
    Mix(4, ord(a.r < b.r) + 2 * ord(a.r = b.r) + 4 * ord(a.r > b.r));
    a.r := R(40, 160); b.r := R(40, 160);
    if b.l and $7F800000 <> 0 then begin c.r := a.r / b.r; Mix(3, c.l); end;
    a.r := R(100, 157);
    Mix(5, Trunc(a.r)); Mix(6, Round(a.r));
    li := Rnd * 256 + Rnd; if Rnd and 1 = 1 then li := -li;
    c.r := li; Mix(7, c.l);
    c.r := Rnd; Mix(8, c.l);
    c.r := Sqrt(Abs(a.r)) + Sin(a.r / 1.0E7) + Exp(a.r / 1.0E9); Mix(9, c.l);
  end;
  for k := 0 to 9 do Write(h[k], ' ');
  WriteLn;
end.
`;
let fail = 0;
const out = {};
for (const t of ['m816', 'schub']) {
  const r = build(src, t);
  if (!r.ok) { console.log(t, r.errors); process.exit(1); }
  const x = run(r, { frames: 200000 });
  out[t] = x.output.trim();
  console.log(`${t.padEnd(6)} ${out[t]}  (${x.frames} frames${x.message ? ', ' + x.message : ''})`);
}
const names = ['add', 'sub', 'mul', 'div', 'compare', 'trunc', 'round', 'longint->real', 'word->real', 'sqrt/sin/exp'];
const A = out.m816.split(/\s+/), B = out.schub.split(/\s+/);
names.forEach((n, i) => { const ok = A[i] === B[i] && A[i] !== undefined; if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}: the same bits on both CPUs`); });
console.log(fail ? `${fail} failed` : 'all ok');
process.exit(fail ? 1 : 0);
