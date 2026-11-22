{ Graphics demo: lines, boxes, circles and text in 256 colours }
program GraphicsDemo;

uses Crt, Graph;

var
  i, x, y: integer;
  c: byte;

begin
  InitGraph;
  { a fan of lines in the MERIDIAN-256 colours }
  for i := 0 to 63 do
    Line(160, 239, i * 5, 0, 16 + i * 3);
  { boxes from the blitter }
  for i := 0 to 7 do
    Bar(10 + i * 38, 150, 40 + i * 38, 200, 32 + i * 24);
  { circles }
  for i := 1 to 6 do
    Circle(160, 90, i * 12, 200 + i * 4);
  FillCircle(160, 90, 8, 7);
  OutTextXYBg(72, 214, ' MERIDIAN PASCAL ', 1, 6);
  OutTextXY(80, 226, 'PRESS A KEY', 7);
  c := 0;
  { cycle a few palette entries while waiting }
  while not KeyPressed do begin
    WaitVSync;
    c := c + 1;
    SetRGB(7, c and 15, 15 - (c and 15), 8);
  end;
  CloseGraph;
  WriteLn('BACK IN TEXT MODE.');
end.
