program ConstMul;
{ multiplies by constants (shifts and adds) and 32-bit shifts by constants }
type TRec = record a: integer; b: byte; c: integer; end;     { 5 bytes }
     TRec2 = record r: array[0..2] of integer; end;         { 6 bytes }
var i, x: integer;
    w: word;
    l, m: longint;
    h: longint;
    g: array[0..3, 0..9] of TRec;
    q: array[0..4] of TRec2;
begin
  h := 0;
  for i := -20 to 20 do begin
    x := i * 37;
    h := h * 7 + x * 3 + 3 * x + x * 10 + x * 320 + x * 1025 + x * 7 + x * 15 + x * 0 + x * 1 + x * (-1) + 5 * x;
    w := word(i + 100) * 6;
    h := h + w;
    l := longint(i) * 98765 - 4;
    m := l * 33 + 33 * l + l * 8 + 8 * l + l * 4096 + l * 5000 + l * 10 + 10 * l + l * (-3) + l * 1;
    h := h + m + (l shl 1) + (l shl 7) + (l shl 8) + (l shl 9) + (l shl 15) + (l shl 16) + (l shl 17) + (l shl 24) + (l shl 31) + (l shl 0);
    h := h + (l shr 1) + (l shr 7) + (l shr 8) + (l shr 9) + (l shr 15) + (l shr 16) + (l shr 17) + (l shr 24) + (l shr 31);
  end;
  WriteLn(h);
  for i := 0 to 3 do for x := 0 to 9 do begin g[i, x].a := i * 100 + x; g[i, x].b := x; g[i, x].c := -i; end;
  h := 0;
  for i := 0 to 3 do for x := 0 to 9 do h := h * 3 + g[i, x].a + g[i, x].b + g[i, x].c;
  for i := 0 to 4 do for x := 0 to 2 do q[i].r[x] := i * 10 + x;
  for i := 0 to 4 do for x := 0 to 2 do h := h * 3 + q[i].r[x];
  WriteLn(h);
end.
(* EXPECT
-859387425
-949800175
*)
