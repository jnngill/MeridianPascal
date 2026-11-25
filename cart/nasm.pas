{ MERIDIAN Pascal - the assembler of the PASCAL cartridge

  Assembles the editor's text for the 65C816 or, with .schub, for the SCHUB
  RV32IM co-processor. The syntax is the one of the PC assemblers
  (compiler/asm816.js, compiler/asmrv.js), so the same source gives the
  same bytes on both.

  65C816: labels start in column 1 (a colon is allowed), instructions are
  indented; * = address sets the origin (default $2000); name = expr;
  .byte .word .long .dword .text .fill .align .al .as .xl .xs; operand
  sizes by value (direct page, absolute, long) or @b @w @l; anonymous
  labels + and -. A symbol defined further down is always absolute, so the
  two passes agree. The program is started with JSL and ends with RTL
  (F5, BRUN, Load program).

  SCHUB (.schub as the first line, or Ctrl+T): RV32IM with the usual
  register names and the pseudo-instructions of asmrv.js; labels end with
  a colon; .byte .half .word (32 bit) .fill .align .text; comments with ;
  or #. The code starts at $04:0400 behind the cartridge's 65C816 host
  stub, which serves the mailbox at $800403F0 like for compiled Pascal.

  Tables and output live in expansion RAM: the assembled bytes at
  $33:0000, the symbols at $38:0000, the opcode table at $39:0000. }
unit NAsm;

interface

uses Blitter, Dos;

const
  { asm blocks of Pascal texts (NComp): the Pascal names the block uses, a
    word count, then from +4 (SCHUB: the values word aligned) 20 bytes a
    name: its length (+128: asm cannot use it), 15 characters in upper
    case, its value (longint) }
  AsmNames = $3B2000;
  MaxAsmNames = 64;

