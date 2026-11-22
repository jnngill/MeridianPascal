{ MERIDIAN Pascal - Crt unit
  Text screen, keyboard and timing in the style of Turbo Pascal's Crt.
  The screen is PINSEL layer A in text mode (40 or 80 columns, 30 rows);
  output goes through the kernel's CHROUT, so the kernel's cursor and
  colours stay in step. }
unit Crt;

interface

const
  { MERIDIAN-16 start palette }
  Black = 0; White = 1; Red = 2; Cyan = 3; Purple = 4; Green = 5; Blue = 6;
  Yellow = 7; Orange = 8; Brown = 9; LightRed = 10; DarkGray = 11; Gray = 12;
  LightGreen = 13; LightBlue = 14; LightGray = 15;

  { key codes returned by ReadKey (MERIDIAN kernel codes) }
  kbHome = #1; kbEsc = #3; kbBell = #7; kbBack = #8; kbEnter = #13; kbInsert = #14;
  kbRight = #28; kbLeft = #29; kbUp = #30; kbDown = #31; kbDelete = #127;

  ScreenRows = 30;

var
  CheckBreak: boolean;   { Esc in ReadKey ends the program (default true) }

procedure ClrScr;
procedure ClrEol;
procedure GotoXY(x, y: integer);
function  WhereX: integer;
function  WhereY: integer;
function  ScreenCols: integer;
procedure TextColor(c: byte);
procedure TextBackground(c: byte);
function  TextAttr: byte;
procedure SetTextAttr(a: byte);
procedure TextMode(cols: integer);
function  KeyPressed: boolean;
function  ReadKey: char;
procedure FlushKeys;
procedure Delay(ms: word);
procedure WaitVSync;
function  Frames: longint;
function  Micros: longint;
procedure Beep;
procedure PutCharAt(x, y: integer; c: char; attr: byte);
function  GetCharAt(x, y: integer): char;
procedure WriteAt(x, y: integer; const s: string; attr: byte);
procedure FillRect(x, y, w, h: integer; c: char; attr: byte);
procedure CursorOff;

implementation

var
  Pending: char;
  HasPending: boolean;
  KCurX: byte absolute $0010;
  KCurY: byte absolute $0011;
  KColor: byte absolute $0012;
  KCols: byte absolute $0015;
  KRowBytes: word absolute $0038;

procedure ClrScr;
begin
  _putchar(#12);
end;

function ScreenCols: integer;
begin
  ScreenCols := KCols;
end;

procedure GotoXY(x, y: integer);
begin
  if x < 1 then x := 1;
  if y < 1 then y := 1;
  if x > KCols then x := KCols;
  if y > ScreenRows then y := ScreenRows;
  { the kernel hides its cursor when it prints; print nothing first }
  KCurX := x - 1;
  KCurY := y - 1;
end;

function WhereX: integer;
begin
  WhereX := KCurX + 1;
end;

function WhereY: integer;
begin
  WhereY := KCurY + 1;
end;

procedure ClrEol;
var x, y, i: integer;
begin
  x := KCurX; y := KCurY;
  for i := x to KCols - 1 do PutCharAt(i + 1, y + 1, ' ', KColor);
end;

procedure TextColor(c: byte);
begin
  KColor := (KColor and $F0) or (c and 15);
end;

procedure TextBackground(c: byte);
begin
  KColor := (KColor and $0F) or ((c and 15) shl 4);
end;

function TextAttr: byte;
begin
  TextAttr := KColor;
end;

procedure SetTextAttr(a: byte);
begin
  KColor := a;
end;

procedure TextMode(cols: integer);
var r: integer;
begin
  if cols <> 80 then cols := 40;
  r := KernelMode(cols);
end;

function KeyPressed: boolean;
begin
  if not HasPending then begin
    Pending := _getkey;
    HasPending := Pending <> #0;
  end;
  KeyPressed := HasPending;
end;

function ReadKey: char;
begin
  while not KeyPressed do ;
  HasPending := false;
  if CheckBreak and (Pending = kbEsc) then _halt(0);
  ReadKey := Pending;
end;

procedure FlushKeys;
begin
  HasPending := false;
  while _getkey <> #0 do ;
end;

function Micros: longint;
begin
  Mem[$C110] := 0;           { freeze the PFORTE microsecond clock }
  Micros := MemL[$C110];
end;

procedure Delay(ms: word);
var start, wait: longint;
begin
  wait := longint(ms) * 1000;
  start := Micros;
  while Micros - start < wait do ;
end;

procedure WaitVSync;
var f: byte;
begin
  f := Mem[$C00F];
  while Mem[$C00F] = f do ;
end;

function Frames: longint;
begin
  Frames := MemL[$0050] and $FFFFFF;
end;

procedure Beep;
begin
  _putchar(#7);
end;

procedure PutCharAt(x, y: integer; c: char; attr: byte);
var a: longint;
begin
  if (x < 1) or (y < 1) or (x > KCols) or (y > ScreenRows) then exit;
  a := $0400 + longint(y - 1) * KRowBytes + (x - 1) * 2;
  Mem[a] := ord(c);
  Mem[a + 1] := attr;
end;

function GetCharAt(x, y: integer): char;
begin
  GetCharAt := chr(Mem[$0400 + longint(y - 1) * KRowBytes + (x - 1) * 2]);
end;

procedure WriteAt(x, y: integer; const s: string; attr: byte);
var i: integer;
begin
  for i := 1 to length(s) do PutCharAt(x + i - 1, y, s[i], attr);
end;

procedure FillRect(x, y, w, h: integer; c: char; attr: byte);
var i, j: integer;
begin
  for j := y to y + h - 1 do
    for i := x to x + w - 1 do PutCharAt(i, j, c, attr);
end;

procedure CursorOff;
begin
  { the kernel shows no cursor while a program runs; kept for TP code }
end;

begin
  HasPending := false;
  CheckBreak := true;
end.
