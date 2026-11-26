/* <audio.h> - the audio unit of the MERIDIAN library (lib/audio.pas), for C.
   MERIDIAN Pascal - Audio unit (ORGEL)
   Four synthesizer voices (SID-like: waveform, ADSR, pulse width, filter)
   and eight sample channels. Frequencies are in Hz.

   Its routines, constants, variables and types can be used from C under
   their Pascal names (in any case): integer is int, word unsigned, byte
   unsigned char, longint long, boolean a 0/1 int, real float; a string
   parameter takes a C string, a function returning a string gives a
   char * (valid until the calling function returns); a var parameter
   takes an address (&x).

   The interface of the unit:

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
*/
#ifndef _AUDIO_H
#define _AUDIO_H
#pragma unit audio
#endif
