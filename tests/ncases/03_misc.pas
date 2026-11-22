program Misc;
var
  name: string;
  a, b: integer;
  big, small: longint;
  c: char;
  k: integer;

function Find(n: integer): integer;
var i: integer;
begin
  Find := -1;
  for i := 1 to 100 do
    if i * i >= n then begin Find := i; exit; end;
end;

function Kind(c: char): string;
begin
  case c of
    'a'..'z': Kind := 'LOWER';
    'A'..'Z': Kind := 'UPPER';
    '0'..'9': Kind := 'DIGIT';
  else
    Kind := 'OTHER';
  end;
end;

begin
  Write('NAME? '); ReadLn(name);
  Write('TWO NUMBERS? '); ReadLn(a, b);
  WriteLn('HI ', name, ' ', a + b);
  big := 3000000; small := -5;
  if big > small then WriteLn('BIG > SMALL');
  if small < 0 then WriteLn('NEGATIVE');
  if big = 3000000 then WriteLn('EQ');
  WriteLn(big * 3 div 2, ' ', big mod 7);
  WriteLn(Find(50), ' ', Find(20000));
  WriteLn(Kind('x'), Kind('Q'), Kind('5'), Kind('#'));
  k := 0;
  repeat k := k + 1 until (k > 3) or (k * k > 100);
  WriteLn(k);
  WriteLn(Random(1) = 0, ' ', Odd(7), ' ', Abs(-9), ' ', Sqr(12), ' ', Hi($1234), ' ', Lo($1234));
  a := 0;
  WriteLn(10 div a);
  WriteLn('NOT REACHED');
end.
(* KEYS:ADA\r3 4\r *)
(* EXPECT
NAME? ADA
TWO NUMBERS? 3 4
HI ADA 7
BIG > SMALL
NEGATIVE
EQ
4500000 3
8 -1
LOWERUPPERDIGITOTHER
4
TRUE TRUE 9 144 18 52

RUNTIME ERROR 200
*)
