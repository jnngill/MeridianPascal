/* <blitter.h> - the blitter unit of the MERIDIAN library (lib/blitter.pas), for C.
   MERIDIAN Pascal - Blitter unit (KRAN)
   Copies and fills rectangles anywhere in chip RAM and expansion RAM while
   the CPU keeps running. Addresses are 24 bit; strides are the distance in
   bytes from one row to the next (negative allowed).

   Its routines, constants, variables and types can be used from C under
   their Pascal names (in any case): integer is int, word unsigned, byte
   unsigned char, longint long, boolean a 0/1 int, real float; a string
   parameter takes a C string, a function returning a string gives a
   char * (valid until the calling function returns); a var parameter
   takes an address (&x).

   The interface of the unit:

   const
     bmCopy = 0;          { copy }
     bmFill = 1;          { fill with value }
     bmTransparent = 2;   { copy, skip bytes equal to value }
     bmTransparent4 = 3;  { copy, skip nibbles equal to value (16-colour bitmaps) }
     bmBackwards = 4;     { add: each row right to left; src and dst are then the
                            RIGHT end of the row (the last byte), as KRAN counts down }
     bmColumn = 8;        { add (SCHUB core): repeat one source byte across the row }
     bmLast = $80;        { in job lists: last job }

   type
     TBlitJob = record
       src: array[0..2] of byte;
       dst: array[0..2] of byte;
       width, height: word;
       srcStride, dstStride: integer;
       value: byte;
       mode: byte;
     end;

   procedure BlitWait;
   function  BlitBusy: boolean;
   procedure Blit(src, dst: longint; width, height: word; srcStride, dstStride: integer; mode, value: byte);
   procedure BlitCopy(src, dst: longint; width, height: word; srcStride, dstStride: integer);
   procedure BlitFill(dst: longint; width, height: word; stride: integer; value: byte);
   procedure BlitTransparent(src, dst: longint; width, height: word; srcStride, dstStride: integer; key: byte);
   procedure MakeJob(var j: TBlitJob; src, dst: longint; width, height: word; srcStride, dstStride: integer; mode, value: byte);
   procedure RunJobList(addr: longint);
   procedure CopyMem(src, dst: longint; len: word);
   procedure FillMem(dst: longint; len: word; value: byte);
*/
#ifndef _BLITTER_H
#define _BLITTER_H
#pragma unit blitter
#endif
