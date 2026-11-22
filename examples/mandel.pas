{ Mandelbrot set in fixed-point arithmetic - build it for both targets
  and compare the time: the SCHUB RISC-V core has a hardware multiplier. }
program Mandelbrot;

uses Crt, Graph;

const
  Step = 2;          { pixel size: 1 = full 320x240, 2 = 160x120 blocks }
  MaxIter = 28;
  Shift = 12;        { fixed point 20.12 }

var
  px, py, it: integer;
  x0, y0, x, y, x2, y2, t: longint;
  start: longint;
  c: byte;

begin
  InitGraph;
  start := Frames;
  py := 0;
  while py < 240 do begin
    y0 := (longint(py - 120) * 4096 * 5) div 480;          { -1.25 .. 1.25 }
    px := 0;
    while px < 320 do begin
      x0 := (longint(px - 210) * 4096 * 7) div 640;        { -2.3 .. 1.2 }
      x := 0; y := 0; it := 0;
      repeat
        x2 := (x * x) shr Shift;
        y2 := (y * y) shr Shift;
        if x2 + y2 > 4 * 4096 then break;
        t := x2 - y2 + x0;
        y := (x * y) div 2048 + y0;      { div keeps the sign, shr would not }
        x := t;
        it := it + 1;
      until it = MaxIter;
      if it = MaxIter then c := 0 else c := 16 + (it * 8) mod 240;
      if Step = 1 then PutPixel(px, py, c) else Bar(px, py, px + Step - 1, py + Step - 1, c);
      px := px + Step;
    end;
    py := py + Step;
    if EscPressed then break;
  end;
  start := Frames - start;
  OutTextXYBg(4, 228, ' ' + IntToStr(start div 60) + '.' + IntToStr((start mod 60) div 6) + ' S ', 1, 6);
  if Target = TargetSchub then OutTextXY(80, 228, 'ON SCHUB', 7) else OutTextXY(80, 228, 'ON THE 65C816', 7);
  ReadKey;
  CloseGraph;
end.
