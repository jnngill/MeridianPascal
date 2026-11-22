program memtest;
var screen: array[0..39] of word absolute $0400;
    b: byte; w: word; l: longint;
begin
  Mem[$03F000] := 77;
  MemW[$03F002] := 1234;
  MemL[$03F004] := 123456789;
  writeln(Mem[$03F000], ' ', MemW[$03F002], ' ', MemL[$03F004]);
  l := $03F000; b := Mem[l]; w := MemW[l + 2]; writeln(b + w);
  Mem[l + 10] := $AB; writeln(Mem[$03F00A]);
  writeln(Mem[$FFE2], '.', Mem[$FFE3]);
  screen[39] := screen[39];
  writeln(Target > 0);
end.
(* EXPECT
77 1234 123456789
1311
171
1.0
TRUE
*)
