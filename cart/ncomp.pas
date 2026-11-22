{ MERIDIAN Pascal - the on-device compiler (runs from the PASCAL cartridge)

  A one-pass compiler in the style of Wirth's compilers: declarations go
  into a symbol table, expressions become "items" that are loaded when
  needed, and 65C816 machine code is emitted straight into bank $30.
  Library units (System, Crt, Graph, ...) are compiled into the cartridge
  ROM; their routines are found through the cartridge's export table and
  called with the same conventions the cross compiler uses (far model:
  JSL / RTL, arguments pushed left to right, results in A or A/X).

  Units of your own are read from NAME.PAS on the current drive and
  compiled together with the program (their code and data become part of it).

  Memory:  source text     $20:0000 (contiguous, srcLen bytes)
           unit sources    $22:0000 .. $2F:FFFF (loaded while compiling)
           program code    $30:0000 (entry at $30:0000)
           data image      $32:0000 (copied to bank 0 at UserData by the entry code)
           program stack   $A7FF downwards, string temporaries $B7FF downwards }
unit NComp;

interface

uses Dos, Blitter;

const
  SrcBase = $200000;
  CodeBase = $300000;
  DataImg = $320000;
  UserStack = $A7FF;
  StrStackTop = $B7FF;
  { SCHUB programs (RISC-V addresses = MERIDIAN addresses) }
  RvStub = $040000;          { 65C816 host stub }
  RvHeapVar = $0403E0;       { start of the heap, read by the library }
  RvLib = $040400;           { the RV32 library }
  RvCode = $080000;          { program code }
  RvData = $0A0000;          { program variables }
  RvTmpTop = $07FFF0;        { string temporaries (register s1) grow down from here }

var
  ErrMsg: string;
  ErrUnit: string[12];      { the unit file the error is in ('' = the program) }
  ErrLine, ErrCol: integer;
  CodeSize, DataSize: longint;
  MerSize: longint;         { size of the last standalone .MER saved }
  WantSchub: boolean;       { compile for SCHUB (also with $SCHUB at the top of the text) }
  IsSchub: boolean;         { the last compilation was for SCHUB }
  RunEntry: longint;        { where RunUser starts the compiled program }
  LinesDone: integer;

function CartPresent: boolean;
function CompileSource(srcLen: longint): boolean;
{ the text (srcLen bytes at SrcBase) starts with $SCHUB: compiled for SCHUB }
function SchubDirective(n: longint): boolean;
{ after a successful CompileSource: save the program as a .MER that runs
  without the cartridge (it carries the library and a loader) }
