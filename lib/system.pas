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

const
  TargetM816 = 1;
  TargetSchub = 2;

var
  RandSeed: longint;
  HeapError: boolean;
  ExitCode: integer;

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
procedure _writechar(c: char; w: integer);
begin
  while w > 1 do begin _putchar(' '); w := w - 1; end;
  _putchar(c);
end;

procedure _writestr(const s: string; w: integer);
var i, n: integer;
begin
  n := ord(s[0]);
  while w > n do begin _putchar(' '); w := w - 1; end;
  for i := 1 to n do _putchar(s[i]);
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
    _putchar(chr(48 + integer(v - hi * 10)));
  end else begin
    _strint(longint(v), w, s, 40);
    _writestr(s, 0);
  end;
end;

procedure _writeln;
begin
  _putchar(#13);
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

procedure _readstr(var s: string; max: integer);
var n: integer;
begin
  NeedLine;
  n := length(LineBuf) - LinePos + 1;
  if n > max then n := max;
  if n < 0 then n := 0;
  if n > 0 then Move(LineBuf[LinePos], s[1], n);
  s[0] := chr(n);
  LinePos := LinePos + n;
end;

function _readchar: char;
begin
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
  _readint := _valint(NextToken, c);
  if c <> 0 then RunError(106);
end;

function _readreal: real;
var c: integer;
begin
  _readreal := _valreal(NextToken, c);
  if c <> 0 then RunError(106);
end;

procedure _readlnend;
begin
  if not LineValid then ReadLine;
  LineValid := false;
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

function _valreal(const s: string; var code: integer): real;
var i, n, ex, scale: integer;
    neg, eneg, digit: boolean;
    v: real;
begin
  i := 1; n := length(s);
  v := 0.0; code := 0;
  while (i <= n) and (s[i] = ' ') do i := i + 1;
  neg := false;
  if (i <= n) and ((s[i] = '-') or (s[i] = '+')) then begin neg := s[i] = '-'; i := i + 1; end;
  digit := false;
  while (i <= n) and (s[i] >= '0') and (s[i] <= '9') do begin
    v := _addreal(_mulreal(v, 10.0), _inttoreal(ord(s[i]) - 48));
    i := i + 1; digit := true;
  end;
  scale := 0;
  if (i <= n) and (s[i] = '.') then begin
    i := i + 1;
    while (i <= n) and (s[i] >= '0') and (s[i] <= '9') do begin
      v := _addreal(_mulreal(v, 10.0), _inttoreal(ord(s[i]) - 48));
      scale := scale - 1;
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
  while scale > 0 do begin v := _mulreal(v, 10.0); scale := scale - 1; end;
  while scale < 0 do begin v := _divreal(v, 10.0); scale := scale + 1; end;
  if neg then v := _negreal(v);
  _valreal := v;
end;

begin
  HeapInit;
  RandSeed := 1;
  LineValid := false;
end.
