program Mandel;
var x, y, i, n: integer;
    cr, ci, zr, zi, t: real;
begin
  n := 0;
  for y := 0 to 23 do
    for x := 0 to 39 do begin
      cr := x / 16.0 - 2.0; ci := y / 10.0 - 1.2;
      zr := 0; zi := 0; i := 0;
      while (i < 30) and (zr * zr + zi * zi < 4.0) do begin
        t := zr * zr - zi * zi + cr; zi := 2.0 * zr * zi + ci; zr := t; i := i + 1;
      end;
      n := n + i;
    end;
  WriteLn(n);
end.
