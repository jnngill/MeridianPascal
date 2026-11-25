program Check;
{ results the code generator must get right: 32-bit compares and shifts,
  multiplies by constants }
var a, b: longint;
    w, v: integer;
    u: word;
    i, n: integer;
    h: longint;
begin
  h := 0;
  for i := -40 to 40 do begin
    a := longint(i) * 123457 - 7; b := longint(i) * -98765 + 3;
    n := ord(a < b) + 2 * ord(a <= b) + 4 * ord(a > b) + 8 * ord(a >= b) + 16 * ord(a = b) + 32 * ord(a <> b)
       + 64 * ord(a < 1000) + 128 * ord(a > -1000) + 256 * ord(a <= 2147483647) + 512 * ord(a >= -5);
    if longword(a) < longword(b) then n := n + 1024;
    if longword(a) > 4000000000 then n := n + 2048;
    h := h * 31 + n + (a shl 3) + (a shr 5) + (a shl 13) + (a shr 19) + (a shl 24) + (b shr 16) + (b shl 17) + a * 8 + b * 65536;
    w := i * 37; v := i * 5 + w * 320 + i * 3 + w * 2;
    u := word(i) * 1025;
    h := h + v + u + w * 7 + (w * v);
  end;
  WriteLn(h);
end.
