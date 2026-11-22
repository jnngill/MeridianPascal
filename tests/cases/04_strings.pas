program strs;
var s, t: string; u: string[5]; i, code: integer; l: longint; c: char;
function rev(const x: string): string;
var i: integer;
begin
  Result := '';
  for i := length(x) downto 1 do Result := Result + x[i];
end;
begin
  s := 'Hello';
  t := s + ', ' + 'World';
  writeln(t, ' ', length(t));
  writeln(copy(t, 8, 5));
  writeln(pos('World', t), ' ', pos('xyz', t));
  u := t; writeln(u);
  delete(t, 6, 7); writeln(t);
  insert(' there', t, 6); writeln(t);
  writeln(upcase('a'), UpperCase(t));
  s := 'abc'; t := 'abd';
  writeln(s < t, ' ', s = 'abc', ' ', s > t, ' ', 'b' > s);
  str(12345, s); writeln(s, length(s));
  str(-42:6, s); writeln('[', s, ']');
  val('1234', i, code); writeln(i + 1, ' ', code);
  val('12x4', i, code); writeln(code);
  val('-99999', l, code); writeln(l);
  writeln(rev('PASCAL'));
  s := ''; for c := 'A' to 'Z' do s := s + c;
  writeln(s);
  s[1] := 'z'; writeln(s[1], s[26], ord(s[0]));
  writeln(IntToStr(-7) + '/' + IntToHex(255, 4));
  writeln(Trim('   x y  '), '|');
  writeln(StringOfChar('*', 5));
  writeln(concat('a', 'b', 'c'));
  s := 'x'; if s = 'x' then writeln('CHAR EQ');
end.
(* EXPECT
Hello, World 12
World
8 0
Hello
Hello
Hello there
AHELLO THERE
TRUE TRUE FALSE TRUE
123455
[   -42]
1235 0
3
-99999
LACSAP
ABCDEFGHIJKLMNOPQRSTUVWXYZ
zZ26
-7/00FF
x y|
*****
abc
CHAR EQ
*)
