#ifndef _MERIDIAN_H
#define _MERIDIAN_H

/* The machine: memory and the chips' registers, and the System unit's
   own routines (Random, KernelMode, Target, EscPressed, MemAvail, ...).

   PEEK/POKE reach all of memory with 24-bit addresses: the chips'
   registers in bank 0 ($C000...), chip RAM ($02:0000...), expansion RAM.
   On SCHUB they go through the uncached alias, as they must for the chips.

       POKE(0xC00B, 1);                  enable the frame interrupt
       unsigned char __far *vram = (unsigned char __far *)0x020000L;
       vram[320 * y + x] = colour;       a pixel of the Graph bitmap
*/
#pragma unit system

#define PEEK(a)   (*(volatile unsigned char __far *)(unsigned long)(a))
#define PEEKW(a)  (*(volatile unsigned int __far *)(unsigned long)(a))
#define PEEKL(a)  (*(volatile unsigned long __far *)(unsigned long)(a))
#define POKE(a, v)  (PEEK(a) = (v))
#define POKEW(a, v) (PEEKW(a) = (v))
#define POKEL(a, v) (PEEKL(a) = (v))

/* a near pointer (the program's own memory) as a 24-bit address */
#define FARPTR(p) ((unsigned char __far *)(p))

#define TARGET_M816 1
#define TARGET_SCHUB 2

#endif
