{ MERIDIAN Pascal - Basic unit
  Read and set the variables of the BASIC program that started this program
  with BRUN "NAME". Names are written as in BASIC: 'SC' (number), 'N%'
  (integer), 'A$' (string); only the first two characters count, like in
  BASIC. A variable BASIC has not used yet reads as 0 or '' (as in BASIC);
  the Set routines create it.

  How it works: BASIC keeps its program and variables in bank 1, which BRUN
  leaves alone. Its pointers to them are in page zero ($87-$94), which BRUN
  saves in bank $E7 while the program runs and puts back afterwards; this
  unit reads and changes them there. Numbers are converted between BASIC's
  5-byte format and real (BASIC has about 9 digits, real about 7). Arrays:
  one dimension (DIM A(n)), created by BASIC. Works on 65C816 and SCHUB. }
unit Basic;

interface

{ true when the saved BASIC pointers look valid (the program was started
  with BRUN; otherwise all reads give 0 / '' and the Set routines do nothing) }
function  BasicPresent: boolean;
function  BasicExists(const name: string): boolean;

function  BasicReal(const name: string): real;
function  BasicInt(const name: string): integer;
function  BasicStr(const name: string): string;
procedure SetBasicReal(const name: string; v: real);
procedure SetBasicInt(const name: string; v: integer);
function  SetBasicStr(const name: string; const s: string): boolean;   { false: no room }

{ arrays with one dimension: number of elements (DIM A(10) -> 11), -1 if none }
function  BasicArrLen(const name: string): integer;
function  BasicArrReal(const name: string; i: integer): real;
function  BasicArrInt(const name: string; i: integer): integer;
function  BasicArrStr(const name: string; i: integer): string;
procedure SetBasicArrReal(const name: string; i: integer; v: real);
procedure SetBasicArrInt(const name: string; i: integer; v: integer);
function  SetBasicArrStr(const name: string; i: integer; const s: string): boolean;

implementation

