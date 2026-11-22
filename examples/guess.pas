{ Guess the number - Crt colours, ReadLn and a record of the best score }
program Guess;

uses Crt;

var
  secret, guess, tries, best: integer;
  again: char;

begin
  Randomize;
  best := 0;
  repeat
    ClrScr;
    TextColor(Yellow);
    WriteLn('*** GUESS THE NUMBER ***');
    TextColor(LightBlue);
    WriteLn('I AM THINKING OF A NUMBER 1..100.');
    if best > 0 then WriteLn('BEST SO FAR: ', best, ' TRIES.');
    WriteLn;
    secret := Random(100) + 1;
    tries := 0;
    repeat
      Write('YOUR GUESS? ');
      ReadLn(guess);
      tries := tries + 1;
      if guess < secret then begin TextColor(Orange); WriteLn('TOO SMALL.'); end
      else if guess > secret then begin TextColor(Purple); WriteLn('TOO BIG.'); end;
      TextColor(LightBlue);
    until guess = secret;
    TextColor(LightGreen);
    WriteLn('RIGHT! ', tries, ' TRIES.');
    if (best = 0) or (tries < best) then best := tries;
    TextColor(LightBlue);
    Write('AGAIN (Y/N)? ');
    again := UpCase(ReadKey);
    WriteLn(again);
  until again <> 'Y';
end.
