program Grid;
type TCell = record x, y: integer; v: byte; end;
var g: array[0..23, 0..39] of TCell;
    r, c, n, sum: integer;
begin
  sum := 0;
  for n := 1 to 10 do
    for r := 0 to 23 do
      for c := 0 to 39 do begin
        g[r, c].x := c; g[r, c].y := r; g[r, c].v := (r * 3 + c * 5 + n) and 255;
        sum := sum + g[r, c].v;
      end;
  WriteLn(sum);
end.