type
  { the assembler's buffers, only used while it assembles: the editor lays
    its line colours over them (bank 0 is short) }
  TAsmWork = record
    lne: string;              { the current line, without its comment }
    exb: string[100];         { the expression being read }
    opd: string[100];         { an instruction's operand }
    pad: array[0..53] of byte;
  end;

  PAsmWork = ^TAsmWork;

var
  { errors of the assembler and of the compiler (NComp) }
  ErrMsg: string;
  ErrUnit: string[12];      { the unit file the error is in ('' = the program) }
  ErrLine, ErrCol: integer;
  AsmUnit: string[12];      { the file an asm block is in (NComp) }
  { set by the editor before the first assembly: 512 bytes of its own }
  AsmWorkPtr: PAsmWork;
  AsmSize: longint;       { bytes assembled }
  AsmOrigin: longint;     { address of the first byte }
  AsmEntry: longint;      { where the program starts (START, or the origin) }
  AsmIsSchub: boolean;    { the last assembly was RV32IM }
  AsmLines: integer;
  RunAt: longint;         { after AsmPrepareRun: RunUser(RunAt) }

{ the text is assembly: NAME.ASM / NAME.S, or ; as its first character }
function IsAsmText(n: longint; const fileName: string): boolean;
{ .schub as the first line }
function IsAsmSchub(n: longint): boolean;
function AssembleSource(srcLen: longint; schub: boolean): boolean;
{ put the program in place for F5; false (ErrMsg) when it cannot run here }
function AsmPrepareRun: boolean;
function SaveAsmMer(const name: string): boolean;
{ for the editor's colours }
function IsMnemonic(const s: string): boolean;
{ an asm block of a Pascal text (NComp): the lines from address a up to e,
  the first is line line0 of the file AsmUnit, assembled for address org into
  $33:0000; the number of bytes. The Pascal names are in AsmNames. }
function InlineAsmBlock(a, e: longint; line0: integer; org: longint; schub: boolean): longint;

implementation

type
  TShort = string[100];

const
  SrcBase = $200000;
  Stage = $330000;          { the assembled bytes }
  MaxOut = $40000;          { 256 KB }
  SymBase = $380000;        { hash heads (256 words), then 32-byte entries }
  MaxSyms = 2000;
  OpBase = $390000;         { 65C816: mnemonic * 32 modes, opcode + 1 (0: none) }
  FlagBase = $392000;       { 65C816: flags per mnemonic }
  AnonBase = $3A0000;       { + labels of pass 1 }
  Tramp = $3B0000;          { F5: copies a 65C816 program to its origin }
  MerBuf = $220000;
  RvOrg = $040400;
  RvStubAt = $040000;

  { addressing modes }
  mImp = 0; mAcc = 1; mImm = 2; mDp = 3; mDpx = 4; mDpy = 5; mAbs = 6; mAbsx = 7; mAbsy = 8;
  mLong = 9; mLongx = 10; mInd = 11; mIndx = 12; mIndy = 13; mIndl = 14; mIndly = 15;
  mSr = 16; mSry = 17; mAbsind = 18; mAbsindx = 19; mAbsindl = 20;
  { mnemonic flags }
  fImmM = 1; fImmX = 2; fImm8 = 4; fBranch = 8; fRel16 = 16; fMove = 32; fImplied = 64; fJump = 128;

  NameBase = $392200;       { packed mnemonic names }
  MsgBase = $393800;        { error messages, 64 bytes each }
  NameHash = $392800;       { 512 slots of 8 bytes: packed name, its index }
  HashSlots = 512;
  MinusBase = $3B1000;      { the last 64 - labels }
  nM816 = 0; cM816 = 95;
  nRvR = 95; cRvR = 18;
  nRvI = 113; cRvI = 6;
  nRvSh = 119; cRvSh = 3;
  nRvLd = 122; cRvLd = 5;
  nRvSt = 127; cRvSt = 3;
  nRvBr = 130; cRvBr = 6;
  nRvOther = 136; cRvOther = 30;

var
  pass: integer;
  pc, origin, outLen: longint;
  linePC: longint;          { * : the address where the line starts }
  rvMode, mWide, xWide, haveOrigin: boolean;
  ip: integer;              { position in the line }
  ep, exAt: integer;
  nm: string[16];           { a symbol name in upper case }
  part, inner: TShort;      { parts of an instruction's operand }
  curLine: integer;
  nSyms: integer;
  exprUndef: boolean;       { pass 1: a symbol was not known yet }
  exprFwd: boolean;         { a symbol defined further down (or unknown in pass 1) }
  minusN, plusN, plusTotal: integer;
  tablesReady: boolean;
  inlineAt: integer;        { an asm block of a Pascal text: the line its text starts on (else 0) }

function CatchError: integer; external 'catch';
procedure ThrowError; external 'throw';

procedure Fail(const msg: string);
begin
  ErrMsg := msg;
  ErrUnit := '';
  if inlineAt > 0 then begin ErrUnit := AsmUnit; curLine := inlineAt + curLine - 1; end;
  ErrLine := curLine;
  ErrCol := ip;
  if ErrCol < 1 then ErrCol := 1;
  ThrowError;
end;

{ message n from the table, then extra }
procedure FailN(n: integer; const extra: string);
var i, k: integer;
    a: longint;
begin
  a := MsgBase + longint(n) * 64;
  k := Mem[a];
  ErrMsg[0] := chr(k);
  for i := 1 to k do ErrMsg[i] := chr(Mem[a + i]);
  if extra <> '' then ErrMsg := ErrMsg + extra;
  ErrUnit := '';
  if inlineAt > 0 then begin ErrUnit := AsmUnit; curLine := inlineAt + curLine - 1; end;
  ErrLine := curLine;
  ErrCol := ip;
  if ErrCol < 1 then ErrCol := 1;
  ThrowError;
end;

{ ------------------------------------------------------------ helpers }
function LowerC(c: char): char;
begin
  if (c >= 'A') and (c <= 'Z') then LowerC := chr(ord(c) + 32) else LowerC := c;
end;

function IsIdStart(c: char): boolean;
begin
  IsIdStart := ((c >= 'a') and (c <= 'z')) or ((c >= 'A') and (c <= 'Z')) or (c = '_') or (c = '.');
end;

function IsIdChar(c: char): boolean;
begin
  IsIdChar := IsIdStart(c) or ((c >= '0') and (c <= '9'));
end;

function Trim(const s: string): string;
var a, b: integer;
begin
  a := 1; b := length(s);
  while (a <= b) and ((s[a] = ' ') or (s[a] = #9)) do a := a + 1;
  while (b >= a) and ((s[b] = ' ') or (s[b] = #9)) do b := b - 1;
  Trim := Copy(s, a, b - a + 1);
end;

function LowerS(const s: string): string;
var t: string[100];
    i: integer;
begin
  t := s;
  for i := 1 to length(t) do t[i] := LowerC(t[i]);
  LowerS := t;
end;

{ a word, packed 5 bits a letter (a = 1); 0 if it is not 1 to 6 letters }
procedure BuildTables; forward;

function PackName(const w: string): longint;
var v: longint;
    i: integer;
    c: char;
begin
  v := 0;
  PackName := 0;
  if (length(w) < 1) or (length(w) > 6) then exit;
  for i := length(w) downto 1 do begin
    c := LowerC(w[i]);
    if (c < 'a') or (c > 'z') then exit;
    v := v * 32 + ord(c) - 96;
  end;
  PackName := v;
end;

{ position of the packed name p in a table (first, count), -1 if absent;
  a name can be in several tables (beq: 65C816 and RISC-V) }
function TabIndex(p: longint; first, n: integer): integer;
var h, g: integer;
    v: longint;
begin
  TabIndex := -1;
  if p = 0 then exit;
  h := (p xor (p shr 9)) and (HashSlots - 1);
  repeat
    v := MemL[NameHash + (longint(h) shl 3)];
    if v = p then begin
      g := MemW[NameHash + (longint(h) shl 3) + 4];
      if (g >= first) and (g < first + n) then begin TabIndex := g - first; exit; end;
    end;
    h := h + 1;
    if h = HashSlots then h := 0;
  until v = 0;
end;

function Mnem816(const w: string): integer;
begin
  Mnem816 := TabIndex(PackName(w), nM816, cM816);
end;

function IsMnemonic(const s: string): boolean;
var p: longint;
begin
  if not tablesReady then BuildTables;
  p := PackName(s);
  IsMnemonic := TabIndex(p, 0, 166) >= 0;
end;

{ ------------------------------------------------------------ 65C816 opcode table }
procedure SetOp(m, mode, op: integer);
begin
  MemW[OpBase + ((longint(m) shl 5) + mode) shl 1] := op + 1;
end;

function GetOp(m, mode: integer): integer;
begin
  GetOp := MemW[OpBase + ((longint(m) shl 5) + mode) shl 1] - 1;
end;

procedure Shift4(m, acc, dp, dpx, ab, abx: integer);
begin
  SetOp(m, mAcc, acc); SetOp(m, mDp, dp); SetOp(m, mDpx, dpx); SetOp(m, mAbs, ab); SetOp(m, mAbsx, abx);
end;

{ the error messages, 4 characters a number (text literals would take room
  in bank 0); written by a script. Message n starts at MsgBase + n * 64:
  its length, then the characters }
procedure BuildMessages;
begin
  MemL[MsgBase + 64] := 1869575184;
  MemL[MsgBase + 68] := 1851878688;
  MemL[MsgBase + 72] := 2037588089;
  MemL[MsgBase + 76] := 1819239021;
  MemL[MsgBase + 80] := 115;
  { too many symbols }
  MemL[MsgBase + 128] := 1836675862;
  MemL[MsgBase + 132] := 543977314;
  MemL[MsgBase + 136] := 1768318308;
  MemL[MsgBase + 140] := 543450478;
  MemL[MsgBase + 144] := 1667856244;
  MemL[MsgBase + 148] := 2112101;
  { symbol defined twice:  }
  MemL[MsgBase + 192] := 1634234383;
  MemL[MsgBase + 196] := 1696621939;
  MemL[MsgBase + 200] := 1919906418;
  MemL[MsgBase + 204] := 544497952;
  { phase error at  }
  MemL[MsgBase + 256] := 1684960529;
  MemL[MsgBase + 260] := 1852401253;
  MemL[MsgBase + 264] := 1931502693;
  MemL[MsgBase + 268] := 1868721529;
  MemL[MsgBase + 272] := 8300;
  { undefined symbol  }
  MemL[MsgBase + 320] := 1886938387;
  MemL[MsgBase + 324] := 1936942450;
  MemL[MsgBase + 328] := 544108393;
  MemL[MsgBase + 332] := 1701869669;
  MemL[MsgBase + 336] := 1684370531;
  { expression expected }
  MemL[MsgBase + 384] := 1936289033;
  MemL[MsgBase + 388] := 1735289203;
  MemL[MsgBase + 392] := 10528;
  { missing ) }
  MemL[MsgBase + 448] := 2019911699;
  MemL[MsgBase + 452] := 1734960160;
  MemL[MsgBase + 456] := 544437353;
  MemL[MsgBase + 460] := 1701869669;
  MemL[MsgBase + 464] := 1684370531;
  { hex digits expected }
  MemL[MsgBase + 512] := 1634231058;
  MemL[MsgBase + 516] := 1952670066;
  MemL[MsgBase + 520] := 1696625253;
  MemL[MsgBase + 524] := 1667592312;
  MemL[MsgBase + 528] := 6579572;
  { character expected }
  MemL[MsgBase + 576] := 1684103694;
  MemL[MsgBase + 580] := 1886938400;
  MemL[MsgBase + 584] := 1936942450;
  MemL[MsgBase + 588] := 7237481;
  { bad expression }
  MemL[MsgBase + 640] := 1986618384;
  MemL[MsgBase + 644] := 1869181801;
  MemL[MsgBase + 648] := 2036473966;
  MemL[MsgBase + 652] := 1919253024;
  MemL[MsgBase + 656] := 111;
  { division by zero }
  MemL[MsgBase + 704] := 1886938387;
  MemL[MsgBase + 708] := 1936942450;
  MemL[MsgBase + 712] := 544108393;
  MemL[MsgBase + 716] := 544173940;
  MemL[MsgBase + 720] := 1735290732;
  { expression too long }
  MemL[MsgBase + 768] := 1769107222;
  MemL[MsgBase + 772] := 544106855;
  MemL[MsgBase + 776] := 1702260589;
  MemL[MsgBase + 780] := 1633820787;
  MemL[MsgBase + 784] := 1635216227;
  MemL[MsgBase + 788] := 7562354;
  { origin moves backwards }
  MemL[MsgBase + 832] := 1869770778;
  MemL[MsgBase + 836] := 1835102823;
  MemL[MsgBase + 840] := 1918987296;
  MemL[MsgBase + 844] := 544367975;
  MemL[MsgBase + 848] := 1851877492;
  MemL[MsgBase + 852] := 909455904;
  MemL[MsgBase + 856] := 4344608;
  { program larger than 256 KB }
  MemL[MsgBase + 896] := 1869575185;
  MemL[MsgBase + 900] := 1851878688;
  MemL[MsgBase + 904] := 1886331001;
  MemL[MsgBase + 908] := 1851880037;
  MemL[MsgBase + 912] := 29540;
  { too many operands }
  MemL[MsgBase + 960] := 1701867279;
  MemL[MsgBase + 964] := 1684955506;
  MemL[MsgBase + 968] := 1936289056;
  MemL[MsgBase + 972] := 1735289203;
  { operand missing }
  MemL[MsgBase + 1024] := 544173584;
  MemL[MsgBase + 1028] := 1634476077;
  MemL[MsgBase + 1032] := 543974754;
  MemL[MsgBase + 1036] := 1987011169;
  MemL[MsgBase + 1040] := 101;
  { no - label above }
  MemL[MsgBase + 1088] := 544173584;
  MemL[MsgBase + 1092] := 1634476075;
  MemL[MsgBase + 1096] := 543974754;
  MemL[MsgBase + 1100] := 1869374818;
  MemL[MsgBase + 1104] := 119;
  { no + label below }
  MemL[MsgBase + 1152] := 1802401044;
  MemL[MsgBase + 1156] := 1853321070;
  MemL[MsgBase + 1160] := 1936615712;
  MemL[MsgBase + 1164] := 1668641396;
  MemL[MsgBase + 1168] := 1852795252;
  MemL[MsgBase + 1172] := 32;
  { unknown instruction  }
  MemL[MsgBase + 1216] := 1918989327;
  MemL[MsgBase + 1220] := 544499047;
  MemL[MsgBase + 1224] := 1701869669;
  MemL[MsgBase + 1228] := 1684370531;
  { target expected }
  MemL[MsgBase + 1280] := 1634886180;
  MemL[MsgBase + 1284] := 543712110;
  MemL[MsgBase + 1288] := 544503151;
  MemL[MsgBase + 1292] := 1914725999;
  MemL[MsgBase + 1296] := 1701277281;
  MemL[MsgBase + 1300] := 1937057824;
  MemL[MsgBase + 1304] := 1919033445;
  MemL[MsgBase + 1308] := 1919885420;
  MemL[MsgBase + 1312] := 1886218784;
  MemL[MsgBase + 1316] := 41;
  { branch out of range (use brl or jmp) }
  MemL[MsgBase + 1344] := 1870099474;
  MemL[MsgBase + 1348] := 1851875872;
  MemL[MsgBase + 1352] := 1696625515;
  MemL[MsgBase + 1356] := 1667592312;
  MemL[MsgBase + 1360] := 6579572;
  { two banks expected }
  MemL[MsgBase + 1408] := 1701867280;
  MemL[MsgBase + 1412] := 1684955506;
  MemL[MsgBase + 1416] := 1886938400;
  MemL[MsgBase + 1420] := 1702126437;
  MemL[MsgBase + 1424] := 100;
  { operand expected }
  MemL[MsgBase + 1472] := 1684300066;
  MemL[MsgBase + 1476] := 1936942450;
  MemL[MsgBase + 1480] := 543649385;
  MemL[MsgBase + 1484] := 1701080941;
  MemL[MsgBase + 1488] := 1953459744;
  MemL[MsgBase + 1492] := 1635148064;
  MemL[MsgBase + 1496] := 1650551913;
  MemL[MsgBase + 1500] := 1713399148;
  MemL[MsgBase + 1504] := 2126447;
  { addressing mode not available for  }
  MemL[MsgBase + 1536] := 1734701585;
  MemL[MsgBase + 1540] := 1702130537;
  MemL[MsgBase + 1544] := 2019893362;
  MemL[MsgBase + 1548] := 1952671088;
  MemL[MsgBase + 1552] := 25701;
  { register expected }
  MemL[MsgBase + 1600] := 1684103692;
  MemL[MsgBase + 1604] := 1734701600;
  MemL[MsgBase + 1608] := 1702130537;
  MemL[MsgBase + 1612] := 114;
  { bad register }
  MemL[MsgBase + 1664] := 1835363607;
  MemL[MsgBase + 1668] := 544830063;
  MemL[MsgBase + 1672] := 1919250543;
  MemL[MsgBase + 1676] := 543452769;
  MemL[MsgBase + 1680] := 1701869669;
  MemL[MsgBase + 1684] := 1684370531;
  { memory operand expected }
  MemL[MsgBase + 1728] := 1717989137;
  MemL[MsgBase + 1732] := 1734701608;
  MemL[MsgBase + 1736] := 2019893289;
  MemL[MsgBase + 1740] := 1952671088;
  MemL[MsgBase + 1744] := 25701;
  { off(reg) expected }
  MemL[MsgBase + 1792] := 1634886163;
  MemL[MsgBase + 1796] := 543712110;
  MemL[MsgBase + 1800] := 544503151;
  MemL[MsgBase + 1804] := 1914725999;
  MemL[MsgBase + 1808] := 1701277281;
  { branch out of range }
  MemL[MsgBase + 1856] := 1836411409;
  MemL[MsgBase + 1860] := 1970217072;
  MemL[MsgBase + 1864] := 1718558836;
  MemL[MsgBase + 1868] := 1851879968;
  MemL[MsgBase + 1872] := 25959;
  { jump out of range }
  MemL[MsgBase + 1920] := 1835886870;
  MemL[MsgBase + 1924] := 1634296933;
  MemL[MsgBase + 1928] := 1864394100;
  MemL[MsgBase + 1932] := 1864397941;
  MemL[MsgBase + 1936] := 1634869350;
  MemL[MsgBase + 1940] := 6645614;
  { immediate out of range }
  MemL[MsgBase + 1984] := 1684103690;
  MemL[MsgBase + 1988] := 1852140576;
  MemL[MsgBase + 1992] := 6845543;
  { bad length }
  MemL[MsgBase + 2048] := 1684103693;
  MemL[MsgBase + 2052] := 1768710432;
  MemL[MsgBase + 2056] := 1701670503;
  MemL[MsgBase + 2060] := 29806;
  { bad alignment }
  MemL[MsgBase + 2112] := 1802401042;
  MemL[MsgBase + 2116] := 1853321070;
  MemL[MsgBase + 2120] := 1919509536;
  MemL[MsgBase + 2124] := 1769235301;
  MemL[MsgBase + 2128] := 2123126;
  { unknown directive  }
  MemL[MsgBase + 2176] := 1869575185;
  MemL[MsgBase + 2180] := 1851878688;
  MemL[MsgBase + 2184] := 539697273;
  MemL[MsgBase + 2188] := 1700946284;
  MemL[MsgBase + 2192] := 29548;
  { too many + labels }
  MemL[MsgBase + 2240] := 1025518100;
  MemL[MsgBase + 2244] := 1684300064;
  MemL[MsgBase + 2248] := 1936942450;
  MemL[MsgBase + 2252] := 1886938400;
  MemL[MsgBase + 2256] := 1702126437;
  MemL[MsgBase + 2260] := 100;
  { * = address expected }
  MemL[MsgBase + 2304] := 1394630954;
  MemL[MsgBase + 2308] := 1112885315;
  MemL[MsgBase + 2312] := 1869770784;
  MemL[MsgBase + 2316] := 1835102823;
  MemL[MsgBase + 2320] := 1635021600;
  MemL[MsgBase + 2324] := 544437362;
  MemL[MsgBase + 2328] := 606106721;
  MemL[MsgBase + 2332] := 875574320;
  MemL[MsgBase + 2336] := 673198128;
  MemL[MsgBase + 2340] := 706768750;
  MemL[MsgBase + 2344] := 2702624;
  { a SCHUB program starts at $040400 (no * =) }
  MemL[MsgBase + 2368] := 1852402701;
  MemL[MsgBase + 2372] := 1869881445;
  MemL[MsgBase + 2376] := 1869357167;
  MemL[MsgBase + 2380] := 26478;
  { line too long }
  MemL[MsgBase + 2432] := 1953459731;
  MemL[MsgBase + 2436] := 1735289192;
  MemL[MsgBase + 2440] := 544175136;
  MemL[MsgBase + 2444] := 1702064993;
  MemL[MsgBase + 2448] := 1701601901;
  { nothing to assemble }
  MemL[MsgBase + 2496] := 1851876119;
  MemL[MsgBase + 2500] := 544501614;
  MemL[MsgBase + 2504] := 1965057378;
  MemL[MsgBase + 2508] := 543450483;
  MemL[MsgBase + 2512] := 1629515369;
  MemL[MsgBase + 2516] := 540700019;
  { cannot be used in asm:  }
end;

{ the names into the hash table (all of them; a name may be there twice) }
procedure HashNames;
var i, h: integer;
    p: longint;
begin
  FillMem(NameHash, HashSlots * 8, 0);
  for i := 0 to 165 do begin
    p := MemL[NameBase + longint(i) * 4];
    if p <> 0 then begin
      h := (p xor (p shr 9)) and (HashSlots - 1);
      while MemL[NameHash + (longint(h) shl 3)] <> 0 do begin
        h := h + 1;
        if h = HashSlots then h := 0;
      end;
      MemL[NameHash + (longint(h) shl 3)] := p;
      MemW[NameHash + (longint(h) shl 3) + 4] := i;
    end;
  end;
end;

{ the mnemonic names, packed 5 bits a letter (a = 1), as numbers in the
  code (text literals would take room in bank 0); written by a script }
procedure BuildNames;
begin
  MemL[NameBase + 0] := 1615;   { ora }
  MemL[NameBase + 4] := 4545;   { and }
  MemL[NameBase + 8] := 18917;   { eor }
  MemL[NameBase + 12] := 3201;   { adc }
  MemL[NameBase + 16] := 1683;   { sta }
  MemL[NameBase + 20] := 1164;   { lda }
  MemL[NameBase + 24] := 16803;   { cmp }
  MemL[NameBase + 28] := 3155;   { sbc }
  MemL[NameBase + 32] := 12897;   { asl }
  MemL[NameBase + 36] := 19052;   { lsr }
  MemL[NameBase + 40] := 12786;   { rol }
  MemL[NameBase + 44] := 18930;   { ror }
  MemL[NameBase + 48] := 3236;   { dec }
  MemL[NameBase + 52] := 3529;   { inc }
  MemL[NameBase + 56] := 20770;   { bit }
  MemL[NameBase + 60] := 25091;   { cpx }
  MemL[NameBase + 64] := 26115;   { cpy }
  MemL[NameBase + 68] := 24716;   { ldx }
  MemL[NameBase + 72] := 25740;   { ldy }
  MemL[NameBase + 76] := 25235;   { stx }
  MemL[NameBase + 80] := 26259;   { sty }
  MemL[NameBase + 84] := 27283;   { stz }
  MemL[NameBase + 88] := 2644;   { trb }
  MemL[NameBase + 92] := 2676;   { tsb }
  MemL[NameBase + 96] := 16810;   { jmp }
  MemL[NameBase + 100] := 12714;   { jml }
  MemL[NameBase + 104] := 19050;   { jsr }
  MemL[NameBase + 108] := 12906;   { jsl }
  MemL[NameBase + 112] := 1200;   { pea }
  MemL[NameBase + 116] := 9392;   { pei }
  MemL[NameBase + 120] := 16562;   { rep }
  MemL[NameBase + 124] := 16563;   { sep }
  MemL[NameBase + 128] := 16867;   { cop }
  MemL[NameBase + 132] := 11842;   { brk }
  MemL[NameBase + 136] := 12802;   { bpl }
  MemL[NameBase + 140] := 9634;   { bmi }
  MemL[NameBase + 144] := 3778;   { bvc }
  MemL[NameBase + 148] := 20162;   { bvs }
  MemL[NameBase + 152] := 3170;   { bcc }
  MemL[NameBase + 156] := 19554;   { bcs }
  MemL[NameBase + 160] := 5570;   { bne }
  MemL[NameBase + 164] := 17570;   { beq }
  MemL[NameBase + 168] := 1602;   { bra }
  MemL[NameBase + 172] := 20866;   { blt }
  MemL[NameBase + 176] := 5346;   { bge }
  MemL[NameBase + 180] := 12866;   { brl }
  MemL[NameBase + 184] := 18608;   { per }
  MemL[NameBase + 188] := 15053;   { mvn }
  MemL[NameBase + 192] := 17101;   { mvp }
  MemL[NameBase + 196] := 0;
  MemL[NameBase + 200] := 3459;   { clc }
  MemL[NameBase + 204] := 4483;   { cld }
  MemL[NameBase + 208] := 9603;   { cli }
  MemL[NameBase + 212] := 22915;   { clv }
  MemL[NameBase + 216] := 3251;   { sec }
  MemL[NameBase + 220] := 4275;   { sed }
  MemL[NameBase + 224] := 9395;   { sei }
  MemL[NameBase + 228] := 24740;   { dex }
  MemL[NameBase + 232] := 25764;   { dey }
  MemL[NameBase + 236] := 25033;   { inx }
  MemL[NameBase + 240] := 26057;   { iny }
  MemL[NameBase + 244] := 16878;   { nop }
  MemL[NameBase + 248] := 1296;   { pha }
  MemL[NameBase + 252] := 2320;   { phb }
  MemL[NameBase + 256] := 4368;   { phd }
  MemL[NameBase + 260] := 11536;   { phk }
  MemL[NameBase + 264] := 16656;   { php }
  MemL[NameBase + 268] := 24848;   { phx }
  MemL[NameBase + 272] := 25872;   { phy }
  MemL[NameBase + 276] := 1424;   { pla }
  MemL[NameBase + 280] := 2448;   { plb }
  MemL[NameBase + 284] := 4496;   { pld }
  MemL[NameBase + 288] := 16784;   { plp }
  MemL[NameBase + 292] := 24976;   { plx }
  MemL[NameBase + 296] := 26000;   { ply }
  MemL[NameBase + 300] := 9874;   { rti }
  MemL[NameBase + 304] := 12946;   { rtl }
  MemL[NameBase + 308] := 20114;   { rts }
  MemL[NameBase + 312] := 17043;   { stp }
  MemL[NameBase + 316] := 24628;   { tax }
  MemL[NameBase + 320] := 25652;   { tay }
  MemL[NameBase + 324] := 4212;   { tcd }
  MemL[NameBase + 328] := 19572;   { tcs }
  MemL[NameBase + 332] := 3220;   { tdc }
  MemL[NameBase + 336] := 3700;   { tsc }
  MemL[NameBase + 340] := 25204;   { tsx }
  MemL[NameBase + 344] := 1812;   { txa }
  MemL[NameBase + 348] := 20244;   { txs }
  MemL[NameBase + 352] := 26388;   { txy }
  MemL[NameBase + 356] := 1844;   { tya }
  MemL[NameBase + 360] := 25396;   { tyx }
  MemL[NameBase + 364] := 9271;   { wai }
  MemL[NameBase + 368] := 13463;   { wdm }
  MemL[NameBase + 372] := 1112;   { xba }
  MemL[NameBase + 376] := 5240;   { xce }
  MemL[NameBase + 380] := 4225;   { add }
  MemL[NameBase + 384] := 2739;   { sub }
  MemL[NameBase + 388] := 12691;   { sll }
  MemL[NameBase + 392] := 20883;   { slt }
  MemL[NameBase + 396] := 709011;   { sltu }
  MemL[NameBase + 400] := 18936;   { xor }
  MemL[NameBase + 404] := 12883;   { srl }
  MemL[NameBase + 408] := 1619;   { sra }
  MemL[NameBase + 412] := 591;   { or }
  MemL[NameBase + 416] := 4545;   { and }
  MemL[NameBase + 420] := 12973;   { mul }
  MemL[NameBase + 424] := 275117;   { mulh }
  MemL[NameBase + 428] := 724841133;   { mulhsu }
  MemL[NameBase + 432] := 22295213;   { mulhu }
  MemL[NameBase + 436] := 22820;   { div }
  MemL[NameBase + 440] := 710948;   { divu }
  MemL[NameBase + 444] := 13490;   { rem }
  MemL[NameBase + 448] := 701618;   { remu }
  MemL[NameBase + 452] := 299137;   { addi }
  MemL[NameBase + 456] := 315795;   { slti }
  MemL[NameBase + 460] := 22335891;   { sltiu }
  MemL[NameBase + 464] := 313848;   { xori }
  MemL[NameBase + 468] := 9807;   { ori }
  MemL[NameBase + 472] := 299457;   { andi }
  MemL[NameBase + 476] := 307603;   { slli }
  MemL[NameBase + 480] := 307795;   { srli }
  MemL[NameBase + 484] := 296531;   { srai }
  MemL[NameBase + 488] := 76;   { lb }
  MemL[NameBase + 492] := 268;   { lh }
  MemL[NameBase + 496] := 748;   { lw }
  MemL[NameBase + 500] := 21580;   { lbu }
  MemL[NameBase + 504] := 21772;   { lhu }
  MemL[NameBase + 508] := 83;   { sb }
  MemL[NameBase + 512] := 275;   { sh }
  MemL[NameBase + 516] := 755;   { sw }
  MemL[NameBase + 520] := 17570;   { beq }
  MemL[NameBase + 524] := 5570;   { bne }
  MemL[NameBase + 528] := 20866;   { blt }
  MemL[NameBase + 532] := 5346;   { bge }
  MemL[NameBase + 536] := 708994;   { bltu }
  MemL[NameBase + 540] := 693474;   { bgeu }
  MemL[NameBase + 544] := 9900;   { lui }
  MemL[NameBase + 548] := 3679905;   { auipc }
  MemL[NameBase + 552] := 12330;   { jal }
  MemL[NameBase + 556] := 602154;   { jalr }
  MemL[NameBase + 560] := 12977253;   { ecall }
  MemL[NameBase + 564] := 370329669;   { ebreak }
  MemL[NameBase + 568] := 5355686;   { fence }
  MemL[NameBase + 572] := 16878;   { nop }
  MemL[NameBase + 576] := 300;   { li }
  MemL[NameBase + 580] := 44;   { la }
  MemL[NameBase + 584] := 717;   { mv }
  MemL[NameBase + 588] := 20974;   { not }
  MemL[NameBase + 592] := 7342;   { neg }
  MemL[NameBase + 596] := 869555;   { seqz }
  MemL[NameBase + 600] := 857555;   { snez }
  MemL[NameBase + 604] := 10;   { j }
  MemL[NameBase + 608] := 586;   { jr }
  MemL[NameBase + 612] := 20658;   { ret }
  MemL[NameBase + 616] := 405539;   { call }
  MemL[NameBase + 620] := 402484;   { tail }
  MemL[NameBase + 624] := 869538;   { beqz }
  MemL[NameBase + 628] := 857538;   { bnez }
  MemL[NameBase + 632] := 872834;   { bltz }
  MemL[NameBase + 636] := 857314;   { bgez }
  MemL[NameBase + 640] := 872674;   { bgtz }
  MemL[NameBase + 644] := 857474;   { blez }
  MemL[NameBase + 648] := 20706;   { bgt }
  MemL[NameBase + 652] := 5506;   { ble }
  MemL[NameBase + 656] := 708834;   { bgtu }
  MemL[NameBase + 660] := 693634;   { bleu }
  HashNames;
end;

procedure BuildTables;
var m, i, b: integer;
const
  G1Off: array[0..14] of byte = ($09, $05, $15, $0D, $1D, $19, $0F, $1F, $12, $01, $11, $07, $17, $03, $13);
  G1Mode: array[0..14] of byte = (mImm, mDp, mDpx, mAbs, mAbsx, mAbsy, mLong, mLongx, mInd, mIndx, mIndy,
    mIndl, mIndly, mSr, mSry);
  Br: array[0..10] of byte = ($10, $30, $50, $70, $90, $B0, $D0, $F0, $80, $90, $B0);
  Imp: array[0..44] of byte = ($18, $D8, $58, $B8, $38, $F8, $78, $CA, $88, $E8, $C8, $EA, $48, $8B, $0B, $4B,
    $08, $DA, $5A, $68, $AB, $2B, $28, $FA, $7A, $40, $6B, $60, $DB, $AA, $A8, $5B, $1B, $7B, $3B, $BA, $8A,
    $9A, $9B, $98, $BB, $CB, $42, $EB, $FB);
begin
  BuildNames;
  BuildMessages;
  FillMem(OpBase, 100 * 32 * 2, 0);
  FillMem(FlagBase, 100, 0);
  { group 1: ora and eor adc sta lda cmp sbc }
  for m := 0 to 7 do begin
    b := m * $20;
    for i := 0 to 14 do
      if not ((m = 4) and (i = 0)) then SetOp(m, G1Mode[i], b + G1Off[i]);
    if m <> 4 then Mem[FlagBase + m] := fImmM;
  end;
  Shift4(8, $0A, $06, $16, $0E, $1E);         { asl }
  Shift4(9, $4A, $46, $56, $4E, $5E);         { lsr }
  Shift4(10, $2A, $26, $36, $2E, $3E);        { rol }
  Shift4(11, $6A, $66, $76, $6E, $7E);        { ror }
  Shift4(12, $3A, $C6, $D6, $CE, $DE);        { dec }
  Shift4(13, $1A, $E6, $F6, $EE, $FE);        { inc }
  SetOp(14, mImm, $89); SetOp(14, mDp, $24); SetOp(14, mDpx, $34); SetOp(14, mAbs, $2C); SetOp(14, mAbsx, $3C);
  Mem[FlagBase + 14] := fImmM;                { bit }
  SetOp(15, mImm, $E0); SetOp(15, mDp, $E4); SetOp(15, mAbs, $EC); Mem[FlagBase + 15] := fImmX;   { cpx }
  SetOp(16, mImm, $C0); SetOp(16, mDp, $C4); SetOp(16, mAbs, $CC); Mem[FlagBase + 16] := fImmX;   { cpy }
  SetOp(17, mImm, $A2); SetOp(17, mDp, $A6); SetOp(17, mDpy, $B6); SetOp(17, mAbs, $AE); SetOp(17, mAbsy, $BE);
  Mem[FlagBase + 17] := fImmX;                { ldx }
  SetOp(18, mImm, $A0); SetOp(18, mDp, $A4); SetOp(18, mDpx, $B4); SetOp(18, mAbs, $AC); SetOp(18, mAbsx, $BC);
  Mem[FlagBase + 18] := fImmX;                { ldy }
  SetOp(19, mDp, $86); SetOp(19, mDpy, $96); SetOp(19, mAbs, $8E);                    { stx }
  SetOp(20, mDp, $84); SetOp(20, mDpx, $94); SetOp(20, mAbs, $8C);                    { sty }
  SetOp(21, mDp, $64); SetOp(21, mDpx, $74); SetOp(21, mAbs, $9C); SetOp(21, mAbsx, $9E);   { stz }
  SetOp(22, mDp, $14); SetOp(22, mAbs, $1C);                                          { trb }
  SetOp(23, mDp, $04); SetOp(23, mAbs, $0C);                                          { tsb }
  SetOp(24, mAbs, $4C); SetOp(24, mLong, $5C); SetOp(24, mAbsind, $6C); SetOp(24, mAbsindx, $7C);
  SetOp(24, mAbsindl, $DC); Mem[FlagBase + 24] := fJump;                                { jmp }
  SetOp(25, mLong, $5C); SetOp(25, mAbsindl, $DC); Mem[FlagBase + 25] := fJump;         { jml }
  SetOp(26, mAbs, $20); SetOp(26, mAbsindx, $FC); SetOp(26, mLong, $22); Mem[FlagBase + 26] := fJump;   { jsr }
  SetOp(27, mLong, $22); Mem[FlagBase + 27] := fJump;                                   { jsl }
  SetOp(28, mAbs, $F4);                                                                { pea }
  SetOp(29, mInd, $D4);                                                                { pei }
  SetOp(30, mImm, $C2); Mem[FlagBase + 30] := fImm8;                                   { rep }
  SetOp(31, mImm, $E2); Mem[FlagBase + 31] := fImm8;                                   { sep }
  SetOp(32, mImm, $02); Mem[FlagBase + 32] := fImm8;                                   { cop }
  SetOp(33, mImm, $00); SetOp(33, mImp, $00); Mem[FlagBase + 33] := fImm8;             { brk }
  for i := 0 to 10 do begin SetOp(34 + i, mImp, Br[i]); Mem[FlagBase + 34 + i] := fBranch; end;
  SetOp(45, mImp, $82); Mem[FlagBase + 45] := fRel16;                                  { brl }
  SetOp(46, mImp, $62); Mem[FlagBase + 46] := fRel16;                                  { per }
  SetOp(47, mImp, $54); Mem[FlagBase + 47] := fMove;                                   { mvn }
  SetOp(48, mImp, $44); Mem[FlagBase + 48] := fMove;                                   { mvp }
  for i := 0 to 44 do begin SetOp(50 + i, mImp, Imp[i]); Mem[FlagBase + 50 + i] := fImplied; end;
  tablesReady := true;
end;

{ ------------------------------------------------------------ symbols }
{ entry: name (len + 15) at 0, value at 16, next at 20, line at 22,
  pass defined at 24, flags at 25 (1: unknown in pass 1), pass-1 value at 28 (aligned for SCHUB) }
function SymAdr(i: integer): longint;
begin
  SymAdr := SymBase + 512 + (longint(i - 1) shl 5);
end;

function Hash(const s: string): integer;
var h, i: integer;
begin
  h := 0;
  for i := 1 to length(s) do h := (h * 31 + ord(s[i])) and 255;
  Hash := h;
end;

{ nm := s in upper case, at most 15 characters }
procedure MakeName(const s: string);
var i, n: integer;
begin
  n := length(s);
  if n > 15 then n := 15;
  nm[0] := chr(n);
  for i := 1 to n do
    if (s[i] >= 'a') and (s[i] <= 'z') then nm[i] := chr(ord(s[i]) - 32) else nm[i] := s[i];
end;

function FindSym(const name: string): integer;
var i, k: integer;
    a: longint;
    ok: boolean;
begin
  i := MemW[SymBase + Hash(name) * 2];
  while i <> 0 do begin
    a := SymAdr(i);
    if Mem[a] = length(name) then begin
      ok := true; k := 1;
      while ok and (k <= length(name)) do begin
        if Mem[a + k] <> ord(name[k]) then ok := false;
        k := k + 1;
      end;
      if ok then begin FindSym := i; exit; end;
    end;
    i := MemW[a + 20];
  end;
  FindSym := 0;
end;

procedure Define(const rawName: string; v: longint; unknown: boolean);
var i, k, h: integer;
    a: longint;
begin
  MakeName(rawName);
  i := FindSym(nm);
  if i = 0 then begin
    if nSyms >= MaxSyms then FailN(1, '');
    nSyms := nSyms + 1;
    i := nSyms;
    a := SymAdr(i);
    Mem[a] := length(nm);
    for k := 1 to length(nm) do Mem[a + k] := ord(nm[k]);
    h := Hash(nm);
    MemW[a + 20] := MemW[SymBase + h * 2];
    MemW[SymBase + h * 2] := i;
  end else begin
    a := SymAdr(i);
    if Mem[a + 24] = pass then FailN(2, rawName);
    if (pass = 2) and (MemL[a + 28] <> v) and (Mem[a + 25] and 1 = 0) then FailN(3, rawName);
  end;
  MemL[a + 16] := v;
  MemW[a + 22] := curLine;
  Mem[a + 24] := pass;
  if pass = 1 then begin
    MemL[a + 28] := v;
    if unknown then Mem[a + 25] := 1 else Mem[a + 25] := 0;
  end;
end;

function SymValue(const rawName: string): longint;
var i, k: integer;
    a, v: longint;
begin
  SymValue := 0;
  MakeName(rawName);
  i := FindSym(nm);
  if i = 0 then begin
    { in an asm block: a name of the Pascal program }
    if inlineAt > 0 then begin
      for k := 0 to MemW[AsmNames] - 1 do begin
        a := AsmNames + 4 + longint(k) * 20;
        if Mem[a] and 127 = length(nm) then begin
          i := 1;
          while (i <= length(nm)) and (Mem[a + i] = ord(nm[i])) do i := i + 1;
          if i > length(nm) then begin
            if Mem[a] and 128 <> 0 then FailN(39, rawName);
            SymValue := MemL[a + 16];
            exit;
          end;
        end;
      end;
    end;
    if pass = 2 then FailN(4, rawName);
    exprUndef := true; exprFwd := true;
    exit;
  end;
  a := SymAdr(i);
  if (Mem[a + 24] <> pass) or (MemW[a + 22] > curLine) then begin
    { not defined yet in this pass: further down }
    exprFwd := true;
    if pass = 1 then begin exprUndef := true; exit; end;
  end;
  if Mem[a + 25] and 1 <> 0 then exprFwd := true;    { was unknown in pass 1 }
  if pass = 1 then if Mem[a + 25] and 1 <> 0 then exprUndef := true;
  SymValue := MemL[a + 16];
end;

{ ------------------------------------------------------------ expressions }
procedure SkipSp;
begin
  while (ip <= length(AsmWorkPtr^.lne)) and ((AsmWorkPtr^.lne[ip] = ' ') or (AsmWorkPtr^.lne[ip] = #9)) do ip := ip + 1;
end;

{ expressions are read from ex (ep the position, exAt the column in the line) }
procedure FailEx(const msg: string);
begin
  ip := exAt + ep - 1;
  Fail(msg);
end;

procedure FailExN(n: integer; const extra: string);
begin
  ip := exAt + ep - 1;
  FailN(n, extra);
end;

procedure SkipEx;
begin
  while (ep <= length(AsmWorkPtr^.exb)) and ((AsmWorkPtr^.exb[ep] = ' ') or (AsmWorkPtr^.exb[ep] = #9)) do ep := ep + 1;
end;

function Expr: longint; forward;

function HexDigit(c: char): integer;
begin
  c := LowerC(c);
  if (c >= '0') and (c <= '9') then HexDigit := ord(c) - 48
  else if (c >= 'a') and (c <= 'f') then HexDigit := ord(c) - 87
  else HexDigit := -1;
end;

function Prim: longint;
var c: char;
    v: longint;
    d: integer;
    name: string[40];
begin
  SkipEx;
  if ep > length(AsmWorkPtr^.exb) then FailExN(5, '');
  c := AsmWorkPtr^.exb[ep];
  v := 0;
  if c = '(' then begin
    ep := ep + 1;
    v := Expr;
    SkipEx;
    if (ep > length(AsmWorkPtr^.exb)) or (AsmWorkPtr^.exb[ep] <> ')') then FailExN(6, '');
    ep := ep + 1;
  end
  else if c = '-' then begin ep := ep + 1; v := -Prim; end
  else if c = '<' then begin ep := ep + 1; v := Prim and $FF; end
  else if c = '>' then begin ep := ep + 1; v := (Prim shr 8) and $FF; end
  else if (c = '^') or (c = '`') then begin ep := ep + 1; v := (Prim shr 16) and $FF; end
  else if c = '~' then begin ep := ep + 1; v := not Prim; end
  else if c = '$' then begin
    ep := ep + 1;
    if (ep > length(AsmWorkPtr^.exb)) or (HexDigit(AsmWorkPtr^.exb[ep]) < 0) then FailExN(7, '');
    while (ep <= length(AsmWorkPtr^.exb)) and (HexDigit(AsmWorkPtr^.exb[ep]) >= 0) do begin
      v := (v shl 4) or HexDigit(AsmWorkPtr^.exb[ep]);
      ep := ep + 1;
    end;
  end
  else if c = '%' then begin
    ep := ep + 1;
    while (ep <= length(AsmWorkPtr^.exb)) and ((AsmWorkPtr^.exb[ep] = '0') or (AsmWorkPtr^.exb[ep] = '1')) do begin
      v := (v shl 1) or (ord(AsmWorkPtr^.exb[ep]) - 48);
      ep := ep + 1;
    end;
  end
  else if c = '*' then begin ep := ep + 1; v := linePC; end
  else if (c = '''') or (c = '"') then begin
    if ep + 1 > length(AsmWorkPtr^.exb) then FailExN(8, '');
    v := ord(AsmWorkPtr^.exb[ep + 1]);
    ep := ep + 3;
  end
  else if (c = '0') and (ep < length(AsmWorkPtr^.exb)) and (LowerC(AsmWorkPtr^.exb[ep + 1]) = 'x') then begin
    ep := ep + 2;
    while (ep <= length(AsmWorkPtr^.exb)) and (HexDigit(AsmWorkPtr^.exb[ep]) >= 0) do begin
      v := (v shl 4) or HexDigit(AsmWorkPtr^.exb[ep]);
      ep := ep + 1;
    end;
  end
  else if (c >= '0') and (c <= '9') then begin
    while (ep <= length(AsmWorkPtr^.exb)) and (AsmWorkPtr^.exb[ep] >= '0') and (AsmWorkPtr^.exb[ep] <= '9') do begin
      v := v * 10 + ord(AsmWorkPtr^.exb[ep]) - 48;
      ep := ep + 1;
    end;
  end
  else if IsIdStart(c) then begin
    name := '';
    while (ep <= length(AsmWorkPtr^.exb)) and IsIdChar(AsmWorkPtr^.exb[ep]) do begin
      if length(name) < 40 then name := name + AsmWorkPtr^.exb[ep];
      ep := ep + 1;
    end;
    v := SymValue(name);
  end
  else FailExN(9, '');
  Prim := v;
end;

function MulExpr: longint;
var v, r: longint;
    done: boolean;
begin
  v := Prim;
  done := false;
  repeat
    SkipEx;
    if (ep <= length(AsmWorkPtr^.exb)) and (AsmWorkPtr^.exb[ep] = '*') then begin ep := ep + 1; v := v * Prim; end
    else if (ep <= length(AsmWorkPtr^.exb)) and (AsmWorkPtr^.exb[ep] = '/') then begin
      ep := ep + 1; r := Prim;
      if r = 0 then begin if pass = 2 then FailExN(10, ''); v := 0; end else v := v div r;
    end
    else if (ep < length(AsmWorkPtr^.exb)) and (AsmWorkPtr^.exb[ep] = '<') and (AsmWorkPtr^.exb[ep + 1] = '<') then begin ep := ep + 2; v := v shl Prim; end
    else if (ep < length(AsmWorkPtr^.exb)) and (AsmWorkPtr^.exb[ep] = '>') and (AsmWorkPtr^.exb[ep + 1] = '>') then begin ep := ep + 2; v := v shr Prim; end
    else done := true;
  until done;
  MulExpr := v;
end;

function SumExpr: longint;
var v: longint;
    done: boolean;
begin
  v := MulExpr;
  done := false;
  repeat
    SkipEx;
    if (ep <= length(AsmWorkPtr^.exb)) and (AsmWorkPtr^.exb[ep] = '+') then begin ep := ep + 1; v := v + MulExpr; end
    else if (ep <= length(AsmWorkPtr^.exb)) and (AsmWorkPtr^.exb[ep] = '-') then begin ep := ep + 1; v := v - MulExpr; end
    else done := true;
  until done;
  SumExpr := v;
end;

function Expr: longint;
var v: longint;
    done: boolean;
begin
  v := SumExpr;
  done := false;
  repeat
    SkipEx;
    if (ep <= length(AsmWorkPtr^.exb)) and (AsmWorkPtr^.exb[ep] = '&') then begin ep := ep + 1; v := v and SumExpr; end
    else if (ep <= length(AsmWorkPtr^.exb)) and (AsmWorkPtr^.exb[ep] = '|') then begin ep := ep + 1; v := v or SumExpr; end
    else done := true;
  until done;
  Expr := v;
end;

{ the value of the text s, which starts in column at of the line }
function EvalStr(const s: string; at: integer): longint;
var v: longint;
begin
  AsmWorkPtr^.exb := s; ep := 1; exAt := at;
  v := Expr;
  SkipEx;
  if ep <= length(AsmWorkPtr^.exb) then FailExN(9, '');
  EvalStr := v;
end;

{ the expression in columns a..b of the line }
function EvalCols(a, b: integer): longint;
var j, n: integer;
    v: longint;
begin
  n := b - a + 1;
  if n < 0 then n := 0;
  if n > 100 then begin ip := a; FailN(11, ''); end;
  AsmWorkPtr^.exb[0] := chr(n);
  for j := 1 to n do AsmWorkPtr^.exb[j] := AsmWorkPtr^.lne[a + j - 1];
  ep := 1; exAt := a;
  v := Expr;
  SkipEx;
  if ep <= length(AsmWorkPtr^.exb) then FailExN(9, '');
  EvalCols := v;
end;

{ the expression from column ip of the line to its end }
function EvalRest: longint;
begin
  EvalRest := EvalCols(ip, length(AsmWorkPtr^.lne));
  ip := length(AsmWorkPtr^.lne) + 1;
end;

{ ------------------------------------------------------------ output }
procedure Emit(b: longint);
var off: longint;
begin
  if not haveOrigin then begin origin := pc; haveOrigin := true; end;
  off := pc - origin;
  if off < 0 then FailN(12, '');
  if off >= MaxOut then FailN(13, '');
  if pass = 2 then Mem[Stage + off] := b and 255;
  pc := pc + 1;
  if off + 1 > outLen then outLen := off + 1;
end;

procedure Emit16(v: longint);
begin
  Emit(v); Emit(v shr 8);
end;

procedure Emit32(v: longint);
begin
  Emit(v); Emit(v shr 8); Emit(v shr 16); Emit(v shr 24);
end;

{ ------------------------------------------------------------ arguments }
const MaxArg = 16;
var nArg: integer;
    argA, argB: array[1..MaxArg] of integer;   { first and last column in ln }

{ split ln from column at to its end, at commas outside quotes and brackets }
procedure SplitArgs(at: integer);
var i, depth, start: integer;
    q: char;

  procedure Add(a, b: integer);
  begin
    while (a <= b) and ((AsmWorkPtr^.lne[a] = ' ') or (AsmWorkPtr^.lne[a] = #9)) do a := a + 1;
    while (b >= a) and ((AsmWorkPtr^.lne[b] = ' ') or (AsmWorkPtr^.lne[b] = #9)) do b := b - 1;
    if a > b then exit;
    if nArg = MaxArg then FailN(14, '');
    nArg := nArg + 1; argA[nArg] := a; argB[nArg] := b;
  end;

begin
  nArg := 0; depth := 0; q := #0; start := at;
  i := at;
  while i <= length(AsmWorkPtr^.lne) do begin
    if q <> #0 then begin if AsmWorkPtr^.lne[i] = q then q := #0; end
    else if AsmWorkPtr^.lne[i] = '"' then q := '"'
    else if (AsmWorkPtr^.lne[i] = '''') and (i + 2 <= length(AsmWorkPtr^.lne)) and (AsmWorkPtr^.lne[i + 2] = '''') then i := i + 2
    else if (AsmWorkPtr^.lne[i] = ',') and (depth = 0) then begin Add(start, i - 1); start := i + 1; end
    else if (AsmWorkPtr^.lne[i] = '(') or (AsmWorkPtr^.lne[i] = '[') then depth := depth + 1
    else if (AsmWorkPtr^.lne[i] = ')') or (AsmWorkPtr^.lne[i] = ']') then depth := depth - 1;
    i := i + 1;
  end;
  Add(start, length(AsmWorkPtr^.lne));
end;

function ArgStr(k: integer): string;
begin
  if k > nArg then FailN(15, '');
  ArgStr := Copy(AsmWorkPtr^.lne, argA[k], argB[k] - argA[k] + 1);
end;

function Ev(k: integer): longint;
begin
  if k > nArg then FailN(15, '');
  Ev := EvalCols(argA[k], argB[k]);
end;

{ ------------------------------------------------------------ 65C816 }
{ anonymous labels: +, ++, -, -- }
function AnonRef(const s: string): longint;
var n, k: integer;
begin
  n := length(s);
  AnonRef := 0;
  if s[1] = '-' then begin
    if n > minusN then FailN(16, '');
    k := (minusN - n) and 63;
    AnonRef := MemL[MinusBase + longint(k) * 4];
  end else begin
    exprFwd := true;
    if pass = 1 then begin exprUndef := true; exit; end;
    k := plusN + n - 1;
    if k >= plusTotal then FailN(17, '');
    AnonRef := MemL[AnonBase + longint(k) * 4];
  end;
end;

function AllSame(const s: string; c: char): boolean;
var i: integer;
begin
  AllSame := length(s) > 0;
  for i := 1 to length(s) do if s[i] <> c then AllSame := false;
end;

{ t := s[a..b] without the spaces around it (no string temporaries: the
  stack is short) }
procedure SubTo(var t: TShort; const s: string; a, b: integer);
var j: integer;
begin
  while (a <= b) and ((s[a] = ' ') or (s[a] = #9)) do a := a + 1;
  while (b >= a) and ((s[b] = ' ') or (s[b] = #9)) do b := b - 1;
  if b - a + 1 > 100 then b := a + 99;
  t[0] := chr(0);
  if b < a then exit;
  t[0] := chr(b - a + 1);
  for j := a to b do t[j - a + 1] := s[j];
end;

{ s[a..]: only spaces }
function EmptyFrom(const s: string; a: integer): boolean;
begin
  while (a <= length(s)) and ((s[a] = ' ') or (s[a] = #9)) do a := a + 1;
  EmptyFrom := a > length(s);
end;

{ s[a..] is spaces, one letter, spaces: the letter in lower case, else #0 }
function OneLetter(const s: string; a: integer): char;
var c: char;
begin
  OneLetter := #0;
  while (a <= length(s)) and ((s[a] = ' ') or (s[a] = #9)) do a := a + 1;
  if a > length(s) then exit;
  c := LowerC(s[a]);
  if EmptyFrom(s, a + 1) then OneLetter := c;
end;

{ the operand's last top-level ",x" ",y" ",s": the index letter, or #0;
  the part before it goes to part }
function IndexOf(const s: string): char;
var i, depth: integer;
    q: boolean;
    c: char;
begin
  IndexOf := #0;
  depth := 0; q := false;
  for i := length(s) downto 1 do begin
    if s[i] = '"' then q := not q;
    if not q then begin
      if (s[i] = ')') or (s[i] = ']') then depth := depth + 1;
      if (s[i] = '(') or (s[i] = '[') then depth := depth - 1;
      if (s[i] = ',') and (depth = 0) then begin
        c := OneLetter(s, i + 1);
        if (c = 'x') or (c = 'y') or (c = 's') then begin
          IndexOf := c;
          SubTo(part, s, 1, i - 1);
          exit;
        end;
        SubTo(part, s, 1, length(s));
        exit;
      end;
    end;
  end;
  SubTo(part, s, 1, length(s));
end;

{ the bracket that closes the one at s[1] }
function Closing(const s: string): integer;
var i, depth: integer;
begin
  Closing := 0;
  depth := 0;
  for i := 1 to length(s) do begin
    if (s[i] = '(') or (s[i] = '[') then depth := depth + 1;
    if (s[i] = ')') or (s[i] = ']') then begin
      depth := depth - 1;
      if depth = 0 then begin Closing := i; exit; end;
    end;
  end;
end;

procedure Ins816(const mn: string; at: integer);
var m, fl, mode, nb, op, i, k: integer;
    size, ix: char;
    tailEmpty, tailY: boolean;
    v, t, d: longint;
    want: char;
begin
  m := Mnem816(mn);
  if m < 0 then FailN(18, mn);
  fl := Mem[FlagBase + m];
  SubTo(AsmWorkPtr^.opd, AsmWorkPtr^.lne, at, length(AsmWorkPtr^.lne));
  { implied }
  if fl and fImplied <> 0 then begin
    if AsmWorkPtr^.opd <> '' then Fail(mn + ' takes no operand');
    Emit(GetOp(m, mImp));
    exit;
  end;
  { branches }
  if fl and (fBranch or fRel16) <> 0 then begin
    if AsmWorkPtr^.opd = '' then FailN(19, '');
    exprFwd := false; exprUndef := false;
    if AllSame(AsmWorkPtr^.opd, '+') or AllSame(AsmWorkPtr^.opd, '-') then t := AnonRef(AsmWorkPtr^.opd) else t := EvalStr(AsmWorkPtr^.opd, at);
    if fl and fBranch <> 0 then begin
      d := t - (pc + 2);
      if (pass = 2) and ((d < -128) or (d > 127)) then FailN(20, '');
      Emit(GetOp(m, mImp)); Emit(d);
    end else begin
      d := t - (pc + 3);
      Emit(GetOp(m, mImp)); Emit16(d);
    end;
    exit;
  end;
  if fl and fMove <> 0 then begin
    SplitArgs(at);
    if nArg <> 2 then FailN(21, '');
    for i := 1 to 2 do if AsmWorkPtr^.lne[argA[i]] = '#' then argA[i] := argA[i] + 1;
    v := Ev(1); t := Ev(2);
    Emit(GetOp(m, mImp)); Emit(t); Emit(v);
    exit;
  end;
  { size prefix }
  size := #0;
  if (length(AsmWorkPtr^.opd) >= 2) and (AsmWorkPtr^.opd[1] = '@') and ((LowerC(AsmWorkPtr^.opd[2]) = 'b') or (LowerC(AsmWorkPtr^.opd[2]) = 'w') or (LowerC(AsmWorkPtr^.opd[2]) = 'l')) then begin
    size := LowerC(AsmWorkPtr^.opd[2]);
    SubTo(AsmWorkPtr^.opd, AsmWorkPtr^.opd, 3, length(AsmWorkPtr^.opd));
    at := at + 2;
  end;
  exprFwd := false; exprUndef := false;
  v := 0;
  mode := -1;
  if AsmWorkPtr^.opd = '' then begin
    if GetOp(m, mImp) >= 0 then mode := mImp
    else if GetOp(m, mAcc) >= 0 then mode := mAcc
    else FailN(22, '');
    nb := 0;
  end
  else if (length(AsmWorkPtr^.opd) = 1) and (LowerC(AsmWorkPtr^.opd[1]) = 'a') then begin mode := mAcc; nb := 0; end
  else if AsmWorkPtr^.opd[1] = '#' then begin
    if fl and fImm8 <> 0 then nb := 1
    else if fl and fImmX <> 0 then begin if xWide then nb := 2 else nb := 1; end
    else begin if mWide then nb := 2 else nb := 1; end;
    if size = 'b' then nb := 1;
    if size = 'w' then nb := 2;
    SubTo(part, AsmWorkPtr^.opd, 2, length(AsmWorkPtr^.opd));
    v := EvalStr(part, at + 1);
    mode := mImm;
  end
  else begin
    { indirect forms: (e,s),y  (e,x)  (e),y  [e],y  [e]  (e) }
    if (AsmWorkPtr^.opd[1] = '(') or (AsmWorkPtr^.opd[1] = '[') then begin
      i := Closing(AsmWorkPtr^.opd);
      if i > 0 then begin
        { after the bracket: nothing, or ,y }
        tailEmpty := EmptyFrom(AsmWorkPtr^.opd, i + 1);
        tailY := false;
        if not tailEmpty then begin
          k := i + 1;
          while (k <= length(AsmWorkPtr^.opd)) and ((AsmWorkPtr^.opd[k] = ' ') or (AsmWorkPtr^.opd[k] = #9)) do k := k + 1;
          tailY := (AsmWorkPtr^.opd[k] = ',') and (OneLetter(AsmWorkPtr^.opd, k + 1) = 'y');
        end;
        SubTo(inner, AsmWorkPtr^.opd, 2, i - 1);
        if AsmWorkPtr^.opd[1] = '[' then begin
          if tailY then mode := mIndly else if tailEmpty then mode := mIndl;
          if mode >= 0 then v := EvalStr(inner, at + 1);
        end else if tailY then begin
          ix := IndexOf(inner);
          if ix = 's' then mode := mSry else if ix = #0 then mode := mIndy;
          if mode >= 0 then v := EvalStr(part, at + 1);
        end else if tailEmpty then begin
          ix := IndexOf(inner);
          if ix = 'x' then mode := mIndx else if ix = #0 then mode := mInd;
          if mode >= 0 then v := EvalStr(part, at + 1);
        end;
        if mode >= 0 then begin
          if fl and fJump <> 0 then begin
            if mode = mInd then mode := mAbsind
            else if mode = mIndx then mode := mAbsindx
            else if mode = mIndl then mode := mAbsindl;
          end;
          if (mode = mAbsind) or (mode = mAbsindx) or (mode = mAbsindl) then nb := 2 else nb := 1;
        end;
      end;
    end;
    if mode < 0 then begin
      ix := IndexOf(AsmWorkPtr^.opd);
      if AllSame(part, '+') or AllSame(part, '-') then v := AnonRef(part) else v := EvalStr(part, at);
      if ix = 's' then begin mode := mSr; nb := 1; end
      else begin
        want := size;
        if want = #0 then begin
          if fl and fJump <> 0 then begin if (v > $FFFF) and not exprFwd then want := 'l' else want := 'w'; end
          else if exprFwd then want := 'w'
          else if (v > $FFFF) or (v < 0) then want := 'l'
          else if v <= $FF then want := 'b'
          else want := 'w';
        end;
        if m = 28 then begin mode := mAbs; nb := 2; end     { pea }
        else begin
          { candidates in order: direct page, absolute, long }
          if want = 'b' then begin
            if ix = 'x' then begin mode := mDpx; nb := 1; end
            else if ix = 'y' then begin mode := mDpy; nb := 1; end
            else begin mode := mDp; nb := 1; end;
            if GetOp(m, mode) < 0 then want := 'w';
          end;
          if want = 'w' then begin
            if ix = 'x' then mode := mAbsx else if ix = 'y' then mode := mAbsy else mode := mAbs;
            nb := 2;
            if GetOp(m, mode) < 0 then want := 'l';
          end;
          if want = 'l' then begin
            if ix = 'x' then mode := mLongx else if ix = 'y' then mode := -2 else mode := mLong;
            nb := 3;
          end;
        end;
      end;
    end;
  end;
  if (mode < 0) or (GetOp(m, mode) < 0) then FailN(23, mn);
  Emit(GetOp(m, mode));
  for i := 1 to nb do begin Emit(v); v := v shr 8; end;
end;

{ ------------------------------------------------------------ RV32IM }
function Reg(k: integer): longint;
var s: string[16];
    i, n: integer;
    c: char;
begin
  if k > nArg then FailN(24, '');
  ip := argA[k];
  n := argB[k] - argA[k] + 1;
  if n > 16 then FailN(25, '');
  s[0] := chr(n);
  for i := 1 to n do s[i] := LowerC(AsmWorkPtr^.lne[argA[k] + i - 1]);
  Reg := 0;
  if s = 'zero' then exit;
  if s = 'ra' then begin Reg := 1; exit; end;
  if s = 'sp' then begin Reg := 2; exit; end;
  if s = 'gp' then begin Reg := 3; exit; end;
  if s = 'tp' then begin Reg := 4; exit; end;
  if s = 'fp' then begin Reg := 8; exit; end;
  if length(s) < 2 then FailN(25, '');
  c := s[1];
  n := 0;
  for i := 2 to length(s) do begin
    if (s[i] < '0') or (s[i] > '9') or (length(s) > 3) then FailN(25, '');
    n := n * 10 + ord(s[i]) - 48;
  end;
  if (c = 'x') and (n <= 31) then Reg := n
  else if (c = 'a') and (n <= 7) then Reg := 10 + n
  else if (c = 't') and (n <= 2) then Reg := 5 + n
  else if (c = 't') and (n <= 6) then Reg := 25 + n
  else if (c = 's') and (n <= 1) then Reg := 8 + n
  else if (c = 's') and (n <= 11) then Reg := 16 + n
  else FailN(25, '');
end;

{ off(reg): the offset and the register }
function EmptyRange(a, b: integer): boolean;
begin
  while (a <= b) and ((AsmWorkPtr^.lne[a] = ' ') or (AsmWorkPtr^.lne[a] = #9)) do a := a + 1;
  EmptyRange := a > b;
end;

procedure MemArg(k: integer; var off, r: longint);
var i, a, b: integer;
begin
  if k > nArg then FailN(26, '');
  a := argA[k]; b := argB[k];
  ip := a;
  if AsmWorkPtr^.lne[b] <> ')' then FailN(27, '');
  i := b;
  while (i > a) and (AsmWorkPtr^.lne[i] <> '(') do i := i - 1;
  if AsmWorkPtr^.lne[i] <> '(' then FailN(27, '');
  if EmptyRange(a, i - 1) then off := 0 else off := EvalCols(a, i - 1);
  argA[k] := i + 1; argB[k] := b - 1;
  r := Reg(k);
end;

function EncR(f7, f3, rd, rs1, rs2: longint): longint;
begin
  EncR := (f7 shl 25) or (rs2 shl 20) or (rs1 shl 15) or (f3 shl 12) or (rd shl 7) or $33;
end;

function EncI(op, f3, rd, rs1, imm: longint): longint;
begin
  EncI := ((imm and $FFF) shl 20) or (rs1 shl 15) or (f3 shl 12) or (rd shl 7) or op;
end;

function EncS(f3, rs2, rs1, imm: longint): longint;
begin
  EncS := (((imm shr 5) and $7F) shl 25) or (rs2 shl 20) or (rs1 shl 15) or (f3 shl 12) or ((imm and $1F) shl 7) or $23;
end;

function EncB(f3, rs1, rs2, off: longint): longint;
var o: longint;
begin
  o := off and $1FFF;
  EncB := (((o shr 12) and 1) shl 31) or (((o shr 5) and $3F) shl 25) or (rs2 shl 20) or (rs1 shl 15) or
    (f3 shl 12) or (((o shr 1) and $F) shl 8) or (((o shr 11) and 1) shl 7) or $63;
end;

function EncU(op, rd, imm20: longint): longint;
begin
  EncU := ((imm20 and $FFFFF) shl 12) or (rd shl 7) or op;
end;

function EncJ(rd, off: longint): longint;
var o: longint;
begin
  o := off and $1FFFFF;
  EncJ := (((o shr 20) and 1) shl 31) or (((o shr 1) and $3FF) shl 21) or (((o shr 11) and 1) shl 20) or
    (((o shr 12) and $FF) shl 12) or (rd shl 7) or $6F;
end;

function Fits12(v: longint): boolean;
begin
  Fits12 := (v >= -2048) and (v <= 2047);
end;

procedure HiLo(v: longint; var hi, lo: longint);
begin
  lo := v and $FFF;
  if lo >= $800 then lo := lo - $1000;
  hi := ((v - lo) shr 12) and $FFFFF;
end;

procedure Branch(f3, rs1, rs2: longint; k: integer);
var t, off: longint;
begin
  exprFwd := false; exprUndef := false;
  t := Ev(k);
  off := t - pc;
  if (pass = 2) and ((off < -4096) or (off > 4094) or odd(off)) then FailN(28, '');
  Emit32(EncB(f3, rs1, rs2, off));
end;

function JumpOff(k: integer): longint;
var off: longint;
begin
  off := Ev(k) - pc;
  if (pass = 2) and ((off < -1048576) or (off > 1048574)) then FailN(29, '');
  JumpOff := off;
end;

procedure InsRV(const mn: string; at: integer);
var k: integer;
    v, hi, lo, off, r, rd: longint;
begin
  SplitArgs(at);
  k := TabIndex(PackName(mn), nRvR, cRvR);
  if k >= 0 then begin
    case k of
      0: v := $000; 1: v := $2000; 2: v := $001; 3: v := $002; 4: v := $003; 5: v := $004; 6: v := $005;
      7: v := $2005; 8: v := $006; 9: v := $007;
      10: v := $100; 11: v := $101; 12: v := $102; 13: v := $103; 14: v := $104; 15: v := $105; 16: v := $106;
      17: v := $107;
    end;
    { v: f7 * $100 / $1000 style: low 3 bits f3, $100 = mul group, $2000 = sub/sra }
    if v and $2000 <> 0 then hi := $20 else if v and $100 <> 0 then hi := 1 else hi := 0;
    Emit32(EncR(hi, v and 7, Reg(1), Reg(2), Reg(3)));
    exit;
  end;
  k := TabIndex(PackName(mn), nRvI, cRvI);
  if k >= 0 then begin
    case k of 0: off := 0; 1: off := 2; 2: off := 3; 3: off := 4; 4: off := 6; 5: off := 7; end;
    v := Ev(3);
    if (pass = 2) and not Fits12(v) then FailN(30, '');
    Emit32(EncI($13, off, Reg(1), Reg(2), v));
    exit;
  end;
  k := TabIndex(PackName(mn), nRvSh, cRvSh);
  if k >= 0 then begin
    v := Ev(3) and 31;
    if k = 0 then Emit32(EncI($13, 1, Reg(1), Reg(2), v))
    else if k = 1 then Emit32(EncI($13, 5, Reg(1), Reg(2), v))
    else Emit32(EncI($13, 5, Reg(1), Reg(2), v or $400));
    exit;
  end;
  k := TabIndex(PackName(mn), nRvLd, cRvLd);
  if k >= 0 then begin
    case k of 0: v := 0; 1: v := 1; 2: v := 2; 3: v := 4; 4: v := 5; end;
    rd := Reg(1);
    MemArg(2, off, r);
    Emit32(EncI($03, v, rd, r, off));
    exit;
  end;
  k := TabIndex(PackName(mn), nRvSt, cRvSt);
  if k >= 0 then begin
    rd := Reg(1);
    MemArg(2, off, r);
    Emit32(EncS(k, rd, r, off));
    exit;
  end;
  k := TabIndex(PackName(mn), nRvBr, cRvBr);
  if k >= 0 then begin
    case k of 0: v := 0; 1: v := 1; 2: v := 4; 3: v := 5; 4: v := 6; 5: v := 7; end;
    Branch(v, Reg(1), Reg(2), 3);
    exit;
  end;
  k := TabIndex(PackName(mn), nRvOther, cRvOther);
  case k of
    0: Emit32(EncU($37, Reg(1), Ev(2)));                         { lui }
    1: Emit32(EncU($17, Reg(1), Ev(2)));                         { auipc }
    2: if nArg = 1 then Emit32(EncJ(1, JumpOff(1)))              { jal }
       else Emit32(EncJ(Reg(1), JumpOff(2)));
    3: if nArg = 1 then Emit32(EncI($67, 0, 1, Reg(1), 0))       { jalr }
       else if (nArg = 2) and (Pos('(', ArgStr(2)) > 0) then begin
         rd := Reg(1); MemArg(2, off, r); Emit32(EncI($67, 0, rd, r, off));
       end
       else if nArg = 3 then Emit32(EncI($67, 0, Reg(1), Reg(2), Ev(3)))
       else Emit32(EncI($67, 0, Reg(1), Reg(2), 0));
    4: Emit32($73);                                              { ecall }
    5: Emit32($00100073);                                        { ebreak }
    6: Emit32($0FF0000F);                                        { fence }
    7: Emit32(EncI($13, 0, 0, 0, 0));                            { nop }
    8: begin                                                     { li }
         rd := Reg(1);
         exprFwd := false; exprUndef := false;
         v := Ev(2);
         if Fits12(v) and not exprFwd then Emit32(EncI($13, 0, rd, 0, v))
         else begin HiLo(v, hi, lo); Emit32(EncU($37, rd, hi)); Emit32(EncI($13, 0, rd, rd, lo)); end;
       end;
    9: begin rd := Reg(1); HiLo(Ev(2), hi, lo); Emit32(EncU($37, rd, hi)); Emit32(EncI($13, 0, rd, rd, lo)); end;   { la }
    10: Emit32(EncI($13, 0, Reg(1), Reg(2), 0));                 { mv }
    11: Emit32(EncI($13, 4, Reg(1), Reg(2), -1));                { not }
    12: Emit32(EncR($20, 0, Reg(1), 0, Reg(2)));                 { neg }
    13: Emit32(EncI($13, 3, Reg(1), Reg(2), 1));                 { seqz }
    14: Emit32(EncR(0, 3, Reg(1), 0, Reg(2)));                   { snez }
    15: Emit32(EncJ(0, JumpOff(1)));                             { j }
    16: Emit32(EncI($67, 0, 0, Reg(1), 0));                      { jr }
    17: Emit32(EncI($67, 0, 0, 1, 0));                           { ret }
    18: Emit32(EncJ(1, JumpOff(1)));                             { call }
    19: Emit32(EncJ(0, JumpOff(1)));                             { tail }
    20: Branch(0, Reg(1), 0, 2);                                 { beqz }
    21: Branch(1, Reg(1), 0, 2);                                 { bnez }
    22: Branch(4, Reg(1), 0, 2);                                 { bltz }
    23: Branch(5, Reg(1), 0, 2);                                 { bgez }
    24: Branch(4, 0, Reg(1), 2);                                 { bgtz }
    25: Branch(5, 0, Reg(1), 2);                                 { blez }
    26: Branch(4, Reg(2), Reg(1), 3);                            { bgt }
    27: Branch(5, Reg(2), Reg(1), 3);                            { ble }
    28: Branch(6, Reg(2), Reg(1), 3);                            { bgtu }
    29: Branch(7, Reg(2), Reg(1), 3);                            { bleu }
  else
    FailN(18, mn);
  end;
end;

{ ------------------------------------------------------------ directives }
procedure Directive(const d: string; at: integer);
var k: integer;
    dp: longint;
    v, n, w: longint;
    s: string[100];
begin
  dp := PackName(Copy(d, 2, 6));
  if (dp = 22019) or (dp = 2793587) or (dp = 5525343689) then exit;
  if dp = 385 then begin mWide := true; exit; end;
  if dp = 609 then begin mWide := false; exit; end;
  if dp = 408 then begin xWide := true; exit; end;
  if dp = 632 then begin xWide := false; exit; end;
  SplitArgs(at);
  if dp = 185122 then begin for k := 1 to nArg do Emit(Ev(k)); exit; end;
  if (dp = 208936) and rvMode then begin for k := 1 to nArg do Emit16(Ev(k)); exit; end;
  if dp = 150007 then begin
    for k := 1 to nArg do if rvMode then Emit32(Ev(k)) else Emit16(Ev(k));
    exit;
  end;
  if (dp = 244204) and not rvMode then begin
    for k := 1 to nArg do begin v := Ev(k); Emit(v); Emit(v shr 8); Emit(v shr 16); end;
    exit;
  end;
  if (dp = 4800228) and not rvMode then begin for k := 1 to nArg do Emit32(Ev(k)); exit; end;
  if dp = 680116 then begin
    for k := 1 to nArg do begin
      s := ArgStr(k);
      if (length(s) >= 2) and (s[1] = '"') and (s[length(s)] = '"') then begin
        for n := 2 to length(s) - 1 do Emit(ord(s[n]));
      end else Emit(Ev(k));
    end;
    exit;
  end;
  if dp = 405798 then begin
    n := Ev(1);
    if nArg >= 2 then w := Ev(2) else w := 0;
    if (n < 0) or (n > MaxOut) then FailN(31, '');
    for v := 1 to n do Emit(w);
    exit;
  end;
  if dp = 14919041 then begin
    n := Ev(1);
    if n <= 0 then FailN(32, '');
    while pc mod n <> 0 do Emit(0);
    exit;
  end;
  FailN(33, d);
end;

{ * = address: the first one sets the origin, later ones may only go up
  (the gap is filled with zeros) }
procedure Org(v: longint);
begin
  if not haveOrigin then begin origin := v; haveOrigin := true; pc := v; end
  else begin
    if v < pc then FailN(12, '');
    while pc < v do Emit(0);
  end;
end;

{ ------------------------------------------------------------ one line }
procedure StripComment;
var i: integer;
    q: char;
begin
  q := #0;
  i := 1;
  while i <= length(AsmWorkPtr^.lne) do begin
    if q <> #0 then begin if AsmWorkPtr^.lne[i] = q then q := #0; end
    else if AsmWorkPtr^.lne[i] = '"' then q := '"'
    else if (AsmWorkPtr^.lne[i] = '''') and (i + 2 <= length(AsmWorkPtr^.lne)) and (AsmWorkPtr^.lne[i + 2] = '''') then i := i + 2
    else if (AsmWorkPtr^.lne[i] = ';') or (rvMode and (AsmWorkPtr^.lne[i] = '#')) then begin AsmWorkPtr^.lne[0] := chr(i - 1); exit; end;
    i := i + 1;
  end;
end;

procedure DoLine;
var label_: string[40];
    word_: string[16];
    i, k, at: integer;
    hadColon: boolean;
begin
  StripComment;
  ip := 1;
  SkipSp;
  if ip > length(AsmWorkPtr^.lne) then exit;
  { name = expr }
  if IsIdStart(AsmWorkPtr^.lne[ip]) then begin
    k := ip;
    while (k <= length(AsmWorkPtr^.lne)) and IsIdChar(AsmWorkPtr^.lne[k]) do k := k + 1;
    i := k;
    while (i <= length(AsmWorkPtr^.lne)) and ((AsmWorkPtr^.lne[i] = ' ') or (AsmWorkPtr^.lne[i] = #9)) do i := i + 1;
    if (i <= length(AsmWorkPtr^.lne)) and (AsmWorkPtr^.lne[i] = '=') then begin
      label_ := Copy(AsmWorkPtr^.lne, ip, k - ip);
      exprUndef := false; exprFwd := false;
      ip := i + 1;
      linePC := pc;
      Define(label_, EvalRest, exprUndef);
      exit;
    end;
  end;
  { label: column 1 (65C816), or a word followed by a colon }
  label_ := '';
  hadColon := false;
  if IsIdStart(AsmWorkPtr^.lne[ip]) then begin
    k := ip;
    while (k <= length(AsmWorkPtr^.lne)) and IsIdChar(AsmWorkPtr^.lne[k]) do k := k + 1;
    if (k <= length(AsmWorkPtr^.lne)) and (AsmWorkPtr^.lne[k] = ':') then begin
      label_ := Copy(AsmWorkPtr^.lne, ip, k - ip); ip := k + 1; hadColon := true;
    end else if (ip = 1) and not rvMode and (inlineAt = 0) then begin
      label_ := Copy(AsmWorkPtr^.lne, ip, k - ip); ip := k;
    end;
  end
  else if (ip = 1) and not rvMode and ((AsmWorkPtr^.lne[1] = '+') or (AsmWorkPtr^.lne[1] = '-')) and
          ((length(AsmWorkPtr^.lne) = 1) or (AsmWorkPtr^.lne[2] = ' ') or (AsmWorkPtr^.lne[2] = #9)) then begin
    { anonymous label }
    if AsmWorkPtr^.lne[1] = '-' then begin
      MemL[MinusBase + longint(minusN and 63) * 4] := pc;
      minusN := minusN + 1;
    end else begin
      if pass = 1 then begin
        if plusTotal >= 16000 then FailN(34, '');
        MemL[AnonBase + longint(plusTotal) * 4] := pc;
        plusTotal := plusTotal + 1;
      end;
      plusN := plusN + 1;
    end;
    ip := 2;
  end;
  if label_ <> '' then Define(label_, pc, false);
  SkipSp;
  if ip > length(AsmWorkPtr^.lne) then exit;
  { * = origin }
  if AsmWorkPtr^.lne[ip] = '*' then begin
    i := ip + 1;
    while (i <= length(AsmWorkPtr^.lne)) and ((AsmWorkPtr^.lne[i] = ' ') or (AsmWorkPtr^.lne[i] = #9)) do i := i + 1;
    if (i > length(AsmWorkPtr^.lne)) or (AsmWorkPtr^.lne[i] <> '=') then FailN(35, '');
    if rvMode then FailN(36, '');
    ip := i + 1;
    exprUndef := false; exprFwd := false;
    linePC := pc;
    Org(EvalRest);
    exit;
  end;
  { mnemonic or directive }
  linePC := pc;
  at := ip;
  word_ := '';
  while (ip <= length(AsmWorkPtr^.lne)) and (AsmWorkPtr^.lne[ip] <> ' ') and (AsmWorkPtr^.lne[ip] <> #9) do begin
    word_ := word_ + LowerC(AsmWorkPtr^.lne[ip]);
    ip := ip + 1;
  end;
  SkipSp;
  at := ip;
  if word_[1] = '.' then Directive(word_, at)
  else if rvMode then InsRV(word_, at)
  else Ins816(word_, at);
end;

{ ------------------------------------------------------------ the text }
function FirstChar(n: longint): char;
var p: longint;
begin
  p := 0;
  while (p < n) and (Mem[SrcBase + p] <= 32) do p := p + 1;
  if p < n then FirstChar := chr(Mem[SrcBase + p]) else FirstChar := #0;
end;

function IsAsmText(n: longint; const fileName: string): boolean;
var i, k: integer;
begin
  { compared a character at a time: this runs for every status line, deep
    in the editor's stack }
  IsAsmText := true;
  i := 1;
  while (i <= length(fileName)) and (fileName[i] <> '.') do i := i + 1;
  k := length(fileName) - i;
  if (k = 1) and (fileName[i + 1] = 'S') then exit;
  if (k = 3) and (fileName[i + 1] = 'A') and (fileName[i + 2] = 'S') and (fileName[i + 3] = 'M') then exit;
  IsAsmText := FirstChar(n) = ';';
end;

{ .schub as the first line (blank lines and comments before it are fine) }
function IsAsmSchub(n: longint): boolean;
var p, i: longint;
    c: byte;
    W: string[6];
begin
  W := '.schub';
  IsAsmSchub := false;
  p := 0;
  while p < n do begin
    while (p < n) and ((Mem[SrcBase + p] = 32) or (Mem[SrcBase + p] = 9) or (Mem[SrcBase + p] = 10)) do p := p + 1;
    if p >= n then exit;
    c := Mem[SrcBase + p];
    if (c = 59) or (c = 35) then begin
      { a comment line: the next one }
      while (p < n) and (Mem[SrcBase + p] <> 10) do p := p + 1;
    end else begin
      if p + 6 > n then exit;
      for i := 0 to 5 do
        if chr(Mem[SrcBase + p + i] or 32) <> W[i + 1] then exit;
      IsAsmSchub := true;
      exit;
    end;
  end;
end;

function AssembleSource(srcLen: longint; schub: boolean): boolean;
var p, e: longint;
    n{$IFDEF SCHUB}, k{$ENDIF}: integer;
begin
  AssembleSource := false;
  ErrMsg := ''; ErrUnit := ''; ErrLine := 0; ErrCol := 0;
  curLine := 0; ip := 1;
  inlineAt := 0;
  if CatchError <> 0 then exit;
  if not tablesReady then BuildTables;
  rvMode := schub;
  AsmIsSchub := schub;
  nSyms := 0;
  FillMem(SymBase, 512, 0);
  plusTotal := 0;
  for pass := 1 to 2 do begin
    if rvMode then pc := RvOrg else pc := $2000;
    haveOrigin := rvMode;
    origin := pc;
    outLen := 0;
    mWide := true; xWide := true;
    minusN := 0; plusN := 0;
    curLine := 0;
    p := 0;
    while p < srcLen do begin
      e := p;
      while (e < srcLen) and (Mem[SrcBase + e] <> 10) do e := e + 1;
      curLine := curLine + 1;
      if e - p > 250 then begin ip := 1; FailN(37, ''); end;
      n := e - p;
      AsmWorkPtr^.lne[0] := chr(n);
{$IFDEF SCHUB}
      { the blitter would write behind SCHUB's data cache }
      for k := 1 to n do AsmWorkPtr^.lne[k] := chr(Mem[SrcBase + p + k - 1]);
{$ELSE}
      if n > 0 then CopyMem(SrcBase + p, longint(@AsmWorkPtr^.lne[1]), n);
{$ENDIF}
      DoLine;
      p := e + 1;
    end;
  end;
  AsmSize := outLen;
  AsmOrigin := origin;
  AsmLines := curLine;
  if outLen = 0 then begin ip := 1; curLine := 1; FailN(38, ''); end;
  { the entry: a label START, else the first byte }
  pass := 3;
  p := FindSym('START');
  if p <> 0 then AsmEntry := MemL[SymAdr(p) + 16] else AsmEntry := AsmOrigin;
  AssembleSource := true;
end;

{ an asm block of a Pascal text (NComp): the lines from a up to e
  for the address org, into Stage; labels are `name:` anywhere on a line,
  the names the block does not define come from the Pascal program
  (AsmNames, written by NComp); braces make a comment too }
function InlineAsmBlock(a, e: longint; line0: integer; org: longint; schub: boolean): longint;
var p, q: longint;
    n, k: integer;
    c: char;
    inBr, semi: boolean;
begin
  if not tablesReady then BuildTables;
  rvMode := schub;
  nSyms := 0;
  FillMem(SymBase, 512, 0);
  plusTotal := 0;
  inlineAt := line0;
  for pass := 1 to 2 do begin
    pc := org; origin := org; haveOrigin := true;
    outLen := 0;
    mWide := true; xWide := true;
    minusN := 0; plusN := 0;
    curLine := 0;
    inBr := false;
    p := a;
    while p < e do begin
      q := p;
      while (q < e) and (Mem[q] <> 10) do q := q + 1;
      curLine := curLine + 1;
      if q - p > 250 then begin ip := 1; FailN(37, ''); end;
      n := q - p;
      semi := false;
      AsmWorkPtr^.lne[0] := chr(n);
      for k := 1 to n do begin
        c := chr(Mem[p + k - 1]);
        if (c = #13) or (c = #9) then c := ' ';
        if inBr then begin if c = '}' then inBr := false; c := ' '; end
        else if not semi then begin
          if c = ';' then semi := true
          else if c = '{' then begin inBr := true; c := ' '; end;
        end;
        AsmWorkPtr^.lne[k] := c;
      end;
      DoLine;
      p := q + 1;
    end;
  end;
  inlineAt := 0;
  InlineAsmBlock := outLen;
end;

{ where the cartridge keeps the SCHUB host stub (byte by byte: the address
  is odd, and SCHUB reads words only at even addresses) }
function StubAdr: longint;
begin
  StubAdr := Mem[$40005B] or (Mem[$40005C] shl 8) or (longint(Mem[$40005D]) shl 16);
end;

function AsmPrepareRun: boolean;
var stubLen, t: longint;
begin
  AsmPrepareRun := false;
  if AsmSize = 0 then begin ErrMsg := 'assemble the program first'; exit; end;
  if AsmIsSchub then begin
    { the cartridge's host stub at $04:0000, the code behind it }
    stubLen := Mem[$40005E] or (Mem[$40005F] shl 8);
    CopyMem(StubAdr, RvStubAt, stubLen);
    CopyMem(Stage, RvOrg, AsmSize);
    RunAt := RvStubAt;
    AsmPrepareRun := true;
    exit;
  end;
  { 65C816: bank 0 is saved while it runs ($2000-$B7FF); banks $04-$1F are free }
  if not (((AsmOrigin >= $2000) and (AsmOrigin + AsmSize <= $B800)) or
          ((AsmOrigin >= $040000) and (AsmOrigin + AsmSize <= $200000))) then begin
    ErrMsg := 'F5 runs programs at $2000-$B7FF or $04:0000-$1F:FFFF';
    exit;
  end;
  if (AsmSize > $10000) or ((AsmOrigin and $FFFF) + AsmSize > $10000) then begin
    ErrMsg := 'F5 runs programs that stay in one bank';
    exit;
  end;
  { a little 65C816 code that copies the program in place once bank 0 is
    saved, then jumps to it (it ends with RTL back to the editor) }
  t := Tramp;
  Mem[t] := $C2; Mem[t + 1] := $30;                                   { rep #$30 }
  Mem[t + 2] := $8B;                                                  { phb }
  Mem[t + 3] := $A9; MemW[t + 4] := AsmSize - 1;                      { lda #len-1 }
  Mem[t + 6] := $A2; Mem[t + 7] := Stage and 255; Mem[t + 8] := (Stage shr 8) and 255;   { ldx #src }
  Mem[t + 9] := $A0; MemW[t + 10] := AsmOrigin and $FFFF;             { ldy #dst }
  Mem[t + 12] := $54; Mem[t + 13] := (AsmOrigin shr 16) and 255;      { mvn dst,src }
  Mem[t + 14] := (Stage shr 16) and 255;
  Mem[t + 15] := $AB;                                                 { plb }
  Mem[t + 16] := $5C;                                                 { jml entry }
  Mem[t + 17] := AsmEntry and 255; Mem[t + 18] := (AsmEntry shr 8) and 255;
  Mem[t + 19] := (AsmEntry shr 16) and 255;
  RunAt := Tramp;
  AsmPrepareRun := true;
end;

function SaveAsmMer(const name: string): boolean;
var len, load, start, stubLen: longint;
begin
  SaveAsmMer := false;
  ErrMsg := '';
  if AsmSize = 0 then begin ErrMsg := 'assemble the program first'; exit; end;
  if AsmIsSchub then begin
    { host stub, the mailbox page, then the code at $04:0400 }
    stubLen := Mem[$40005E] or (Mem[$40005F] shl 8);
    FillMem(MerBuf + 16, RvOrg - RvStubAt, 0);
    CopyMem(StubAdr, MerBuf + 16, stubLen);
    CopyMem(Stage, MerBuf + 16 + (RvOrg - RvStubAt), AsmSize);
    len := (RvOrg - RvStubAt) + AsmSize;
    load := RvStubAt; start := RvStubAt;
  end else begin
    CopyMem(Stage, MerBuf + 16, AsmSize);
    len := AsmSize;
    load := AsmOrigin; start := AsmEntry;
  end;
  { MER header: "MER" 1, load (3), flags, start (3), 0, length (4) }
  Mem[MerBuf] := ord('M'); Mem[MerBuf + 1] := ord('E'); Mem[MerBuf + 2] := ord('R'); Mem[MerBuf + 3] := 1;
  Mem[MerBuf + 4] := load and 255; Mem[MerBuf + 5] := (load shr 8) and 255; Mem[MerBuf + 6] := (load shr 16) and 255;
  Mem[MerBuf + 7] := 1;
  Mem[MerBuf + 8] := start and 255; Mem[MerBuf + 9] := (start shr 8) and 255; Mem[MerBuf + 10] := (start shr 16) and 255;
  Mem[MerBuf + 11] := 0;
  MemL[MerBuf + 12] := len;
  if not SaveFile(name, MerBuf, len + 16) then begin
    ErrMsg := 'save failed: ' + DosErrorText(DosError);
    exit;
  end;
  SaveAsmMer := true;
end;

begin
  tablesReady := false;
  AsmSize := 0;
end.
