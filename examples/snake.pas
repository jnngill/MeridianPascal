{ Snake - a text-mode game with Crt: cursor keys steer, Esc ends }
program Snake;

uses Crt;

const
  W = 40; H = 28;
  MaxLen = 400;

var
  sx, sy: array[1..MaxLen] of integer;
  len, dir, i, fx, fy, score, speed: integer;
  head: integer;
  dead: boolean;
  k: char;

procedure PlaceFood;
begin
  repeat
    fx := 2 + Random(W - 2);
    fy := 3 + Random(H - 2);
  until GetCharAt(fx, fy) = ' ';
  PutCharAt(fx, fy, '*', $67);
end;

procedure DrawBorder;
var x, y: integer;
begin
  for x := 1 to W do begin
    PutCharAt(x, 2, '#', $6B);
    PutCharAt(x, H + 1, '#', $6B);
  end;
  for y := 2 to H + 1 do begin
    PutCharAt(1, y, '#', $6B);
    PutCharAt(W, y, '#', $6B);
  end;
end;

begin
  Randomize;
  ClrScr;
  DrawBorder;
  len := 4;
  for i := 1 to len do begin sx[i] := 20 - i; sy[i] := 15; PutCharAt(sx[i], sy[i], 'O', $65); end;
  dir := 0; { 0 right, 1 down, 2 left, 3 up }
  score := 0;
  speed := 6;
  PlaceFood;
  dead := false;
  repeat
    WriteAt(2, 1, 'SCORE ' + IntToStr(score) + '   ', $6E);
    for i := 1 to speed do WaitVSync;
    while KeyPressed do begin
      k := ReadKey;
      if (k = kbRight) and (dir <> 2) then dir := 0;
      if (k = kbDown) and (dir <> 3) then dir := 1;
      if (k = kbLeft) and (dir <> 0) then dir := 2;
      if (k = kbUp) and (dir <> 1) then dir := 3;
    end;
    { tail off, body forward }
    PutCharAt(sx[len], sy[len], ' ', $6E);
    for i := len downto 2 do begin sx[i] := sx[i - 1]; sy[i] := sy[i - 1]; end;
    case dir of
      0: sx[1] := sx[1] + 1;
      1: sy[1] := sy[1] + 1;
      2: sx[1] := sx[1] - 1;
      3: sy[1] := sy[1] - 1;
    end;
    if (sx[1] = fx) and (sy[1] = fy) then begin
      score := score + 10;
      if len < MaxLen then begin len := len + 1; sx[len] := sx[len - 1]; sy[len] := sy[len - 1]; end;
      if (score mod 50 = 0) and (speed > 2) then speed := speed - 1;
      Beep;
      PlaceFood;
    end else if GetCharAt(sx[1], sy[1]) <> ' ' then dead := true;
    PutCharAt(sx[1], sy[1], 'O', $65);
  until dead;
  GotoXY(14, 15);
  TextColor(Yellow);
  Write(' GAME OVER ');
  GotoXY(1, H + 2);
  WriteLn('SCORE: ', score);
end.
