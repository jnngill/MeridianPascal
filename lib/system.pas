{ MERIDIAN Pascal - System unit
  Used automatically by every program. Holds the runtime the compiler calls
  (strings, sets, Write/Read, heap, software floating point) and the
  standard routines. Machine primitives are "external": each back end
  (65C816 / SCHUB RV32IM) supplies them. }
unit System;

interface

type
  _TSet = set of byte;
  PByte = ^byte;
  PWord = ^word;
  PInteger = ^integer;
  PLongint = ^longint;
  PChar = ^char;
  PString = ^string;
  TByteArray = array[0..32766] of byte;
  PByteArray = ^TByteArray;
  { a file (Text, file of T, file): the whole file is kept in a buffer (a
    bank of expansion RAM, $E1..$E7, so up to 64 KB and 7 files open);
    Reset loads it, Close saves what was written }
  _TFile = record
    mode: word;          { 0 closed, 1 text input, 2 text output, 3 records }
    recsize: word;
    buf: longint;
    len: longint;
    pos: longint;
    dirty: boolean;
    drive: byte;
    name: string[16];
  end;
  Text = _TFile;

const
  TargetM816 = 1;
  TargetSchub = 2;

var
  RandSeed: longint;
  HeapError: boolean;
  ExitCode: integer;
  _fdummy: word;         { BlockRead / BlockWrite without a result }

{ ---- machine primitives (back end) ---- }
procedure _putchar(c: char); external 'putchar';
function  _getkey: char; external 'getkey';
function  _escape: boolean; external 'escape';
procedure _halt(code: integer); external 'halt';
function  _heaporg: pointer; external 'heaporg';
function  _sp: pointer; external 'sp';
procedure _fill(var dst; count: word; value: byte); external 'fill';
procedure Move(const src; var dst; count: word); external 'move';
procedure FillChar(var dst; count: word; value: byte); external 'fill';
function  Target: integer; external 'target';
function  KernelMode(cols: integer): integer; external 'kmode';
procedure ResetDisplay; external 'kreset';
function  DosCall(cmd: integer): integer; external 'dos';

{ ---- runtime used by the compiler ---- }
procedure _strasg(var dst: string; const src: string; max: integer);
procedure _strcat(var dst: string; const src: string; max: integer);
function  _strcmp(const a, b: string): integer;
procedure _writechar(c: char; w: integer);
procedure _writestr(const s: string; w: integer);
procedure _writebool(b: boolean; w: integer);
procedure _writeint(v: longint; w: integer);
procedure _writecard(v: longword; w: integer);
procedure _writereal(r: real; w, d: integer);
procedure _writeln;
procedure _readstr(var s: string; max: integer);
function  _readchar: char;
function  _readint: longint;
function  _readreal: real;
procedure _readlnend;
procedure _strint(v: longint; w: integer; var s: string; max: integer);
procedure _strreal(r: real; w, d: integer; var s: string; max: integer);
function  _valint(const s: string; var code: integer): longint;
function  _valreal(const s: string; var code: integer): real;
function  _getmem(size: word): pointer;
procedure _freemem(p: pointer; size: word);
procedure _setincl(var s: _TSet; e: integer);
procedure _setexcl(var s: _TSet; e: integer);
procedure _setrange(var s: _TSet; lo, hi: integer);
function  _setin(e: integer; const s: _TSet): boolean;
procedure _setop(var d: _TSet; const a, b: _TSet; op: integer);
function  _seteq(const a, b: _TSet): boolean;
function  _setle(const a, b: _TSet): boolean;
function  _absint(i: integer): integer;
function  _abslong(l: longint): longint;
procedure RunError(code: integer);

{ software floating point (IEEE single precision) }
function  _addreal(a, b: real): real;
function  _subreal(a, b: real): real;
function  _mulreal(a, b: real): real;
function  _divreal(a, b: real): real;
function  _negreal(a: real): real;
function  _cmpreal(a, b: real): integer;
function  _absreal(a: real): real;
function  _inttoreal(l: longint): real;
function  _cardtoreal(l: longword): real;
function  _truncreal(r: real): longint;
function  _roundreal(r: real): longint;
function  _intreal(r: real): real;
function  _fracreal(r: real): real;
function  _sqrtreal(r: real): real;

{ ---- standard routines ---- }
function  Copy(const s: string; index, count: integer): string;
function  Pos(const sub, s: string): integer;
procedure Delete(var s: string; index, count: integer);
procedure Insert(const src: string; var s: string; index: integer);
function  UpCase(c: char): char;
function  LoCase(c: char): char;
function  UpperCase(const s: string): string;
function  LowerCase(const s: string): string;
function  IntToStr(v: longint): string;
function  StrToInt(const s: string): longint;
function  IntToHex(v: longint; digits: integer): string;
function  Trim(const s: string): string;
function  StringOfChar(c: char; n: integer): string;
function  Random(n: integer): integer;
function  RandomLong: longint;
procedure Randomize;
function  MaxAvail: longint;
function  MemAvail: longint;
function  Sin(x: real): real;
function  Cos(x: real): real;
function  ArcTan(x: real): real;
function  Exp(x: real): real;
function  Ln(x: real): real;
function  Power(base, ex: real): real;
function  Min(a, b: longint): longint;
function  Max(a, b: longint): longint;
function  EscPressed: boolean;

{ ---- files ---- }
procedure Assign(var f: _TFile; const name: string);
procedure _freset(var f: _TFile; recsize: integer);
procedure _frewrite(var f: _TFile; recsize: integer);
procedure Append(var f: _TFile);
procedure Close(var f: _TFile);
procedure Erase(var f: _TFile);
procedure Rename(var f: _TFile; const name: string);
function  Eof(var f: _TFile): boolean;
function  Eoln(var f: _TFile): boolean;
procedure Seek(var f: _TFile; n: longint);
function  FilePos(var f: _TFile): longint;
function  FileSize(var f: _TFile): longint;
procedure Truncate(var f: _TFile);
procedure Flush(var f: _TFile);
procedure _fread(var f: _TFile; var v; size: word);
procedure _fwrite(var f: _TFile; const v; size: word);
procedure _fblockread(var f: _TFile; var buf; count: word; var result: word);
procedure _fblockwrite(var f: _TFile; const buf; count: word; var result: word);
procedure _textout(var f: _TFile);
procedure _textin(var f: _TFile);
procedure _textend;
procedure _iocheck;
function  IOResult: integer;
procedure _setdrive(d: integer);

implementation

type
  PFree = ^TFree;
  TFree = record
    size: word;
    next: PFree;
  end;
  TRealBits = record
    case integer of
      0: (r: real);
      1: (l: longint);
  end;

