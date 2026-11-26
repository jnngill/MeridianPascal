/* <crt.h> - the crt unit of the MERIDIAN library (lib/crt.pas), for C.
   MERIDIAN Pascal - Crt unit
   Text screen, keyboard and timing in the style of Turbo Pascal's Crt.
   The screen is PINSEL layer A in text mode (40 or 80 columns, 30 rows);
   output goes through the kernel's CHROUT, so the kernel's cursor and
   colours stay in step.

   Its routines, constants, variables and types can be used from C under
   their Pascal names (in any case): integer is int, word unsigned, byte
   unsigned char, longint long, boolean a 0/1 int, real float; a string
   parameter takes a C string, a function returning a string gives a
   char * (valid until the calling function returns); a var parameter
   takes an address (&x).

   The interface of the unit:

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
*/
#ifndef _CRT_H
#define _CRT_H
#pragma unit crt
#endif
