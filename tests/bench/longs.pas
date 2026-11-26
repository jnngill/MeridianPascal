program Longs;
var i, s, t: longint;
begin
  s := 0; t := 1;
  for i := 1 to 20000 do begin
    s := s + i * 4 + (i shr 3);
    if s > 100000000 then s := s - 99999999;
    t := (t * 33 + i) and $FFFFFF;
  end;
  WriteLn(s, ' ', t);
end.