var
  HeapPtr: pointer;
  HeapTop: pointer;
  FreeList: PFree;
  LineBuf: string;
  LinePos: integer;
  LineValid: boolean;
  { files }
  IoErr: integer;
  CurDrive: integer;
  Slots: integer;              { bit k: bank $E1 + k in use }
  OutMode, InMode: integer;    { 0 screen / keyboard, 1 a file, 2 nowhere (an error) }
  OutF, InF: ^_TFile;

procedure RunError(code: integer);
begin
  _writeln;
  _writestr('RUNTIME ERROR ', 0);
  _writeint(code, 0);
  _writeln;
  _halt(code);
end;

{ ------------------------------------------------------------- strings }
procedure _strasg(var dst: string; const src: string; max: integer);
var n: integer;
begin
  n := ord(src[0]);
  if n > max then n := max;
  if n > 0 then Move(src[1], dst[1], n);
  dst[0] := chr(n);
end;

procedure _strcat(var dst: string; const src: string; max: integer);
var n, l: integer;
begin
  l := ord(dst[0]);
  n := ord(src[0]);
  if l + n > max then n := max - l;
  if n > 0 then begin
    Move(src[1], dst[l + 1], n);
    dst[0] := chr(l + n);
  end;
end;

function _strcmp(const a, b: string): integer;
var i, la, lb, n: integer;
begin
  la := ord(a[0]); lb := ord(b[0]);
  n := la;
  if lb < n then n := lb;
  i := 1;
  while i <= n do begin
    if a[i] <> b[i] then begin
      if a[i] < b[i] then _strcmp := -1 else _strcmp := 1;
      exit;
    end;
    i := i + 1;
  end;
  if la < lb then _strcmp := -1
  else if la > lb then _strcmp := 1
  else _strcmp := 0;
end;

function Copy(const s: string; index, count: integer): string;
var n: integer;
begin
  n := ord(s[0]);
  if index < 1 then index := 1;
  if (index > n) or (count <= 0) then begin
    Result[0] := #0;
    exit;
  end;
  if count > n - index + 1 then count := n - index + 1;
  Move(s[index], Result[1], count);
  Result[0] := chr(count);
end;

function Pos(const sub, s: string): integer;
var i, j, ls, lsub: integer;
    ok: boolean;
begin
  ls := ord(s[0]); lsub := ord(sub[0]);
  Pos := 0;
  if lsub = 0 then exit;
  i := 1;
  while i <= ls - lsub + 1 do begin
    ok := true;
    j := 1;
    while ok and (j <= lsub) do begin
      if s[i + j - 1] <> sub[j] then ok := false;
      j := j + 1;
    end;
    if ok then begin
      Pos := i;
      exit;
    end;
    i := i + 1;
  end;
end;

procedure Delete(var s: string; index, count: integer);
var n: integer;
begin
  n := ord(s[0]);
  if (index < 1) or (index > n) or (count <= 0) then exit;
  if count > n - index + 1 then count := n - index + 1;
  if index + count <= n then Move(s[index + count], s[index], n - index - count + 1);
  s[0] := chr(n - count);
end;

procedure Insert(const src: string; var s: string; index: integer);
var tmp: string;
begin
  if index < 1 then index := 1;
  if index > ord(s[0]) + 1 then index := ord(s[0]) + 1;
  tmp := Copy(s, 1, index - 1) + src + Copy(s, index, 255);
  s := tmp;
end;

function UpCase(c: char): char;
begin
  if (c >= 'a') and (c <= 'z') then UpCase := chr(ord(c) - 32) else UpCase := c;
end;

function LoCase(c: char): char;
begin
  if (c >= 'A') and (c <= 'Z') then LoCase := chr(ord(c) + 32) else LoCase := c;
end;

function UpperCase(const s: string): string;
var i: integer;
begin
  Result := s;
  for i := 1 to length(Result) do Result[i] := UpCase(Result[i]);
end;

function LowerCase(const s: string): string;
var i: integer;
begin
  Result := s;
  for i := 1 to length(Result) do Result[i] := LoCase(Result[i]);
end;

function Trim(const s: string): string;
var a, b: integer;
begin
  a := 1; b := length(s);
  while (a <= b) and (s[a] <= ' ') do a := a + 1;
  while (b >= a) and (s[b] <= ' ') do b := b - 1;
  Result := Copy(s, a, b - a + 1);
end;

function StringOfChar(c: char; n: integer): string;
var i: integer;
begin
  if n > 255 then n := 255;
  if n < 0 then n := 0;
  for i := 1 to n do Result[i] := c;
  Result[0] := chr(n);
end;

{ ------------------------------------------------------------- numbers }
procedure _strint(v: longint; w: integer; var s: string; max: integer);
var buf: string[12];
    n, i: integer;
    neg: boolean;
    u: longword;
    wv: word;
begin
  neg := v < 0;
  if neg then u := longword(-v) else u := longword(v);
  n := 0;
  if u = 0 then begin n := 1; buf[1] := '0'; end;
  { 32-bit part }
  while u > 65535 do begin
    n := n + 1;
    buf[n] := chr(48 + integer(u mod 10));
    u := u div 10;
  end;
  wv := word(u);
  while wv > 0 do begin
    n := n + 1;
    buf[n] := chr(48 + (wv mod 10));
    wv := wv div 10;
  end;
  if neg then begin n := n + 1; buf[n] := '-'; end;
  i := 0;
  while (w > n) and (i < max) do begin
    i := i + 1;
    s[i] := ' ';
    w := w - 1;
  end;
  while (n > 0) and (i < max) do begin
    i := i + 1;
    s[i] := buf[n];
    n := n - 1;
  end;
  s[0] := chr(i);
end;

function IntToStr(v: longint): string;
begin
  _strint(v, 0, Result, 255);
end;

function IntToHex(v: longint; digits: integer): string;
const hx: string[16] = '0123456789ABCDEF';
var i: integer;
begin
  if digits > 8 then digits := 8;
  if digits < 1 then digits := 1;
  for i := digits downto 1 do begin
    Result[i] := hx[integer(v and 15) + 1];
    v := v shr 4;
  end;
  Result[0] := chr(digits);
end;

function _valint(const s: string; var code: integer): longint;
var i, n, d: integer;
    neg, hex: boolean;
    v: longint;
begin
  v := 0; i := 1; n := length(s);
  while (i <= n) and (s[i] = ' ') do i := i + 1;
  neg := false; hex := false;
  if (i <= n) and ((s[i] = '-') or (s[i] = '+')) then begin
    neg := s[i] = '-';
    i := i + 1;
  end;
  if (i <= n) and (s[i] = '$') then begin hex := true; i := i + 1; end;
  code := 0;
  if i > n then code := i;
  while (i <= n) and (code = 0) do begin
    d := -1;
    if (s[i] >= '0') and (s[i] <= '9') then d := ord(s[i]) - 48
    else if hex and (UpCase(s[i]) >= 'A') and (UpCase(s[i]) <= 'F') then d := ord(UpCase(s[i])) - 55;
    if d < 0 then code := i
    else begin
      if hex then v := v * 16 + d else v := v * 10 + d;
      i := i + 1;
    end;
  end;
  if neg then v := -v;
  _valint := v;
