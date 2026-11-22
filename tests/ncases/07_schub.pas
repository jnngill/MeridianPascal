{$SCHUB}
program OnSchub;
type
  PNode = ^TNode;
  TNode = record v: longint; next: PNode; end;
  TBig = array[0..59999] of byte;
  TRec = record b: byte; l: longint; w: word; c: char; end;
var
  a, b, c: TBig;             { 180 KB of variables: more than bank 0 could hold }
  i: integer;
  l, sum: longint;
  p, q: PNode;
  r: TRec;
  w: word;
  s: string;

function Fact(n: integer): longint;
begin
  if n <= 1 then Fact := 1 else Fact := n * Fact(n - 1);
end;

procedure Outer(k: integer);
var base: longint;
  procedure Inner(j: integer);
  begin
    base := base + j * k;
  end;
begin
  base := 1000;
  Inner(1); Inner(2);
  WriteLn('NESTED ', base);
end;

begin
  WriteLn('SCHUB ', SizeOf(pointer), ' ', SizeOf(TRec), ' ', SizeOf(TBig));
  for l := 0 to 59999 do begin a[l] := l and 255; b[l] := 255 - (l and 255); end;
  sum := 0;
  for l := 0 to 59999 do begin c[l] := a[l] + b[l]; sum := sum + c[l]; end;
  WriteLn('BIG ', sum, ' ', c[0], ' ', c[59999]);
  WriteLn('FACT ', Fact(12), ' ', 100000 * 3 div 7, ' ', -7 mod 3);
  p := nil;
  for i := 1 to 1000 do begin New(q); q^.v := i; q^.next := p; p := q; end;
  sum := 0;
  while p <> nil do begin sum := sum + p^.v; q := p; p := p^.next; Dispose(q); end;
  WriteLn('LIST ', sum);
  r.b := 1; r.l := 123456789; r.w := 65535; r.c := 'Z';
  WriteLn('REC ', r.b, ' ', r.l, ' ', r.w, ' ', r.c);
  w := 65535; w := w + 1; i := 32767; i := i + 1;
  WriteLn('WRAP ', w, ' ', i);
  Outer(10);
  s := 'SCH' + 'UB';
  for i := 1 to 3 do s := s + '!';
  WriteLn(s, ' ', Length(s), ' ', Pos('UB', s), ' ', Copy(s, 2, 3));
  WriteLn(Mem[$CD00], ' ', Chr(Mem[$CD01]));
end.
(* EXPECT
SCHUB 4 12 60000
BIG 15300000 255 255
FACT 479001600 42857 -1
LIST 500500
REC 1 123456789 65535 Z
WRAP 0 -32768
NESTED 1030
SCHUB!!! 8 4 CHU
83 C
*)
