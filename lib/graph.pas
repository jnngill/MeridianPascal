{ MERIDIAN Pascal - Graph unit
  320 x 240 bitmap graphics with 256 colours on PINSEL. The picture lives in
  chip RAM at $02:0000 (76 800 bytes, like BASIC's GRAPHIC). Filled boxes
  and clearing use the KRAN blitter. }
unit Graph;

interface

const
  GetMaxX = 319;
  GetMaxY = 239;
  GraphBase = $020000;

procedure InitGraph;              { bitmap on layer A, text hidden }
procedure InitGraphOverText;      { bitmap on layer B over the text, colour 0 transparent }
procedure CloseGraph;             { back to the text screen }
procedure ClearDevice(c: byte);
procedure PutPixel(x, y: integer; c: byte);
function  GetPixel(x, y: integer): byte;
procedure Line(x1, y1, x2, y2: integer; c: byte);
procedure HLine(x1, x2, y: integer; c: byte);
procedure VLine(x, y1, y2: integer; c: byte);
procedure Rectangle(x1, y1, x2, y2: integer; c: byte);
procedure Bar(x1, y1, x2, y2: integer; c: byte);
procedure Circle(xc, yc, r: integer; c: byte);
procedure FillCircle(xc, yc, r: integer; c: byte);
procedure Ellipse(xc, yc, rx, ry: integer; c: byte);
procedure OutTextXY(x, y: integer; const s: string; c: byte);
procedure OutTextXYBg(x, y: integer; const s: string; c, bg: byte);
procedure SetRGB(index: byte; r, g, b: byte);    { 0..15 each }
procedure SetRGB8(index: byte; r, g, b: byte);   { 0..255 each, reduced to 4 bit }
procedure ScrollUp(lines: integer; fill: byte);
procedure WaitVSync;

implementation

var
  Row: array[0..239] of longint;

procedure BuildRows;
var y: integer;
begin
  for y := 0 to 239 do Row[y] := GraphBase + longint(y) * 320;
end;

procedure KranWait;
begin
  while (Mem[$C610] and 1) <> 0 do ;
end;

procedure Set24(reg: word; v: longint);
begin
  Mem[reg] := v and 255;
  Mem[reg + 1] := (v shr 8) and 255;
  Mem[reg + 2] := (v shr 16) and 255;
end;

procedure KranFill(dst: longint; w, h: word; stride: integer; value: byte);
begin
  KranWait;
  Set24($C603, dst);
  MemW[$C606] := w;
  MemW[$C608] := h;
  MemW[$C60A] := 0;
  MemW[$C60C] := word(stride);
  Mem[$C60E] := value;
  Mem[$C60F] := 1;             { fill }
  Mem[$C610] := 1;             { start }
  KranWait;
end;

procedure WaitVSync;
var f: byte;
begin
  f := Mem[$C00F];
  while Mem[$C00F] = f do ;
end;

procedure SetLayer(base: word);
begin
  Mem[base + 1] := 0;
  Mem[base + 2] := GraphBase and 255;
  Mem[base + 3] := (GraphBase shr 8) and 255;
  Mem[base + 4] := GraphBase shr 16;
  Mem[base] := 4;               { bitmap 256 colours }
end;

procedure InitGraph;
begin
  BuildRows;
  ClearDevice(0);
  Mem[$C020] := 0;              { layer B off }
  SetLayer($C000);
end;

procedure InitGraphOverText;
begin
  BuildRows;
  ClearDevice(0);
  SetLayer($C020);
end;

procedure CloseGraph;
begin
  ResetDisplay;
end;

procedure ClearDevice(c: byte);
begin
  KranFill(GraphBase, 320, 240, 320, c);
end;

procedure PutPixel(x, y: integer; c: byte);
begin
  if (x < 0) or (x > 319) or (y < 0) or (y > 239) then exit;
  Mem[Row[y] + x] := c;
end;

function GetPixel(x, y: integer): byte;
begin
  if (x < 0) or (x > 319) or (y < 0) or (y > 239) then GetPixel := 0
  else GetPixel := Mem[Row[y] + x];
end;

procedure HLine(x1, x2, y: integer; c: byte);
var t: integer;
begin
  if x1 > x2 then begin t := x1; x1 := x2; x2 := t; end;
  if (y < 0) or (y > 239) or (x2 < 0) or (x1 > 319) then exit;
  if x1 < 0 then x1 := 0;
  if x2 > 319 then x2 := 319;
  KranFill(Row[y] + x1, x2 - x1 + 1, 1, 320, c);
end;

procedure VLine(x, y1, y2: integer; c: byte);
var t: integer;
begin
  if y1 > y2 then begin t := y1; y1 := y2; y2 := t; end;
  if (x < 0) or (x > 319) or (y2 < 0) or (y1 > 239) then exit;
  if y1 < 0 then y1 := 0;
  if y2 > 239 then y2 := 239;
  KranFill(Row[y1] + x, 1, y2 - y1 + 1, 320, c);
end;

procedure Line(x1, y1, x2, y2: integer; c: byte);
var dx, dy, sx, sy, err, e2: integer;
begin
  if y1 = y2 then begin HLine(x1, x2, y1, c); exit; end;
  if x1 = x2 then begin VLine(x1, y1, y2, c); exit; end;
  dx := abs(x2 - x1); dy := -abs(y2 - y1);
  if x1 < x2 then sx := 1 else sx := -1;
  if y1 < y2 then sy := 1 else sy := -1;
  err := dx + dy;
  repeat
    PutPixel(x1, y1, c);
    if (x1 = x2) and (y1 = y2) then exit;
    e2 := 2 * err;
    if e2 >= dy then begin err := err + dy; x1 := x1 + sx; end;
    if e2 <= dx then begin err := err + dx; y1 := y1 + sy; end;
  until false;
end;

procedure Rectangle(x1, y1, x2, y2: integer; c: byte);
begin
  HLine(x1, x2, y1, c);
  HLine(x1, x2, y2, c);
  VLine(x1, y1, y2, c);
  VLine(x2, y1, y2, c);
end;

procedure Bar(x1, y1, x2, y2: integer; c: byte);
var t: integer;
begin
  if x1 > x2 then begin t := x1; x1 := x2; x2 := t; end;
  if y1 > y2 then begin t := y1; y1 := y2; y2 := t; end;
  if x1 < 0 then x1 := 0;
  if y1 < 0 then y1 := 0;
  if x2 > 319 then x2 := 319;
  if y2 > 239 then y2 := 239;
  if (x1 > x2) or (y1 > y2) then exit;
  KranFill(Row[y1] + x1, x2 - x1 + 1, y2 - y1 + 1, 320, c);
end;

procedure Circle(xc, yc, r: integer; c: byte);
var x, y, d: integer;
begin
  x := 0; y := r; d := 1 - r;
  while x <= y do begin
    PutPixel(xc + x, yc + y, c); PutPixel(xc - x, yc + y, c);
    PutPixel(xc + x, yc - y, c); PutPixel(xc - x, yc - y, c);
    PutPixel(xc + y, yc + x, c); PutPixel(xc - y, yc + x, c);
    PutPixel(xc + y, yc - x, c); PutPixel(xc - y, yc - x, c);
    if d < 0 then d := d + 2 * x + 3
    else begin d := d + 2 * (x - y) + 5; y := y - 1; end;
    x := x + 1;
  end;
end;

procedure FillCircle(xc, yc, r: integer; c: byte);
var x, y, d: integer;
begin
  x := 0; y := r; d := 1 - r;
  while x <= y do begin
    HLine(xc - x, xc + x, yc + y, c); HLine(xc - x, xc + x, yc - y, c);
    HLine(xc - y, xc + y, yc + x, c); HLine(xc - y, xc + y, yc - x, c);
    if d < 0 then d := d + 2 * x + 3
    else begin d := d + 2 * (x - y) + 5; y := y - 1; end;
    x := x + 1;
  end;
end;

procedure Ellipse(xc, yc, rx, ry: integer; c: byte);
var i, steps: integer;
    a, s, co: real;
begin
  steps := 4 * (rx + ry);
  if steps < 16 then steps := 16;
  for i := 0 to steps - 1 do begin
    a := i * 6.2831853 / steps;
    s := Sin(a); co := Cos(a);
    PutPixel(xc + Round(co * rx), yc + Round(s * ry), c);
  end;
end;

procedure DrawChar(x, y: integer; ch: char; c, bg: byte; opaque: boolean);
var row, col: integer;
    bits: byte;
    font: longint;
begin
  font := $1800 + longint(ord(ch)) * 8;
  for row := 0 to 7 do begin
    bits := Mem[font + row];
    for col := 0 to 7 do
      if (bits and ($80 shr col)) <> 0 then PutPixel(x + col, y + row, c)
      else if opaque then PutPixel(x + col, y + row, bg);
  end;
end;

procedure OutTextXY(x, y: integer; const s: string; c: byte);
var i: integer;
begin
  for i := 1 to length(s) do DrawChar(x + (i - 1) * 8, y, s[i], c, 0, false);
end;

procedure OutTextXYBg(x, y: integer; const s: string; c, bg: byte);
var i: integer;
begin
  for i := 1 to length(s) do DrawChar(x + (i - 1) * 8, y, s[i], c, bg, true);
end;

procedure SetRGB(index: byte; r, g, b: byte);
begin
  Mem[$C008] := index;
  Mem[$C009] := ((g and 15) shl 4) or (b and 15);
  Mem[$C00A] := r and 15;
end;

procedure SetRGB8(index: byte; r, g, b: byte);
begin
  SetRGB(index, r shr 4, g shr 4, b shr 4);
end;

procedure ScrollUp(lines: integer; fill: byte);
begin
  if lines <= 0 then exit;
  if lines >= 240 then begin ClearDevice(fill); exit; end;
  KranWait;
  Set24($C600, Row[lines]);
  Set24($C603, GraphBase);
  MemW[$C606] := 320;
  MemW[$C608] := 240 - lines;
  MemW[$C60A] := 320;
  MemW[$C60C] := 320;
  Mem[$C60F] := 0;
  Mem[$C610] := 1;
  KranWait;
  KranFill(Row[240 - lines], 320, lines, 320, fill);
end;

begin
  BuildRows;
end.
