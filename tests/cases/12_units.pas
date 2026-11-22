program units;
uses Crt, Graph, Sprites, Audio, Input, Dos, Blitter, Copper, Schub;
var i: integer; n: string; sz, t: longint; buf: array[0..9] of byte;
begin
  GotoXY(5, 3); write('X'); writeln(WhereX, ' ', WhereY);
  InitGraph;
  PutPixel(10, 20, 5); write(GetPixel(10, 20), ' ');
  Bar(0, 0, 9, 9, 7); write(GetPixel(5, 5), ' ');
  Line(0, 100, 50, 100, 3); write(GetPixel(25, 100), ' ');
  Line(0, 0, 30, 15, 9); writeln(GetPixel(30, 15));
  CloseGraph;
  SetPatternRow(0, 0, 'F0F0F0F0F0F0F0F0');
  SetSprite(0, 100, 50, 0, 1);
  writeln(SpriteX(0), ' ', SpriteY(0));
  SetVoice(0, wTriangle, 1, 1, 10, 2);
  SetNote(0, 69);
  writeln(NoteFreq(69), ' ', MemW[$C500]);
  writeln(Joy(1), ' ', KeyDown(scA));
  for i := 0 to 9 do buf[i] := i * 3;
  writeln(SaveFile('TEST.BIN', VarAddr(@buf), 10));
  if DirEntry(0, n, sz) then writeln(n, ' ', sz);
  FillChar(buf, 10, 0);
  writeln(LoadFile('TEST.BIN', VarAddr(@buf), 100), ' ', buf[9]);
  writeln(LoadFile('NOPE', VarAddr(@buf), 100), ' ', DosErrorText(DosError));
  FillMem($03F100, 16, $AA); write(Mem[$03F10F], ' ');
  CopyMem($03F100, $03F200, 16); writeln(Mem[$03F205]);
  CopBegin(CopperBase); CopWait(100); CopColor(0, 15, 0, 0); CopEnd;
  writeln(CopSize);
  writeln(SchubPresent);
  t := Micros; Delay(10); writeln(Micros - t >= 10000);
end.
(* EXPECT
X6 3
5 7 3 9
100 50
440 7381
0 FALSE
TRUE
TEST.BIN 10
10 27
-1 FILE NOT FOUND
170 170
12
TRUE
TRUE
*)
