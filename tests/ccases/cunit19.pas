{ a Pascal unit used by 19_ownunit.c }
unit CUnit19;

interface

type
  TPoint = record
    x, y: integer;
  end;

const
  Greeting = 'hello from Pascal';
  Factor = 3;

var
  Calls: integer;

function Scale(n: integer): integer;
procedure Mirror(var p: TPoint);
function Describe(const p: TPoint; const name: string): string;

implementation

function Scale(n: integer): integer;
begin
  Calls := Calls + 1;
  Scale := n * Factor;
end;

procedure Mirror(var p: TPoint);
var t: integer;
begin
  t := p.x; p.x := p.y; p.y := t;
end;

function Describe(const p: TPoint; const name: string): string;
begin
  Describe := name + '=(' + IntToStr(p.x) + ',' + IntToStr(p.y) + ')';
end;

end.
