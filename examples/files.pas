{ Files with the Dos unit: save a record, read it back, list the disk }
program Files;

uses Crt, Dos;

type
  TScore = record
    name: string[12];
    points: longint;
    level: byte;
  end;

var
  s, t: TScore;
  i: integer;
  n: string;
  size: longint;

begin
  ClrScr;
  SetDrive(1);
  s.name := 'ADA';
  s.points := 123456;
  s.level := 7;
  if SaveFile('SCORE.DAT', VarAddr(@s), SizeOf(s)) then WriteLn('SAVED SCORE.DAT')
  else WriteLn('SAVE FAILED: ', DosErrorText(DosError));
  FillChar(t, SizeOf(t), 0);
  if LoadFile('SCORE.DAT', VarAddr(@t), SizeOf(t)) > 0 then
    WriteLn('LOADED: ', t.name, ' ', t.points, ' LEVEL ', t.level)
  else WriteLn('LOAD FAILED: ', DosErrorText(DosError));
  WriteLn;
  WriteLn('DIRECTORY OF DRIVE ', CurrentDrive, ':');
  i := 0;
  while DirEntry(i, n, size) do begin
    WriteLn('  ', n, '':14 - length(n), size: 8);
    i := i + 1;
  end;
  WriteLn(DiskFree, ' BYTES FREE');
end.
