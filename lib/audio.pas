{ MERIDIAN Pascal - Audio unit (ORGEL)
  Four synthesizer voices (SID-like: waveform, ADSR, pulse width, filter)
  and eight sample channels. Frequencies are in Hz. }
unit Audio;

interface

const
  wTriangle = $10;
  wSaw = $20;
  wPulse = $40;
  wNoise = $80;

procedure SetVoice(v: integer; wave: byte; attack, decay, sustain, release: byte);
procedure SetVolume(v: integer; vol: byte);
procedure SetPan(v: integer; left, right: byte);
procedure SetPulse(v: integer; width: word);
procedure SetFreq(v: integer; hz: word);
procedure SetNote(v: integer; note: integer);   { MIDI note number, 69 = A4 = 440 Hz }
procedure NoteOn(v: integer);
procedure NoteOff(v: integer);
procedure PlayNote(v: integer; note: integer; ms: word);
procedure Sound(hz: word);                        { Turbo Pascal style: voice 0 }
procedure NoSound;
procedure Beep;
procedure MasterVolume(vol: byte);
procedure SetFilter(cutoff: word; resonance, voices, mode: byte);
procedure PlaySample(ch: integer; addr: longint; len: longint; rate: word; vol: byte; loop: boolean);
procedure StopSample(ch: integer);
procedure Silence;
function  NoteFreq(note: integer): word;

implementation

const
  { Hz of the notes C8..B8 (MIDI 108..119); lower octaves by shifting }
  Top: array[0..11] of word = (4186, 4435, 4699, 4978, 5274, 5588, 5920, 6272, 6645, 7040, 7459, 7902);

var
  VoiceWave: array[0..3] of byte;

function VB(v: integer): word;
begin
  VB := $C500 + word(v and 3) * 16;
end;

procedure SetFreq(v: integer; hz: word);
var f: longint;
begin
  { FREQ = hz * 2^24 / 1 MHz = hz * 16.777216 }
  f := (longint(hz) * 16777) div 1000 + (longint(hz) * 216) div 1000000;
  Mem[VB(v)] := f and 255;
  Mem[VB(v) + 1] := (f shr 8) and 255;
end;

function NoteFreq(note: integer): word;
var o: integer;
    f: word;
begin
  if note < 0 then note := 0;
  if note > 107 then note := 107;
  f := Top[note mod 12];
  o := 9 - note div 12;
  NoteFreq := f shr o;
end;

procedure SetNote(v: integer; note: integer);
begin
  SetFreq(v, NoteFreq(note));
end;

procedure SetVoice(v: integer; wave: byte; attack, decay, sustain, release: byte);
var b: word;
begin
  b := VB(v);
  VoiceWave[v and 3] := wave and $F0;
  Mem[b + 5] := ((attack and 15) shl 4) or (decay and 15);
  Mem[b + 6] := ((sustain and 15) shl 4) or (release and 15);
  Mem[b + 4] := VoiceWave[v and 3];
  if Mem[b + 7] = 0 then Mem[b + 7] := 15;
  if wave and wPulse <> 0 then SetPulse(v, 2048);
end;

procedure SetVolume(v: integer; vol: byte);
begin
  Mem[VB(v) + 7] := vol and 15;
end;

procedure SetPan(v: integer; left, right: byte);
begin
  Mem[VB(v) + 8] := ((left and 15) shl 4) or (right and 15);
end;

procedure SetPulse(v: integer; width: word);
begin
  Mem[VB(v) + 2] := width and 255;
  Mem[VB(v) + 3] := (width shr 8) and 15;
end;

procedure NoteOn(v: integer);
begin
  if VoiceWave[v and 3] = 0 then VoiceWave[v and 3] := wTriangle;
  Mem[VB(v) + 4] := VoiceWave[v and 3] or 1;
end;

procedure NoteOff(v: integer);
begin
  Mem[VB(v) + 4] := VoiceWave[v and 3];
end;

procedure PlayNote(v: integer; note: integer; ms: word);
var start: longint;
begin
  SetNote(v, note);
  NoteOn(v);
  Mem[$C110] := 0;
  start := MemL[$C110];
  repeat
    Mem[$C110] := 0;
  until MemL[$C110] - start >= longint(ms) * 1000;
  NoteOff(v);
end;

procedure Sound(hz: word);
begin
  if VoiceWave[0] = 0 then SetVoice(0, wPulse, 0, 0, 15, 2);
  SetFreq(0, hz);
  NoteOn(0);
end;

procedure NoSound;
begin
  NoteOff(0);
end;

procedure Beep;
begin
  _putchar(#7);
end;

procedure MasterVolume(vol: byte);
begin
  Mem[$C543] := (Mem[$C543] and $F0) or (vol and 15);
end;

procedure SetFilter(cutoff: word; resonance, voices, mode: byte);
begin
  Mem[$C540] := cutoff and 255;
  Mem[$C541] := (cutoff shr 8) and 7;
  Mem[$C542] := ((resonance and 15) shl 4) or (voices and 15);
  Mem[$C543] := (Mem[$C543] and 15) or (mode and $70);
end;

function SB(ch: integer): word;
begin
  if ch < 4 then SB := $C580 + word(ch) * 16
  else SB := $CC80 + word(ch - 4) * 16;
end;

procedure PlaySample(ch: integer; addr: longint; len: longint; rate: word; vol: byte; loop: boolean);
var b: word;
    step: longint;
begin
  b := SB(ch and 7);
  Mem[b + 11] := 0;
  Mem[b] := addr and 255;
  Mem[b + 1] := (addr shr 8) and 255;
  Mem[b + 2] := (addr shr 16) and 255;
  Mem[b + 3] := len and 255;
  Mem[b + 4] := (len shr 8) and 255;
  Mem[b + 5] := 0;
  Mem[b + 6] := 0;
  Mem[b + 14] := (len shr 16) and 255;
  { step = rate / 15.26 Hz }
  step := (longint(rate) * 100) div 1526;
  Mem[b + 7] := step and 255;
  Mem[b + 8] := (step shr 8) and 255;
  Mem[b + 9] := vol and 63;
  Mem[b + 10] := $FF;
  if loop then Mem[b + 11] := 3 else Mem[b + 11] := 1;
end;

procedure StopSample(ch: integer);
begin
  Mem[SB(ch and 7) + 11] := 0;
end;

procedure Silence;
var i: integer;
begin
  for i := 0 to 3 do Mem[VB(i) + 4] := 0;
  for i := 0 to 7 do StopSample(i);
end;

begin
  Mem[$C543] := (Mem[$C543] and $F0) or 15;
end.
