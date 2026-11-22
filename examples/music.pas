{ Music demo: a melody with bass on the ORGEL synth voices }
program MusicDemo;

uses Crt, Audio;

const
  { MIDI notes, 0 = rest }
  Melody: array[0..31] of byte = (
    64, 0, 64, 0, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62,
    62, 0, 64, 0, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 62);
  Bass: array[0..7] of byte = (36, 36, 43, 43, 40, 40, 43, 43);

var
  i, step: integer;

begin
  ClrScr;
  TextColor(LightGreen);
  WriteLn('ORGEL - VOICE 0 PULSE, VOICE 1 SAW BASS');
  WriteLn('ESC ENDS');
  SetVoice(0, wPulse, 1, 6, 8, 4);
  SetPulse(0, 1200);
  SetVolume(0, 12);
  SetVoice(1, wSaw, 0, 8, 6, 3);
  SetVolume(1, 9);
  SetPan(0, 15, 8);
  SetPan(1, 8, 15);
  for step := 0 to 63 do begin
    i := step mod 32;
    GotoXY(1, 4); Write('STEP ', step: 2);
    if Melody[i] <> 0 then begin SetNote(0, Melody[i]); NoteOn(0); end;
    if step mod 4 = 0 then begin SetNote(1, Bass[(step div 4) mod 8]); NoteOn(1); end;
    Delay(140);
    NoteOff(0);
    if step mod 4 = 3 then NoteOff(1);
    Delay(40);
    if EscPressed then break;
  end;
  Silence;
  WriteLn;
  WriteLn('DONE.');
end.
