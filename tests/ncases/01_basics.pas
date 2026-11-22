program Basics;
const
  N = 10;
  Title = 'ON DEVICE';
var
  i, j, k: integer;
  w: word;
  b: byte;
  l: longint;
  c: char;
  ok: boolean;
  s, t: string;
  a: array[1..10] of integer;
  m: array[0..2, 0..3] of byte;

function Fact(n: integer): longint;
begin
  if n <= 1 then Fact := 1 else Fact := n * Fact(n - 1);
end;

procedure Swap(var x, y: integer);
var h: integer;
begin
  h := x; x := y; y := h;
end;

function Twice(const s: string): string;
begin
  Twice := s + s;
end;

begin
  WriteLn(Title);
  i := 7; j := -3;
  WriteLn(i + j, ' ', i - j, ' ', i * j, ' ', i div j, ' ', i mod j);
  w := 65535; w := w + 1; WriteLn(w);
  b := 250; b := b + 10; WriteLn(b);
  l := 100000; l := l * 30; WriteLn(l, ' ', l div 7, ' ', -l);
  for i := 1 to N do a[i] := i * i;
  k := 0;
  for i := N downto 1 do k := k + a[i];
  WriteLn('SUM ', k);
  for i := 0 to 2 do for j := 0 to 3 do m[i, j] := i * 10 + j;
  WriteLn(m[2, 3], ' ', m[1, 2]);
  WriteLn(Fact(10));
  i := 1; j := 2; Swap(i, j); WriteLn(i, j);
  s := 'ABC'; t := s + 'DEF' + '!';
  WriteLn(t, ' ', Length(t));
  WriteLn(Twice('XY'));
  if s < t then WriteLn('LESS');
  if s = 'ABC' then WriteLn('EQUAL');
  c := 'q';
  if c in ['a'..'z'] then WriteLn('LOWER');
  ok := (i > 1) and (j < 5);
  WriteLn(ok, ' ', not ok);
  k := 0;
  while k < 100 do k := k + 7;
  WriteLn(k);
  repeat k := k - 30 until k < 0;
  WriteLn(k);
  for i := 1 to 10 do begin
    if i = 3 then continue;
    if i = 6 then break;
    Write(i);
  end;
  WriteLn;
  case k of
    -100..-1: WriteLn('NEG');
    0: WriteLn('ZERO');
  else
    WriteLn('POS');
  end;
  Inc(k, 10); Dec(k); WriteLn(k);
  WriteLn(Ord('A'), ' ', Chr(66), ' ', Copy('PASCAL', 2, 3), ' ', Pos('C', 'ABC'));
  WriteLn(IntToStr(-42), ' ', UpperCase('mixed'));
  WriteLn(5:4, '|', 'X':3);
end.
(* EXPECT
ON DEVICE
4 10 -21 -2 1
0
4
3000000 428571 -3000000
SUM 385
23 12
3628800
21
ABCDEF! 7
XYXY
LESS
EQUAL
LOWER
TRUE FALSE
105
-15
1245
NEG
-6
65 B ASC 3
-42 MIXED
   5|  X
*)
