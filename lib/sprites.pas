{ MERIDIAN Pascal - Sprites unit (KOBOLD)
  32 hardware sprites of 16 x 16 pixels (32 x 32 doubled), 16 colours each
  from a palette bank, 128 patterns in KOBOLD's own pattern memory. Sprite 0
  is in front, sprite 31 at the back. Coordinates are screen pixels. }
unit Sprites;

interface

const
  MaxSprite = 31;
  MaxPattern = 127;
  { flags for SetSpriteFlags }
  sfFlipX = $10;
  sfFlipY = $20;
  sfBehind = $40;     { behind layer B }
  sfDouble = $80;     { 32 x 32 }

type
  TPattern = array[0..127] of byte;    { 16 rows of 8 bytes, left pixel in the upper nibble }

procedure SpritesOn;
procedure SpritesOff;
procedure DefinePattern(n: integer; const p: TPattern);
procedure SetPatternRow(n, row: integer; const hex: string);
procedure ClearPattern(n: integer);
procedure SetSprite(n, x, y, pattern, bank: integer);
procedure MoveSprite(n, x, y: integer);
procedure SetSpritePattern(n, pattern: integer);
procedure SetSpriteBank(n, bank: integer);
procedure SetSpriteFlags(n, flags: integer);
procedure ShowSprite(n: integer);
procedure HideSprite(n: integer);
procedure HideAllSprites;
function  SpriteX(n: integer): integer;
function  SpriteY(n: integer): integer;
function  SpriteHit(n: integer): boolean;
procedure ClearHits;

implementation

var
  Shadow: TPattern;

procedure SpritesOn;  begin Mem[$C403] := 1; end;
procedure SpritesOff; begin Mem[$C403] := 0; end;

procedure DefinePattern(n: integer; const p: TPattern);
var i: integer;
    a: word;
begin
  a := word(n and 127) * 128;
  Mem[$C400] := a and 255;
  Mem[$C401] := a shr 8;
  for i := 0 to 127 do Mem[$C402] := p[i];
end;

function HexVal(c: char): integer;
begin
  c := UpCase(c);
  if (c >= '0') and (c <= '9') then HexVal := ord(c) - 48
  else if (c >= 'A') and (c <= 'F') then HexVal := ord(c) - 55
  else HexVal := 0;
end;

{ one row as 16 hex digits, one per pixel: '0011223344556677' }
procedure SetPatternRow(n, row: integer; const hex: string);
var i: integer;
    a: word;
    b: byte;
begin
  a := word(n and 127) * 128 + word(row and 15) * 8;
  Mem[$C400] := a and 255;
  Mem[$C401] := a shr 8;
  for i := 0 to 7 do begin
    b := 0;
    if 2 * i + 1 <= length(hex) then b := HexVal(hex[2 * i + 1]) shl 4;
    if 2 * i + 2 <= length(hex) then b := b or HexVal(hex[2 * i + 2]);
    Mem[$C402] := b;
  end;
end;

procedure ClearPattern(n: integer);
begin
  FillChar(Shadow, 128, 0);
  DefinePattern(n, Shadow);
end;

procedure MoveSprite(n, x, y: integer);
var b: word;
begin
  b := $C300 + word(n and 31) * 8;
  x := x + 32; y := y + 32;
  Mem[b] := x and 255;
  Mem[b + 1] := (x shr 8) and 1;
  Mem[b + 2] := y and 255;
  Mem[b + 3] := (y shr 8) and 1;
end;

procedure SetSpritePattern(n, pattern: integer);
begin
  Mem[$C304 + word(n and 31) * 8] := pattern and 127;
end;

procedure SetSpriteBank(n, bank: integer);
var a: word;
begin
  a := $C305 + word(n and 31) * 8;
  Mem[a] := (Mem[a] and $F0) or (bank and 15);
end;

procedure SetSpriteFlags(n, flags: integer);
var a: word;
begin
  a := $C305 + word(n and 31) * 8;
  Mem[a] := (Mem[a] and $0F) or (flags and $F0);
end;

procedure ShowSprite(n: integer);
var a: word;
begin
  a := $C306 + word(n and 31) * 8;
  Mem[a] := Mem[a] or 1;
end;

procedure HideSprite(n: integer);
var a: word;
begin
  a := $C306 + word(n and 31) * 8;
  Mem[a] := Mem[a] and $FE;
end;

procedure SetSprite(n, x, y, pattern, bank: integer);
begin
  MoveSprite(n, x, y);
  SetSpritePattern(n, pattern);
  Mem[$C305 + word(n and 31) * 8] := bank and 15;
  ShowSprite(n);
  SpritesOn;
end;

procedure HideAllSprites;
var i: integer;
begin
  for i := 0 to 31 do Mem[$C306 + i * 8] := 0;
end;

function SpriteX(n: integer): integer;
var b: word;
begin
  b := $C300 + word(n and 31) * 8;
  SpriteX := (Mem[b] or (integer(Mem[b + 1] and 1) shl 8)) - 32;
end;

function SpriteY(n: integer): integer;
var b: word;
begin
  b := $C302 + word(n and 31) * 8;
  SpriteY := (Mem[b] or (integer(Mem[b + 1] and 1) shl 8)) - 32;
end;

function SpriteHit(n: integer): boolean;
begin
  SpriteHit := (Mem[$C404 + (n and 31) shr 3] and (1 shl (n and 7))) <> 0;
end;

procedure ClearHits;
begin
  Mem[$C404] := 0;
end;

end.
