/* <schub.h> - the schub unit of the MERIDIAN library (lib/schub.pas), for C.
   MERIDIAN Pascal - Schub unit
   On the 65C816: find, start and talk to a RISC-V program on the SCHUB
   co-processor (the same mailbox protocol as BASIC's SCHUB() function).
   On both targets: the SCHUB cycle counter for timing.

   Its routines, constants, variables and types can be used from C under
   their Pascal names (in any case): integer is int, word unsigned, byte
   unsigned char, longint long, boolean a 0/1 int, real float; a string
   parameter takes a C string, a function returning a string gives a
   char * (valid until the calling function returns); a var parameter
   takes an address (&x).

   The interface of the unit:

   function  SchubPresent: boolean;
   function  SchubStatus: byte;
   function  SchubRunning: boolean;
   function  SchubCycles: longint;
   function  OnSchub: boolean;           { true when this program runs on SCHUB }
   {$IFNDEF SCHUB}
   procedure SchubStart(addr: longint);
   procedure SchubStop;
   function  SchubCall(n, a, b, c: longint): longint;
   {$ENDIF}
*/
#ifndef _SCHUB_H
#define _SCHUB_H
#pragma unit schub
#endif
