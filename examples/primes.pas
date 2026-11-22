{ Sieve of Eratosthenes benchmark - compare 65C816 and SCHUB }
program Primes;

uses Crt;

const
  N = 8190;

var
  flags: array[0..N] of boolean;
  i, k, count, iter: integer;
  t0, t1: longint;

begin
  ClrScr;
  TextColor(Yellow);
  if Target = TargetSchub then WriteLn('SIEVE ON SCHUB (RV32IM, 24 MHZ)')
  else WriteLn('SIEVE ON THE 65C816 (8 MHZ)');
  TextColor(LightBlue);
  t0 := Micros;
  for iter := 1 to 10 do begin
    count := 0;
    for i := 0 to N do flags[i] := true;
    for i := 2 to N do
      if flags[i] then begin
        k := i + i;
        while k <= N do begin
          flags[k] := false;
          k := k + i;
        end;
        count := count + 1;
      end;
  end;
  t1 := Micros;
  WriteLn(count, ' PRIMES BELOW ', N + 1);
  WriteLn('10 RUNS IN ', (t1 - t0) div 1000, ' MS');
end.
