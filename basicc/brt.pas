unit BRT;
{ Runtime for programs made by the MERIDIAN BASIC compiler (prototype).
  The MERIDIAN commands run through the same kernel routines BASIC uses
  (values at $03A0, command number in A), so they behave as in BASIC.
  The addresses of those routines are not in the kernel's jump table: the
  compiler fills them in below from kern.lbl of the core it builds for. }

interface

uses Crt;

const
  KBefehl  = $E6F9;   { bb_befehl     }
  KFunkt   = $F5AC;   { bb_funktion   }
  KGrafik  = $E5C7;   { grafik_setzen }
  KPunkt   = $E60E;   { punkt         }
  KLinie   = $E65A;   { linie         }

procedure BArg(i: integer; v: longint);
procedure BCmd(n, count: integer);
function  BFun(n: integer; v: longint): longint;
procedure BGraphic(n: longint);
procedure BPlot(x, y: longint; hasC: boolean; c: longint);
procedure BLine(x1, y1, x2, y2: longint; hasC: boolean; c: longint);
procedure BPattern(m, row: longint; const s: string);
procedure BPause(n: longint);
procedure BCls;
procedure BColor(f: longint; hasB: boolean; b: longint);
procedure BPoke(a, v: longint);
function  BPeek(a: longint): longint;

procedure BPrintS(const s: string);
procedure BPrintI(v: longint);
procedure BPrintR(r: real);
procedure BComma;
procedure BTab(n: longint);
procedure BSpc(n: longint);
procedure BNewLine;
function  BStrI(v: longint): string;
function  BStrR(r: real): string;
function  BVal(const s: string): real;
function  BRnd(x: real): real;
function  BFloor(r: real): longint;
function  BIDiv(a, b: longint): longint;
function  BGet: string;
function  BBool(b: boolean): longint;
procedure BError(const msg: string; line: integer);
procedure BCheckStop(line: integer);

implementation

var
  bpos: integer;
  seed: longint;
  last: real;
  PAnz: byte absolute $039F;          { kernel commands: number of values }
  PWert: array[0..23] of byte absolute $03A0;   { 8 values of 24 bits }
  FWert: array[0..2] of byte absolute $0000;    { kernel functions: value, result }
  PX: word absolute $0380;            { PLOT and LINE }
  PY: byte absolute $0382;
  PX2: word absolute $0383;
  PY2: byte absolute $0385;
  PF: byte absolute $0386;

procedure BArg(i: integer; v: longint);
begin
  Move(v, PWert[i + i + i], 3);
end;

procedure BCmd(n, count: integer);
var r: integer;
begin
  PAnz := count;
  asm
    lda n
    phd
    pea 0
    pld
    sep #$20
    jsr KBefehl
    rep #$30
    pld
    and #$00FF
    sta r
  end;
  if r = 1 then BError('ILLEGAL QUANTITY', -1)
  else if r <> 0 then BError('DOS', -1);
end;

function BFun(n: integer; v: longint): longint;
var r: longint;
begin
  Move(v, FWert[0], 3);
  asm
    lda n
    phd
    pea 0
    pld
    sep #$20
    jsr KFunkt
    rep #$30
    pld
  end;
  r := 0;
  Move(FWert[0], r, 3);
  if FWert[2] >= $80 then r := r - $1000000;
  BFun := r;
end;

procedure BGraphic(n: longint);
var g: integer;
begin
  g := n and 255;
  asm
    lda g
    phd
    pea 0
    pld
    sep #$20
    jsr KGrafik
    rep #$30
    pld
  end;
  PF := 1;
end;

procedure SetXY(x, y: longint);
begin
  PX := x; PY := y;
end;

procedure BPlot(x, y: longint; hasC: boolean; c: longint);
begin
  SetXY(x, y);
  if hasC then PF := c;
  asm
    phd
    pea 0
    pld
    sep #$20
    jsr KPunkt
    rep #$30
    pld
  end;
end;

procedure BLine(x1, y1, x2, y2: longint; hasC: boolean; c: longint);
begin
  SetXY(x1, y1);
  PX2 := x2; PY2 := y2;
  if hasC then PF := c;
  asm
    phd
    pea 0
    pld
    sep #$20
    jsr KLinie
    rep #$30
    pld
  end;
end;

