program arith;
var i, j: integer; w: word; b: byte; l, m: longint; s: shortint; lw: longword;
begin
  i := 7; j := -3;
  writeln(i + j, ' ', i - j, ' ', i * j);
  writeln(i div j, ' ', i mod j);
  writeln(-i div 2, ' ', -i mod 2);
  w := 65535; w := w + 1; writeln(w);
  i := 32767; i := i + 1; writeln(i);
  b := 250; b := b + 10; writeln(b);
  l := 100000; l := l * 30; writeln(l);
  m := -1234567; writeln(m div 1000, ' ', m mod 1000);
  writeln(l div m);
  writeln($FF, ' ', %1010, ' ', $1000 shr 4, ' ', 1 shl 10);
  w := 40000; writeln(w > 30000, ' ', w div 3);
  i := -5; writeln(i < 0, ' ', abs(i), ' ', sqr(i));
  writeln(odd(7), ' ', odd(8));
  writeln(hi($1234), ' ', lo($1234));
  l := $12345678; writeln(l shr 16, ' ', l and $FFFF);
  lw := 4000000000; writeln(lw);
  s := -100; writeln(s, ' ', integer(s) * 2);
  i := 1000; j := 3; writeln(i * j div 7);
  l := 70000; i := 3; writeln(l * i);
  writeln(maxint, ' ', -maxint - 1);
  writeln(ord('A'), ' ', chr(66), ' ', succ(5), ' ', pred('b'));
  i := 12; j := 10; writeln(i and j, ' ', i or j, ' ', i xor j, ' ', not i);
  l := 123456789; writeln(l mod 10, ' ', l div 10);
  writeln(5:4, '|', -5:4, '|', 123:2);
end.
(* EXPECT
4 10 -21
-2 1
-3 -1
0
-32768
4
3000000
-1234 -567
-2
255 10 256 1024
TRUE 13333
TRUE 5 25
TRUE FALSE
18 52
4660 22136
4000000000
-100 -200
428
210000
32767 -32768
65 B 6 a
8 14 6 -13
9 12345678
   5|  -5|123
*)
