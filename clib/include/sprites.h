/* <sprites.h> - the sprites unit of the MERIDIAN library (lib/sprites.pas), for C.
   MERIDIAN Pascal - Sprites unit (KOBOLD)
   32 hardware sprites of 16 x 16 pixels (32 x 32 doubled), 16 colours each
   from a palette bank, 128 patterns in KOBOLD's own pattern memory. Sprite 0
   is in front, sprite 31 at the back. Coordinates are screen pixels.

   Its routines, constants, variables and types can be used from C under
   their Pascal names (in any case): integer is int, word unsigned, byte
   unsigned char, longint long, boolean a 0/1 int, real float; a string
   parameter takes a C string, a function returning a string gives a
   char * (valid until the calling function returns); a var parameter
   takes an address (&x).

   The interface of the unit:

   const
     MaxSprite = 31;
     MaxPattern = 127;
     { flags for SetSpriteFlags }
     sfFlipX = $10;
     sfFlipY = $20;
     sfBehind = $40;     { behind layer B }
     sfDouble = $80;     { 32 x 32 }

   type
     TPattern = array[0..127] of byte;    { 16 rows of 8 bytes, left pixel in the upper nibble }

   procedure SpritesOn;
   procedure SpritesOff;
   procedure DefinePattern(n: integer; const p: TPattern);
   procedure SetPatternRow(n, row: integer; const hex: string);
   procedure ClearPattern(n: integer);
   procedure SetSprite(n, x, y, pattern, bank: integer);
   procedure MoveSprite(n, x, y: integer);
   procedure SetSpritePattern(n, pattern: integer);
   procedure SetSpriteBank(n, bank: integer);
   procedure SetSpriteFlags(n, flags: integer);
   procedure ShowSprite(n: integer);
   procedure HideSprite(n: integer);
   procedure HideAllSprites;
   function  SpriteX(n: integer): integer;
   function  SpriteY(n: integer): integer;
   function  SpriteHit(n: integer): boolean;
   procedure ClearHits;
*/
#ifndef _SPRITES_H
#define _SPRITES_H
#pragma unit sprites
#endif
