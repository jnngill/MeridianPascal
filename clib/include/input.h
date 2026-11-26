/* <input.h> - the input unit of the MERIDIAN library (lib/input.pas), for C.
   MERIDIAN Pascal - Input unit (PFORTE)
   Joysticks, keys held down (for games), mouse and the clock.

   Its routines, constants, variables and types can be used from C under
   their Pascal names (in any case): integer is int, word unsigned, byte
   unsigned char, longint long, boolean a 0/1 int, real float; a string
   parameter takes a C string, a function returning a string gives a
   char * (valid until the calling function returns); a var parameter
   takes an address (&x).

   The interface of the unit:

   const
     { joystick bits }
     joyRight = 1; joyLeft = 2; joyDown = 4; joyUp = 8;
     joyFireA = 16; joyFireB = 32; joyFireC = 64; joyFireD = 128;
     joyStart = 256; joySelect = 512;

     { keys for KeyDown: PS/2 scan codes, the cursor keys etc. + 128 }
     scA = $1C; scB = $32; scC = $21; scD = $23; scE = $24; scF = $2B; scG = $34;
     scH = $33; scI = $43; scJ = $3B; scK = $42; scL = $4B; scM = $3A; scN = $31;
     scO = $44; scP = $4D; scQ = $15; scR = $2D; scS = $1B; scT = $2C; scU = $3C;
     scV = $2A; scW = $1D; scX = $22; scY = $35; scZ = $1A;
     sc0 = $45; sc1 = $16; sc2 = $1E; sc3 = $26; sc4 = $25; sc5 = $2E; sc6 = $36;
     sc7 = $3D; sc8 = $3E; sc9 = $46;
     scSpace = $29; scEnter = $5A; scEsc = $76; scBackspace = $66; scTab = $0D;
     scShift = $12; scRShift = $59; scCtrl = $14; scAlt = $11;
     scUp = $F5; scDown = $F2; scLeft = $EB; scRight = $F4;

   function  Joy(n: integer): word;
   function  JoyPressed(n: integer; bits: word): boolean;
   function  KeyDown(scan: integer): boolean;
   function  AnyKeyDown: boolean;
   function  MouseX: integer;
   function  MouseY: integer;
   function  MouseButtons: byte;
   function  MouseWheel: integer;
   procedure SetMouse(x, y: integer);
   procedure SetMouseLimits(maxX, maxY: integer);
   function  Micros: longint;
   procedure GetTime(var hour, min, sec: integer);
   procedure GetDate(var year, month, day, weekday: integer);
*/
#ifndef _INPUT_H
#define _INPUT_H
#pragma unit input
#endif
