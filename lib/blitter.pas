{ MERIDIAN Pascal - Blitter unit (KRAN)
  Copies and fills rectangles anywhere in chip RAM and expansion RAM while
  the CPU keeps running. Addresses are 24 bit; strides are the distance in
  bytes from one row to the next (negative allowed). }
unit Blitter;

interface

const
  bmCopy = 0;          { copy }
  bmFill = 1;          { fill with value }
  bmTransparent = 2;   { copy, skip bytes equal to value }
  bmTransparent4 = 3;  { copy, skip nibbles equal to value (16-colour bitmaps) }
  bmBackwards = 4;     { add: each row right to left }
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

implementation

procedure Put24(reg: word; v: longint);
begin
  Mem[reg] := v and 255;
  Mem[reg + 1] := (v shr 8) and 255;
  Mem[reg + 2] := (v shr 16) and 255;
end;

function BlitBusy: boolean;
begin
  BlitBusy := (Mem[$C610] and 1) <> 0;
end;

procedure BlitWait;
begin
  while (Mem[$C610] and 1) <> 0 do ;
end;

procedure Blit(src, dst: longint; width, height: word; srcStride, dstStride: integer; mode, value: byte);
begin
  BlitWait;
  Put24($C600, src);
  Put24($C603, dst);
  MemW[$C606] := width;
  MemW[$C608] := height;
  MemW[$C60A] := word(srcStride);
  MemW[$C60C] := word(dstStride);
  Mem[$C60E] := value;
  Mem[$C60F] := mode and $7F;
  Mem[$C610] := 1;
end;

procedure BlitCopy(src, dst: longint; width, height: word; srcStride, dstStride: integer);
begin
  Blit(src, dst, width, height, srcStride, dstStride, bmCopy, 0);
  BlitWait;
end;

procedure BlitFill(dst: longint; width, height: word; stride: integer; value: byte);
begin
  Blit(0, dst, width, height, 0, stride, bmFill, value);
  BlitWait;
end;

procedure BlitTransparent(src, dst: longint; width, height: word; srcStride, dstStride: integer; key: byte);
begin
  Blit(src, dst, width, height, srcStride, dstStride, bmTransparent, key);
  BlitWait;
end;

procedure MakeJob(var j: TBlitJob; src, dst: longint; width, height: word; srcStride, dstStride: integer; mode, value: byte);
begin
  j.src[0] := src and 255; j.src[1] := (src shr 8) and 255; j.src[2] := (src shr 16) and 255;
  j.dst[0] := dst and 255; j.dst[1] := (dst shr 8) and 255; j.dst[2] := (dst shr 16) and 255;
  j.width := width; j.height := height;
  j.srcStride := srcStride; j.dstStride := dstStride;
  j.value := value; j.mode := mode;
end;

procedure RunJobList(addr: longint);
begin
  BlitWait;
  Put24($C611, addr);
  Mem[$C610] := 2;
  BlitWait;
end;

procedure CopyMem(src, dst: longint; len: word);
begin
  if len = 0 then exit;
  BlitCopy(src, dst, len, 1, 0, 0);
end;

procedure FillMem(dst: longint; len: word; value: byte);
begin
  if len = 0 then exit;
  BlitFill(dst, len, 1, 0, value);
end;

end.
