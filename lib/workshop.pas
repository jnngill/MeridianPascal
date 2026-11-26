unit Workshop;
{ The workshop's data in Pascal programs: what F1-F6 in BASIC paint and
  compose (sprites, tiles, two maps, sounds, the look, the font), saved with a
  BASIC program (SAVE "GAME" writes them behind the program text).

  WsLoad takes them from such a file, as BASIC's LOAD does; MapShow, SetTile,
  GetTile, Sfx and UseLook do what BASIC's MAP, TILE, TILE(), SFX and LOOK do,
  by calling the same routines in the workshop ROM (jump table at $FF:C000).
  The sprite patterns go straight to KOBOLD: show them with the Sprites unit.
  The data stays in memory after a program ends, and a program started with
  BRUN from BASIC finds what BASIC loaded.

  Needs the SDRAM module (WsResult 14 otherwise). On SCHUB the routines do
  nothing and WsResult is wsNotHere; the data can still be read with Mem[]. }

interface

const
  wsOk = 0;
  wsTooBig = 8;          { file too big for the load buffer }
  wsBadValue = 1;        { a value out of range (BASIC: ILLEGAL QUANTITY) }
  wsNoSdram = 14;        { no expansion memory }
  wsNotHere = 255;       { not on SCHUB }

  { where the data is }
  TileBase    = $034000;   { 256 tiles of 32 bytes (8 rows of 4 bytes, as PINSEL reads them) }
  Map1Base    = $036000;   { map 1: 64 x 32 cells of 2 bytes }
  Map2Base    = $037000;   { map 2 }
  PatternBase = $F80000;   { 128 sprite patterns of 128 bytes }
  PatternBankBase = $F84000;
  TileBankBase = $F84200;
  SoundBase   = $F88000;   { 64 sounds of 132 bytes }
  LookBase    = $F84800;   { palette, glow, ink }
  FontBase    = $F8C000;   { 256 characters of 8 bytes }
  MapW = 64; MapH = 32;

var
  WsResult: integer;     { 0, or what went wrong in the last call }

{ the workshop data from a file saved by BASIC (".BAS" when the name has no
  ending), on Dos's current drive (Dos.SetDrive; a program starts on drive
  1). Replaces all of it; false if the file could not be read (WsResult =
  Dos.DosError) or the workshop refused it. A file without workshop data
  leaves everything empty. }
function  WsLoad(const name: string): boolean;
{ empty sprites, tiles, maps and sounds; start colours and the ROM font }
procedure WsClear;

{ layer 1 (behind, instead of the text) shows map 1, layer 2 (in front,
  instead of the bitmap) map 2, scrolled by x (0..511), y (0..255) pixels }
procedure MapShow(layer: integer);
procedure MapScroll(layer, x, y: integer);
procedure MapOff;      { both layers as before: text and bitmap }

{ cell x (0..63), y (0..31) of map m (1 or 2): tile t (0..255); flags:
  palette bank + 16 mirrored left-right + 32 upside down. Without flags the
  tile keeps the bank it was painted in. }
procedure SetTile(m, x, y, t: integer);
procedure SetTileFlags(m, x, y, t, flags: integer);
function  GetTile(m, x, y: integer): integer;    { 0: empty, also outside the map }

{ sound n (0..63) in the background, on the first free voice from 4 down,
  or on voice v (1..4) }
procedure Sfx(n: integer);
procedure SfxOn(n, v: integer);
procedure SfxStop;
procedure SfxStopVoice(v: integer);

