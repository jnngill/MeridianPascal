{ Copper demo: colour bars with LOTSE behind the text }
program RasterBars;

uses Crt, Copper;

var
  y, t, buf: integer;
  r, g, b: byte;

{ two lists: build one while LOTSE shows the other; a new list address
  takes effect at the start of the next frame }
procedure BuildList(phase: integer; addr: longint);
var line, k: integer;
begin
  CopBegin(addr);
  for line := 0 to 239 do begin
    k := (line + phase) and 63;
    if k < 32 then begin r := k shr 1; g := 0; b := 15 - k shr 1; end
    else begin r := 15 - (k - 32) shr 1; g := (k - 32) shr 2; b := (k - 32) shr 1; end;
    CopWait(line);
    CopColor(6, r, g, b);        { colour 6 is the text background }
  end;
  CopEnd;
end;

begin
  ClrScr;
  TextColor(White);
  for y := 1 to 10 do WriteLn;
  WriteLn('      LOTSE THE COPPER CHANGES COLOUR');
  WriteLn('      6 ON EVERY RASTER LINE.');
  WriteLn;
  WriteLn('      ESC ENDS.');
  t := 0;
  buf := 0;
  repeat
    BuildList(t, CopperBase + longint(buf) * $1000);
    CopperOn;
    WaitVSync;
    buf := 1 - buf;
    t := t + 2;
  until EscPressed;
  CopperOff;
  ResetDisplay;
  WriteLn('BYE.');
end.
