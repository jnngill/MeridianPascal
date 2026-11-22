program enums;
type TDay = (Mon, Tue, Wed, Thu, Fri, Sat, Sun);
     TWeekend = Sat..Sun;
var d: TDay; w: TWeekend; hours: array[TDay] of integer; total: integer;
    letters: array['a'..'e'] of integer; c: char; flags: array[boolean] of string[3];
begin
  for d := Mon to Sun do hours[d] := ord(d) * 2;
  total := 0; for d := Mon to Fri do total := total + hours[d];
  writeln(total);
  d := Wed; d := succ(d); writeln(ord(d), ' ', ord(pred(Sun)));
  w := Sun; writeln(ord(w), ' ', ord(low(TDay)), ' ', ord(high(TDay)));
  for c := 'a' to 'e' do letters[c] := ord(c) - 96;
  writeln(letters['c'] + letters['e']);
  flags[false] := 'NO'; flags[true] := 'YES';
  writeln(flags[3 > 2], flags[1 > 2]);
  if d > Tue then writeln('AFTER TUE');
  case d of Mon..Wed: writeln('EARLY'); Thu, Fri: writeln('LATE'); else writeln('WEEKEND'); end;
end.
(* EXPECT
20
3 5
6 0 6
8
YESNO
AFTER TUE
LATE
*)
