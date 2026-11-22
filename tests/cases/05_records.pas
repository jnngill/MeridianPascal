program recs;
type
  TPoint = record x, y: integer; end;
  TShape = record
    name: string[10];
    pts: array[1..3] of TPoint;
    color: byte;
  end;
  TGrid = array[0..2, 0..3] of integer;
var p, q: TPoint; s: TShape; sh: array[1..2] of TShape; g: TGrid; i, j: integer;
const primes: array[1..5] of integer = (2, 3, 5, 7, 11);
      origin: TPoint = (x: 10; y: -20);
      names: array[0..2] of string[5] = ('RED', 'GREEN', 'BLUE');
procedure show(const pt: TPoint);
begin writeln('(', pt.x, ',', pt.y, ')'); end;
function dist2(a, b: TPoint): longint;
begin dist2 := longint(a.x - b.x) * (a.x - b.x) + longint(a.y - b.y) * (a.y - b.y); end;
begin
  p.x := 3; p.y := 4;
  q := p; q.x := q.x + 10;
  show(p); show(q);
  writeln(dist2(p, q));
  s.name := 'TRI';
  for i := 1 to 3 do begin s.pts[i].x := i; s.pts[i].y := i * i; end;
  sh[2] := s;
  sh[2].pts[3].y := 99;
  writeln(sh[2].name, sh[2].pts[2].y, s.pts[3].y, sh[2].pts[3].y);
  with sh[2] do begin color := 7; writeln(name, color); end;
  with p do writeln(x + y);
  for i := 0 to 2 do for j := 0 to 3 do g[i, j] := i * 10 + j;
  writeln(g[2, 3], ' ', g[1][2]);
  j := 0; for i := 1 to 5 do j := j + primes[i];
  writeln(j);
  show(origin);
  writeln(names[1], length(names[2]));
  writeln(sizeof(TPoint), ' ', sizeof(g));
end.
(* EXPECT
(3,4)
(13,4)
100
TRI4999
TRI7
7
23 12
28
(10,-20)
GREEN4
4 24
*)
