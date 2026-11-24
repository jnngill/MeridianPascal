program Overflow32;
{$Q+}
var l, m: longint;
begin
  l := 65536; m := 32768;
  WriteLn('BEFORE');
  l := l * m;
  WriteLn('NOT REACHED');
end.

(* EXPECT
BEFORE

RUNTIME ERROR 215
*)
