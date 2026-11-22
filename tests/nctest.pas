program NCTest;
{ test cartridge: compile the source the harness put at $20:0000 (length
  at $21:FFFC) with the on-device compiler, then run it }
uses Crt, Graph, Sprites, Audio, Input, Dos, Blitter, Copper, Schub, NComp;

procedure RunUser(entry: longint); external 'runuser';

var len: longint;
begin
  len := MemL[$21FFFC];
  if not CompileSource(len) then begin
    WriteLn('ERROR ', ErrUnit, ' ', ErrLine, ':', ErrCol, ' ', ErrMsg);
    exit;
  end;
  WriteLn('COMPILED ', CodeSize, ' ', DataSize);
  PrepareRun;
  RunUser(RunEntry);
  WriteLn('BACK');
end.
