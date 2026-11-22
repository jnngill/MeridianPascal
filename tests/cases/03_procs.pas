program procs;
var g: integer;
function fact(n: integer): longint;
begin
  if n <= 1 then fact := 1 else fact := n * fact(n - 1);
end;
function fib(n: integer): integer;
begin
  if n < 2 then fib := n else fib := fib(n - 1) + fib(n - 2);
end;
procedure swap(var a, b: integer);
var t: integer;
begin t := a; a := b; b := t; end;
procedure outer(x: integer);
var y: integer;
  procedure inner(z: integer);
    procedure deepest;
    begin
      y := y + x + z;
      g := g + 1;
    end;
  begin
    deepest;
    y := y * 2;
  end;
begin
  y := 1;
  inner(10);
  writeln('Y=', y);
end;
procedure forw(n: integer); forward;
procedure back(n: integer);
begin
  if n > 0 then forw(n - 1);
  write('B', n);
end;
procedure forw(n: integer);
begin
  if n > 0 then back(n - 1);
  write('F', n);
end;
function sum3(a: integer; b: longint; c: byte): longint;
begin sum3 := a + b + c; end;
var a, b: integer;
begin
  writeln(fact(10));
  writeln(fib(15));
  a := 1; b := 2; swap(a, b); writeln(a, b);
  g := 0;
  outer(5);
  writeln('G=', g);
  forw(3); writeln;
  writeln(sum3(-1, 100000, 200));
end.
(* EXPECT
3628800
610
21
Y=32
G=1
B0F1B2F3
100199
*)
