program CartSmoke;
uses Crt, Graph, Sprites, Audio, Input, Dos, Blitter, Copper, Schub;
var s: string; i: integer; l: longint;
begin
  WriteLn('CARTRIDGE OK');
  s := 'ABC' + IntToStr(42);
  WriteLn(s, ' ', Length(s));
  l := 1;
  for i := 1 to 20 do l := l * 2;
  WriteLn(l, ' ', l div 7, ' ', -l mod 7);
  WriteLn(Copy('PASCAL', 2, 3), Pos('C', 'ABC'));
  InitGraph; PutPixel(5, 5, 9); i := GetPixel(5, 5); CloseGraph;
  WriteLn('PIXEL ', i);
end.
