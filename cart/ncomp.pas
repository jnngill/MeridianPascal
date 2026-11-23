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
  { F5 builds: every statement writes its line to DbgLineAdr (16 bits: the
    unit in bits 12-15, 0 = the program, the line in bits 0-11), the end of
    the program $FFFF; so the editor can tell where a runtime error was }
  DebugLines: boolean;
  { with breakpoints or stepping: every statement that stores its line also
    calls the debugger hook (rt_dbghook, see compiler/cart.js) }
  DebugHooks: boolean;

const
  DbgLineAdr = $3D7F00;

function CartPresent: boolean;
function CompileSource(srcLen: longint): boolean;
{ the text (srcLen bytes at SrcBase) starts with $SCHUB: compiled for SCHUB }
function SchubDirective(n: longint): boolean;
{ after a successful CompileSource: save the program as a .MER that runs
  without the cartridge (it carries the library and a loader) }
function SaveStandalone(const name: string): boolean;
{ before RunUser(RunEntry): put a SCHUB program's library and data in place }
procedure PrepareRun;
{ the file of unit u (as DebugLines numbers them) }
function DebugUnitName(u: integer): string;
{ the value of a global variable of the program compiled last, as text:
  name, name.field, name[n] (a 65C816 program's bank 0 is in bank $34 while
  it is stopped) }
function DebugValue(const name: string): string;

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
  aRtError, aMemmove, aDbgHook: longint;
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
  { directives: defined names, open IFDEFs, open include files }
  nDef, condDepth, incDepth: integer;
  swR, swQ, swI, swD: boolean;         { the switches R+ Q+ I+ D+ }
  lastDbg: longint;                    { DebugLines: the last line stored }
  { labels: their table in expansion RAM; the slots FOR loops keep on the
    stack (a goto out of a loop drops them) }
  nLab, labStart, nFix, stkSlots, preLabels: integer;
  skipHidden: boolean;                 { PushArg pushed an open array's hidden index too }
  openHi: integer;                     { Selector: the hidden index of the open array indexed }
  curUnit: integer;                    { 0: the program, else the unit being compiled }
  msgsBuilt: boolean;

const
  MsgBase = $3D1000;         { error messages, 64 bytes each (up to $3D:4FFF) }

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

{ the error messages, 4 characters a number (string literals would take
  room in bank 0); written by a script. Message n starts at MsgBase + n * 64:
  its length, then the characters }
procedure BuildMessages;
begin
  MemL[MsgBase + 64] := 1869575184;
  MemL[MsgBase + 68] := 1851878688;
  MemL[MsgBase + 72] := 1701060729;
  MemL[MsgBase + 76] := 1701734758;
  MemL[MsgBase + 80] := 115;
  { too many defines }
  MemL[MsgBase + 128] := 1160018704;
  MemL[MsgBase + 132] := 1179206734;
  MemL[MsgBase + 136] := 1768759421;
  MemL[MsgBase + 140] := 1852404595;
  MemL[MsgBase + 144] := 103;
  { $ENDIF missing }
  MemL[MsgBase + 192] := 1668180253;
  MemL[MsgBase + 196] := 1701082476;
  MemL[MsgBase + 200] := 1818846752;
  MemL[MsgBase + 204] := 1847620453;
  MemL[MsgBase + 208] := 1702130533;
  MemL[MsgBase + 212] := 1869881444;
  MemL[MsgBase + 216] := 1701060719;
  MemL[MsgBase + 220] := 28773;
  { include files nested too deep }
  MemL[MsgBase + 256] := 544173580;
  MemL[MsgBase + 260] := 1836019570;
  MemL[MsgBase + 264] := 1919903264;
  MemL[MsgBase + 268] := 32;
  { no room for  }
  MemL[MsgBase + 320] := 1668180248;
  MemL[MsgBase + 324] := 1701082476;
  MemL[MsgBase + 328] := 1818846752;
  MemL[MsgBase + 332] := 1869488229;
  MemL[MsgBase + 336] := 1868963956;
  MemL[MsgBase + 340] := 979660405;
  MemL[MsgBase + 344] := 32;
  { include file not found:  }
  MemL[MsgBase + 384] := 1160018712;
  MemL[MsgBase + 388] := 2101695308;
  MemL[MsgBase + 392] := 1953068832;
  MemL[MsgBase + 396] := 1953853288;
  MemL[MsgBase + 400] := 1227127584;
  MemL[MsgBase + 404] := 1178944582;
  MemL[MsgBase + 408] := 125;
  { $ELSE without $IFDEF }
  MemL[MsgBase + 448] := 1160018713;
  MemL[MsgBase + 452] := 1179206734;
  MemL[MsgBase + 456] := 1769414781;
  MemL[MsgBase + 460] := 1970235508;
  MemL[MsgBase + 464] := 612049012;
  MemL[MsgBase + 468] := 1162102345;
  MemL[MsgBase + 472] := 32070;
  { $ENDIF without $IFDEF }
  MemL[MsgBase + 512] := 1684103696;
  MemL[MsgBase + 516] := 1634038304;
  MemL[MsgBase + 520] := 1970151532;
  MemL[MsgBase + 524] := 1919246957;
  MemL[MsgBase + 528] := 32;
  { bad real number  }
  MemL[MsgBase + 576] := 1920234257;
  MemL[MsgBase + 580] := 543649385;
  MemL[MsgBase + 584] := 544501614;
  MemL[MsgBase + 588] := 1936682083;
  MemL[MsgBase + 592] := 25701;
  { string not closed }
  MemL[MsgBase + 640] := 1701737750;
  MemL[MsgBase + 644] := 1667592312;
  MemL[MsgBase + 648] := 543450484;
  MemL[MsgBase + 652] := 1918986339;
  MemL[MsgBase + 656] := 1702126433;
  MemL[MsgBase + 660] := 2564210;
  { unexpected character ' }
  MemL[MsgBase + 704] := 1869770783;
  MemL[MsgBase + 708] := 1835102823;
  MemL[MsgBase + 712] := 1685021472;
  MemL[MsgBase + 716] := 1634476133;
  MemL[MsgBase + 720] := 1919248242;
  MemL[MsgBase + 724] := 1634235424;
  MemL[MsgBase + 728] := 842080366;
  MemL[MsgBase + 732] := 1112219704;
  { program code larger than 128 KB }
  MemL[MsgBase + 768] := 1869770782;
  MemL[MsgBase + 772] := 1835102823;
  MemL[MsgBase + 776] := 1685021472;
  MemL[MsgBase + 780] := 1634476133;
  MemL[MsgBase + 784] := 1919248242;
  MemL[MsgBase + 788] := 1634235424;
  MemL[MsgBase + 792] := 875962478;
  MemL[MsgBase + 796] := 4344608;
  { program code larger than 64 KB }
  MemL[MsgBase + 832] := 1869575182;
  MemL[MsgBase + 836] := 1851878688;
  MemL[MsgBase + 840] := 2037653625;
  MemL[MsgBase + 844] := 7562608;
  { too many types }
  MemL[MsgBase + 896] := 1869575188;
  MemL[MsgBase + 900] := 1851878688;
  MemL[MsgBase + 904] := 1684611193;
  MemL[MsgBase + 908] := 1769238117;
  MemL[MsgBase + 912] := 1919248742;
  MemL[MsgBase + 916] := 115;
  { too many identifiers }
  MemL[MsgBase + 960] := 1918984990;
  MemL[MsgBase + 964] := 1684632180;
  MemL[MsgBase + 968] := 1914725735;
  MemL[MsgBase + 972] := 1769238133;
  MemL[MsgBase + 976] := 1763730797;
  MemL[MsgBase + 980] := 1836016494;
  MemL[MsgBase + 984] := 1952803952;
  MemL[MsgBase + 988] := 2112101;
  { cartridge runtime incomplete:  }
  MemL[MsgBase + 1024] := 1651076121;
  MemL[MsgBase + 1028] := 2037539186;
  MemL[MsgBase + 1032] := 1970237984;
  MemL[MsgBase + 1036] := 1701734772;
  MemL[MsgBase + 1040] := 1936289056;
  MemL[MsgBase + 1044] := 1735289203;
  MemL[MsgBase + 1048] := 8250;
  { library routine missing:  }
  MemL[MsgBase + 1088] := 1869575193;
  MemL[MsgBase + 1092] := 1851878688;
  MemL[MsgBase + 1096] := 1818697849;
  MemL[MsgBase + 1100] := 1818321519;
  MemL[MsgBase + 1104] := 1918989856;
  MemL[MsgBase + 1108] := 1818386793;
  MemL[MsgBase + 1112] := 29541;
  { too many global variables }
  MemL[MsgBase + 1152] := 1667589162;
  MemL[MsgBase + 1156] := 1701994860;
  MemL[MsgBase + 1160] := 1918989856;
  MemL[MsgBase + 1164] := 1818386793;
  MemL[MsgBase + 1168] := 1646293861;
  MemL[MsgBase + 1172] := 1919903333;
  MemL[MsgBase + 1176] := 1701716069;
  MemL[MsgBase + 1180] := 1684370547;
  MemL[MsgBase + 1184] := 1869770784;
  MemL[MsgBase + 1188] := 1969513827;
  MemL[MsgBase + 1192] := 7562610;
  { declare variables before nested procedures }
  MemL[MsgBase + 1216] := 1869575198;
  MemL[MsgBase + 1220] := 1851878688;
  MemL[MsgBase + 1224] := 1634476153;
  MemL[MsgBase + 1228] := 543516530;
  MemL[MsgBase + 1232] := 1633906540;
  MemL[MsgBase + 1236] := 1635131500;
  MemL[MsgBase + 1240] := 1650551154;
  MemL[MsgBase + 1244] := 7562604;
  { too many large local variables }
  MemL[MsgBase + 1280] := 1918989841;
  MemL[MsgBase + 1284] := 1818386793;
  MemL[MsgBase + 1288] := 2019893349;
  MemL[MsgBase + 1292] := 1952671088;
  MemL[MsgBase + 1296] := 25701;
  { variable expected }
  MemL[MsgBase + 1344] := 1818326542;
  MemL[MsgBase + 1348] := 1696621941;
  MemL[MsgBase + 1352] := 1667592312;
  MemL[MsgBase + 1356] := 6579572;
  { value expected }
  MemL[MsgBase + 1408] := 1953392920;
  MemL[MsgBase + 1412] := 1634628197;
  MemL[MsgBase + 1416] := 1663056492;
  MemL[MsgBase + 1420] := 1768189551;
  MemL[MsgBase + 1424] := 1852795252;
  MemL[MsgBase + 1428] := 1768649504;
  MemL[MsgBase + 1432] := 112;
  { internal: condition skip }
  MemL[MsgBase + 1472] := 1953392920;
  MemL[MsgBase + 1476] := 1634628197;
  MemL[MsgBase + 1480] := 1663056492;
  MemL[MsgBase + 1484] := 1768189551;
  MemL[MsgBase + 1488] := 1852795252;
  MemL[MsgBase + 1492] := 1685021472;
  MemL[MsgBase + 1496] := 101;
  { internal: condition code }
  MemL[MsgBase + 1536] := 1869570576;
  MemL[MsgBase + 1540] := 1851876716;
  MemL[MsgBase + 1544] := 1886938400;
  MemL[MsgBase + 1548] := 1702126437;
  MemL[MsgBase + 1552] := 100;
  { boolean expected }
  MemL[MsgBase + 1600] := 1869570587;
  MemL[MsgBase + 1604] := 1851876716;
  MemL[MsgBase + 1608] := 1886938400;
  MemL[MsgBase + 1612] := 1936942450;
  MemL[MsgBase + 1616] := 544108393;
  MemL[MsgBase + 1620] := 1701869669;
  MemL[MsgBase + 1624] := 1684370531;
  { boolean expression expected }
  MemL[MsgBase + 1664] := 1920234255;
  MemL[MsgBase + 1668] := 543649385;
  MemL[MsgBase + 1672] := 1701869669;
  MemL[MsgBase + 1676] := 1684370531;
  { string expected }
  MemL[MsgBase + 1728] := 1836412431;
  MemL[MsgBase + 1732] := 544367970;
  MemL[MsgBase + 1736] := 1701869669;
  MemL[MsgBase + 1740] := 1684370531;
  { number expected }
  MemL[MsgBase + 1792] := 1953392912;
  MemL[MsgBase + 1796] := 1919248229;
  MemL[MsgBase + 1800] := 1886938400;
  MemL[MsgBase + 1804] := 1702126437;
  MemL[MsgBase + 1808] := 100;
  { integer expected }
  MemL[MsgBase + 1856] := 1634231053;
  MemL[MsgBase + 1860] := 2019893362;
  MemL[MsgBase + 1864] := 1952671088;
  MemL[MsgBase + 1868] := 25701;
  { char expected }
  MemL[MsgBase + 1920] := 1668180242;
  MemL[MsgBase + 1924] := 1634757999;
  MemL[MsgBase + 1928] := 1818388852;
  MemL[MsgBase + 1932] := 2037653605;
  MemL[MsgBase + 1936] := 7562608;
  { incompatible types }
  MemL[MsgBase + 1984] := 1768910864;
  MemL[MsgBase + 1988] := 1919251566;
  MemL[MsgBase + 1992] := 1886938400;
  MemL[MsgBase + 1996] := 1702126437;
  MemL[MsgBase + 2000] := 100;
  { pointer expected }
  MemL[MsgBase + 2048] := 1851876117;
  MemL[MsgBase + 2052] := 544501614;
  MemL[MsgBase + 2056] := 1769173857;
  MemL[MsgBase + 2060] := 1948282471;
  MemL[MsgBase + 2064] := 1752440943;
  MemL[MsgBase + 2068] := 29545;
  { cannot assign to this }
  MemL[MsgBase + 2112] := 1852793617;
  MemL[MsgBase + 2116] := 1851880563;
  MemL[MsgBase + 2120] := 2019893364;
  MemL[MsgBase + 2124] := 1952671088;
  MemL[MsgBase + 2128] := 25701;
  { constant expected }
  MemL[MsgBase + 2176] := 1887007757;
  MemL[MsgBase + 2180] := 2019893349;
  MemL[MsgBase + 2184] := 1952671088;
  MemL[MsgBase + 2188] := 25701;
  { type expected }
  MemL[MsgBase + 2240] := 1887007759;
  MemL[MsgBase + 2244] := 2019893349;
  MemL[MsgBase + 2248] := 1952671088;
  MemL[MsgBase + 2252] := 540697701;
  { type expected:  }
  MemL[MsgBase + 2304] := 1986947345;
  MemL[MsgBase + 2308] := 1684630625;
  MemL[MsgBase + 2312] := 1887007776;
  MemL[MsgBase + 2316] := 1633886309;
  MemL[MsgBase + 2320] := 29811;
  { invalid type cast }
  MemL[MsgBase + 2368] := 1667592719;
  MemL[MsgBase + 2372] := 543453807;
  MemL[MsgBase + 2376] := 1701869669;
  MemL[MsgBase + 2380] := 1684370531;
  { record expected }
  MemL[MsgBase + 2432] := 1701406222;
  MemL[MsgBase + 2436] := 1696621676;
  MemL[MsgBase + 2440] := 1667592312;
  MemL[MsgBase + 2444] := 6579572;
  { field expected }
  MemL[MsgBase + 2496] := 1802401038;
  MemL[MsgBase + 2500] := 1853321070;
  MemL[MsgBase + 2504] := 1701406240;
  MemL[MsgBase + 2508] := 2122860;
  { unknown field  }
  MemL[MsgBase + 2560] := 1701406235;
  MemL[MsgBase + 2564] := 1864393836;
  MemL[MsgBase + 2568] := 1752440934;
  MemL[MsgBase + 2572] := 1847620457;
  MemL[MsgBase + 2576] := 1931506799;
  MemL[MsgBase + 2580] := 1869639797;
  MemL[MsgBase + 2584] := 1684370546;
  { field of this not supported }
  MemL[MsgBase + 2624] := 1920098574;
  MemL[MsgBase + 2628] := 1696627041;
  MemL[MsgBase + 2632] := 1667592312;
  MemL[MsgBase + 2636] := 6579572;
  { array expected }
  MemL[MsgBase + 2688] := 1851876113;
  MemL[MsgBase + 2692] := 544501614;
  MemL[MsgBase + 2696] := 1701080681;
  MemL[MsgBase + 2700] := 1752440952;
  MemL[MsgBase + 2704] := 29545;
  { cannot index this }
  MemL[MsgBase + 2752] := 1684957461;
  MemL[MsgBase + 2756] := 1830844517;
  MemL[MsgBase + 2760] := 544502645;
  MemL[MsgBase + 2764] := 1864394082;
  MemL[MsgBase + 2768] := 1852400754;
  MemL[MsgBase + 2772] := 27745;
  { index must be ordinal }
  MemL[MsgBase + 2816] := 1953392911;
  MemL[MsgBase + 2820] := 1634628197;
  MemL[MsgBase + 2824] := 1763719788;
  MemL[MsgBase + 2828] := 2019910766;
  { internal: index }
  MemL[MsgBase + 2880] := 1887007766;
  MemL[MsgBase + 2884] := 1881171045;
  MemL[MsgBase + 2888] := 1953393007;
  MemL[MsgBase + 2892] := 1696625253;
  MemL[MsgBase + 2896] := 1667592312;
  MemL[MsgBase + 2900] := 6579572;
  { typed pointer expected }
  MemL[MsgBase + 2944] := 1684300048;
  MemL[MsgBase + 2948] := 1936942450;
  MemL[MsgBase + 2952] := 1886938400;
  MemL[MsgBase + 2956] := 1702126437;
  MemL[MsgBase + 2960] := 100;
  { address expected }
  MemL[MsgBase + 3008] := 1918989843;
  MemL[MsgBase + 3012] := 1818386793;
  MemL[MsgBase + 3016] := 2019893349;
  MemL[MsgBase + 3020] := 1952671088;
  MemL[MsgBase + 3024] := 540697701;
  { variable expected:  }
  MemL[MsgBase + 3072] := 1986618384;
  MemL[MsgBase + 3076] := 1869181801;
  MemL[MsgBase + 3080] := 2036473966;
  MemL[MsgBase + 3084] := 1919253024;
  MemL[MsgBase + 3088] := 111;
  { division by zero }
  MemL[MsgBase + 3136] := 1836412432;
  MemL[MsgBase + 3140] := 1936876898;
  MemL[MsgBase + 3144] := 1886938400;
  MemL[MsgBase + 3148] := 1702126437;
  MemL[MsgBase + 3152] := 100;
  { numbers expected }
  MemL[MsgBase + 3200] := 1768453148;
  MemL[MsgBase + 3204] := 1886330995;
  MemL[MsgBase + 3208] := 1952543333;
  MemL[MsgBase + 3212] := 1847620207;
  MemL[MsgBase + 3216] := 1935959397;
  MemL[MsgBase + 3220] := 1953392928;
  MemL[MsgBase + 3224] := 1919248229;
  MemL[MsgBase + 3228] := 115;
  { this operator needs integers }
  MemL[MsgBase + 3264] := 1952805644;
  MemL[MsgBase + 3268] := 1886938400;
  MemL[MsgBase + 3272] := 1702126437;
  MemL[MsgBase + 3276] := 100;
  { set expected }
  MemL[MsgBase + 3328] := 1685221151;
  MemL[MsgBase + 3332] := 1818324585;
  MemL[MsgBase + 3336] := 1818326560;
  MemL[MsgBase + 3340] := 1696621941;
  MemL[MsgBase + 3344] := 1667592312;
  MemL[MsgBase + 3348] := 543450484;
  MemL[MsgBase + 3352] := 1629515369;
  MemL[MsgBase + 3356] := 1952805664;
  { ordinal value expected in a set }
  MemL[MsgBase + 3392] := 1685221136;
  MemL[MsgBase + 3396] := 1818324585;
  MemL[MsgBase + 3400] := 1886938400;
  MemL[MsgBase + 3404] := 1702126437;
  MemL[MsgBase + 3408] := 100;
  { ordinal expected }
  MemL[MsgBase + 3456] := 1935827234;
  MemL[MsgBase + 3460] := 543584032;
  MemL[MsgBase + 3464] := 1735290732;
  MemL[MsgBase + 3468] := 980708969;
  MemL[MsgBase + 3472] := 1702065440;
  MemL[MsgBase + 3476] := 1701344288;
  MemL[MsgBase + 3480] := 1886938400;
  MemL[MsgBase + 3484] := 1936942450;
  MemL[MsgBase + 3488] := 7237481;
  { abs of longint: use the expression }
  MemL[MsgBase + 3520] := 1802401041;
  MemL[MsgBase + 3524] := 1853321070;
  MemL[MsgBase + 3528] := 1853187616;
  MemL[MsgBase + 3532] := 1869182051;
  MemL[MsgBase + 3536] := 8302;
  { unknown function  }
  MemL[MsgBase + 3584] := 1869570586;
  MemL[MsgBase + 3588] := 1851876716;
  MemL[MsgBase + 3592] := 1886938400;
  MemL[MsgBase + 3596] := 1702126437;
  MemL[MsgBase + 3600] := 1717641316;
  MemL[MsgBase + 3604] := 544367988;
  MemL[MsgBase + 3608] := 5525326;
  { boolean expected after NOT }
  MemL[MsgBase + 3648] := 1802401043;
  MemL[MsgBase + 3652] := 1853321070;
  MemL[MsgBase + 3656] := 1701079328;
  MemL[MsgBase + 3660] := 1718187118;
  MemL[MsgBase + 3664] := 544367977;
  { unknown identifier  }
  MemL[MsgBase + 3712] := 1869770774;
  MemL[MsgBase + 3716] := 1969513827;
  MemL[MsgBase + 3720] := 1746953586;
  MemL[MsgBase + 3724] := 1847620449;
  MemL[MsgBase + 3728] := 1635131503;
  MemL[MsgBase + 3732] := 6649196;
  { procedure has no value }
  MemL[MsgBase + 3776] := 1702065441;
  MemL[MsgBase + 3780] := 1936020000;
  MemL[MsgBase + 3784] := 544500853;
  MemL[MsgBase + 3788] := 544370534;
  MemL[MsgBase + 3792] := 543516788;
  MemL[MsgBase + 3796] := 1668183398;
  MemL[MsgBase + 3800] := 1852795252;
  MemL[MsgBase + 3804] := 1818326560;
  MemL[MsgBase + 3808] := 25973;
  { use Result for the function value }
  MemL[MsgBase + 3840] := 1886938387;
  MemL[MsgBase + 3844] := 1936942450;
  MemL[MsgBase + 3848] := 544108393;
  MemL[MsgBase + 3852] := 1701869669;
  MemL[MsgBase + 3856] := 1684370531;
  { expression expected }
  MemL[MsgBase + 3904] := 1953392913;
  MemL[MsgBase + 3908] := 1919248229;
  MemL[MsgBase + 3912] := 2019893363;
  MemL[MsgBase + 3916] := 1952671088;
  MemL[MsgBase + 3920] := 25701;
  { integers expected }
  MemL[MsgBase + 3968] := 1952805660;
  MemL[MsgBase + 3972] := 1868767347;
  MemL[MsgBase + 3976] := 1918988397;
  MemL[MsgBase + 3980] := 1769414757;
  MemL[MsgBase + 3984] := 1025534068;
  MemL[MsgBase + 3988] := 540949536;
  MemL[MsgBase + 3992] := 1042300220;
  MemL[MsgBase + 3996] := 61;
  { sets compare with = <> <= >= }
  MemL[MsgBase + 4032] := 1668180256;
  MemL[MsgBase + 4036] := 1634757999;
  MemL[MsgBase + 4040] := 1818388852;
  MemL[MsgBase + 4044] := 2037653605;
  MemL[MsgBase + 4048] := 544433520;
  MemL[MsgBase + 4052] := 1663069801;
  MemL[MsgBase + 4056] := 1634757999;
  MemL[MsgBase + 4060] := 1869834610;
  MemL[MsgBase + 4064] := 110;
  { incompatible types in comparison }
  MemL[MsgBase + 4096] := 1685221152;
  MemL[MsgBase + 4100] := 1818324585;
  MemL[MsgBase + 4104] := 1818326560;
  MemL[MsgBase + 4108] := 1696621941;
  MemL[MsgBase + 4112] := 1667592312;
  MemL[MsgBase + 4116] := 543450484;
  MemL[MsgBase + 4120] := 1868981602;
  MemL[MsgBase + 4124] := 1226859890;
  MemL[MsgBase + 4128] := 78;
  { ordinal value expected before IN }
  MemL[MsgBase + 4160] := 1953853496;
  MemL[MsgBase + 4164] := 1701344288;
  MemL[MsgBase + 4168] := 1920234272;
  MemL[MsgBase + 4172] := 543649385;
  MemL[MsgBase + 4176] := 1936877926;
  MemL[MsgBase + 4180] := 1752637556;
  MemL[MsgBase + 4184] := 1663069797;
  MemL[MsgBase + 4188] := 1634757999;
  MemL[MsgBase + 4192] := 1735289202;
  MemL[MsgBase + 4196] := 1931501856;
  MemL[MsgBase + 4200] := 1852404340;
  MemL[MsgBase + 4204] := 1769414759;
  MemL[MsgBase + 4208] := 1629513844;
  MemL[MsgBase + 4212] := 1634231072;
  MemL[MsgBase + 4216] := 114;
  { put the string first when comparing a string with a char }
  MemL[MsgBase + 4224] := 1835355423;
  MemL[MsgBase + 4228] := 1663065435;
  MemL[MsgBase + 4232] := 1869508193;
  MemL[MsgBase + 4236] := 1700929652;
  MemL[MsgBase + 4240] := 1981833504;
  MemL[MsgBase + 4244] := 1881174625;
  MemL[MsgBase + 4248] := 1835102817;
  MemL[MsgBase + 4252] := 1919251557;
  { Mem[] cannot be a var parameter }
  MemL[MsgBase + 4288] := 1869772563;
  MemL[MsgBase + 4292] := 1981835118;
  MemL[MsgBase + 4296] := 1634300513;
  MemL[MsgBase + 4300] := 543517794;
  MemL[MsgBase + 4304] := 1701869940;
  { wrong variable type }
  MemL[MsgBase + 4352] := 1869575186;
  MemL[MsgBase + 4356] := 1851878688;
  MemL[MsgBase + 4360] := 1918967929;
  MemL[MsgBase + 4364] := 1701672295;
  MemL[MsgBase + 4368] := 7566446;
  { too many arguments }
  MemL[MsgBase + 4416] := 1869575185;
  MemL[MsgBase + 4420] := 2003133984;
  MemL[MsgBase + 4424] := 1735549216;
  MemL[MsgBase + 4428] := 1852140917;
  MemL[MsgBase + 4432] := 29556;
  { too few arguments }
  MemL[MsgBase + 4480] := 1851876113;
  MemL[MsgBase + 4484] := 544501614;
  MemL[MsgBase + 4488] := 1953067639;
  MemL[MsgBase + 4492] := 1752440933;
  MemL[MsgBase + 4496] := 29545;
  { cannot write this }
  MemL[MsgBase + 4544] := 1684633358;
  MemL[MsgBase + 4548] := 1696622708;
  MemL[MsgBase + 4552] := 1667592312;
  MemL[MsgBase + 4556] := 6579572;
  { width expected }
  MemL[MsgBase + 4608] := 1836412443;
  MemL[MsgBase + 4612] := 544367970;
  MemL[MsgBase + 4616] := 1679844975;
  MemL[MsgBase + 4620] := 1835623269;
  MemL[MsgBase + 4624] := 544435297;
  MemL[MsgBase + 4628] := 1701869669;
  MemL[MsgBase + 4632] := 1684370531;
  { number of decimals expected }
  MemL[MsgBase + 4672] := 1851876112;
  MemL[MsgBase + 4676] := 544501614;
  MemL[MsgBase + 4680] := 1684104562;
  MemL[MsgBase + 4684] := 1768453152;
  MemL[MsgBase + 4688] := 115;
  { cannot read this }
  MemL[MsgBase + 4736] := 1685221145;
  MemL[MsgBase + 4740] := 1818324585;
  MemL[MsgBase + 4744] := 1918989856;
  MemL[MsgBase + 4748] := 1818386793;
  MemL[MsgBase + 4752] := 2019893349;
  MemL[MsgBase + 4756] := 1952671088;
  MemL[MsgBase + 4760] := 25701;
  { ordinal variable expected }
  MemL[MsgBase + 4800] := 1668180271;
  MemL[MsgBase + 4804] := 543584032;
  MemL[MsgBase + 4808] := 1869619297;
  MemL[MsgBase + 4812] := 1702129257;
  MemL[MsgBase + 4816] := 2036473970;
  MemL[MsgBase + 4820] := 1981833504;
  MemL[MsgBase + 4824] := 1634300513;
  MemL[MsgBase + 4828] := 543517794;
  MemL[MsgBase + 4832] := 1847620457;
  MemL[MsgBase + 4836] := 1931506799;
  MemL[MsgBase + 4840] := 1869639797;
  MemL[MsgBase + 4844] := 1684370546;
  { inc of a pointer by a variable is not supported }
  MemL[MsgBase + 4864] := 540880145;
  MemL[MsgBase + 4868] := 1713402729;
  MemL[MsgBase + 4872] := 1847620207;
  MemL[MsgBase + 4876] := 1700949365;
  MemL[MsgBase + 4880] := 29554;
  { -= is for numbers }
  MemL[MsgBase + 4928] := 540879643;
  MemL[MsgBase + 4932] := 1948282479;
  MemL[MsgBase + 4936] := 544434536;
  MemL[MsgBase + 4940] := 1769103734;
  MemL[MsgBase + 4944] := 1701601889;
  MemL[MsgBase + 4948] := 1937055802;
  MemL[MsgBase + 4952] := 1027219557;
  { += on this variable: use := }
  MemL[MsgBase + 4992] := 1920234264;
  MemL[MsgBase + 4996] := 543649385;
  MemL[MsgBase + 5000] := 1769103734;
  MemL[MsgBase + 5004] := 1701601889;
  MemL[MsgBase + 5008] := 1886938400;
  MemL[MsgBase + 5012] := 1702126437;
  MemL[MsgBase + 5016] := 100;
  { string variable expected }
  MemL[MsgBase + 5056] := 1836412440;
  MemL[MsgBase + 5060] := 544367970;
  MemL[MsgBase + 5064] := 1769103734;
  MemL[MsgBase + 5068] := 1701601889;
  MemL[MsgBase + 5072] := 1886938400;
  MemL[MsgBase + 5076] := 1702126437;
  MemL[MsgBase + 5080] := 100;
  { number variable expected }
  MemL[MsgBase + 5120] := 1818318381;
  MemL[MsgBase + 5124] := 1953392928;
  MemL[MsgBase + 5128] := 1752440943;
  MemL[MsgBase + 5132] := 1981838185;
  MemL[MsgBase + 5136] := 1634300513;
  MemL[MsgBase + 5140] := 979725410;
  MemL[MsgBase + 5144] := 1702065440;
  MemL[MsgBase + 5148] := 1931501856;
  MemL[MsgBase + 5152] := 1819307369;
  MemL[MsgBase + 5156] := 1635131493;
  MemL[MsgBase + 5160] := 1650551154;
  MemL[MsgBase + 5164] := 25964;
  { Val into this variable: use a simple variable }
  MemL[MsgBase + 5184] := 1953392921;
  MemL[MsgBase + 5188] := 1919248229;
  MemL[MsgBase + 5192] := 1918989856;
  MemL[MsgBase + 5196] := 1818386793;
  MemL[MsgBase + 5200] := 2019893349;
  MemL[MsgBase + 5204] := 1952671088;
  MemL[MsgBase + 5208] := 25701;
  { integer variable expected }
  MemL[MsgBase + 5248] := 1768910873;
  MemL[MsgBase + 5252] := 1919251566;
  MemL[MsgBase + 5256] := 1918989856;
  MemL[MsgBase + 5260] := 1818386793;
  MemL[MsgBase + 5264] := 2019893349;
  MemL[MsgBase + 5268] := 1952671088;
  MemL[MsgBase + 5272] := 25701;
  { pointer variable expected }
  MemL[MsgBase + 5312] := 1869573143;
  MemL[MsgBase + 5316] := 1847620464;
  MemL[MsgBase + 5320] := 1702130533;
  MemL[MsgBase + 5324] := 1869881444;
  MemL[MsgBase + 5328] := 1701060719;
  MemL[MsgBase + 5332] := 2037149797;
  { loops nested too deeply }
  MemL[MsgBase + 5376] := 1701344299;
  MemL[MsgBase + 5380] := 1869573152;
  MemL[MsgBase + 5384] := 1635131504;
  MemL[MsgBase + 5388] := 1650551154;
  MemL[MsgBase + 5392] := 1830839660;
  MemL[MsgBase + 5396] := 544502645;
  MemL[MsgBase + 5400] := 1629513058;
  MemL[MsgBase + 5404] := 1835627296;
  MemL[MsgBase + 5408] := 543517808;
  MemL[MsgBase + 5412] := 1769103734;
  MemL[MsgBase + 5416] := 1701601889;
  { the loop variable must be a simple variable }
  MemL[MsgBase + 5440] := 1869573163;
  MemL[MsgBase + 5444] := 1635131504;
  MemL[MsgBase + 5448] := 1650551154;
  MemL[MsgBase + 5452] := 1830839660;
  MemL[MsgBase + 5456] := 544502645;
  MemL[MsgBase + 5460] := 1629513058;
  MemL[MsgBase + 5464] := 1864382496;
  MemL[MsgBase + 5468] := 909189234;
  MemL[MsgBase + 5472] := 1953063456;
  MemL[MsgBase + 5476] := 1685221152;
  MemL[MsgBase + 5480] := 1818324585;
  { loop variable must be a 8 or 16 bit ordinal }
  MemL[MsgBase + 5504] := 542069771;
  MemL[MsgBase + 5508] := 1701869669;
  MemL[MsgBase + 5512] := 1684370531;
  { TO expected }
  MemL[MsgBase + 5568] := 1864382500;
  MemL[MsgBase + 5572] := 909189234;
  MemL[MsgBase + 5576] := 1953063456;
  MemL[MsgBase + 5580] := 1685221152;
  MemL[MsgBase + 5584] := 1818324585;
  MemL[MsgBase + 5588] := 1886938400;
  MemL[MsgBase + 5592] := 1702126437;
  MemL[MsgBase + 5596] := 1852383332;
  MemL[MsgBase + 5600] := 1396785952;
  MemL[MsgBase + 5604] := 69;
  { 8 or 16 bit ordinal expected in CASE }
  MemL[MsgBase + 5632] := 1667592730;
  MemL[MsgBase + 5636] := 543453807;
  MemL[MsgBase + 5640] := 1701869669;
  MemL[MsgBase + 5644] := 1684370531;
  MemL[MsgBase + 5648] := 1952866592;
  MemL[MsgBase + 5652] := 1461744229;
  MemL[MsgBase + 5656] := 4740169;
  { record expected after WITH }
  MemL[MsgBase + 5696] := 1414092566;
  MemL[MsgBase + 5700] := 1701716040;
  MemL[MsgBase + 5704] := 1684370547;
  MemL[MsgBase + 5708] := 1869575200;
  MemL[MsgBase + 5712] := 1701143584;
  MemL[MsgBase + 5716] := 7957616;
  { WITH nested too deeply }
  MemL[MsgBase + 5760] := 1414092586;
  MemL[MsgBase + 5764] := 1718558792;
  MemL[MsgBase + 5768] := 1836016416;
  MemL[MsgBase + 5772] := 1702131056;
  MemL[MsgBase + 5776] := 1701978212;
  MemL[MsgBase + 5780] := 1685221219;
  MemL[MsgBase + 5784] := 1701716083;
  MemL[MsgBase + 5788] := 1684370547;
  MemL[MsgBase + 5792] := 1869575200;
  MemL[MsgBase + 5796] := 1701143584;
  MemL[MsgBase + 5800] := 7957616;
  { WITH of computed records nested too deeply }
  MemL[MsgBase + 5824] := 1953392919;
  MemL[MsgBase + 5828] := 1634628197;
  MemL[MsgBase + 5832] := 1847605868;
  MemL[MsgBase + 5836] := 1230446703;
  MemL[MsgBase + 5840] := 1931495508;
  MemL[MsgBase + 5844] := 1937010540;
  { internal: no WITH slots }
  MemL[MsgBase + 5888] := 1414481685;
  MemL[MsgBase + 5892] := 1936269391;
  MemL[MsgBase + 5896] := 1953459744;
  MemL[MsgBase + 5900] := 1886745376;
  MemL[MsgBase + 5904] := 1953656688;
  MemL[MsgBase + 5908] := 25701;
  { GOTO is not supported }
  MemL[MsgBase + 5952] := 1952805653;
  MemL[MsgBase + 5956] := 1918989856;
  MemL[MsgBase + 5960] := 1818386793;
  MemL[MsgBase + 5964] := 2019893349;
  MemL[MsgBase + 5968] := 1952671088;
  MemL[MsgBase + 5972] := 25701;
  { set variable expected }
  MemL[MsgBase + 6016] := 1685221142;
  MemL[MsgBase + 6020] := 1818324585;
  MemL[MsgBase + 6024] := 1818326560;
  MemL[MsgBase + 6028] := 1696621941;
  MemL[MsgBase + 6032] := 1667592312;
  MemL[MsgBase + 6036] := 6579572;
  { ordinal value expected }
  MemL[MsgBase + 6080] := 1230521624;
  MemL[MsgBase + 6084] := 1970217044;
  MemL[MsgBase + 6088] := 1684632436;
  MemL[MsgBase + 6092] := 543236197;
  MemL[MsgBase + 6096] := 1668248176;
  MemL[MsgBase + 6100] := 1920296037;
  MemL[MsgBase + 6104] := 101;
  { EXIT outside a procedure }
  MemL[MsgBase + 6144] := 1230521634;
  MemL[MsgBase + 6148] := 1769414740;
  MemL[MsgBase + 6152] := 1629513844;
  MemL[MsgBase + 6156] := 1818326560;
  MemL[MsgBase + 6160] := 1763730805;
  MemL[MsgBase + 6164] := 1868963955;
  MemL[MsgBase + 6168] := 1969627250;
  MemL[MsgBase + 6172] := 1769235310;
  MemL[MsgBase + 6176] := 7564911;
  { EXIT with a value is for functions }
  MemL[MsgBase + 6208] := 1635021586;
  MemL[MsgBase + 6212] := 1701668212;
  MemL[MsgBase + 6216] := 1696625774;
  MemL[MsgBase + 6220] := 1667592312;
  MemL[MsgBase + 6224] := 6579572;
  { statement expected }
  MemL[MsgBase + 6272] := 1701406227;
  MemL[MsgBase + 6276] := 1847616620;
  MemL[MsgBase + 6280] := 543518049;
  MemL[MsgBase + 6284] := 1701869669;
  MemL[MsgBase + 6288] := 1684370531;
  { field name expected }
  MemL[MsgBase + 6336] := 1869575182;
  MemL[MsgBase + 6340] := 1851878688;
  MemL[MsgBase + 6344] := 1634607225;
  MemL[MsgBase + 6348] := 7562605;
  { too many names }
  MemL[MsgBase + 6400] := 1734439962;
  MemL[MsgBase + 6404] := 1701406240;
  MemL[MsgBase + 6408] := 1864393836;
  MemL[MsgBase + 6412] := 2037653618;
  MemL[MsgBase + 6416] := 1696621936;
  MemL[MsgBase + 6420] := 1667592312;
  MemL[MsgBase + 6424] := 6579572;
  { tag field or type expected }
  MemL[MsgBase + 6464] := 1920234260;
  MemL[MsgBase + 6468] := 543649385;
  MemL[MsgBase + 6472] := 1735288172;
  MemL[MsgBase + 6476] := 824207476;
  MemL[MsgBase + 6480] := 892481070;
  MemL[MsgBase + 6484] := 53;
  { string length 1..255 }
  MemL[MsgBase + 6528] := 1887007765;
  MemL[MsgBase + 6532] := 2019893349;
  MemL[MsgBase + 6536] := 1952671088;
  MemL[MsgBase + 6540] := 1629512805;
  MemL[MsgBase + 6544] := 1919251558;
  MemL[MsgBase + 6548] := 24096;
  { type expected after ^ }
  MemL[MsgBase + 6592] := 1869575193;
  MemL[MsgBase + 6596] := 1851878688;
  MemL[MsgBase + 6600] := 1868963961;
  MemL[MsgBase + 6604] := 1918990194;
  MemL[MsgBase + 6608] := 1869619300;
  MemL[MsgBase + 6612] := 1702129257;
  MemL[MsgBase + 6616] := 29554;
  { too many forward pointers }
  MemL[MsgBase + 6656] := 544497940;
  MemL[MsgBase + 6660] := 1953722221;
  MemL[MsgBase + 6664] := 1679833120;
  MemL[MsgBase + 6668] := 1852140905;
  MemL[MsgBase + 6672] := 1852795251;
  MemL[MsgBase + 6676] := 115;
  { at most 8 dimensions }
  MemL[MsgBase + 6720] := 1684103696;
  MemL[MsgBase + 6724] := 1920098592;
  MemL[MsgBase + 6728] := 1646295393;
  MemL[MsgBase + 6732] := 1684960623;
  MemL[MsgBase + 6736] := 115;
  { bad array bounds }
  MemL[MsgBase + 6784] := 1920098583;
  MemL[MsgBase + 6788] := 1814067553;
  MemL[MsgBase + 6792] := 1701278305;
  MemL[MsgBase + 6796] := 1752440946;
  MemL[MsgBase + 6800] := 908095073;
  MemL[MsgBase + 6804] := 1112219700;
  { array larger than 64 KB }
  MemL[MsgBase + 6848] := 1920098575;
  MemL[MsgBase + 6852] := 1948285281;
  MemL[MsgBase + 6856] := 1814065007;
  MemL[MsgBase + 6860] := 1701278305;
  { array too large }
  MemL[MsgBase + 6912] := 1835101709;
  MemL[MsgBase + 6916] := 2019893349;
  MemL[MsgBase + 6920] := 1952671088;
  MemL[MsgBase + 6924] := 25701;
  { name expected }
  MemL[MsgBase + 6976] := 1952805663;
  MemL[MsgBase + 6980] := 543584032;
  MemL[MsgBase + 6984] := 1864396385;
  MemL[MsgBase + 6988] := 1852400754;
  MemL[MsgBase + 6992] := 1948281953;
  MemL[MsgBase + 6996] := 543518841;
  MemL[MsgBase + 7000] := 1701869669;
  MemL[MsgBase + 7004] := 1684370531;
  { set of an ordinal type expected }
  MemL[MsgBase + 7040] := 1818846742;
  MemL[MsgBase + 7044] := 1635131493;
  MemL[MsgBase + 7048] := 1650551154;
  MemL[MsgBase + 7052] := 1696621932;
  MemL[MsgBase + 7056] := 1667592312;
  MemL[MsgBase + 7060] := 6579572;
  { file variable expected }
  MemL[MsgBase + 7104] := 1802401037;
  MemL[MsgBase + 7108] := 1853321070;
  MemL[MsgBase + 7112] := 1887007776;
  MemL[MsgBase + 7116] := 8293;
  { unknown type  }
  MemL[MsgBase + 7168] := 1920234255;
  MemL[MsgBase + 7172] := 543649385;
  MemL[MsgBase + 7176] := 544173940;
  MemL[MsgBase + 7180] := 1735290732;
  { string too long }
  MemL[MsgBase + 7232] := 544173577;
  MemL[MsgBase + 7236] := 1818585446;
  MemL[MsgBase + 7240] := 8292;
  { no field  }
  MemL[MsgBase + 7296] := 1396850982;
  MemL[MsgBase + 7300] := 1414876239;
  MemL[MsgBase + 7304] := 1936269381;
  MemL[MsgBase + 7308] := 1919903264;
  MemL[MsgBase + 7312] := 1701736224;
  MemL[MsgBase + 7316] := 1918989856;
  MemL[MsgBase + 7320] := 1818386793;
  MemL[MsgBase + 7324] := 1952522341;
  MemL[MsgBase + 7328] := 1948279072;
  MemL[MsgBase + 7332] := 6647145;
  { ABSOLUTE is for one variable at a time }
  MemL[MsgBase + 7360] := 1918989856;
  MemL[MsgBase + 7364] := 1818386793;
  MemL[MsgBase + 7368] := 2019893349;
  MemL[MsgBase + 7372] := 1952671088;
  MemL[MsgBase + 7376] := 1629512805;
  MemL[MsgBase + 7380] := 1919251558;
  MemL[MsgBase + 7384] := 1396850976;
  MemL[MsgBase + 7388] := 1414876239;
  MemL[MsgBase + 7392] := 69;
  { variable expected after ABSOLUTE }
  MemL[MsgBase + 7424] := 1396850997;
  MemL[MsgBase + 7428] := 1414876239;
  MemL[MsgBase + 7432] := 1986994245;
  MemL[MsgBase + 7436] := 1629516389;
  MemL[MsgBase + 7440] := 1918987296;
  MemL[MsgBase + 7444] := 1814062439;
  MemL[MsgBase + 7448] := 1818321775;
  MemL[MsgBase + 7452] := 1918989856;
  MemL[MsgBase + 7456] := 1818386793;
  MemL[MsgBase + 7460] := 1936269413;
  MemL[MsgBase + 7464] := 1953459744;
  MemL[MsgBase + 7468] := 1886745376;
  MemL[MsgBase + 7472] := 1953656688;
  MemL[MsgBase + 7476] := 25701;
  { ABSOLUTE over a large local variable is not supported }
  MemL[MsgBase + 7488] := 1396851003;
  MemL[MsgBase + 7492] := 1414876239;
  MemL[MsgBase + 7496] := 1970217029;
  MemL[MsgBase + 7500] := 1684632436;
  MemL[MsgBase + 7504] := 1633820773;
  MemL[MsgBase + 7508] := 807431022;
  MemL[MsgBase + 7512] := 544434464;
  MemL[MsgBase + 7516] := 544370534;
  MemL[MsgBase + 7520] := 1886218611;
  MemL[MsgBase + 7524] := 1981834604;
  MemL[MsgBase + 7528] := 1634300513;
  MemL[MsgBase + 7532] := 1936026722;
  MemL[MsgBase + 7536] := 1684955424;
  MemL[MsgBase + 7540] := 1667592736;
  MemL[MsgBase + 7544] := 1935962735;
  { ABSOLUTE outside bank 0 is for simple variables and records }
  MemL[MsgBase + 7552] := 1768843568;
  MemL[MsgBase + 7556] := 1818323316;
  MemL[MsgBase + 7560] := 1818326560;
  MemL[MsgBase + 7564] := 544433525;
  MemL[MsgBase + 7568] := 544370534;
  MemL[MsgBase + 7572] := 543518319;
  MemL[MsgBase + 7576] := 1651469415;
  MemL[MsgBase + 7580] := 1981836385;
  MemL[MsgBase + 7584] := 1634300513;
  MemL[MsgBase + 7588] := 543517794;
  MemL[MsgBase + 7592] := 1629516897;
  MemL[MsgBase + 7596] := 1835627552;
  MemL[MsgBase + 7600] := 101;
  { initial values for one global variable at a time }
  MemL[MsgBase + 7616] := 1918988311;
  MemL[MsgBase + 7620] := 1952804193;
  MemL[MsgBase + 7624] := 1847620197;
  MemL[MsgBase + 7628] := 543518049;
  MemL[MsgBase + 7632] := 1701869669;
  MemL[MsgBase + 7636] := 1684370531;
  { parameter name expected }
  MemL[MsgBase + 7680] := 1918988311;
  MemL[MsgBase + 7684] := 1952804193;
  MemL[MsgBase + 7688] := 1948283493;
  MemL[MsgBase + 7692] := 543518841;
  MemL[MsgBase + 7696] := 1701869669;
  MemL[MsgBase + 7700] := 1684370531;
  { parameter type expected }
  MemL[MsgBase + 7744] := 1853187622;
  MemL[MsgBase + 7748] := 1869182051;
  MemL[MsgBase + 7752] := 1701978222;
  MemL[MsgBase + 7756] := 1953265011;
  MemL[MsgBase + 7760] := 1918967923;
  MemL[MsgBase + 7764] := 1952522341;
  MemL[MsgBase + 7768] := 1936682272;
  MemL[MsgBase + 7772] := 892477556;
  MemL[MsgBase + 7776] := 2036473910;
  MemL[MsgBase + 7780] := 7562612;
  { function results are at most 256 bytes }
  MemL[MsgBase + 7808] := 1919705360;
  MemL[MsgBase + 7812] := 2036621669;
  MemL[MsgBase + 7816] := 1667589152;
  MemL[MsgBase + 7820] := 1701994860;
  MemL[MsgBase + 7824] := 100;
  { already declared }
  MemL[MsgBase + 7872] := 1869770780;
  MemL[MsgBase + 7876] := 1969513827;
  MemL[MsgBase + 7880] := 544433522;
  MemL[MsgBase + 7884] := 1953719662;
  MemL[MsgBase + 7888] := 1948279909;
  MemL[MsgBase + 7892] := 1679847279;
  MemL[MsgBase + 7896] := 1819305317;
  MemL[MsgBase + 7900] := 121;
  { procedures nested too deeply }
  MemL[MsgBase + 7936] := 1869575204;
  MemL[MsgBase + 7940] := 1851878688;
  MemL[MsgBase + 7944] := 1953702009;
  MemL[MsgBase + 7948] := 1952675186;
  MemL[MsgBase + 7952] := 1684370037;
  MemL[MsgBase + 7956] := 1818326560;
  MemL[MsgBase + 7960] := 1881171317;
  MemL[MsgBase + 7964] := 1835102817;
  MemL[MsgBase + 7968] := 1919251557;
  MemL[MsgBase + 7972] := 115;
  { too many structured value parameters }
  MemL[MsgBase + 8000] := 1650551832;
  MemL[MsgBase + 8004] := 544435301;
  MemL[MsgBase + 8008] := 543519329;
  MemL[MsgBase + 8012] := 544501614;
  MemL[MsgBase + 8016] := 1886418291;
  MemL[MsgBase + 8020] := 1702130287;
  MemL[MsgBase + 8024] := 100;
  { labels are not supported }
  MemL[MsgBase + 8064] := 1195721230;
  MemL[MsgBase + 8068] := 1696616009;
  MemL[MsgBase + 8072] := 1667592312;
  MemL[MsgBase + 8076] := 6579572;
  { BEGIN expected }
  MemL[MsgBase + 8128] := 1869770779;
  MemL[MsgBase + 8132] := 1969513827;
  MemL[MsgBase + 8136] := 1847616882;
  MemL[MsgBase + 8140] := 1763734639;
  MemL[MsgBase + 8144] := 1701605485;
  MemL[MsgBase + 8148] := 1953391981;
  MemL[MsgBase + 8152] := 540697701;
  { procedure not implemented:  }
  MemL[MsgBase + 8192] := 1768846610;
  MemL[MsgBase + 8196] := 1634607220;
  MemL[MsgBase + 8200] := 1696621933;
  MemL[MsgBase + 8204] := 1667592312;
  MemL[MsgBase + 8208] := 6579572;
  { unit name expected }
  MemL[MsgBase + 8256] := 1869575182;
  MemL[MsgBase + 8260] := 1851878688;
  MemL[MsgBase + 8264] := 1853169785;
  MemL[MsgBase + 8268] := 7566441;
  { too many units }
  MemL[MsgBase + 8320] := 1696611082;
  MemL[MsgBase + 8324] := 1667592312;
  MemL[MsgBase + 8328] := 6579572;
  { ; expected }
  MemL[MsgBase + 8384] := 1768846626;
  MemL[MsgBase + 8388] := 1965060980;
  MemL[MsgBase + 8392] := 1696621939;
  MemL[MsgBase + 8396] := 543712097;
  MemL[MsgBase + 8400] := 1701344367;
  MemL[MsgBase + 8404] := 1852383346;
  MemL[MsgBase + 8408] := 1663066400;
  MemL[MsgBase + 8412] := 1818456681;
  MemL[MsgBase + 8416] := 2112101;
  { units use each other in a circle:  }
  MemL[MsgBase + 8448] := 544173585;
  MemL[MsgBase + 8452] := 1836019570;
  MemL[MsgBase + 8456] := 1919903264;
  MemL[MsgBase + 8460] := 1768846624;
  MemL[MsgBase + 8464] := 8308;
  { no room for unit  }
  MemL[MsgBase + 8512] := 1768846608;
  MemL[MsgBase + 8516] := 1869488244;
  MemL[MsgBase + 8520] := 1868963956;
  MemL[MsgBase + 8524] := 979660405;
  MemL[MsgBase + 8528] := 32;
  { unit not found:  }
  MemL[MsgBase + 8576] := 1229870349;
  MemL[MsgBase + 8580] := 2019893332;
  MemL[MsgBase + 8584] := 1952671088;
  MemL[MsgBase + 8588] := 25701;
  { UNIT expected }
  MemL[MsgBase + 8640] := 1701344268;
  MemL[MsgBase + 8644] := 1768846624;
  MemL[MsgBase + 8648] := 1852383348;
  MemL[MsgBase + 8652] := 32;
  { the unit in  }
  MemL[MsgBase + 8704] := 1414416658;
  MemL[MsgBase + 8708] := 1095127621;
  MemL[MsgBase + 8712] := 1696613699;
  MemL[MsgBase + 8716] := 1667592312;
  MemL[MsgBase + 8720] := 6579572;
  { INTERFACE expected }
  MemL[MsgBase + 8768] := 1347242263;
  MemL[MsgBase + 8772] := 1162691916;
  MemL[MsgBase + 8776] := 1413567566;
  MemL[MsgBase + 8780] := 542003017;
  MemL[MsgBase + 8784] := 1701869669;
  MemL[MsgBase + 8788] := 1684370531;
  { IMPLEMENTATION expected }
  MemL[MsgBase + 8832] := 1696607777;
  MemL[MsgBase + 8836] := 1667592312;
  MemL[MsgBase + 8840] := 543450484;
  MemL[MsgBase + 8844] := 1948284001;
  MemL[MsgBase + 8848] := 1696621928;
  MemL[MsgBase + 8852] := 1864393838;
  MemL[MsgBase + 8856] := 1752440934;
  MemL[MsgBase + 8860] := 1853169765;
  MemL[MsgBase + 8864] := 29801;
  { . expected at the end of the unit }
  MemL[MsgBase + 8896] := 1869770773;
  MemL[MsgBase + 8900] := 1835102823;
  MemL[MsgBase + 8904] := 1835101728;
  MemL[MsgBase + 8908] := 2019893349;
  MemL[MsgBase + 8912] := 1952671088;
  MemL[MsgBase + 8916] := 25701;
  { program name expected }
  MemL[MsgBase + 8960] := 1696607780;
  MemL[MsgBase + 8964] := 1667592312;
  MemL[MsgBase + 8968] := 543450484;
  MemL[MsgBase + 8972] := 1948284001;
  MemL[MsgBase + 8976] := 1696621928;
  MemL[MsgBase + 8980] := 1864393838;
  MemL[MsgBase + 8984] := 1752440934;
  MemL[MsgBase + 8988] := 1919950949;
  MemL[MsgBase + 8992] := 1634887535;
  MemL[MsgBase + 8996] := 109;
  { . expected at the end of the program }
  msgsBuilt := true;
end;

{ message n from the table, then extra }
procedure ErrorN(n: integer; const extra: string);
var i, k: integer;
    a: longint;
begin
  if not msgsBuilt then BuildMessages;
  a := MsgBase + longint(n) * 64;
  k := Mem[a];
  ErrMsg[0] := chr(k);
  for i := 1 to k do ErrMsg[i] := chr(Mem[a + i]);
  if extra <> '' then ErrMsg := ErrMsg + extra;
  ErrUnit := curFile;
  ErrLine := tokLine;
  ErrCol := tokCol;
  ThrowError;
end;

{ ================================================================ scanner }
const
  { directives: the defined names (16 bytes each) and the stack of open
    include files (32 bytes a level) are in expansion RAM, not in bank 0 }
  DefBase = $3D0000;  MaxDef = 32;
  IncBase = $3D0400;  MaxInc = 8;

{ the end of an include file: back to the text that included it }
procedure IncludeEnd;
var a: longint;
    k: integer;
begin
  incDepth := incDepth - 1;
  a := IncBase + longint(incDepth) * 32;
  curBase := MemL[a]; srcPos := MemL[a + 4]; srcEnd := MemL[a + 8];
  line := MemW[a + 12]; col := MemW[a + 14]; ch := chr(Mem[a + 16]);
  for k := 0 to Mem[a + 17] do curFile[k] := chr(Mem[a + 17 + k]);
end;

procedure NextCh;
begin
  if srcPos < srcEnd then begin
    ch := chr(Mem[curBase + srcPos]);
    srcPos := srcPos + 1;
    if ch = #10 then begin line := line + 1; col := 0; end
    else col := col + 1;
    if ch = #13 then ch := ' ';
    if ch = #9 then ch := ' ';
  end else if incDepth > 0 then IncludeEnd
  else ch := #0;
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

{ a directive's word, in upper case (built char by char: no string
  temporaries, Next can run deep in an expression) }
procedure DirWord(var s: TName);
var n: integer;
begin
  n := 0;
  while ((ch >= 'A') and (ch <= 'Z')) or ((ch >= 'a') and (ch <= 'z')) or ((ch >= '0') and (ch <= '9')) or
        (ch = '_') or (ch = '.') or (ch = '-') or (ch = '~') do begin
    if n < 15 then begin n := n + 1; s[n] := UpCase(ch); end;
    NextCh;
  end;
  s[0] := chr(n);
end;

function DefIndex(const n: TName): integer;
var i, k: integer;
    a: longint;
    ok: boolean;
begin
  DefIndex := 0;
  for i := 1 to nDef do begin
    a := DefBase + longint(i - 1) * 16;
    if Mem[a] = length(n) then begin
      ok := true;
      for k := 1 to length(n) do if Mem[a + k] <> ord(n[k]) then ok := false;
      if ok then begin DefIndex := i; exit; end;
    end;
  end;
end;

procedure DefineName(const n: TName);
var k: integer;
    a: longint;
begin
  if (n = '') or (DefIndex(n) <> 0) then exit;
  if nDef >= MaxDef then ErrorN(1, '');
  a := DefBase + longint(nDef) * 16;
  nDef := nDef + 1;
  for k := 0 to length(n) do Mem[a + k] := ord(n[k]);
end;

procedure UndefName(const n: TName);
var i, k: integer;
begin
  i := DefIndex(n);
  if i = 0 then exit;
  { the last one takes its place }
  for k := 0 to 15 do Mem[DefBase + longint(i - 1) * 16 + k] := Mem[DefBase + longint(nDef - 1) * 16 + k];
  nDef := nDef - 1;
end;

{ skip the text of a false branch, up to the matching ELSE (when elseOk)
  or ENDIF; IFDEFs inside are skipped whole, comments and strings too }
procedure SkipBranch(elseOk: boolean);
var nest: integer;
    d: TName;
begin
  nest := 0;
  while ch <> #0 do begin
    if ch = '{' then begin
      NextCh;
      if ch = '$' then begin
        NextCh;
        DirWord(d);
        if (d = 'IFDEF') or (d = 'IFNDEF') or (d = 'IFOPT') then nest := nest + 1
        else if d = 'ENDIF' then begin
          if nest = 0 then begin SkipComment('}'); condDepth := condDepth - 1; exit; end;
          nest := nest - 1;
        end
        else if (d = 'ELSE') and (nest = 0) and elseOk then begin SkipComment('}'); exit; end;
      end;
      SkipComment('}');
    end
    else if ch = '''' then begin
      NextCh;
      while (ch <> '''') and (ch <> #10) and (ch <> #0) do NextCh;
      NextCh;
    end
    else if ch = '(' then begin
      NextCh;
      if ch = '*' then begin NextCh; SkipComment(')'); end;
    end
    else NextCh;
  end;
  ErrorN(2, '');
end;

{ include file: the text goes on in the file; NextCh comes back at its end }
procedure IncludeFile(const n: TName);
var a, got: longint;
    k: integer;
    fname: string[12];
begin
  if incDepth >= MaxInc then ErrorN(3, '');
  fname := n;
  if Pos('.', fname) = 0 then fname := fname + '.PAS';
  if unitTop >= $2F0000 then ErrorN(4, fname);
  got := LoadFile(fname, unitTop, $300000 - unitTop);
  if got < 0 then ErrorN(5, fname + ' (' + DosErrorText(DosError) + ')');
  a := IncBase + longint(incDepth) * 32;
  MemL[a] := curBase; MemL[a + 4] := srcPos; MemL[a + 8] := srcEnd;
  MemW[a + 12] := line; MemW[a + 14] := col; Mem[a + 16] := ord(ch);
  for k := 0 to length(curFile) do Mem[a + 17 + k] := ord(curFile[k]);
  incDepth := incDepth + 1;
  curFile := fname;
  curBase := unitTop; srcPos := 0; srcEnd := got; line := 1; col := 0;
  unitTop := (unitTop + got + 255) and $FFFF00;
  NextCh;
end;

{ after the dollar of a directive: DEFINE UNDEF IFDEF IFNDEF ELSE ENDIF and
  I / INCLUDE; the others (SCHUB, R+ ...) are skipped like comments }
procedure Directive;
var d, a: TName;
    yes, on: boolean;
    c: char;
begin
  { switches: R+ Q- I+, several with commas }
  if (((ch >= 'A') and (ch <= 'Z')) or ((ch >= 'a') and (ch <= 'z'))) and (srcPos < srcEnd) and
     ((Mem[curBase + srcPos] = ord('+')) or (Mem[curBase + srcPos] = ord('-'))) then begin
    repeat
      c := UpCase(ch); NextCh;
      on := ch = '+'; NextCh;
      if c = 'R' then swR := on else if c = 'Q' then swQ := on else if c = 'I' then swI := on
      else if c = 'D' then swD := on;
      while ch = ' ' do NextCh;
      if ch <> ',' then break;
      NextCh;
      while ch = ' ' do NextCh;
    until false;
    SkipComment('}');
    exit;
  end;
  DirWord(d);
  while ch = ' ' do NextCh;
  if (d = 'I') and (ch <> '+') and (ch <> '-') then d := 'INCLUDE';
  DirWord(a);
  if d = 'DEFINE' then DefineName(a)
  else if d = 'UNDEF' then UndefName(a)
  else if (d = 'IFDEF') or (d = 'IFNDEF') then begin
    condDepth := condDepth + 1;
    yes := DefIndex(a) <> 0;
    if d = 'IFNDEF' then yes := not yes;
    if not yes then begin SkipComment('}'); SkipBranch(true); exit; end;
  end
  else if d = 'ELSE' then begin
    if condDepth = 0 then ErrorN(6, '');
    SkipComment('}'); SkipBranch(false); exit;
  end
  else if d = 'ENDIF' then begin
    if condDepth = 0 then ErrorN(7, '');
    condDepth := condDepth - 1;
  end
  else if d = 'INCLUDE' then begin
    SkipComment('}');
    IncludeFile(a);
    exit;
  end;
  SkipComment('}');
end;

{ IEEE single bits of a real written as text }
function RealOf(const t: string): longint;
var u: TRealBits;
    code: integer;
begin
  Val(t, u.r, code);
  if code <> 0 then ErrorN(8, t);
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
    if ch = '{' then begin
      NextCh;
      if ch = '$' then begin NextCh; Directive; end else SkipComment('}');
      done := false;
    end;
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
            if (ch = #0) or (ch = #10) then ErrorN(9, '');
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
    ErrorN(10, ch + '''');
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
  if rv then begin if pc > $1FFF0 then ErrorN(11, ''); end
  else if pc > $FFF0 then ErrorN(12, '');
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
  if nType >= MaxType then ErrorN(13, '');
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
  if nSym >= MaxSym then ErrorN(14, '');
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
  if i < 0 then ErrorN(15, n);
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
    aRtError := RtAdr('rt_error');
    aMemmove := RtAdr('rt_memmove'); aDbgHook := RtAdr('rt_dbghook');
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
  aRtError := RtAdr('rt_error');
  aDbgHook := RtAdr('rt_dbghook');
end;

function LibProc(const n: TName): integer;
var s: integer;
begin
  s := Find(n);
  if (s = 0) or (syms[s].kind <> skProc) then ErrorN(16, n);
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
    if dataTop + size > $50000 then ErrorN(17, '');
  end else if UserData + dataTop + size > $9000 then ErrorN(17, '');
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
  if ctxFrozen[curLev] then ErrorN(18, '');
  if rv then ctxLoc[curLev] := (ctxLoc[curLev] + 3) and $FFFC;
  AllocLocal := ctxLoc[curLev];
  ctxLoc[curLev] := ctxLoc[curLev] + size;
end;

{ a local variable: small ones now, large ones once all are declared }
procedure LocalVar(s: integer);
begin
  if types[syms[s].typ].size <= 8 then syms[s].adr := AllocLocal(types[syms[s].typ].size)
  else begin
    if ctxFrozen[curLev] then ErrorN(18, '');
    if defN[curLev] >= 24 then ErrorN(19, '');
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
      ErrorN(20, '');
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
    ErrorN(20, '');
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
      ErrorN(21, '');
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
    ErrorN(21, '');
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
    if skip <> 3 then ErrorN(22, '');
    if c = cEq then RB(0, rA0, rZero, 8) else if c = cNe then RB(1, rA0, rZero, 8)
    else ErrorN(23, '');
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
  if x.typ <> tBool then ErrorN(24, '');
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
  if x.typ <> tBool then ErrorN(25, '');
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
  if x.typ <> tBool then ErrorN(25, '');
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
  if types[x.typ].form <> fStr then ErrorN(26, '');
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
  if not IsInt(x.typ) then ErrorN(27, '');
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
    if xf <> fInt then ErrorN(28, '');
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
    if xf <> fBool then ErrorN(24, '');
    LoadBool(x); exit;
  end;
  if tf = fChar then begin
    if xf <> fChar then ErrorN(29, '');
    Load(x); exit;
  end;
  if tf = fEnum then begin
    if x.typ <> t then if not ((xf = fEnum) and (types[x.typ].base = t)) then ErrorN(30, '');
    Load(x); exit;
  end;
  if tf = fPtr then begin
    if not (xf in [fPtr, fNil]) then ErrorN(31, '');
    Load(x); exit;
  end;
  ErrorN(30, '');
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
      ErrorN(32, '');
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
    ErrorN(32, '');
  end;
end;

{ before the value of an assignment is computed: park a computed address }
procedure PrepStore(var x: TItem);
begin
  if rv then begin
    if x.mode = mInd then begin RPush(rA0); x.mode := mStk; end
    else if x.mode = mFar then begin RPush(rA0); x.mode := mFarStk; end
    else if not (x.mode in [mGlob, mLoc, mFarC]) then ErrorN(20, '');
    exit;
  end;
  if x.mode = mInd then begin Gen($48); x.mode := mStk; end
  else if x.mode = mFar then begin Gen($DA); Gen($48); x.mode := mFarStk; end
  else if not (x.mode in [mGlob, mLoc, mFarC]) then ErrorN(20, '');
end;

{ ================================================================ expressions }
procedure Expression(var x: TItem); forward;
procedure Designator(var x: TItem; s: integer); forward;
procedure CallProc(s: integer; var x: TItem); forward;

function ConstExpr: longint;
var x: TItem;
begin
  Expression(x);
  if x.mode <> mConst then ErrorN(33, '');
  ConstExpr := x.a;
end;

procedure ParseTypeIdent(var t: integer);
var s: integer;
begin
  if sym = sStringKw then begin Next; t := tString; exit; end;
  if sym <> sIdent then ErrorN(34, '');
  s := Find(id);
  if (s = 0) or (syms[s].kind <> skType) then ErrorN(35, id);
  t := syms[s].typ;
  Next;
end;

{ x := typecast(x) to t }
procedure Cast(var x: TItem; t: integer);
begin
  if IsStruct(t) or IsStruct(x.typ) then begin
    if types[t].size <> types[x.typ].size then ErrorN(36, '');
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

{ ---- the switches R+ and Q+: runtime errors 201 and 215 }
{ the jump to the runtime error: 65C816 rep #$30 / lda #code / jml rt_error
  (9 bytes, from any register width), RISC-V li a0 / call rt_error (12) }
procedure ErrJump(code: integer);
begin
  if rv then begin RLi(rA0, code); RCall(aRtError); end
  else begin Op8($C2, $30); Op16($A9, code); Op24($5C, aRtError); end;
end;

{ the value just loaded (type t: A, X:A for a 32-bit one; RISC-V a0) within
  lo..hi, else runtime error code; the value stays }
procedure RangeCheck(t: integer; lo, hi: longint; code: integer);
var sg: boolean;
begin
  if hi < lo then exit;                          { an open array (see OpenCheck) }
  if (lo <= types[t].lo) and (hi >= types[t].hi) then exit;
  sg := types[t].sgn;
  if rv then begin
    if lo > types[t].lo then begin
      RLi(rT1, lo); if sg then RB(5, rA0, rT1, 16) else RB(7, rA0, rT1, 16); ErrJump(code);
    end;
    if hi < types[t].hi then begin
      RLi(rT1, hi); if sg then RB(5, rT1, rA0, 16) else RB(7, rT1, rA0, 16); ErrJump(code);
    end;
    exit;
  end;
  if IsLong(t) then begin
    if lo >= 0 then begin
      { the high word 0, then the low one unsigned }
      Op16($E0, 0); Op8($F0, 9); ErrJump(code);         { cpx #0 / beq ok }
      sg := false;
    end else begin
      { the high word the sign of the low one, then the low one signed }
      Op16($E0, 0); Op8($D0, 5); Op16($C9, $8000); Op8($90, 19);
      Op16($E0, $FFFF); Op8($D0, 5); Op16($C9, $8000); Op8($B0, 9);
      ErrJump(code);
      sg := true;
    end;
  end;
  if sg then begin
    if lo < -32768 then lo := -32768;
    if hi > 32767 then hi := 32767;
    Gen($48);                                            { pha }
    if lo > -32768 then begin
      { sec / sbc #lo / bvc +3 / eor #$8000 / bpl ok }
      Gen($38); Op16($E9, lo); Op8($50, 3); Op16($49, $8000); Op8($10, 9); ErrJump(code);
    end;
    if hi < 32767 then begin
      { lda #hi / sec / sbc 1,s / bvc +3 / eor #$8000 / bpl ok }
      Op16($A9, hi); Gen($38); Op8($E3, 1); Op8($50, 3); Op16($49, $8000); Op8($10, 9); ErrJump(code);
    end;
    Gen($68);                                            { pla }
  end else begin
    if lo < 0 then lo := 0;
    if hi > 65535 then hi := 65535;
    if lo > 0 then begin Op16($C9, lo); Op8($B0, 9); ErrJump(code); end;          { cmp #lo / bcs ok }
    if hi < 65535 then begin Op16($C9, hi + 1); Op8($90, 9); ErrJump(code); end;  { cmp #hi+1 / bcc ok }
  end;
end;

function IsOpenArr(t: integer): boolean;
begin
  IsOpenArr := (types[t].form = fArr) and (types[t].hi < types[t].lo);
end;

{ the hidden last index of the open array parameter a variable is }
function OpenHigh(const n: TName): integer;
var k: integer;
begin
  k := Find(Copy(n, 1, 14) + '$');
  if k = 0 then ErrorN(67, '');
  OpenHigh := k;
end;

{ $R+ on an open array: the index (A / a0) in 0..its hidden last index }
procedure OpenCheck(hs: integer);
var h: TItem;
begin
  if rv then begin
    RMv(rA2, rA0);
    Designator(h, hs); Load(h);
    RB(4, rA0, rA2, 12);                      { high < index }
    RB(4, rA2, rZero, 8);                     { index < 0 }
    W32(JEnc(rZero, 16));
    ErrJump(201);
    RMv(rA0, rA2);
  end else begin
    Gen($48);                                 { pha }
    Designator(h, hs); Load(h);
    Gen($38); Op8($E3, 1);                    { sec / sbc 1,s: high - index }
    Op8($50, 3); Op16($49, $8000);
    Op8($30, 4);                              { bmi bad }
    Op8($A3, 1); Op8($10, 9);                 { lda 1,s / bpl ok }
    ErrJump(201);
    Gen($68);                                 { pla }
  end;
end;

{ RISC-V: a0 holds a 16-bit result as 32 bits: it must be what its 16 bits say }
procedure RvFits16(sgn: boolean);
begin
  RSlli(rT0, rA0, 16);
  if sgn then RSrai(rT0, rT0, 16) else RSrli(rT0, rT0, 16);
  RB(0, rT0, rA0, 16); ErrJump(215);
end;

procedure Selector(var x: TItem);
var y: TItem;
    t, f, esz, k, oh: integer;
    khi: longint;
    s: TName;
begin
  oh := openHi;                     { (an index expression changes openHi) }
  repeat
    if sym = sPeriod then begin
      Next;
      if types[x.typ].form <> fRec then ErrorN(37, '');
      if sym <> sIdent then ErrorN(38, '');
      f := types[x.typ].fields;
      while (f <> 0) and (syms[f].name <> id) do f := syms[f].next;
      if f = 0 then ErrorN(39, id);
      Next;
      if x.mode in [mGlob, mLoc, mInd, mFarC] then x.a := x.a + syms[f].adr
      else ErrorN(40, '');
      x.typ := syms[f].typ;
      if not rv and (x.mode = mLoc) and (x.a + types[x.typ].size > 255) then begin LoadAdr(x); x.mode := mInd; x.a := 0; end;
    end else if sym = sLbrak then begin
      Next;
      repeat
        t := x.typ;
        if types[t].form = fStr then begin esz := 1; x.typ := tChar; k := 0; khi := types[t].hi; end
        else if types[t].form = fArr then begin
          esz := types[types[t].base].size; x.typ := types[t].base; k := types[t].lo; khi := types[t].hi;
        end else ErrorN(41, '');
        if not (x.mode in [mGlob, mLoc, mInd]) then ErrorN(42, '');
        { a computed base address must survive the index expression }
        if x.mode = mInd then begin PushA(2); x.mode := mStk; end;
        Expression(y);
        if not IsOrd(y.typ) then ErrorN(43, '');
        if (y.mode = mConst) then begin
          if x.mode = mStk then begin if rv then RPop(rA0) else Gen($68); x.mode := mInd; end;
          x.a := x.a + (y.a - k) * esz;
          if not rv and (x.mode = mLoc) and (x.a + esz > 255) then begin LoadAdr(x); x.mode := mInd; x.a := 0; end;
        end else if rv then begin
          LoadBool(y);
          if y.mode <> mReg then Load(y);
          if swR then RangeCheck(y.typ, k, khi, 201);
          if swR and (khi < k) and (oh <> 0) then OpenCheck(oh);
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
          if swR then RangeCheck(y.typ, k, khi, 201);
          if swR and (khi < k) and (oh <> 0) then OpenCheck(oh);
          if k <> 0 then begin Gen($38); Op16($E9, k); end;
          if esz = 2 then Gen($0A)
          else if esz = 4 then begin Gen($0A); Gen($0A); end
          else if esz = 8 then begin Gen($0A); Gen($0A); Gen($0A); end
          else if esz <> 1 then begin LdxImm(esz); Jsl(aMul16); end;
          case x.mode of
            mGlob: begin Gen($18); Op16($69, x.a); x.a := 0; end;
            mLoc: begin StaAbs(aT0); Gen($7B); Gen($18); Op16($69, x.a); Gen($18); Op16($6D, aT0); x.a := 0; end;
            mStk: begin Gen($18); Op8($63, 1); Gen($7A); end;      { clc / adc 1,s / ply }
            mInd: ErrorN(44, '');
          end;
          x.mode := mInd;
        end;
        if sym = sComma then Next else break;
      until false;
      Expect(sRbrak);
    end else if sym = sCaret then begin
      Next;
      if types[x.typ].form <> fPtr then ErrorN(31, '');
      if types[x.typ].base = 0 then ErrorN(45, '');
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
  if IsOpenArr(x.typ) then openHi := OpenHigh(syms[s].name) else openHi := 0;
  Selector(x);
end;

procedure MemDesignator(var x: TItem; sz: integer);
var y: TItem;
begin
  Expect(sLbrak);
  Expression(y);
  Expect(sRbrak);
  if not IsInt(y.typ) then ErrorN(46, '');
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
  if sym <> sIdent then ErrorN(20, '');
  if WithField(x) then exit;
  s := Find(id);
  if (s = 0) or (syms[s].kind <> skVar) then ErrorN(47, id);
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
    sSlash: begin if v.r = 0.0 then ErrorN(48, ''); u.r := u.r / v.r; end;
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
  if not IsNum(x.typ) or not IsNum(y.typ) then ErrorN(49, '');
  case op of
    sPlus: n := '_addreal';
    sMinus: n := '_subreal';
    sTimes: n := '_mulreal';
    sSlash: n := '_divreal';
  else
    ErrorN(50, '');
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
  if types[x.typ].form <> fSet then ErrorN(51, '');
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
      if not IsOrd(e.typ) then ErrorN(52, '');
      LoadBool(e); PushA(2);
      if sym = sDotdot then begin
        Next; Expression(h);
        if not IsOrd(h.typ) then ErrorN(52, '');
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
    nm: TName;
    u: TRealBits;
begin
  Expect(sLparen);
  if (n = 'sizeof') or (n = 'low') or (n = 'high') then begin
    k := 0;
    nm := id;
    if sym = sIdent then begin
      k := Find(id);
      if (k <> 0) and (syms[k].kind = skType) then begin t := syms[k].typ; Next; end else k := 0;
    end else if sym = sStringKw then begin Next; t := tString; k := 1; end;
    if k = 0 then begin Expression(y); t := y.typ; end;
    Expect(sRparen);
    if IsOpenArr(t) then begin
      { an open array parameter: 0, its hidden last index, the size from it }
      if n = 'low' then MakeConst(x, 0, tInteger)
      else begin
        Designator(x, OpenHigh(nm));
        if n = 'sizeof' then begin
          Load(x);
          if rv then begin RAddi(rA0, rA0, 1); RLi(rT1, types[types[t].base].size); RR(1, 0, rA0, rA0, rT1); end
          else begin Gen($1A); LdxImm(types[types[t].base].size); Jsl(aMul16); end;
          x.mode := mReg; x.typ := tInteger;
        end;
      end;
      exit;
    end;
    if n = 'sizeof' then MakeConst(x, types[t].size, tInteger)
    else if types[t].form = fArr then begin
      if n = 'low' then MakeConst(x, types[t].lo, tInteger) else MakeConst(x, types[t].hi, tInteger);
    end else if n = 'low' then MakeConst(x, types[t].lo, t) else MakeConst(x, types[t].hi, t);
    if (types[t].form = fStr) and (n <> 'sizeof') then if n = 'low' then MakeConst(x, 0, tInteger) else MakeConst(x, types[t].hi, tInteger);
    exit;
  end;
  Expression(x);
  if n = 'ord' then begin
    if not IsOrd(x.typ) then ErrorN(53, '');
    if x.mode = mCond then LoadBool(x);
    { a 1-byte value is loaded as it is before it becomes an integer (else
      two bytes would be read) }
    if (x.mode <> mConst) and (types[x.typ].size = 1) then Load(x);
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
        if IsLong(t) then begin
          { clc adc #1 bcc +1 inx / sec sbc #1 bcs +1 dex }
          if n = 'succ' then begin Gen($18); Op16($69, 1); Op8($90, 1); Gen($E8); end
          else begin Gen($38); Op16($E9, 1); Op8($B0, 1); Gen($CA); end;
        end
        else if n = 'succ' then Gen($1A) else Gen($3A);
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
      if IsLong(x.typ) then ErrorN(54, '');
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
      if types[x.typ].form <> fStr then ErrorN(26, '');
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
  end else if n = 'swap' then begin
    { the two bytes of the low word, as the PC compiler does: a word
      (an integer for an integer) }
    if not IsInt(x.typ) then ErrorN(28, '');
    t := x.typ;
    if types[t].size <> 2 then t := tWord;
    if x.mode = mConst then begin
      x.a := ((x.a shr 8) and 255) or ((x.a and 255) shl 8);
      if types[t].sgn and (x.a > 32767) then x.a := x.a - 65536;
    end else begin
      Load(x);
      if rv then begin
        RI($13, 7, rT0, rA0, 255); RSlli(rT0, rT0, 8); RSrli(rA0, rA0, 8); RI($13, 7, rA0, rA0, 255);
        RR(0, 6, rA0, rA0, rT0); RNormSz(rA0, 2, types[t].sgn);
      end else Gen($EB);                                                 { xba }
      x.mode := mReg;
    end;
    x.typ := t;
  end else ErrorN(55, n);
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
        if not IsOrd(lo.typ) then ErrorN(52, '');
        if lo.mode <> mConst then begin LoadBool(lo); RPush(rA0); end;
        single := sym <> sDotdot;
        if not single then begin
          Next; Expression(hi);
          if not IsOrd(hi.typ) then ErrorN(52, '');
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
      if not IsOrd(lo.typ) then ErrorN(52, '');
      if lo.mode <> mConst then begin LoadBool(lo); StaAbs(aSpare + 14); end;
      single := sym <> sDotdot;
      if not single then begin
        Next; Expression(hi);
        if not IsOrd(hi.typ) then ErrorN(52, '');
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

{ Concat(a, b, ...): the strings one after another in a temporary, like + }
procedure StdConcat(var x: TItem);
var y: TItem;
begin
  Expect(sLparen);
  Expression(x);
  if not IsStrish(x.typ) then ErrorN(26, '');
  while sym = sComma do begin
    Next;
    if not x.tmp then begin
      StrAdr(x); PushA(2);                       { source }
      AllocTmp; PushA(2);                        { keep the temporary }
      PushA(2);                                  { destination }
      LdaSlot(3); PushA(2);                      { source again }
      PeaW(255);
      LibCallPop('_strasg');
      PopA; DropSlot; PushA(2);                  { the temporary / drop the source / keep it }
    end else PushA(2);
    Expression(y);
    if not IsStrish(y.typ) then ErrorN(26, '');
    StrAdr(y);
    SaveB;                                        { source }
    LdaSlot(1); PushA(2);                         { destination }
    PushB;                                        { source }
    PeaW(255);
    LibCallPop('_strcat');
    PopA;                                         { the temporary }
    x.mode := mReg; x.typ := tString; x.tmp := true;
  end;
  Expect(sRparen);
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
          Load(x); Op16($49, $FFFF);
          { the high word: pha txa eor #$FFFF tax pla }
          if IsLong(x.typ) then begin Gen($48); Gen($8A); Op16($49, $FFFF); Gen($AA); Gen($68); end;
        end;
      end else ErrorN(56, '');
    end;
    sNil: begin MakeConst(x, 0, tNil); Next; end;
    sStringKw: begin
      { string(s): a cast that leaves a string as it is }
      Next; Expect(sLparen); Expression(x); Expect(sRparen);
      if not IsStrish(x.typ) then ErrorN(26, '');
    end;
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
         (id = 'int') or (id = 'frac') or (id = 'sqrt') or (id = 'swap') then begin
        str := id; Next; StdFunc(str, x); exit;
      end;
      if (id = 'addr') and (Find(id) = 0) then begin
        { Addr(v) = @v }
        Next; Expect(sLparen);
        VarDesignator(x);
        LoadAdr(x);
        x.typ := tPointer;
        Expect(sRparen);
        exit;
      end;
      if (id = 'concat') and (Find(id) = 0) then begin Next; StdConcat(x); exit; end;
      s := Find(id);
      if s = 0 then ErrorN(57, id);
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
          if syms[s].typ = 0 then ErrorN(58, '');
          if (syms[s].flags and 4 = 0) and (sym <> sLparen) and (s = ctxProc[curLev]) then
            ErrorN(59, '');
          CallProc(s, x);
          if types[x.typ].form in [fRec, fArr] then begin
            x.mode := mInd; x.a := 0; x.tmp := false;   { the buffer is released with the statement }
            Selector(x);
          end;
        end;
      else
        ErrorN(21, '');
      end;
    end;
  else
    ErrorN(60, '');
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
    sDiv: begin if b = 0 then ErrorN(48, ''); Fold := a div b; end;
    sMod: begin if b = 0 then ErrorN(48, ''); Fold := a mod b; end;
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
var long, sg, ovfMul, uq: boolean;
    rt, resT: integer;
    at: longint;
begin
  if IsReal(x.typ) or IsReal(y.typ) then begin RealArith(op, x, y); exit; end;
  if not IsInt(x.typ) or not IsInt(y.typ) then ErrorN(61, '');
  if (x.mode = mConst) and (y.mode = mConst) then begin
    MakeConst(x, Fold(op, x.a, y.a), tInteger);
    x.typ := IntTypeFor(x.a);
    exit;
  end;
  long := IsLong(x.typ) or IsLong(y.typ) or (x.mode = mConst) and (IntTypeFor(x.a) = tLong) or
          (y.mode = mConst) and (IntTypeFor(y.a) = tLong);
  sg := types[x.typ].sgn or types[y.typ].sgn;
  { the overflow check is unsigned when both sides are (a constant that is not
    negative counts as unsigned), as in the PC compiler }
  uq := (not types[x.typ].sgn or ((x.mode = mConst) and (x.a >= 0))) and
        (not types[y.typ].sgn or ((y.mode = mConst) and (y.a >= 0)));
  if rv then begin
    if x.mode = mConst then begin Load(y); RLi(rA1, x.a); end
    else if y.mode = mConst then begin RPop(rA1); RLi(rA0, y.a); end
    else begin Load(y); RPop(rA1); end;
    if not long and (op = sShr) then RNormSz(rA1, 2, false);
    if swQ and long and ((op = sPlus) or (op = sMinus) or (op = sTimes)) then begin
      { 32 bit: the result in t2, checked, then a0 }
      if op = sPlus then begin
        RR(0, 0, rT2, rA1, rA0); RR(0, 4, rT0, rA1, rT2); RR(0, 4, rT1, rA0, rT2);
      end else if op = sMinus then begin
        RR($20, 0, rT2, rA1, rA0); RR(0, 4, rT0, rA1, rA0); RR(0, 4, rT1, rA1, rT2);
      end;
      if op = sTimes then begin
        RR(1, 0, rT2, rA1, rA0); RR(1, 1, rT0, rA1, rA0); RSrai(rT1, rT2, 31);
        RB(0, rT0, rT1, 16); ErrJump(215);                 { mulh = the sign of mul }
      end else begin
        RR(0, 7, rT0, rT0, rT1); RB(5, rT0, rZero, 16); ErrJump(215);
      end;
      RMv(rA0, rT2);
      x.mode := mReg; x.typ := tLong;
      exit;
    end;
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
      if swQ and ((op = sPlus) or (op = sMinus) or (op = sTimes)) then RvFits16(not uq);
      RNormSz(rA0, 2, types[x.typ].sgn);
    end;
    exit;
  end;
  { 65C816, 16-bit multiplication with $Q+: in 32 bits, then the range }
  ovfMul := swQ and not long and (op = sTimes);
  if ovfMul then begin
    if uq then resT := tWord else resT := tInteger;
    long := true;
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
        LdaAbs(aA + 2); Op16(rt, aB + 2);
        if swQ and ((op = sPlus) or (op = sMinus)) then begin Op8($50, 9); ErrJump(215); end;   { bvc ok }
        Gen($AA); Gen($98);
      end;
      sTimes: if not swQ then Jsl(aMul32)
        else begin
          { a * b, then (when a <> 0) r div a must give b again: a, b, r in rt_spare }
          LdaAbs(aA); StaAbs(aSpare); LdaAbs(aA + 2); StaAbs(aSpare + 2);
          LdaAbs(aB); StaAbs(aSpare + 4); LdaAbs(aB + 2); StaAbs(aSpare + 6);
          Jsl(aMul32);
          StaAbs(aSpare + 8); Op16($8E, aSpare + 10);                  { stx }
          if ovfMul then begin
            { a 16-bit product: the 32-bit result in the range }
            RangeCheck(tLong, types[resT].lo, types[resT].hi, 215);
          end else begin
            LdaAbs(aSpare); Op16($0D, aSpare + 2);                     { ora: a = 0? }
            at := pc; Op8($F0, 0);
            LdaAbs(aSpare + 8); StaAbs(aA); LdaAbs(aSpare + 10); StaAbs(aA + 2);
            LdaAbs(aSpare); StaAbs(aB); LdaAbs(aSpare + 2); StaAbs(aB + 2);
            Jsl(aDiv32s);
            Op16($CD, aSpare + 4); Op8($D0, 5);                        { cmp / bne bad }
            Op16($EC, aSpare + 6); Op8($F0, 9);                        { cpx / beq ok }
            ErrJump(215);
            Mem[cBase + at + 1] := (pc - at - 2) and 255;
            LdaAbs(aSpare + 8); Op16($AE, aSpare + 10);                { lda / ldx: r }
          end;
        end;
      sDiv: Jsl(aDiv32s);
      sMod: Jsl(aMod32s);
      sShl: Jsl(aShl32);
      sShr: Jsl(aShr32);
    end;
    x.mode := mReg; x.typ := tLong;
    if ovfMul then x.typ := resT;
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
      sPlus: if (y.a = 1) and not swQ then Gen($1A) else begin Gen($18); Op16($69, y.a); end;
      sMinus: if (y.a = 1) and not swQ then Gen($3A) else begin Gen($38); Op16($E9, y.a); end;
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
  if swQ and ((op = sPlus) or (op = sMinus)) then begin
    { signed: no overflow (V); unsigned: no carry (+) / no borrow (-) }
    if not uq then Op8($50, 9) else if op = sPlus then Op8($90, 9) else Op8($B0, 9);
    ErrJump(215);
  end;
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
    if (op = sLss) or (op = sGtr) then ErrorN(62, '');
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
    if not IsNum(x.typ) or not IsNum(y.typ) then ErrorN(49, '');
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
    if IsInt(x.typ) <> IsInt(y.typ) then ErrorN(63, '');
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
  if IsInt(x.typ) <> IsInt(y.typ) then ErrorN(63, '');
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
        if y.typ <> tBool then ErrorN(24, '');
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
    if not IsNum(x.typ) then ErrorN(27, '');
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
        if y.typ <> tBool then ErrorN(24, '');
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
      if y.typ <> tBool then ErrorN(24, '');
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
    if not IsOrd(x.typ) then ErrorN(64, '');
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
      ErrorN(65, '');
    Relation(op, x, y);
  end;
end;

{ ================================================================ calls }
procedure PushArg(p: integer);
var x, h: TItem;
    s: integer;
    pt: integer;
    nm: TName;
begin
  pt := syms[p].typ;
  if IsOpenArr(pt) then begin
    nm := id;
    VarDesignator(x);
    if (types[x.typ].form <> fArr) or (types[types[x.typ].base].size <> types[types[pt].base].size) then ErrorN(67, '');
    LoadAdr(x); PushA(2);
    if IsOpenArr(x.typ) then begin
      Designator(h, OpenHigh(nm)); Load(h);
    end else LdaImm(types[x.typ].hi - types[x.typ].lo);
    PushA(2);
    skipHidden := true;
    exit;
  end;
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
    if (id = 'mem') or (id = 'memw') or (id = 'meml') then ErrorN(66, '');
    VarDesignator(x);
    if (types[pt].form <> fUntyped) and (types[pt].size <> types[x.typ].size) then ErrorN(67, '');
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
        if p = 0 then ErrorN(68, '');
        PushArg(p);
        p := syms[p].next;
        if skipHidden then begin p := syms[p].next; skipHidden := false; end;
        n := n + 1;
        if sym = sComma then Next else break;
      until false;
    Expect(sRparen);
  end;
  if p <> 0 then ErrorN(69, '');
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
  { a routine of the program stores its own lines: the next statement's again }
  if syms[s].flags and 4 = 0 then lastDbg := -1;
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

{ ---- files }
{ System's file record (Text) }
function FileRecT: integer;
var k: integer;
begin
  k := Find('_tfile');
  if (k = 0) or (syms[k].kind <> skType) then ErrorN(110, '');
  FileRecT := syms[k].typ;
end;

function IsFileT(t: integer): boolean;
begin
  IsFileT := (types[t].form = fRec) and ((types[t].base >= 1) or (t = FileRecT));
end;

{ $I+: an I/O error stops the program }
procedure IoCheck;
begin
  if swI then CallLib('_iocheck');
end;

{ the address of a file variable (a simple one: it is taken again) }
procedure FileAdr(var f: TItem);
var y: TItem;
begin
  if not (f.mode in [mGlob, mLoc]) then ErrorN(42, '');
  y := f;
  LoadAdr(y); PushA(2);
end;

{ Reset / Rewrite (f [, record size]) }
procedure StdReset(rw: boolean);
var f, y: TItem;
    rs: integer;
begin
  Expect(sLparen);
  VarDesignator(f);
  if not IsFileT(f.typ) then ErrorN(110, '');
  LoadAdr(f); PushA(2);
  if sym = sComma then begin Next; Expression(y); LoadAs(y, tInteger); PushA(2); end
  else begin
    rs := types[f.typ].base;
    if rs = 0 then rs := 0 else if rs = 1 then rs := 128 else rs := types[rs - 1].size;
    PeaW(rs);
  end;
  Expect(sRparen);
  if rw then LibCallPop('_frewrite') else LibCallPop('_freset');
  IoCheck;
end;

{ BlockRead / BlockWrite (f, buf, count [, result]) }
procedure StdBlock(wr: boolean);
var f, b, y: TItem;
    k: integer;
begin
  Expect(sLparen);
  VarDesignator(f);
  if not IsFileT(f.typ) then ErrorN(110, '');
  LoadAdr(f); PushA(2);
  Expect(sComma);
  VarDesignator(b); LoadAdr(b); PushA(2);
  Expect(sComma);
  Expression(y); LoadAs(y, tWord); PushA(2);
  if sym = sComma then begin Next; VarDesignator(y); LoadAdr(y); PushA(2); end
  else begin
    k := Find('_fdummy');
    y.mode := mGlob; y.a := syms[k].adr; y.typ := tWord; y.tmp := false; y.tj := 0; y.fj := 0;
    LoadAdr(y); PushA(2);
  end;
  Expect(sRparen);
  if wr then LibCallPop('_fblockwrite') else LibCallPop('_fblockread');
  IoCheck;
end;

procedure StdWrite(ln: boolean);
var x, w, fx: TItem;
    f: integer;
    first, isF: boolean;
begin
  isF := false;
  if sym = sLparen then begin
    Next;
    first := true;
    if sym <> sRparen then
      repeat
        Expression(x);
        if first and IsFileT(x.typ) then begin
          { Write(f, ...): to a file }
          fx := x; isF := true;
          if types[fx.typ].base >= 1 then begin
            { records: each one a variable }
            if ln then Error('WriteLn/ReadLn: text files only');
            while sym = sComma do begin
              Next;
              FileAdr(fx);
              VarDesignator(x); LoadAdr(x); PushA(2); PeaW(types[x.typ].size);
              LibCallPop('_fwrite');
            end;
            Expect(sRparen);
            IoCheck;
            exit;
          end;
          FileAdr(fx); LibCallPop('_textout');
          first := false;
          if sym = sComma then begin Next; Expression(x); end else break;
        end;
        first := false;
        f := types[x.typ].form;
        if f = fStr then begin StrAdr(x); PushA(2); end
        else if f = fChar then begin Load(x); PushA(2); end
        else if f = fBool then begin LoadBool(x); PushA(2); end
        else if f = fInt then begin Load(x); Extend(x.typ); PushA(4); end
        else if f = fEnum then begin Load(x); if not rv then LdxImm(0); PushA(4); f := fInt; end
        else if f = fReal then begin Load(x); PushA(4); end
        else ErrorN(70, '');
        if sym = sColon then begin
          Next; Expression(w);
          if not IsInt(w.typ) then ErrorN(71, '');
          Load(w); PushA(2);
        end else PeaW(0);
        if f = fReal then begin
          if sym = sColon then begin
            Next; Expression(w);
            if not IsInt(w.typ) then ErrorN(72, '');
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
  if isF then begin CallLib('_textend'); IoCheck; end;
end;

procedure StdRead(ln: boolean);
var x, fx: TItem;
    s, f: integer;
    first, isF: boolean;
begin
  isF := false;
  if sym = sLparen then begin
    Next;
    first := true;
    if sym <> sRparen then
      repeat
        VarDesignator(x);
        if first and IsFileT(x.typ) then begin
          fx := x; isF := true;
          if types[fx.typ].base >= 1 then begin
            if ln then Error('WriteLn/ReadLn: text files only');
            while sym = sComma do begin
              Next;
              FileAdr(fx);
              VarDesignator(x); LoadAdr(x); PushA(2); PeaW(types[x.typ].size);
              LibCallPop('_fread');
            end;
            Expect(sRparen);
            IoCheck;
            exit;
          end;
          FileAdr(fx); LibCallPop('_textin');
          first := false;
          if sym = sComma then begin Next; VarDesignator(x); end else break;
        end;
        first := false;
        f := types[x.typ].form;
        if f = fStr then begin
          LoadAdr(x); PushA(2); PeaW(types[x.typ].hi);
          LibCallPop('_readstr');
        end else begin
          PrepStore(x);
          if f = fInt then CallLib('_readint')
          else if f = fReal then CallLib('_readreal')
          else if f = fChar then CallLib('_readchar')
          else ErrorN(73, '');
          Store(x);
        end;
        if sym = sComma then Next else break;
      until false;
    Expect(sRparen);
  end;
  if ln then CallLib('_readlnend');
  if isF then begin CallLib('_textend'); IoCheck; end;
end;

procedure StdIncDec(dec: boolean);
var x, y: TItem;
    s, sz: integer;
    k: longint;
    chk: boolean;
begin
  Expect(sLparen);
  VarDesignator(x);
  if not IsOrd(x.typ) and (types[x.typ].form <> fPtr) then ErrorN(74, '');
  sz := types[x.typ].size;
  LoadAdr(x); PushA(2);
  k := 1;
  if types[x.typ].form = fPtr then if types[x.typ].base <> 0 then k := types[types[x.typ].base].size;
  if sym = sComma then begin
    Next; Expression(y);
    if y.mode = mConst then k := y.a * k
    else begin
      if k <> 1 then ErrorN(75, '');
      Load(y); Extend(y.typ);
      if rv then RMv(rA3, rA0) else begin StaAbs(aT0); Op16($8E, aT0 + 2); end;
      k := 0;
    end;
  end;
  Expect(sRparen);
  chk := swQ and (types[x.typ].form <> fPtr);
  if rv then begin
    RPop(rT1);
    RLd(sz, types[x.typ].sgn, rA0, rT1, 0);
    if chk then begin
      { keep the variable's address (t1 is needed) and the old value }
      RPush(rT1); RMv(rA2, rA0);
      if k = 0 then RMv(rA1, rA3) else RLi(rA1, k);
    end;
    if k = 0 then begin if dec then RR($20, 0, rA0, rA0, rA3) else RR(0, 0, rA0, rA0, rA3); end
    else if dec then RAddi(rA0, rA0, -k) else RAddi(rA0, rA0, k);
    if chk then begin
      if sz < 4 then begin
        { what the variable's bytes say }
        RSlli(rT0, rA0, 32 - 8 * sz);
        if types[x.typ].sgn then RSrai(rT0, rT0, 32 - 8 * sz) else RSrli(rT0, rT0, 32 - 8 * sz);
        RB(0, rT0, rA0, 16); ErrJump(215);
      end else begin
        if dec then begin RR(0, 4, rT0, rA2, rA1); RR(0, 4, rT1, rA2, rA0); end
        else begin RR(0, 4, rT0, rA2, rA0); RR(0, 4, rT1, rA1, rA0); end;
        RR(0, 7, rT0, rT0, rT1); RB(5, rT0, rZero, 16); ErrJump(215);
      end;
      RPop(rT1);
    end;
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
  if chk and (sz < 4) then begin
    if types[x.typ].sgn then Op8($50, 9) else if dec then Op8($B0, 9) else Op8($90, 9);
    ErrJump(215);
  end;
  Op16($9D, 0);                           { sta 0,x }
  if sz = 1 then Rep;
  if sz = 4 then begin
    Op16($BD, 2);
    if k = 0 then begin if dec then Op16($ED, aT0 + 2) else Op16($6D, aT0 + 2); end
    else begin if dec then Op16($E9, k shr 16) else Op16($69, k shr 16); end;
    if chk then begin
      if types[x.typ].sgn then Op8($50, 9) else if dec then Op8($B0, 9) else Op8($90, 9);
      ErrJump(215);
    end;
    Op16($9D, 2);
  end;
  Gen($7A);                                { ply }
end;

{ v += e, v -= e (strings: s += e); v is reached once }
procedure AddAssign(var x: TItem);
var y, z: TItem;
    op, t: integer;
begin
  op := sym; Next; Expect(sEql);
  t := x.typ;
  if types[t].form = fStr then begin
    if op <> sPlus then ErrorN(76, '');
    LoadAdr(x); PushA(2);                          { destination }
    Expression(y);
    if not IsStrish(y.typ) then ErrorN(26, '');
    StrAdr(y); PushA(2);                           { source }
    PeaW(types[t].hi);
    LibCallPop('_strcat');
    exit;
  end;
  if not IsNum(t) then ErrorN(27, '');
  y := x;                                          { the old value, through the same designator }
  PrepStore(x);
  if x.mode = mFarStk then ErrorN(77, '');
  Push(y);
  Expression(z);
  Arith(op, y, z);
  LoadAs(y, t);
  Store(x);
end;

procedure AssignTo(var x: TItem; becomes: boolean);
var y: TItem;
    sp, t: integer;
begin
  if becomes and ((sym = sPlus) or (sym = sMinus)) then begin AddAssign(x); exit; end;
  t := x.typ;
  if types[t].form = fStr then begin
    LoadAdr(x); PushA(2);
    if becomes then Expect(sBecomes);
    Expression(y);
    StrAdr(y); PushA(2);
    PeaW(types[t].hi);
    LibCallPop('_strasg');
    exit;
  end;
  if types[t].form in [fArr, fRec, fSet] then begin
    LoadAdr(x); PushA(2);
    if becomes then Expect(sBecomes);
    Expression(y);
    if types[t].form = fSet then SetAdr(y)
    else begin
      if y.typ <> t then ErrorN(30, '');
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
  if becomes then Expect(sBecomes);
  Expression(y);
  if swR and IsOrd(t) and IsOrd(y.typ) and (y.mode <> mConst) and
     ((types[y.typ].lo < types[t].lo) or (types[y.typ].hi > types[t].hi)) then begin
    LoadBool(y);
    if y.mode <> mReg then Load(y);
    RangeCheck(y.typ, types[t].lo, types[t].hi, 201);
  end;
  LoadAs(y, t);
  Store(x);
end;

procedure Assignment(var x: TItem);
begin
  AssignTo(x, true);
end;

procedure StdNewDispose(isNew: boolean);
var x: TItem;
    s, t: integer;
begin
  Expect(sLparen);
  VarDesignator(x);
  t := x.typ;
  if (types[t].form <> fPtr) or (types[t].base = 0) then ErrorN(45, '');
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
  if not IsNum(x.typ) then ErrorN(27, '');
  isR := IsReal(x.typ);
  Load(x); if not isR then Extend(x.typ); PushA(4);
  if sym = sColon then begin Next; Expression(w); Load(w); PushA(2); end else PeaW(0);
  if isR then begin
    if sym = sColon then begin Next; Expression(w); Load(w); PushA(2); end else PeaW($FFFF);
  end;
  Expect(sComma);
  VarDesignator(v);
  if types[v.typ].form <> fStr then ErrorN(78, '');
  LoadAdr(v); PushA(2); PeaW(types[v.typ].hi);
  if isR then LibCallPop('_strreal') else LibCallPop('_strint');
  Expect(sRparen);
end;

{ Val(s, v, code): _valint / _valreal(s, var code) and the result into v }
procedure StdVal;
var x, v, c, y: TItem;
    pushed: boolean;
begin
  Expect(sLparen);
  Expression(x);
  if not IsStrish(x.typ) then ErrorN(26, '');
  StrAdr(x); PushA(2);
  Expect(sComma);
  VarDesignator(v);
  if not IsNum(v.typ) then ErrorN(79, '');
  if v.mode = mFar then ErrorN(80, '');
  pushed := v.mode = mInd;
  PrepStore(v);                                     { an indexed v keeps its address on the stack }
  Expect(sComma);
  VarDesignator(c);
  if not IsInt(c.typ) then ErrorN(81, '');
  LoadAdr(c); PushA(2);
  if pushed then begin
    { s, @v, @code -> @v, s, @code: the arguments together, @v under them }
    if rv then begin RPop(rA0); RPop(rA1); RPop(rA2); RPush(rA1); RPush(rA2); RPush(rA0); end
    else begin Gen($68); Gen($FA); Gen($7A); Gen($DA); Gen($5A); Gen($48); end;
  end;
  if IsReal(v.typ) then begin LibCallPop('_valreal'); y.typ := tReal; end
  else begin LibCallPop('_valint'); y.typ := tLong; end;
  y.mode := mReg; y.tmp := false; y.tj := 0; y.fj := 0;
  LoadAs(y, v.typ);
  Store(v);
  Expect(sRparen);
end;

{ GetMem(p, size), FreeMem(p, size) }
procedure StdGetFree(isGet: boolean);
var x, y: TItem;
begin
  Expect(sLparen);
  if isGet then begin
    VarDesignator(x);
    if types[x.typ].form <> fPtr then ErrorN(82, '');
    PrepStore(x);
    Expect(sComma);
    Expression(y); LoadAs(y, tWord); PushA(2);
    LibCallPop('_getmem');
    Store(x);
  end else begin
    Expression(x);
    if types[x.typ].form <> fPtr then ErrorN(31, '');
    Load(x); PushA(PtrSz);
    Expect(sComma);
    Expression(y); LoadAs(y, tWord); PushA(2);
    LibCallPop('_freemem');
  end;
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
  if nLoop > MaxLoop then ErrorN(83, '');
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
  if nLoop > MaxLoop then ErrorN(83, '');
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
  if not (v.mode in [mGlob, mLoc]) then ErrorN(84, '');
  if not IsOrd(v.typ) or not rv and (types[v.typ].size = 4) then ErrorN(85, '');
  sg := types[v.typ].sgn;
  sz := types[v.typ].size;
  Expect(sBecomes);
  Expression(x);
  LoadAs(x, v.typ);
  lim := v;
  Store(lim);
  down := sym = sDownto;
  if (sym <> sTo) and (sym <> sDownto) then ErrorN(86, '');
  Next;
  Expression(lim);
  LoadAs(lim, v.typ);
  if rv then RPush(rA0)
  else begin
    if sg then Op16($49, $8000);
    Gen($48);                             { the limit stays on the stack }
  end;
  stkSlots := stkSlots + 1;
  if sg then f3 := 5 else f3 := 7;        { SCHUB: bge / bgeu }
  ReleaseTmp(false, false);
  Expect(sDo);
  nLoop := nLoop + 1;
  if nLoop > MaxLoop then ErrorN(83, '');
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
  stkSlots := stkSlots - 1;
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
  if not IsOrd(x.typ) or not rv and (types[x.typ].size = 4) then ErrorN(87, '');
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
    if types[x.typ].form <> fRec then ErrorN(88, '');
    if nWith >= 8 then ErrorN(89, '');
    nWith := nWith + 1;
    withTyp[nWith] := x.typ;
    if x.mode in [mGlob, mLoc] then begin
      withMode[nWith] := x.mode; withA[nWith] := x.a;
    end else begin
      { the record's address goes into one of the frame's WITH slots }
      slots := 0;
      for i := 1 to nWith - 1 do if withMode[i] = mInd then slots := slots + 1;
      if slots >= 4 then ErrorN(90, '');
      if ctxWith[curLev] < 0 then ErrorN(91, '');
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

{ ---- goto and label. A label (32 bytes at LabBase): name (16), address
  (-1 not placed), FOR slots there, chain of the forward jumps. A forward
  goto (8 bytes at FixBase): the place of its stack adjustment, the label,
  its FOR slots. The adjustment (65C816 tsc clc adc #n tcs, RISC-V addi sp)
  drops the limits of the loops it leaves. }
const
  LabBase = $3D5000;
  FixBase = $3D6000;

function LabelName: TName;
var n: TName;
begin
  if sym = sNumber then n := IntToStr(num)
  else if sym = sIdent then n := id
  else Error('label name expected');
  LabelName := n;
end;

{ a label of this routine, -1 = none }
function FindLabel(const n: TName): integer;
var i, k: integer;
    a: longint;
    ok: boolean;
begin
  FindLabel := -1;
  for i := labStart to nLab - 1 do begin
    a := LabBase + longint(i) * 32;
    if Mem[a] = length(n) then begin
      ok := true;
      for k := 1 to length(n) do if Mem[a + k] <> ord(n[k]) then ok := false;
      if ok then begin FindLabel := i; exit; end;
    end;
  end;
end;

procedure LabelSection;
var n: TName;
    a: longint;
    k: integer;
begin
  Next;
  repeat
    n := LabelName;
    if FindLabel(n) >= 0 then ErrorN(2, n);
    if nLab >= 128 then Error('too many labels');
    a := LabBase + longint(nLab) * 32;
    for k := 0 to length(n) do Mem[a + k] := ord(n[k]);
    MemL[a + 16] := -1; MemW[a + 20] := 0; MemL[a + 28] := 0; Mem[a + 24] := 0;
    nLab := nLab + 1;
    Next;
    if sym = sComma then Next else break;
  until false;
  Expect(sSemi);
end;

{ the stack adjustment of a goto: n bytes up }
procedure StackAdjust(n: integer);
begin
  if rv then RI($13, 0, rSp, rSp, n)
  else begin Gen($3B); Gen($18); Op16($69, n); Gen($1B); end;
end;

function SlotBytes: integer;
begin
  if rv then SlotBytes := 4 else SlotBytes := 2;
end;

procedure GotoStat;
var k: integer;
    a, chain, site: longint;
begin
  Next;
  k := FindLabel(LabelName);
  if k < 0 then Error('label of this routine expected');
  Next;
  a := LabBase + longint(k) * 32;
  Mem[a + 24] := 1;
  if MemL[a + 16] >= 0 then begin
    if stkSlots < MemW[a + 20] then Error('goto into a FOR loop');
    if stkSlots > MemW[a + 20] then StackAdjust((stkSlots - MemW[a + 20]) * SlotBytes);
    BrlTo(MemL[a + 16]);
  end else begin
    if nFix >= 64 then Error('too many forward gotos');
    site := pc;
    StackAdjust(0);
    MemL[FixBase + nFix * 8] := site; MemW[FixBase + nFix * 8 + 4] := k; MemW[FixBase + nFix * 8 + 6] := stkSlots;
    nFix := nFix + 1;
    chain := MemL[a + 28];
    BrlFwd(chain);
    MemL[a + 28] := chain;
  end;
end;

procedure PlaceLabel(k: integer);
var a: longint;
    i, d: integer;
begin
  a := LabBase + longint(k) * 32;
  if MemL[a + 16] >= 0 then Error('label placed twice');
  MemL[a + 16] := pc; MemW[a + 20] := stkSlots;
  FixChain(MemL[a + 28], pc);
  MemL[a + 28] := 0;
  { the forward gotos: their stack adjustments }
  for i := 0 to nFix - 1 do
    if MemW[FixBase + i * 8 + 4] = k then begin
      d := MemW[FixBase + i * 8 + 6] - stkSlots;
      if d < 0 then Error('goto into a FOR loop');
      if rv then Put32(MemL[FixBase + i * 8], IEnc($13, 0, rSp, rSp, d * 4))
      else Put16(MemL[FixBase + i * 8] + 3, d * 2);
      MemW[FixBase + i * 8 + 4] := $FFFF;
    end;
  lastDbg := -1;
end;

{ the end of a routine: every label used is placed }
procedure EndLabels;
var i: integer;
begin
  for i := labStart to nLab - 1 do
    if (Mem[LabBase + longint(i) * 32 + 24] <> 0) and (MemL[LabBase + longint(i) * 32 + 16] < 0) then
      Error('a label is used but not placed');
end;

{ DebugLines: the statement's line into DbgLineAdr (lda #v / sta long; on
  RISC-V gp points there) }
procedure StmtLine;
var v: longint;
begin
  v := tokLine;
  if v > 4095 then v := 4095;
  v := v or (longint(curUnit) shl 12);
  if v = lastDbg then exit;
  lastDbg := v;
  if rv then begin RLi(rT0, v); RSt(2, rT0, 3, 0); end
  else begin Op16($A9, v); Op24($8F, DbgLineAdr); end;
  if DebugHooks then begin if rv then RCall(aDbgHook) else Op24($22, aDbgHook); end;
end;

{ DebugLines with $D-: the line is not known ($FFFE), once until a line is
  stored again }
procedure NoLine;
begin
  if lastDbg = -2 then exit;
  lastDbg := -2;
  if rv then begin RLi(rT0, $FFFE); RSt(2, rT0, 3, 0); end
  else begin Op16($A9, $FFFE); Op24($8F, DbgLineAdr); end;
end;

{ DebugLines: the program ends here as it should }
procedure DbgEnd;
begin
  if not DebugLines then exit;
  if rv then begin RLi(rT0, -1); RSt(2, rT0, 3, 0); end
  else begin Op16($A9, $FFFF); Op24($8F, DbgLineAdr); end;
  lastDbg := -1;
end;

procedure Statement;
var x: TItem;
    s, k: integer;
    n: TName;
begin
  nTmp := 0;
  if DebugLines and (sym <> sEnd) and (sym <> sSemi) then if swD then StmtLine else NoLine;
  case sym of
    sBegin: begin Next; StatSeq; Expect(sEnd); end;
    sIf: IfStat;
    sWhile: WhileStat;
    sRepeat: RepeatStat;
    sFor: ForStat;
    sCase: CaseStat;
    sWith: WithStat;
    sGoto: GotoStat;
    sNumber: begin
      k := FindLabel(LabelName);
      if k < 0 then Error('label of this routine expected');
      Next; Expect(sColon);
      PlaceLabel(k);
      Statement;
    end;
    sIdent: begin
      n := id;
      k := FindLabel(n);
      if k >= 0 then begin
        Next; Expect(sColon);
        PlaceLabel(k);
        Statement;
        exit;
      end;
      if WithField(x) then Assignment(x)
      else if (n = 'write') or (n = 'writeln') then begin Next; StdWrite(n = 'writeln'); end
      else if (n = 'include') or (n = 'exclude') then begin
        Next; Expect(sLparen);
        VarDesignator(x);
        if types[x.typ].form <> fSet then ErrorN(93, '');
        LoadAdr(x); PushA(2);
        Expect(sComma);
        Expression(x);
        if not IsOrd(x.typ) then ErrorN(94, '');
        LoadBool(x); PushA(2);
        if n = 'include' then LibCallPop('_setincl') else LibCallPop('_setexcl');
        Expect(sRparen);
      end
      else if (n = 'read') or (n = 'readln') then begin Next; StdRead(n = 'readln'); end
      else if (n = 'inc') or (n = 'dec') then begin Next; StdIncDec(n = 'dec'); end
      else if (n = 'new') or (n = 'dispose') then begin Next; StdNewDispose(n = 'new'); end
      else if n = 'str' then begin Next; StdStr; end
      else if (n = 'val') and (Find(n) = 0) then begin Next; StdVal; end
      else if ((n = 'reset') or (n = 'rewrite')) and (Find(n) = 0) then begin Next; StdReset(n = 'rewrite'); end
      else if ((n = 'blockread') or (n = 'blockwrite')) and (Find(n) = 0) then begin Next; StdBlock(n = 'blockwrite'); end
      else if ((n = 'getmem') or (n = 'freemem')) and (Find(n) = 0) then begin Next; StdGetFree(n = 'getmem'); end
      else if n = 'exit' then begin
        Next;
        if curLev = 0 then ErrorN(95, '');
        if sym = sLparen then begin
          { Exit(value): the function's result, then out }
          s := ctxProc[curLev];
          if syms[s].typ = 0 then ErrorN(96, '');
          Next;
          if syms[s].flags and 1 <> 0 then begin
            LdaDp(ParDp(curLev, syms[s].hid));
            x.mode := mInd; x.a := 0; x.typ := ResultType(s);
          end else begin
            x.mode := mLoc; x.a := ctxRes[curLev]; x.typ := syms[s].typ;
          end;
          x.tmp := false; x.tj := 0; x.fj := 0;
          AssignTo(x, false);
          Expect(sRparen);
        end;
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
        PushA(2); DbgEnd; CallLib('_halt');
      end else if (n = 'mem') or (n = 'memw') or (n = 'meml') then begin
        Next;
        if n = 'mem' then MemDesignator(x, 1) else if n = 'memw' then MemDesignator(x, 2) else MemDesignator(x, 4);
        Assignment(x);
      end else begin
        s := Find(n);
        if s = 0 then ErrorN(57, n);
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
              { a System routine on files (Close, Append, Seek ...): $I+ }
              if (syms[s].flags and 4 <> 0) and (syms[s].first <> 0) then
                if IsFileT(syms[syms[s].first].typ) then IoCheck;
            end;
          end;
        else
          ErrorN(97, '');
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
      if sym <> sIdent then ErrorN(98, '');
      if nid >= 16 then ErrorN(99, '');
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
    if sym <> sIdent then ErrorN(100, '');
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
    bLo, bHi: array[1..8] of longint;
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
        if (lo < 1) or (lo > 255) then ErrorN(101, '');
        t := NewType(fStr, lo + 1); types[t].hi := lo;
      end else t := tString;
    end;
    sCaret: begin
      Next;
      if sym <> sIdent then ErrorN(102, '');
      t := NewType(fPtr, PtrSz);
      s := Find(id);
      if (s <> 0) and (syms[s].kind = skType) then types[t].base := syms[s].typ
      else begin
        if nPend >= 16 then ErrorN(103, '');
        nPend := nPend + 1; pendPtr[nPend] := t; pendName[nPend] := id;
      end;
      Next;
    end;
    sArray: begin
      Next; Expect(sLbrak);
      k := 0;
      repeat
        k := k + 1;
        if k > 8 then ErrorN(104, '');
        if sym = sIdent then begin
          s := Find(id);
          if (s <> 0) and (syms[s].kind = skType) and IsOrd(syms[s].typ) then begin
            Next; lo := types[syms[s].typ].lo; hi := types[syms[s].typ].hi;
            if syms[s].typ = tChar then begin lo := 0; hi := 255; end;
          end else begin lo := ConstExpr; Expect(sDotdot); hi := ConstExpr; end;
        end else begin lo := ConstExpr; Expect(sDotdot); hi := ConstExpr; end;
        if hi < lo then ErrorN(105, '');
        bLo[k] := lo; bHi[k] := hi;
        if sym = sComma then Next else break;
      until false;
      Expect(sRbrak); Expect(sOf);
      TypeDef(ft);
      for i := k downto 1 do begin
        lo := bLo[i]; hi := bHi[i];
        t := NewType(fArr, 0);
        if rv then begin if (hi - lo + 1) * types[ft].size > 65535 then ErrorN(106, ''); end
        else if (hi - lo + 1) * types[ft].size > 40000 then ErrorN(107, '');
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
        if sym <> sIdent then ErrorN(108, '');
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
      if not IsOrd(ft) then ErrorN(109, '');
      t := NewType(fSet, 32);
      types[t].base := ft;
    end;
    sFile: begin
      { file of T / file: System's _TFile record; base = 1 untyped, T + 1 }
      Next;
      f := FileRecT;
      if sym = sOf then begin Next; TypeDef(ft); ft := ft + 1; end else ft := 1;
      t := NewType(fRec, types[f].size);
      types[t].fields := types[f].fields; types[t].al := types[f].al; types[t].base := ft;
    end;
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
    if (k = 0) or (syms[k].kind <> skType) then ErrorN(111, pendName[i]);
    types[pendPtr[i]].base := syms[k].typ;
  end;
  nPend := 0;
end;

{ the value of a typed constant or an initialised variable, written into
  the data image at a: (a, b) for arrays, (f: v; g: w) for records }
procedure InitValue(t: integer; a: longint);
var x: TItem;
    i: longint;
    k, f: integer;
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
    if sym <> sString then ErrorN(26, '');
    if length(str) > types[t].hi then ErrorN(112, '');
    Mem[DataImg + a - dataOrg] := length(str);
    for k := 1 to length(str) do Mem[DataImg + a - dataOrg + k] := ord(str[k]);
    Next;
    exit;
  end;
  if types[t].form = fRec then begin
    Expect(sLparen);
    while sym = sIdent do begin
      f := types[t].fields;
      while (f <> 0) and (syms[f].name <> id) do f := syms[f].next;
      if f = 0 then ErrorN(113, id);
      Next; Expect(sColon);
      InitValue(syms[f].typ, a + syms[f].adr);
      if sym = sSemi then Next else break;
    end;
    Expect(sRparen);
    exit;
  end;
  Expression(x);
  if x.mode <> mConst then ErrorN(33, '');
  if IsReal(t) and not IsReal(x.typ) then x.a := IntToRealBits(x.a);
  for k := 0 to types[t].size - 1 do Mem[DataImg + a - dataOrg + k] := (x.a shr (8 * k)) and 255;
end;

procedure ConstSection;
var s, t: integer;
    n: TName;
    x: TItem;
    a: longint;
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
        if x.mode <> mConst then ErrorN(33, '');
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
      if sym <> sIdent then ErrorN(108, '');
      n := n + 1; if n > 16 then ErrorN(99, '');
      ids[n] := id; Next;
      if sym = sComma then Next else break;
    until false;
    Expect(sColon);
    TypeDef(t);
    if (sym = sIdent) and (id = 'absolute') then begin
      Next;
      if n <> 1 then ErrorN(114, '');
      if sym = sIdent then begin
        v := Find(id);
        if (v = 0) or (syms[v].kind <> skVar) then ErrorN(115, '');
        Next;
        if (syms[v].lev > 0) and not syms[v].isPar and (types[syms[v].typ].size > 8) and not defPlaced[syms[v].lev] then
          ErrorN(116, '');
        s := NewSym(ids[1], skVar, t);
        syms[s].lev := syms[v].lev; syms[s].adr := syms[v].adr;
        syms[s].isPar := syms[v].isPar; syms[s].isRef := syms[v].isRef;
        syms[s].flags := syms[v].flags and 32;
      end else begin
        a := ConstExpr;
        s := NewSym(ids[1], skVar, t);
        syms[s].lev := 0; syms[s].adr := a;
        if rv or (a < 0) or (a > $FFFF) then begin
          if types[t].form in [fStr, fArr, fSet] then ErrorN(117, '');
          syms[s].flags := 32;     { far: reached with long addressing }
        end;
      end;
    end else if sym = sEql then begin
      { an initialised variable: global, like a typed constant }
      if (n <> 1) or (curLev > 0) then ErrorN(118, '');
      Next;
      s := NewSym(ids[1], skVar, t);
      syms[s].adr := AllocData(types[t].size);
      InitValue(t, syms[s].adr);
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
    isOpen: boolean;
begin
  isFunc := sym = sFunction;
  Next;
  if sym <> sIdent then ErrorN(108, '');
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
            if sym <> sIdent then ErrorN(119, '');
            np := np + 1; parIds[np] := id; Next;
            if sym = sComma then Next else break;
          until false;
          isOpen := false;
          if sym = sColon then begin
            Next;
            if sym = sArray then begin
              { array of T: an address, and a hidden name$ = the last index }
              Next; Expect(sOf); ParseTypeIdent(pt);
              q := NewType(fArr, 0); types[q].lo := 0; types[q].hi := -1; types[q].base := pt;
              pt := q; isOpen := true;
              if mode = 0 then mode := 2;
            end else ParseTypeIdent(pt);
          end
          else begin if mode = 0 then ErrorN(120, ''); pt := tUntyped; end;
          for i := 1 to np do begin
            p := NewSym(parIds[i], skPar, pt);
            syms[p].isRef := (mode = 1) or IsStruct(pt) or (pt = tUntyped);
            if mode = 1 then syms[p].flags := 1;
            if mode = 2 then syms[p].flags := 2;
            if prev = 0 then syms[s].first := p else syms[prev].next := p;
            prev := p;
            syms[s].npar := syms[s].npar + 1;
            if isOpen then begin
              p := NewSym(Copy(parIds[i], 1, 14) + '$', skPar, tInteger);
              syms[prev].next := p;
              prev := p;
              syms[s].npar := syms[s].npar + 1;
            end;
          end;
          if sym = sSemi then Next else break;
        until false;
      Expect(sRparen);
    end;
    if isFunc then begin
      Expect(sColon); ParseTypeIdent(rt);
      if (types[rt].form in [fArr, fRec, fSet]) and (types[rt].size > 256) then
        ErrorN(121, '');
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
  if (sym = sIdent) and (id = 'forward') then ErrorN(122, '');
  { body }
  if curLev >= MaxLev - 1 then ErrorN(123, '');
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
      if cpN[curLev] >= 8 then ErrorN(124, '');
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
    saveLab, saveFix, saveSlots: integer;
begin
  saveLab := labStart; saveFix := nFix; saveSlots := stkSlots;
  labStart := nLab - preLabels; preLabels := 0; stkSlots := 0;
  repeat
    case sym of
      sConst: ConstSection;
      sType: TypeSection;
      sVar: VarSection;
      sProcedure, sFunction: ProcDecl;
      sLabel: LabelSection;
    else
      break;
    end;
  until false;
  if sym <> sBegin then ErrorN(126, '');
  { procedure entry }
  lastDbg := -1;                               { DebugLines: this body stores its lines anew }
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
    EndLabels; nLab := labStart; labStart := saveLab; nFix := saveFix; stkSlots := saveSlots;
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
  EndLabels; nLab := labStart; labStart := saveLab; nFix := saveFix; stkSlots := saveSlots;
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
    { an include file may hold a WITH: room for it, to be safe }
    if (c = ord('{') or $20) and (Mem[base + p + 1] = ord('$')) and ((Mem[base + p + 2] or $20) = ord('i')) and
       ((Mem[base + p + 3] = 32) or ((Mem[base + p + 3] or $20) = ord('n'))) then begin ScanWith := true; exit; end;
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
      sLabel: LabelSection;
    else
      break;
    end;
  until false;
end;

procedure CheckForwards(from: integer);
var i: integer;
begin
  for i := from to nSym do
    if (syms[i].kind = skProc) and (syms[i].flags and 6 = 0) then ErrorN(127, syms[i].name);
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
    if sym <> sIdent then ErrorN(128, '');
    if k >= 8 then ErrorN(129, '');
    k := k + 1; names[k] := id;
    Next;
  until sym <> sComma;
  if sym <> sSemi then ErrorN(130, '');
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
    saveUnit: integer;
begin
  for i := 1 to nUnit do
    if unitName[i] = n then begin
      if unitDone[i] then exit;
      ErrorN(131, n);
    end;
  if nUnit >= 12 then ErrorN(129, '');
  nUnit := nUnit + 1; u := nUnit;
  unitName[u] := n; unitDone[u] := false;
  fname := UpperCase(Copy(n, 1, 8)) + '.PAS';
  if unitTop >= $2F0000 then ErrorN(132, fname);
  got := LoadFile(fname, unitTop, $300000 - unitTop);
  if got < 0 then ErrorN(133, fname + ' (' + DosErrorText(DosError) + ')');
  saveFile := curFile; saveWith := hasWith;
  curFile := fname;
  saveUnit := curUnit; curUnit := u; lastDbg := -1;
  curBase := unitTop; srcPos := 0; srcEnd := got; line := 1; col := 0;
  unitTop := (unitTop + got + 255) and $FFFF00;
  hasWith := ScanWith(curBase, got);
  NextCh; Next;
  if (sym <> sIdent) or (id <> 'unit') then ErrorN(134, '');
  Next;
  if (sym <> sIdent) or (id <> n) then ErrorN(135, fname + ' must be called ' + n);
  Next; Expect(sSemi);
  if (sym <> sIdent) or (id <> 'interface') then ErrorN(136, '');
  Next;
  if sym = sUses then UsesClause;
  first := nSym + 1;
  inInterface := true;
  Declarations;
  inInterface := false;
  if (sym <> sIdent) or (id <> 'implementation') then ErrorN(137, '');
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
  if sym <> sPeriod then ErrorN(138, '');
  { what the implementation declared is private to the unit }
  for i := ifaceEnd + 1 to nSym do
    if (syms[i].kind in [skConst, skVar, skType, skProc, skAsm]) and (syms[i].flags and (128 + 64) = 0) and
       (syms[i].lev <= 1) then syms[i].name := '';
  { its interface stays visible (also when another unit's implementation used it) }
  for i := first to ifaceEnd do
    if syms[i].kind in [skConst, skVar, skType, skProc, skAsm] then syms[i].flags := syms[i].flags or 64;
  hasWith := saveWith; curFile := saveFile;
  curUnit := saveUnit; lastDbg := -1;
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
  { the messages again for every compile: a program may have used that memory }
  msgsBuilt := false; BuildMessages;
  if CatchError <> 0 then exit;
  rv := WantSchub or SchubDirective(srcLen);
  IsSchub := rv;
  { the names the PC compiler defines for the target }
  nDef := 0; condDepth := 0; incDepth := 0;
  swR := false; swQ := false; swI := true; swD := true;
  DefineName('MERIDIAN');
  if rv then begin DefineName('SCHUB'); DefineName('CPURV32'); end
  else begin DefineName('M816'); DefineName('CPU65C816'); end;
  if rv then begin cBase := RvCode; RunEntry := RvStub; end
  else begin cBase := CodeBase; RunEntry := CodeBase; end;
  curBase := SrcBase; srcPos := 0; srcEnd := srcLen; line := 1; col := 0;
  tokLine := 1; tokCol := 1;
  pc := 0; dataTop := 0; nLoop := 0; nTmp := 0; nPend := 0; nWith := 0;
  lastDbg := -1; curUnit := 0;
  nLab := 0; labStart := 0; nFix := 0; stkSlots := 0; preLabels := 0;
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
    if DebugLines then RLi(3, DbgLineAdr);  { gp: the line for the editor }
    W32(0); W32(0); mainFix := pc - 8;      { call main (patched) }
    DbgEnd;
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
  DbgEnd;
  Op24($5C, aExit);                          { jml rt_exit }
  end;
  { program text }
  NextCh;
  Next;
  if sym = sProgram then begin
    Next;
    if sym <> sIdent then ErrorN(139, '');
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
  if sym <> sBegin then ErrorN(126, '');
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
  preLabels := nLab;                         { the program's labels belong to its body }
  Block;
  if sym <> sPeriod then ErrorN(140, '');
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
    { byte by byte: heapAt can be odd, and SCHUB writes words only at even addresses }
    a := (RvData + DataSize + 7) and not longint(7);
    for i := 0 to 3 do Mem[heapAt + i] := (a shr (8 * i)) and 255;
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
function DebugUnitName(u: integer): string;
begin
  if (u < 1) or (u > nUnit) then DebugUnitName := ''
  else DebugUnitName := UpperCase(Copy(unitName[u], 1, 8)) + '.PAS';
end;

{ ---- the debugger's watches }
function LowerC(c: char): char;
begin
  if (c >= 'A') and (c <= 'Z') then LowerC := chr(ord(c) + 32) else LowerC := c;
end;

function DbgHex(v: longint; n: integer): string;
var s: string[8];
    k, d: integer;
begin
  s[0] := chr(n);
  for k := n downto 1 do begin
    d := v and 15;
    if d < 10 then s[k] := chr(48 + d) else s[k] := chr(55 + d);
    v := v shr 4;
  end;
  DbgHex := '$' + s;
end;

function DebugValue(const name: string): string;
var n: TName;
    i, s, t, f, k, len: integer;
    a, v, idx: longint;
    far, neg: boolean;
    u: TRealBits;
    r: string;
  function B(o: longint): longint;
  begin
    if far or IsSchub then B := Mem[a + o] else B := Mem[$340000 + (a + o) and $FFFF];
  end;
  procedure Word1;
  begin
    n[0] := chr(0);
    while (i <= length(name)) and ((UpCase(name[i]) in ['A'..'Z', '0'..'9']) or (name[i] = '_')) do begin
      if length(n) < 15 then begin n[0] := chr(length(n) + 1); n[length(n)] := LowerC(name[i]); end;
      i := i + 1;
    end;
  end;
begin
  DebugValue := '?';
  i := 1;
  Word1;
  s := 0;
  for k := nSym downto 1 do
    if (s = 0) and (syms[k].kind = skVar) and (syms[k].lev = 0) and (syms[k].name = n) then s := k;
  if s = 0 then begin DebugValue := 'UNKNOWN'; exit; end;
  t := syms[s].typ; a := syms[s].adr; far := syms[s].flags and 32 <> 0;
  { .field and [n] }
  while i <= length(name) do begin
    if name[i] = '.' then begin
      i := i + 1; Word1;
      if types[t].form <> fRec then exit;
      f := types[t].fields;
      while (f <> 0) and (syms[f].name <> n) do f := syms[f].next;
      if f = 0 then exit;
      a := a + syms[f].adr; t := syms[f].typ;
    end else if name[i] = '[' then begin
      i := i + 1; idx := 0; neg := false;
      if (i <= length(name)) and (name[i] = '-') then begin neg := true; i := i + 1; end;
      while (i <= length(name)) and (name[i] in ['0'..'9']) do begin idx := idx * 10 + ord(name[i]) - 48; i := i + 1; end;
      if neg then idx := -idx;
      if (i > length(name)) or (name[i] <> ']') then exit;
      i := i + 1;
      if types[t].form = fStr then begin a := a + idx; t := tChar; end
      else if types[t].form = fArr then begin
        if (idx < types[t].lo) or (idx > types[t].hi) then begin DebugValue := 'OUT OF RANGE'; exit; end;
        a := a + (idx - types[t].lo) * types[types[t].base].size; t := types[t].base;
      end else exit;
    end else exit;
  end;
  { the value }
  case types[t].form of
    fInt, fEnum, fBool, fChar, fPtr, fNil: begin
      v := 0;
      for k := types[t].size - 1 downto 0 do v := (v shl 8) or B(k);
      if types[t].sgn then begin
        if (types[t].size = 1) and (v > 127) then v := v - 256
        else if (types[t].size = 2) and (v > 32767) then v := v - 65536;
      end;
      case types[t].form of
        fBool: if v <> 0 then r := 'TRUE' else r := 'FALSE';
        fChar: if (v >= 32) and (v < 127) then r := '''' + chr(v) + '''' else r := '#' + IntToStr(v);
        fPtr, fNil: if v = 0 then r := 'NIL' else r := DbgHex(v, 2 * types[t].size);
        fEnum: begin
          r := IntToStr(v);
          for k := 1 to nSym do
            if (syms[k].kind = skConst) and (syms[k].typ = t) and (syms[k].adr = v) then r := UpperCase(syms[k].name);
        end;
      else
        r := IntToStr(v);
      end;
    end;
    fReal: begin
      u.l := B(0) or (B(1) shl 8) or (B(2) shl 16) or (B(3) shl 24);
      { (Str is hidden here by the scanner's str) }
      if Abs(u.r) >= 2000000000.0 then r := 'BIG'
      else begin
        v := Trunc(u.r);
        f := Round(Abs(u.r - v) * 10000);
        if f >= 10000 then begin f := f - 10000; if u.r < 0 then v := v - 1 else v := v + 1; end;
        r := IntToStr(f + 10000);
        r[1] := '.';
        if (v = 0) and (u.r < 0) then r := '-0' + r else r := IntToStr(v) + r;
      end;
    end;
    fStr: begin
      len := B(0);
      r := '''';
      for k := 1 to len do if k <= 40 then r := r + chr(B(k));
      r := r + '''';
      if len > 40 then r := r + '...';
    end;
  else
    r := '(...)';
  end;
  DebugValue := r;
end;

procedure PrepareRun;
begin
  if not IsSchub then exit;
  CopyMem(Far24($40005B), RvStub, Mem[$40005E] or (Mem[$40005F] shl 8));
  CopyMem(Far24($400055), RvLib, Far24($400058));
  CopyMem(DataImg, RvData, DataSize);
  MemL[RvHeapVar] := (RvData + DataSize + 7) and not longint(7);
end;

end.
