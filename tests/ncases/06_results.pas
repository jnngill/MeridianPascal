program Results;
type
  TPoint = record x, y: integer; end;
  TVec = array[1..3] of integer;
  TDigits = set of 0..9;
  TName = record first: string[10]; age: byte; end;
var
  p, q: TPoint;
  v: TVec;
  d: TDigits;
  i: integer;
  n: TName;
  w: word;
  b0: byte absolute w;
  same: TPoint absolute p;
  counter: longint;
  alias: longint absolute counter;
  far: word absolute $310000;

function Pt(x, y: integer): TPoint;
begin
  Result.x := x; Result.y := y;
end;

function Add(const a, b: TPoint): TPoint;
var r: TPoint;
begin
  r.x := a.x + b.x; r.y := a.y + b.y;
  Add := r;
end;

function Squares: TVec;
var i: integer;
begin
  for i := 1 to 3 do Result[i] := i * i;
end;

function Evens(upto: integer): TDigits;
var i: integer;
begin
  Result := [];
  i := 0;
  while i <= upto do begin Result := Result + [i]; i := i + 2; end;
end;

function Person(const s: string; a: byte): TName;
begin
  Result.first := s; Result.age := a;
end;

function Fib(k: integer): TPoint;   { recursive, a record result per level }
var r: TPoint;
begin
  if k = 0 then begin r.x := 0; r.y := 1; end
  else begin r := Fib(k - 1); i := r.x; r.x := r.y; r.y := i + r.y; end;
  Fib := r;
end;

procedure Show(a: TPoint);
begin
  WriteLn(a.x, ',', a.y);
end;

begin
  p := Pt(3, 4);
  q := Add(p, Pt(10, 20));
  WriteLn(p.x, ' ', p.y, ' ', q.x, ' ', q.y);
  Show(Add(q, q));
  WriteLn(Pt(7, 8).y, ' ', Add(p, p).x + 1);
  v := Squares;
  WriteLn(v[1], ' ', v[2], ' ', v[3], ' ', Squares[3]);
  d := Evens(7);
  for i := 0 to 9 do if i in d then Write(i);
  WriteLn(' ', 6 in Evens(6), ' ', 7 in Evens(9));
  n := Person('ADA', 36);
  WriteLn(n.first, ' ', n.age, ' ', Person('BOB', 7).first);
  WriteLn(Fib(10).x);
  w := $1234;
  WriteLn(b0, ' ', same.x + same.y);
  b0 := 0; WriteLn(w);
  counter := 5; Inc(alias, 10); WriteLn(counter);
  far := 4242; WriteLn(MemW[$310000], ' ', far);
end.
(* EXPECT
3 4 13 24
26,48
8 7
1 4 9 9
0246 TRUE FALSE
ADA 36 BOB
55
52 7
4608
15
4242 4242
*)
