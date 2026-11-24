program Gotos;
{ goto and label: backwards, forwards, out of a loop, numbers and names }
label 10, done, next;
var i, n, c: integer;

procedure P;
label again;
var k: integer;
begin
  k := 0;
again:
  k := k + 1;
  if k < 3 then goto again;
  WriteLn('P ', k);
end;

begin
  i := 0;
10:
  i := i + 1;
  if i < 5 then goto 10;
  WriteLn('I ', i);
  for n := 1 to 100 do
    if n = 7 then goto done;
  WriteLn('NOT REACHED');
done:
  WriteLn('N ', n);
  P;
  { out of the inner loop to the end of the outer one, many times: the
    stack must not grow }
  c := 0;
  for i := 1 to 2000 do begin
    for n := 1 to 10 do
      if n = 3 then goto next;
    c := c - 1;
  next:
    c := c + 1;
  end;
  WriteLn('C ', c);
end.

(* EXPECT
I 5
N 7
P 3
C 2000
*)
