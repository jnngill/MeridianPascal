program RangeAssign;
{ $R+: a value that does not fit the variable's type stops the program }
type TDigit = 0..9;
     TColor = (Red, Green, Blue);
var d: TDigit;
    b: byte;
    sh: shortint;
    w: word;
    i: integer;
    l: longint;
begin
{$R+}
  i := 9; d := i; WriteLn('D ', d);
  i := 255; b := i; WriteLn('B ', b);
  i := -128; sh := i; WriteLn('SH ', sh);
  l := 65535; w := l; WriteLn('W ', w);
  l := -32768; i := l; WriteLn('I ', i);
{$R-}
  i := 300; b := i; WriteLn('WRAP ', b);
{$R+}
  i := 10;
  d := i;
  WriteLn('NOT REACHED');
end.

(* EXPECT
D 9
B 255
SH -128
W 65535
I -32768
WRAP 44

RUNTIME ERROR 201
*)