end;

function StrToInt(const s: string): longint;
var c: integer;
begin
  StrToInt := _valint(s, c);
end;

function _absint(i: integer): integer;
begin
  if i < 0 then _absint := -i else _absint := i;
end;

function _abslong(l: longint): longint;
begin
  if l < 0 then _abslong := -l else _abslong := l;
end;

function Min(a, b: longint): longint;
begin
  if a < b then Min := a else Min := b;
end;

function Max(a, b: longint): longint;
begin
  if a > b then Max := a else Max := b;
end;

function RandomLong: longint;
begin
  RandSeed := RandSeed * 134775813 + 1;
  RandomLong := RandSeed;
end;

function Random(n: integer): integer;
var r: longint;
begin
  if n <= 0 then begin Random := 0; exit; end;
  RandSeed := RandSeed * 134775813 + 1;
  r := (RandSeed shr 16) and $7FFF;
  Random := integer(r mod n);
end;

procedure Randomize;
begin
  { PFORTE microsecond clock: writing $C110 freezes it for reading }
  Mem[$C110] := 0;
  RandSeed := MemL[$C110] xor (longint(Mem[$C00F]) shl 16);
end;

function EscPressed: boolean;
begin
  { Esc next in the key buffer, or held down right now (kernel key table) }
  EscPressed := _escape or (Mem[$033E76] <> 0);
end;

{ ------------------------------------------------------------- output }
{ a character to the screen, or to the text file Write(f, ...) names }
procedure _out(c: char);
var f: ^_TFile;
begin
  if OutMode = 0 then _putchar(c)
  else if OutMode = 1 then begin
    f := OutF;
    if f^.pos >= 65536 then begin if IoErr = 0 then IoErr := 101; end
    else begin
      Mem[f^.buf + f^.pos] := ord(c);
      f^.pos := f^.pos + 1;
      if f^.pos > f^.len then f^.len := f^.pos;
      f^.dirty := true;
    end;
  end;
end;

procedure _writechar(c: char; w: integer);
begin
  while w > 1 do begin _out(' '); w := w - 1; end;
  _out(c);
end;

procedure _writestr(const s: string; w: integer);
var i, n: integer;
begin
  n := ord(s[0]);
  while w > n do begin _out(' '); w := w - 1; end;
  for i := 1 to n do _out(s[i]);
end;

procedure _writebool(b: boolean; w: integer);
begin
  if b then _writestr('TRUE', w) else _writestr('FALSE', w);
end;

procedure _writeint(v: longint; w: integer);
var s: string[40];
begin
  _strint(v, w, s, 40);
  _writestr(s, 0);
end;

procedure _writecard(v: longword; w: integer);
var s: string[40];
    hi: longword;
begin
  if v > $7FFFFFFF then begin
    { split: v = hi * 10 + last digit }
    hi := (v shr 1) div 5;
    _strint(longint(hi), w - 1, s, 40);
    _writestr(s, 0);
    _out(chr(48 + integer(v - hi * 10)));
  end else begin
    _strint(longint(v), w, s, 40);
    _writestr(s, 0);
  end;
end;

