program Sieve;
var flags: array[0..8190] of boolean;
    i, k, count, iter: integer;
begin
  for iter := 1 to 3 do begin
    count := 0;
    for i := 0 to 8190 do flags[i] := true;
    for i := 0 to 8190 do
      if flags[i] then begin
        k := i + i + 3;
        while i + k <= 8190 do begin flags[i + k] := false; k := k + i + i + 3; end;
        count := count + 1;
      end;
  end;
  WriteLn(count);
end.