procedure UseLook;     { the workshop's palette, glow, ink and font }
procedure LookOff;     { start colours, no glow, no ink, the ROM font }

function  PatternBank(n: integer): integer;     { the palette bank a pattern was painted in }
function  TileBank(t: integer): integer;

implementation

uses Dos;

var
  PAnz: byte absolute $039F;
  PWert: array[0..23] of byte absolute $03A0;

procedure Arg(i: integer; v: longint);
begin
  Move(v, PWert[i + i + i], 3);
end;

{ ws_basic ($FF:C00C): A = function, values from $03A0, count in $039F }
procedure WsCall(fn, count: integer);
var r: integer;
begin
  PAnz := count;
{$IFDEF SCHUB}
  r := wsNotHere;
{$ELSE}
  asm
    lda fn
    phd
    pea 0
    pld
    sep #$20
    jsl $FFC00C
    rep #$30
    pld
    and #$00FF
    sta r
  end;
{$ENDIF}
  WsResult := r;
end;

{ ws_laden ($FF:C008): the file in the buffer at $FB:0000 to its places }
function LoadCall: integer;
var r: integer;
begin
{$IFDEF SCHUB}
  r := wsNotHere;
{$ELSE}
  asm
    phd
    pea 0
    pld
    sep #$20
    jsl $FFC008
    rep #$30
    pld
    and #$00FF
    sta r
  end;
{$ENDIF}
  LoadCall := r;
end;

function WsLoad(const name: string): boolean;
var n: longint;
    f: string;
begin
  WsLoad := false;
  f := name;
  if Pos('.', f) = 0 then f := f + '.BAS';
  n := LoadFile(f, $FB0000, $20000);                 { the workshop's load buffer }
  if n < 0 then begin WsResult := DosError; exit; end;
  { as BASIC's LOAD: the length in D_LAENGE; the program part is copied to
    P_START (here onto itself in the buffer), at most P_LEN bytes }
  Mem[$16E8] := n and 255; Mem[$16E9] := (n shr 8) and 255; Mem[$16EA] := (n shr 16) and 255;
  Mem[$0390] := $00; Mem[$0391] := $00; Mem[$0392] := $FB;
  Mem[$0393] := $FF; Mem[$0394] := $FF; Mem[$0395] := $FF;
  WsResult := LoadCall;
  WsLoad := WsResult = 0;
end;

procedure WsClear; begin WsCall(4, 0); end;

procedure MapShow(layer: integer); begin Arg(0, layer); WsCall(0, 1); end;
procedure MapScroll(layer, x, y: integer); begin Arg(0, layer); Arg(1, x); Arg(2, y); WsCall(0, 3); end;
procedure MapOff; begin Arg(0, 0); WsCall(0, 1); end;

procedure SetTile(m, x, y, t: integer);
begin Arg(0, m); Arg(1, x); Arg(2, y); Arg(3, t); WsCall(1, 4); end;
procedure SetTileFlags(m, x, y, t, flags: integer);
begin Arg(0, m); Arg(1, x); Arg(2, y); Arg(3, t); Arg(4, flags); WsCall(1, 5); end;

function GetTile(m, x, y: integer): integer;
begin
  Arg(0, m); Arg(1, x); Arg(2, y);
  WsCall(2, 3);
{$IFDEF SCHUB}
  GetTile := 0;
{$ELSE}
  GetTile := Mem[0];                                 { the result in $00-$02 }
{$ENDIF}
end;

procedure Sfx(n: integer); begin Arg(0, n); WsCall(5, 1); end;
procedure SfxOn(n, v: integer); begin Arg(0, n); Arg(1, v); WsCall(5, 2); end;
procedure SfxStop; begin Arg(0, -1); WsCall(5, 1); end;
procedure SfxStopVoice(v: integer); begin Arg(0, -1); Arg(1, v); WsCall(5, 2); end;

procedure UseLook; begin WsCall(7, 0); end;
procedure LookOff; begin Arg(0, 0); WsCall(7, 1); end;

function PatternBank(n: integer): integer; begin PatternBank := Mem[PatternBankBase + (n and 127)]; end;
function TileBank(t: integer): integer; begin TileBank := Mem[TileBankBase + (t and 255)]; end;

begin
  WsResult := 0;
end.
