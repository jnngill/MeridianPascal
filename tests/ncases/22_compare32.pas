program Cmp32;
{ 32-bit compares: every relation, with variables and constants on both sides, around the sign and the words }
const N = 12;
var v: array[0..11] of longint;
    i, j, r: integer;
    h: longint;
    a, b: longint;
begin
  v[0] := 0; v[1] := 1; v[2] := -1; v[3] := 65535; v[4] := 65536; v[5] := -65536;
  v[6] := 2147483647; v[7] := -2147483647 - 1; v[8] := 100000; v[9] := -100000; v[10] := 32768; v[11] := -32769;
  h := 0;
  for i := 0 to N - 1 do for j := 0 to N - 1 do begin
    a := v[i]; b := v[j];
    r := ord(a < b) + 2 * ord(a <= b) + 4 * ord(a > b) + 8 * ord(a >= b) + 16 * ord(a = b) + 32 * ord(a <> b);
    if a < b then r := r + 64;
    if a > b then r := r + 128;
    if (a <= b) and (a >= b) then r := r + 256;
    h := h * 5 + r;
  end;
  for i := 0 to N - 1 do begin
    a := v[i];
    r := ord(a < 65536) + 2 * ord(a > -65536) + 4 * ord(100000 < a) + 8 * ord(-1 >= a) + 16 * ord(a = 2147483647) + 32 * ord(a <> 0);
    h := h * 5 + r;
  end;
  WriteLn(h);
end.
(* EXPECT
-511967239
*)
