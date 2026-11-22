program control;
var i, j, n: integer; c: char;
function classify(x: integer): string;
begin
  case x of
    0: classify := 'ZERO';
    1, 2, 3: classify := 'SMALL';
    4..9: classify := 'MEDIUM';
    -5..-1: classify := 'NEG';
  else
    classify := 'BIG';
  end;
end;
begin
  for i := 1 to 3 do write(i, ' ');
  writeln;
  for i := 3 downto 1 do write(i);
  writeln;
  i := 0;
  while i < 5 do begin i := i + 2; end;
  writeln(i);
  repeat i := i - 1 until i <= 2;
  writeln(i);
  n := 0;
  for i := 1 to 10 do begin
    if i = 3 then continue;
    if i = 7 then break;
    n := n + i;
  end;
  writeln(n);
  writeln(classify(0), ' ', classify(2), ' ', classify(7), ' ', classify(-3), ' ', classify(50));
  n := 0;
  for i := 1 to 5 do for j := 1 to i do n := n + 1;
  writeln(n);
  for c := 'a' to 'e' do write(c);
  writeln;
  if (n > 10) and (n < 20) then writeln('IN') else writeln('OUT');
  if (n < 10) or (n = 15) then writeln('YES');
  if not (n = 15) then writeln('NO') else writeln('NOT NO');
  i := 10;
  for i := i to i + 2 do write(i, ',');
  writeln;
  for i := 5 to 4 do writeln('NEVER');
  writeln('END');
end.
(* EXPECT
1 2 3
321
6
2
18
ZERO SMALL MEDIUM NEG BIG
15
abcde
IN
YES
NOT NO
10,11,12,
END
*)
