program NewFeatures;
type
  TColor = (Red, Green, Blue, Yellow);
  TColors = set of TColor;
  TPoint = record x, y: integer; end;
  PPoint = ^TPoint;
  TShape = record
    name: string[8];
    case kind: byte of
      0: (radius: integer);
      1: (w, h: integer);
  end;
  TBits = record
    case integer of
      0: (l: longint);
      1: (lo, hi: word);
  end;
var
  x, y, r: real;
  i, calls: integer;
  l: longint;
  cs: TColors;
  c: TColor;
  digits, letters, both: set of char;
  ch: char;
  p: TPoint;
  pp: PPoint;
  pts: array[1..3] of TPoint;
  sh: TShape;
  b: TBits;
  s: string;

function Check(v: boolean): boolean;
begin
  calls := calls + 1;
  Check := v;
end;

function Area(const sh: TShape): real;
begin
  if sh.kind = 0 then Area := 3.14159 * sh.radius * sh.radius
  else Area := sh.w * sh.h;
end;

begin
  { reals }
  x := 1.5; y := 2.25;
  WriteLn(x + y:0:2, ' ', x * y:0:3, ' ', y / x:0:2, ' ', x - y:0:2);
  i := 3; r := i / 4; WriteLn(r:0:2);
  WriteLn(Trunc(7.9), ' ', Round(7.5), ' ', Trunc(-3.7));
  WriteLn(Sqrt(16):0:3, ' ', Abs(-2.5):0:1, ' ', Sqr(1.5):0:2);
  WriteLn(x > 1.4, ' ', x < i, ' ', -x:0:1);
  r := 0; for i := 1 to 10 do r := r + 0.1;
  WriteLn(r:0:5, ' ', Int(3.7):0:1, ' ', Frac(3.75):0:2);
  WriteLn(Sin(0):0:3, ' ', Cos(0):0:3, ' ', Pi:0:4);
  WriteLn(1234.5);
  Str(2.5:6:2, s); WriteLn('[', s, ']');
  { sets }
  cs := [Red, Blue];
  for c := Red to Yellow do if c in cs then Write(Ord(c));
  WriteLn;
  Include(cs, Yellow); Exclude(cs, Red);
  for c := Red to Yellow do if c in cs then Write(Ord(c));
  WriteLn;
  digits := ['0'..'9']; letters := ['a'..'z', 'A'..'Z'];
  both := digits + letters;
  i := 0; for ch := #0 to #127 do if ch in both then i := i + 1;
  WriteLn(i, ' ', 'q' in letters - ['q'], ' ', '5' in both * digits);
  WriteLn(digits <= both, ' ', both <= digits, ' ', [Red] = [Red], ' ', cs <> [Blue, Yellow]);
  i := 5;
  if i in [i - 1 .. i + 1, 20] then WriteLn('RANGE');
  { with }
  p.x := 1; p.y := 2;
  with p do begin x := x + 10; y := y * 3; end;
  WriteLn(p.x, ' ', p.y);
  New(pp);
  with pp^ do begin x := 7; y := 8; end;
  for i := 1 to 3 do with pts[i] do begin x := i; y := pp^.x * i; end;
  WriteLn(pp^.x + pp^.y, ' ', pts[3].y);
  { variant records }
  sh.name := 'CIRCLE'; sh.kind := 0; sh.radius := 2;
  WriteLn(sh.name, ' ', Area(sh):0:2);
  sh.kind := 1; sh.w := 3; sh.h := 4;
  WriteLn(Area(sh):0:1, ' ', SizeOf(TShape));
  b.l := $12345678;
  WriteLn(b.hi, ' ', b.lo);
  { short circuit }
  calls := 0;
  if Check(false) and Check(true) then WriteLn('NO');
  if Check(true) or Check(false) then WriteLn('OR');
  WriteLn(calls);
  s := 'ABC'; pp := nil;
  if (pp <> nil) and (pp^.x = 1) then WriteLn('NO') else WriteLn('NIL SAFE');
  if (s = 'XYZ') or (s + 'D' = 'ABCD') then WriteLn('TEMPS OK');
  for i := 1 to 50 do if (s + '!' = 'X') and (s + '?' = 'Y') then WriteLn('NO');
  WriteLn('END');
end.
(* EXPECT
3.75 3.375 1.50 -0.75
0.75
7 8 -3
4.000 2.5 2.25
TRUE TRUE -1.5
1.00000 3.0 0.75
0.000 1.000 3.1416
 1.234500E+03
[  2.50]
02
23
62 FALSE TRUE
TRUE FALSE TRUE FALSE
RANGE
11 6
15 21
CIRCLE 12.57
12.0 14
4660 22136
OR
2
NIL SAFE
TEMPS OK
END
*)
