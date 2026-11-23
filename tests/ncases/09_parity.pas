program Parity;
{ what the PC compiler had and the on-device compiler lacked: conditional
  compilation and include files, Val, Concat, GetMem/FreeMem, Swap, Addr,
  += and -=, Exit(value), record constants, initialised variables, Succ,
  Pred and not on longints, string casts, arrays with more than 4 dimensions }
{$DEFINE FOO}
type
  TPoint = record x, y: integer; end;
  TA5 = array[1..2, 1..2, 1..2, 1..2, 1..2] of byte;
const
  Origin: TPoint = (x: 3; y: 4);
  Corners: array[1..2] of TPoint = ((x: 1; y: 2), (x: 5; y: 6));
var
  k: integer = 5;
  big: longint = 100000;
  name: string[10] = 'PASCAL';
  l: longint;
  s, t: string;
  i, code: integer;
  r: real;
  p: pointer;
  pb: ^byte;
  pk: ^integer;
  a5: TA5;
  w: word;
  ar: array[1..3] of integer;
  rr: array[1..2] of real;

function Twice(n: integer): integer;
begin
  if n > 0 then Exit(n * 2);
  Twice := -1;
end;

function Name2: string;
begin
  Exit('NAMED');
end;

begin
{$IFDEF FOO}
  WriteLn('FOO');
{$ELSE}
  WriteLn('NOT FOO');
{$ENDIF}
{$IFNDEF BAR}
  WriteLn('NO BAR');
{$ELSE}
  WriteLn('BAR');
{$ENDIF}
{$UNDEF FOO}
{$IFDEF FOO}
  WriteLn('STILL FOO');
{$ENDIF}
{$IFDEF MERIDIAN}
  WriteLn('MERIDIAN');
{$ENDIF}
{$I PARITY.INC}
  WriteLn('K ', k, ' ', big, ' ', name);
  WriteLn('ORIGIN ', Origin.x, ' ', Origin.y, ' ', Corners[2].x + Corners[2].y);
  Val('1234', i, code); WriteLn('VAL ', i, ' ', code);
  Val('12X', i, code); WriteLn('VAL ', code);
  Val('2.5', r, code); WriteLn('VAL ', r:4:1, ' ', code);
  Val('70000', l, code); WriteLn('VAL ', l, ' ', code);
  s := Concat('AB', 'CD', 'E'); WriteLn(s, ' ', Length(Concat(s, s)));
  GetMem(p, 10); pb := p; pb^ := 77; WriteLn('GETMEM ', pb^); FreeMem(p, 10);
  w := $1234; WriteLn('SWAP ', Swap(w) = $3412);
  i := $0102; WriteLn('SWAPI ', Swap(i));
  pk := Addr(k); WriteLn('ADDR ', pk^);
  i := 10; i += 5; i -= 2; WriteLn('PLUSEQ ', i);
  l := 100000; l += 1; l -= 3; WriteLn('PLUSEQL ', l);
  s := 'AB'; s += 'CD'; WriteLn('PLUSEQS ', s);
  WriteLn('EXIT ', Twice(21), ' ', Twice(0), ' ', Name2);
  l := 65535; l := Succ(l); WriteLn('SUCC ', l); l := Pred(l); WriteLn('PRED ', l);
  l := not l; WriteLn('NOT ', l);
  t := 'XY'; s := string(t); WriteLn('CAST ', s);
  ar[2] := 1; ar[2] += 4; i := 3; Val('77', ar[i], code); Val('1.5', rr[2], code); rr[2] -= 0.25;
  WriteLn('IDX ', ar[2], ' ', ar[3], ' ', rr[2]:5:2);
  l := $12345678; WriteLn('SWAPL ', Swap(l) = $7856);
  a5[2, 2, 2, 2, 2] := 9; a5[1, 2, 1, 2, 1] := 4; WriteLn('A5 ', a5[2, 2, 2, 2, 2] + a5[1, 2, 1, 2, 1], ' ', SizeOf(a5));
end.

(* EXPECT
FOO
NO BAR
MERIDIAN
INCLUDED
K 5 100000 PASCAL
ORIGIN 3 4 11
VAL 1234 0
VAL 3
VAL  2.5 0
VAL 70000 0
ABCDE 10
GETMEM 77
SWAP TRUE
SWAPI 513
ADDR 5
PLUSEQ 13
PLUSEQL 99998
PLUSEQS ABCD
EXIT 42 -1 NAMED
SUCC 65536
PRED 65535
NOT -65536
CAST XY
IDX 5 77  1.25
SWAPL TRUE
A5 13 32
*)

(* FILE PARITY.INC
  WriteLn('INCLUDED');
*)
