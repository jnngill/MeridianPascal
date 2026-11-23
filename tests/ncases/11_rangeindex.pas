program RangeIndex;
{ $R+: array and string indexes within their bounds, else runtime error 201 }
var a: array[1..5] of integer;
    c: array['a'..'e'] of byte;
    g: array[1..3, 2..4] of byte;
    s: string[5];
    i, k: integer;
    ch: char;
begin
{$R+}
  for i := 1 to 5 do a[i] := i * i;
  for ch := 'a' to 'e' do c[ch] := ord(ch);
  g[3, 4] := 7;
  s := 'HELLO';
  i := 5; k := 0;
  WriteLn(a[i], ' ', c['e'], ' ', g[3, 4], ' ', s[i], ' ', ord(s[k]));
{$R-}
  i := 6; k := a[i - 1];
  WriteLn('OFF ', k);
{$R+}
  i := 0;
  a[i] := 1;
  WriteLn('NOT REACHED');
end.

(* EXPECT
25 101 7 O 5
OFF 25

RUNTIME ERROR 201
*)
