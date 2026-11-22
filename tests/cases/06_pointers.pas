program ptrs;
type
  PNode = ^TNode;
  TNode = record value: integer; next: PNode; end;
var head, p, q: PNode; i, sum: integer; pi: ^integer; x: integer;
begin
  head := nil;
  for i := 1 to 5 do begin
    new(p); p^.value := i * i; p^.next := head; head := p;
  end;
  p := head; sum := 0;
  while p <> nil do begin write(p^.value, ' '); sum := sum + p^.value; p := p^.next; end;
  writeln; writeln(sum);
  p := head;
  while p <> nil do begin q := p^.next; dispose(p); p := q; end;
  x := 42; pi := @x; pi^ := pi^ + 1; writeln(x);
  new(pi); pi^ := 7; writeln(pi^ * 6); dispose(pi);
  if assigned(head) then writeln('ASSIGNED');
  head := nil;
  if not assigned(head) then writeln('NIL');
  writeln(MemAvail > 1000);
end.
(* EXPECT
25 16 9 4 1
55
43
42
ASSIGNED
NIL
TRUE
*)