procedure _writeln;
begin
  if OutMode = 0 then _putchar(#13)
  else begin _out(#13); _out(#10); end;
end;

{ ------------------------------------------------------------- input }
procedure ReadLine;
var c: char;
    n: integer;
begin
  n := 0;
  repeat
    repeat c := _getkey until c <> #0;
    if c = #8 then begin
      if n > 0 then begin
        n := n - 1;
        _putchar(#8);
      end;
    end else if c = #3 then begin
      _writeln;
      _halt(0);
    end else if (c >= ' ') and (c <> #13) and (n < 255) then begin
      n := n + 1;
      LineBuf[n] := c;
      _putchar(c);
    end;
  until c = #13;
  LineBuf[0] := chr(n);
  _putchar(#13);
  LinePos := 1;
  LineValid := true;
end;

procedure NeedLine;
begin
  if not LineValid then ReadLine;
end;

{ ---- reading a text file: straight from its buffer }
function FPeek: integer;           { the next byte, -1 at the end }
begin
  if InF^.pos >= InF^.len then FPeek := -1 else FPeek := Mem[InF^.buf + InF^.pos];
end;

function FAtEol: boolean;
var c: integer;
begin
  c := FPeek;
  FAtEol := (c = -1) or (c = 13) or (c = 10) or (c = 26);
end;

procedure FSkipEol;
begin
  if FPeek = 13 then InF^.pos := InF^.pos + 1;
  if FPeek = 10 then InF^.pos := InF^.pos + 1;
end;

function FToken: string;
var s: string;
    c, n: integer;
begin
  repeat
    c := FPeek;
    if (c = 32) or (c = 9) or (c = 13) or (c = 10) then InF^.pos := InF^.pos + 1;
  until not ((c = 32) or (c = 9) or (c = 13) or (c = 10));
  n := 0;
  repeat
    c := FPeek;
    if (c > 32) and (c <> 26) and (n < 255) then begin
      n := n + 1; s[n] := chr(c); InF^.pos := InF^.pos + 1;
    end else c := -1;
  until c = -1;
  s[0] := chr(n);
  FToken := s;
end;

procedure _readstr(var s: string; max: integer);
var n: integer;
begin
  if InMode <> 0 then begin
    n := 0;
    if InMode = 1 then
      while not FAtEol and (n < max) do begin
        n := n + 1; s[n] := chr(FPeek); InF^.pos := InF^.pos + 1;
      end;
    s[0] := chr(n);
    exit;
  end;
  NeedLine;
  n := length(LineBuf) - LinePos + 1;
  if n > max then n := max;
  if n < 0 then n := 0;
  if n > 0 then Move(LineBuf[LinePos], s[1], n);
  s[0] := chr(n);
  LinePos := LinePos + n;
end;

function _readchar: char;
var c: integer;
begin
  if InMode <> 0 then begin
    c := -1;
    if InMode = 1 then c := FPeek;
    if c = -1 then _readchar := #26
    else if (c = 13) or (c = 10) then begin FSkipEol; _readchar := #13; end
    else begin _readchar := chr(c); InF^.pos := InF^.pos + 1; end;
    exit;
  end;
  NeedLine;
  if LinePos > length(LineBuf) then begin
    _readchar := #13;
    LineValid := false;
  end else begin
    _readchar := LineBuf[LinePos];
    LinePos := LinePos + 1;
  end;
end;

function NextToken: string;
var a: integer;
begin
  repeat
    NeedLine;
    while (LinePos <= length(LineBuf)) and (LineBuf[LinePos] = ' ') do LinePos := LinePos + 1;
    if LinePos > length(LineBuf) then LineValid := false;
  until LineValid;
  a := LinePos;
  while (LinePos <= length(LineBuf)) and (LineBuf[LinePos] <> ' ') do LinePos := LinePos + 1;
  NextToken := Copy(LineBuf, a, LinePos - a);
end;

function _readint: longint;
var c: integer;
begin
  if InMode <> 0 then begin
    _readint := 0;
    if InMode = 1 then begin
      _readint := _valint(FToken, c);
      if (c <> 0) and (IoErr = 0) then IoErr := 106;
    end;
    exit;
  end;
  _readint := _valint(NextToken, c);
  if c <> 0 then RunError(106);
end;

function _readreal: real;
var c: integer;
begin
  if InMode <> 0 then begin
    _readreal := 0;
    if InMode = 1 then begin
      _readreal := _valreal(FToken, c);
      if (c <> 0) and (IoErr = 0) then IoErr := 106;
    end;
    exit;
  end;
  _readreal := _valreal(NextToken, c);
  if c <> 0 then RunError(106);
end;

procedure _readlnend;
begin
  if InMode <> 0 then begin
    if InMode = 1 then begin
      while not FAtEol do InF^.pos := InF^.pos + 1;
      FSkipEol;
    end;
    exit;
  end;
  if not LineValid then ReadLine;
  LineValid := false;
end;

{ ------------------------------------------------------------- files }
const
  PB = $16C0;                  { the DOS parameter block }

procedure DosName(var f: _TFile);
var i: integer;
begin
  Mem[PB] := f.drive;
  Mem[PB + 6] := length(f.name);
  for i := 1 to length(f.name) do Mem[PB + 6 + i] := ord(UpCase(f.name[i]));
  Mem[PB + 2] := 0; Mem[PB + 3] := 0; Mem[PB + 4] := 0; Mem[PB + 5] := 0;
end;

procedure DosAddr(addr, len: longint);
begin
  Mem[PB + $24] := addr and 255; Mem[PB + $25] := (addr shr 8) and 255; Mem[PB + $26] := (addr shr 16) and 255;
  Mem[PB + $28] := len and 255; Mem[PB + $29] := (len shr 8) and 255;
  Mem[PB + $2A] := (len shr 16) and 255; Mem[PB + $2B] := (len shr 24) and 255;
end;

{ a DOS error as a Turbo Pascal I/O error }
function IoCode(e: integer; writing: boolean): integer;
begin
  case e of
    0: IoCode := 0;
    2, 9: IoCode := 2;            { file not found }
    4: IoCode := 152;             { drive not ready }
    6: IoCode := 150;             { write protected }
  else
    if writing then IoCode := 101 else IoCode := 100;
  end;
end;

procedure SetErr(e: integer);
begin
  if IoErr = 0 then IoErr := e;
end;

{ a buffer: one of the banks $E1..$E7 }
function NewSlot: longint;
var k: integer;
begin
  NewSlot := 0;
  for k := 0 to 6 do
    if Slots and (1 shl k) = 0 then begin
      Slots := Slots or (1 shl k);
      NewSlot := longint($E1 + k) shl 16;
      exit;
    end;
  SetErr(4);                      { too many open files }
end;

procedure FreeSlot(var f: _TFile);
begin
  if f.buf <> 0 then Slots := Slots and not (1 shl integer((f.buf shr 16) - $E1));
  f.buf := 0;
end;

function IsOpen(var f: _TFile): boolean;
begin
  IsOpen := (f.mode >= 1) and (f.mode <= 3) and (f.buf <> 0);
end;

procedure Assign(var f: _TFile; const name: string);
var n: string;
begin
  f.mode := 0; f.buf := 0; f.len := 0; f.pos := 0; f.dirty := false;
  n := name;
  f.drive := CurDrive;
  if (length(n) >= 2) and (n[2] = ':') and (n[1] >= '0') and (n[1] <= '3') then begin
    f.drive := ord(n[1]) - 48;
    Delete(n, 1, 2);
  end;
  if length(n) > 16 then n[0] := chr(16);
  f.name := n;
end;

procedure _freset(var f: _TFile; recsize: integer);
var e: integer;
begin
  if IsOpen(f) then Close(f);
  if f.name = '' then begin SetErr(102); exit; end;
  f.buf := NewSlot;
  if f.buf = 0 then exit;
  DosName(f);
  DosAddr(f.buf, 65536);
  e := DosCall(0);
  if e <> 0 then begin FreeSlot(f); SetErr(IoCode(e, false)); exit; end;
  f.len := longint(Mem[PB + $28]) or (longint(Mem[PB + $29]) shl 8) or (longint(Mem[PB + $2A]) shl 16);
  f.pos := 0; f.dirty := false;
  if recsize = 0 then f.mode := 1 else begin f.mode := 3; f.recsize := recsize; end;
end;

procedure _frewrite(var f: _TFile; recsize: integer);
begin
  if IsOpen(f) then Close(f);
  if f.name = '' then begin SetErr(102); exit; end;
  f.buf := NewSlot;
  if f.buf = 0 then exit;
  f.len := 0; f.pos := 0; f.dirty := true;
  if recsize = 0 then f.mode := 2 else begin f.mode := 3; f.recsize := recsize; end;
end;

procedure Append(var f: _TFile);
begin
  _freset(f, 0);
  if IsOpen(f) then begin f.mode := 2; f.pos := f.len; end;
end;

procedure Close(var f: _TFile);
var e: integer;
begin
  if not IsOpen(f) then begin SetErr(103); exit; end;
  if f.dirty then begin
    DosName(f);
    DosAddr(f.buf, f.len);
    e := DosCall(1);
    if e <> 0 then SetErr(IoCode(e, true));
  end;
  FreeSlot(f);
  f.mode := 0;
end;

procedure Erase(var f: _TFile);
var e: integer;
begin
  if IsOpen(f) then begin SetErr(102); exit; end;
  DosName(f);
  e := DosCall(2);
  if e <> 0 then SetErr(IoCode(e, false));
end;

procedure Rename(var f: _TFile; const name: string);
var g: _TFile;
    e: integer;
begin
  if IsOpen(f) then begin SetErr(102); exit; end;
  { (the DOS has no rename) load, save under the new name, remove the old }
  _freset(f, 1);
  if not IsOpen(f) then exit;
  Assign(g, name);
  DosName(g);
  DosAddr(f.buf, f.len);
  e := DosCall(1);
  FreeSlot(f);
  f.mode := 0;
  if e <> 0 then begin SetErr(IoCode(e, true)); exit; end;
  DosName(f);
  e := DosCall(2);
  f.name := g.name; f.drive := g.drive;
end;

function Eof(var f: _TFile): boolean;
begin
  if not IsOpen(f) then begin SetErr(103); Eof := true; exit; end;
  Eof := (f.pos >= f.len) or ((f.mode = 1) and (Mem[f.buf + f.pos] = 26));
end;

function Eoln(var f: _TFile): boolean;
var c: integer;
begin
  if not IsOpen(f) then begin SetErr(103); Eoln := true; exit; end;
  if f.pos >= f.len then Eoln := true
  else begin c := Mem[f.buf + f.pos]; Eoln := (c = 13) or (c = 10) or (c = 26); end;
end;

function RecSz(var f: _TFile): longint;
begin
  if f.mode = 3 then RecSz := f.recsize else RecSz := 1;
end;

procedure Seek(var f: _TFile; n: longint);
begin
  if not IsOpen(f) then begin SetErr(103); exit; end;
  if (n < 0) or (n * RecSz(f) > f.len) then begin SetErr(100); exit; end;
  f.pos := n * RecSz(f);
end;

function FilePos(var f: _TFile): longint;
begin
  if not IsOpen(f) then begin SetErr(103); FilePos := 0; exit; end;
  FilePos := f.pos div RecSz(f);
end;

function FileSize(var f: _TFile): longint;
begin
  if not IsOpen(f) then begin SetErr(103); FileSize := 0; exit; end;
  FileSize := f.len div RecSz(f);
end;

procedure Truncate(var f: _TFile);
begin
  if not IsOpen(f) then begin SetErr(103); exit; end;
  f.len := f.pos; f.dirty := true;
end;

procedure Flush(var f: _TFile);
begin
  if not IsOpen(f) then SetErr(103);
end;

procedure _fread(var f: _TFile; var v; size: word);
var p: PByteArray;
    i: integer;
begin
  if not IsOpen(f) then begin SetErr(103); exit; end;
  if f.mode <> 3 then begin SetErr(104); exit; end;
  if f.pos + size > f.len then begin SetErr(100); exit; end;
  p := PByteArray(@v);
  for i := 0 to size - 1 do p^[i] := Mem[f.buf + f.pos + i];
  f.pos := f.pos + size;
end;

procedure _fwrite(var f: _TFile; const v; size: word);
var p: PByteArray;
    i: integer;
begin
  if not IsOpen(f) then begin SetErr(103); exit; end;
  if f.mode <> 3 then begin SetErr(105); exit; end;
  if f.pos + size > 65536 then begin SetErr(101); exit; end;
  p := PByteArray(@v);
  for i := 0 to size - 1 do Mem[f.buf + f.pos + i] := p^[i];
  f.pos := f.pos + size;
  if f.pos > f.len then f.len := f.pos;
  f.dirty := true;
end;

procedure _fblockread(var f: _TFile; var buf; count: word; var result: word);
var p: PByteArray;
    n, i: longint;
begin
  result := 0;
  if not IsOpen(f) then begin SetErr(103); exit; end;
  n := count;
  if f.pos + n * RecSz(f) > f.len then n := (f.len - f.pos) div RecSz(f);
  p := PByteArray(@buf);
  for i := 0 to n * RecSz(f) - 1 do p^[i] := Mem[f.buf + f.pos + i];
  f.pos := f.pos + n * RecSz(f);
  result := n;
end;

procedure _fblockwrite(var f: _TFile; const buf; count: word; var result: word);
var p: PByteArray;
    n, i: longint;
begin
  result := 0;
  if not IsOpen(f) then begin SetErr(103); exit; end;
  n := count;
  if f.pos + n * RecSz(f) > 65536 then begin n := (65536 - f.pos) div RecSz(f); SetErr(101); end;
  p := PByteArray(@buf);
  for i := 0 to n * RecSz(f) - 1 do Mem[f.buf + f.pos + i] := p^[i];
  f.pos := f.pos + n * RecSz(f);
  if f.pos > f.len then f.len := f.pos;
  f.dirty := true;
  result := n;
end;

{ Write(f, ...) / Read(f, ...) on a text file: the output / input go there
  until _textend }
procedure _textout(var f: _TFile);
begin
  if not IsOpen(f) then begin SetErr(103); OutMode := 2; end
  else if f.mode <> 2 then begin SetErr(105); OutMode := 2; end
  else begin OutF := @f; OutMode := 1; end;
end;

procedure _textin(var f: _TFile);
begin
  if not IsOpen(f) then begin SetErr(103); InMode := 2; end
  else if f.mode <> 1 then begin SetErr(104); InMode := 2; end
  else begin InF := @f; InMode := 1; end;
end;

procedure _textend;
begin
  OutMode := 0; InMode := 0;
end;

{ $I+: an I/O error stops the program }
procedure _iocheck;
var e: integer;
begin
  if IoErr <> 0 then begin e := IoErr; IoErr := 0; RunError(e); end;
end;

function IOResult: integer;
begin
  IOResult := IoErr;
  IoErr := 0;
end;

procedure _setdrive(d: integer);
begin
  if (d >= 0) and (d <= 3) then CurDrive := d;
end;

{ ------------------------------------------------------------- heap }
procedure HeapInit;
begin
  HeapPtr := _heaporg;
  FreeList := nil;
end;

function _getmem(size: word): pointer;
var p, prev: PFree;
    need: word;
    np: PtrUInt;
begin
  need := (size + SizeOf(TFree) - 1) div SizeOf(TFree) * SizeOf(TFree);
  if need < SizeOf(TFree) then need := SizeOf(TFree);
  prev := nil;
  p := FreeList;
  while p <> nil do begin
    if p^.size >= need then begin
      if p^.size - need >= SizeOf(TFree) then begin
        { split: keep the front part on the list }
        p^.size := p^.size - need;
        _getmem := pointer(PtrUInt(p) + p^.size);
      end else begin
        if prev = nil then FreeList := p^.next else prev^.next := p^.next;
        _getmem := p;
      end;
      exit;
    end;
    prev := p;
    p := p^.next;
  end;
  np := PtrUInt(HeapPtr) + need;
  if (np < PtrUInt(HeapPtr)) or (np + 512 > PtrUInt(_sp)) then begin
    if HeapError then begin _getmem := nil; exit; end;
    RunError(203);
  end;
  _getmem := HeapPtr;
  HeapPtr := pointer(np);
end;

procedure _freemem(p: pointer; size: word);
var f: PFree;
    need: word;
begin
  if p = nil then exit;
  need := (size + SizeOf(TFree) - 1) div SizeOf(TFree) * SizeOf(TFree);
  if need < SizeOf(TFree) then need := SizeOf(TFree);
  if PtrUInt(p) + need = PtrUInt(HeapPtr) then begin
    HeapPtr := p;
    exit;
  end;
  f := PFree(p);
  f^.size := need;
  f^.next := FreeList;
  FreeList := f;
end;

function MemAvail: longint;
var p: PFree;
    n: longint;
begin
  n := longint(PtrUInt(_sp)) - longint(PtrUInt(HeapPtr)) - 512;
  if n < 0 then n := 0;
  p := FreeList;
  while p <> nil do begin
    n := n + p^.size;
    p := p^.next;
  end;
  MemAvail := n;
end;

function MaxAvail: longint;
var n: longint;
begin
  n := longint(PtrUInt(_sp)) - longint(PtrUInt(HeapPtr)) - 512;
  if n < 0 then n := 0;
  MaxAvail := n;
end;

{ ------------------------------------------------------------- sets }
procedure _setincl(var s: _TSet; e: integer);
var b: PByteArray;
begin
  if (e < 0) or (e > 255) then exit;
  b := PByteArray(@s);
  b^[e shr 3] := b^[e shr 3] or (1 shl (e and 7));
end;

procedure _setexcl(var s: _TSet; e: integer);
var b: PByteArray;
begin
  if (e < 0) or (e > 255) then exit;
  b := PByteArray(@s);
  b^[e shr 3] := b^[e shr 3] and not (1 shl (e and 7));
end;

procedure _setrange(var s: _TSet; lo, hi: integer);
var i: integer;
begin
  if lo < 0 then lo := 0;
  if hi > 255 then hi := 255;
  for i := lo to hi do _setincl(s, i);
end;

function _setin(e: integer; const s: _TSet): boolean;
var b: PByteArray;
begin
  if (e < 0) or (e > 255) then begin _setin := false; exit; end;
  b := PByteArray(@s);
  _setin := (b^[e shr 3] and (1 shl (e and 7))) <> 0;
end;

procedure _setop(var d: _TSet; const a, b: _TSet; op: integer);
var pd, pa, pb: PByteArray;
    i: integer;
begin
  pd := PByteArray(@d); pa := PByteArray(@a); pb := PByteArray(@b);
  for i := 0 to 31 do
    case op of
      0: pd^[i] := pa^[i] or pb^[i];
      1: pd^[i] := pa^[i] and not pb^[i];
      2: pd^[i] := pa^[i] and pb^[i];
    end;
end;

function _seteq(const a, b: _TSet): boolean;
var pa, pb: PByteArray;
    i: integer;
begin
  pa := PByteArray(@a); pb := PByteArray(@b);
  _seteq := false;
  for i := 0 to 31 do if pa^[i] <> pb^[i] then exit;
  _seteq := true;
end;

function _setle(const a, b: _TSet): boolean;
var pa, pb: PByteArray;
    i: integer;
begin
  pa := PByteArray(@a); pb := PByteArray(@b);
  _setle := false;
  for i := 0 to 31 do if (pa^[i] and not pb^[i]) <> 0 then exit;
  _setle := true;
end;

{ ------------------------------------------------------------- reals
  IEEE single: sign 1, exponent 8 (bias 127), mantissa 23. Denormals are
  flushed to zero, overflow is runtime error 205. }

function MkReal(neg: boolean; e: integer; m: longint): real;
{ m: mantissa with the hidden bit at bit 23 (normalised) }
var u: TRealBits;
begin
  if m = 0 then begin u.l := 0; MkReal := u.r; exit; end;
  if e <= 0 then begin u.l := 0; MkReal := u.r; exit; end;
  if e >= 255 then RunError(205);
  u.l := (longint(e) shl 23) or (m and $7FFFFF);
  if neg then u.l := u.l or longint($80000000);
  MkReal := u.r;
end;

procedure Unpack(r: real; var neg: boolean; var e: integer; var m: longint);
var u: TRealBits;
begin
  u.r := r;
  neg := u.l < 0;
  e := integer((u.l shr 23) and 255);
  if e = 0 then m := 0
  else m := (u.l and $7FFFFF) or $800000;
end;

function _addreal(a, b: real): real;
var na, nb: boolean;
    ea, eb, d: integer;
    ma, mb: longint;
begin
  Unpack(a, na, ea, ma);
  Unpack(b, nb, eb, mb);
  if mb = 0 then begin _addreal := a; exit; end;
  if ma = 0 then begin _addreal := b; exit; end;
  { 3 guard bits }
  ma := ma shl 3; mb := mb shl 3;
  if ea < eb then begin
    d := eb - ea; ea := eb;
    if d > 30 then ma := 0 else ma := ma shr d;
  end else if eb < ea then begin
    d := ea - eb;
    if d > 30 then mb := 0 else mb := mb shr d;
  end;
  if na = nb then ma := ma + mb
  else begin
    ma := ma - mb;
    if ma < 0 then begin ma := -ma; na := nb; end;
  end;
  if ma = 0 then begin _addreal := 0.0; exit; end;
  while ma >= $8000000 do begin ma := ma shr 1; ea := ea + 1; end;
  while ma < $4000000 do begin ma := ma shl 1; ea := ea - 1; end;
  { round to nearest }
  ma := (ma + 4) shr 3;
  if ma >= $1000000 then begin ma := ma shr 1; ea := ea + 1; end;
  _addreal := MkReal(na, ea, ma);
end;

function _negreal(a: real): real;
var u: TRealBits;
begin
  u.r := a;
  if u.l <> 0 then u.l := u.l xor longint($80000000);
  _negreal := u.r;
end;

function _subreal(a, b: real): real;
begin
  _subreal := _addreal(a, _negreal(b));
end;

function _mulreal(a, b: real): real;
var na, nb: boolean;
    ea, eb: integer;
    ma, mb, a1, a0, b1, b0, mid, low, m: longint;
begin
  Unpack(a, na, ea, ma);
  Unpack(b, nb, eb, mb);
  if (ma = 0) or (mb = 0) then begin _mulreal := 0.0; exit; end;
  a1 := ma shr 12; a0 := ma and $FFF;
  b1 := mb shr 12; b0 := mb and $FFF;
  mid := a1 * b0 + a0 * b1;
  low := a0 * b0 + ((mid and $7FF) shl 12);
  m := a1 * b1 * 2 + (mid shr 11) + (low shr 23);
  { product of two 1.23 numbers: m is 1.23 or 2.23 }
  ea := ea + eb - 127;
  if m >= $1000000 then begin m := (m + 1) shr 1; ea := ea + 1; end;
  _mulreal := MkReal(na <> nb, ea, m);
end;

function _divreal(a, b: real): real;
var na, nb: boolean;
    ea, eb, i: integer;
    ma, mb, q: longint;
begin
  Unpack(a, na, ea, ma);
  Unpack(b, nb, eb, mb);
  if mb = 0 then RunError(200);
  if ma = 0 then begin _divreal := 0.0; exit; end;
  q := 0;
  for i := 0 to 24 do begin
    q := q shl 1;
    if ma >= mb then begin ma := ma - mb; q := q or 1; end;
    ma := ma shl 1;
  end;
  { q = (ma/mb) * 2^24, between 2^23 and 2^25 }
  ea := ea - eb + 127;
  if q >= $1000000 then q := (q + 1) shr 1
  else ea := ea - 1;
  if q >= $1000000 then begin q := q shr 1; ea := ea + 1; end;
  _divreal := MkReal(na <> nb, ea, q);
end;

function _cmpreal(a, b: real): integer;
var ua, ub: TRealBits;
begin
  ua.r := a; ub.r := b;
  { turn the sign-magnitude bits into ordered integers }
  if ua.l < 0 then ua.l := -(ua.l and $7FFFFFFF);
  if ub.l < 0 then ub.l := -(ub.l and $7FFFFFFF);
  if ua.l < ub.l then _cmpreal := -1
  else if ua.l > ub.l then _cmpreal := 1
  else _cmpreal := 0;
end;

function _absreal(a: real): real;
var u: TRealBits;
begin
  u.r := a;
  u.l := u.l and $7FFFFFFF;
  _absreal := u.r;
end;

function _cardtoreal(l: longword): real;
var e: integer;
    m: longword;
begin
  if l = 0 then begin _cardtoreal := 0.0; exit; end;
  m := l;
  e := 150;
  while m >= $1000000 do begin
    if m and 1 <> 0 then m := (m shr 1) + 1 else m := m shr 1;   { round }
    e := e + 1;
  end;
  while m < $800000 do begin m := m shl 1; e := e - 1; end;
  _cardtoreal := MkReal(false, e, longint(m));
end;

function _inttoreal(l: longint): real;
begin
  if l < 0 then _inttoreal := _negreal(_cardtoreal(longword(-l)))
  else _inttoreal := _cardtoreal(longword(l));
end;

function _truncreal(r: real): longint;
var n: boolean;
    e: integer;
    m: longint;
begin
  Unpack(r, n, e, m);
  if (m = 0) or (e < 127) then begin _truncreal := 0; exit; end;
  e := e - 150;
  if e > 7 then RunError(207);
  if e >= 0 then m := m shl e else m := m shr (-e);
  if n then m := -m;
  _truncreal := m;
end;

function _roundreal(r: real): longint;
begin
  if _cmpreal(r, 0.0) < 0 then _roundreal := _truncreal(_subreal(r, 0.5))
  else _roundreal := _truncreal(_addreal(r, 0.5));
end;

function _intreal(r: real): real;
var n: boolean;
    e: integer;
    m: longint;
begin
  Unpack(r, n, e, m);
  if e >= 150 then begin _intreal := r; exit; end;
  if e < 127 then begin _intreal := 0.0; exit; end;
  m := (m shr (150 - e)) shl (150 - e);
  _intreal := MkReal(n, e, m);
end;

function _fracreal(r: real): real;
begin
  _fracreal := _subreal(r, _intreal(r));
end;

function _sqrtreal(r: real): real;
var x, last: real;
    i: integer;
    n: boolean;
    e: integer;
    m: longint;
begin
  if _cmpreal(r, 0.0) <= 0 then begin
    if _cmpreal(r, 0.0) < 0 then RunError(207);
    _sqrtreal := 0.0; exit;
  end;
  { first guess: halve the exponent }
  Unpack(r, n, e, m);
  x := MkReal(false, (e - 127) div 2 + 127, $800000);
  for i := 1 to 8 do begin
    last := x;
    x := _mulreal(_addreal(x, _divreal(r, x)), 0.5);
  end;
  _sqrtreal := x;
end;

function Exp(x: real): real;
var k, i: integer;
    t, s: real;
begin
  { e^x = 2^k * e^r with r = x - k*ln2 }
  k := integer(_roundreal(_divreal(x, 0.6931471805599453)));
  x := _subreal(x, _mulreal(_inttoreal(k), 0.6931471805599453));
  s := 1.0; t := 1.0;
  for i := 1 to 10 do begin
    t := _divreal(_mulreal(t, x), _inttoreal(i));
    s := _addreal(s, t);
  end;
  while k > 0 do begin s := _mulreal(s, 2.0); k := k - 1; end;
  while k < 0 do begin s := _mulreal(s, 0.5); k := k + 1; end;
  Exp := s;
end;

function Ln(x: real): real;
var n: boolean;
    e, i: integer;
    m: longint;
    y, y2, t, s: real;
begin
  if _cmpreal(x, 0.0) <= 0 then RunError(207);
  Unpack(x, n, e, m);
  { x = 2^(e-127) * f, f in [1,2) }
  x := MkReal(false, 127, m);
  { ln f = 2 atanh((f-1)/(f+1)) }
  y := _divreal(_subreal(x, 1.0), _addreal(x, 1.0));
  y2 := _mulreal(y, y);
  s := 0.0; t := y;
  i := 1;
  while i <= 13 do begin
    s := _addreal(s, _divreal(t, _inttoreal(i)));
    t := _mulreal(t, y2);
    i := i + 2;
  end;
  Ln := _addreal(_mulreal(s, 2.0), _mulreal(_inttoreal(e - 127), 0.6931471805599453));
end;

function Power(base, ex: real): real;
begin
  if _cmpreal(base, 0.0) = 0 then Power := 0.0
  else Power := Exp(_mulreal(ex, Ln(base)));
end;

function Sin(x: real): real;
var k, i: integer;
    t, s, x2: real;
begin
  { reduce to [-pi, pi] }
  k := integer(_roundreal(_divreal(x, 6.283185307179586)));
  x := _subreal(x, _mulreal(_inttoreal(k), 6.283185307179586));
  x2 := _mulreal(x, x);
  s := x; t := x;
  i := 1;
  while i <= 8 do begin
    t := _negreal(_divreal(_mulreal(t, x2), _inttoreal((2 * i) * (2 * i + 1))));
    s := _addreal(s, t);
    i := i + 1;
  end;
  Sin := s;
end;

function Cos(x: real): real;
begin
  Cos := Sin(_addreal(x, 1.5707963267948966));
end;

function ArcTan(x: real): real;
var neg, inv: boolean;
    t, s, x2: real;
    i: integer;
begin
  neg := _cmpreal(x, 0.0) < 0;
  if neg then x := _negreal(x);
  inv := _cmpreal(x, 1.0) > 0;
  if inv then x := _divreal(1.0, x);
  { reduce once more: atan x = 2 atan(x / (1 + sqrt(1+x^2))) }
  x := _divreal(x, _addreal(1.0, _sqrtreal(_addreal(1.0, _mulreal(x, x)))));
  x2 := _mulreal(x, x);
  s := x; t := x;
  i := 1;
  while i <= 7 do begin
    t := _negreal(_mulreal(t, x2));
    s := _addreal(s, _divreal(t, _inttoreal(2 * i + 1)));
    i := i + 1;
  end;
  s := _mulreal(s, 2.0);
  if inv then s := _subreal(1.5707963267948966, s);
  if neg then s := _negreal(s);
  ArcTan := s;
end;

procedure _strreal(r: real; w, d: integer; var s: string; max: integer);
var neg: boolean;
    e, i, digits: integer;
    ip: longint;
    t: string[40];
    f: real;
    dg: integer;
begin
  t := '';
  neg := _cmpreal(r, 0.0) < 0;
  if neg then r := _negreal(r);
  if d >= 0 then begin
    { fixed point }
    f := r;
    for i := 1 to d do f := _mulreal(f, 10.0);
    if _cmpreal(f, 2000000000.0) >= 0 then begin d := -1; end
    else begin
      ip := _roundreal(f);
      _strint(ip, 0, t, 40);
      while length(t) <= d do t := '0' + t;
      if d > 0 then Insert('.', t, length(t) - d + 1);
      if neg and (ip <> 0) then t := '-' + t;
    end;
  end;
  if d < 0 then begin
    { scientific: d.dddddddE+xx }
    e := 0;
    if _cmpreal(r, 0.0) <> 0 then begin
      while _cmpreal(r, 10.0) >= 0 do begin r := _divreal(r, 10.0); e := e + 1; end;
      while _cmpreal(r, 1.0) < 0 do begin r := _mulreal(r, 10.0); e := e - 1; end;
    end;
    digits := 7;
    f := r;
    for i := 1 to digits - 1 do f := _mulreal(f, 10.0);
    ip := _roundreal(f);
    if ip >= 10000000 then begin ip := ip div 10; e := e + 1; end;
    _strint(ip, 0, t, 40);
    Insert('.', t, 2);
    t := t + 'E';
    if e < 0 then begin t := t + '-'; e := -e; end else t := t + '+';
    if e < 10 then t := t + '0';
    t := t + IntToStr(e);
    if neg then t := '-' + t else t := ' ' + t;
  end;
  while length(t) < w do t := ' ' + t;
  _strasg(s, t, max);
end;

procedure _writereal(r: real; w, d: integer);
var s: string[60];
begin
  _strreal(r, w, d, s, 60);
  _writestr(s, 0);
end;

{ text -> real, rounded once: the digits are collected as an integer (up to
  9 significant digits, the rest only marks "more"), scaled by the power of
  ten in a 64-bit mantissa of four 16-bit limbs (m[3] the highest), and only
  then rounded to the 24 bits of a real (to nearest, ties to even). }
function _valreal(const s: string; var code: integer): real;
var i, n, ex, scale, nd, be, k, e: integer;
    neg, eneg, digit, more: boolean;
    mant, cur, rem, top: longint;
    m: array[0..4] of longint;
    u: TRealBits;

  procedure ShiftLeft;
  var j: integer;
  begin
    for j := 3 downto 1 do m[j] := ((m[j] shl 1) and $FFFF) or (m[j - 1] shr 15);
    m[0] := (m[0] shl 1) and $FFFF;
    be := be - 1;
  end;

  procedure ShiftRight;            { from m[4] down; the lost bit stays as "more" }
  var j: integer;
  begin
    if odd(m[0]) then more := true;
    for j := 0 to 3 do m[j] := (m[j] shr 1) or ((m[j + 1] and 1) shl 15);
    m[4] := m[4] shr 1;
    be := be + 1;
  end;

  procedure Normalize;             { highest bit of m[3] set }
  begin
    while m[3] < $8000 do ShiftLeft;
  end;

  procedure Mul10;
  var j: integer;
  begin
    cur := 0;
    for j := 0 to 3 do begin
      cur := m[j] * 10 + cur;
      m[j] := cur and $FFFF;
      cur := cur shr 16;
    end;
    m[4] := cur;
    while m[4] <> 0 do ShiftRight;
    Normalize;
  end;

  procedure Div10;
  var j: integer;
  begin
    rem := 0;
    for j := 3 downto 0 do begin
      cur := rem * 65536 + m[j];
      m[j] := cur div 10;
      rem := cur mod 10;
    end;
    if rem <> 0 then more := true;
    Normalize;
  end;

begin
  i := 1; n := length(s);
  code := 0; mant := 0; nd := 0; scale := 0; more := false;
  while (i <= n) and (s[i] = ' ') do i := i + 1;
  neg := false;
  if (i <= n) and ((s[i] = '-') or (s[i] = '+')) then begin neg := s[i] = '-'; i := i + 1; end;
  digit := false;
  while (i <= n) and (s[i] >= '0') and (s[i] <= '9') do begin
    if nd < 9 then begin
      mant := mant * 10 + ord(s[i]) - 48;
      if mant <> 0 then nd := nd + 1;
    end else begin
      scale := scale + 1;
      if s[i] <> '0' then more := true;
    end;
    i := i + 1; digit := true;
  end;
  if (i <= n) and (s[i] = '.') then begin
    i := i + 1;
    while (i <= n) and (s[i] >= '0') and (s[i] <= '9') do begin
      if nd < 9 then begin
        mant := mant * 10 + ord(s[i]) - 48;
        if mant <> 0 then nd := nd + 1;
        scale := scale - 1;
      end else if s[i] <> '0' then more := true;
      i := i + 1; digit := true;
    end;
  end;
  if (i <= n) and ((s[i] = 'e') or (s[i] = 'E')) then begin
    i := i + 1;
    eneg := false;
    if (i <= n) and ((s[i] = '-') or (s[i] = '+')) then begin eneg := s[i] = '-'; i := i + 1; end;
    ex := 0;
    while (i <= n) and (s[i] >= '0') and (s[i] <= '9') do begin
      ex := ex * 10 + ord(s[i]) - 48;
      i := i + 1;
    end;
    if eneg then scale := scale - ex else scale := scale + ex;
  end;
  if (i <= n) or not digit then code := i;
  u.l := 0;
  if (code = 0) and (mant <> 0) then begin
    m[0] := mant and $FFFF; m[1] := (mant shr 16) and $FFFF; m[2] := 0; m[3] := 0; m[4] := 0;
    be := 0;
    Normalize;
    if scale > 60 then scale := 60;                   { far beyond the range of real }
    if scale < -60 then scale := -60;
    for k := 1 to scale do Mul10;
    for k := -1 downto scale do Div10;
    { value = m * 2^be with m in [2^63, 2^64): keep the top 24 bits }
    top := m[3] * 256 + (m[2] shr 8);
    if (m[2] and $80) <> 0 then
      if ((m[2] and $7F) <> 0) or (m[1] <> 0) or (m[0] <> 0) or more or odd(top) then top := top + 1;
    e := be + 63 + 127;                               { biased exponent of top / 2^23 }
    if top = $1000000 then begin top := $800000; e := e + 1; end;
    if e >= 255 then code := n                        { too large for real }
    else if e > 0 then u.l := (longint(e) shl 23) or (top and $7FFFFF);
  end;
  if neg and (u.l <> 0) then u.l := u.l or not longint($7FFFFFFF);
  _valreal := u.r;
end;

begin
  HeapInit;
  RandSeed := 1;
  LineValid := false;
  IoErr := 0; Slots := 0; OutMode := 0; InMode := 0;
  { files go to the drive of the last DOS request (where the program came from) }
  CurDrive := Mem[PB];
  if CurDrive > 3 then CurDrive := 1;
end.
