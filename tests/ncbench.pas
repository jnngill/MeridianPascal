program NcBench;
{ timed sections for the on-device compiler: frames per section and a check value }
uses Crt;
type TCell = record x, y: integer; v: byte; end;
var i, j, n, sum, w: integer;
    x, y: real;
    s, t, f: longint;
    g: array[0..23, 0..39] of TCell;
    flags: array[0..4095] of boolean;
begin
  f := Frames; sum := 0;
  for n := 1 to 2 do
    for i := 0 to 23 do
      for j := 0 to 39 do begin
        g[i, j].x := j; g[i, j].y := i; g[i, j].v := (i * 3 + j * 5 + n) and 255;
        sum := sum + g[i, j].v;
      end;
  WriteLn('GRID  ', sum, ' ', Frames - f);
  f := Frames; s := 0; t := 1;
  for i := 1 to 5000 do begin
    s := s + longint(i) * 4 + (longint(i) shr 3) + (longint(i) shl 9);
    if s > 100000000 then s := s - 99999999;
    t := (t * 33 + i) and $FFFFFF;
  end;
  WriteLn('LONG  ', s, ' ', t, ' ', Frames - f);
  f := Frames; n := 0;
  for i := 0 to 4095 do flags[i] := true;
  for i := 0 to 4095 do
    if flags[i] then begin
      j := i + i + 3;
      while i + j <= 4095 do begin flags[i + j] := false; j := j + i + i + 3; end;
      n := n + 1;
    end;
  WriteLn('SIEVE ', n, ' ', Frames - f);
  f := Frames; w := 0;
  for i := 1 to 3000 do w := w + i * 10 + i * 7 - (i * 320) div 64;
  WriteLn('MUL   ', w, ' ', Frames - f);
  f := Frames; y := 0;
  for i := 1 to 300 do begin x := i / 7.0; y := y + x * x - Sin(x); end;
  WriteLn('REAL  ', y:0:3, ' ', Frames - f);
end.
