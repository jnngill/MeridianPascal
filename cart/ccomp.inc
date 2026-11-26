{ MERIDIAN C on the MERIDIAN: the on-device C compiler of the PASCAL
  cartridge, part of the unit NComp (it shares its code generator, its
  tables and the program layout of Pascal programs compiled on the
  MERIDIAN). CompileC compiles the text at SrcBase like CompileSource;
  F5 / F7 then run and save it the same way. The C library (clib/) is
  in the cartridge, compiled by the PC compiler, as are the headers.
  See cpre.inc (preprocessor and scanner), ctype.inc (types and
  declarators), cexpr.inc (expressions), cstmt.inc (statements,
  declarations, the program). }

{$I cpre.inc}
{$I ctype.inc}
{$I cexpr.inc}
{$I cstmt.inc}
