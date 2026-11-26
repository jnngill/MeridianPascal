{ MERIDIAN C on the MERIDIAN - part 1: tokens, the source frames, the
  preprocessor and the scanner (included by ccomp.inc).

  The text comes from frames: the program (bank $20), a header (in the
  cartridge ROM, or a file loaded after the program), a macro's
  replacement text (in the pool, bank $37). A frame that ends gives back
  the frame below it; between the two the scanner sees a blank, so tokens
  never run together. Macros are kept as text: the body with markers for
  the parameters (1 n), # parameter (2 n) and ## (3); an invocation builds
  the replacement text with the arguments (macro-expanded first, as the
  standard says, except next to # and ##) and reads it as a new frame,
  with the macro switched off until that frame ends. }

const
  { tokens (sIdent, sNumber, sString, sEOF, sReal as for Pascal) }
  tPlus = 101; tMinus = 102; tStar = 103; tSlash = 104; tPercent = 105; tInc = 106; tDec = 107;
  tEq = 108; tNe = 109; tLt = 110; tLe = 111; tGt = 112; tGe = 113; tAndAnd = 114; tOrOr = 115;
  tNot = 116; tTilde = 117; tAmp = 118; tBar = 119; tCaret = 120; tShl = 121; tShr = 122;
  tAssign = 123; tAddAs = 124; tSubAs = 125; tMulAs = 126; tDivAs = 127; tModAs = 128;
  tAndAs = 129; tOrAs = 130; tXorAs = 131; tShlAs = 132; tShrAs = 133; tQuest = 134;
  tColon = 135; tSemi = 136; tComma = 137; tDot = 138; tArrow = 139; tLpar = 140; tRpar = 141;
  tLbrk = 142; tRbrk = 143; tLbrace = 144; tRbrace = 145; tEllipsis = 146; tEOL = 147;
  { keywords (the table in the ROM gives these codes: compiler/cart.js C_KEYWORDS) }
  kAuto = 160; kBreak = 161; kCase = 162; kChar = 163; kConst = 164; kContinue = 165;
  kDefault = 166; kDo = 167; kDouble = 168; kElse = 169; kEnum = 170; kExtern = 171;
  kFloat = 172; kFor = 173; kGoto = 174; kIf = 175; kInt = 176; kLong = 177; kRegister = 178;
  kReturn = 179; kShort = 180; kSigned = 181; kSizeof = 182; kStatic = 183; kStruct = 184;
  kSwitch = 185; kTypedef = 186; kUnion = 187; kUnsigned = 188; kVoid = 189; kVolatile = 190;
  kWhile = 191; kBool = 192; kFar = 193; kInline = 194; kRestrict = 195; kVaArg = 196;
  kNoreturn = 197; kAttribute = 198; kAsm = 199;

  { error messages (cart/cmsgs.txt, in the ROM) }
  ceSyntax = 1; ceExpected = 2; ceUndeclared = 3; ceMacros = 4; ceMacroArgs = 5; ceMacroNest = 6;
  ceInclude = 7; ceIncNest = 8; ceCondNest = 9; ceElse = 10; ceEndif = 11; ceNoEndif = 12;
  ceError = 13; ceDirective = 14; ceString = 15; ceChar = 16; ceBadChar = 17; ceNumber = 18;
  ceConst = 19; ceType = 20; ceTypeMix = 21; ceDecl = 22; ceRedecl = 23; ceIncomplete = 24;
  ceNoMember = 25; ceNotStruct = 26; ceBitfield = 27; ceNotLvalue = 28; ceNotScalar = 29;
  ceNotPointer = 30; ceNotFunc = 31; ceArgs = 32; ceVoid = 33; ceConv = 34; ceDivZero = 35;
  ceBreak = 36; ceContinue = 37; ceCase = 38; ceDupCase = 39; ceCases = 40; ceLabel = 41;
  ceDupLabel = 42; ceNested = 43; ceFuncAddr = 44; ceUndefFunc = 45; ceNoMain = 46; ceInit = 47;
  ceInitConst = 48; ceTooMany = 49; ceParams = 50; ceFrame = 51; ceStrLong = 52; ceUnit = 53;
  ceNotHere = 54; ceArrSize = 55; ceStorage = 56; ceLabels = 57; ceMacroDef = 58; ceTokens = 59;
  ceNoHeader = 60;
  ceLast = 60;        { then the tokens' spellings (101..147) }

  { symbol kinds of C (skConst, skVar, skType, skField as for Pascal) }
  skTag = 8;          { struct / union / enum tag: typ }
  skCFunc = 9;        { a C function: typ = result, first/npar = its parameters (CPar), flags below }
  { skCFunc flags }
  cfVariadic = 1; cfDefined = 2; cfLib = 4; cfStatic = 8; cfNoProto = 16; cfUsed = 32;
  { type forms of C }
  fCFn = 14;          { a function type: base = result, fields = CPar index, lo = number of parameters, hi = flags }
  { item modes of C }
  mFn = 11;           { a function designator: a = the symbol }
  mPfn = 12;          { a Pascal routine: a = the symbol }

  { expansion RAM of the C compiler (banks $35-$37) }
  MacHash = $350000;  { 256 words: the first macro of each hash }
  MacTab = $350200;   { 32 bytes a macro: name (length, 23), next, parameters (255: none), flags, body }
  MaxMacro = 1000;
  CParBase = $358000; { 20 bytes a parameter: type, name (16), unused }
  MaxCPar = 1200;
  MacBody = $360000;  { the macros' bodies (length word, then the text) }
  CFrames = $370000;  { 32 bytes a frame }
  MaxCFrame = 48;
  CFileNames = $370800; { the file of each open include (16 bytes) }
  CCases = $371000;   { switch: 12 bytes a case (low, high value, address) }
  MaxCase = 340;
  CLabels = $372000;  { goto: 24 bytes a label (name 16, address, chain) }
  MaxCLabel = 128;
  CPoolBase = $373000; { macro arguments and replacement texts, up to CPoolEnd }
  CPoolEnd = $37A000;
  CTmpBase = $37A000;  { texts being expanded, up to CTmpEnd }
  CTmpEnd = $37FF00;

  { frame kinds }
  fkFile = 1; fkMacro = 2; fkBarrier = 3;

var
  cDepth: integer;            { frames below the current text }
  cBarrier: integer;          { a barrier frame's level: its end is the end (0: none) }
  cFileDepth: integer;        { open include files }
  cKind: byte;                { the current frame's kind }
  cMac: integer;              { the current frame's macro (0: none) }
  cPend: integer;             { a character given back after a frame ended (-1: none) }
  cBol: boolean;              { at the start of a line (a directive may come) }
  cPP: boolean;               { in a directive's line: the end of the line is a token }
  cNoMacros: boolean;         { identifiers are not expanded (#ifdef, defined) }
  cPoolTop, cTmpTop: longint;
  cMacros: integer;
  cBodyTop: longint;
  cName: string[31];          { the whole identifier (id has its first 15 characters) }
  cNumTyp: integer;           { the type of the number constant just read }
  cCond: array[1..16] of byte; { #if: 0 the text is used, 1 not yet, 2 no more }
  cCondN: integer;
  cUnits: longint;            { the Pascal units the text named (#pragma unit), bit per unit; System always }
  cKwBase, cMsgBase, cUnitBase, cHdrBase: longint;
  cMainName: string[16];      { the program's file (__FILE__) }
  cMacSnap: boolean;          { the macros as they were before a function's first pass }
  cSnapMacros: integer;
  cSnapBody: longint;
  cFirstPass: boolean;        { a function's first pass (its directives run again) }

{ ---------------------------------------------------------------- messages }
{ message n (cart/cmsgs.txt) from the ROM, then extra; the position of the
  token being read }
procedure CErr(n: integer; const extra: string);
var a: longint;
    k, i: integer;
begin
  a := cMsgBase + 2;
  for i := 2 to n do a := a + Mem[a] + 1;
  if (n < 1) or (n > Mem[cMsgBase] + Mem[cMsgBase + 1] * 256) then begin ErrMsg := 'C error '; a := 0; end
  else begin
    k := Mem[a];
    ErrMsg[0] := chr(k);
    for i := 1 to k do ErrMsg[i] := chr(Mem[a + i]);
  end;
  if extra <> '' then ErrMsg := ErrMsg + ' ' + extra;
  ErrUnit := curFile;
  ErrLine := tokLine;
  ErrCol := tokCol;
  ThrowError;
end;

procedure CErr0(n: integer);
begin
  CErr(n, '');
end;

{ words at any address (SCHUB reads and writes them only at even ones) }
function CGetW(a: longint): longint;
begin
  CGetW := longint(Mem[a]) or (longint(Mem[a + 1]) shl 8);
end;

procedure CPutW(a, v: longint);
begin
  Mem[a] := v and 255;
  Mem[a + 1] := (v shr 8) and 255;
end;

{ the spelling of token s (for "... expected") }
function CTokText(s: integer): TName;
var a: longint;
    i, k: integer;
    t: TName;
begin
  t := '';
  if (s >= 101) and (s <= 147) then begin
    a := cMsgBase + 2;
    for i := 1 to ceLast + s - 101 do a := a + Mem[a] + 1;
    k := Mem[a];
    if k > 15 then k := 15;
    for i := 1 to k do t[i] := chr(Mem[a + i]);
    t[0] := chr(k);
  end else if s = sIdent then t := 'identifier';
  CTokText := t;
end;

procedure CExpect(s: integer); forward;

{ ---------------------------------------------------------------- frames }
{ push the text at base (n bytes) as a frame of kind k }
procedure CPushFrame(base, n: longint; k: byte; mac: integer; pool: longint);
var a: longint;
begin
  if cDepth >= MaxCFrame then CErr0(ceMacroNest);
  a := CFrames + longint(cDepth) * 32;
  MemL[a] := curBase; MemL[a + 4] := srcPos; MemL[a + 8] := srcEnd;
  MemW[a + 12] := line; MemW[a + 14] := col;
  Mem[a + 16] := ord(ch); Mem[a + 17] := cKind;
  MemW[a + 18] := cMac; MemL[a + 20] := pool;
  MemW[a + 24] := cPend + 1;
  Mem[a + 26] := ord(cBol);
  cDepth := cDepth + 1;
  curBase := base; srcPos := 0; srcEnd := n;
  cKind := k; cMac := mac; cPend := -1;
  if mac <> 0 then Mem[MacTab + longint(mac - 1) * 32 + 27] := Mem[MacTab + longint(mac - 1) * 32 + 27] or 2;
end;

procedure CPopFrame;
var a: longint;
    k: integer;
begin
  if cMac <> 0 then Mem[MacTab + longint(cMac - 1) * 32 + 27] := Mem[MacTab + longint(cMac - 1) * 32 + 27] and $FD;
  if cKind = fkFile then begin
    cFileDepth := cFileDepth - 1;
    a := CFileNames + longint(cFileDepth) * 16;
    curFile := '';
    if cFileDepth > 0 then begin
      a := a - 16;
      curFile[0] := chr(Mem[a]);
      for k := 1 to Mem[a] do curFile[k] := chr(Mem[a + k]);
    end;
  end;
  cDepth := cDepth - 1;
  a := CFrames + longint(cDepth) * 32;
  curBase := MemL[a]; srcPos := MemL[a + 4]; srcEnd := MemL[a + 8];
  line := MemW[a + 12]; col := MemW[a + 14];
  ch := chr(Mem[a + 16]); cKind := Mem[a + 17];
  cMac := MemW[a + 18]; cPoolTop := MemL[a + 20];
  cPend := MemW[a + 24] - 1;
  cBol := Mem[a + 26] <> 0;
end;

{ the next character; a frame's end gives a blank, then the text below }
procedure CNextCh;
var c: integer;
begin
  repeat
    if cPend >= 0 then begin ch := chr(cPend); cPend := -1; exit; end;
    if srcPos < srcEnd then begin
      c := Mem[curBase + srcPos];
      srcPos := srcPos + 1;
      if c = 10 then begin line := line + 1; col := 0; ch := #10; exit; end;
      col := col + 1;
      if c = 13 then continue;
      if c = 92 then begin
        { a backslash at the end of the line joins the next one }
        if (srcPos < srcEnd) and (Mem[curBase + srcPos] = 10) then begin
          srcPos := srcPos + 1; line := line + 1; col := 0; continue;
        end;
        if (srcPos + 1 < srcEnd) and (Mem[curBase + srcPos] = 13) and (Mem[curBase + srcPos + 1] = 10) then begin
          srcPos := srcPos + 2; line := line + 1; col := 0; continue;
        end;
      end;
      if c = 9 then c := 32;
      ch := chr(c);
      exit;
    end;
    if (cDepth = 0) or (cDepth = cBarrier) then begin ch := #0; exit; end;
    { the end of a frame: the text below goes on where it was (a macro's
      text ends with a blank, so tokens do not run together) }
    CPopFrame;
    exit;
  until false;
end;

{ the character after ch, in the current frame (#0 at its end) }
function CPeek: char;
begin
  if (cPend < 0) and (srcPos < srcEnd) then CPeek := chr(Mem[curBase + srcPos]) else CPeek := #0;
end;

function IsIdCh(c: char): boolean;
begin
  IsIdCh := ((c >= 'a') and (c <= 'z')) or ((c >= 'A') and (c <= 'Z')) or ((c >= '0') and (c <= '9')) or (c = '_');
end;

{ ---------------------------------------------------------------- pool texts }
procedure CTmpPut(c: integer);
begin
  if cTmpTop >= CTmpEnd then CErr0(ceMacroNest);
  Mem[cTmpTop] := c;
  cTmpTop := cTmpTop + 1;
end;

{ copy the text from..cTmpTop into the pool; cTmpTop back to from }
function CTmpToPool(from: longint): longint;
var n: longint;
begin
  n := cTmpTop - from;
  if cPoolTop + n > CPoolEnd then CErr0(ceMacroNest);
  CTmpToPool := cPoolTop;
  if n > 0 then CopyMem(from, cPoolTop, n);
  cPoolTop := cPoolTop + n;
  cTmpTop := from;
end;

{ ---------------------------------------------------------------- macros }
function MacHashOf(const n: string): integer;
var i, h: integer;
begin
  h := 0;
  for i := 1 to length(n) do h := (h * 3 + ord(n[i])) and 255;
  MacHashOf := h;
end;

function MacFind(const n: string): integer;
var m, i, k: integer;
    a: longint;
    ok: boolean;
begin
  MacFind := 0;
  k := length(n);
  if k > 23 then k := 23;
  m := MemW[MacHash + MacHashOf(n) * 2];
  while m <> 0 do begin
    a := MacTab + longint(m - 1) * 32;
    if (Mem[a] = k) and (Mem[a + 27] and 4 <> 0) then begin
      ok := true;
      for i := 1 to k do if Mem[a + i] <> ord(n[i]) then begin ok := false; break; end;
      if ok then begin MacFind := m; exit; end;
    end;
    m := MemW[a + 24];
  end;
end;

{ a new macro (or the old one again): its body is at cBodyTop }
function MacNew(const n: string): integer;
var m, i, k, h: integer;
    a: longint;
begin
  m := MacFind(n);
  if m = 0 then begin
    if cMacros >= MaxMacro then CErr0(ceMacros);
    cMacros := cMacros + 1;
    m := cMacros;
    a := MacTab + longint(m - 1) * 32;
    k := length(n);
    if k > 23 then k := 23;
    Mem[a] := k;
    for i := 1 to k do Mem[a + i] := ord(n[i]);
    h := MacHashOf(n);
    MemW[a + 24] := MemW[MacHash + h * 2];
    MemW[MacHash + h * 2] := m;
  end;
  a := MacTab + longint(m - 1) * 32;
  Mem[a + 26] := 255; Mem[a + 27] := 4;
  MemL[a + 28] := cBodyTop;
  MacNew := m;
end;

{ the first pass over a function changes the macros: they are kept as they
  were, the second pass starts from them again }
const MacSnap = $330000;

procedure CMacSave;
begin
  if not cFirstPass or cMacSnap then exit;
  CopyMem(MacHash, MacSnap, 512 + longint(cMacros) * 32);
  cSnapMacros := cMacros; cSnapBody := cBodyTop;
  cMacSnap := true;
end;

procedure CMacRestore;
begin
  if not cMacSnap then exit;
  CopyMem(MacSnap, MacHash, 512 + longint(cSnapMacros) * 32);
  cMacros := cSnapMacros; cBodyTop := cSnapBody;
  cMacSnap := false;
end;

procedure BodyPut(c: integer);
begin
  if cBodyTop >= MacBody + $FFF0 then CErr0(ceMacros);
  Mem[cBodyTop] := c;
  cBodyTop := cBodyTop + 1;
end;

{ #define name text (a built-in macro) }
procedure MacDefine(const n, body: string);
var m, i: integer;
    a: longint;
begin
  m := MacNew(n);
  a := cBodyTop;
  BodyPut(0); BodyPut(0);
  for i := 1 to length(body) do BodyPut(ord(body[i]));
  CPutW(a, cBodyTop - a - 2);
end;

procedure CSkipBlanks;
begin
  while ch = ' ' do CNextCh;
end;

{ an identifier at ch into cName (ch then after it) }
procedure CReadName;
var n: integer;
begin
  n := 0;
  while IsIdCh(ch) do begin
    if n < 31 then begin n := n + 1; cName[n] := ch; end;
    CNextCh;
  end;
  cName[0] := chr(n);
end;

{ the rest of the line is skipped }
procedure CSkipLine;
begin
  while (ch <> #10) and (ch <> #0) do CNextCh;
end;

{ #define: the body with the parameters as markers }
procedure CDefine;
var pn: array[1..16] of string[23];
    np, i, m, k, last: integer;
    a, start: longint;
    variadic, fn: boolean;
    q: char;
begin
  CMacSave;
  CSkipBlanks;
  if not IsIdCh(ch) then CErr0(ceMacroDef);
  CReadName;
  np := 0; variadic := false; fn := false;
  if ch = '(' then begin
    { parameters (only right after the name) }
    fn := true;
    CNextCh; CSkipBlanks;
    if ch <> ')' then
      repeat
        CSkipBlanks;
        if ch = '.' then begin
          CNextCh; CNextCh; CNextCh;
          variadic := true;
          if np >= 16 then CErr0(ceMacroDef);
          np := np + 1; pn[np] := '__VA_ARGS__';
        end else begin
          if not IsIdCh(ch) then CErr0(ceMacroDef);
          if np >= 16 then CErr0(ceMacroDef);
          np := np + 1;
          m := 0;
          while IsIdCh(ch) do begin if m < 23 then begin m := m + 1; pn[np][m] := ch; end; CNextCh; end;
          pn[np][0] := chr(m);
          CSkipBlanks;
          if ch = '.' then begin CNextCh; CNextCh; CNextCh; variadic := true; CSkipBlanks; end;
        end;
        CSkipBlanks;
        if ch = ',' then CNextCh else break;
      until false;
    if ch <> ')' then CErr0(ceMacroDef);
    CNextCh;
  end;
  m := MacNew(cName);
  a := MacTab + longint(m - 1) * 32;
  if fn then Mem[a + 26] := np;
  if variadic then Mem[a + 27] := Mem[a + 27] or 1;
  start := cBodyTop;
  BodyPut(0); BodyPut(0);
  CSkipBlanks;
  last := 0;       { 1 after a blank was put }
  while (ch <> #10) and (ch <> #0) do begin
    if ch = ' ' then begin
      CSkipBlanks;
      if (ch <> #10) and (ch <> #0) then begin BodyPut(32); last := 1; end;
      continue;
    end;
    if (ch = '/') and (CPeek = '*') then begin
      CNextCh; CNextCh;
      while (ch <> #0) and not ((ch = '*') and (CPeek = '/')) do CNextCh;
      CNextCh; CNextCh;
      ch := ' ';
      continue;
    end;
    if (ch = '/') and (CPeek = '/') then begin CSkipLine; break; end;
    last := 0;
    if (ch = '"') or (ch = '''') then begin
      q := ch;
      BodyPut(ord(ch)); CNextCh;
      while (ch <> q) and (ch <> #10) and (ch <> #0) do begin
        if ch = '\' then begin BodyPut(92); CNextCh; end;
        BodyPut(ord(ch)); CNextCh;
      end;
      if ch = q then begin BodyPut(ord(q)); CNextCh; end;
    end else if ch = '#' then begin
      CNextCh;
      if ch = '#' then begin
        { ## : no blank before it }
        CNextCh;
        if (cBodyTop > start + 2) and (Mem[cBodyTop - 1] = 32) then cBodyTop := cBodyTop - 1;
        BodyPut(3);
        CSkipBlanks;
      end else begin
        CSkipBlanks;
        k := 0;
        if IsIdCh(ch) then begin
          CReadName;
          for i := 1 to np do if pn[i] = cName then k := i;
          if (k = 0) or not fn then CErr0(ceMacroDef);
          BodyPut(2); BodyPut(k);
        end else BodyPut(ord('#'));
      end;
    end else if IsIdCh(ch) then begin
      if (ch >= '0') and (ch <= '9') then begin
        { a number: as it is (1e5, 0x1F, 10L) }
        while IsIdCh(ch) or (ch = '.') do begin BodyPut(ord(ch)); CNextCh; end;
      end else begin
        CReadName;
        k := 0;
        if fn then for i := 1 to np do if pn[i] = cName then k := i;
        if k <> 0 then begin BodyPut(1); BodyPut(k); end
        else for i := 1 to length(cName) do BodyPut(ord(cName[i]));
      end;
    end else begin
      BodyPut(ord(ch)); CNextCh;
    end;
  end;
  { no blank at the end }
  if (cBodyTop > start + 2) and (last = 1) then cBodyTop := cBodyTop - 1;
  CPutW(start, cBodyTop - start - 2);
  MemL[a + 28] := start;
end;

procedure CExpandMacro(m: integer); forward;

{ the macro text from..to as a C text: expanded, in the temporary area at
  cTmpTop (it ends at cTmpTop) }
procedure CExpandText(from, n: longint);
var oldBar, m, i: integer;
    q: char;
    blank: boolean;
begin
  oldBar := cBarrier;
  CPushFrame(from, n, fkBarrier, 0, cPoolTop);
  cBarrier := cDepth;
  CNextCh;
  while ch <> #0 do begin
    if IsIdCh(ch) and not ((ch >= '0') and (ch <= '9')) then begin
      CReadName;
      m := MacFind(cName);
      blank := false;
      if (m <> 0) and (Mem[MacTab + longint(m - 1) * 32 + 27] and 2 = 0) then begin
        if Mem[MacTab + longint(m - 1) * 32 + 26] = 255 then begin CExpandMacro(m); continue; end;
        blank := ch = ' ';
        CSkipBlanks;
        if ch = '(' then begin CExpandMacro(m); continue; end;
      end;
      for i := 1 to length(cName) do CTmpPut(ord(cName[i]));
      if blank then CTmpPut(32);
    end else if (ch >= '0') and (ch <= '9') then begin
      while IsIdCh(ch) or (ch = '.') do begin CTmpPut(ord(ch)); CNextCh; end;
    end else if (ch = '"') or (ch = '''') then begin
      q := ch;
      CTmpPut(ord(ch)); CNextCh;
      while (ch <> q) and (ch <> #0) do begin
        if ch = '\' then begin CTmpPut(92); CNextCh; end;
        CTmpPut(ord(ch)); CNextCh;
      end;
      if ch = q then begin CTmpPut(ord(q)); CNextCh; end;
    end else begin
      CTmpPut(ord(ch)); CNextCh;
    end;
  end;
  { the barrier frame ends: back to the text below it }
  cBarrier := oldBar;
  CPopFrame;
end;

{ an invocation of macro m: (the name has been read; for a function-like
  macro ch is the opening parenthesis) its replacement text becomes a frame }
procedure CExpandMacro(m: integer);
var a, body, blen, p, t0, pool0, rawStart: longint;
    np, n, depth, i, k, c: integer;
    variadic, paste, raw: boolean;
    q: char;
    argAt, argLen, expAt, expLen: array[0..16] of longint;
  procedure PutArg(from, len: longint);
  var j: longint;
  begin
    for j := 0 to len - 1 do CTmpPut(Mem[from + j]);
  end;
begin
  a := MacTab + longint(m - 1) * 32;
  np := Mem[a + 26];
  variadic := Mem[a + 27] and 1 <> 0;
  body := MemL[a + 28] + 2;
  blen := CGetW(MemL[a + 28]);
  pool0 := cPoolTop;
  n := 0;
  if np <> 255 then begin
    { the arguments, as they are written }
    CNextCh;                          { after ( }
    rawStart := cTmpTop;
    depth := 0;
    argAt[0] := cTmpTop - rawStart;
    CSkipBlanks;
    while ch = #10 do begin CNextCh; CSkipBlanks; end;
    if ch <> ')' then begin
      repeat
        if ch = #0 then CErr(ceMacroArgs, cName);
        if (ch = '"') or (ch = '''') then begin
          q := ch; CTmpPut(ord(ch)); CNextCh;
          while (ch <> q) and (ch <> #0) and (ch <> #10) do begin
            if ch = '\' then begin CTmpPut(92); CNextCh; end;
            CTmpPut(ord(ch)); CNextCh;
          end;
          CTmpPut(ord(q)); CNextCh;
          continue;
        end;
        if (ch = '/') and (CPeek = '*') then begin
          CNextCh; CNextCh;
          while (ch <> #0) and not ((ch = '*') and (CPeek = '/')) do CNextCh;
          CNextCh; CNextCh; ch := ' ';
          continue;
        end;
        if (ch = '(') or (ch = '[') or (ch = '{') then depth := depth + 1
        else if ((ch = ')') or (ch = ']') or (ch = '}')) and (depth > 0) then depth := depth - 1
        else if (ch = ')') and (depth = 0) then break
        else if (ch = ',') and (depth = 0) and not (variadic and (n = np - 1)) then begin
          { the end of an argument (blanks at its end dropped) }
          while (cTmpTop > rawStart + argAt[n]) and (Mem[cTmpTop - 1] = 32) do cTmpTop := cTmpTop - 1;
          argLen[n] := cTmpTop - rawStart - argAt[n];
          n := n + 1;
          if n > 15 then CErr(ceMacroArgs, cName);
          CNextCh; CSkipBlanks;
          while ch = #10 do begin CNextCh; CSkipBlanks; end;
          argAt[n] := cTmpTop - rawStart;
          continue;
        end;
        if ch = #10 then ch := ' ';
        if (ch = ' ') and ((cTmpTop = rawStart + argAt[n]) or (Mem[cTmpTop - 1] = 32)) then begin CNextCh; continue; end;
        CTmpPut(ord(ch));
        CNextCh;
      until false;
      while (cTmpTop > rawStart + argAt[n]) and (Mem[cTmpTop - 1] = 32) do cTmpTop := cTmpTop - 1;
      argLen[n] := cTmpTop - rawStart - argAt[n];
      n := n + 1;
    end;
    { ch = ')' : the rest of the text goes on after the replacement }
    if (n = 0) and (np = 1) then begin argAt[0] := cTmpTop - rawStart; argLen[0] := 0; n := 1; end;
    if variadic and (n = np - 1) then begin argAt[n] := cTmpTop - rawStart; argLen[n] := 0; n := n + 1; end;
    if n <> np then CErr(ceMacroArgs, cName);
    p := CTmpToPool(rawStart);
    for i := 0 to n - 1 do argAt[i] := argAt[i] + p;
    { each argument expanded }
    for i := 0 to n - 1 do begin
      t0 := cTmpTop;
      CExpandText(argAt[i], argLen[i]);
      expLen[i] := cTmpTop - t0;
      expAt[i] := CTmpToPool(t0);
    end;
    ch := ' ';     { the ) is read: the replacement's frame gives back a blank }
  end;
  { the replacement text }
  t0 := cTmpTop;
  p := body;
  paste := false;
  while p < body + blen do begin
    c := Mem[p]; p := p + 1;
    if c = 1 then begin
      k := Mem[p] - 1; p := p + 1;
      { next to ## : the argument as written }
      raw := paste or ((p < body + blen) and (Mem[p] = 3));
      if raw then PutArg(argAt[k], argLen[k]) else PutArg(expAt[k], expLen[k]);
      paste := false;
    end else if c = 2 then begin
      k := Mem[p] - 1; p := p + 1;
      CTmpPut(34);
      for i := 0 to argLen[k] - 1 do begin
        c := Mem[argAt[k] + i];
        if (c = 34) or (c = 92) then CTmpPut(92);
        CTmpPut(c);
      end;
      CTmpPut(34);
      paste := false;
    end else if c = 3 then begin
      { ## : the two sides join; , ## __VA_ARGS__ with no arguments drops the comma }
      while (cTmpTop > t0) and (Mem[cTmpTop - 1] = 32) do cTmpTop := cTmpTop - 1;
      while (p < body + blen) and (Mem[p] = 32) do p := p + 1;
      if variadic and (p + 1 < body + blen) and (Mem[p] = 1) and (Mem[p + 1] = np) and (argLen[np - 1] = 0) and
         (cTmpTop > t0) and (Mem[cTmpTop - 1] = ord(',')) then cTmpTop := cTmpTop - 1;
      paste := true;
    end else begin
      CTmpPut(c);
      paste := false;
    end;
  end;
  CTmpPut(32);
  p := CTmpToPool(t0);
  CPushFrame(p, cPoolTop - p, fkMacro, m, pool0);
  CNextCh;
end;

{ ---------------------------------------------------------------- includes }
function CUpName(const s: string): string;
var i: integer;
    r: string[16];
begin
  r := s;
  if length(r) > 12 then r[0] := chr(12);
  for i := 1 to length(r) do r[i] := UpCase(r[i]);
  CUpName := r;
end;

{ a header in the ROM: its text and length; false when there is none }
function CRomHeader(const n: string; var at, len: longint): boolean;
var i, k, cnt: integer;
    a: longint;
    ok: boolean;
    u: string[16];
begin
  CRomHeader := false;
  u := CUpName(n);
  cnt := Mem[cHdrBase] + Mem[cHdrBase + 1] * 256;
  for i := 0 to cnt - 1 do begin
    a := cHdrBase + 2 + longint(i) * 20;
    if Mem[a] = length(u) then begin
      ok := true;
      for k := 1 to length(u) do if Mem[a + k] <> ord(u[k]) then ok := false;
      if ok then begin
        at := cHdrBase + (CGetW(a + 13) or (CGetW(a + 15) shl 16));
        len := longint(Mem[a + 17]) or (longint(Mem[a + 18]) shl 8) or (longint(Mem[a + 19]) shl 16);
        CRomHeader := true;
        exit;
      end;
    end;
  end;
end;

{ a file from drive d, loaded after the program and its other files }
function CLoadFrom(d: integer; const n: string; var at, len: longint): boolean;
var old: integer;
begin
  CLoadFrom := false;
  if unitTop >= $2F0000 then CErr(ceInclude, n);
  old := CurrentDrive;
  SetDrive(d);
  len := LoadFile(CUpName(n), unitTop, $300000 - unitTop);
  SetDrive(old);
  if len < 0 then exit;
  at := unitTop;
  unitTop := (unitTop + len + 255) and $FFFF00;
  CLoadFrom := true;
end;

procedure CIncludeFile(const n: string; system: boolean);
var at, len: longint;
    i, d: integer;
    found: boolean;
    u: string[16];
    a: longint;
begin
  if cFileDepth >= 8 then CErr0(ceIncNest);
  { the cartridge's own (the predefined macros), then the current drive,
    then the others: the headers are on the C disk (C.DSK) }
  found := CRomHeader(n, at, len);
  if not found then found := CLoadFrom(CurrentDrive, n, at, len);
  d := 1;
  while not found and (d <= 3) do begin
    if d <> CurrentDrive then found := CLoadFrom(d, n, at, len);
    d := d + 1;
  end;
  if not found then begin
    if system then CErr(ceNoHeader, n) else CErr(ceInclude, n);
  end;
  u := CUpName(n);
  a := CFileNames + longint(cFileDepth) * 16;
  Mem[a] := length(u);
  for i := 1 to length(u) do Mem[a + i] := ord(u[i]);
  cFileDepth := cFileDepth + 1;
  CPushFrame(at, len, fkFile, 0, cPoolTop);
  curFile := u;
  line := 1; col := 0;
  cBol := true;
  CNextCh;
end;

{ ---------------------------------------------------------------- directives }
procedure CNext; forward;
function CConstValue: longint; forward;

{ the value of the #if expression on the rest of the line }
function CIfValue: boolean;
var v: longint;
begin
  cPP := true;
  CNext;
  v := CConstValue;
  if sym <> tEOL then CErr0(ceSyntax);
  cPP := false;
  CIfValue := v <> 0;
end;

{ skip the text of a branch not taken, up to the #elif / #else / #endif
  that ends it; ch is at the start of a line }
procedure CSkipBranch;
var nest: integer;
    w: string[8];
    k: integer;
begin
  nest := 0;
  repeat
    { the start of a line }
    CSkipBlanks;
    if ch = '#' then begin
      CNextCh; CSkipBlanks;
      k := 0;
      while IsIdCh(ch) do begin if k < 8 then begin k := k + 1; w[k] := ch; end; CNextCh; end;
      w[0] := chr(k);
      if (w = 'if') or (w = 'ifdef') or (w = 'ifndef') then nest := nest + 1
      else if w = 'endif' then begin
        if nest = 0 then begin cCondN := cCondN - 1; CSkipLine; exit; end;
        nest := nest - 1;
      end else if (nest = 0) and (w = 'else') then begin
        if cCond[cCondN] = 1 then begin cCond[cCondN] := 0; CSkipLine; exit; end;
      end else if (nest = 0) and (w = 'elif') then begin
        if cCond[cCondN] = 1 then begin
          if CIfValue then begin cCond[cCondN] := 0; exit; end;
          continue;
        end;
      end;
    end;
    { the rest of the line; a comment may go on over lines }
    while (ch <> #10) and (ch <> #0) do begin
      if (ch = '/') and (CPeek = '*') then begin
        CNextCh; CNextCh;
        while (ch <> #0) and not ((ch = '*') and (CPeek = '/')) do CNextCh;
        CNextCh;
      end else if (ch = '"') or (ch = '''') then begin
        k := ord(ch); CNextCh;
        while (ord(ch) <> k) and (ch <> #10) and (ch <> #0) do begin if ch = '\' then CNextCh; CNextCh; end;
      end;
      if ch <> #10 then CNextCh;
    end;
    if ch = #0 then CErr0(ceNoEndif);
    CNextCh;
  until false;
end;

procedure CUnitPragma;
var i, k, cnt: integer;
    a: longint;
    ok: boolean;
begin
  CSkipBlanks;
  CReadName;
  for i := 1 to length(cName) do cName[i] := LoCase(cName[i]);
  cnt := Mem[cUnitBase];
  a := cUnitBase + 1;
  for i := 0 to cnt - 1 do begin
    if Mem[a] = length(cName) then begin
      ok := true;
      for k := 1 to length(cName) do if Mem[a + k] <> ord(cName[k]) then ok := false;
      if ok then begin cUnits := cUnits or (longint(1) shl i); exit; end;
    end;
    a := a + Mem[a] + 1;
  end;
  CErr(ceUnit, cName);
end;

{ after the # of a directive }
procedure CDirective;
var w: string[12];
    k: integer;
    q: char;
    n: string[31];
    sys: boolean;
begin
  CNextCh; CSkipBlanks;
  k := 0;
  while IsIdCh(ch) do begin if k < 12 then begin k := k + 1; w[k] := ch; end; CNextCh; end;
  w[0] := chr(k);
  if w = '' then begin CSkipLine; exit; end;
  if w = 'define' then CDefine
  else if w = 'undef' then begin
    CMacSave;
    CSkipBlanks; CReadName;
    k := MacFind(cName);
    if k <> 0 then Mem[MacTab + longint(k - 1) * 32 + 27] := 0;
    CSkipLine;
  end
  else if w = 'include' then begin
    CSkipBlanks;
    if (ch <> '"') and (ch <> '<') then CErr0(ceDirective);
    sys := ch = '<';
    if sys then q := '>' else q := '"';
    CNextCh;
    n := '';
    while (ch <> q) and (ch <> #10) and (ch <> #0) do begin if length(n) < 31 then n := n + ch; CNextCh; end;
    CSkipLine;
    CIncludeFile(n, sys);
    exit;
  end
  else if (w = 'ifdef') or (w = 'ifndef') or (w = 'if') then begin
    if cCondN >= 16 then CErr0(ceCondNest);
    cCondN := cCondN + 1;
    cCond[cCondN] := 0;
    if w = 'if' then begin
      if CIfValue then exit;
    end else begin
      CSkipBlanks; CReadName;
      if (MacFind(cName) <> 0) = (w = 'ifdef') then begin CSkipLine; exit; end;
      CSkipLine;
    end;
    { not taken: skip to the next branch }
    cCond[cCondN] := 1;
    CNextCh;
    CSkipBranch;
    exit;
  end
  else if (w = 'else') or (w = 'elif') then begin
    if cCondN = 0 then CErr0(ceElse);
    { the branch before was taken: skip to the #endif }
    cCond[cCondN] := 2;
    CSkipLine;
    CNextCh;
    CSkipBranch;
    exit;
  end
  else if w = 'endif' then begin
    if cCondN = 0 then CErr0(ceEndif);
    cCondN := cCondN - 1;
    CSkipLine;
  end
  else if w = 'error' then begin
    CSkipBlanks;
    n := '';
    while (ch <> #10) and (ch <> #0) do begin if length(n) < 31 then n := n + ch; CNextCh; end;
    CErr(ceError, n);
  end
  else if w = 'pragma' then begin
    CSkipBlanks; CReadName;
    if cName = 'unit' then CUnitPragma;
    CSkipLine;
  end
  else if w = 'line' then begin
    { #line n: the next line is line n }
    CSkipBlanks;
    k := 0;
    while (ch >= '0') and (ch <= '9') do begin k := k * 10 + ord(ch) - 48; CNextCh; end;
    CSkipLine;
    if ch = #10 then line := k;
  end
  else if (w = 'warning') or (w = 'ident') then CSkipLine
  else CErr(ceDirective, w);
end;

{ ---------------------------------------------------------------- the scanner }
function CKeyword: integer;
var a: longint;
    k, i, c: integer;
    ok: boolean;
begin
  CKeyword := 0;
  c := ord(cName[1]);
  if c = 95 then c := 26 else if (c >= 97) and (c <= 122) then c := c - 97 else exit;
  a := cKwBase + CGetW(cKwBase + c * 2);
  k := length(cName);
  while Mem[a] <> 0 do begin
    if Mem[a] = k then begin
      ok := true;
      for i := 2 to k do if Mem[a + i] <> ord(cName[i]) then begin ok := false; break; end;
      if ok then begin CKeyword := Mem[a + k + 1]; exit; end;
    end;
    a := a + Mem[a] + 2;
  end;
end;

function CEscape: integer;
var v, d, n: integer;
begin
  { ch is after the backslash }
  case ch of
    'n': v := 10; 't': v := 9; 'r': v := 13; 'a': v := 7; 'b': v := 8; 'f': v := 12; 'v': v := 11;
    'e': v := 27;
    'x': begin
      CNextCh; v := 0;
      d := HexDigit(ch);
      while d >= 0 do begin v := (v * 16 + d) and 255; CNextCh; d := HexDigit(ch); end;
      CEscape := v; exit;
    end;
    '0'..'7': begin
      v := 0; n := 0;
      while (ch >= '0') and (ch <= '7') and (n < 3) do begin v := v * 8 + ord(ch) - 48; n := n + 1; CNextCh; end;
      CEscape := v and 255; exit;
    end;
  else
    v := ord(ch);
  end;
  CNextCh;
  CEscape := v;
end;

procedure CNumber;
var d: integer;
    big, isReal, uns, lng, oct: boolean;
    s: string[40];
begin
  num := 0; big := false; isReal := false; oct := false;
  s := '';
  if (ch = '0') and ((CPeek = 'x') or (CPeek = 'X')) then begin
    CNextCh; CNextCh;
    d := HexDigit(ch);
    if d < 0 then CErr0(ceNumber);
    while d >= 0 do begin
      if (num shr 28) <> 0 then big := true;
      num := (num shl 4) or d;
      CNextCh; d := HexDigit(ch);
    end;
    if num < 0 then big := true;
  end else if (ch = '0') and ((CPeek = 'b') or (CPeek = 'B')) then begin
    CNextCh; CNextCh;
    while (ch = '0') or (ch = '1') do begin num := num * 2 + ord(ch) - 48; CNextCh; end;
    if num < 0 then big := true;
  end else begin
    oct := ch = '0';
    while (ch >= '0') and (ch <= '9') do begin
      if length(s) < 40 then s := s + ch;
      d := ord(ch) - 48;
      if oct then begin
        if (num shr 29) <> 0 then big := true;
        num := num * 8 + d;
      end else begin
        if (num > 214748364) or ((num = 214748364) and (d > 7)) then big := true;
        num := num * 10 + d;
      end;
      CNextCh;
    end;
    if (ch = '.') or (ch = 'e') or (ch = 'E') then begin
      isReal := true;
      if ch = '.' then begin
        s := s + '.'; CNextCh;
        if not ((ch >= '0') and (ch <= '9')) then s := s + '0';
        while (ch >= '0') and (ch <= '9') do begin if length(s) < 40 then s := s + ch; CNextCh; end;
      end;
      if (ch = 'e') or (ch = 'E') then begin
        s := s + 'E'; CNextCh;
        if (ch = '+') or (ch = '-') then begin s := s + ch; CNextCh; end;
        while (ch >= '0') and (ch <= '9') do begin s := s + ch; CNextCh; end;
      end;
      if s[1] = '.' then s := '0' + s;
      if (ch = 'f') or (ch = 'F') or (ch = 'l') or (ch = 'L') then CNextCh;
      num := RealOf(s);
      sym := sReal; cNumTyp := tReal;
      exit;
    end;
    if oct and (num < 0) then big := true;
  end;
  uns := false; lng := false;
  while (ch = 'u') or (ch = 'U') or (ch = 'l') or (ch = 'L') do begin
    if (ch = 'u') or (ch = 'U') then uns := true else lng := true;
    CNextCh;
  end;
  if IsIdCh(ch) then CErr0(ceNumber);
  sym := sNumber;
  { the type: int, unsigned (hex and octal), long, unsigned long }
  if big then cNumTyp := tLongW
  else if not uns and not lng and (num <= 32767) then cNumTyp := tInteger
  else if not lng and (uns or (s = '')  or (s[1] = '0')) and (num <= 65535) then cNumTyp := tWord
  else if uns then cNumTyp := tLongW
  else cNumTyp := tLong;
end;

procedure CNext;
var c: char;
    m: integer;
begin
  repeat
    while (ch = ' ') or (ch = #10) do begin
      if ch = #10 then begin
        if cPP then begin sym := tEOL; tokLine := line; exit; end;
        cBol := true;
      end;
      CNextCh;
    end;
    if (ch = '/') and (CPeek = '*') then begin
      CNextCh; CNextCh;
      while (ch <> #0) and not ((ch = '*') and (CPeek = '/')) do CNextCh;
      if ch = #0 then CErr0(ceSyntax);
      CNextCh; CNextCh;
      continue;
    end;
    if (ch = '/') and (CPeek = '/') then begin
      while (ch <> #10) and (ch <> #0) do CNextCh;
      continue;
    end;
    if (ch = '#') and cBol and not cPP and (cKind = fkFile) then begin
      CDirective;
      cBol := true;
      continue;
    end;
    break;
  until false;
  cBol := false;
  tokLine := line; tokCol := col;
  c := ch;
  case c of
    #0: begin
      if cPP then begin sym := tEOL; exit; end;
      sym := sEOF;
    end;
    'a'..'z', 'A'..'Z', '_': begin
      CReadName;
      if not cNoMacros then begin
        m := MacFind(cName);
        if (m <> 0) and (Mem[MacTab + longint(m - 1) * 32 + 27] and 2 = 0) then begin
          if Mem[MacTab + longint(m - 1) * 32 + 26] = 255 then begin CExpandMacro(m); CNext; exit; end;
          CSkipBlanks;
          while (ch = #10) and not cPP do begin CNextCh; CSkipBlanks; end;
          if ch = '(' then begin CExpandMacro(m); CNext; exit; end;
        end;
      end;
      if (cName[1] = '_') and (length(cName) = 8) then begin
        if cName = '__LINE__' then begin sym := sNumber; num := line; cNumTyp := tInteger; exit; end;
        if cName = '__FILE__' then begin
          sym := sString;
          if curFile = '' then str := cMainName else str := curFile;
          exit;
        end;
      end;
      id := cName;
      sym := CKeyword;
      if sym = 0 then sym := sIdent;
    end;
    '0'..'9': CNumber;
    '''': begin
      CNextCh;
      if ch = '\' then begin CNextCh; num := CEscape; end
      else if (ch = '''') or (ch = #10) then CErr0(ceChar)
      else begin num := ord(ch); CNextCh; end;
      while (ch <> '''') and (ch <> #10) and (ch <> #0) do CNextCh;
      if ch <> '''' then CErr0(ceChar);
      CNextCh;
      sym := sNumber; cNumTyp := tInteger;
    end;
    '"': begin
      str := '';
      CNextCh;
      while (ch <> '"') do begin
        if (ch = #10) or (ch = #0) then CErr0(ceString);
        if length(str) >= 255 then CErr0(ceStrLong);
        if ch = '\' then begin CNextCh; str := str + chr(CEscape); end
        else begin str := str + ch; CNextCh; end;
      end;
      CNextCh;
      sym := sString;
    end;
    '+': begin CNextCh; if ch = '+' then begin sym := tInc; CNextCh; end else if ch = '=' then begin sym := tAddAs; CNextCh; end else sym := tPlus; end;
    '-': begin
      CNextCh;
      if ch = '-' then begin sym := tDec; CNextCh; end
      else if ch = '=' then begin sym := tSubAs; CNextCh; end
      else if ch = '>' then begin sym := tArrow; CNextCh; end
      else sym := tMinus;
    end;
    '*': begin CNextCh; if ch = '=' then begin sym := tMulAs; CNextCh; end else sym := tStar; end;
    '/': begin CNextCh; if ch = '=' then begin sym := tDivAs; CNextCh; end else sym := tSlash; end;
    '%': begin CNextCh; if ch = '=' then begin sym := tModAs; CNextCh; end else sym := tPercent; end;
    '=': begin CNextCh; if ch = '=' then begin sym := tEq; CNextCh; end else sym := tAssign; end;
    '!': begin CNextCh; if ch = '=' then begin sym := tNe; CNextCh; end else sym := tNot; end;
    '<': begin
      CNextCh;
      if ch = '=' then begin sym := tLe; CNextCh; end
      else if ch = '<' then begin
        CNextCh;
        if ch = '=' then begin sym := tShlAs; CNextCh; end else sym := tShl;
      end else sym := tLt;
    end;
    '>': begin
      CNextCh;
      if ch = '=' then begin sym := tGe; CNextCh; end
      else if ch = '>' then begin
        CNextCh;
        if ch = '=' then begin sym := tShrAs; CNextCh; end else sym := tShr;
      end else sym := tGt;
    end;
    '&': begin
      CNextCh;
      if ch = '&' then begin sym := tAndAnd; CNextCh; end
      else if ch = '=' then begin sym := tAndAs; CNextCh; end
      else sym := tAmp;
    end;
    '|': begin
      CNextCh;
      if ch = '|' then begin sym := tOrOr; CNextCh; end
      else if ch = '=' then begin sym := tOrAs; CNextCh; end
      else sym := tBar;
    end;
    '^': begin CNextCh; if ch = '=' then begin sym := tXorAs; CNextCh; end else sym := tCaret; end;
    '~': begin sym := tTilde; CNextCh; end;
    '?': begin sym := tQuest; CNextCh; end;
    ':': begin sym := tColon; CNextCh; end;
    ';': begin sym := tSemi; CNextCh; end;
    ',': begin sym := tComma; CNextCh; end;
    '(': begin sym := tLpar; CNextCh; end;
    ')': begin sym := tRpar; CNextCh; end;
    '[': begin sym := tLbrk; CNextCh; end;
    ']': begin sym := tRbrk; CNextCh; end;
    '{': begin sym := tLbrace; CNextCh; end;
    '}': begin sym := tRbrace; CNextCh; end;
    '.': begin
      if (CPeek >= '0') and (CPeek <= '9') then begin
        { .5 }
        CNumber; exit;
      end;
      CNextCh;
      if (ch = '.') and (CPeek = '.') then begin CNextCh; CNextCh; sym := tEllipsis; end
      else sym := tDot;
    end;
  else
    CErr(ceBadChar, c);
  end;
end;

procedure CExpect(s: integer);
begin
  if sym <> s then CErr(ceExpected, CTokText(s));
  CNext;
end;