function SaveStandalone(const name: string): boolean;
{ before RunUser(RunEntry): put a SCHUB program's library and data in place }
procedure PrepareRun;

implementation

{ ---------------------------------------------------------------- tokens }
const
  sNull = 0; sIdent = 1; sNumber = 2; sString = 3; sEOF = 4; sReal = 5;
  sPlus = 10; sMinus = 11; sTimes = 12; sSlash = 13; sEql = 14; sNeq = 15; sLss = 16;
  sLeq = 17; sGtr = 18; sGeq = 19; sLparen = 20; sRparen = 21; sLbrak = 22; sRbrak = 23;
  sComma = 24; sColon = 25; sSemi = 26; sPeriod = 27; sDotdot = 28; sBecomes = 29;
  sCaret = 30; sAt = 31;
  sAnd = 40; sArray = 41; sBegin = 42; sCase = 43; sConst = 44; sDiv = 45; sDo = 46;
  sDownto = 47; sElse = 48; sEnd = 49; sFor = 50; sFunction = 51; sIf = 52; sIn = 53;
  sMod = 54; sNil = 55; sNot = 56; sOf = 57; sOr = 58; sProcedure = 59; sProgram = 60;
  sRecord = 61; sRepeat = 62; sShl = 63; sShr = 64; sStringKw = 65; sThen = 66; sTo = 67;
  sType = 68; sUntil = 69; sUses = 70; sVar = 71; sWhile = 72; sXor = 73; sWith = 74;
  sGoto = 75; sLabel = 76; sPacked = 77; sSet = 78; sFile = 79;
  NKW = 40;

  { symbol kinds }
  skConst = 1; skVar = 2; skType = 3; skProc = 4; skField = 5; skPar = 6; skAsm = 7;
  { type forms }
  fInt = 1; fChar = 2; fBool = 3; fEnum = 4; fStr = 5; fArr = 6; fRec = 7; fPtr = 8; fNil = 9; fUntyped = 10;
  fReal = 11; fSet = 12;
  { predefined types }
  tInteger = 1; tWord = 2; tByte = 3; tShort = 4; tLong = 5; tLongW = 6; tChar = 7; tBool = 8;
  tString = 9; tPointer = 10; tNil = 11; tUntyped = 12; tReal = 13; tSet = 14;
  { item modes }
  mConst = 1; mGlob = 2; mLoc = 3; mInd = 4; mFar = 5; mFarC = 6; mReg = 7; mCond = 8;
  mStk = 9; mFarStk = 10;
  { conditions: 1..6 from C/Z (unsigned), 11..16 from N/Z (sign of a -1/0/1 result) }
  cEq = 1; cNe = 2; cLt = 3; cGe = 4; cGt = 5; cLe = 6;

  MaxSym = 420;
  MaxType = 160;
  MaxLev = 12;
  MaxLoop = 16;

type
  TName = string[15];
  TSym = record
    name: TName;
    kind: byte;
    typ: integer;
    lev: byte;
    isRef: boolean;    { var parameter (address in the slot) }
    isPar: boolean;    { parameter (offset above the frame) }
    adr: longint;
    next: integer;     { params: next parameter; fields: next field }
    first: integer;    { procs: first parameter }
    npar: byte;
    parsz: integer;
    flags: byte;       { procs: 1 string result, 2 body seen, 4 library }
    hid: integer;      { procs: offset of the hidden string result parameter }
  end;
  TType = record
    form: byte;
    size: word;
    sgn: boolean;
    lo, hi: longint;
    base: integer;     { array element / pointer target }
    fields: integer;   { record: first field }
    al: byte;          { record: alignment (SCHUB) }
  end;
  TItem = record
    mode: byte;
    typ: integer;
    a: longint;
    tmp: boolean;      { string in a temporary }
    tj, fj: longint;   { conditions: chains of jumps taken when true / false }
  end;
  TRealBits = record
    case integer of
      0: (r: real);
      1: (l: longint);
  end;

var
  { scanner }
  ch: char;
  srcPos, srcEnd, curBase: longint;
  line, col, tokLine, tokCol: integer;
  sym: integer;
  id: TName;
  num: longint;
  str: string;
  kwName: array[1..NKW] of string[9];
  kwSym: array[1..NKW] of byte;
  { tables }
  syms: array[1..MaxSym] of TSym;
  nSym: integer;
  types: array[1..MaxType] of TType;
  nType: integer;
  { export table }
  ExpBase, ParBase, TypBase: longint;
  ExpCount: integer;
  UserData: word;
  impType: array[0..63] of integer;
  { runtime addresses }
  aMul16, aDiv16s, aDiv16u, aMod16s, aMod16u, aShl16, aShr16: longint;
  aMul32, aDiv32s, aMod32s, aShl32, aShr32, aCmp32s: longint;
  aLdf8, aLdf16, aLdf32, aStf8, aStf16, aStf32, aExit, aLibinit: longint;
  aT0, aA, aB, aFp, aV, aStp, aHeapbase, aSavesp: word;
  { code }
  pc: longint;
  dataTop: longint;
  { procedure contexts }
  curLev: integer;
  ctxFS: array[0..MaxLev] of integer;
  ctxLoc: array[0..MaxLev] of integer;
  ctxFrozen: array[0..MaxLev] of boolean;
  ctxProc: array[0..MaxLev] of integer;
  ctxExit: array[0..MaxLev] of longint;
  ctxRes: array[0..MaxLev] of integer;    { dp offset of the function result }
  { structured value parameters copied into the frame at entry }
  cpN: array[0..MaxLev] of integer;
  cpSrc, cpSym, cpSize: array[0..MaxLev, 1..8] of integer;
  { large locals are placed after the small ones (direct page reach) }
  defN: array[0..MaxLev] of integer;
  defSym: array[0..MaxLev, 1..24] of integer;
  defPlaced: array[0..MaxLev] of boolean;
  { loops }
  nLoop: integer;
  loopBreak, loopCont: array[1..MaxLoop] of longint;
  loopContAdr: array[1..MaxLoop] of longint;
  { string temporaries allocated and not yet released }
  nTmp: integer;
  { WITH: records in scope; non-variable records go through frame slots }
  hasWith: boolean;
  ctxWith: array[0..MaxLev] of integer;
  nWith: integer;
  withTyp: array[1..8] of integer;
  withMode: array[1..8] of byte;
  withA: array[1..8] of longint;
  aSpare: word;
  { target }
  rv: boolean;
  cBase, dataOrg: longint;
  aRtError, aMemmove: longint;
  { units of your own }
  curFile: string[12];
  inInterface: boolean;
  nUnit, nInit: integer;
  unitName: array[1..12] of TName;
  unitDone: array[1..12] of boolean;
  unitInit: array[1..12] of longint;
  unitTop: longint;
  pendPtr: array[1..16] of integer;
  pendName: array[1..16] of TName;
  nPend: integer;

function CatchError: integer; external 'catch';
procedure ThrowError; external 'throw';

procedure Error(const msg: string);
begin
  ErrMsg := msg;
  ErrUnit := curFile;
  ErrLine := tokLine;
  ErrCol := tokCol;
  ThrowError;
end;

{ ================================================================ scanner }
procedure NextCh;
begin
  if srcPos < srcEnd then begin
    ch := chr(Mem[curBase + srcPos]);
    srcPos := srcPos + 1;
    if ch = #10 then begin line := line + 1; col := 0; end
    else col := col + 1;
    if ch = #13 then ch := ' ';
    if ch = #9 then ch := ' ';
  end else ch := #0;
end;

procedure InitKeywords;
  procedure K(i: integer; const n: string; s: byte);
  begin kwName[i] := n; kwSym[i] := s; end;
begin
  K(1, 'and', sAnd); K(2, 'array', sArray); K(3, 'begin', sBegin); K(4, 'case', sCase);
  K(5, 'const', sConst); K(6, 'div', sDiv); K(7, 'do', sDo); K(8, 'downto', sDownto);
  K(9, 'else', sElse); K(10, 'end', sEnd); K(11, 'for', sFor); K(12, 'function', sFunction);
  K(13, 'if', sIf); K(14, 'in', sIn); K(15, 'mod', sMod); K(16, 'nil', sNil);
  K(17, 'not', sNot); K(18, 'of', sOf); K(19, 'or', sOr); K(20, 'procedure', sProcedure);
  K(21, 'program', sProgram); K(22, 'record', sRecord); K(23, 'repeat', sRepeat); K(24, 'shl', sShl);
  K(25, 'shr', sShr); K(26, 'string', sStringKw); K(27, 'then', sThen); K(28, 'to', sTo);
  K(29, 'type', sType); K(30, 'until', sUntil); K(31, 'uses', sUses); K(32, 'var', sVar);
  K(33, 'while', sWhile); K(34, 'xor', sXor); K(35, 'with', sWith); K(36, 'goto', sGoto);
  K(37, 'label', sLabel); K(38, 'packed', sPacked); K(39, 'set', sSet); K(40, 'file', sFile);
end;

procedure SkipComment(close: char);
begin
  if close = '}' then begin
    while (ch <> '}') and (ch <> #0) do NextCh;
    NextCh;
  end else begin
    repeat
      while (ch <> '*') and (ch <> #0) do NextCh;
      NextCh;
    until (ch = ')') or (ch = #0);
    NextCh;
  end;
end;

{ IEEE single bits of a real written as text }
function RealOf(const t: string): longint;
var u: TRealBits;
    code: integer;
begin
  Val(t, u.r, code);
  if code <> 0 then Error('bad real number ' + t);
  RealOf := u.l;
end;

function IntToRealBits(v: longint): longint;
var u: TRealBits;
begin
  u.r := v;
  IntToRealBits := u.l;
end;

function HexDigit(c: char): integer;
begin
  c := UpCase(c);
  if (c >= '0') and (c <= '9') then HexDigit := ord(c) - 48
  else if (c >= 'A') and (c <= 'F') then HexDigit := ord(c) - 55
  else HexDigit := -1;
end;

procedure Next;
var i, d, n: integer;
    done: boolean;
begin
  repeat
    done := true;
    while (ch = ' ') or (ch = #10) do NextCh;
    if ch = '{' then begin SkipComment('}'); done := false; end;
  until done;
  tokLine := line; tokCol := col;
  case ch of
    #0: sym := sEOF;
    'a'..'z', 'A'..'Z', '_': begin
      n := 0;
      id := '';
      while ((ch >= 'a') and (ch <= 'z')) or ((ch >= 'A') and (ch <= 'Z')) or ((ch >= '0') and (ch <= '9')) or (ch = '_') do begin
        if n < 15 then begin n := n + 1; id[n] := LoCase(ch); end;
        NextCh;
      end;
      id[0] := chr(n);
      sym := sIdent;
      for i := 1 to NKW do
        if kwName[i][1] = id[1] then
          if kwName[i] = id then begin sym := kwSym[i]; break; end;
    end;
    '0'..'9': begin
      num := 0;
      str := '';
      while (ch >= '0') and (ch <= '9') do begin
        num := num * 10 + (ord(ch) - 48); str := str + ch; NextCh;
      end;
      sym := sNumber;
      if (ch = '.') and (chr(Mem[curBase + srcPos]) <> '.') then begin
        str := str + '.'; NextCh;
        while (ch >= '0') and (ch <= '9') do begin str := str + ch; NextCh; end;
        sym := sReal;
      end;
      if (ch = 'e') or (ch = 'E') then begin
        str := str + 'E'; NextCh;
        if (ch = '+') or (ch = '-') then begin str := str + ch; NextCh; end;
        while (ch >= '0') and (ch <= '9') do begin str := str + ch; NextCh; end;
        sym := sReal;
      end;
      if sym = sReal then num := RealOf(str);
    end;
    '$': begin
      NextCh; num := 0;
      d := HexDigit(ch);
      while d >= 0 do begin num := num * 16 + d; NextCh; d := HexDigit(ch); end;
      sym := sNumber;
    end;
    '%': begin
      NextCh; num := 0;
      while (ch = '0') or (ch = '1') do begin num := num * 2 + (ord(ch) - 48); NextCh; end;
      sym := sNumber;
    end;
    '''', '#': begin
      str := '';
      while (ch = '''') or (ch = '#') do begin
        if ch = '''' then begin
          NextCh;
          repeat
            if (ch = #0) or (ch = #10) then Error('string not closed');
            if ch = '''' then begin
              NextCh;
              if ch = '''' then begin str := str + ''''; NextCh; end
              else break;
            end else begin str := str + ch; NextCh; end;
          until false;
        end else begin
          NextCh; n := 0;
          if ch = '$' then begin
            NextCh; d := HexDigit(ch);
            while d >= 0 do begin n := n * 16 + d; NextCh; d := HexDigit(ch); end;
          end else
            while (ch >= '0') and (ch <= '9') do begin n := n * 10 + (ord(ch) - 48); NextCh; end;
          str := str + chr(n);
        end;
      end;
      sym := sString;
    end;
    '+': begin sym := sPlus; NextCh; end;
    '-': begin sym := sMinus; NextCh; end;
    '*': begin sym := sTimes; NextCh; end;
    '/': begin
      NextCh;
      if ch = '/' then begin
        while (ch <> #10) and (ch <> #0) do NextCh;
        Next; exit;
      end;
      sym := sSlash;
    end;
    '=': begin sym := sEql; NextCh; end;
    '<': begin
      NextCh;
      if ch = '=' then begin sym := sLeq; NextCh; end
      else if ch = '>' then begin sym := sNeq; NextCh; end
      else sym := sLss;
    end;
    '>': begin
      NextCh;
      if ch = '=' then begin sym := sGeq; NextCh; end else sym := sGtr;
    end;
    '(': begin
      NextCh;
      if ch = '*' then begin NextCh; SkipComment(')'); Next; exit; end;
      sym := sLparen;
    end;
    ')': begin sym := sRparen; NextCh; end;
    '[': begin sym := sLbrak; NextCh; end;
    ']': begin sym := sRbrak; NextCh; end;
    ',': begin sym := sComma; NextCh; end;
    ':': begin
      NextCh;
      if ch = '=' then begin sym := sBecomes; NextCh; end else sym := sColon;
    end;
    ';': begin sym := sSemi; NextCh; end;
    '.': begin
      NextCh;
      if ch = '.' then begin sym := sDotdot; NextCh; end else sym := sPeriod;
    end;
    '^': begin sym := sCaret; NextCh; end;
    '@': begin sym := sAt; NextCh; end;
  else
    Error('unexpected character ''' + ch + '''');
  end;
end;

function SymName(s: integer): string;
begin
  case s of
    sIdent: SymName := 'identifier';
    sNumber: SymName := 'number';
    sSemi: SymName := ';';
    sColon: SymName := ':';
    sBecomes: SymName := ':=';
    sRparen: SymName := ')';
    sLparen: SymName := '(';
    sRbrak: SymName := ']';
    sPeriod: SymName := '.';
    sEql: SymName := '=';
    sComma: SymName := ',';
    sOf: SymName := 'OF';
    sDo: SymName := 'DO';
    sThen: SymName := 'THEN';
    sEnd: SymName := 'END';
    sBegin: SymName := 'BEGIN';
    sUntil: SymName := 'UNTIL';
    sTo: SymName := 'TO';
    sDotdot: SymName := '..';
  else
    SymName := 'symbol ' + IntToStr(s);
  end;
end;

procedure Expect(s: integer);
begin
  if sym <> s then Error(UpperCase(SymName(s)) + ' EXPECTED');
  Next;
end;

{ ================================================================ code }
procedure Gen(b: integer);
begin
  if rv then begin if pc > $1FFF0 then Error('program code larger than 128 KB'); end
  else if pc > $FFF0 then Error('program code larger than 64 KB');
  Mem[cBase + pc] := b;
  pc := pc + 1;
end;
procedure Gen16(w: longint);
begin Gen(w and 255); Gen((w shr 8) and 255); end;
procedure Gen24(l: longint);
begin Gen(l and 255); Gen((l shr 8) and 255); Gen((l shr 16) and 255); end;
procedure Op8(o, b: integer); begin Gen(o); Gen(b); end;
procedure Op16(o: integer; w: longint); begin Gen(o); Gen16(w); end;
procedure Op24(o: integer; l: longint); begin Gen(o); Gen24(l); end;

procedure Put16(at, w: longint);
begin
  Mem[cBase + at] := w and 255;
  Mem[cBase + at + 1] := (w shr 8) and 255;
end;
function Get16(at: longint): longint;
begin
  Get16 := longint(Mem[cBase + at]) or (longint(Mem[cBase + at + 1]) shl 8);
end;
procedure Put32(at, w: longint);
begin
  Put16(at, w and $FFFF); Put16(at + 2, (w shr 16) and $FFFF);
end;
function Get32(at: longint): longint;
begin
  Get32 := Get16(at) or (Get16(at + 2) shl 16);
end;

{ ---------------------------------------------------------------- RV32IM }
const
  rZero = 0; rRa = 1; rSp = 2; rT0 = 5; rT1 = 6; rT2 = 7; rS0 = 8; rS1 = 9;
  rA0 = 10; rA1 = 11; rA2 = 12; rA3 = 13;

procedure W32(w: longint);
begin
  Gen(w and 255); Gen((w shr 8) and 255); Gen((w shr 16) and 255); Gen((w shr 24) and 255);
end;
function IEnc(op, f3, rd, rs1: integer; imm: longint): longint;
begin
  IEnc := ((imm and $FFF) shl 20) or (longint(rs1) shl 15) or (longint(f3) shl 12) or (longint(rd) shl 7) or op;
end;
procedure RI(op, f3, rd, rs1: integer; imm: longint);
begin W32(IEnc(op, f3, rd, rs1, imm)); end;
procedure RR(f7, f3, rd, rs1, rs2: integer);
begin
  W32((longint(f7) shl 25) or (longint(rs2) shl 20) or (longint(rs1) shl 15) or (longint(f3) shl 12) or
      (longint(rd) shl 7) or $33);
end;
function LuiEnc(rd: integer; v: longint): longint;
begin
  LuiEnc := ((((v + $800) shr 12) and $FFFFF) shl 12) or (longint(rd) shl 7) or $37;
end;
function BEnc(f3, rs1, rs2: integer; off: longint): longint;
begin
  BEnc := (((off shr 12) and 1) shl 31) or (((off shr 5) and $3F) shl 25) or (longint(rs2) shl 20) or
          (longint(rs1) shl 15) or (longint(f3) shl 12) or (((off shr 1) and $F) shl 8) or
          (((off shr 11) and 1) shl 7) or $63;
end;
function JEnc(rd: integer; off: longint): longint;
begin
  JEnc := (((off shr 20) and 1) shl 31) or (((off shr 1) and $3FF) shl 21) or (((off shr 11) and 1) shl 20) or
          (((off shr 12) and $FF) shl 12) or (longint(rd) shl 7) or $6F;
end;
{ branch rs1 ? rs2 over off bytes (from this instruction): 0 beq 1 bne 4 blt 5 bge 6 bltu 7 bgeu }
procedure RB(f3, rs1, rs2: integer; off: longint);
begin W32(BEnc(f3, rs1, rs2, off)); end;
procedure RLi(rd: integer; v: longint);
begin
  if (v >= -2048) and (v <= 2047) then RI($13, 0, rd, rZero, v)
  else begin
    W32(LuiEnc(rd, v));
    if v and $FFF <> 0 then RI($13, 0, rd, rd, v and $FFF);
  end;
end;
procedure RMv(rd, rs: integer); begin RI($13, 0, rd, rs, 0); end;
{ rd := rs + v (t2 is the scratch register for large values) }
procedure RAddi(rd, rs: integer; v: longint);
begin
  if (v >= -2048) and (v <= 2047) then begin if (v <> 0) or (rd <> rs) then RI($13, 0, rd, rs, v); end
  else begin RLi(rT2, v); RR(0, 0, rd, rs, rT2); end;
end;
procedure RLd(sz: integer; sg: boolean; rd, base: integer; off: longint);
var f3: integer;
begin
  if sz = 1 then begin if sg then f3 := 0 else f3 := 4; end
  else if sz = 2 then begin if sg then f3 := 1 else f3 := 5; end
  else f3 := 2;
  if (off < -2048) or (off > 2047) then begin RLi(rT2, off); RR(0, 0, rT2, rT2, base); base := rT2; off := 0; end;
  RI($03, f3, rd, base, off);
end;
procedure RSt(sz, rs, base: integer; off: longint);
var f3: integer;
begin
  if sz = 1 then f3 := 0 else if sz = 2 then f3 := 1 else f3 := 2;
  if (off < -2048) or (off > 2047) then begin RLi(rT2, off); RR(0, 0, rT2, rT2, base); base := rT2; off := 0; end;
  W32((((off shr 5) and $7F) shl 25) or (longint(rs) shl 20) or (longint(base) shl 15) or (longint(f3) shl 12) or
      ((off and $1F) shl 7) or $23);
end;
{ absolute address: lui t0 + offset }
procedure RLdAbs(sz: integer; sg: boolean; rd: integer; a: longint);
begin W32(LuiEnc(rT0, a)); RLd(sz, sg, rd, rT0, ((a and $FFF) xor $800) - $800); end;
procedure RStAbs(sz, rs: integer; a: longint);
begin W32(LuiEnc(rT0, a)); RSt(sz, rs, rT0, ((a and $FFF) xor $800) - $800); end;
procedure RPush(r: integer); begin RI($13, 0, rSp, rSp, -4); RSt(4, r, rSp, 0); end;
procedure RPop(r: integer); begin RLd(4, false, r, rSp, 0); RI($13, 0, rSp, rSp, 4); end;
procedure RSlli(rd, rs, n: integer); begin RI($13, 1, rd, rs, n); end;
procedure RSrli(rd, rs, n: integer); begin RI($13, 5, rd, rs, n); end;
procedure RSrai(rd, rs, n: integer); begin RI($13, 5, rd, rs, n or $400); end;
procedure RCall(a: longint);
begin W32(LuiEnc(rT0, a)); RI($67, 0, rRa, rT0, a); end;
procedure RRet; begin RI($67, 0, rZero, rRa, 0); end;
{ the register holds a value of type size sz: make it a correct 32-bit value }
procedure RNormSz(r, sz: integer; sg: boolean);
begin
  if sz = 1 then begin
    if sg then begin RSlli(r, r, 24); RSrai(r, r, 24); end else RI($13, 7, r, r, 255);
  end else if sz = 2 then begin
    RSlli(r, r, 16);
    if sg then RSrai(r, r, 16) else RSrli(r, r, 16);
  end;
end;

{ BRL to a known target }
procedure BrlTo(target: longint);
begin
  if rv then begin W32(JEnc(rZero, target - pc)); exit; end;
  Gen($82);
  Gen16(target - (pc + 2));
end;
{ BRL to a later target: the operand links the chain }
procedure BrlFwd(var chain: longint);
begin
  if rv then begin W32(chain); chain := pc - 4; exit; end;
  Gen($82);
  Gen16(chain);
  chain := pc - 2;
end;
procedure FixChain(chain, target: longint);
var nxt: longint;
begin
  if rv then begin
    while chain <> 0 do begin
      nxt := Get32(chain);
      Put32(chain, JEnc(rZero, target - chain));
      chain := nxt;
    end;
    exit;
  end;
  while chain <> 0 do begin
    nxt := Get16(chain);
    Put16(chain, target - (chain + 2));
    chain := nxt;
  end;
end;
{ JSL to a procedure whose address is not known yet }
procedure FixCalls(chain, target: longint);
var nxt: longint;
begin
  if rv then begin
    while chain <> 0 do begin
      nxt := Get32(chain);
      Put32(chain, LuiEnc(rT0, target));
      Put32(chain + 4, IEnc($67, 0, rRa, rT0, target));
      chain := nxt;
    end;
    exit;
  end;
  while chain <> 0 do begin
    nxt := Get16(chain);
    Put16(chain, target and $FFFF);
    Mem[cBase + chain + 2] := (target shr 16) and 255;
    chain := nxt;
  end;
end;

procedure Jsl(a: longint); begin if rv then RCall(a) else Op24($22, a); end;
procedure LdaImm(v: longint); begin if rv then RLi(rA0, v) else Op16($A9, v and $FFFF); end;
procedure LdxImm(v: longint); begin Op16($A2, v and $FFFF); end;
procedure StaAbs(a: longint); begin Op16($8D, a); end;
procedure LdaAbs(a: longint); begin Op16($AD, a); end;
procedure Sep; begin Op8($E2, $20); end;
procedure Rep; begin Op8($C2, $20); end;
{ push the value in A (sz bytes; one 4-byte slot on SCHUB) }
procedure PushA(sz: integer);
begin
  if rv then RPush(rA0)
  else begin if sz = 4 then Gen($DA); Gen($48); end;
end;
procedure PopA; begin if rv then RPop(rA0) else Gen($68); end;
procedure DropSlot; begin if rv then RAddi(rSp, rSp, 4) else Gen($7A); end;
{ A := the k-th pushed slot (1 = the top) }
procedure LdaSlot(k: integer);
begin if rv then RLd(4, false, rA0, rSp, 4 * (k - 1)) else Op8($A3, 2 * k - 1); end;
{ keep A as a second operand (X / a3), push it later }
procedure SaveB; begin if rv then RMv(rA3, rA0) else Gen($AA); end;
procedure PushB; begin if rv then RPush(rA3) else Gen($DA); end;
{ a0 := ra c rb as 0 / 1 (SCHUB) }
procedure RSetCmp(c: integer; sg: boolean; ra, rb: integer);
var f3: integer;
begin
  if sg then f3 := 2 else f3 := 3;
  case c of
    cEq: begin RR($20, 0, rA0, ra, rb); RI($13, 3, rA0, rA0, 1); end;
    cNe: begin RR($20, 0, rA0, ra, rb); RR(0, 3, rA0, rZero, rA0); end;
    cLt: RR(0, f3, rA0, ra, rb);
    cGt: RR(0, f3, rA0, rb, ra);
    cLe: begin RR(0, f3, rA0, rb, ra); RI($13, 4, rA0, rA0, 1); end;
    cGe: begin RR(0, f3, rA0, ra, rb); RI($13, 4, rA0, rA0, 1); end;
  end;
end;
{ push a constant 16-bit argument }
procedure PeaW(v: longint);
begin
  if rv then begin RLi(rT1, v); RPush(rT1); end else Op16($F4, v);
end;
{ frame offsets of locals and parameters (65C816: direct page; SCHUB: from s0) }
function LocDp(adr: longint): longint;
begin if rv then LocDp := adr else LocDp := 1 + adr; end;
function ParDp(lev: integer; adr: longint): longint;
begin if rv then ParDp := ctxFS[lev] + 8 + adr else ParDp := ctxFS[lev] + 6 + adr; end;
procedure PopBytes(n: integer);
var i: integer;
begin
  if n <= 0 then exit;
  if rv then begin RAddi(rSp, rSp, n); exit; end;
  if n <= 8 then begin for i := 1 to n div 2 do Gen($7A); end   { ply }
  else begin
    Gen($A8); Gen($3B); Gen($18); Op16($69, n); Gen($1B); Gen($98); { tay tsc clc adc tcs tya }
  end;
end;

{ ================================================================ tables }
function NewType(form: byte; size: word): integer;
begin
  if nType >= MaxType then Error('too many types');
  nType := nType + 1;
  types[nType].form := form;
  types[nType].size := size;
  types[nType].sgn := false;
  types[nType].lo := 0;
  types[nType].hi := 0;
  types[nType].base := 0;
  types[nType].fields := 0;
  types[nType].al := 1;
  NewType := nType;
end;

function NewSym(const n: TName; kind: byte; typ: integer): integer;
begin
  if nSym >= MaxSym then Error('too many identifiers');
  nSym := nSym + 1;
  with syms[nSym] do begin
    name := n; next := 0; first := 0; npar := 0; parsz := 0; flags := 0;
    isRef := false; isPar := false; adr := 0; hid := 0; lev := curLev;
  end;
  syms[nSym].kind := kind;
  syms[nSym].typ := typ;
  NewSym := nSym;
end;

function PtrSz: integer; begin if rv then PtrSz := 4 else PtrSz := 2; end;

{ alignment of a type (SCHUB: natural alignment, as the PC compiler lays it out) }
function AlignOf(t: integer): integer;
begin
  AlignOf := 1;
  if not rv then exit;
  case types[t].form of
    fInt, fEnum: AlignOf := types[t].size;
    fReal, fPtr, fNil: AlignOf := 4;
    fRec: AlignOf := types[t].al;
    fArr: AlignOf := AlignOf(types[t].base);
  end;
end;

procedure InitTypes;
  procedure IT(form: byte; size: word; sgn: boolean; lo, hi: longint);
  var t: integer;
  begin
    t := NewType(form, size);
    types[t].sgn := sgn; types[t].lo := lo; types[t].hi := hi;
  end;
begin
  nType := 0;
  IT(fInt, 2, true, -32768, 32767);       { 1 integer }
  IT(fInt, 2, false, 0, 65535);           { 2 word }
  IT(fInt, 1, false, 0, 255);             { 3 byte }
  IT(fInt, 1, true, -128, 127);           { 4 shortint }
  IT(fInt, 4, true, -2147483647, 2147483647); { 5 longint }
  IT(fInt, 4, false, 0, 2147483647);      { 6 longword }
  IT(fChar, 1, false, 0, 255);            { 7 char }
  IT(fBool, 1, false, 0, 1);              { 8 boolean }
  IT(fStr, 256, false, 0, 255);           { 9 string }
  IT(fPtr, PtrSz, false, 0, 0);           { 10 pointer }
  IT(fNil, PtrSz, false, 0, 0);           { 11 nil }
  IT(fUntyped, 0, false, 0, 0);           { 12 untyped }
  IT(fReal, 4, true, 0, 0);               { 13 real }
  IT(fSet, 32, false, 0, 255);            { 14 set of byte }
  types[tSet].base := tByte;
end;

procedure InitStdSyms;
  procedure T(const n: TName; t: integer); var s: integer; begin s := NewSym(n, skType, t); end;
  procedure C(const n: TName; t: integer; v: longint); var s: integer; begin s := NewSym(n, skConst, t); syms[s].adr := v; end;
begin
  nSym := 0;
  T('integer', tInteger); T('word', tWord); T('byte', tByte); T('shortint', tShort);
  T('longint', tLong); T('longword', tLongW); T('cardinal', tLongW); T('char', tChar);
  T('boolean', tBool); T('pointer', tPointer); T('smallint', tInteger); T('ptruint', tWord);
  C('true', tBool, 1); C('false', tBool, 0); C('maxint', tInteger, 32767);
  C('maxlongint', tLong, 2147483647);
  T('real', tReal); T('single', tReal);
  C('pi', tReal, RealOf('3.14159265'));
end;

{ ---- export table in the cartridge ---- }
function CartPresent: boolean;
begin
  CartPresent := (Mem[$400020] = ord('M')) and (Mem[$400021] = ord('P')) and
                 (Mem[$400022] = ord('A')) and (Mem[$400023] = ord('S'));
end;

function Far24(a: longint): longint;
begin
  Far24 := longint(Mem[a]) or (longint(Mem[a + 1]) shl 8) or (longint(Mem[a + 2]) shl 16);
end;

function ExpName(i: integer): TName;
var a: longint;
    n, k: integer;
    s: TName;
begin
  a := ExpBase + longint(i) * 40;
  n := Mem[a];
  if n > 15 then n := 15;
  for k := 1 to n do s[k] := chr(Mem[a + k]);
  s[0] := chr(n);
  ExpName := s;
end;

{ binary search; -1 when the name is not exported }
function ExpFind(const n: TName): integer;
var lo, hi, mid: integer;
    s: TName;
begin
  lo := 0; hi := ExpCount - 1;
  ExpFind := -1;
  while lo <= hi do begin
    mid := (lo + hi) div 2;
    s := ExpName(mid);
    if s = n then begin ExpFind := mid; exit; end;
    if s < n then lo := mid + 1 else hi := mid - 1;
  end;
end;

function ExpValue(i: integer): longint;
var a: longint;
begin
  a := ExpBase + longint(i) * 40 + 22;
  ExpValue := longint(Mem[a]) or (longint(Mem[a + 1]) shl 8) or (longint(Mem[a + 2]) shl 16) or (longint(Mem[a + 3]) shl 24);
end;

function RtAdr(const n: TName): longint;
var i: integer;
begin
  i := ExpFind(n);
  if i < 0 then Error('cartridge runtime incomplete: ' + n);
  RtAdr := ExpValue(i);
end;

function TypeOf(code, ref: integer): integer; forward;

function ImportStruct(ref: integer): integer;
var a, f: longint;
    t, k, nf, n, s, prev: integer;
    nm: TName;
begin
  if (ref < 64) and (impType[ref] <> 0) then begin ImportStruct := impType[ref]; exit; end;
  a := TypBase + (longint(Mem[TypBase + ref * 2]) or (longint(Mem[TypBase + ref * 2 + 1]) shl 8));
  if Mem[a] = 1 then begin
    t := NewType(fArr, Mem[a + 1] or (Mem[a + 2] shl 8));
    types[t].lo := integer(Mem[a + 3] or (Mem[a + 4] shl 8));
    types[t].hi := integer(Mem[a + 5] or (Mem[a + 6] shl 8));
    types[t].base := TypeOf(Mem[a + 7], Mem[a + 8]);
  end else begin
    t := NewType(fRec, Mem[a + 1] or (Mem[a + 2] shl 8));
    nf := Mem[a + 3];
    f := a + 4;
    prev := 0;
    for k := 1 to nf do begin
      n := Mem[f];
      for s := 1 to n do nm[s] := chr(Mem[f + s]);
      nm[0] := chr(n);
      s := NewSym(nm, skField, TypeOf(Mem[f + 18], Mem[f + 19]));
      syms[s].adr := Mem[f + 16] or (Mem[f + 17] shl 8);
      syms[s].lev := 0;
      if prev = 0 then types[t].fields := s else syms[prev].next := s;
      prev := s;
      if AlignOf(syms[s].typ) > types[t].al then types[t].al := AlignOf(syms[s].typ);
      f := f + 20;
    end;
  end;
  if ref < 64 then impType[ref] := t;
  ImportStruct := t;
end;

function TypeOf(code, ref: integer): integer;
var t: integer;
begin
  case code of
    1: TypeOf := tInteger;
    2: TypeOf := tWord;
    3: TypeOf := tByte;
    4: TypeOf := tShort;
    5: TypeOf := tLong;
    6: TypeOf := tLongW;
    7: TypeOf := tChar;
    8: TypeOf := tBool;
    9: TypeOf := tString;
    10: TypeOf := tPointer;
    11: TypeOf := tUntyped;
    12: TypeOf := tReal;
    15: TypeOf := tSet;
    13: TypeOf := ImportStruct(ref);
    14: begin
      t := NewType(fStr, ref + 1);
      types[t].hi := ref;
      TypeOf := t;
    end;
  else
    TypeOf := tInteger;
  end;
end;

procedure CalcLibParsz(s: integer); forward;

{ make a library symbol visible: copy it from the export table }
function Import(i: integer): integer;
var a, pa: longint;
    s, p, k, prev, mode, kind: integer;
begin
  a := ExpBase + longint(i) * 40;
  kind := Mem[a + 20];
  s := NewSym(ExpName(i), skConst, TypeOf(Mem[a + 21], Mem[a + 26] or (Mem[a + 27] shl 8)));
  syms[s].adr := ExpValue(i);
  syms[s].lev := 0;
  case kind of
    1: syms[s].kind := skConst;
    2: syms[s].kind := skVar;
    5: syms[s].kind := skType;
    6: syms[s].kind := skAsm;
    3, 4: begin
      syms[s].kind := skProc;
      if kind = 3 then syms[s].typ := 0;
      syms[s].flags := 4 or 2 or (Mem[a + 29] and 1);
      syms[s].npar := Mem[a + 28];
      pa := ParBase + longint(Mem[a + 30] or (Mem[a + 31] shl 8)) * 3;
      prev := 0;
      for k := 1 to syms[s].npar do begin
        mode := Mem[pa];
        p := NewSym('', skPar, TypeOf(Mem[pa + 1], Mem[pa + 2]));
        syms[p].isRef := (mode = 1) or (types[syms[p].typ].form in [fStr, fArr, fRec, fSet, fUntyped]);
        syms[p].lev := 0;
        if mode = 1 then syms[p].flags := 1;   { var }
        if prev = 0 then syms[s].first := p else syms[prev].next := p;
        prev := p;
        pa := pa + 3;
      end;
      CalcLibParsz(s);
    end;
  end;
  syms[s].flags := syms[s].flags or 128;   { from the library (never hidden) }
  Import := s;
end;

function Find(const n: TName): integer;
var i: integer;
begin
  for i := nSym downto 1 do
    if (syms[i].kind <> skField) and (syms[i].kind <> skPar) then
      if syms[i].name = n then begin Find := i; exit; end;
  i := ExpFind(n);
  if i >= 0 then Find := Import(i) else Find := 0;
end;

function FindLocal(const n: TName; from: integer): boolean;
var i: integer;
begin
  FindLocal := false;
  for i := nSym downto from do
    if (syms[i].kind <> skField) and (syms[i].kind <> skPar) and (syms[i].name = n) then FindLocal := true;
end;

procedure InitRuntime;
var a: longint;
begin
  if rv then begin
    ExpBase := Far24($40004A);
    ExpCount := Mem[$40004D] or (Mem[$40004E] shl 8);
    ParBase := Far24($40004F);
    TypBase := Far24($400052);
    aRtError := RtAdr('rt_error'); aMemmove := RtAdr('rt_memmove');
    exit;
  end;
  ExpBase := Far24($400025);
  ExpCount := Mem[$400028] or (Mem[$400029] shl 8);
  ParBase := Far24($40002A);
  TypBase := Far24($40002D);
  UserData := Mem[$400030] or (Mem[$400031] shl 8);
  aMul16 := RtAdr('rt_mul16'); aDiv16s := RtAdr('rt_div16s'); aDiv16u := RtAdr('rt_div16u');
  aMod16s := RtAdr('rt_mod16s'); aMod16u := RtAdr('rt_mod16u'); aShl16 := RtAdr('rt_shl16');
  aShr16 := RtAdr('rt_shr16'); aMul32 := RtAdr('rt_mul32'); aDiv32s := RtAdr('rt_div32s');
  aMod32s := RtAdr('rt_mod32s'); aShl32 := RtAdr('rt_shl32'); aShr32 := RtAdr('rt_shr32');
  aCmp32s := RtAdr('rt_cmp32s'); aLdf8 := RtAdr('rt_ldf8'); aLdf16 := RtAdr('rt_ldf16');
  aLdf32 := RtAdr('rt_ldf32'); aStf8 := RtAdr('rt_stf8'); aStf16 := RtAdr('rt_stf16');
  aStf32 := RtAdr('rt_stf32'); aExit := RtAdr('rt_exit'); aLibinit := RtAdr('rt_libinit');
  aT0 := RtAdr('rt_t0'); aA := RtAdr('rt_a'); aB := RtAdr('rt_b'); aFp := RtAdr('rt_fp');
  aV := RtAdr('rt_v'); aStp := RtAdr('rt_stp'); aHeapbase := RtAdr('rt_heapbase');
  aSavesp := RtAdr('rt_savesp');
  aSpare := RtAdr('rt_spare');
end;

function LibProc(const n: TName): integer;
var s: integer;
begin
  s := Find(n);
  if (s = 0) or (syms[s].kind <> skProc) then Error('library routine missing: ' + n);
  LibProc := s;
end;

{ ---- block moves with KRAN ---- }
procedure CopyMem(src, dst, n: longint);
var k: longint;
begin
  k := n div 4096;
  if k > 0 then BlitCopy(src, dst, 4096, k, 4096, 4096);
  k := k * 4096;
  if n > k then BlitCopy(src + k, dst + k, n - k, 1, 0, 0);
end;
procedure ZeroMem(dst, n: longint);
var k: longint;
begin
  k := n div 4096;
  if k > 0 then BlitFill(dst, 4096, k, 4096, 0);
  k := k * 4096;
  if n > k then BlitFill(dst + k, n - k, 1, 0, 0);
end;

{ ---- data in bank 0 ---- }
function AllocData(size: longint): longint;
var i: longint;
begin
  if rv then begin
    if size >= 2 then dataTop := (dataTop + 3) and not longint(3);
    if dataTop + size > $50000 then Error('too many global variables');
  end else if UserData + dataTop + size > $9000 then Error('too many global variables');
  AllocData := dataOrg + dataTop;
  if size > 16 then ZeroMem(DataImg + dataTop, size)
  else for i := 0 to size - 1 do Mem[DataImg + dataTop + i] := 0;
  dataTop := dataTop + size;
end;

function StrLiteral(const s: string): longint;
var a: longint;
    i: integer;
begin
  a := AllocData(length(s) + 1);
  Mem[DataImg + a - dataOrg] := length(s);
  for i := 1 to length(s) do Mem[DataImg + a - dataOrg + i] := ord(s[i]);
  StrLiteral := a;
end;

function WithSz: integer; begin if rv then WithSz := 16 else WithSz := 8; end;

function AllocLocal(size: integer): integer;
begin
  if ctxFrozen[curLev] then Error('declare variables before nested procedures');
  if rv then ctxLoc[curLev] := (ctxLoc[curLev] + 3) and $FFFC;
  AllocLocal := ctxLoc[curLev];
  ctxLoc[curLev] := ctxLoc[curLev] + size;
end;

{ a local variable: small ones now, large ones once all are declared }
procedure LocalVar(s: integer);
begin
  if types[syms[s].typ].size <= 8 then syms[s].adr := AllocLocal(types[syms[s].typ].size)
  else begin
    if ctxFrozen[curLev] then Error('declare variables before nested procedures');
    if defN[curLev] >= 24 then Error('too many large local variables');
    defN[curLev] := defN[curLev] + 1;
    defSym[curLev, defN[curLev]] := s;
  end;
end;

procedure PlaceLocals;
var i: integer;
begin
  if defPlaced[curLev] then exit;
  for i := 1 to defN[curLev] do
    syms[defSym[curLev, i]].adr := AllocLocal(types[syms[defSym[curLev, i]].typ].size);
  defPlaced[curLev] := true;
  ctxFrozen[curLev] := true;
  if rv then ctxLoc[curLev] := (ctxLoc[curLev] + 3) and $FFFC;
  ctxFS[curLev] := ctxLoc[curLev];
end;

{ ================================================================ items }
function IsInt(t: integer): boolean; begin IsInt := types[t].form = fInt; end;
function IsLong(t: integer): boolean; begin IsLong := (types[t].form = fInt) and (types[t].size = 4); end;
function IsOrd(t: integer): boolean; begin IsOrd := types[t].form in [fInt, fChar, fBool, fEnum]; end;
function IsStrish(t: integer): boolean; begin IsStrish := types[t].form in [fStr, fChar]; end;
function IsStruct(t: integer): boolean; begin IsStruct := types[t].form in [fStr, fArr, fRec, fSet]; end;
function IsReal(t: integer): boolean; begin IsReal := types[t].form = fReal; end;
function IsNum(t: integer): boolean; begin IsNum := types[t].form in [fInt, fReal]; end;

procedure MakeConst(var x: TItem; v: longint; t: integer);
begin x.mode := mConst; x.a := v; x.typ := t; x.tmp := false; x.tj := 0; x.fj := 0; end;

function IntTypeFor(v: longint): integer;
begin
  if (v >= -32768) and (v <= 32767) then IntTypeFor := tInteger
  else if (v >= 0) and (v <= 65535) then IntTypeFor := tWord
  else IntTypeFor := tLong;
end;

{ lda from the frame, also beyond the 256-byte direct page }
procedure LdaDp(dp: longint);
begin
  if rv then begin RLd(4, false, rA0, rS0, dp); exit; end;
  if dp <= 254 then Op8($A5, dp)
  else begin Gen($7B); Gen($AA); Op16($BD, dp); end;    { tdc / tax / lda dp,x }
end;

procedure SignExt8;   { A: byte -> signed 16 bit }
begin Op16($29, $FF); Op16($49, $80); Gen($38); Op16($E9, $80); end;

{ A = frame pointer of level lev (lev < curLev) }
procedure FrameOf(lev: integer);
var l: integer;
begin
  if rv then begin
    RLd(4, false, rA0, rS0, ctxFS[curLev] + 8);
    l := curLev - 1;
    while l > lev do begin RLd(4, false, rA0, rA0, ctxFS[l] + 8); l := l - 1; end;
    exit;
  end;
  LdaDp(ctxFS[curLev] + 6);                   { lda static link }
  l := curLev - 1;
  while l > lev do begin
    Gen($AA);                                  { tax }
    Op16($BD, ctxFS[l] + 6);                   { lda FS+6,x : its static link }
    l := l - 1;
  end;
end;

{ address of the item in A (16 bit, bank 0) }
procedure LoadAdr(var x: TItem);
begin
  if rv then begin
    case x.mode of
      mGlob, mFarC: RLi(rA0, x.a);
      mLoc: RAddi(rA0, rS0, x.a);
      mInd: RAddi(rA0, rA0, x.a);
      mStk: begin RPop(rA0); RAddi(rA0, rA0, x.a); end;
      mReg: ;
    else
      Error('variable expected');
    end;
    x.mode := mReg; x.a := 0;
    exit;
  end;
  case x.mode of
    mGlob: LdaImm(x.a);
    mLoc: begin Gen($7B); Gen($18); Op16($69, x.a); end;      { tdc clc adc }
    mInd: if x.a <> 0 then begin Gen($18); Op16($69, x.a); end;
    mReg: ;
  else
    Error('variable expected');
  end;
  x.mode := mReg;
  x.a := 0;
end;

{ value of a scalar item into A (A/X for 32 bit) }
procedure Load(var x: TItem);
var sz: integer;
    sg: boolean;
    f: longint;
begin
  sz := types[x.typ].size;
  if IsStruct(x.typ) then begin LoadAdr(x); exit; end;
  sg := types[x.typ].sgn;
  if rv then begin
    case x.mode of
      mConst: RLi(rA0, x.a);
      mGlob: RLdAbs(sz, sg, rA0, x.a);
      mLoc: RLd(sz, sg, rA0, rS0, x.a);
      mInd: RLd(sz, sg, rA0, rA0, x.a);
      mStk: begin RPop(rA0); RLd(sz, sg, rA0, rA0, x.a); end;
      mFarC: begin RLi(rT0, x.a or longint($80000000)); RLd(sz, sg, rA0, rT0, 0); end;
      mFar: begin RLi(rT0, longint($80000000)); RR(0, 6, rA0, rA0, rT0); RLd(sz, sg, rA0, rA0, x.a); end;
      mReg: ;
      mCond: begin
        { true -> 1 (the jump chains are handled by LoadBool) }
        if x.a = cEq then RI($13, 3, rA0, rA0, 1) else RR(0, 3, rA0, rZero, rA0);
        x.typ := tBool;
      end;
    else
      Error('value expected');
    end;
    x.mode := mReg;
    exit;
  end;
  case x.mode of
    mConst: begin
      LdaImm(x.a);
      if sz = 4 then LdxImm(x.a shr 16);
    end;
    mGlob: begin
      if sz = 4 then Op16($AE, x.a + 2);       { ldx abs+2 }
      LdaAbs(x.a);
    end;
    mLoc: begin
      if sz = 4 then Op8($A6, x.a + 2);        { ldx dp+2 }
      Op8($A5, x.a);
    end;
    mInd: begin
      Gen($AA);                                 { tax }
      if sz = 4 then begin
        Op16($BD, x.a + 2); Gen($A8);           { lda off+2,x / tay }
        Op16($BD, x.a); Gen($BB);               { lda off,x / tyx }
      end else Op16($BD, x.a);
    end;
    mFar, mFarC: begin
      if x.mode = mFarC then begin
        f := x.a;
        if sz = 1 then begin Sep; Op24($AF, f); Rep; end
        else if sz = 2 then Op24($AF, f)
        else begin Op24($AF, f + 2); Gen($AA); Op24($AF, f); end;
      end else begin
        StaAbs(aFp); Op16($8E, aFp + 2);        { sta rt_fp / stx rt_fp+2 }
        Op16($A0, x.a);                          { ldy #off }
        if sz = 1 then Jsl(aLdf8) else if sz = 2 then Jsl(aLdf16) else Jsl(aLdf32);
      end;
    end;
    mReg: ;
    mCond: begin
      { materialise: true -> 1 }
      x.mode := mReg;
      x.typ := tBool;
      exit;
    end;
  else
    Error('value expected');
  end;
  if (sz = 1) and (x.mode <> mConst) and (x.mode <> mReg) then begin
    if sg then SignExt8 else Op16($29, $FF);
  end;
  x.mode := mReg;
end;

{ branches taken when condition c holds, jumping skip bytes over the code that follows }
procedure CondTrue(c, skip: integer);
var b: integer;
begin
  if rv then begin
    if skip <> 3 then Error('internal: condition skip');
    if c = cEq then RB(0, rA0, rZero, 8) else if c = cNe then RB(1, rA0, rZero, 8)
    else Error('internal: condition code');
    exit;
  end;
  if c > 10 then begin
    case c - 10 of
      cEq: Op8($F0, skip);
      cNe: Op8($D0, skip);
      cLt: Op8($30, skip);
      cGe: Op8($10, skip);
      cGt: begin Op8($F0, 2); Op8($10, skip); end;
      cLe: begin Op8($30, skip + 2); Op8($F0, skip); end;
    end;
  end else
    case c of
      cEq: Op8($F0, skip);
      cNe: Op8($D0, skip);
      cLt: Op8($90, skip);
      cGe: Op8($B0, skip);
      cGt: begin Op8($F0, 2); Op8($B0, skip); end;
      cLe: begin Op8($90, skip + 2); Op8($F0, skip); end;
    end;
end;

function Inverse(c: integer): integer;
var b, r: integer;
begin
  b := 0;
  if c > 10 then begin b := 10; c := c - 10; end;
  case c of
    cEq: r := cNe; cNe: r := cEq; cLt: r := cGe; cGe: r := cLt; cGt: r := cLe; cLe: r := cGt;
  end;
  Inverse := r + b;
end;

{ link chain b behind chain a }
function MergeChain(a, b: longint): longint;
var p: longint;
begin
  if a = 0 then begin MergeChain := b; exit; end;
  if b <> 0 then begin
    p := a;
    if rv then begin
      while Get32(p) <> 0 do p := Get32(p);
      Put32(p, b);
    end else begin
      while Get16(p) <> 0 do p := Get16(p);
      Put16(p, b);
    end;
  end;
  MergeChain := a;
end;

procedure LoadBool(var x: TItem);
var e: longint;
begin
  if rv and (x.mode = mCond) then begin
    if x.a = cEq then RI($13, 3, rA0, rA0, 1) else RR(0, 3, rA0, rZero, rA0);
    if (x.tj <> 0) or (x.fj <> 0) then begin
      e := 0; BrlFwd(e);
      FixChain(x.fj, pc); RLi(rA0, 0); BrlFwd(e);
      FixChain(x.tj, pc); RLi(rA0, 1);
      FixChain(e, pc);
    end;
    x.mode := mReg; x.tj := 0; x.fj := 0; x.typ := tBool;
    exit;
  end;
  if x.mode = mCond then begin
    CondTrue(x.a, 5);
    FixChain(x.fj, pc);
    LdaImm(0); Op8($80, 3);
    FixChain(x.tj, pc);
    LdaImm(1);
    x.mode := mReg; x.tj := 0; x.fj := 0;
  end else Load(x);
end;

{ release the n youngest string temporaries }
procedure ReleaseN(n: integer; keepFlags, keepA: boolean);
begin
  if n <= 0 then exit;
  if rv then begin RAddi(rS1, rS1, n * 256); nTmp := nTmp - n; exit; end;
  if keepFlags then Gen($08);       { php }
  if keepA then Gen($A8);           { tay }
  LdaAbs(aStp); Gen($18); Op16($69, n * 256); StaAbs(aStp);
  if keepA then Gen($98);
  if keepFlags then Gen($28);       { plp }
  nTmp := nTmp - n;
end;

procedure ReleaseTmp(keepFlags, keepA: boolean);
begin
  ReleaseN(nTmp, keepFlags, keepA);
end;

{ make x a condition; temporaries allocated since n0 are released first,
  so that every path that jumps away leaves the temporary stack balanced }
procedure ToCond(var x: TItem; n0: integer);
begin
  if x.typ <> tBool then Error('boolean expected');
  if x.mode <> mCond then begin
    Load(x);
    ReleaseN(nTmp - n0, false, true);
    if not rv then Op16($C9, 0);
    x.mode := mCond; x.a := cNe; x.tj := 0; x.fj := 0;
  end else ReleaseN(nTmp - n0, true, false);
end;

{ jump if false: adds to the forward chain }
procedure JumpFalse(var x: TItem; var chain: longint);
begin
  if x.typ <> tBool then Error('boolean expression expected');
  if x.mode = mConst then begin
    ReleaseTmp(false, false);
    if x.a = 0 then BrlFwd(chain);
    exit;
  end;
  ToCond(x, 0);
  CondTrue(x.a, 3);
  BrlFwd(chain);
  chain := MergeChain(chain, x.fj);
  FixChain(x.tj, pc);
end;

procedure JumpFalseTo(var x: TItem; target: longint);
begin
  if x.typ <> tBool then Error('boolean expression expected');
  if x.mode = mConst then begin
    ReleaseTmp(false, false);
    if x.a = 0 then BrlTo(target);
    exit;
  end;
  ToCond(x, 0);
  CondTrue(x.a, 3);
  BrlTo(target);
  FixChain(x.fj, target);
  FixChain(x.tj, pc);
end;

{ a 256-byte temporary for strings and sets: address in A }
procedure AllocTmp;
begin
  if rv then begin RAddi(rS1, rS1, -256); RMv(rA0, rS1); nTmp := nTmp + 1; exit; end;
  LdaAbs(aStp); Gen($38); Op16($E9, 256); StaAbs(aStp);
  nTmp := nTmp + 1;
end;

procedure LibCall(const n: TName);
begin
  Jsl(syms[LibProc(n)].adr);
end;

{ call a library routine and drop its arguments }
procedure LibCallPop(const n: TName);
var s: integer;
begin
  s := LibProc(n);
  Jsl(syms[s].adr);
  PopBytes(syms[s].parsz);
end;

{ address of a string value in A; chars become one-character strings }
procedure StrAdr(var x: TItem);
begin
  if rv and (types[x.typ].form = fChar) then begin
    Load(x);
    RMv(rA3, rA0);
    AllocTmp;
    RLi(rT1, 1); RSt(1, rT1, rA0, 0); RSt(1, rA3, rA0, 1);
    x.mode := mReg; x.typ := tString; x.tmp := true;
    exit;
  end;
  if types[x.typ].form = fChar then begin
    Load(x);
    Gen($A8);                 { tay }
    AllocTmp;
    Gen($AA);                 { tax }
    Gen($98);                 { tya }
    Sep; Op16($9D, 1); Op8($A9, 1); Gen($9D); Gen16(0); Rep;  { sta 1,x / lda #1 (8 bit) / sta 0,x }
    Gen($8A);                 { txa }
    x.mode := mReg; x.typ := tString; x.tmp := true;
    exit;
  end;
  if types[x.typ].form <> fStr then Error('string expected');
  LoadAdr(x);
end;

{ ================================================================ conversion }
{ A (16 bit, type t) -> A/X 32 bit }
procedure Extend(t: integer);
begin
  if rv or (types[t].size = 4) then exit;
  if types[t].sgn then begin
    LdxImm(0); Op16($C9, $8000); Op8($90, 1); Gen($CA);   { ldx #0 / cmp #$8000 / bcc +1 / dex }
  end else LdxImm(0);
end;

{ a number as a real in A/X }
procedure LoadReal(var x: TItem);
begin
  if IsReal(x.typ) then begin Load(x); exit; end;
  if not IsInt(x.typ) then Error('number expected');
  if x.mode = mConst then begin
    x.a := IntToRealBits(x.a); x.typ := tReal; Load(x); exit;
  end;
  Load(x); Extend(x.typ); PushA(4);
  LibCallPop('_inttoreal');
  x.mode := mReg; x.typ := tReal;
end;

{ load x converted for storing into type t }
procedure LoadAs(var x: TItem; t: integer);
var tf, xf: integer;
begin
  tf := types[t].form;
  xf := types[x.typ].form;
  if tf = fReal then begin
    LoadReal(x); exit;
  end;
  if tf = fInt then begin
    if xf <> fInt then Error('integer expected');
    if (types[t].size = 4) and (types[x.typ].size < 4) then begin
      if x.mode = mConst then begin
        if rv then RLi(rA0, x.a) else begin LdaImm(x.a); LdxImm(x.a shr 16); end;
        x.mode := mReg; exit;
      end;
      Load(x); Extend(x.typ); exit;
    end;
    Load(x); exit;
  end;
  if tf = fBool then begin
    if xf <> fBool then Error('boolean expected');
    LoadBool(x); exit;
  end;
  if tf = fChar then begin
    if xf <> fChar then Error('char expected');
    Load(x); exit;
  end;
  if tf = fEnum then begin
    if x.typ <> t then if not ((xf = fEnum) and (types[x.typ].base = t)) then Error('incompatible types');
    Load(x); exit;
  end;
  if tf = fPtr then begin
    if not (xf in [fPtr, fNil]) then Error('pointer expected');
    Load(x); exit;
  end;
  Error('incompatible types');
end;

{ store A (/X) into x }
procedure Store(var x: TItem);
var sz: integer;
begin
  sz := types[x.typ].size;
  if rv then begin
    case x.mode of
      mGlob: RStAbs(sz, rA0, x.a);
      mLoc: RSt(sz, rA0, rS0, x.a);
      mStk: begin RPop(rT1); RSt(sz, rA0, rT1, x.a); end;
      mFarC: begin RLi(rT1, x.a or longint($80000000)); RSt(sz, rA0, rT1, 0); end;
      mFarStk: begin
        RPop(rT1); RLi(rT0, longint($80000000)); RR(0, 6, rT1, rT1, rT0); RSt(sz, rA0, rT1, x.a);
      end;
    else
      Error('cannot assign to this');
    end;
    exit;
  end;
  case x.mode of
    mGlob: begin
      if sz = 1 then begin Sep; StaAbs(x.a); Rep; end
      else begin StaAbs(x.a); if sz = 4 then Op16($8E, x.a + 2); end;
    end;
    mLoc: begin
      if sz = 1 then begin Sep; Op8($85, x.a); Rep; end
      else begin Op8($85, x.a); if sz = 4 then Op8($86, x.a + 2); end;
    end;
    mStk: begin
      if sz = 4 then begin
        StaAbs(aT0); Gen($8A); Gen($FA); Op16($9D, x.a + 2); LdaAbs(aT0); Op16($9D, x.a);
      end else begin
        Gen($FA);                                { plx }
        if sz = 1 then begin Sep; Op16($9D, x.a); Rep; end else Op16($9D, x.a);
      end;
    end;
    mFarC: begin
      if sz = 1 then begin Sep; Op24($8F, x.a); Rep; end
      else if sz = 2 then Op24($8F, x.a)
      else begin Op24($8F, x.a); Gen($8A); Op24($8F, x.a + 2); end;
    end;
    mFarStk: begin
      StaAbs(aV); if sz = 4 then Op16($8E, aV + 2);
      Gen($68); StaAbs(aFp); Gen($68); StaAbs(aFp + 2);
      Op16($A0, x.a);
      if sz = 1 then Jsl(aStf8) else if sz = 2 then Jsl(aStf16) else Jsl(aStf32);
    end;
  else
    Error('cannot assign to this');
  end;
end;

{ before the value of an assignment is computed: park a computed address }
procedure PrepStore(var x: TItem);
begin
  if rv then begin
    if x.mode = mInd then begin RPush(rA0); x.mode := mStk; end
    else if x.mode = mFar then begin RPush(rA0); x.mode := mFarStk; end
    else if not (x.mode in [mGlob, mLoc, mFarC]) then Error('variable expected');
    exit;
  end;
  if x.mode = mInd then begin Gen($48); x.mode := mStk; end
  else if x.mode = mFar then begin Gen($DA); Gen($48); x.mode := mFarStk; end
  else if not (x.mode in [mGlob, mLoc, mFarC]) then Error('variable expected');
end;

{ ================================================================ expressions }
procedure Expression(var x: TItem); forward;
procedure Designator(var x: TItem; s: integer); forward;
procedure CallProc(s: integer; var x: TItem); forward;

function ConstExpr: longint;
var x: TItem;
begin
  Expression(x);
  if x.mode <> mConst then Error('constant expected');
  ConstExpr := x.a;
end;

procedure ParseTypeIdent(var t: integer);
var s: integer;
begin
  if sym = sStringKw then begin Next; t := tString; exit; end;
  if sym <> sIdent then Error('type expected');
  s := Find(id);
  if (s = 0) or (syms[s].kind <> skType) then Error('type expected: ' + id);
  t := syms[s].typ;
  Next;
end;

{ x := typecast(x) to t }
procedure Cast(var x: TItem; t: integer);
begin
  if IsStruct(t) or IsStruct(x.typ) then begin
    if types[t].size <> types[x.typ].size then Error('invalid type cast');
    x.typ := t; exit;
  end;
  if x.mode = mConst then begin
    if types[t].size = 1 then x.a := x.a and 255
    else if types[t].size = 2 then begin
      x.a := x.a and $FFFF;
      if types[t].sgn and (x.a > 32767) then x.a := x.a - 65536;
    end;
    x.typ := t; exit;
  end;
  if x.mode = mCond then LoadBool(x);
  if rv then begin
    if (types[t].size <> types[x.typ].size) or (types[t].sgn <> types[x.typ].sgn) or (x.mode = mReg) then begin
      Load(x); RNormSz(rA0, types[t].size, types[t].sgn);
    end;
    x.typ := t; exit;
  end;
  if (types[t].size = 4) and (types[x.typ].size < 4) then begin Load(x); Extend(x.typ); x.typ := t; exit; end;
  if (types[t].size < 4) and (types[x.typ].size = 4) then begin Load(x); end;
  if (x.mode = mReg) or (types[t].size <> types[x.typ].size) then begin
    Load(x);
    if types[t].size = 1 then begin
      if types[t].sgn then SignExt8 else Op16($29, $FF);
    end;
  end;
  x.typ := t;
end;

procedure Selector(var x: TItem);
var y: TItem;
    t, f, esz, k: integer;
    s: TName;
begin
  repeat
    if sym = sPeriod then begin
      Next;
      if types[x.typ].form <> fRec then Error('record expected');
      if sym <> sIdent then Error('field expected');
      f := types[x.typ].fields;
      while (f <> 0) and (syms[f].name <> id) do f := syms[f].next;
      if f = 0 then Error('unknown field ' + id);
      Next;
      if x.mode in [mGlob, mLoc, mInd, mFarC] then x.a := x.a + syms[f].adr
      else Error('field of this not supported');
      x.typ := syms[f].typ;
      if not rv and (x.mode = mLoc) and (x.a + types[x.typ].size > 255) then begin LoadAdr(x); x.mode := mInd; x.a := 0; end;
    end else if sym = sLbrak then begin
      Next;
      repeat
        t := x.typ;
        if types[t].form = fStr then begin esz := 1; x.typ := tChar; k := 0; end
        else if types[t].form = fArr then begin
          esz := types[types[t].base].size; x.typ := types[t].base; k := types[t].lo;
        end else Error('array expected');
        if not (x.mode in [mGlob, mLoc, mInd]) then Error('cannot index this');
        { a computed base address must survive the index expression }
        if x.mode = mInd then begin PushA(2); x.mode := mStk; end;
        Expression(y);
        if not IsOrd(y.typ) then Error('index must be ordinal');
        if (y.mode = mConst) then begin
          if x.mode = mStk then begin if rv then RPop(rA0) else Gen($68); x.mode := mInd; end;
          x.a := x.a + (y.a - k) * esz;
          if not rv and (x.mode = mLoc) and (x.a + esz > 255) then begin LoadAdr(x); x.mode := mInd; x.a := 0; end;
        end else if rv then begin
          LoadBool(y);
          if y.mode <> mReg then Load(y);
          RAddi(rA0, rA0, -k);
          if esz = 2 then RSlli(rA0, rA0, 1)
          else if esz = 4 then RSlli(rA0, rA0, 2)
          else if esz = 8 then RSlli(rA0, rA0, 3)
          else if esz = 16 then RSlli(rA0, rA0, 4)
          else if esz <> 1 then begin RLi(rT1, esz); RR(1, 0, rA0, rA0, rT1); end;   { mul }
          case x.mode of
            mGlob: begin RLi(rT1, x.a); RR(0, 0, rA0, rA0, rT1); x.a := 0; end;
            mLoc: begin RAddi(rT1, rS0, x.a); RR(0, 0, rA0, rA0, rT1); x.a := 0; end;
            mStk: begin RPop(rT1); RR(0, 0, rA0, rA0, rT1); end;
          end;
          x.mode := mInd;
        end else begin
          { index in A, scaled, plus the base }
          LoadBool(y);
          if y.mode <> mReg then Load(y);
          if k <> 0 then begin Gen($38); Op16($E9, k); end;
          if esz = 2 then Gen($0A)
          else if esz = 4 then begin Gen($0A); Gen($0A); end
          else if esz = 8 then begin Gen($0A); Gen($0A); Gen($0A); end
          else if esz <> 1 then begin LdxImm(esz); Jsl(aMul16); end;
          case x.mode of
            mGlob: begin Gen($18); Op16($69, x.a); x.a := 0; end;
            mLoc: begin StaAbs(aT0); Gen($7B); Gen($18); Op16($69, x.a); Gen($18); Op16($6D, aT0); x.a := 0; end;
            mStk: begin Gen($18); Op8($63, 1); Gen($7A); end;      { clc / adc 1,s / ply }
            mInd: Error('internal: index');
          end;
          x.mode := mInd;
        end;
        if sym = sComma then Next else break;
      until false;
      Expect(sRbrak);
    end else if sym = sCaret then begin
      Next;
      if types[x.typ].form <> fPtr then Error('pointer expected');
      if types[x.typ].base = 0 then Error('typed pointer expected');
      t := types[x.typ].base;
      Load(x);
      x.mode := mInd; x.a := 0; x.typ := t;
    end else exit;
  until false;
end;

{ variables and parameters by symbol }
procedure Designator(var x: TItem; s: integer);
var dp: longint;
begin
  x.typ := syms[s].typ;
  x.tmp := false;
  if syms[s].lev = 0 then begin
    if syms[s].flags and 32 <> 0 then x.mode := mFarC else x.mode := mGlob;
    x.a := syms[s].adr;
  end else begin
    if syms[s].isPar then dp := ParDp(syms[s].lev, syms[s].adr)
    else dp := LocDp(syms[s].adr);
    if syms[s].lev = curLev then begin
      if syms[s].isRef then begin LdaDp(dp); x.mode := mInd; x.a := 0; end
      else if rv or (dp + types[x.typ].size <= 255) then begin x.mode := mLoc; x.a := dp; end
      else begin x.mode := mLoc; x.a := dp; LoadAdr(x); x.mode := mInd; x.a := 0; end;
    end else if rv then begin
      FrameOf(syms[s].lev);
      if syms[s].isRef then begin RLd(4, false, rA0, rA0, dp); x.a := 0; end else x.a := dp;
      x.mode := mInd;
    end else begin
      FrameOf(syms[s].lev);
      Gen($18); Op16($69, dp);
      if syms[s].isRef then begin Gen($AA); Op16($BD, 0); end;
      x.mode := mInd; x.a := 0;
    end;
  end;
  Selector(x);
end;

procedure MemDesignator(var x: TItem; sz: integer);
var y: TItem;
begin
  Expect(sLbrak);
  Expression(y);
  Expect(sRbrak);
  if not IsInt(y.typ) then Error('address expected');
  if sz = 1 then x.typ := tByte else if sz = 2 then x.typ := tWord else x.typ := tLong;
  x.tmp := false;
  if y.mode = mConst then begin x.mode := mFarC; x.a := y.a; end
  else begin
    Load(y);
    if not IsLong(y.typ) then Extend(y.typ);
    x.mode := mFar; x.a := 0;
  end;
end;

{ a field of a record opened with WITH (innermost first) }
function WithField(var x: TItem): boolean;
var i, f: integer;
begin
  WithField := false;
  for i := nWith downto 1 do begin
    f := types[withTyp[i]].fields;
    while (f <> 0) and (syms[f].name <> id) do f := syms[f].next;
    if f <> 0 then begin
      Next;
      x.tmp := false; x.tj := 0; x.fj := 0;
      x.typ := syms[f].typ;
      if withMode[i] = mInd then begin
        LdaDp(withA[i]);                        { the record's address, kept in a frame slot }
        x.mode := mInd; x.a := syms[f].adr;
      end else begin
        x.mode := withMode[i]; x.a := withA[i] + syms[f].adr;
        if not rv and (x.mode = mLoc) and (x.a + types[x.typ].size > 255) then begin LoadAdr(x); x.mode := mInd; x.a := 0; end;
      end;
      Selector(x);
      WithField := true;
      exit;
    end;
  end;
end;

{ a variable (or a WITH field) with its selectors }
procedure VarDesignator(var x: TItem);
var s: integer;
begin
  if sym <> sIdent then Error('variable expected');
  if WithField(x) then exit;
  s := Find(id);
  if (s = 0) or (syms[s].kind <> skVar) then Error('variable expected: ' + id);
  Next;
  Designator(x, s);
end;

{ ---- reals ---- }
function RealFold(op: integer; a, b: longint): longint;
var u, v: TRealBits;
begin
  u.l := a; v.l := b;
  case op of
    sPlus: u.r := u.r + v.r;
    sMinus: u.r := u.r - v.r;
    sTimes: u.r := u.r * v.r;
    sSlash: begin if v.r = 0.0 then Error('division by zero'); u.r := u.r / v.r; end;
  end;
  RealFold := u.l;
end;

function RealCompare(a, b: longint): integer;
var u, v: TRealBits;
begin
  u.l := a; v.l := b;
  if u.r < v.r then RealCompare := -1 else if u.r > v.r then RealCompare := 1 else RealCompare := 0;
end;

{ x (pushed, or constant) and y as two reals on the stack }
procedure PushReals(var x, y: TItem);
begin
  if rv then begin
    if y.mode = mConst then begin
      if IsInt(y.typ) then begin y.a := IntToRealBits(y.a); y.typ := tReal; end;
      if IsInt(x.typ) then begin
        RLd(4, false, rA0, rSp, 0); RPush(rA0); LibCallPop('_inttoreal'); RSt(4, rA0, rSp, 0);
      end;
      RLi(rT1, y.a); RPush(rT1);
    end else begin
      LoadReal(y);
      if x.mode = mConst then begin
        if IsInt(x.typ) then x.a := IntToRealBits(x.a);
        RLi(rT1, x.a); RPush(rT1); RPush(rA0);
      end else begin
        RPush(rA0);
        if IsInt(x.typ) then begin
          RLd(4, false, rA0, rSp, 4); RPush(rA0); LibCallPop('_inttoreal'); RSt(4, rA0, rSp, 4);
        end;
      end;
    end;
    exit;
  end;
  if y.mode = mConst then begin
    if IsInt(y.typ) then begin y.a := IntToRealBits(y.a); y.typ := tReal; end;
  end else begin
    LoadReal(y); StaAbs(aSpare); Op16($8E, aSpare + 2);
  end;
  if x.mode = mConst then begin
    if IsInt(x.typ) then x.a := IntToRealBits(x.a);
    Op16($F4, x.a shr 16); Op16($F4, x.a);
  end else if IsInt(x.typ) then begin
    Gen($68);
    if types[x.typ].size = 4 then Gen($FA) else Extend(x.typ);
    Gen($DA); Gen($48); LibCall('_inttoreal'); PopBytes(4);
    Gen($DA); Gen($48);
  end;
  if y.mode = mConst then begin Op16($F4, y.a shr 16); Op16($F4, y.a); end
  else begin LdaAbs(aSpare + 2); Gen($48); LdaAbs(aSpare); Gen($48); end;
end;

procedure RealArith(op: integer; var x, y: TItem);
var n: TName;
begin
  if not IsNum(x.typ) or not IsNum(y.typ) then Error('numbers expected');
  case op of
    sPlus: n := '_addreal';
    sMinus: n := '_subreal';
    sTimes: n := '_mulreal';
    sSlash: n := '_divreal';
  else
    Error('this operator needs integers');
  end;
  if (x.mode = mConst) and (y.mode = mConst) then begin
    if IsInt(x.typ) then x.a := IntToRealBits(x.a);
    if IsInt(y.typ) then y.a := IntToRealBits(y.a);
    x.a := RealFold(op, x.a, y.a); x.typ := tReal;
    exit;
  end;
  PushReals(x, y);
  LibCallPop(n);
  x.mode := mReg; x.typ := tReal; x.tmp := false;
end;

{ ---- sets ---- }
procedure SetAdr(var x: TItem);
begin
  if types[x.typ].form <> fSet then Error('set expected');
  LoadAdr(x);
end;

procedure PushSet(var x: TItem);
begin
  SetAdr(x); PushA(2); x.mode := mStk;
end;

{ [a, b..c, ...] built at run time in a temporary }
procedure SetCons(var x: TItem);
var e, h: TItem;
begin
  Next;
  AllocTmp; PushA(2);                                  { keep the set's address }
  PushA(2); PeaW(32); PeaW(0); LibCallPop('_fill');
  if sym <> sRbrak then
    repeat
      LdaSlot(1); PushA(2);                            { the set }
      Expression(e);
      if not IsOrd(e.typ) then Error('ordinal value expected in a set');
      LoadBool(e); PushA(2);
      if sym = sDotdot then begin
        Next; Expression(h);
        if not IsOrd(h.typ) then Error('ordinal value expected in a set');
        LoadBool(h); PushA(2);
        LibCallPop('_setrange');
      end else LibCallPop('_setincl');
      if sym = sComma then Next else break;
    until false;
  Expect(sRbrak);
  PopA;
  x.mode := mReg; x.typ := tSet; x.tmp := true; x.tj := 0; x.fj := 0;
end;

{ x (address pushed) op y -> new set in a temporary: 0 union, 1 difference, 2 intersection }
procedure SetOp(code: integer; var x, y: TItem);
begin
  SetAdr(y); SaveB;                                    { b }
  AllocTmp; PushA(2);                                  { keep the result }
  PushA(2);                                            { d }
  LdaSlot(3); PushA(2);                                { a }
  PushB;                                               { b }
  PeaW(code);
  LibCallPop('_setop');
  PopA; DropSlot;                                      { the result / drop a }
  x.mode := mReg; x.typ := tSet; x.tmp := true;
end;

procedure StdFunc(n: TName; var x: TItem);
var y: TItem;
    t, k: integer;
    u: TRealBits;
begin
  Expect(sLparen);
  if (n = 'sizeof') or (n = 'low') or (n = 'high') then begin
    k := 0;
    if sym = sIdent then begin
      k := Find(id);
      if (k <> 0) and (syms[k].kind = skType) then begin t := syms[k].typ; Next; end else k := 0;
    end else if sym = sStringKw then begin Next; t := tString; k := 1; end;
    if k = 0 then begin Expression(y); t := y.typ; end;
    Expect(sRparen);
    if n = 'sizeof' then MakeConst(x, types[t].size, tInteger)
    else if types[t].form = fArr then begin
      if n = 'low' then MakeConst(x, types[t].lo, tInteger) else MakeConst(x, types[t].hi, tInteger);
    end else if n = 'low' then MakeConst(x, types[t].lo, t) else MakeConst(x, types[t].hi, t);
    if (types[t].form = fStr) and (n <> 'sizeof') then if n = 'low' then MakeConst(x, 0, tInteger) else MakeConst(x, types[t].hi, tInteger);
    exit;
  end;
  Expression(x);
  if n = 'ord' then begin
    if not IsOrd(x.typ) then Error('ordinal expected');
    if x.mode = mCond then LoadBool(x);
    if x.typ <> tLong then x.typ := tInteger;
  end else if n = 'chr' then begin
    if x.mode = mConst then x.a := x.a and 255
    else begin Load(x); if rv then RI($13, 7, rA0, rA0, 255) else Op16($29, $FF); end;
    x.typ := tChar;
  end else if (n = 'succ') or (n = 'pred') then begin
    if x.mode = mConst then begin if n = 'succ' then x.a := x.a + 1 else x.a := x.a - 1; end
    else begin
      t := x.typ; Load(x);
      if rv then begin
        if n = 'succ' then RAddi(rA0, rA0, 1) else RAddi(rA0, rA0, -1);
        RNormSz(rA0, types[t].size, types[t].sgn);
      end else begin
        if IsLong(t) then Error('succ/pred of longint not supported');
        if n = 'succ' then Gen($1A) else Gen($3A);
      end;
      x.typ := t;
    end;
  end else if n = 'odd' then begin
    if x.mode = mConst then MakeConst(x, x.a and 1, tBool)
    else begin
      Load(x);
      if rv then RI($13, 7, rA0, rA0, 1) else begin Op16($29, 1); Op16($C9, 0); end;
      x.mode := mCond; x.a := cNe; x.typ := tBool; x.tj := 0; x.fj := 0;
    end;
  end else if n = 'abs' then begin
    if IsReal(x.typ) then begin
      if x.mode = mConst then x.a := x.a and $7FFFFFFF
      else if rv then begin Load(x); RSlli(rA0, rA0, 1); RSrli(rA0, rA0, 1); end
      else begin Load(x); Gen($48); Gen($8A); Op16($29, $7FFF); Gen($AA); Gen($68); end;
    end else if x.mode = mConst then x.a := Abs(x.a)
    else if rv then begin
      Load(x); RSrai(rT0, rA0, 31); RR(0, 4, rA0, rA0, rT0); RR($20, 0, rA0, rA0, rT0);
      if not IsLong(x.typ) then begin RNormSz(rA0, 2, true); x.typ := tInteger; end;
      x.mode := mReg;
    end else begin
      if IsLong(x.typ) then Error('abs of longint: use the expression');
      Load(x); Op16($C9, $8000); Op8($90, 4); Op16($49, $FFFF); Gen($1A);
      x.typ := tInteger;
    end;
  end else if n = 'sqr' then begin
    if IsReal(x.typ) then begin
      if x.mode = mConst then x.a := RealFold(sTimes, x.a, x.a)
      else begin Load(x); PushA(4); PushA(4); LibCallPop('_mulreal'); end;
    end else if x.mode = mConst then x.a := x.a * x.a
    else if rv then begin
      Load(x); RR(1, 0, rA0, rA0, rA0);
      if not IsLong(x.typ) then begin RNormSz(rA0, 2, true); x.typ := tInteger; end;
    end else begin Load(x); Gen($AA); Jsl(aMul16); x.typ := tInteger; end;
  end else if (n = 'trunc') or (n = 'round') then begin
    if x.mode = mConst then begin
      if IsInt(x.typ) then MakeConst(x, x.a, tLong)
      else begin
        u.l := x.a;
        if n = 'trunc' then MakeConst(x, Trunc(u.r), tLong) else MakeConst(x, Round(u.r), tLong);
      end;
    end else begin
      LoadReal(x); PushA(4);
      if n = 'trunc' then LibCallPop('_truncreal') else LibCallPop('_roundreal');
      x.mode := mReg; x.typ := tLong;
    end;
  end else if (n = 'int') or (n = 'frac') or (n = 'sqrt') then begin
    LoadReal(x); PushA(4);
    if n = 'int' then LibCallPop('_intreal') else if n = 'frac' then LibCallPop('_fracreal') else LibCallPop('_sqrtreal');
    x.mode := mReg; x.typ := tReal;
  end else if n = 'length' then begin
    if types[x.typ].form = fChar then MakeConst(x, 1, tInteger)
    else begin
      if types[x.typ].form <> fStr then Error('string expected');
      StrAdr(x);
      if rv then RLd(1, false, rA0, rA0, 0) else begin Gen($AA); Op16($BD, 0); Op16($29, $FF); end;
      x.mode := mReg; x.typ := tInteger;
    end;
  end else if (n = 'lo') or (n = 'hi') then begin
    if x.mode = mConst then begin
      if n = 'lo' then x.a := x.a and 255 else x.a := (x.a shr 8) and 255;
    end else begin
      Load(x);
      if rv then begin if n = 'hi' then RSrli(rA0, rA0, 8); RI($13, 7, rA0, rA0, 255); end
      else begin
        if n = 'hi' then Gen($EB);       { xba }
        Op16($29, $FF);
      end;
    end;
    x.typ := tByte;
  end else if n = 'assigned' then begin
    Load(x); if not rv then Op16($C9, 0); x.mode := mCond; x.a := cNe; x.typ := tBool; x.tj := 0; x.fj := 0;
  end else Error('unknown function ' + n);
  Expect(sRparen);
end;

{ x in [ a, lo..hi, ... ]: tested inline (elements may be expressions) }
procedure SetTest(var x: TItem);
var lo, hi: TItem;
    yes, no: longint;
    single: boolean;
begin
  Expect(sLbrak);
  if rv then begin
    LoadBool(x); RPush(rA0);
    yes := 0;
    if sym <> sRbrak then
      repeat
        Expression(lo);
        if not IsOrd(lo.typ) then Error('ordinal value expected in a set');
        if lo.mode <> mConst then begin LoadBool(lo); RPush(rA0); end;
        single := sym <> sDotdot;
        if not single then begin
          Next; Expression(hi);
          if not IsOrd(hi.typ) then Error('ordinal value expected in a set');
          if hi.mode <> mConst then begin LoadBool(hi); RMv(rA2, rA0); end else RLi(rA2, hi.a);
        end;
        if lo.mode = mConst then RLi(rA1, lo.a) else RPop(rA1);
        RLd(4, false, rA0, rSp, 0);
        if single then begin RB(1, rA0, rA1, 8); BrlFwd(yes); end
        else begin RB(6, rA0, rA1, 12); RB(6, rA2, rA0, 8); BrlFwd(yes); end;
        if sym = sComma then Next else break;
      until false;
    Expect(sRbrak);
    RLi(rA0, 0); no := 0; BrlFwd(no);
    FixChain(yes, pc); RLi(rA0, 1);
    FixChain(no, pc);
    RAddi(rSp, rSp, 4);
    x.mode := mReg; x.typ := tBool;
    exit;
  end;
  LoadBool(x);
  StaAbs(aSpare + 12);
  yes := 0;
  if sym <> sRbrak then
    repeat
      Expression(lo);
      if not IsOrd(lo.typ) then Error('ordinal value expected in a set');
      if lo.mode <> mConst then begin LoadBool(lo); StaAbs(aSpare + 14); end;
      single := sym <> sDotdot;
      if not single then begin
        Next; Expression(hi);
        if not IsOrd(hi.typ) then Error('ordinal value expected in a set');
        if hi.mode <> mConst then begin LoadBool(hi); StaAbs(aSpare + 8); end;
      end;
      LdaAbs(aSpare + 12);
      if lo.mode = mConst then Op16($C9, lo.a) else Op16($CD, aSpare + 14);
      if single then begin Op8($D0, 3); BrlFwd(yes); end
      else begin
        if hi.mode = mConst then begin
          Op8($90, 8); Op16($C9, hi.a + 1); Op8($B0, 3); BrlFwd(yes);
        end else begin
          Op8($90, 10); Op16($CD, aSpare + 8); Op8($F0, 2); Op8($B0, 3); BrlFwd(yes);
        end;
      end;
      if sym = sComma then Next else break;
    until false;
  Expect(sRbrak);
  LdaImm(0); no := 0; BrlFwd(no);
  FixChain(yes, pc);
  LdaImm(1);
  FixChain(no, pc);
  x.mode := mReg; x.typ := tBool;
end;

procedure Factor(var x: TItem);
var s: integer;
    t: integer;
    j: longint;
begin
  x.tmp := false; x.tj := 0; x.fj := 0;
  case sym of
    sNumber: begin MakeConst(x, num, IntTypeFor(num)); Next; end;
    sReal: begin MakeConst(x, num, tReal); Next; end;
    sString: begin
      if length(str) = 1 then MakeConst(x, ord(str[1]), tChar)
      else begin x.mode := mGlob; x.a := StrLiteral(str); x.typ := tString; end;
      Next;
    end;
    sLbrak: SetCons(x);
    sLparen: begin Next; Expression(x); Expect(sRparen); end;
    sNot: begin
      Next; Factor(x);
      if x.typ = tBool then begin
        if x.mode = mConst then x.a := 1 - x.a
        else if x.mode = mCond then begin
          x.a := Inverse(x.a);
          j := x.tj;
          x.tj := x.fj; x.fj := j;
        end else begin Load(x); if rv then RI($13, 4, rA0, rA0, 1) else Op16($49, 1); end;
      end else if IsInt(x.typ) then begin
        if x.mode = mConst then x.a := not x.a
        else if rv then begin
          Load(x); RI($13, 4, rA0, rA0, -1); RNormSz(rA0, types[x.typ].size, types[x.typ].sgn);
        end else begin
          if IsLong(x.typ) then Error('not of longint not supported');
          Load(x); Op16($49, $FFFF);
        end;
      end else Error('boolean expected after NOT');
    end;
    sNil: begin MakeConst(x, 0, tNil); Next; end;
    sAt: begin
      Next;
      VarDesignator(x);
      LoadAdr(x);
      x.typ := tPointer;
    end;
    sIdent: begin
      if WithField(x) then exit;
      if (id = 'mem') or (id = 'memw') or (id = 'meml') then begin
        if id = 'mem' then t := 1 else if id = 'memw' then t := 2 else t := 4;
        Next; MemDesignator(x, t); exit;
      end;
      if (id = 'ord') or (id = 'chr') or (id = 'succ') or (id = 'pred') or (id = 'odd') or (id = 'abs') or
         (id = 'sqr') or (id = 'length') or (id = 'sizeof') or (id = 'lo') or (id = 'hi') or
         (id = 'assigned') or (id = 'low') or (id = 'high') or (id = 'trunc') or (id = 'round') or
         (id = 'int') or (id = 'frac') or (id = 'sqrt') then begin
        str := id; Next; StdFunc(str, x); exit;
      end;
      s := Find(id);
      if s = 0 then Error('unknown identifier ' + id);
      Next;
      case syms[s].kind of
        skConst: begin
          MakeConst(x, syms[s].adr, syms[s].typ);
          if types[x.typ].form = fStr then x.mode := mGlob;
        end;
        skVar: Designator(x, s);
        skType: begin
          t := syms[s].typ;
          Expect(sLparen); Expression(x); Expect(sRparen);
          if (t = tReal) and IsInt(x.typ) then begin LoadReal(x); end
          else Cast(x, t);
          Selector(x);
        end;
        skProc: begin
          if syms[s].typ = 0 then Error('procedure has no value');
          if (syms[s].flags and 4 = 0) and (sym <> sLparen) and (s = ctxProc[curLev]) then
            Error('use Result for the function value');
          CallProc(s, x);
          if types[x.typ].form in [fRec, fArr] then begin
            x.mode := mInd; x.a := 0; x.tmp := false;   { the buffer is released with the statement }
            Selector(x);
          end;
        end;
      else
        Error('value expected');
      end;
    end;
  else
    Error('expression expected');
  end;
end;

{ ---- binary operators ---- }
{ x (left) has been pushed (mStk) or is a constant; y is the right operand }
procedure Push(var x: TItem);
begin
  if x.mode = mConst then exit;
  LoadBool(x);
  PushA(types[x.typ].size);
  x.mode := mStk;
end;

procedure PushStr(var x: TItem);
begin
  StrAdr(x);
  PushA(2);
  x.mode := mStk;
end;

{ 32-bit operands: y -> rt_b, x -> rt_a }
procedure ToAB(var x, y: TItem);
begin
  if y.mode = mConst then begin
    LdaImm(y.a); StaAbs(aB); LdaImm(y.a shr 16); StaAbs(aB + 2);
  end else begin
    Load(y); Extend(y.typ); StaAbs(aB); Op16($8E, aB + 2);
  end;
  if x.mode = mConst then begin
    LdaImm(x.a); StaAbs(aA); LdaImm(x.a shr 16); StaAbs(aA + 2);
  end else begin
    Gen($68);   { pla }
    if types[x.typ].size = 4 then Gen($FA) else Extend(x.typ);
    StaAbs(aA); Op16($8E, aA + 2);
  end;
end;

function Fold(op: integer; a, b: longint): longint;
begin
  case op of
    sPlus: Fold := a + b;
    sMinus: Fold := a - b;
    sTimes: Fold := a * b;
    sDiv: begin if b = 0 then Error('division by zero'); Fold := a div b; end;
    sMod: begin if b = 0 then Error('division by zero'); Fold := a mod b; end;
    sAnd: Fold := a and b;
    sOr: Fold := a or b;
    sXor: Fold := a xor b;
    sShl: Fold := a shl b;
    sShr: Fold := a shr b;
  else
    Fold := 0;
  end;
end;

procedure Arith(op: integer; var x, y: TItem);
var long, sg: boolean;
    rt: integer;
begin
  if IsReal(x.typ) or IsReal(y.typ) then begin RealArith(op, x, y); exit; end;
  if not IsInt(x.typ) or not IsInt(y.typ) then Error('integers expected');
  if (x.mode = mConst) and (y.mode = mConst) then begin
    MakeConst(x, Fold(op, x.a, y.a), tInteger);
    x.typ := IntTypeFor(x.a);
    exit;
  end;
  long := IsLong(x.typ) or IsLong(y.typ) or (x.mode = mConst) and (IntTypeFor(x.a) = tLong) or
          (y.mode = mConst) and (IntTypeFor(y.a) = tLong);
  sg := types[x.typ].sgn or types[y.typ].sgn;
  if rv then begin
    if x.mode = mConst then begin Load(y); RLi(rA1, x.a); end
    else if y.mode = mConst then begin RPop(rA1); RLi(rA0, y.a); end
    else begin Load(y); RPop(rA1); end;
    if not long and (op = sShr) then RNormSz(rA1, 2, false);
    case op of
      sPlus: RR(0, 0, rA0, rA1, rA0);
      sMinus: RR($20, 0, rA0, rA1, rA0);
      sAnd: RR(0, 7, rA0, rA1, rA0);
      sOr: RR(0, 6, rA0, rA1, rA0);
      sXor: RR(0, 4, rA0, rA1, rA0);
      sTimes: RR(1, 0, rA0, rA1, rA0);
      sDiv, sMod: begin
        RB(1, rA0, rZero, 16); RLi(rA0, 200); RCall(aRtError);
        if op = sDiv then begin if sg or long then RR(1, 4, rA0, rA1, rA0) else RR(1, 5, rA0, rA1, rA0); end
        else begin if sg or long then RR(1, 6, rA0, rA1, rA0) else RR(1, 7, rA0, rA1, rA0); end;
      end;
      sShl: RR(0, 1, rA0, rA1, rA0);
      sShr: RR(0, 5, rA0, rA1, rA0);
    end;
    x.mode := mReg;
    if long then x.typ := tLong
    else begin
      if not types[x.typ].sgn and not types[y.typ].sgn then x.typ := tWord else x.typ := tInteger;
      RNormSz(rA0, 2, types[x.typ].sgn);
    end;
    exit;
  end;
  if long then begin
    ToAB(x, y);
    case op of
      sPlus, sMinus, sAnd, sOr, sXor: begin
        case op of
          sPlus: rt := $6D; sMinus: rt := $ED; sAnd: rt := $2D; sOr: rt := $0D; sXor: rt := $4D;
        end;
        LdaAbs(aA);
        if op = sPlus then Gen($18) else if op = sMinus then Gen($38);
        Op16(rt, aB); Gen($A8);
        LdaAbs(aA + 2); Op16(rt, aB + 2); Gen($AA); Gen($98);
      end;
      sTimes: Jsl(aMul32);
      sDiv: Jsl(aDiv32s);
      sMod: Jsl(aMod32s);
      sShl: Jsl(aShl32);
      sShr: Jsl(aShr32);
    end;
    x.mode := mReg; x.typ := tLong;
    exit;
  end;
  if x.mode = mConst then begin
    Load(y);
    case op of
      sPlus: begin Gen($18); Op16($69, x.a); end;
      sMinus: begin Op16($49, $FFFF); Gen($38); Op16($69, x.a); end;
      sAnd: Op16($29, x.a);
      sOr: Op16($09, x.a);
      sXor: Op16($49, x.a);
      sTimes: begin LdxImm(x.a); Jsl(aMul16); end;
      sDiv, sMod, sShl, sShr: begin
        Gen($AA); LdaImm(x.a);
        case op of
          sDiv: if sg then Jsl(aDiv16s) else Jsl(aDiv16u);
          sMod: if sg then Jsl(aMod16s) else Jsl(aMod16u);
          sShl: Jsl(aShl16);
          sShr: Jsl(aShr16);
        end;
      end;
    end;
  end else if y.mode = mConst then begin
    Gen($68);   { pla: x }
    case op of
      sPlus: if y.a = 1 then Gen($1A) else begin Gen($18); Op16($69, y.a); end;
      sMinus: if y.a = 1 then Gen($3A) else begin Gen($38); Op16($E9, y.a); end;
      sAnd: Op16($29, y.a);
      sOr: Op16($09, y.a);
      sXor: Op16($49, y.a);
      sTimes: if y.a = 2 then Gen($0A) else if y.a = 4 then begin Gen($0A); Gen($0A); end
              else begin LdxImm(y.a); Jsl(aMul16); end;
      sDiv: begin LdxImm(y.a); if sg then Jsl(aDiv16s) else Jsl(aDiv16u); end;
      sMod: begin LdxImm(y.a); if sg then Jsl(aMod16s) else Jsl(aMod16u); end;
      sShl: begin LdxImm(y.a); Jsl(aShl16); end;
      sShr: begin LdxImm(y.a); Jsl(aShr16); end;
    end;
  end else begin
    Load(y);
    case op of
      sPlus: begin Gen($18); Op8($63, 1); Gen($7A); end;
      sMinus: begin Op16($49, $FFFF); Gen($38); Op8($63, 1); Gen($7A); end;
      sAnd: begin Op8($23, 1); Gen($7A); end;
      sOr: begin Op8($03, 1); Gen($7A); end;
      sXor: begin Op8($43, 1); Gen($7A); end;
      sTimes: begin Gen($AA); Gen($68); Jsl(aMul16); end;
      sDiv: begin Gen($AA); Gen($68); if sg then Jsl(aDiv16s) else Jsl(aDiv16u); end;
      sMod: begin Gen($AA); Gen($68); if sg then Jsl(aMod16s) else Jsl(aMod16u); end;
      sShl: begin Gen($AA); Gen($68); Jsl(aShl16); end;
      sShr: begin Gen($AA); Gen($68); Jsl(aShr16); end;
    end;
  end;
  x.mode := mReg;
  if not types[x.typ].sgn and not types[y.typ].sgn then x.typ := tWord else x.typ := tInteger;
end;

function RelCode(op: integer): integer;
begin
  case op of
    sEql: RelCode := cEq; sNeq: RelCode := cNe; sLss: RelCode := cLt;
    sLeq: RelCode := cLe; sGtr: RelCode := cGt; sGeq: RelCode := cGe;
  end;
end;

procedure CondResult(var x: TItem; c: integer);
begin
  x.mode := mCond; x.a := c; x.typ := tBool; x.tj := 0; x.fj := 0;
end;

procedure Relation(op: integer; var x, y: TItem);
var c, r: integer;
    sg: boolean;
    sp: integer;
begin
  c := RelCode(op);
  if types[x.typ].form = fSet then begin
    { x was pushed as an address }
    SetAdr(y); PushA(2);
    if (op = sLss) or (op = sGtr) then Error('sets compare with = <> <= >=');
    if op = sGeq then begin                                        { swap: y <= x }
      if rv then begin RPop(rA0); RPop(rA1); RPush(rA0); RPush(rA1); end
      else begin Gen($68); Gen($FA); Gen($48); Gen($DA); end;
    end;
    if (op = sEql) or (op = sNeq) then LibCallPop('_seteq') else LibCallPop('_setle');
    if not rv then begin Op16($29, $FF); Op16($C9, 0); end;
    if op = sNeq then CondResult(x, cEq) else CondResult(x, cNe);
    exit;
  end;
  if IsStrish(x.typ) and IsStrish(y.typ) and ((types[x.typ].form = fStr) or (types[y.typ].form = fStr)) then begin
    { x was pushed as an address }
    StrAdr(y); PushA(2);
    LibCallPop('_strcmp');
    if rv then begin RSetCmp(c, true, rA0, rZero); CondResult(x, cNe); exit; end;
    Op16($49, $8000); Op16($C9, $8000);
    CondResult(x, c);
    exit;
  end;
  if IsReal(x.typ) or IsReal(y.typ) then begin
    if not IsNum(x.typ) or not IsNum(y.typ) then Error('numbers expected');
    if (x.mode = mConst) and (y.mode = mConst) then begin
      if IsInt(x.typ) then x.a := IntToRealBits(x.a);
      if IsInt(y.typ) then y.a := IntToRealBits(y.a);
      r := RealCompare(x.a, y.a);
      case c of
        cEq: x.a := ord(r = 0); cNe: x.a := ord(r <> 0); cLt: x.a := ord(r < 0);
        cLe: x.a := ord(r <= 0); cGt: x.a := ord(r > 0); cGe: x.a := ord(r >= 0);
      end;
      x.typ := tBool;
      exit;
    end;
    PushReals(x, y);
    LibCallPop('_cmpreal');
    if rv then begin RSetCmp(c, true, rA0, rZero); CondResult(x, cNe); exit; end;
    Op16($49, $8000); Op16($C9, $8000);
    CondResult(x, c);
    exit;
  end;
  if (x.mode = mConst) and (y.mode = mConst) then begin
    case c of
      cEq: x.a := ord(x.a = y.a); cNe: x.a := ord(x.a <> y.a); cLt: x.a := ord(x.a < y.a);
      cLe: x.a := ord(x.a <= y.a); cGt: x.a := ord(x.a > y.a); cGe: x.a := ord(x.a >= y.a);
    end;
    x.typ := tBool;
    exit;
  end;
  if rv then begin
    if IsInt(x.typ) <> IsInt(y.typ) then Error('incompatible types in comparison');
    sg := IsInt(x.typ) and (types[x.typ].sgn or types[y.typ].sgn or IsLong(x.typ) or IsLong(y.typ));
    if x.mode = mConst then begin LoadBool(y); RLi(rA1, x.a); end
    else if y.mode = mConst then begin RPop(rA1); RLi(rA0, y.a); end
    else begin LoadBool(y); RPop(rA1); end;
    RSetCmp(c, sg, rA1, rA0);
    CondResult(x, cNe);
    exit;
  end;
  if IsInt(x.typ) and IsInt(y.typ) and (IsLong(x.typ) or IsLong(y.typ)) then begin
    ToAB(x, y);
    Jsl(aCmp32s);
    CondResult(x, c + 10);
    exit;
  end;
  if IsInt(x.typ) <> IsInt(y.typ) then Error('incompatible types in comparison');
  sg := IsInt(x.typ) and (types[x.typ].sgn or types[y.typ].sgn);
  if x.mode = mConst then begin
    { x op A  <=>  A op' x }
    LoadBool(y);
    if sg then Op16($49, $8000);
    if sg then Op16($C9, (x.a xor $8000) and $FFFF) else Op16($C9, x.a and $FFFF);
    case c of
      cLt: c := cGt; cGt: c := cLt; cLe: c := cGe; cGe: c := cLe;
    end;
  end else if y.mode = mConst then begin
    Gen($68);
    if sg then begin Op16($49, $8000); Op16($C9, (y.a xor $8000) and $FFFF); end
    else Op16($C9, y.a and $FFFF);
  end else begin
    LoadBool(y);
    if sg then Op16($49, $8000);
    StaAbs(aT0);
    Gen($68);
    if sg then Op16($49, $8000);
    Op16($CD, aT0);
  end;
  CondResult(x, c);
end;

procedure Term(var x: TItem);
var y: TItem;
    op, n0: integer;
begin
  n0 := nTmp;
  Factor(x);
  while sym in [sTimes, sDiv, sMod, sAnd, sShl, sShr, sSlash] do begin
    op := sym; Next;
    if (op = sAnd) and (x.typ = tBool) then begin
      if x.mode = mConst then begin
        Factor(y);
        if y.typ <> tBool then Error('boolean expected');
        if x.a = 0 then begin LoadBool(y); MakeConst(x, 0, tBool); end else x := y;
      end else begin
        { short circuit: a false left side skips the right side }
        ToCond(x, n0);
        CondTrue(x.a, 3); BrlFwd(x.fj);
        FixChain(x.tj, pc); x.tj := 0;
        Factor(y);
        ToCond(y, n0);
        y.fj := MergeChain(y.fj, x.fj);
        x := y;
      end;
    end else if (op = sTimes) and (types[x.typ].form = fSet) then begin
      PushSet(x);
      Factor(y);
      SetOp(2, x, y);
    end else begin
      Push(x);
      Factor(y);
      if op = sSlash then RealArith(op, x, y) else Arith(op, x, y);
    end;
  end;
end;

procedure SimpleExpr(var x: TItem);
var y: TItem;
    op, sp, n0: integer;
begin
  n0 := nTmp;
  if sym = sMinus then begin
    Next; Term(x);
    if not IsNum(x.typ) then Error('number expected');
    if rv and (x.mode <> mConst) then begin
      Load(x);
      if IsReal(x.typ) then begin RLi(rT1, longint($80000000)); RR(0, 4, rA0, rA0, rT1); end
      else begin
        RR($20, 0, rA0, rZero, rA0);
        if IsLong(x.typ) then x.typ := tLong else begin RNormSz(rA0, 2, true); x.typ := tInteger; end;
      end;
      x.mode := mReg;
    end else if IsReal(x.typ) then begin
      if x.mode = mConst then x.a := x.a xor longint($80000000)
      else begin Load(x); Gen($48); Gen($8A); Op16($49, $8000); Gen($AA); Gen($68); end;
    end else if x.mode = mConst then x.a := -x.a
    else if IsLong(x.typ) then begin
      Load(x); StaAbs(aB); Op16($8E, aB + 2);
      LdaImm(0); Gen($38); Op16($ED, aB); Gen($A8); LdaImm(0); Op16($ED, aB + 2); Gen($AA); Gen($98);
      x.mode := mReg; x.typ := tLong;
    end else begin
      Load(x); Op16($49, $FFFF); Gen($1A);
      x.typ := tInteger;
    end;
  end else begin
    if sym = sPlus then Next;
    Term(x);
  end;
  while sym in [sPlus, sMinus, sOr, sXor] do begin
    op := sym; Next;
    if (op = sPlus) and IsStrish(x.typ) then begin
      { string concatenation into a temporary }
      if not x.tmp then begin
        StrAdr(x); PushA(2);                       { source }
        AllocTmp; PushA(2);                        { keep the temporary }
        PushA(2);                                  { destination }
        LdaSlot(3); PushA(2);                      { source again }
        PeaW(255);
        LibCallPop('_strasg');
        PopA; DropSlot; PushA(2);                  { the temporary / drop the source / keep it }
      end else PushA(2);
      Term(y);
      StrAdr(y);
      SaveB;                                        { source }
      LdaSlot(1); PushA(2);                         { destination }
      PushB;                                        { source }
      PeaW(255);
      LibCallPop('_strcat');
      PopA;                                         { the temporary }
      x.mode := mReg; x.typ := tString; x.tmp := true;
    end else if (op = sOr) and (x.typ = tBool) then begin
      if x.mode = mConst then begin
        Term(y);
        if y.typ <> tBool then Error('boolean expected');
        if x.a <> 0 then begin LoadBool(y); MakeConst(x, 1, tBool); end else x := y;
      end else begin
        { short circuit: a true left side skips the right side }
        ToCond(x, n0);
        CondTrue(Inverse(x.a), 3); BrlFwd(x.tj);
        FixChain(x.fj, pc); x.fj := 0;
        Term(y);
        ToCond(y, n0);
        y.tj := MergeChain(y.tj, x.tj);
        x := y;
      end;
    end else if (op = sXor) and (x.typ = tBool) then begin
      Push(x);
      Term(y);
      if y.typ <> tBool then Error('boolean expected');
      LoadBool(y);
      if rv then begin RPop(rA1); RR(0, 4, rA0, rA0, rA1); end
      else begin Op8($43, 1); Gen($7A); end;
      x.mode := mReg; x.typ := tBool;
    end else if ((op = sPlus) or (op = sMinus)) and (types[x.typ].form = fSet) then begin
      PushSet(x);
      Term(y);
      if op = sPlus then SetOp(0, x, y) else SetOp(1, x, y);
    end else begin
      Push(x);
      Term(y);
      Arith(op, x, y);
    end;
  end;
end;

procedure Expression(var x: TItem);
var y: TItem;
    op: integer;
begin
  SimpleExpr(x);
  if sym = sIn then begin
    Next;
    if not IsOrd(x.typ) then Error('ordinal value expected before IN');
    if sym = sLbrak then begin SetTest(x); exit; end;
    LoadBool(x); PushA(2);
    SimpleExpr(y);
    SetAdr(y); PushA(2);
    LibCallPop('_setin');
    if not rv then Op16($29, $FF);
    x.mode := mReg; x.typ := tBool;
    exit;
  end;
  if sym in [sEql, sNeq, sLss, sLeq, sGtr, sGeq] then begin
    op := sym; Next;
    if types[x.typ].form = fStr then PushStr(x)
    else if types[x.typ].form = fSet then PushSet(x)
    else Push(x);
    SimpleExpr(y);
    if (types[x.typ].form = fChar) and (types[y.typ].form = fStr) then
      Error('put the string first when comparing a string with a char');
    Relation(op, x, y);
  end;
end;

{ ================================================================ calls }
procedure PushArg(p: integer);
var x: TItem;
    s: integer;
    pt: integer;
begin
  pt := syms[p].typ;
  if syms[p].isRef then begin
    if (types[pt].form = fStr) and (syms[p].flags and 1 = 0) then begin
      Expression(x); StrAdr(x); PushA(2); exit;
    end;
    if (types[pt].form in [fArr, fRec]) and (syms[p].flags and 1 = 0) then begin
      Expression(x); LoadAdr(x); PushA(2); exit;
    end;
    if (types[pt].form = fSet) and (syms[p].flags and 1 = 0) then begin
      Expression(x); SetAdr(x); PushA(2); exit;
    end;
    { var parameter / untyped: an address }
    if (id = 'mem') or (id = 'memw') or (id = 'meml') then Error('Mem[] cannot be a var parameter');
    VarDesignator(x);
    if (types[pt].form <> fUntyped) and (types[pt].size <> types[x.typ].size) then Error('wrong variable type');
    LoadAdr(x); PushA(2);
    exit;
  end;
  Expression(x);
  LoadAs(x, pt);
  PushA(types[pt].size);
end;

{ the type of a function result passed through a hidden buffer }
function ResultType(s: integer): integer;
begin
  if (syms[s].flags and 4 <> 0) or (types[syms[s].typ].form = fStr) then ResultType := tString
  else ResultType := syms[s].typ;
end;

procedure CallProc(s: integer; var x: TItem);
var p, n, i: integer;
    fix: longint;
begin
  if syms[s].flags and 1 <> 0 then begin
    AllocTmp;
    PushA(2); PushA(2);          { keep a copy of the result buffer, pass it }
  end;
  p := syms[s].first;
  n := 0;
  if sym = sLparen then begin
    Next;
    if sym <> sRparen then
      repeat
        if p = 0 then Error('too many arguments');
        PushArg(p);
        p := syms[p].next;
        n := n + 1;
        if sym = sComma then Next else break;
      until false;
    Expect(sRparen);
  end;
  if p <> 0 then Error('too few arguments');
  if (syms[s].flags and 4 = 0) and (syms[s].lev >= 2) then begin
    { static link: frame of the procedure that declares the callee }
    if syms[s].lev - 1 = curLev then begin if rv then RMv(rA0, rS0) else Gen($7B); end
    else FrameOf(syms[s].lev - 1);
    PushA(2);
  end;
  if (syms[s].flags and 2 <> 0) or (syms[s].flags and 4 <> 0) then Jsl(syms[s].adr)
  else if rv then begin
    W32(syms[s].adr); W32(0);
    syms[s].adr := pc - 8;
  end else begin
    { not compiled yet: chain the call }
    Gen($22); fix := syms[s].adr; Gen16(fix); Gen(0);
    syms[s].adr := pc - 3;
  end;
  PopBytes(syms[s].parsz);
  x.tmp := false;
  if syms[s].flags and 1 <> 0 then begin
    PopA;
    x.mode := mReg; x.typ := ResultType(s); x.tmp := true;
  end else begin
    x.mode := mReg; x.typ := syms[s].typ;
  end;
end;

{ library procedures: arguments by count (parsz from the parameter list) }
procedure CalcLibParsz(s: integer);
var p, sz: integer;
begin
  sz := 0;
  p := syms[s].first;
  while p <> 0 do begin
    if rv or not syms[p].isRef and (types[syms[p].typ].size > 2) then sz := sz + 4 else sz := sz + 2;
    p := syms[p].next;
  end;
  if syms[s].flags and 1 <> 0 then if rv then sz := sz + 4 else sz := sz + 2;
  syms[s].parsz := sz;
end;

procedure CallLib(const n: TName);
var s: integer;
begin
  s := LibProc(n);
  Jsl(syms[s].adr);
end;

{ ================================================================ statements }
procedure Statement; forward;

procedure StdWrite(ln: boolean);
var x, w: TItem;
    f: integer;
begin
  if sym = sLparen then begin
    Next;
    if sym <> sRparen then
      repeat
        Expression(x);
        f := types[x.typ].form;
        if f = fStr then begin StrAdr(x); PushA(2); end
        else if f = fChar then begin Load(x); PushA(2); end
        else if f = fBool then begin LoadBool(x); PushA(2); end
        else if f = fInt then begin Load(x); Extend(x.typ); PushA(4); end
        else if f = fEnum then begin Load(x); if not rv then LdxImm(0); PushA(4); f := fInt; end
        else if f = fReal then begin Load(x); PushA(4); end
        else Error('cannot write this');
        if sym = sColon then begin
          Next; Expression(w);
          if not IsInt(w.typ) then Error('width expected');
          Load(w); PushA(2);
        end else PeaW(0);
        if f = fReal then begin
          if sym = sColon then begin
            Next; Expression(w);
            if not IsInt(w.typ) then Error('number of decimals expected');
            Load(w); PushA(2);
          end else PeaW($FFFF);
          LibCallPop('_writereal');
        end else begin
          if f = fStr then LibCallPop('_writestr')
          else if f = fChar then LibCallPop('_writechar')
          else if f = fBool then LibCallPop('_writebool')
          else LibCallPop('_writeint');
        end;
        ReleaseTmp(false, false);
        if sym = sComma then Next else break;
      until false;
    Expect(sRparen);
  end;
  if ln then CallLib('_writeln');
end;

procedure StdRead(ln: boolean);
var x: TItem;
    s, f: integer;
begin
  if sym = sLparen then begin
    Next;
    if sym <> sRparen then
      repeat
        VarDesignator(x);
        f := types[x.typ].form;
        if f = fStr then begin
          LoadAdr(x); PushA(2); PeaW(types[x.typ].hi);
          LibCallPop('_readstr');
        end else begin
          PrepStore(x);
          if f = fInt then CallLib('_readint')
          else if f = fReal then CallLib('_readreal')
          else if f = fChar then CallLib('_readchar')
          else Error('cannot read this');
          Store(x);
        end;
        if sym = sComma then Next else break;
      until false;
    Expect(sRparen);
  end;
  if ln then CallLib('_readlnend');
end;

procedure StdIncDec(dec: boolean);
var x, y: TItem;
    s, sz: integer;
    k: longint;
begin
  Expect(sLparen);
  VarDesignator(x);
  if not IsOrd(x.typ) and (types[x.typ].form <> fPtr) then Error('ordinal variable expected');
  sz := types[x.typ].size;
  LoadAdr(x); PushA(2);
  k := 1;
  if types[x.typ].form = fPtr then if types[x.typ].base <> 0 then k := types[types[x.typ].base].size;
  if sym = sComma then begin
    Next; Expression(y);
    if y.mode = mConst then k := y.a * k
    else begin
      if k <> 1 then Error('inc of a pointer by a variable is not supported');
      Load(y); Extend(y.typ);
      if rv then RMv(rA3, rA0) else begin StaAbs(aT0); Op16($8E, aT0 + 2); end;
      k := 0;
    end;
  end;
  Expect(sRparen);
  if rv then begin
    RPop(rT1);
    RLd(sz, types[x.typ].sgn, rA0, rT1, 0);
    if k = 0 then begin if dec then RR($20, 0, rA0, rA0, rA3) else RR(0, 0, rA0, rA0, rA3); end
    else if dec then RAddi(rA0, rA0, -k) else RAddi(rA0, rA0, k);
    RSt(sz, rA0, rT1, 0);
    exit;
  end;
  Op8($A3, 1); Gen($AA);                 { lda 1,s / tax }
  if sz = 1 then Sep;
  Op16($BD, 0);                           { lda 0,x }
  if dec then Gen($38) else Gen($18);
  if k = 0 then begin if dec then Op16($ED, aT0) else Op16($6D, aT0); end
  else if sz = 1 then begin if dec then Op8($E9, k) else Op8($69, k); end
  else begin if dec then Op16($E9, k) else Op16($69, k); end;
  Op16($9D, 0);                           { sta 0,x }
  if sz = 1 then Rep;
  if sz = 4 then begin
    Op16($BD, 2);
    if k = 0 then begin if dec then Op16($ED, aT0 + 2) else Op16($6D, aT0 + 2); end
    else begin if dec then Op16($E9, k shr 16) else Op16($69, k shr 16); end;
    Op16($9D, 2);
  end;
  Gen($7A);                                { ply }
end;

procedure Assignment(var x: TItem);
var y: TItem;
    sp, t: integer;
begin
  t := x.typ;
  if types[t].form = fStr then begin
    LoadAdr(x); PushA(2);
    Expect(sBecomes);
    Expression(y);
    StrAdr(y); PushA(2);
    PeaW(types[t].hi);
    LibCallPop('_strasg');
    exit;
  end;
  if types[t].form in [fArr, fRec, fSet] then begin
    LoadAdr(x); PushA(2);
    Expect(sBecomes);
    Expression(y);
    if types[t].form = fSet then SetAdr(y)
    else begin
      if y.typ <> t then Error('incompatible types');
      LoadAdr(y);
    end;
    if rv then begin
      RMv(rA1, rA0); RPop(rA0); RLi(rA2, types[t].size); RCall(aMemmove);
      exit;
    end;
    Gen($AA); Gen($7A);                         { tax (source) / ply (destination) }
    LdaImm(types[t].size - 1);
    Op8($54, 0); Gen(0);                        { mvn 0,0 }
    exit;
  end;
  PrepStore(x);
  Expect(sBecomes);
  Expression(y);
  LoadAs(y, t);
  Store(x);
end;

procedure StdNewDispose(isNew: boolean);
var x: TItem;
    s, t: integer;
begin
  Expect(sLparen);
  VarDesignator(x);
  t := x.typ;
  if (types[t].form <> fPtr) or (types[t].base = 0) then Error('typed pointer expected');
  if isNew then begin
    PrepStore(x);
    PeaW(types[types[t].base].size);
    LibCallPop('_getmem');
    Store(x);
  end else begin
    Load(x); PushA(PtrSz); PeaW(types[types[t].base].size);
    LibCallPop('_freemem');
  end;
  Expect(sRparen);
end;

procedure StdStr;
var x, w, v: TItem;
    isR: boolean;
begin
  Expect(sLparen);
  Expression(x);
  if not IsNum(x.typ) then Error('number expected');
  isR := IsReal(x.typ);
  Load(x); if not isR then Extend(x.typ); PushA(4);
  if sym = sColon then begin Next; Expression(w); Load(w); PushA(2); end else PeaW(0);
  if isR then begin
    if sym = sColon then begin Next; Expression(w); Load(w); PushA(2); end else PeaW($FFFF);
  end;
  Expect(sComma);
  VarDesignator(v);
  if types[v.typ].form <> fStr then Error('string variable expected');
  LoadAdr(v); PushA(2); PeaW(types[v.typ].hi);
  if isR then LibCallPop('_strreal') else LibCallPop('_strint');
  Expect(sRparen);
end;

procedure StatSeq;
begin
  Statement;
  while sym = sSemi do begin Next; Statement; end;
end;

procedure IfStat;
var x: TItem;
    fFalse, fEnd: longint;
begin
  Next;
  Expression(x);
  fFalse := 0;
  JumpFalse(x, fFalse);
  Expect(sThen);
  Statement;
  if sym = sElse then begin
    Next;
    fEnd := 0; BrlFwd(fEnd);
    FixChain(fFalse, pc);
    Statement;
    FixChain(fEnd, pc);
  end else FixChain(fFalse, pc);
end;

procedure WhileStat;
var x: TItem;
    top: longint;
begin
  Next;
  top := pc;
  nLoop := nLoop + 1;
  if nLoop > MaxLoop then Error('loops nested too deeply');
  loopBreak[nLoop] := 0; loopCont[nLoop] := 0; loopContAdr[nLoop] := top;
  Expression(x);
  JumpFalse(x, loopBreak[nLoop]);
  Expect(sDo);
  Statement;
  BrlTo(top);
  FixChain(loopBreak[nLoop], pc);
  nLoop := nLoop - 1;
end;

procedure RepeatStat;
var x: TItem;
    top: longint;
begin
  Next;
  top := pc;
  nLoop := nLoop + 1;
  if nLoop > MaxLoop then Error('loops nested too deeply');
  loopBreak[nLoop] := 0; loopCont[nLoop] := 0; loopContAdr[nLoop] := -1;
  StatSeq;
  Expect(sUntil);
  FixChain(loopCont[nLoop], pc);
  Expression(x);
  JumpFalseTo(x, top);
  FixChain(loopBreak[nLoop], pc);
  nLoop := nLoop - 1;
end;

procedure LoadVarSigned(var v: TItem; sg: boolean);
var x: TItem;
begin
  x := v;
  Load(x);
  if sg then Op16($49, $8000);
end;

procedure ForStat;
var v, x, lim: TItem;
    s: integer;
    down, sg: boolean;
    top, cont: longint;
    sz, f3: integer;
begin
  Next;
  VarDesignator(v);
  if not (v.mode in [mGlob, mLoc]) then Error('the loop variable must be a simple variable');
  if not IsOrd(v.typ) or not rv and (types[v.typ].size = 4) then Error('loop variable must be a 8 or 16 bit ordinal');
  sg := types[v.typ].sgn;
  sz := types[v.typ].size;
  Expect(sBecomes);
  Expression(x);
  LoadAs(x, v.typ);
  lim := v;
  Store(lim);
  down := sym = sDownto;
  if (sym <> sTo) and (sym <> sDownto) then Error('TO expected');
  Next;
  Expression(lim);
  LoadAs(lim, v.typ);
  if rv then RPush(rA0)
  else begin
    if sg then Op16($49, $8000);
    Gen($48);                             { the limit stays on the stack }
  end;
  if sg then f3 := 5 else f3 := 7;        { SCHUB: bge / bgeu }
  ReleaseTmp(false, false);
  Expect(sDo);
  nLoop := nLoop + 1;
  if nLoop > MaxLoop then Error('loops nested too deeply');
  loopBreak[nLoop] := 0; loopCont[nLoop] := 0; loopContAdr[nLoop] := -1;
  { first test }
  if rv then begin
    x := v; Load(x); RLd(4, false, rA1, rSp, 0);
    if down then RB(f3, rA0, rA1, 8) else RB(f3, rA1, rA0, 8);
  end else begin
    LoadVarSigned(v, sg);
    Op8($C3, 1);                          { cmp 1,s }
    if down then CondTrue(cGe, 3) else CondTrue(cLe, 3);
  end;
  BrlFwd(loopBreak[nLoop]);
  top := pc;
  Statement;
  FixChain(loopCont[nLoop], pc);
  if rv then begin
    x := v; Load(x); RLd(4, false, rA1, rSp, 0); RB(1, rA0, rA1, 8);
  end else begin
    LoadVarSigned(v, sg);
    Op8($C3, 1);
    Op8($D0, 3);
  end;
  BrlFwd(loopBreak[nLoop]);
  x := v;
  Load(x);
  if rv then begin if down then RAddi(rA0, rA0, -1) else RAddi(rA0, rA0, 1); end
  else if down then Gen($3A) else Gen($1A);
  x := v;
  Store(x);
  BrlTo(top);
  FixChain(loopBreak[nLoop], pc);
  DropSlot;                               { drop the limit }
  nLoop := nLoop - 1;
end;

procedure CaseStat;
var x: TItem;
    sg: boolean;
    lo, hi: longint;
    arm, nxt, fEnd: longint;
begin
  Next;
  Expression(x);
  if not IsOrd(x.typ) or not rv and (types[x.typ].size = 4) then Error('8 or 16 bit ordinal expected in CASE');
  sg := types[x.typ].sgn;
  LoadBool(x);
  if x.mode <> mReg then Load(x);
  if rv then RPush(rA0)
  else begin
    if sg then Op16($49, $8000);
    Gen($48);
  end;
  ReleaseTmp(false, false);
  Expect(sOf);
  fEnd := 0;
  while (sym <> sEnd) and (sym <> sElse) do begin
    arm := 0;
    repeat
      lo := ConstExpr; hi := lo;
      if sym = sDotdot then begin Next; hi := ConstExpr; end;
      if rv then begin
        RLd(4, false, rA0, rSp, 0); RLi(rA1, lo);
        if lo = hi then begin RB(1, rA0, rA1, 8); BrlFwd(arm); end
        else begin
          RLi(rA2, hi);
          if sg then begin RB(4, rA0, rA1, 12); RB(4, rA2, rA0, 8); end
          else begin RB(6, rA0, rA1, 12); RB(6, rA2, rA0, 8); end;
          BrlFwd(arm);
        end;
      end else begin
      if sg then begin lo := (lo xor $8000) and $FFFF; hi := (hi xor $8000) and $FFFF; end
      else begin lo := lo and $FFFF; hi := hi and $FFFF; end;
      Op8($A3, 1);
      if lo = hi then begin Op16($C9, lo); Op8($D0, 3); BrlFwd(arm); end
      else begin
        Op16($C9, lo);
        if hi < $FFFF then begin Op8($90, 8); Op16($C9, hi + 1); Op8($B0, 3); BrlFwd(arm); end
        else begin Op8($90, 3); BrlFwd(arm); end;
      end;
      end;
      if sym = sComma then Next else break;
    until false;
    Expect(sColon);
    nxt := 0; BrlFwd(nxt);
    FixChain(arm, pc);
    DropSlot;
    Statement;
    BrlFwd(fEnd);
    FixChain(nxt, pc);
    if sym = sSemi then Next else break;
  end;
  DropSlot;
  if sym = sElse then begin
    Next;
    StatSeq;
  end;
  Expect(sEnd);
  FixChain(fEnd, pc);
end;

procedure WithStat;
var x: TItem;
    n0, slots, i: integer;
begin
  Next;
  n0 := nWith;
  repeat
    VarDesignator(x);
    if types[x.typ].form <> fRec then Error('record expected after WITH');
    if nWith >= 8 then Error('WITH nested too deeply');
    nWith := nWith + 1;
    withTyp[nWith] := x.typ;
    if x.mode in [mGlob, mLoc] then begin
      withMode[nWith] := x.mode; withA[nWith] := x.a;
    end else begin
      { the record's address goes into one of the frame's WITH slots }
      slots := 0;
      for i := 1 to nWith - 1 do if withMode[i] = mInd then slots := slots + 1;
      if slots >= 4 then Error('WITH of computed records nested too deeply');
      if ctxWith[curLev] < 0 then Error('internal: no WITH slots');
      LoadAdr(x);
      if rv then begin
        RSt(4, rA0, rS0, ctxWith[curLev] + 4 * slots);
        withA[nWith] := ctxWith[curLev] + 4 * slots;
      end else begin
        Op8($85, ctxWith[curLev] + 2 * slots);
        withA[nWith] := ctxWith[curLev] + 2 * slots;
      end;
      withMode[nWith] := mInd;
    end;
    if sym = sComma then Next else break;
  until false;
  ReleaseTmp(false, false);
  Expect(sDo);
  Statement;
  nWith := n0;
end;

procedure Statement;
var x: TItem;
    s: integer;
    n: TName;
begin
  nTmp := 0;
  case sym of
    sBegin: begin Next; StatSeq; Expect(sEnd); end;
    sIf: IfStat;
    sWhile: WhileStat;
    sRepeat: RepeatStat;
    sFor: ForStat;
    sCase: CaseStat;
    sWith: WithStat;
    sGoto: Error('GOTO is not supported');
    sIdent: begin
      n := id;
      if WithField(x) then Assignment(x)
      else if (n = 'write') or (n = 'writeln') then begin Next; StdWrite(n = 'writeln'); end
      else if (n = 'include') or (n = 'exclude') then begin
        Next; Expect(sLparen);
        VarDesignator(x);
        if types[x.typ].form <> fSet then Error('set variable expected');
        LoadAdr(x); PushA(2);
        Expect(sComma);
        Expression(x);
        if not IsOrd(x.typ) then Error('ordinal value expected');
        LoadBool(x); PushA(2);
        if n = 'include' then LibCallPop('_setincl') else LibCallPop('_setexcl');
        Expect(sRparen);
      end
      else if (n = 'read') or (n = 'readln') then begin Next; StdRead(n = 'readln'); end
      else if (n = 'inc') or (n = 'dec') then begin Next; StdIncDec(n = 'dec'); end
      else if (n = 'new') or (n = 'dispose') then begin Next; StdNewDispose(n = 'new'); end
      else if n = 'str' then begin Next; StdStr; end
      else if n = 'exit' then begin
        Next;
        if curLev = 0 then Error('EXIT outside a procedure');
        BrlFwd(ctxExit[curLev]);
      end else if (n = 'break') or (n = 'continue') then begin
        Next;
        if nLoop = 0 then Error(n + ' outside a loop');
        if n = 'break' then BrlFwd(loopBreak[nLoop])
        else if loopContAdr[nLoop] >= 0 then BrlTo(loopContAdr[nLoop])
        else BrlFwd(loopCont[nLoop]);
      end else if n = 'halt' then begin
        Next;
        if sym = sLparen then begin Next; Expression(x); Load(x); Expect(sRparen); end else LdaImm(0);
        PushA(2); CallLib('_halt');
      end else if (n = 'mem') or (n = 'memw') or (n = 'meml') then begin
        Next;
        if n = 'mem' then MemDesignator(x, 1) else if n = 'memw' then MemDesignator(x, 2) else MemDesignator(x, 4);
        Assignment(x);
      end else begin
        s := Find(n);
        if s = 0 then Error('unknown identifier ' + n);
        Next;
        case syms[s].kind of
          skVar: begin Designator(x, s); Assignment(x); end;
          skProc: begin
            if (sym = sBecomes) and (s = ctxProc[curLev]) then begin
              { function result }
              if syms[s].flags and 1 <> 0 then begin
                LdaDp(ParDp(curLev, syms[s].hid));
                x.mode := mInd; x.a := 0; x.typ := ResultType(s);
              end else begin
                x.mode := mLoc; x.a := ctxRes[curLev]; x.typ := syms[s].typ;
              end;
              Assignment(x);
            end else begin
              CallProc(s, x);
            end;
          end;
        else
          Error('statement expected');
        end;
      end;
    end;
  end;
  ReleaseTmp(false, false);
end;

{ ================================================================ declarations }
procedure TypeDef(var t: integer); forward;

{ the fields of a record, with a variant part (fields of the variants overlap) }
procedure FieldList(t: integer; var off: longint; var prev: integer);
var ids: array[1..16] of TName;
    nid, i, f, ft, tt: integer;
    start, o, maxo, dummy: longint;
    n: TName;
begin
  while sym = sIdent do begin
    nid := 0;
    repeat
      if sym <> sIdent then Error('field name expected');
      if nid >= 16 then Error('too many names');
      nid := nid + 1; ids[nid] := id; Next;
      if sym = sComma then Next else break;
    until false;
    Expect(sColon);
    TypeDef(ft);
    for i := 1 to nid do begin
      f := NewSym(ids[i], skField, ft);
      if rv then begin
        off := (off + AlignOf(ft) - 1) div AlignOf(ft) * AlignOf(ft);
        if AlignOf(ft) > types[t].al then types[t].al := AlignOf(ft);
      end;
      syms[f].adr := off;
      off := off + types[ft].size;
      if prev = 0 then types[t].fields := f else syms[prev].next := f;
      prev := f;
    end;
    if sym = sSemi then Next else break;
  end;
  if sym = sCase then begin
    Next;
    if sym <> sIdent then Error('tag field or type expected');
    n := id; Next;
    if sym = sColon then begin
      Next; TypeDef(tt);
      f := NewSym(n, skField, tt);
      if rv then begin
        off := (off + AlignOf(tt) - 1) div AlignOf(tt) * AlignOf(tt);
        if AlignOf(tt) > types[t].al then types[t].al := AlignOf(tt);
      end;
      syms[f].adr := off;
      off := off + types[tt].size;
      if prev = 0 then types[t].fields := f else syms[prev].next := f;
      prev := f;
    end;
    Expect(sOf);
    start := off; maxo := off;
    while (sym <> sEnd) and (sym <> sRparen) and (sym <> sEOF) do begin
      repeat
        dummy := ConstExpr;
        if sym = sDotdot then begin Next; dummy := ConstExpr; end;
        if sym = sComma then Next else break;
      until false;
      Expect(sColon); Expect(sLparen);
      o := start;
      FieldList(t, o, prev);
      Expect(sRparen);
      if o > maxo then maxo := o;
      if sym = sSemi then Next else break;
    end;
    off := maxo;
  end;
end;

procedure TypeDef(var t: integer);
var s, f, prev, k: integer;
    lo, hi: longint;
    bLo, bHi: array[1..4] of longint;
    off: longint;
    ids: array[1..16] of TName;
    nid, i, ft: integer;
    pt: integer;
begin
  case sym of
    sPacked: begin Next; TypeDef(t); end;
    sStringKw: begin
      Next;
      if sym = sLbrak then begin
        Next; lo := ConstExpr; Expect(sRbrak);
        if (lo < 1) or (lo > 255) then Error('string length 1..255');
        t := NewType(fStr, lo + 1); types[t].hi := lo;
      end else t := tString;
    end;
    sCaret: begin
      Next;
      if sym <> sIdent then Error('type expected after ^');
      t := NewType(fPtr, PtrSz);
      s := Find(id);
      if (s <> 0) and (syms[s].kind = skType) then types[t].base := syms[s].typ
      else begin
        if nPend >= 16 then Error('too many forward pointers');
        nPend := nPend + 1; pendPtr[nPend] := t; pendName[nPend] := id;
      end;
      Next;
    end;
    sArray: begin
      Next; Expect(sLbrak);
      k := 0;
      repeat
        k := k + 1;
        if k > 4 then Error('at most 4 dimensions');
        if sym = sIdent then begin
          s := Find(id);
          if (s <> 0) and (syms[s].kind = skType) and IsOrd(syms[s].typ) then begin
            Next; lo := types[syms[s].typ].lo; hi := types[syms[s].typ].hi;
            if syms[s].typ = tChar then begin lo := 0; hi := 255; end;
          end else begin lo := ConstExpr; Expect(sDotdot); hi := ConstExpr; end;
        end else begin lo := ConstExpr; Expect(sDotdot); hi := ConstExpr; end;
        if hi < lo then Error('bad array bounds');
        bLo[k] := lo; bHi[k] := hi;
        if sym = sComma then Next else break;
      until false;
      Expect(sRbrak); Expect(sOf);
      TypeDef(ft);
      for i := k downto 1 do begin
        lo := bLo[i]; hi := bHi[i];
        t := NewType(fArr, 0);
        if rv then begin if (hi - lo + 1) * types[ft].size > 65535 then Error('array larger than 64 KB'); end
        else if (hi - lo + 1) * types[ft].size > 40000 then Error('array too large');
        types[t].size := (hi - lo + 1) * types[ft].size;
        types[t].lo := lo; types[t].hi := hi; types[t].base := ft;
        ft := t;
      end;
    end;
    sRecord: begin
      Next;
      t := NewType(fRec, 0);
      off := 0; prev := 0;
      FieldList(t, off, prev);
      Expect(sEnd);
      if rv then off := (off + types[t].al - 1) div types[t].al * types[t].al;
      types[t].size := off;
    end;
    sLparen: begin
      Next;
      t := NewType(fEnum, 1);
      k := 0;
      repeat
        if sym <> sIdent then Error('name expected');
        s := NewSym(id, skConst, t); syms[s].adr := k; k := k + 1;
        Next;
        if sym = sComma then Next else break;
      until false;
      Expect(sRparen);
      types[t].lo := 0; types[t].hi := k - 1;
    end;
    sSet: begin
      Next; Expect(sOf);
      TypeDef(ft);
      if not IsOrd(ft) then Error('set of an ordinal type expected');
      t := NewType(fSet, 32);
      types[t].base := ft;
    end;
    sFile: Error('file types are not supported; use the Dos unit');
  else
    if sym = sIdent then begin
      s := Find(id);
      if (s <> 0) and (syms[s].kind = skType) then begin t := syms[s].typ; Next; exit; end;
    end;
    { subrange }
    lo := ConstExpr; Expect(sDotdot); hi := ConstExpr;
    if (lo >= 0) and (hi <= 255) then t := NewType(fInt, 1)
    else if (lo >= -128) and (hi <= 127) then begin t := NewType(fInt, 1); types[t].sgn := true; end
    else if (lo >= -32768) and (hi <= 32767) then begin t := NewType(fInt, 2); types[t].sgn := true; end
    else if (lo >= 0) and (hi <= 65535) then t := NewType(fInt, 2)
    else begin t := NewType(fInt, 4); types[t].sgn := true; end;
    types[t].lo := lo; types[t].hi := hi;
  end;
end;

procedure TypeSection;
var s, t, i, k: integer;
    n: TName;
begin
  Next;
  nPend := 0;
  while sym = sIdent do begin
    n := id; Next;
    Expect(sEql);
    TypeDef(t);
    s := NewSym(n, skType, t);
    Expect(sSemi);
  end;
  for i := 1 to nPend do begin
    k := Find(pendName[i]);
    if (k = 0) or (syms[k].kind <> skType) then Error('unknown type ' + pendName[i]);
    types[pendPtr[i]].base := syms[k].typ;
  end;
  nPend := 0;
end;

procedure ConstSection;
var s, t, i: integer;
    n: TName;
    x: TItem;
    a: longint;
procedure InitValue(t: integer; a: longint);
var x: TItem;
    i: longint;
    k: integer;
begin
  if types[t].form = fArr then begin
    Expect(sLparen);
    for i := types[t].lo to types[t].hi do begin
      InitValue(types[t].base, a + (i - types[t].lo) * types[types[t].base].size);
      if i < types[t].hi then Expect(sComma);
    end;
    Expect(sRparen);
    exit;
  end;
  if types[t].form = fStr then begin
    if sym <> sString then Error('string expected');
    if length(str) > types[t].hi then Error('string too long');
    Mem[DataImg + a - dataOrg] := length(str);
    for k := 1 to length(str) do Mem[DataImg + a - dataOrg + k] := ord(str[k]);
    Next;
    exit;
  end;
  if types[t].form in [fRec] then Error('record constants are not supported');
  Expression(x);
  if x.mode <> mConst then Error('constant expected');
  for k := 0 to types[t].size - 1 do Mem[DataImg + a - dataOrg + k] := (x.a shr (8 * k)) and 255;
end;
begin
  Next;
  while sym = sIdent do begin
    n := id; Next;
    if sym = sColon then begin
      Next;
      TypeDef(t);
      Expect(sEql);
      a := AllocData(types[t].size);
      InitValue(t, a);
      s := NewSym(n, skVar, t); syms[s].adr := a; syms[s].lev := 0;
    end else begin
      Expect(sEql);
      if sym = sString then begin
        if length(str) = 1 then begin s := NewSym(n, skConst, tChar); syms[s].adr := ord(str[1]); end
        else begin s := NewSym(n, skConst, tString); syms[s].adr := StrLiteral(str); end;
        Next;
      end else begin
        Expression(x);
        if x.mode <> mConst then Error('constant expected');
        s := NewSym(n, skConst, x.typ); syms[s].adr := x.a;
      end;
    end;
    Expect(sSemi);
  end;
end;

procedure VarSection;
var ids: array[1..16] of TName;
    n, i, s, t, v: integer;
    a: longint;
begin
  Next;
  while sym = sIdent do begin
    n := 0;
    repeat
      if sym <> sIdent then Error('name expected');
      n := n + 1; if n > 16 then Error('too many names');
      ids[n] := id; Next;
      if sym = sComma then Next else break;
    until false;
    Expect(sColon);
    TypeDef(t);
    if (sym = sIdent) and (id = 'absolute') then begin
      Next;
      if n <> 1 then Error('ABSOLUTE is for one variable at a time');
      if sym = sIdent then begin
        v := Find(id);
        if (v = 0) or (syms[v].kind <> skVar) then Error('variable expected after ABSOLUTE');
        Next;
        if (syms[v].lev > 0) and not syms[v].isPar and (types[syms[v].typ].size > 8) and not defPlaced[syms[v].lev] then
          Error('ABSOLUTE over a large local variable is not supported');
        s := NewSym(ids[1], skVar, t);
        syms[s].lev := syms[v].lev; syms[s].adr := syms[v].adr;
        syms[s].isPar := syms[v].isPar; syms[s].isRef := syms[v].isRef;
        syms[s].flags := syms[v].flags and 32;
      end else begin
        a := ConstExpr;
        s := NewSym(ids[1], skVar, t);
        syms[s].lev := 0; syms[s].adr := a;
        if rv or (a < 0) or (a > $FFFF) then begin
          if types[t].form in [fStr, fArr, fSet] then Error('ABSOLUTE outside bank 0 is for simple variables and records');
          syms[s].flags := 32;     { far: reached with long addressing }
        end;
      end;
    end else
      for i := 1 to n do begin
        s := NewSym(ids[i], skVar, t);
        if curLev = 0 then syms[s].adr := AllocData(types[t].size)
        else LocalVar(s);
      end;
    Expect(sSemi);
  end;
end;

procedure Block; forward;

procedure ProcDecl;
var isFunc: boolean;
    n: TName;
    s, p, prev, k, rt, mark, lv, q, i: integer;
    off: integer;
    parIds: array[1..16] of TName;
    np, mode, pt: integer;
    entry: longint;
    rsz: integer;
begin
  isFunc := sym = sFunction;
  Next;
  if sym <> sIdent then Error('name expected');
  n := id; Next;
  { existing forward declaration? }
  s := 0;
  for i := nSym downto 1 do
    if (syms[i].kind = skProc) and (syms[i].name = n) and (syms[i].lev = curLev + 1) and (syms[i].flags and 6 = 0) then s := i;
  if s <> 0 then begin
    { skip a repeated parameter list }
    if sym = sLparen then while (sym <> sRparen) and (sym <> sEOF) do Next;
    if sym = sRparen then Next;
    if sym = sColon then begin Next; Next; end;
    Expect(sSemi);
  end else begin
    s := NewSym(n, skProc, 0);
    syms[s].lev := curLev + 1;
    syms[s].adr := 0;
    prev := 0;
    if sym = sLparen then begin
      Next;
      if sym <> sRparen then
        repeat
          mode := 0;
          if sym = sVar then begin mode := 1; Next; end
          else if sym = sConst then begin mode := 2; Next; end;
          np := 0;
          repeat
            if sym <> sIdent then Error('parameter name expected');
            np := np + 1; parIds[np] := id; Next;
            if sym = sComma then Next else break;
          until false;
          if sym = sColon then begin Next; ParseTypeIdent(pt); end
          else begin if mode = 0 then Error('parameter type expected'); pt := tUntyped; end;
          for i := 1 to np do begin
            p := NewSym(parIds[i], skPar, pt);
            syms[p].isRef := (mode = 1) or IsStruct(pt) or (pt = tUntyped);
            if mode = 1 then syms[p].flags := 1;
            if mode = 2 then syms[p].flags := 2;
            if prev = 0 then syms[s].first := p else syms[prev].next := p;
            prev := p;
            syms[s].npar := syms[s].npar + 1;
          end;
          if sym = sSemi then Next else break;
        until false;
      Expect(sRparen);
    end;
    if isFunc then begin
      Expect(sColon); ParseTypeIdent(rt);
      if (types[rt].form in [fArr, fRec, fSet]) and (types[rt].size > 256) then
        Error('function results are at most 256 bytes');
      syms[s].typ := rt;
      if types[rt].form in [fStr, fArr, fRec, fSet] then syms[s].flags := 1;
    end;
    Expect(sSemi);
    { parameter offsets: the last argument is nearest to the frame }
    off := 0;
    if syms[s].lev >= 2 then if rv then off := 4 else off := 2;
    k := syms[s].npar;
    while k > 0 do begin
      p := syms[s].first;
      for i := 2 to k do p := syms[p].next;
      syms[p].adr := off;
      if rv or not syms[p].isRef and (types[syms[p].typ].size > 2) then off := off + 4 else off := off + 2;
      k := k - 1;
    end;
    if syms[s].flags and 1 <> 0 then begin
      syms[s].hid := off;
      if rv then off := off + 4 else off := off + 2;
    end;
    syms[s].parsz := off;
    if inInterface then exit;              { the body follows in the implementation }
    if (sym = sIdent) and (id = 'forward') then begin Next; Expect(sSemi); exit; end;
  end;
  if (sym = sIdent) and (id = 'forward') then Error('already declared');
  { body }
  if curLev >= MaxLev - 1 then Error('procedures nested too deeply');
  if curLev > 0 then PlaceLocals;      { nested procedures address our frame through ctxFS }
  lv := curLev;
  curLev := syms[s].lev;
  ctxLoc[curLev] := 0;
  ctxFrozen[curLev] := false;
  defN[curLev] := 0;
  defPlaced[curLev] := false;
  ctxProc[curLev] := s;
  ctxExit[curLev] := 0;
  mark := nSym;
  { parameters as variables of the body }
  if isFunc then begin
    if syms[s].flags and 1 <> 0 then begin
      q := NewSym('result', skVar, ResultType(s));
      syms[q].isPar := true; syms[q].isRef := true; syms[q].adr := syms[s].hid;
    end else begin
      rsz := types[syms[s].typ].size;
      k := AllocLocal(rsz);
      ctxRes[curLev] := LocDp(k);
      q := NewSym('result', skVar, syms[s].typ);
      syms[q].adr := k;
    end;
  end;
  if hasWith then ctxWith[curLev] := LocDp(AllocLocal(WithSz)) else ctxWith[curLev] := -1;
  cpN[curLev] := 0;
  p := syms[s].first;
  while p <> 0 do begin
    q := NewSym(syms[p].name, skVar, syms[p].typ);
    if IsStruct(syms[p].typ) and (syms[p].flags = 0) then begin
      { value parameter: a local copy }
      if cpN[curLev] >= 8 then Error('too many structured value parameters');
      cpN[curLev] := cpN[curLev] + 1;
      LocalVar(q);
      cpSrc[curLev, cpN[curLev]] := syms[p].adr;
      cpSym[curLev, cpN[curLev]] := q;
      cpSize[curLev, cpN[curLev]] := types[syms[p].typ].size;
    end else begin
      syms[q].isPar := true;
      syms[q].isRef := syms[p].isRef;
      syms[q].adr := syms[p].adr;
    end;
    p := syms[p].next;
  end;
  Block;
  nSym := mark;
  curLev := lv;
  Expect(sSemi);
end;

{ declarations and the body of a procedure (or the program) }
procedure Block;
var entry, fs: longint;
    s, p, q: integer;
    x: TItem;
begin
  repeat
    case sym of
      sConst: ConstSection;
      sType: TypeSection;
      sVar: VarSection;
      sProcedure, sFunction: ProcDecl;
      sLabel: Error('labels are not supported');
    else
      break;
    end;
  until false;
  if sym <> sBegin then Error('BEGIN expected');
  { procedure entry }
  PlaceLocals;
  fs := ctxLoc[curLev];
  ctxFS[curLev] := fs;
  entry := pc;
  s := ctxProc[curLev];
  if s <> 0 then begin
    FixCalls(syms[s].adr, cBase + entry);
    syms[s].adr := cBase + entry;
    syms[s].flags := syms[s].flags or 2;
  end;
  if rv then begin
    RI($13, 0, rSp, rSp, -8); RSt(4, rRa, rSp, 4); RSt(4, rS0, rSp, 0);
    RAddi(rSp, rSp, -fs); RMv(rS0, rSp);
    if s <> 0 then
      for p := 1 to cpN[curLev] do begin
        RLd(4, false, rA1, rS0, fs + 8 + cpSrc[curLev, p]);
        RAddi(rA0, rS0, syms[cpSym[curLev, p]].adr);
        RLi(rA2, cpSize[curLev, p]);
        RCall(aMemmove);
      end;
    Next;
    StatSeq;
    Expect(sEnd);
    FixChain(ctxExit[curLev], pc);
    if (s <> 0) and (syms[s].typ <> 0) and (syms[s].flags and 1 = 0) then
      RLd(types[syms[s].typ].size, types[syms[s].typ].sgn, rA0, rS0, ctxRes[curLev]);
    RAddi(rSp, rS0, fs);
    RLd(4, false, rS0, rSp, 0); RLd(4, false, rRa, rSp, 4); RI($13, 0, rSp, rSp, 8);
    RRet;
    exit;
  end;
  Gen($0B); Gen($3B);                       { phd / tsc }
  if fs > 0 then begin Gen($38); Op16($E9, fs); Gen($1B); end;
  Gen($5B);                                  { tcd }
  { copy structured value parameters into the frame }
  if s <> 0 then
    for p := 1 to cpN[curLev] do begin
      LdaDp(fs + 6 + cpSrc[curLev, p]); Gen($AA);                 { lda param / tax }
      Gen($7B); Gen($18); Op16($69, 1 + syms[cpSym[curLev, p]].adr); Gen($A8); { tdc / clc / adc / tay }
      LdaImm(cpSize[curLev, p] - 1);
      Op8($54, 0); Gen(0);                                         { mvn 0,0 }
    end;
  Next;
  StatSeq;
  Expect(sEnd);
  FixChain(ctxExit[curLev], pc);
  { epilogue }
  if (s <> 0) and (syms[s].typ <> 0) and (syms[s].flags and 1 = 0) then begin
    if types[syms[s].typ].size = 4 then Op8($A6, ctxRes[curLev] + 2);
    Op8($A5, ctxRes[curLev]);
    if types[syms[s].typ].size = 1 then Op16($29, $FF);
    Gen($A8);
  end;
  if fs > 0 then begin Gen($7B); Gen($18); Op16($69, fs); Gen($1B); end;
  Gen($2B);                                  { pld }
  if (s <> 0) and (syms[s].typ <> 0) and (syms[s].flags and 1 = 0) then Gen($98);
  Gen($6B);                                  { rtl }
end;

{ ================================================================ program }
{ does the word WITH occur in the text? (WITH needs slots in every frame) }
function ScanWith(base, n: longint): boolean;
var p: longint;
    c: integer;
    prevId: boolean;
begin
  ScanWith := false;
  prevId := false;
  p := 0;
  while p + 4 <= n do begin
    c := Mem[base + p] or $20;
    if (c = ord('w')) and not prevId then
      if ((Mem[base + p + 1] or $20) = ord('i')) and ((Mem[base + p + 2] or $20) = ord('t')) and
         ((Mem[base + p + 3] or $20) = ord('h')) then begin
        if p + 4 = n then begin ScanWith := true; exit; end;
        c := Mem[base + p + 4] or $20;
        if not (((c >= ord('a')) and (c <= ord('z'))) or ((c >= ord('0')) and (c <= ord('9'))) or (c = ord('_'))) then begin
          ScanWith := true; exit;
        end;
      end;
    prevId := ((c >= ord('a')) and (c <= ord('z'))) or ((c >= ord('0')) and (c <= ord('9'))) or (c = ord('_'));
    p := p + 1;
  end;
end;

{ ---------------------------------------------------------------- units }
procedure Declarations;
begin
  repeat
    case sym of
      sConst: ConstSection;
      sType: TypeSection;
      sVar: VarSection;
      sProcedure, sFunction: ProcDecl;
      sLabel: Error('labels are not supported');
    else
      break;
    end;
  until false;
end;

procedure CheckForwards(from: integer);
var i: integer;
begin
  for i := from to nSym do
    if (syms[i].kind = skProc) and (syms[i].flags and 6 = 0) then Error('procedure not implemented: ' + syms[i].name);
end;

function BuiltinUnit(const n: TName): boolean;
begin
  BuiltinUnit := (n = 'system') or (n = 'crt') or (n = 'graph') or (n = 'sprites') or (n = 'audio') or
    (n = 'input') or (n = 'dos') or (n = 'blitter') or (n = 'copper') or (n = 'schub') or (n = 'basic');
end;

procedure CompileUnit(const n: TName); forward;

{ USES a, b, c;  (sym = sUses) - units of your own are compiled right here }
procedure UsesClause;
var names: array[1..8] of TName;
    k, i: integer;
    sPos, sEnd, sBase: longint;
    sLine, sCol: integer;
    sCh: char;
begin
  k := 0;
  repeat
    Next;
    if sym <> sIdent then Error('unit name expected');
    if k >= 8 then Error('too many units');
    k := k + 1; names[k] := id;
    Next;
  until sym <> sComma;
  if sym <> sSemi then Error('; expected');
  sPos := srcPos; sEnd := srcEnd; sBase := curBase; sLine := line; sCol := col; sCh := ch;
  for i := 1 to k do
    if not BuiltinUnit(names[i]) then begin
      CompileUnit(names[i]);
      srcPos := sPos; srcEnd := sEnd; curBase := sBase; line := sLine; col := sCol; ch := sCh;
    end;
  Next;
end;

procedure CompileUnit(const n: TName);
var i, u, ifaceEnd, first: integer;
    fname, saveFile: string[12];
    got: longint;
    saveWith: boolean;
begin
  for i := 1 to nUnit do
    if unitName[i] = n then begin
      if unitDone[i] then exit;
      Error('units use each other in a circle: ' + n);
    end;
  if nUnit >= 12 then Error('too many units');
  nUnit := nUnit + 1; u := nUnit;
  unitName[u] := n; unitDone[u] := false;
  fname := UpperCase(Copy(n, 1, 8)) + '.PAS';
  if unitTop >= $2F0000 then Error('no room for unit ' + fname);
  got := LoadFile(fname, unitTop, $300000 - unitTop);
  if got < 0 then Error('unit not found: ' + fname + ' (' + DosErrorText(DosError) + ')');
  saveFile := curFile; saveWith := hasWith;
  curFile := fname;
  curBase := unitTop; srcPos := 0; srcEnd := got; line := 1; col := 0;
  unitTop := (unitTop + got + 255) and $FFFF00;
  hasWith := ScanWith(curBase, got);
  NextCh; Next;
  if (sym <> sIdent) or (id <> 'unit') then Error('UNIT expected');
  Next;
  if (sym <> sIdent) or (id <> n) then Error('the unit in ' + fname + ' must be called ' + n);
  Next; Expect(sSemi);
  if (sym <> sIdent) or (id <> 'interface') then Error('INTERFACE expected');
  Next;
  if sym = sUses then UsesClause;
  first := nSym + 1;
  inInterface := true;
  Declarations;
  inInterface := false;
  if (sym <> sIdent) or (id <> 'implementation') then Error('IMPLEMENTATION expected');
  ifaceEnd := nSym;
  Next;
  if sym = sUses then UsesClause;
  Declarations;
  CheckForwards(first);
  if (sym = sBegin) or ((sym = sIdent) and (id = 'initialization')) then begin
    if sym = sIdent then sym := sBegin;
    curLev := 1;
    ctxLoc[1] := 0; ctxFrozen[1] := false; ctxProc[1] := 0; ctxExit[1] := 0;
    if hasWith then ctxWith[1] := LocDp(AllocLocal(WithSz)) else ctxWith[1] := -1;
    defN[1] := 0; defPlaced[1] := false;
    nInit := nInit + 1;
    unitInit[nInit] := pc;
    Block;
    curLev := 0;
  end else Expect(sEnd);
  if sym <> sPeriod then Error('. expected at the end of the unit');
  { what the implementation declared is private to the unit }
  for i := ifaceEnd + 1 to nSym do
    if (syms[i].kind in [skConst, skVar, skType, skProc, skAsm]) and (syms[i].flags and (128 + 64) = 0) and
       (syms[i].lev <= 1) then syms[i].name := '';
  { its interface stays visible (also when another unit's implementation used it) }
  for i := first to ifaceEnd do
    if syms[i].kind in [skConst, skVar, skType, skProc, skAsm] then syms[i].flags := syms[i].flags or 64;
  hasWith := saveWith; curFile := saveFile;
  unitDone[u] := true;
end;

{ the text starts with $SCHUB: compile for the SCHUB co-processor }
function SchubDirective(n: longint): boolean;
var p: longint;
    i: integer;
    t: string[8];
begin
  SchubDirective := false;
  p := 0;
  while (p < n) and (Mem[SrcBase + p] <= 32) do p := p + 1;
  if p + 8 > n then exit;
  for i := 1 to 8 do t[i] := chr(Mem[SrcBase + p + i - 1]);
  t[0] := chr(8);
  SchubDirective := UpperCase(t) = '{$SCHUB}';
end;

function CompileSource(srcLen: longint): boolean;
var mainFix, lenAt, heapAt: longint;
    i: integer;
    x: TItem;
begin
  CompileSource := false;
  ErrMsg := ''; ErrUnit := ''; curFile := '';
  ErrLine := 0; ErrCol := 0;
  nUnit := 0; nInit := 0; unitTop := $220000; inInterface := false;
  if not CartPresent then begin ErrMsg := 'PASCAL cartridge directory missing'; exit; end;
  if CatchError <> 0 then exit;
  rv := WantSchub or SchubDirective(srcLen);
  IsSchub := rv;
  if rv then begin cBase := RvCode; RunEntry := RvStub; end
  else begin cBase := CodeBase; RunEntry := CodeBase; end;
  curBase := SrcBase; srcPos := 0; srcEnd := srcLen; line := 1; col := 0;
  tokLine := 1; tokCol := 1;
  pc := 0; dataTop := 0; nLoop := 0; nTmp := 0; nPend := 0; nWith := 0;
  hasWith := ScanWith(SrcBase, srcLen);
  for i := 0 to 63 do impType[i] := 0;
  InitKeywords;
  InitTypes;
  curLev := 0;
  InitStdSyms;
  InitRuntime;
  if rv then dataOrg := RvData else dataOrg := UserData;
  ctxLoc[0] := 0; ctxFrozen[0] := false; ctxProc[0] := 0; ctxExit[0] := 0; ctxFS[0] := 0;
  { entry code }
  if rv then begin
    { called by the library after its unit inits }
    RPush(rRa);
    RLi(rS1, RvTmpTop);
    W32(0); W32(0); mainFix := pc - 8;      { call main (patched) }
    RPop(rRa);
    RRet;
  end else begin
  Gen($8B); Gen($0B); Gen($08);              { phb phd php }
  Op8($C2, $30);                             { rep #$30 }
  Gen($3B); StaAbs(aSavesp);                 { tsc / sta rt_savesp }
  LdaImm(UserStack); Gen($1B);               { lda #stack / tcs }
  LdaImm(0); Gen($5B);                       { tcd }
  Gen($8B);                                  { phb }
  LdxImm(0); LdaImm(UserData); Gen($A8);     { ldx #0 / ldy #UserData }
  Gen($A9); lenAt := pc; Gen16(0);           { lda #len-1 (patched) }
  Op8($54, $00); Gen($32);                   { mvn #$32,#$00 }
  Gen($AB);                                  { plb }
  Gen($A9); heapAt := pc; Gen16(0);          { lda #heap (patched) }
  StaAbs(aHeapbase);
  LdaImm(StrStackTop); StaAbs(aStp);
  Jsl(aLibinit);
  Gen($22); mainFix := pc; Gen24(0);         { jsl main (patched) }
  Op24($5C, aExit);                          { jml rt_exit }
  end;
  { program text }
  NextCh;
  Next;
  if sym = sProgram then begin
    Next;
    if sym <> sIdent then Error('program name expected');
    Next;
    if sym = sLparen then begin while (sym <> sRparen) and (sym <> sEOF) do Next; Next; end;
    Expect(sSemi);
  end;
  x.a := AllocData(2);      { the data image is never empty }
  if sym = sUses then UsesClause;
  curLev := 0;
  ctxProc[1] := 0;
  { the main program block: globals at level 0, its body at level 1 }
  Declarations;
  if sym <> sBegin then Error('BEGIN expected');
  CheckForwards(1);
  curLev := 1;
  ctxLoc[1] := 0; ctxFrozen[1] := false; ctxProc[1] := 0; ctxExit[1] := 0;
  if hasWith then ctxWith[1] := LocDp(AllocLocal(WithSz)) else ctxWith[1] := -1;
  defN[1] := 0; defPlaced[1] := false;
  if rv then begin
    Put32(mainFix, LuiEnc(rT0, cBase + pc)); Put32(mainFix + 4, IEnc($67, 0, rRa, rT0, cBase + pc));
  end else begin
    Put16(mainFix, pc); Mem[cBase + mainFix + 2] := $30;
  end;
  if rv and (nInit > 0) then RPush(rRa);
  for i := 1 to nInit do Jsl(cBase + unitInit[i]);   { unit initialisation, then the body }
  if rv and (nInit > 0) then RPop(rRa);
  Block;
  if sym <> sPeriod then Error('. expected at the end of the program');
  if not rv then begin
    Put16(lenAt, dataTop - 1);
    Put16(heapAt, UserData + dataTop);
  end;
  CodeSize := pc;
  DataSize := dataTop;
  LinesDone := line;
  CompileSource := true;
end;

{ ---------------------------------------------------------------- standalone .MER }
function SaveStandalone(const name: string): boolean;
const Img = $220000;
var stub, libCode, dataRom, len, a: longint;
    stubLen, i: integer;
    nPiece: integer;

  procedure CopyIn(src, n: longint);
  begin
    CopyMem(src, Img + len, n);
  end;

  procedure Piece(src, dst, n: longint);
  begin
    a := Img + 4 + nPiece * 12;
    MemL[a] := src; MemL[a + 4] := dst; MemL[a + 8] := n;
    nPiece := nPiece + 1;
  end;

  function AddBlock(src, n: longint): longint;
  begin
    AddBlock := Img + len;
    CopyIn(src, n);
    len := len + n;
  end;

var libAt, dataAt, codeAt, imgAt, hostAt, heapAt, libLen, hostLen: longint;
begin
  SaveStandalone := false;
  ErrMsg := '';
  if not CartPresent then begin ErrMsg := 'PASCAL cartridge directory missing'; exit; end;
  if CodeSize = 0 then begin ErrMsg := 'compile the program first'; exit; end;
  libCode := Far24($40003B);
  dataRom := Far24($40003E);
  stub := Far24($400041);
  stubLen := Mem[$400044] or (Mem[$400045] shl 8);
  UserData := Mem[$400030] or (Mem[$400031] shl 8);
  len := 0;
  a := AddBlock(stub, stubLen);
  if IsSchub then begin
    { SCHUB: library, host stub, code, variables, heap start; no library check }
    libLen := Far24($400058);
    hostLen := Mem[$40005E] or (Mem[$40005F] shl 8);
    libAt := AddBlock(Far24($400055), libLen);
    hostAt := AddBlock(Far24($40005B), hostLen);
    codeAt := AddBlock(RvCode, CodeSize);
    imgAt := AddBlock(DataImg, DataSize);
    heapAt := Img + len;
    MemL[heapAt] := (RvData + DataSize + 7) and not longint(7);
    len := len + 4;
    nPiece := 0;
    Piece(libAt, RvLib, libLen);
    Piece(hostAt, RvStub, hostLen);
    Piece(codeAt, RvCode, CodeSize);
    Piece(imgAt, RvData, DataSize);
    Piece(heapAt, RvHeapVar, 4);
    MemL[Img + 64] := 0;
    MemL[Img + 68] := RvStub;
  end else begin
  libAt := AddBlock($400000, libCode - $400000);
  dataAt := AddBlock(dataRom, UserData - $2000);
  codeAt := AddBlock(CodeBase, CodeSize);
  imgAt := AddBlock(DataImg, DataSize);
  nPiece := 0;
  Piece(libAt, $400000, libCode - $400000);
  Piece(dataAt, dataRom, UserData - $2000);
  Piece(codeAt, CodeBase, CodeSize);
  Piece(imgAt, DataImg, DataSize);
  Piece(dataAt, $2000, UserData - $2000);
  for i := 0 to 3 do Mem[Img + 64 + i] := Mem[$400046 + i];
  MemL[Img + 68] := CodeBase;
  end;
  if not SaveMer(name, Img, len) then begin
    ErrMsg := 'save failed: ' + DosErrorText(DosError);
    exit;
  end;
  MerSize := len;
  SaveStandalone := true;
end;

{ ---------------------------------------------------------------- SCHUB run }
procedure PrepareRun;
begin
  if not IsSchub then exit;
  CopyMem(Far24($40005B), RvStub, Mem[$40005E] or (Mem[$40005F] shl 8));
  CopyMem(Far24($400055), RvLib, Far24($400058));
  CopyMem(DataImg, RvData, DataSize);
  MemL[RvHeapVar] := (RvData + DataSize + 7) and not longint(7);
end;

end.
