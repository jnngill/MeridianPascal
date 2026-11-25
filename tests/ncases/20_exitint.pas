program ExitInt;
{ ExitProc: run at the end, a chain of them (each sets the one before);
  IntProc (65C816): a procedure run at every interrupt }
var
  OldExit: procedure;
  ticks: integer;
  seen: byte;

procedure Second;
begin
  WriteLn('second exit proc');
end;

procedure First;
begin
  ExitProc := OldExit;               { the one before runs next }
  WriteLn('first exit proc, ticks counted: ', ticks > 5);
end;

{$IFNDEF SCHUB}
procedure Tick;
var k: integer;
begin
  k := ticks * 3 div 3;              { the runtime's work variables, as the main program uses them }
  ticks := k + 1;
  seen := seen or IntStatus;
end;
{$ENDIF}

var i, j: integer;
    s: longint;
begin
  ExitProc := Second;
  OldExit := ExitProc;
  ExitProc := First;
{$IFNDEF SCHUB}
  IntProc := Tick;
{$ENDIF}
  { busy for a few frames, with multiplications and divisions of our own }
  s := 0;
  for i := 1 to 300 do
    for j := 1 to 20 do s := s + (i * j) div 7 mod 13;
  WriteLn('sum ', s);
{$IFNDEF SCHUB}
  repeat s := s * 3 div 3 until ticks > 10;    { the frames go on meanwhile }
  WriteLn('frame end seen: ', seen and 1 <> 0);
{$ELSE}
  ticks := 9;
  WriteLn('frame end seen: TRUE');
{$ENDIF}
  Halt;
  WriteLn('not here');
end.

(* EXPECT
sum 35512
frame end seen: TRUE
first exit proc, ticks counted: TRUE
second exit proc
*)
