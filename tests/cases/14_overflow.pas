program Overflow;
{ $Q+: + - * that do not fit stop the program with runtime error 215;
  $Q- wraps around as before }
var i, j: integer;
    w: word;
    l, m: longint;
    b: byte;
begin
  i := 32767; j := 1;
{$Q-}
  i := i + j; WriteLn('WRAP ', i);
{$Q+}
  i := 32000; i := i + 767; WriteLn('ADD ', i);
  i := -32000; i := i - 768; WriteLn('SUB ', i);
  i := 181; i := i * 181; WriteLn('MUL ', i);
  i := -181; i := i * 181; WriteLn('MULN ', i);
  w := 65000; w := w + 535; WriteLn('WORD ', w);
  l := 2147483000; l := l + 647; WriteLn('LADD ', l);
  l := -2147483000; l := l - 648; WriteLn('LSUB ', l);
  l := 46340; l := l * 46340; WriteLn('LMUL ', l);
  l := -46340; m := 46340; l := l * m; WriteLn('LMULN ', l);
  b := 200; i := b + b; WriteLn('BYTE ', i);
  Inc(i, 100); WriteLn('INC ', i);
  i := 32767; j := 1;
  i := i + j;
  WriteLn('NOT REACHED');
end.

(* EXPECT
WRAP -32768
ADD 32767
SUB -32768
MUL 32761
MULN -32761
WORD 65535
LADD 2147483647
LSUB -2147483648
LMUL 2147395600
LMULN -2147395600
BYTE 400
INC 500

RUNTIME ERROR 215
*)
