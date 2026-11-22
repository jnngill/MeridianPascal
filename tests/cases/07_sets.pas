program sets;
type TColor = (Red, Green, Blue, Yellow);
     TColors = set of TColor;
var a, b, c: set of byte; cs: TColors; ch: char; i, n: integer; col: TColor;
begin
  a := [1, 3, 5..8];
  b := [5, 6, 20];
  c := a + b; n := 0; for i := 0 to 30 do if i in c then n := n + 1;
  writeln(n);
  c := a * b; for i := 0 to 30 do if i in c then write(i, ' ');
  writeln;
  c := a - b; for i := 0 to 30 do if i in c then write(i, ' ');
  writeln;
  include(c, 30); exclude(c, 1);
  writeln(30 in c, ' ', 1 in c);
  cs := [Red, Blue];
  for col := Red to Yellow do if col in cs then write(ord(col));
  writeln;
  ch := 'q';
  if ch in ['a'..'z', '_'] then writeln('LETTER');
  if not (ch in ['0'..'9']) then writeln('NOT DIGIT');
  writeln([1, 2] = [2, 1], ' ', [1] <= [1, 2], ' ', [1, 3] <= [1, 2]);
  i := 4;
  if i in [i - 1 .. i + 1] then writeln('RANGE');
end.
(* EXPECT
7
5 6
1 3 7 8
TRUE FALSE
02
LETTER
NOT DIGIT
TRUE TRUE FALSE
RANGE
*)
