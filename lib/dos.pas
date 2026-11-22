{ MERIDIAN Pascal - Dos unit (TRUHE / DOS in the system ROM)
  Files on the FAT16 disk images (drives 1 and 2), the cartridge save
  (drive 0) and the SD card folder games/MERIDIAN/files (drive 3).
  Data is moved between files and memory at 24-bit addresses, so anything
  from a Pascal variable (Addr(x)) to expansion RAM can be loaded or saved. }
unit Dos;

interface

const
  { DosError values }
  deOk = 0; deInvalid = 1; deNotFound = 2; deFull = 3; deNoDisk = 4;
  deNoFat16 = 5; deReadOnly = 6; deDirFull = 7; deTooLarge = 8; deBadName = 9;

var
  DosError: integer;
  CurrentDrive: integer;

procedure SetDrive(d: integer);
function  LoadFile(const name: string; addr: longint; maxLen: longint): longint;
function  LoadMer(const name: string): longint;
function  SaveFile(const name: string; addr: longint; len: longint): boolean;
function  SaveMer(const name: string; addr: longint; len: longint): boolean;
function  DeleteFile(const name: string): boolean;
function  FileExists(const name: string): boolean;
function  DirEntry(index: integer; var name: string; var size: longint): boolean;
function  DiskFree: longint;
function  VarAddr(p: pointer): longint;
function  DosErrorText(e: integer): string;

implementation

const
  PB = $16C0;   { DOS parameter block }

procedure SetDrive(d: integer);
begin
  if (d >= 0) and (d <= 3) then CurrentDrive := d;
end;

procedure SetName(const name: string);
var i, n: integer;
begin
  n := length(name);
  if n > 16 then n := 16;
  Mem[PB] := CurrentDrive;
  Mem[PB + 6] := n;
  for i := 1 to n do Mem[PB + 6 + i] := ord(UpCase(name[i]));
  Mem[PB + 3] := 0; Mem[PB + 4] := 0; Mem[PB + 5] := 0;
end;

procedure SetAddr(addr, len: longint);
begin
  Mem[PB + $24] := addr and 255;
  Mem[PB + $25] := (addr shr 8) and 255;
  Mem[PB + $26] := (addr shr 16) and 255;
  Mem[PB + $28] := len and 255;
  Mem[PB + $29] := (len shr 8) and 255;
  Mem[PB + $2A] := (len shr 16) and 255;
  Mem[PB + $2B] := (len shr 24) and 255;
end;

function GetLen: longint;
begin
  GetLen := longint(Mem[PB + $28]) or (longint(Mem[PB + $29]) shl 8) or
            (longint(Mem[PB + $2A]) shl 16) or (longint(Mem[PB + $2B]) shl 24);
end;

{ address of a Pascal variable as a 24-bit address }
function VarAddr(p: pointer): longint;
begin
{$IFDEF SCHUB}
  VarAddr := longint(PtrUInt(p)) and $FFFFFF;
{$ELSE}
  VarAddr := longint(PtrUInt(p));
{$ENDIF}
end;

function LoadFile(const name: string; addr: longint; maxLen: longint): longint;
begin
  SetName(name);
  SetAddr(addr, maxLen);
  DosError := DosCall(0);
  if DosError = 0 then LoadFile := GetLen else LoadFile := -1;
end;

function LoadMer(const name: string): longint;
begin
  LoadMer := LoadFile(name, $FFFFFF, $7FFFFFFF);
end;

function DoSave(const name: string; addr, len: longint; mer: boolean): boolean;
begin
  SetName(name);
  SetAddr(addr, len);
  if mer then Mem[PB + 2] := 1 else Mem[PB + 2] := 0;
  DosError := DosCall(1);
  DoSave := DosError = 0;
end;

function SaveFile(const name: string; addr: longint; len: longint): boolean;
begin
  SaveFile := DoSave(name, addr, len, false);
end;

function SaveMer(const name: string; addr: longint; len: longint): boolean;
begin
  SaveMer := DoSave(name, addr, len, true);
end;

function DeleteFile(const name: string): boolean;
begin
  SetName(name);
  DosError := DosCall(2);
  DeleteFile := DosError = 0;
end;

function DirEntry(index: integer; var name: string; var size: longint): boolean;
var i, n: integer;
begin
  Mem[PB] := CurrentDrive;
  Mem[PB + $2C] := index and 255;
  Mem[PB + $2D] := index shr 8;
  DosError := DosCall(3);
  if DosError <> 0 then begin DirEntry := false; exit; end;
  n := Mem[PB + 6];
  if n > 16 then n := 16;
  for i := 1 to n do name[i] := chr(Mem[PB + 6 + i]);
  name[0] := chr(n);
  size := GetLen;
  DirEntry := true;
end;

function FileExists(const name: string): boolean;
var i: integer;
    n, u: string;
    sz: longint;
begin
  u := UpperCase(name);
  i := 0;
  FileExists := false;
  while DirEntry(i, n, sz) do begin
    if (n = u) or (Copy(n, 1, length(u) + 1) = u + '.') then begin
      FileExists := true;
      exit;
    end;
    i := i + 1;
  end;
end;

function DiskFree: longint;
begin
  Mem[PB] := CurrentDrive;
  DosError := DosCall(4);
  if DosError = 0 then DiskFree := GetLen else DiskFree := -1;
end;

function DosErrorText(e: integer): string;
begin
  case e of
    0: DosErrorText := 'OK';
    1: DosErrorText := 'INVALID REQUEST';
    2: DosErrorText := 'FILE NOT FOUND';
    3: DosErrorText := 'DISK FULL';
    4: DosErrorText := 'NO DISK';
    5: DosErrorText := 'NOT FAT16';
    6: DosErrorText := 'WRITE PROTECTED';
    7: DosErrorText := 'DIRECTORY FULL';
    8: DosErrorText := 'TOO LARGE';
    9: DosErrorText := 'BAD FILE NAME';
  else
    DosErrorText := 'DOS ERROR ' + IntToStr(e);
  end;
end;

begin
  CurrentDrive := 1;
  DosError := 0;
end.
