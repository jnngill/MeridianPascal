/* <copper.h> - the copper unit of the MERIDIAN library (lib/copper.pas), for C.
   MERIDIAN Pascal - Copper unit (LOTSE)
   Builds a copper list in chip RAM: wait for a raster line, set chip
   registers, change palette colours - every frame, in step with the beam.
   Lines run 0..239 (visible); a list starts again every frame.

   Its routines, constants, variables and types can be used from C under
   their Pascal names (in any case): integer is int, word unsigned, byte
   unsigned char, longint long, boolean a 0/1 int, real float; a string
   parameter takes a C string, a function returning a string gives a
   char * (valid until the calling function returns); a var parameter
   takes an address (&x).

   The interface of the unit:

   const
     CopperBase = $038000;      { default list address (chip RAM, bank 3, free) }

   procedure CopBegin(addr: longint);
   procedure CopWait(line: integer);
   procedure CopWaitX(line, x: integer);
   procedure CopSet(reg: word; value: byte);
   procedure CopColor(index: byte; r, g, b: byte);
   procedure CopWaitBlitter;
   procedure CopEnd;
   procedure CopperOn;
   procedure CopperOff;
   function  CopSize: longint;
*/
#ifndef _COPPER_H
#define _COPPER_H
#pragma unit copper
#endif
