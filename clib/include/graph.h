/* <graph.h> - the graph unit of the MERIDIAN library (lib/graph.pas), for C.
   MERIDIAN Pascal - Graph unit
   320 x 240 bitmap graphics with 256 colours on PINSEL. The picture lives in
   chip RAM at $02:0000 (76 800 bytes, like BASIC's GRAPHIC). Filled boxes
   and clearing use the KRAN blitter.

   Its routines, constants, variables and types can be used from C under
   their Pascal names (in any case): integer is int, word unsigned, byte
   unsigned char, longint long, boolean a 0/1 int, real float; a string
   parameter takes a C string, a function returning a string gives a
   char * (valid until the calling function returns); a var parameter
   takes an address (&x).

   The interface of the unit:

   const
     GetMaxX = 319;
     GetMaxY = 239;
     GraphBase = $020000;

   procedure InitGraph;              { bitmap on layer A, text hidden }
   procedure InitGraphOverText;      { bitmap on layer B over the text, colour 0 transparent }
   procedure CloseGraph;             { back to the text screen }
   procedure ClearDevice(c: byte);
   procedure PutPixel(x, y: integer; c: byte);
   function  GetPixel(x, y: integer): byte;
   procedure Line(x1, y1, x2, y2: integer; c: byte);
   procedure HLine(x1, x2, y: integer; c: byte);
   procedure VLine(x, y1, y2: integer; c: byte);
   procedure Rectangle(x1, y1, x2, y2: integer; c: byte);
   procedure Bar(x1, y1, x2, y2: integer; c: byte);
   procedure Circle(xc, yc, r: integer; c: byte);
   procedure FillCircle(xc, yc, r: integer; c: byte);
   procedure Ellipse(xc, yc, rx, ry: integer; c: byte);
   procedure OutTextXY(x, y: integer; const s: string; c: byte);
   procedure OutTextXYBg(x, y: integer; const s: string; c, bg: byte);
   procedure SetRGB(index: byte; r, g, b: byte);    { 0..15 each }
   procedure SetRGB8(index: byte; r, g, b: byte);   { 0..255 each, reduced to 4 bit }
   procedure ScrollUp(lines: integer; fill: byte);
   procedure WaitVSync;
*/
#ifndef _GRAPH_H
#define _GRAPH_H
#pragma unit graph
#endif
