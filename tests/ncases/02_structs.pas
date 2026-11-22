program Structs;
uses Crt, Graph;
type
  TPoint = record x, y: integer; end;
  PNode = ^TNode;
  TNode = record value: integer; next: PNode; end;
  TDay = (Mon, Tue, Wed, Thu, Fri);
  TName = string[8];
const
  Primes: array[1..5] of integer = (2, 3, 5, 7, 11);
  Names: array[0..2] of TName = ('RED', 'GREEN', 'BLUE');
var
  p, q: TPoint;
  pts: array[1..3] of TPoint;
  head, n: PNode;
  i, sum: integer;
  d: TDay;
  hours: array[Mon..Fri] of integer;
  nm: TName;
  l: longint;

procedure Show(const pt: TPoint);
begin
  WriteLn('(', pt.x, ',', pt.y, ')');
end;

function Shout(s: string): string;
var i: integer;
begin
  for i := 1 to Length(s) do s[i] := UpCase(s[i]);
  Shout := s + '!';
end;

procedure Outer(a: integer);
var b: integer;
  procedure Inner(c: integer);
    procedure Deepest;
    begin
      b := b + a + c;
    end;
  begin
    Deepest;
    b := b * 2;
  end;
begin
  b := 1;
  Inner(10);
  WriteLn('B=', b);
end;

begin
  p.x := 3; p.y := 4;
  q := p; q.x := q.x + 10;
  Show(p); Show(q);
  for i := 1 to 3 do begin pts[i].x := i; pts[i].y := i * i; end;
  WriteLn(pts[3].y, pts[2].x);
  head := nil;
  for i := 1 to 5 do begin
    New(n); n^.value := i * i; n^.next := head; head := n;
  end;
  sum := 0; n := head;
  while n <> nil do begin Write(n^.value, ' '); sum := sum + n^.value; n := n^.next; end;
  WriteLn; WriteLn(sum);
  for d := Mon to Fri do hours[d] := Ord(d) * 2;
  WriteLn(hours[Thu], ' ', Ord(Wed));
  sum := 0; for i := 1 to 5 do sum := sum + Primes[i];
  WriteLn(sum, ' ', Names[1]);
  nm := 'abcdefghijk'; WriteLn(nm, ' ', Length(nm));
  WriteLn(Shout('hello'));
  Outer(5);
  Mem[$03F000] := 77; MemW[$03F002] := 1234; MemL[$03F004] := 123456789;
  l := $03F000;
  WriteLn(Mem[$03F000], ' ', MemW[l + 2], ' ', MemL[$03F004]);
  InitGraph; PutPixel(10, 20, 5); i := GetPixel(10, 20); CloseGraph;
  WriteLn('PIXEL ', i);
  GotoXY(5, 20); Write('X'); WriteLn(WhereX);
end.
(* EXPECT
(3,4)
(13,4)
92
25 16 9 4 1
55
6 2
28 GREEN
abcdefgh 8
HELLO!
B=32
77 1234 123456789
PIXEL 5
X6
*)
