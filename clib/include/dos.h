/* <dos.h> - the dos unit of the MERIDIAN library (lib/dos.pas), for C.
   MERIDIAN Pascal - Dos unit (TRUHE / DOS in the system ROM)
   Files on the FAT16 disk images (drives 1 and 2), the cartridge save
   (drive 0) and the SD card folder games/MERIDIAN/files (drive 3).
   Data is moved between files and memory at 24-bit addresses, so anything
   from a Pascal variable (Addr(x)) to expansion RAM can be loaded or saved.

   Its routines, constants, variables and types can be used from C under
   their Pascal names (in any case): integer is int, word unsigned, byte
   unsigned char, longint long, boolean a 0/1 int, real float; a string
   parameter takes a C string, a function returning a string gives a
   char * (valid until the calling function returns); a var parameter
   takes an address (&x).

   The interface of the unit:

   const
     { DosError values }
     deOk = 0; deInvalid = 1; deNotFound = 2; deFull = 3; deNoDisk = 4;
     deNoFat16 = 5; deReadOnly = 6; deDirFull = 7; deTooLarge = 8; deBadName = 9;

   var
     DosError: integer;
     CurrentDrive: integer;

   procedure SetDrive(d: integer);
   function  LoadFile(const name: string; addr: longint; maxLen: longint): longint;
   function  LoadMer(const name: string): longint;
   function  SaveFile(const name: string; addr: longint; len: longint): boolean;
   function  SaveMer(const name: string; addr: longint; len: longint): boolean;
   function  DeleteFile(const name: string): boolean;
   function  FileExists(const name: string): boolean;
   function  DirEntry(index: integer; var name: string; var size: longint): boolean;
   function  DiskFree: longint;
   function  VarAddr(p: pointer): longint;
   function  DosErrorText(e: integer): string;
*/
#ifndef _DOS_H
#define _DOS_H
#pragma unit dos
#endif
