program WorkshopDemo;
{ Uses what was made in BASIC's workshop (F1-F6): GLOWMINE.BAS from the demo
  disk carries sprites, tiles, two maps, sounds, a look and a font. The maps
  scroll like the example in BASIC.md: map 2 at full speed, map 1 behind it at
  half speed. A key ends it early. It looks for the file on drives 1, 2
  and 3 (the SD card folder games/MERIDIAN/files). }
uses Crt, Dos, Sprites, Workshop;
var x, t, d: integer;
begin
  d := 1;
  SetDrive(d);
  while not WsLoad('GLOWMINE') do begin
    d := d + 1;
    if d > 3 then begin
      WriteLn('GLOWMINE.BAS: ', DosErrorText(WsResult));
      exit;
    end;
    SetDrive(d);
  end;
  UseLook;
  MapShow(1); MapShow(2);
  SpritesOn;
  SetSprite(0, 150, 100, 1, PatternBank(1));
  ShowSprite(0);
  Sfx(1);
  x := 0;
  while (x <= 192) and not KeyPressed do begin
    MapScroll(2, x, 0); MapScroll(1, x div 2, 0);
    WaitVSync; WaitVSync;
    x := x + 2;
  end;
  t := GetTile(2, 10, 20);
  SetTile(2, 10, 20, 0);
  Delay(500);
  HideSprite(0);
  MapOff; LookOff;
  WriteLn('TILE WAS ', t, ' NOW ', GetTile(2, 10, 20));
end.
