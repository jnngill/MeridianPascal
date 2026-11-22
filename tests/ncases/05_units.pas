program UseUnits;
uses Crt, Shapes, Counter;
var r: TRect;
    total: integer;
function Helper: integer;   { same name as a private routine in Shapes }
begin
  Helper := 99;
end;
begin
  MakeRect(r, 2, 3, 10, 7);
  WriteLn(Area(r), ' ', Describe(r));
  WriteLn(ShapeCount, ' ', Helper);
  Bump; Bump; Bump;
  WriteLn(Count, ' ', Started);
  total := 0;
  with r do total := w + h;
  WriteLn(total, ' ', MaxSide);
end.
(* EXPECT
32 RECT 8X4
1 99
3 TRUE
12 10
*)
(* FILE SHAPES.PAS
unit Shapes;
interface
const MaxSide = 10;
type
  TRect = record x, y, w, h: integer; end;
var ShapeCount: integer;
procedure MakeRect(var r: TRect; x1, y1, x2, y2: integer);
function Area(const r: TRect): integer;
function Describe(const r: TRect): string;
implementation
uses Counter;
var made: integer;
function Helper(v: integer): integer;
begin
  Helper := v;
end;
procedure MakeRect(var r: TRect; x1, y1, x2, y2: integer);
begin
  r.x := x1; r.y := y1; r.w := Helper(x2 - x1); r.h := y2 - y1;
  made := made + 1; ShapeCount := made;
end;
function Area(const r: TRect): integer;
begin
  Area := r.w * r.h;
end;
function Describe;
begin
  Describe := 'RECT ' + IntToStr(r.w) + 'X' + IntToStr(r.h);
end;
begin
  made := 0;
  ShapeCount := 0;
end.
*)
(* FILE COUNTER.PAS
unit Counter;
interface
var Count: integer;
    Started: boolean;
procedure Bump;
implementation
procedure Bump;
begin
  Inc(Count);
end;
initialization
  Count := 0;
  Started := true;
end.
*)
