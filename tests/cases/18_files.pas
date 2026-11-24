program Files;
{ text files, files of records, untyped files, IOResult and $I+ }
type
  TRec = record
    a: integer;
    b: string[5];
  end;
var
  t: Text;
  f: file of TRec;
  u: file;
  r: TRec;
  s: string;
  x: real;
  i, n: integer;
  w: word;
  buf: array[0..9] of byte;
begin
  Assign(t, 'T1.TXT');
  Rewrite(t);
  WriteLn(t, 'HELLO ', 42);
  WriteLn(t, 3.5:4:1, ' X');
  Write(t, 'END');
  Close(t);
  Reset(t);
  ReadLn(t, s); WriteLn('LINE1 ', s);
  Read(t, x); ReadLn(t, s); WriteLn('LINE2 ', x:4:1, '|', s, '|');
  ReadLn(t, s); WriteLn('LINE3 ', s, ' ', Eof(t));
  Close(t);
  Append(t);
  WriteLn(t);
  WriteLn(t, 'MORE');
  Close(t);
  Reset(t);
  n := 0;
  while not Eof(t) do begin ReadLn(t, s); n := n + 1; end;
  Close(t);
  WriteLn('LINES ', n, ' LAST ', s);

  Assign(f, 'R.DAT');
  Rewrite(f);
  for i := 1 to 3 do begin r.a := i * 10; r.b := 'R' + IntToStr(i); Write(f, r); end;
  Close(f);
  Reset(f);
  WriteLn('SIZE ', FileSize(f));
  Seek(f, 1);
  Read(f, r);
  WriteLn('REC ', r.a, ' ', r.b, ' POS ', FilePos(f));
  Close(f);

  Assign(u, 'U.BIN');
  Rewrite(u, 1);
  for i := 0 to 9 do buf[i] := i * 3;
  BlockWrite(u, buf, 10);
  Close(u);
  for i := 0 to 9 do buf[i] := 0;
  Reset(u, 1);
  BlockRead(u, buf, 20, w);
  WriteLn('BLOCK ', w, ' ', buf[9]);
  Close(u);

  Rename(u, 'V.BIN');
  Assign(u, 'V.BIN');
  Reset(u, 1);
  WriteLn('RENAMED ', FileSize(u));
  Close(u);
{$I-}
  Assign(u, 'U.BIN');
  Reset(u, 1);
  WriteLn('OLD NAME ', IOResult);
  Erase(t);
  Reset(t);
  WriteLn('ERASED ', IOResult, ' ', IOResult);
{$I+}
  Reset(t);
  WriteLn('NOT REACHED');
end.

(* EXPECT
LINE1 HELLO 42
LINE2  3.5| X|
LINE3 END TRUE
LINES 4 LAST MORE
SIZE 3
REC 20 R2 POS 2
BLOCK 10 27
RENAMED 10
OLD NAME 2
ERASED 2 0

RUNTIME ERROR 2
*)
