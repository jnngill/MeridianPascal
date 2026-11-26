/* <workshop.h> - the workshop unit of the MERIDIAN library (lib/workshop.pas), for C.

   Its routines, constants, variables and types can be used from C under
   their Pascal names (in any case): integer is int, word unsigned, byte
   unsigned char, longint long, boolean a 0/1 int, real float; a string
   parameter takes a C string, a function returning a string gives a
   char * (valid until the calling function returns); a var parameter
   takes an address (&x).

   The interface of the unit:

   const
     wsOk = 0;
     wsTooBig = 8;          { file too big for the load buffer }
     wsBadValue = 1;        { a value out of range (BASIC: ILLEGAL QUANTITY) }
     wsNoSdram = 14;        { no expansion memory }
     wsNotHere = 255;       { not on SCHUB }

     { where the data is }
     TileBase    = $034000;   { 256 tiles of 32 bytes (8 rows of 4 bytes, as PINSEL reads them) }
     Map1Base    = $036000;   { map 1: 64 x 32 cells of 2 bytes }
     Map2Base    = $037000;   { map 2 }
     PatternBase = $F80000;   { 128 sprite patterns of 128 bytes }
     PatternBankBase = $F84000;
     TileBankBase = $F84200;
     SoundBase   = $F88000;   { 64 sounds of 132 bytes }
     LookBase    = $F84800;   { palette, glow, ink }
     FontBase    = $F8C000;   { 256 characters of 8 bytes }
     MapW = 64; MapH = 32;

   var
     WsResult: integer;     { 0, or what went wrong in the last call }

   { the workshop data from a file saved by BASIC (".BAS" when the name has no
     ending), on Dos's current drive (Dos.SetDrive; a program starts on drive
     1). Replaces all of it; false if the file could not be read (WsResult =
     Dos.DosError) or the workshop refused it. A file without workshop data
     leaves everything empty. }
   function  WsLoad(const name: string): boolean;
   { empty sprites, tiles, maps and sounds; start colours and the ROM font }
   procedure WsClear;

   { layer 1 (behind, instead of the text) shows map 1, layer 2 (in front,
     instead of the bitmap) map 2, scrolled by x (0..511), y (0..255) pixels }
   procedure MapShow(layer: integer);
   procedure MapScroll(layer, x, y: integer);
   procedure MapOff;      { both layers as before: text and bitmap }

   { cell x (0..63), y (0..31) of map m (1 or 2): tile t (0..255); flags:
     palette bank + 16 mirrored left-right + 32 upside down. Without flags the
     tile keeps the bank it was painted in. }
   procedure SetTile(m, x, y, t: integer);
   procedure SetTileFlags(m, x, y, t, flags: integer);
   function  GetTile(m, x, y: integer): integer;    { 0: empty, also outside the map }

   { sound n (0..63) in the background, on the first free voice from 4 down,
     or on voice v (1..4) }
   procedure Sfx(n: integer);
   procedure SfxOn(n, v: integer);
   procedure SfxStop;
   procedure SfxStopVoice(v: integer);

   procedure UseLook;     { the workshop's palette, glow, ink and font }
   procedure LookOff;     { start colours, no glow, no ink, the ROM font }

   function  PatternBank(n: integer): integer;     { the palette bank a pattern was painted in }
   function  TileBank(t: integer): integer;
*/
#ifndef _WORKSHOP_H
#define _WORKSHOP_H
#pragma unit workshop
#endif