{ PATTERN m,row,"pixels": the kernel reads the text from BASIC's data bank }
procedure BPattern(m, row: longint; const s: string);
var i: integer;
begin
  for i := 1 to length(s) do Mem[$01FF00 + i - 1] := ord(s[i]);
  BArg(0, m); BArg(1, row);
  PWert[6] := length(s); PWert[7] := $00; PWert[8] := $FF;
  BCmd(3, 2);
end;

procedure BPause(n: longint);
var f: byte;
begin
  n := n and 255;
  while n > 0 do begin
    f := Mem[$50];
    while Mem[$50] = f do ;
    n := n - 1;
  end;
end;

procedure BCls;
begin
  bpos := 0;
  Write(chr(12));
end;

procedure BColor(f: longint; hasB: boolean; b: longint);
begin
  Mem[$12] := (Mem[$12] and $F0) or (f and 15);
  if hasB then Mem[$12] := (Mem[$12] and $0F) or ((b and 15) shl 4);
end;

procedure BPoke(a, v: longint);
begin
  if (a < 0) or (a > $FFFFFF) or (v < 0) or (v > 255) then BError('ILLEGAL QUANTITY', -1);
  Mem[a] := v;
end;

function BPeek(a: longint): longint;
begin
  if (a < 0) or (a > $FFFFFF) then BError('ILLEGAL QUANTITY', -1);
  BPeek := Mem[a];
end;

{ ---- PRINT, the way Microsoft BASIC writes numbers }

procedure Out(const s: string);
var i: integer;
begin
  for i := 1 to length(s) do begin
    Write(s[i]);
    if s[i] = chr(13) then bpos := 0 else bpos := bpos + 1;
  end;
end;

procedure BPrintS(const s: string); begin Out(s); end;

function BStrI(v: longint): string;
begin
  if v < 0 then BStrI := IntToStr(v) else BStrI := ' ' + IntToStr(v);
end;

{ 9 digits in BASIC; a real here has about 7 }
function BStrR(r: real): string;
var neg: boolean;
    e, i, p: integer;
    d: longint;
    s, t: string;
begin
  if r = 0 then begin BStrR := ' 0'; exit; end;
  if (r = Int(r)) and (Abs(r) < 999999999.0) then begin BStrR := BStrI(Trunc(r)); exit; end;
  neg := r < 0; if neg then r := -r;
  e := 0;
  while r >= 10.0 do begin r := r / 10.0; e := e + 1; end;
  while r < 1.0 do begin r := r * 10.0; e := e - 1; end;
  d := Round(r * 1000000.0);
  if d >= 10000000 then begin d := d div 10; e := e + 1; end;
  s := IntToStr(d);                         { 7 digits }
  while (length(s) > 1) and (s[length(s)] = '0') do Delete(s, length(s), 1);
  if (e < -2) or (e > 8) then begin
    t := s[1];
    if length(s) > 1 then t := t + '.' + Copy(s, 2, 10);
    if e < 0 then t := t + 'E-' else t := t + 'E+';
    p := Abs(e);
    if p < 10 then t := t + '0';
    t := t + IntToStr(p);
  end else if e < 0 then begin
    t := '.';
    for i := 1 to -e - 1 do t := t + '0';
    t := t + s;
  end else begin
    while length(s) < e + 1 do s := s + '0';
    t := Copy(s, 1, e + 1);
    if length(s) > e + 1 then t := t + '.' + Copy(s, e + 2, 10);
  end;
  if neg then BStrR := '-' + t else BStrR := ' ' + t;
end;

procedure BPrintI(v: longint); begin Out(BStrI(v) + ' '); end;
procedure BPrintR(r: real); begin Out(BStrR(r) + ' '); end;

{ Microsoft's comma: fields of 14 (CLMWID), a new line beyond the last one }
procedure BComma;
begin
  if bpos >= (ScreenCols div 14 - 1) * 14 then BNewLine
  else repeat Out(' ') until bpos mod 14 = 0;
end;

procedure BTab(n: longint);
begin
  while bpos < n do Out(' ');
end;

procedure BSpc(n: longint);
begin
  while n > 0 do begin Out(' '); n := n - 1; end;
end;

procedure BNewLine;
begin
  WriteLn;
  bpos := 0;
end;

function BVal(const s: string): real;
var r: real;
    c: integer;
    t: string;
    i: integer;
begin
  t := '';
  for i := 1 to length(s) do if s[i] <> ' ' then t := t + s[i];
  i := 1;
  while (i <= length(t)) and (t[i] in ['0'..'9', '.', '-', '+', 'E']) do i := i + 1;
  t := Copy(t, 1, i - 1);
  if (t <> '') and (t[1] = '.') then t := '0' + t;
  Val(t, r, c);
  if c <> 0 then begin
    if c > 1 then Val(Copy(t, 1, c - 1), r, c) else r := 0;
    if c <> 0 then r := 0;
  end;
  BVal := r;
end;

{ RND(x): x > 0 the next number, 0 the last again, x < 0 starts anew from x }
function BRnd(x: real): real;
begin
  if x < 0 then seed := Trunc(x * 1000.0) xor $5DEECE6;
  if x <> 0 then begin
    seed := seed * 1103515245 + 12345;
    last := ((seed shr 8) and $FFFFFF) / 16777216.0;
  end;
  BRnd := last;
end;

function BFloor(r: real): longint;
var t: longint;
begin
  t := Trunc(r);
  if (r < 0) and (t <> r) then t := t - 1;
  BFloor := t;
end;

{ INT(a/b) with whole numbers }
function BIDiv(a, b: longint): longint;
var q: longint;
begin
  if b = 0 then BError('DIVISION BY ZERO', -1);
  q := a div b;
  if ((a mod b) <> 0) and ((a < 0) <> (b < 0)) then q := q - 1;
  BIDiv := q;
end;

function BGet: string;
var c: char;
begin
  if KeyPressed then begin c := ReadKey; BGet := c; end else BGet := '';
end;

function BBool(b: boolean): longint;
begin
  if b then BBool := -1 else BBool := 0;
end;

procedure BError(const msg: string; line: integer);
begin
  WriteLn;
  if line >= 0 then WriteLn('?', msg, ' ERROR IN ', line)
  else WriteLn('?', msg, ' ERROR');
  Halt(1);
end;

procedure BCheckStop(line: integer);
begin
  if EscPressed then begin
    WriteLn; WriteLn('BREAK IN ', line);
    Halt(0);
  end;
end;

begin
  bpos := 0;
  seed := 12345;
  last := 0;
end.
