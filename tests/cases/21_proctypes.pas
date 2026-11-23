program ProcTypes;
{ procedural types: variables, parameters, nil, @ }
type
  TOp = function(a, b: integer): integer;
  TShow = procedure(const s: string);
  TAct = procedure;
var
  op: TOp;
  show: TShow;
  act: TAct;
  ops: array[1..3] of TOp;
  i, n: integer;

function Add(a, b: integer): integer; begin Add := a + b; end;
function Mul(a, b: integer): integer; begin Mul := a * b; end;
function Sub(a, b: integer): integer; begin Sub := a - b; end;
procedure Loud(const s: string); begin WriteLn('<', s, '>'); end;
procedure Tick; begin n := n + 1; end;

function Apply(f: TOp; x, y: integer): integer;
begin
  Apply := f(x, y);
end;

procedure Twice(p: TAct);
begin
  p; p;
end;

begin
  op := Add;
  WriteLn('ADD ', op(3, 4));
  op := Mul;
  WriteLn('MUL ', op(3, 4), ' ', Apply(op, 5, 6), ' ', Apply(Sub, 9, 2));
  ops[1] := Add; ops[2] := Mul; ops[3] := Sub;
  for i := 1 to 3 do Write(ops[i](10, 2), ' ');
  WriteLn;
  show := Loud;
  show('HI');
  n := 0;
  act := Tick;
  act;
  Twice(act);
  Twice(Tick);
  WriteLn('N ', n);
  act := nil;
  WriteLn('NIL ', Assigned(act), ' ', act = nil);
  act := @Tick;
  WriteLn('SET ', Assigned(act));
end.

(* EXPECT
ADD 7
MUL 12 30 7
12 20 8
<HI>
N 5
NIL FALSE TRUE
SET TRUE
*)
