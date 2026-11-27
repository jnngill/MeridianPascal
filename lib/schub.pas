{ MERIDIAN Pascal - Schub unit
  On the 65C816: find, start and talk to a RISC-V program on the SCHUB
  co-processor (the same mailbox protocol as BASIC's SCHUB() function).
  On both targets: the SCHUB cycle counter for timing. }
unit Schub;

interface

function  SchubPresent: boolean;
function  SchubStatus: byte;
function  SchubRunning: boolean;
function  SchubCycles: longint;
function  OnSchub: boolean;           { true when this program runs on SCHUB }
{$IFNDEF SCHUB}
procedure SchubStart(addr: longint);
procedure SchubStop;
function  SchubCall(n, a, b, c: longint): longint;
{$ENDIF}

implementation

const
  MBOX = $FE1800;

function SchubPresent: boolean;
begin
  SchubPresent := (Mem[$CD00] = ord('S')) and (Mem[$CD01] = ord('C')) and
                  (Mem[$CD02] = ord('H')) and (Mem[$CD03] = ord('B'));
end;

function SchubStatus: byte;
begin
  SchubStatus := Mem[$CD09];
end;

function SchubRunning: boolean;
begin
  { on a core without SCHUB $CD09 reads $FF, so ask SchubPresent first }
  SchubRunning := SchubPresent and ((Mem[$CD09] and 2) <> 0);
end;

function SchubCycles: longint;
var b0, b1, b2, b3: longint;
begin
  b0 := Mem[$CD18];        { reading $18 latches the upper bytes }
  b1 := Mem[$CD19]; b2 := Mem[$CD1A]; b3 := Mem[$CD1B];
  SchubCycles := b0 or (b1 shl 8) or (b2 shl 16) or (b3 shl 24);
end;

function OnSchub: boolean;
begin
  OnSchub := Target = TargetSchub;
end;

{$IFNDEF SCHUB}
procedure SchubStop;
begin
  if not SchubPresent then exit;
  Mem[$CD08] := 0;
  while (Mem[$CD09] and 6) <> 0 do ;
end;

procedure SchubStart(addr: longint);
var i: integer;
begin
  if not SchubPresent then exit;
  SchubStop;
  Mem[$CD0C] := addr and 255;
  Mem[$CD0D] := (addr shr 8) and 255;
  Mem[$CD0E] := (addr shr 16) and 255;
  Mem[$CD0F] := 0;
  for i := 0 to 23 do Mem[MBOX + i] := 0;
  Mem[$CD08] := 3;
end;

function SchubCall(n, a, b, c: longint): longint;
begin
  MemL[MBOX + 4] := n;
  MemL[MBOX + 8] := a;
  MemL[MBOX + 12] := b;
  MemL[MBOX + 16] := c;
  MemL[MBOX] := 1;
  while (MemL[MBOX] <> 2) and SchubRunning do
    if EscPressed then begin MemL[MBOX] := 0; SchubCall := -1; exit; end;
  SchubCall := MemL[MBOX + 20];
  MemL[MBOX] := 0;
end;
{$ENDIF}

end.
