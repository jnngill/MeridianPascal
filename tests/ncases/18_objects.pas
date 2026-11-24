program Objects;
{ objects: fields, methods, inheritance, virtual methods, constructors,
  destructors, inherited, New / Dispose with constructors }
type
  PShape = ^TShape;
  TShape = object
    x, y: integer;
    constructor Init(ax, ay: integer);
    destructor Done; virtual;
    function Area: integer; virtual;
    function Name: string; virtual;
    procedure MoveBy(dx, dy: integer);
    procedure Show;
  end;
  PRect = ^TRect;
  TRect = object(TShape)
    w, h: integer;
    constructor Init(ax, ay, aw, ah: integer);
    function Area: integer; virtual;
    function Name: string; virtual;
  end;
  TSquare = object(TRect)
    constructor Init(ax, ay, s: integer);
    function Name: string; virtual;
  end;
  PSquare = ^TSquare;

var
  ndone: integer;

constructor TShape.Init(ax, ay: integer);
begin
  x := ax; y := ay;
end;

destructor TShape.Done;
begin
  ndone := ndone + 1;
end;

function TShape.Area: integer;
begin
  Area := 0;
end;

function TShape.Name: string;
begin
  Name := 'SHAPE';
end;

procedure TShape.MoveBy(dx, dy: integer);
begin
  x := x + dx;
  Self.y := Self.y + dy;
end;

procedure TShape.Show;
begin
  WriteLn(Name, ' AT ', x, ',', y, ' AREA ', Area);
end;

constructor TRect.Init(ax, ay, aw, ah: integer);
begin
  inherited Init(ax, ay);
  w := aw; h := ah;
end;

function TRect.Area: integer;
begin
  Area := w * h;
end;

function TRect.Name: string;
begin
  Name := 'RECT';
end;

constructor TSquare.Init(ax, ay, s: integer);
begin
  TRect.Init(ax, ay, s, s);
end;

function TSquare.Name: string;
begin
  Name := 'SQUARE ' + inherited Name;
end;

procedure Twice(var s: TShape);
begin
  s.MoveBy(s.x, s.y);
end;

var
  sh: TShape;
  r: TRect;
  p: PShape;
  shapes: array[1..3] of PShape;
  i, total: integer;
begin
  sh.Init(1, 2);
  sh.Show;
  r.Init(3, 4, 5, 6);
  r.MoveBy(1, 1);
  r.Show;
  Twice(r);
  WriteLn('TWICE ', r.x, ',', r.y);
  New(shapes[1], Init(0, 0));
  shapes[2] := New(PRect, Init(1, 1, 2, 3));
  shapes[3] := New(PSquare, Init(2, 2, 4));
  total := 0;
  for i := 1 to 3 do begin
    shapes[i]^.Show;
    total := total + shapes[i]^.Area;
  end;
  WriteLn('TOTAL ', total);
  ndone := 0;
  for i := 1 to 3 do Dispose(shapes[i], Done);
  WriteLn('DONE ', ndone, ' SIZES ', SizeOf(TRect) - SizeOf(TShape));
  p := @r;
  WriteLn('VIA POINTER ', p^.Name, ' ', p^.Area);
end.

(* EXPECT
SHAPE AT 1,2 AREA 0
RECT AT 4,5 AREA 30
TWICE 8,10
SHAPE AT 0,0 AREA 0
RECT AT 1,1 AREA 6
SQUARE RECT AT 2,2 AREA 16
TOTAL 22
DONE 3 SIZES 4
VIA POINTER RECT 30
*)
