/* <basic.h> - the basic unit of the MERIDIAN library (lib/basic.pas), for C.
   MERIDIAN Pascal - Basic unit
   Read and set the variables of the BASIC program that started this program
   with BRUN "NAME". Names are written as in BASIC: 'SC' (number), 'N%'
   (integer), 'A$' (string); only the first two characters count, like in
   BASIC. A variable BASIC has not used yet reads as 0 or '' (as in BASIC);
   the Set routines create it.

   How it works: BASIC keeps its program and variables in bank 1, which BRUN
   leaves alone. Its pointers to them are in page zero ($87-$94), which BRUN
   saves in bank $E7 while the program runs and puts back afterwards; this
   unit reads and changes them there. Numbers are converted between BASIC's
   5-byte format and real (BASIC has about 9 digits, real about 7). Arrays:
   one dimension (DIM A(n)), created by BASIC. Works on 65C816 and SCHUB.

   Its routines, constants, variables and types can be used from C under
   their Pascal names (in any case): integer is int, word unsigned, byte
   unsigned char, longint long, boolean a 0/1 int, real float; a string
   parameter takes a C string, a function returning a string gives a
   char * (valid until the calling function returns); a var parameter
   takes an address (&x).

   The interface of the unit:

   { true when the saved BASIC pointers look valid (the program was started
     with BRUN; otherwise all reads give 0 / '' and the Set routines do nothing) }
   function  BasicPresent: boolean;
   function  BasicExists(const name: string): boolean;

   function  BasicReal(const name: string): real;
   function  BasicInt(const name: string): integer;
   function  BasicStr(const name: string): string;
   procedure SetBasicReal(const name: string; v: real);
   procedure SetBasicInt(const name: string; v: integer);
   function  SetBasicStr(const name: string; const s: string): boolean;   { false: no room }

   { arrays with one dimension: number of elements (DIM A(10) -> 11), -1 if none }
   function  BasicArrLen(const name: string): integer;
   function  BasicArrReal(const name: string; i: integer): real;
   function  BasicArrInt(const name: string; i: integer): integer;
   function  BasicArrStr(const name: string; i: integer): string;
   procedure SetBasicArrReal(const name: string; i: integer; v: real);
   procedure SetBasicArrInt(const name: string; i: integer; v: integer);
   function  SetBasicArrStr(const name: string; i: integer; const s: string): boolean;
*/
#ifndef _BASIC_H
#define _BASIC_H
#pragma unit basic
#endif
