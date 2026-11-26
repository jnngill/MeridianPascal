program Strs;
var s, t: string;
    i, n: integer;
begin
  n := 0;
  for i := 1 to 2000 do begin
    s := s + chr(65 + i mod 26);
    if length(s) > 60 then begin t := copy(s, 10, 20); if pos('ABC', s) > 0 then n := n + 1; s := t; end;
  end;
  WriteLn(n, ' ', s);
end.
