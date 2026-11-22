program inp;
var s: string; i, j: integer;
begin
  write('NAME? '); readln(s);
  writeln('HI ', s);
  write('TWO NUMBERS? '); readln(i, j);
  writeln(i + j);
end.
(* KEYS:BOB\r12 30\r *)
(* EXPECT
NAME? BOB
HI BOB
TWO NUMBERS? 12 30
42
*)
