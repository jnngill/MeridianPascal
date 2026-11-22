program reals;
var x, y: real; i: integer;
begin
  x := 1.5; y := 2.25;
  writeln(x + y:0:2, ' ', x * y:0:3, ' ', y / x:0:2, ' ', x - y:0:2);
  writeln(trunc(7.9), ' ', round(7.5), ' ', round(-2.5), ' ', trunc(-3.7));
  x := 10; writeln(sqrt(x):0:4);
  writeln(x > 9.99, ' ', x < 9.99);
  i := 3; x := i / 4; writeln(x:0:2);
  writeln(sin(0):0:3, ' ', cos(0):0:3);
  writeln(sin(pi / 2):0:4);
  writeln(exp(1):0:4, ' ', ln(10):0:4);
  writeln(arctan(1) * 4:0:4);
  writeln(1234.5);
  writeln(-0.001:0:3);
  writeln(abs(-2.5):0:1, ' ', sqr(1.5):0:2);
  x := 0; for i := 1 to 10 do x := x + 0.1; writeln(x:0:5);
  writeln(int(3.7):0:1, ' ', frac(3.75):0:2);
end.
(* EXPECT
3.75 3.375 1.50 -0.75
7 8 -3 -3
3.1623
TRUE FALSE
0.75
0.000 1.000
1.0000
2.7183 2.3026
3.1416
 1.234500E+03
-0.001
2.5 2.25
1.00000
3.0 0.75
*)
