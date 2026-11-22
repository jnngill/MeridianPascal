{ MERIDIAN Pascal - Copper unit (LOTSE)
  Builds a copper list in chip RAM: wait for a raster line, set chip
  registers, change palette colours - every frame, in step with the beam.
  Lines run 0..239 (visible); a list starts again every frame. }
unit Copper;

interface

const
  CopperBase = $038000;      { default list address (chip RAM, bank 3, free) }

procedure CopBegin(addr: longint);
procedure CopWait(line: integer);
procedure CopWaitX(line, x: integer);
procedure CopSet(reg: word; value: byte);
procedure CopColor(index: byte; r, g, b: byte);
procedure CopWaitBlitter;
procedure CopEnd;
procedure CopperOn;
procedure CopperOff;
function  CopSize: longint;

implementation

var
  ListStart, P: longint;

procedure Cmd(a, b, c, d: byte);
begin
  Mem[P] := a; Mem[P + 1] := b; Mem[P + 2] := c; Mem[P + 3] := d;
  P := P + 4;
end;

procedure CopBegin(addr: longint);
begin
  ListStart := addr;
  P := addr;
end;

procedure CopWait(line: integer);
begin
  Cmd(1, line and 255, ((line shr 8) and 1) or 2, $FF);   { x = $1FF: start of line }
end;

procedure CopWaitX(line, x: integer);
begin
  Cmd(1, line and 255, ((line shr 8) and 1) or (((x shr 8) and 1) shl 1), x and 255);
end;

procedure CopSet(reg: word; value: byte);
begin
  Cmd(2, reg and 255, reg shr 8, value);
end;

procedure CopColor(index: byte; r, g, b: byte);
begin
  Cmd(6, index, ((g and 15) shl 4) or (b and 15), r and 15);
end;

procedure CopWaitBlitter;
begin
  Cmd(5, 0, 0, 0);
end;

procedure CopEnd;
begin
  Cmd(0, 0, 0, 0);
end;

function CopSize: longint;
begin
  CopSize := P - ListStart;
end;

procedure CopperOn;
begin
  Mem[$C700] := ListStart and 255;
  Mem[$C701] := (ListStart shr 8) and 255;
  Mem[$C702] := (ListStart shr 16) and 255;
  Mem[$C703] := 1;
end;

procedure CopperOff;
begin
  Mem[$C703] := 0;
end;

begin
  ListStart := CopperBase;
  P := CopperBase;
end.
