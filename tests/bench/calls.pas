program Calls;
function Fib(n: integer): integer;
begin
  if n < 2 then Fib := n else Fib := Fib(n - 1) + Fib(n - 2);
end;
begin
  WriteLn(Fib(20));
end.
