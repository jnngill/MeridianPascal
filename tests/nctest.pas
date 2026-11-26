program NCTest;
{ test cartridge: compile the source the harness put at $20:0000 (length
  at $21:FFFC) with the on-device compiler, then run it. Built as the C
  cartridge (CCART), a C text: its file name at $21:FF00 (a length byte,
  then the characters) }
uses Crt, Graph, Sprites, Audio, Input, Dos, Blitter, Copper, Schub, Basic, Workshop, NComp, NAsm;

procedure RunUser(entry: longint); external 'runuser';

var len: longint;
    work: TAsmWork;          { the assembler's buffers (asm blocks) }
    name: string[16];
    i: integer;
    ok: boolean;
begin
  AsmWorkPtr := @work;
  len := MemL[$21FFFC];
  name := '';
  for i := 1 to Mem[$21FF00] do name := name + chr(Mem[$21FF00 + i]);
{$IFDEF CCART}
  if IsCText(name) then ok := CompileC(len, name) else
{$ENDIF}
  ok := CompileSource(len);
  if not ok then begin
    WriteLn('ERROR ', ErrUnit, ' ', ErrLine, ':', ErrCol, ' ', ErrMsg);
    exit;
  end;
  WriteLn('COMPILED ', CodeSize, ' ', DataSize);
  PrepareRun;
  RunUser(RunEntry);
  WriteLn('BACK');
end.
