{ Sprites demo: a ship on joystick 1 / cursor keys and 12 bouncing balls }
program SpriteDemo;

uses Crt, Sprites, Input;

const
  Balls = 12;

var
  bx, by, dx, dy: array[1..Balls] of integer;
  sx, sy, i, j, hits: integer;
  joyBits: word;

procedure MakePatterns;
begin
  { pattern 0: the ship (colour bank 1 = palette 16..31) }
  SetPatternRow(0, 0,  '0000000FF0000000');
  SetPatternRow(0, 1,  '000000FFFF000000');
  SetPatternRow(0, 2,  '000000F33F000000');
  SetPatternRow(0, 3,  '00000FF33FF00000');
  SetPatternRow(0, 4,  '00000FFFFFF00000');
  SetPatternRow(0, 5,  '0000FFFFFFFF0000');
  SetPatternRow(0, 6,  '000FFFFFFFFFF000');
  SetPatternRow(0, 7,  '00FFF5FFFF5FFF00');
  SetPatternRow(0, 8,  '0FFFF5FFFF5FFFF0');
  SetPatternRow(0, 9,  'FFFFFFFFFFFFFFFF');
  SetPatternRow(0, 10, 'FF00FFFFFFFF00FF');
  SetPatternRow(0, 11, 'F0000FFFFFF0000F');
  SetPatternRow(0, 12, '00000AA00AA00000');
  SetPatternRow(0, 13, '0000AA0000AA0000');
  SetPatternRow(0, 14, '0000A000000A0000');
  SetPatternRow(0, 15, '0000000000000000');
  { pattern 1: a ball }
  SetPatternRow(1, 3,  '0000066666600000');
  SetPatternRow(1, 4,  '0006677777660000');
  SetPatternRow(1, 5,  '0067711777766000');
  SetPatternRow(1, 6,  '0677117777776600');
  SetPatternRow(1, 7,  '0677777777776600');
  SetPatternRow(1, 8,  '0677777777776600');
  SetPatternRow(1, 9,  '0667777777766600');
  SetPatternRow(1, 10, '0066777777666000');
  SetPatternRow(1, 11, '0006666666600000');
end;

begin
  ClrScr;
  TextColor(Yellow);
  WriteLn('SPRITES - MOVE WITH CURSOR KEYS');
  WriteLn('OR JOYSTICK 1, ESC ENDS.');
  MakePatterns;
  sx := 152; sy := 200;
  SetSprite(0, sx, sy, 0, 1);
  SetSpriteFlags(0, sfDouble);
  Randomize;
  for i := 1 to Balls do begin
    bx[i] := Random(300); by[i] := 20 + Random(150);
    dx[i] := Random(5) - 2; if dx[i] = 0 then dx[i] := 1;
    dy[i] := Random(5) - 2; if dy[i] = 0 then dy[i] := -1;
    SetSprite(i, bx[i], by[i], 1, 2 + i mod 6);
  end;
  hits := 0;
  ClearHits;
  repeat
    WaitVSync;
    joyBits := Joy(1);
    if KeyDown(scLeft) or (joyBits and joyLeft <> 0) then sx := sx - 3;
    if KeyDown(scRight) or (joyBits and joyRight <> 0) then sx := sx + 3;
    if KeyDown(scUp) or (joyBits and joyUp <> 0) then sy := sy - 3;
    if KeyDown(scDown) or (joyBits and joyDown <> 0) then sy := sy + 3;
    if sx < 0 then sx := 0;
    if sx > 288 then sx := 288;
    if sy < 24 then sy := 24;
    if sy > 208 then sy := 208;
    MoveSprite(0, sx, sy);
    for i := 1 to Balls do begin
      bx[i] := bx[i] + dx[i];
      by[i] := by[i] + dy[i];
      if (bx[i] < 0) or (bx[i] > 304) then dx[i] := -dx[i];
      if (by[i] < 16) or (by[i] > 224) then dy[i] := -dy[i];
      MoveSprite(i, bx[i], by[i]);
    end;
    if SpriteHit(0) then begin
      hits := hits + 1;
      ClearHits;
      GotoXY(1, 4); TextColor(LightRed); Write('HITS: ', hits, '  ');
    end;
  until EscPressed;
  HideAllSprites;
  SpritesOff;
  GotoXY(1, 6);
  TextColor(White);
  WriteLn('GOODBYE.');
end.
