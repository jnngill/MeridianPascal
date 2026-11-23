program OpenArrays;
{ open array parameters: any array of the element type, indexed from 0 }
type TName = string[8];
var a: array[1..5] of integer;
    b: array[10..12] of integer;
    n: array[0..2] of TName;
    i: integer;

function Sum(const v: array of integer): longint;
var k: integer;
    s: longint;
begin
  s := 0;
  for k := 0 to High(v) do s := s + v[k];
  Sum := s;
end;

procedure Twice(var v: array of integer);
var k: integer;
begin
  for k := Low(v) to High(v) do v[k] := v[k] * 2;
end;

function Count(const v: array of integer): integer;
begin
  Count := High(v) + 1;            { passed on }
end;

function Inner(const v: array of integer): integer;
begin
  Inner := Count(v) * 10 + SizeOf(v);
end;

procedure Show(const s: array of TName);
var k: integer;
begin
  for k := 0 to High(s) do Write(s[k], ' ');
  WriteLn;
end;

{$R+}
procedure Bad(const v: array of integer);
var k: integer;
begin
  k := 3;
  WriteLn(v[k]);
end;

begin
  for i := 1 to 5 do a[i] := i;
  b[10] := 7; b[11] := 8; b[12] := 9;
  WriteLn('SUM ', Sum(a), ' ', Sum(b));
  Twice(a);
  WriteLn('TWICE ', a[1], ' ', a[5], ' ', Sum(a));
  WriteLn('INNER ', Inner(b));
  n[0] := 'ONE'; n[1] := 'TWO'; n[2] := 'SIX';
  Show(n);
{$R+}
  i := 0;
  WriteLn(Sum(a));
  Twice(b);
  WriteLn('B ', b[12]);
  Bad(b);
  WriteLn('NOT REACHED');
end.

(* EXPECT
SUM 15 24
TWICE 2 10 30
INNER 36
ONE TWO SIX
30
B 18

RUNTIME ERROR 201
*)