const
  Saved = $E70000;      { BRUN's copy of page zero }
  Bank1 = $010000;      { BASIC program, variables and strings }
  zTXTTAB = $87; zVARTAB = $89; zARYTAB = $8B; zSTREND = $8D;
  zFRETOP = $8F; zFRESPC = $91; zMEMSIZ = $93;
  kReal = 0; kInt = 1; kStr = 2;

type
  TBits = record
    case boolean of
      true: (r: real);
      false: (l: longint);
  end;

{ words a byte at a time: BASIC's are at odd addresses, which SCHUB cannot
  read as words }
function Word16(a: longint): longint;
begin
  Word16 := Mem[a] + longint(Mem[a + 1]) * 256;
end;

function Ptr(z: integer): longint;
begin
  Ptr := Word16(Saved + z);
end;

procedure SetPtr(z: integer; v: longint);
begin
  Mem[Saved + z] := v and $FF;
  Mem[Saved + z + 1] := (v shr 8) and $FF;
end;

function BasicPresent: boolean;
var t, v, a, s, f, m: longint;
begin
  t := Ptr(zTXTTAB); v := Ptr(zVARTAB); a := Ptr(zARYTAB);
  s := Ptr(zSTREND); f := Ptr(zFRETOP); m := Ptr(zMEMSIZ);
  BasicPresent := (t > 0) and (t <= v) and (v <= a) and (a <= s) and (s <= f) and (f <= m)
    and ((a - v) mod 7 = 0);
end;

{ 'SC' -> the two name bytes as BASIC stores them, and the kind }
function Key(const name: string; var c1, c2: byte; var kind: integer): boolean;
var i: integer;
    c: char;
begin
  Key := false;
  c1 := 0; c2 := 0; kind := kReal;
  i := 1;
  if (length(name) < 1) then exit;
  c := UpCase(name[1]);
  if not (c in ['A'..'Z']) then exit;
  c1 := ord(c);
  i := 2;
  if (i <= length(name)) and (UpCase(name[i]) in ['A'..'Z', '0'..'9']) then begin
    c2 := ord(UpCase(name[i]));
    i := i + 1;
  end;
  while (i <= length(name)) and (UpCase(name[i]) in ['A'..'Z', '0'..'9']) do i := i + 1;
  if i <= length(name) then begin
    if name[i] = '$' then kind := kStr
    else if name[i] = '%' then kind := kInt
    else exit;
    i := i + 1;
  end;
  if i <= length(name) then exit;
  if kind = kStr then c2 := c2 or $80;
  if kind = kInt then begin c1 := c1 or $80; c2 := c2 or $80; end;
  Key := true;
end;

{ address of a simple variable's value (5 bytes), 0 if there is none }
function FindVar(c1, c2: byte): longint;
var p, e: longint;
begin
  FindVar := 0;
  p := Ptr(zVARTAB); e := Ptr(zARYTAB);
  while p < e do begin
    if (Mem[Bank1 + p] = c1) and (Mem[Bank1 + p + 1] = c2) then begin
      FindVar := Bank1 + p + 2;
      exit;
    end;
    p := p + 7;
  end;
end;

{ like BASIC: a new simple variable goes at the end of the simple ones, the
  arrays move up by 7 bytes }
function NewVar(c1, c2: byte): longint;
var a, s, q: longint;
    i: integer;
begin
  NewVar := 0;
  a := Ptr(zARYTAB); s := Ptr(zSTREND);
  if s + 7 > Ptr(zFRETOP) then exit;
  q := s - 1;
  while q >= a do begin
    Mem[Bank1 + q + 7] := Mem[Bank1 + q];
    q := q - 1;
  end;
  Mem[Bank1 + a] := c1;
  Mem[Bank1 + a + 1] := c2;
  for i := 2 to 6 do Mem[Bank1 + a + i] := 0;
  SetPtr(zARYTAB, a + 7);
  SetPtr(zSTREND, s + 7);
  NewVar := Bank1 + a + 2;
end;

function VarAdr(const name: string; want: integer; create: boolean): longint;
var c1, c2: byte;
    kind: integer;
    p: longint;
begin
  VarAdr := 0;
  if not BasicPresent then exit;
  if not Key(name, c1, c2, kind) then exit;
  if kind <> want then exit;
  p := FindVar(c1, c2);
  if (p = 0) and create then p := NewVar(c1, c2);
  VarAdr := p;
end;

{ ---- numbers: BASIC's 5 bytes (exponent, sign + 31 bits) <-> real }
function GetReal(p: longint): real;
var b: TBits;
    e, m: longint;
begin
  e := Mem[p];
  if e <= 2 then begin GetReal := 0.0; exit; end;     { zero (and too small for real) }
  m := (longint(Mem[p + 1] and $7F) shl 16) or (longint(Mem[p + 2]) shl 8) or Mem[p + 3];
  if Mem[p + 4] >= $80 then m := m + 1;                { round to 23 bits }
  e := e - 2;
  if m > $7FFFFF then begin m := 0; e := e + 1; end;
  b.l := (e shl 23) or m;
  if Mem[p + 1] >= $80 then b.l := b.l or not longint($7FFFFFFF);
  GetReal := b.r;
end;

procedure PutReal(p: longint; v: real);
var b: TBits;
    e, m: longint;
    s: byte;
begin
  b.r := v;
  e := (b.l shr 23) and $FF;
  m := b.l and $7FFFFF;
  s := 0;
  if b.l < 0 then s := $80;
  if e = 0 then begin                                  { zero (and denormals) }
    Mem[p] := 0; Mem[p + 1] := 0; Mem[p + 2] := 0; Mem[p + 3] := 0; Mem[p + 4] := 0;
    exit;
  end;
  e := e + 2;
  if e > 255 then begin e := 255; m := $7FFFFF; end;  { too large for BASIC }
  Mem[p] := e;
  Mem[p + 1] := ((m shr 16) and $7F) or s;
  Mem[p + 2] := (m shr 8) and $FF;
  Mem[p + 3] := m and $FF;
  Mem[p + 4] := 0;
end;

function GetInt(p: longint): integer;
var w: longint;
begin
  w := longint(Mem[p]) * 256 + Mem[p + 1];
  if w >= 32768 then w := w - 65536;
  GetInt := w;
end;

procedure PutInt(p: longint; v: integer);
begin
  Mem[p] := (longint(v) shr 8) and $FF;
  Mem[p + 1] := v and $FF;
end;

{ ---- strings: descriptor = length, address in bank 1 (low, high) }
function GetStr(p: longint): string;
var s: string;
    a: longint;
    i, n: integer;
begin
  n := Mem[p];
  a := Bank1 + Mem[p + 1] + longint(Mem[p + 2]) * 256;
  s[0] := chr(n);
  for i := 1 to n do s[i] := chr(Mem[a + i - 1]);
  GetStr := s;
end;

{ new string space below FRETOP, as BASIC's GETSPA does; the old text is
  left for BASIC's garbage collection }
function PutStr(p: longint; const s: string): boolean;
var f: longint;
    i: integer;
begin
  PutStr := false;
  f := Ptr(zFRETOP) - length(s);
  if f < Ptr(zSTREND) then exit;
  for i := 1 to length(s) do Mem[Bank1 + f + i - 1] := ord(s[i]);
  SetPtr(zFRETOP, f);
  SetPtr(zFRESPC, f);
  Mem[p] := length(s);
  Mem[p + 1] := f and $FF;
  Mem[p + 2] := (f shr 8) and $FF;
  PutStr := true;
end;

function BasicExists(const name: string): boolean;
var c1, c2: byte;
    kind: integer;
begin
  BasicExists := false;
  if BasicPresent then
    if Key(name, c1, c2, kind) then BasicExists := FindVar(c1, c2) <> 0;
end;

function BasicReal(const name: string): real;
var p: longint;
begin
  p := VarAdr(name, kReal, false);
  if p = 0 then BasicReal := 0.0 else BasicReal := GetReal(p);
end;

function BasicInt(const name: string): integer;
var p: longint;
begin
  p := VarAdr(name, kInt, false);
  if p = 0 then BasicInt := 0 else BasicInt := GetInt(p);
end;

function BasicStr(const name: string): string;
var p: longint;
begin
  p := VarAdr(name, kStr, false);
  if p = 0 then BasicStr := '' else BasicStr := GetStr(p);
end;

procedure SetBasicReal(const name: string; v: real);
var p: longint;
begin
  p := VarAdr(name, kReal, true);
  if p <> 0 then PutReal(p, v);
end;

procedure SetBasicInt(const name: string; v: integer);
var p: longint;
begin
  p := VarAdr(name, kInt, true);
  if p <> 0 then PutInt(p, v);
end;

function SetBasicStr(const name: string; const s: string): boolean;
var p: longint;
begin
  SetBasicStr := false;
  p := VarAdr(name, kStr, true);
  if p <> 0 then SetBasicStr := PutStr(p, s);
end;

{ ---- arrays: name (2), length (2), dimensions (1), sizes (2 each, high
  byte first), then the elements (5, 2 or 3 bytes) }
function FindArr(const name: string; want: integer; var count: longint): longint;
var c1, c2: byte;
    kind: integer;
    p, e, len: longint;
begin
  FindArr := 0; count := -1;
  if not BasicPresent then exit;
  if not Key(name, c1, c2, kind) then exit;
  if (want >= 0) and (kind <> want) then exit;
  p := Ptr(zARYTAB); e := Ptr(zSTREND);
  while p < e do begin
    if (Mem[Bank1 + p] = c1) and (Mem[Bank1 + p + 1] = c2) then begin
      if Mem[Bank1 + p + 4] <> 1 then exit;           { one dimension only }
      count := longint(Mem[Bank1 + p + 5]) * 256 + Mem[Bank1 + p + 6];
      FindArr := Bank1 + p + 7;
      exit;
    end;
    len := Word16(Bank1 + p + 2);
    if len = 0 then exit;
    p := p + len;
  end;
end;

function Elem(const name: string; want, size, i: integer): longint;
var n, p: longint;
begin
  Elem := 0;
  p := FindArr(name, want, n);
  if (p <> 0) and (i >= 0) and (i < n) then Elem := p + longint(i) * size;
end;

function BasicArrLen(const name: string): integer;
var n: longint;
begin
  if FindArr(name, -1, n) = 0 then BasicArrLen := -1 else BasicArrLen := n;
end;

function BasicArrReal(const name: string; i: integer): real;
var p: longint;
begin
  p := Elem(name, kReal, 5, i);
  if p = 0 then BasicArrReal := 0.0 else BasicArrReal := GetReal(p);
end;

function BasicArrInt(const name: string; i: integer): integer;
var p: longint;
begin
  p := Elem(name, kInt, 2, i);
  if p = 0 then BasicArrInt := 0 else BasicArrInt := GetInt(p);
end;

function BasicArrStr(const name: string; i: integer): string;
var p: longint;
begin
  p := Elem(name, kStr, 3, i);
  if p = 0 then BasicArrStr := '' else BasicArrStr := GetStr(p);
end;

procedure SetBasicArrReal(const name: string; i: integer; v: real);
var p: longint;
begin
  p := Elem(name, kReal, 5, i);
  if p <> 0 then PutReal(p, v);
end;

procedure SetBasicArrInt(const name: string; i: integer; v: integer);
var p: longint;
begin
  p := Elem(name, kInt, 2, i);
  if p <> 0 then PutInt(p, v);
end;

function SetBasicArrStr(const name: string; i: integer; const s: string): boolean;
var p: longint;
begin
  SetBasicArrStr := false;
  p := Elem(name, kStr, 3, i);
  if p <> 0 then SetBasicArrStr := PutStr(p, s);
end;

end.
