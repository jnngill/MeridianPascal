{ MERIDIAN C on the MERIDIAN - part 4: statements, initializers,
  declarations, functions and the program (included by ccomp.inc).

  A function's body is read twice: the first time only to learn how big
  its frame is (its code is thrown away; calls are not chained), the
  second time for good. So the 65C816 frame, whose size the parameters'
  direct page offsets depend on, is known before the first instruction,
  even with declarations anywhere in the body. }

const
  CDeclTab = $372C00;   { the sizes of local arrays sized by their initializer (pass 1 -> pass 2) }
  CStage = $35E000;     { a global array sized by its initializer is built here first }
  CStageSize = $2000;

var
  cLoopN: integer;
  cBrk, cCont, cContAt: array[1..24] of longint;
  cIsSw: array[1..24] of boolean;
  cSwN, cCaseN, cLabN, cDeclIdx: integer;
  cSwStart: array[1..12] of integer;
  cSwDef: array[1..12] of longint;
  cSwLong: array[1..12] of boolean;

procedure CStatement; forward;
procedure CLocalDecl; forward;

{ ---------------------------------------------------------------- loops }
procedure CPushLoop(sw: boolean; contAt: longint);
begin
  if cLoopN >= 24 then CErr0(ceNested);
  cLoopN := cLoopN + 1;
  cBrk[cLoopN] := 0; cCont[cLoopN] := 0; cContAt[cLoopN] := contAt; cIsSw[cLoopN] := sw;
end;

procedure CPopLoop;
begin
  FixChain(cBrk[cLoopN], pc);
  cLoopN := cLoopN - 1;
end;

procedure CJumpTrueTo(var x: TItem; target: longint);
var v: longint;
begin
  CCondOf(x);
  if x.mode = mConst then begin
    if x.a <> 0 then BrlTo(target);
    exit;
  end;
  x.a := Inverse(x.a);
  v := x.tj; x.tj := x.fj; x.fj := v;
  JumpFalseTo(x, target);
end;

procedure CCondition(var x: TItem);
begin
  CExpect(tLpar);
  CExpr(x);
  CExpect(tRpar);
  CCondOf(x);
end;

{ ---------------------------------------------------------------- labels }
function CLabel(const n: TName): integer;
var i, k: integer;
    a: longint;
    ok: boolean;
begin
  for i := 0 to cLabN - 1 do begin
    a := CLabels + longint(i) * 24;
    if Mem[a] = length(n) then begin
      ok := true;
      for k := 1 to length(n) do if Mem[a + k] <> ord(n[k]) then ok := false;
      if ok then begin CLabel := i; exit; end;
    end;
  end;
  if cLabN >= MaxCLabel then CErr0(ceLabels);
  a := CLabels + longint(cLabN) * 24;
  Mem[a] := length(n);
  for k := 1 to length(n) do Mem[a + k] := ord(n[k]);
  MemL[a + 16] := -1; MemL[a + 20] := 0;
  CLabel := cLabN;
  cLabN := cLabN + 1;
end;

procedure CEndLabels;
var i, k: integer;
    a: longint;
    n: TName;
begin
  for i := 0 to cLabN - 1 do begin
    a := CLabels + longint(i) * 24;
    if MemL[a + 16] < 0 then begin
      n[0] := chr(Mem[a]);
      for k := 1 to Mem[a] do n[k] := chr(Mem[a + k]);
      CErr(ceLabel, n);
    end;
  end;
end;

{ ---------------------------------------------------------------- switch }
procedure CSwitch;
var x, v: TItem;
    t, tmp, k: integer;
    disp, a, lo, hi, adr: longint;
begin
  CNext;
  CExpect(tLpar);
  CExpr(x);
  CExpect(tRpar);
  CValue(x);
  if not CIsInt(x.typ) then CErr0(ceConv);
  t := CPromote(x.typ);
  CConvTo(x, t);
  if x.mode = mConst then Load(x);
  tmp := AllocLocal(types[t].size);
  v.mode := mLoc; v.a := LocDp(tmp); v.typ := t; v.tmp := false;
  CStore(v);
  disp := 0;
  BrlFwd(disp);
  if cSwN >= 12 then CErr0(ceNested);
  cSwN := cSwN + 1;
  cSwStart[cSwN] := cCaseN; cSwDef[cSwN] := -1; cSwLong[cSwN] := types[t].size = 4;
  CPushLoop(true, -1);
  CStatement;
  BrlFwd(cBrk[cLoopN]);
  FixChain(disp, pc);
  { the dispatch: the value against each case }
  v.mode := mLoc; v.a := LocDp(tmp); v.typ := t;
  CLoad(v);
  for k := cSwStart[cSwN] to cCaseN - 1 do begin
    a := CCases + longint(k) * 12;
    lo := MemL[a]; hi := MemL[a + 4]; adr := MemL[a + 8];
    if rv then begin
      if lo = hi then begin
        RLi(rT1, lo); RB(1, rA0, rT1, 8); W32(JEnc(rZero, adr - pc));
      end else begin
        RAddi(rT1, rA0, -lo); RLi(rT2, hi - lo); RB(6, rT2, rT1, 8); W32(JEnc(rZero, adr - pc));
      end;
    end else if cSwLong[cSwN] then begin
      if lo <> hi then CErr0(ceNotHere);
      Op16($C9, lo and $FFFF); Op8($D0, 8); Op16($E0, (lo shr 16) and $FFFF); Op8($D0, 3); BrlTo(adr);
    end else if lo = hi then begin
      Op16($C9, lo and $FFFF); Op8($D0, 3); BrlTo(adr);
    end else begin
      Gen($48); Gen($38); Op16($E9, lo and $FFFF); Op16($C9, (hi - lo + 1) and $FFFF); Gen($68);
      Op8($B0, 3); BrlTo(adr);
    end;
  end;
  if cSwDef[cSwN] >= 0 then BrlTo(cSwDef[cSwN]);
  cCaseN := cSwStart[cSwN];
  cSwN := cSwN - 1;
  CPopLoop;
end;

procedure CCaseLabel;
var lo, hi, a: longint;
begin
  if cSwN = 0 then CErr0(ceCase);
  CNext;
  lo := CConstValue;
  hi := lo;
  if sym = tEllipsis then begin CNext; hi := CConstValue; end;
  CExpect(tColon);
  if cCaseN >= MaxCase then CErr0(ceCases);
  if not cSwLong[cSwN] then begin lo := CWrap(lo, tInteger); hi := CWrap(hi, tInteger); end;
  a := CCases + longint(cCaseN) * 12;
  MemL[a] := lo; MemL[a + 4] := hi; MemL[a + 8] := pc;
  cCaseN := cCaseN + 1;
end;

{ ---------------------------------------------------------------- statements }
procedure CCompound;
var mark: integer;
begin
  CNext;
  mark := nSym;
  while sym <> tRbrace do begin
    if sym = sEOF then CErr(ceExpected, CTokText(tRbrace));
    if CIsTypeStart then CLocalDecl else CStatement;
  end;
  CNext;
  nSym := mark;
end;

procedure CReturn;
var y, z: TItem;
    dp: longint;
begin
  CNext;
  if sym <> tSemi then begin
    CExpr(y);
    if types[cRetT].form = fRec then begin
      { into the caller's buffer; its address is the result }
      CConvTo(y, cRetT);
      dp := ParDp(1, 0);
      CLoadAdr(y);
      if rv then begin
        RMv(rA1, rA0); RLd(4, false, rA0, rS0, dp); RLi(rA2, types[cRetT].size); RCall(aMemmove);
        RLd(4, false, rA0, rS0, dp);
      end else begin
        Gen($48); LdaDp(dp); Gen($A8); Gen($FA);           { pha / lda hid / tay / plx }
        LdaImm(types[cRetT].size - 1); Op8($54, 0); Gen(0);
        LdaDp(dp);
      end;
    end else if cRetT = tVoid then CDiscard(y)
    else begin
      CConvTo(y, cRetT);
      if y.mode = mConst then Load(y);
    end;
  end else if cIsMain then LdaImm(0);
  BrlFwd(ctxExit[1]);
  CExpect(tSemi);
end;

procedure CStatement;
var x: TItem;
    f, e, top, inc, body, mark: longint;
    k: integer;
    n: TName;
begin
  if DebugLines then StmtLine;
  case sym of
    tLbrace: CCompound;
    tSemi: CNext;
    kIf: begin
      CNext;
      CCondition(x);
      f := 0;
      JumpFalse(x, f);
      CStatement;
      if sym = kElse then begin
        CNext;
        e := 0; BrlFwd(e);
        FixChain(f, pc);
        CStatement;
        FixChain(e, pc);
      end else FixChain(f, pc);
    end;
    kWhile: begin
      CNext;
      top := pc;
      CCondition(x);
      f := 0;
      JumpFalse(x, f);
      CPushLoop(false, top);
      CStatement;
      BrlTo(top);
      FixChain(f, pc);
      CPopLoop;
    end;
    kDo: begin
      CNext;
      top := pc;
      CPushLoop(false, -1);
      CStatement;
      if sym <> kWhile then CErr(ceExpected, 'while');
      CNext;
      FixChain(cCont[cLoopN], pc);
      CCondition(x);
      CExpect(tSemi);
      CJumpTrueTo(x, top);
      CPopLoop;
    end;
    kFor: begin
      CNext;
      CExpect(tLpar);
      mark := nSym;
      if sym = tSemi then CNext
      else if CIsTypeStart then CLocalDecl
      else begin CExpr(x); CDiscard(x); CExpect(tSemi); end;
      top := pc;
      f := 0;
      if sym <> tSemi then begin CExpr(x); CCondOf(x); JumpFalse(x, f); end;
      CExpect(tSemi);
      inc := top;
      if sym <> tRpar then begin
        body := 0; BrlFwd(body);
        inc := pc;
        CExpr(x); CDiscard(x);
        BrlTo(top);
        FixChain(body, pc);
      end;
      CExpect(tRpar);
      CPushLoop(false, inc);
      CStatement;
      BrlTo(inc);
      FixChain(f, pc);
      CPopLoop;
      nSym := mark;
    end;
    kSwitch: CSwitch;
    kCase: begin CCaseLabel; CStatement; end;
    kDefault: begin
      if cSwN = 0 then CErr0(ceCase);
      CNext; CExpect(tColon);
      if cSwDef[cSwN] >= 0 then CErr0(ceDupCase);
      cSwDef[cSwN] := pc;
      CStatement;
    end;
    kBreak: begin
      if cLoopN = 0 then CErr0(ceBreak);
      CNext;
      BrlFwd(cBrk[cLoopN]);
      CExpect(tSemi);
    end;
    kContinue: begin
      k := cLoopN;
      while (k > 0) and cIsSw[k] do k := k - 1;
      if k = 0 then CErr0(ceContinue);
      CNext;
      if cContAt[k] >= 0 then BrlTo(cContAt[k]) else BrlFwd(cCont[k]);
      CExpect(tSemi);
    end;
    kReturn: CReturn;
    kGoto: begin
      CNext;
      if sym <> sIdent then CErr(ceExpected, CTokText(sIdent));
      k := CLabel(id);
      CNext;
      f := CLabels + longint(k) * 24;
      if MemL[f + 16] >= 0 then BrlTo(MemL[f + 16])
      else begin e := MemL[f + 20]; BrlFwd(e); MemL[f + 20] := e; end;
      CExpect(tSemi);
    end;
  else
    if sym = sIdent then begin
      CSkipBlanks;
      if (ch = ':') and (CPeek <> ':') then begin
        { a label }
        n := id;
        k := CLabel(n);
        f := CLabels + longint(k) * 24;
        if MemL[f + 16] >= 0 then CErr(ceDupLabel, n);
        FixChain(MemL[f + 20], pc);
        MemL[f + 16] := pc;
        CNext;
        CExpect(tColon);
        lastDbg := -1;
        if sym = tRbrace then exit;
        CStatement;
        exit;
      end;
    end;
    CExpr(x);
    CDiscard(x);
    CExpect(tSemi);
  end;
end;

{ ---------------------------------------------------------------- initializers }
procedure CPutConst(a: longint; t: integer; v: longint);
var i: integer;
begin
  for i := 0 to types[t].size - 1 do begin Mem[a + i] := v and 255; v := v shr 8; end;
end;

function CInitList(t: integer; glob: boolean; at: longint; braced: boolean): longint; forward;

{ a string for an array of characters: its bytes (n of them, -1: all and the 0) }
function CInitString(t: integer; glob: boolean; at: longint): longint;
var s: string;
    n, i: integer;
    d: longint;
    y, z: TItem;
begin
  s := str;
  CNext;
  while sym = sString do begin
    if length(s) + length(str) > 255 then CErr0(ceStrLong);
    s := s + str;
    CNext;
  end;
  n := types[t].hi + 1;
  if n <= 0 then n := length(s) + 1;
  if glob then begin
    for i := 1 to length(s) do if i <= n then Mem[at + i - 1] := ord(s[i]);
  end else begin
    { a copy from the data }
    d := AllocData(n);
    for i := 1 to length(s) do if i <= n then Mem[DataImg + d - dataOrg + i - 1] := ord(s[i]);
    y.mode := mGlob; y.a := d; y.typ := CArr(tByte, n); y.tmp := false;
    z.mode := mLoc; z.a := LocDp(at); z.typ := y.typ; z.tmp := false;
    CCopyStruct(z, y);
  end;
  CInitString := n;
end;

{ one initializer for an object of type t (a global's bytes at the far
  address at, a local at frame offset at); top: the object itself }
procedure CInit(t: integer; glob: boolean; at: longint; top: boolean);
var y, z: TItem;
    n: longint;
begin
  if sym = tLbrace then begin
    CNext;
    if types[t].form in [fArr, fRec] then n := CInitList(t, glob, at, true)
    else begin CInit(t, glob, at, false); if sym = tComma then CNext; end;
    CExpect(tRbrace);
    exit;
  end;
  if (types[t].form = fArr) and (types[types[t].base].size = 1) and (sym = sString) then begin
    n := CInitString(t, glob, at);
    exit;
  end;
  if types[t].form = fArr then begin n := CInitList(t, glob, at, false); exit; end;
  if (types[t].form = fRec) and (glob or not top) then begin n := CInitList(t, glob, at, false); exit; end;
  CAssignExpr(y);
  if types[t].form = fRec then begin
    CConvTo(y, t);
    z.mode := mLoc; z.a := LocDp(at); z.typ := t; z.tmp := false;
    CCopyStruct(z, y);
    exit;
  end;
  CConvTo(y, t);
  if glob then begin
    if y.mode <> mConst then CErr0(ceInitConst);
    CPutConst(at, t, y.a);
    exit;
  end;
  if y.mode = mConst then Load(y);
  z.mode := mLoc; z.a := LocDp(at); z.typ := t; z.tmp := false;
  CStore(z);
end;

{ the elements of an array or the members of a struct; the number of
  elements given (arrays) }
function CInitList(t: integer; glob: boolean; at: longint; braced: boolean): longint;
var et, f: integer;
    esz, i, max, n: longint;
begin
  max := 0;
  if types[t].form = fArr then begin
    et := types[t].base;
    esz := types[et].size;
    n := types[t].hi + 1;
    i := 0;
    while sym <> tRbrace do begin
      if braced and (sym = tLbrk) then begin
        CNext; i := CConstValue; CExpect(tRbrk); CExpect(tAssign);
      end;
      if (n > 0) and (i >= n) then begin if braced then CErr0(ceTooMany); break; end;
      if glob and (n <= 0) and ((i + 1) * esz > CStageSize) then CErr0(ceTooMany);
      CInit(et, glob, at + i * esz, false);
      i := i + 1;
      if i > max then max := i;
      if sym <> tComma then break;
      if not braced and (n > 0) and (i >= n) then break;
      CNext;
    end;
  end else begin
    f := types[t].fields;
    while sym <> tRbrace do begin
      if braced and (sym = tDot) then begin
        CNext;
        if sym <> sIdent then CErr(ceExpected, CTokText(sIdent));
        f := Member(t, id);
        if f = 0 then CErr(ceNoMember, id);
        CNext;
        CExpect(tAssign);
      end;
      if f = 0 then begin if braced then CErr0(ceTooMany); break; end;
      CInit(syms[f].typ, glob, at + syms[f].adr, false);
      if types[t].hi and 2 <> 0 then f := 0 else f := syms[f].next;
      if sym <> tComma then break;
      if not braced and (f = 0) then break;
      CNext;
    end;
  end;
  CInitList := max;
end;

{ the initializer of a declared object: the number of elements it gave }
function CInitTop(t: integer; glob: boolean; at: longint): longint;
var n: longint;
begin
  CInitTop := 1;
  if (types[t].form = fArr) and (sym = sString) and (types[types[t].base].size = 1) then begin
    CInitTop := CInitString(t, glob, at);
    exit;
  end;
  if (types[t].form = fArr) and (sym = tLbrace) then begin
    CNext;
    if (sym = sString) and (types[types[t].base].size = 1) then begin
      n := CInitString(t, glob, at);
      if sym = tComma then CNext;
    end else n := CInitList(t, glob, at, true);
    CExpect(tRbrace);
    CInitTop := n;
    exit;
  end;
  CInit(t, glob, at, true);
end;

{ a local aggregate: zero first (memset) }
procedure CZeroLocal(at, n: longint);
var e: integer;
    z: TItem;
begin
  e := CLibFind('memset');
  if e < 0 then CErr0(ceNotHere);
  if rv then begin
    RLi(rT1, n); RPush(rT1); RPush(rZero);
  end else begin
    PeaW(n); PeaW(0);
  end;
  z.mode := mLoc; z.a := LocDp(at); z.typ := tByte;
  LoadAdr(z);
  PushA(PtrSz);
  Jsl(ExpValue(e));
  if rv then PopBytes(12) else PopBytes(6);
end;

{ ---------------------------------------------------------------- declarations }
{ a global variable (also a static or extern one in a function) }
procedure CGlobalVar(const name: TName; t: integer; storage: byte; local: boolean);
var s, e: integer;
    size, n: longint;
begin
  s := 0;
  if not local then begin
    s := CFindC(name);
    if s <> 0 then
      if (syms[s].kind <> skVar) or (syms[s].lev <> 0) then CErr(ceRedecl, name);
  end;
  if storage = 2 then begin
    if s <> 0 then exit;
    s := NewSym(name, skVar, t);
    syms[s].lev := 0;
    e := CLibFind(name);
    if (e >= 0) and (Mem[ExpBase + longint(e) * 40 + 20] = 8) then begin syms[s].adr := ExpValue(e); exit; end;
    size := types[t].size;
    if size = 0 then size := 1;
    syms[s].adr := AllocData(size);
    syms[s].flags := 64;
    exit;
  end;
  if s = 0 then begin
    s := NewSym(name, skVar, t);
    syms[s].lev := 0;
    if not ((types[t].form = fArr) and (types[t].hi < 0) and (sym = tAssign)) then begin
      size := types[t].size;
      if size = 0 then size := 1;
      syms[s].adr := AllocData(size);
    end;
  end;
  if sym <> tAssign then exit;
  CNext;
  t := syms[s].typ;
  if (types[t].form = fArr) and (types[t].hi < 0) then begin
    ZeroMem(CStage, CStageSize);
    n := CInitTop(t, true, CStage);
    t := CArr(types[t].base, n);
    syms[s].typ := t;
    syms[s].adr := AllocData(types[t].size);
    CopyMem(CStage, DataImg + syms[s].adr - dataOrg, types[t].size);
  end else n := CInitTop(t, true, DataImg + syms[s].adr - dataOrg);
  syms[s].flags := syms[s].flags and not 64;
end;

procedure CLocalDecl;
var sp: TCSpec;
    t, s, et: integer;
    size, n, at: longint;
    incomplete: boolean;
begin
  CSpecifiers(sp);
  if not sp.any then CErr0(ceType);
  if sym = tSemi then begin CNext; exit; end;
  repeat
    dN := 0; dHasName := false; dFar := sp.far;
    CDeclarator(false);
    if not dHasName then CErr0(ceDecl);
    if (dN > 0) and (dOps[dN].k = 4) then begin
      { a function declared in a block: only one declared already outside }
      s := CFindC(dName);
      if (s = 0) or (syms[s].kind <> skCFunc) then CErr(ceNotHere, dName);
    end else begin
      t := CApply(sp.t, 1, dN);
      case sp.storage of
        1: begin s := NewSym(dName, skType, t); end;
        2, 3: CGlobalVar(dName, t, sp.storage, true);
      else
        if t = tVoid then CErr0(ceVoid);
        incomplete := (types[t].form = fArr) and (types[t].hi < 0);
        if (types[t].form = fRec) and (types[t].hi and 1 = 0) then CErr0(ceIncomplete);
        s := NewSym(dName, skVar, t);
        syms[s].lev := 1;
        et := types[t].base;
        if incomplete then begin
          if sym <> tAssign then CErr0(ceArrSize);
          if cDeclIdx >= 512 then CErr0(ceNested);
          if not cDry then begin
            size := MemW[CDeclTab + cDeclIdx * 2];
            t := CArr(et, size div types[et].size);
            syms[s].typ := t;
            syms[s].adr := AllocLocal(size);
          end else syms[s].adr := AllocLocal(0);
        end else begin
          size := types[t].size;
          if size = 0 then size := 1;
          syms[s].adr := AllocLocal(size);
        end;
        if sym = tAssign then begin
          CNext;
          at := syms[s].adr;
          if (types[t].form in [fArr, fRec]) and ((sym = tLbrace) or (sym = sString)) and not incomplete then
            CZeroLocal(at, types[t].size)
          else if incomplete and not cDry and (sym = tLbrace) then CZeroLocal(at, types[t].size);
          n := CInitTop(t, false, at);
          if incomplete then begin
            if cDry then begin
              size := n * types[et].size;
              MemW[CDeclTab + cDeclIdx * 2] := size;
              at := AllocLocal(size);
            end;
            cDeclIdx := cDeclIdx + 1;
          end;
        end;
      end;
    end;
    if sym = tComma then CNext else break;
  until false;
  CExpect(tSemi);
end;

{ a function declared at the file's level }
function CDeclareFunc(const name: TName; ret: integer; par: longint; np, fl: integer; storage: byte): integer;
var s: integer;
begin
  s := CFindC(name);
  if s <> 0 then begin
    if syms[s].kind <> skCFunc then CErr(ceRedecl, name);
    if (syms[s].flags and cfNoProto <> 0) and (fl and cfNoProto = 0) then begin
      syms[s].first := par; syms[s].npar := np;
      syms[s].flags := (syms[s].flags and not cfNoProto) or (fl and cfVariadic);
    end;
    CDeclareFunc := s;
    exit;
  end;
  s := NewSym(name, skCFunc, ret);
  syms[s].lev := 0; syms[s].first := par; syms[s].npar := np;
  syms[s].flags := fl and (cfVariadic or cfNoProto);
  if storage = 3 then syms[s].flags := syms[s].flags or cfStatic;
  syms[s].adr := 0;
  CDeclareFunc := s;
end;

type
  TCScan = record
    base, pos, en: longint;
    ln, cl: integer;
    c: char;
    pend: integer;
    bol: boolean;
    depth, kind, mac, fdepth, cond: integer;
    pool, tmp: longint;
    tl, tc: integer;
  end;

procedure CSaveScan(var st: TCScan);
begin
  st.base := curBase; st.pos := srcPos; st.en := srcEnd; st.ln := line; st.cl := col; st.c := ch;
  st.pend := cPend; st.bol := cBol; st.depth := cDepth; st.kind := cKind; st.mac := cMac;
  st.fdepth := cFileDepth; st.cond := cCondN; st.pool := cPoolTop; st.tmp := cTmpTop;
  st.tl := tokLine; st.tc := tokCol;
end;

procedure CRestoreScan(var st: TCScan);
begin
  if (cDepth <> st.depth) or (cFileDepth <> st.fdepth) or (cCondN <> st.cond) then CErr0(ceFrame);
  curBase := st.base; srcPos := st.pos; srcEnd := st.en; line := st.ln; col := st.cl; ch := st.c;
  cPend := st.pend; cBol := st.bol; cKind := st.kind; cMac := st.mac;
  cPoolTop := st.pool; cTmpTop := st.tmp;
  tokLine := st.tl; tokCol := st.tc;
  sym := tLbrace;
end;

{ a function's body (sym is its opening brace); par / np: the parameters
  as the definition names them }
procedure CFuncDef(s: integer; par: longint; np: integer);
var st: TCScan;
    pass, i, p, mark, t0, p0: integer;
    pc0, d0, fs, entry, off: longint;
    pt: integer;
begin
  if syms[s].flags and cfDefined <> 0 then CErr(ceRedecl, syms[s].name);
  if cKind <> fkFile then CErr0(ceFrame);
  syms[s].first := par; syms[s].npar := np;
  CSaveScan(st);
  pc0 := pc; d0 := dataTop; mark := nSym; t0 := nType; p0 := cParTop;
  fs := 0;
  cMacSnap := false;
  for pass := 1 to 2 do begin
    cFirstPass := pass = 1;
    if pass = 2 then begin
      CMacRestore;
      CRestoreScan(st);
      pc := pc0; dataTop := d0; nSym := mark; nType := t0; cParTop := p0;
      for i := 0 to 63 do if impType[i] > t0 then impType[i] := 0;
    end;
    cDry := pass = 1;
    curLev := 1;
    ctxLoc[1] := 0; ctxFrozen[1] := false; ctxExit[1] := 0; ctxProc[1] := 0;
    defN[1] := 0; defPlaced[1] := false;
    if pass = 2 then ctxFS[1] := fs else ctxFS[1] := 0;
    cLoopN := 0; cSwN := 0; cCaseN := 0; cLabN := 0; cDeclIdx := 0; nTmp := 0;
    cRetT := syms[s].typ;
    cIsMain := syms[s].name = 'main';
    { the parameters: the first one next to the frame }
    off := 0;
    if types[cRetT].form = fRec then if rv then off := 4 else off := 2;
    for i := 0 to np - 1 do begin
      pt := CParType(par + i);
      p := NewSym(CParName(par + i), skVar, pt);
      syms[p].lev := 1; syms[p].isPar := true; syms[p].adr := off;
      syms[p].isRef := types[pt].form = fRec;
      if rv or ((types[pt].size > 2) and not syms[p].isRef) then off := off + 4 else off := off + 2;
    end;
    entry := pc;
    if pass = 2 then begin
      if (syms[s].flags and cfLib = 0) and (syms[s].adr <> 0) then FixCalls(syms[s].adr, cBase + entry);
      syms[s].adr := cBase + entry;
      syms[s].flags := (syms[s].flags or cfDefined) and not cfLib;
    end;
    { the entry }
    if rv then begin
      RI($13, 0, rSp, rSp, -8); RSt(4, rRa, rSp, 4); RSt(4, rS0, rSp, 0);
      RAddi(rSp, rSp, -fs); RMv(rS0, rSp);
    end else begin
      Gen($0B); Gen($3B);                                   { phd / tsc }
      if fs > 0 then begin Gen($38); Op16($E9, fs); Gen($1B); end;
      Gen($5B);                                             { tcd }
    end;
    lastDbg := -1;
    CCompound;
    if cIsMain then LdaImm(0);
    FixChain(ctxExit[1], pc);
    CEndLabels;
    { the exit: the result stays in A (A/X; a0) }
    if rv then begin
      RAddi(rSp, rS0, fs);
      RLd(4, false, rS0, rSp, 0); RLd(4, false, rRa, rSp, 4); RI($13, 0, rSp, rSp, 8);
      RRet;
    end else begin
      Gen($A8);                                             { tay }
      if fs > 0 then begin Gen($7B); Gen($18); Op16($69, fs); Gen($1B); end;
      Gen($2B); Gen($98); Gen($6B);                         { pld / tya / rtl }
    end;
    if pass = 1 then begin
      fs := ctxLoc[1];
      if rv then fs := (fs + 3) and not longint(3);
    end;
  end;
  cDry := false; cFirstPass := false;
  nSym := mark; nType := t0; cParTop := p0;
  for i := 0 to 63 do if impType[i] > t0 then impType[i] := 0;
  curLev := 0;
end;

{ a declaration at the file's level, or a function's definition }
procedure CExternalDecl;
var sp: TCSpec;
    s, t, ret: integer;
    par: longint;
    np, fl: integer;
begin
  if sym = tSemi then begin CNext; exit; end;
  CSpecifiers(sp);
  if not sp.any then CErr0(ceDecl);
  if sym = tSemi then begin CNext; exit; end;
  repeat
    dN := 0; dHasName := false; dFar := sp.far;
    CDeclarator(false);
    if not dHasName then CErr0(ceDecl);
    if (dN > 0) and (dOps[dN].k = 4) and (sp.storage <> 1) then begin
      ret := CApply(sp.t, 1, dN - 1);
      par := dOps[dN].v; np := dOps[dN].f and 255; fl := dOps[dN].f shr 8;
      s := CDeclareFunc(dName, ret, par, np, fl, sp.storage);
      if sym = tLbrace then begin
        CFuncDef(s, par, np);
        exit;
      end;
    end else begin
      t := CApply(sp.t, 1, dN);
      if sp.storage = 1 then s := NewSym(dName, skType, t)
      else CGlobalVar(dName, t, sp.storage, false);
    end;
    if sym = tComma then CNext else break;
  until false;
  CExpect(tSemi);
end;

{ ---------------------------------------------------------------- the program }
{ the text is C: NAME.C }
function IsCText(const fileName: string): boolean;
var n: integer;
begin
  n := length(fileName);
  IsCText := (n >= 2) and (fileName[n - 1] = '.') and (UpCase(fileName[n]) = 'C');
end;

{ #pragma schub as the first line: compiled for SCHUB }
function CSchubPragma(n: longint): boolean;
var p: longint;
    i: integer;
    t: string[13];
begin
  CSchubPragma := false;
  p := 0;
  while (p < n) and (Mem[SrcBase + p] <= 32) do p := p + 1;
  if p + 13 > n then exit;
  for i := 1 to 13 do t[i] := LoCase(chr(Mem[SrcBase + p + i - 1]));
  t[0] := chr(13);
  CSchubPragma := t = '#pragma schub';
end;

function CompileC(srcLen: longint; const name: string): boolean;
var mainFix, lenAt, heapAt, a, argv, stub: longint;
    i, s, e, nb: integer;
    x: TItem;
begin
  CompileC := false;
  ErrMsg := ''; ErrUnit := ''; curFile := '';
  ErrLine := 0; ErrCol := 0;
  nUnit := 0; nInit := 0; unitTop := $220000; inInterface := false;
  if not CartPresent then begin ErrMsg := 'PASCAL cartridge directory missing'; exit; end;
  msgsBuilt := false; BuildMessages;
  if CatchError <> 0 then begin cDry := false; exit; end;
  rv := WantSchub or CSchubPragma(srcLen);
  IsSchub := rv;
  cHdrBase := Far24($400060); cMsgBase := Far24($400063); cKwBase := Far24($400066); cUnitBase := Far24($400069);
  cMainName := name;
  for i := 1 to length(cMainName) do cMainName[i] := LoCase(cMainName[i]);
  nDef := 0; condDepth := 0; incDepth := 0;
  swR := false; swQ := false; swI := true; swD := true;
  if rv then begin cBase := RvCode; RunEntry := RvStub; end
  else begin cBase := CodeBase; RunEntry := CodeBase; end;
  pc := 0; pushAt := -1; dataTop := 0; nLoop := 0; nTmp := 0; nPend := 0; nWith := 0;
  lastDbg := -1; curUnit := 0;
  nLab := 0; labStart := 0; nFix := 0; stkSlots := 0; preLabels := 0;
  wantProc := 0; procAny := 0; nObj := 0;
  hasWith := false;
  for i := 0 to 63 do impType[i] := 0;
  InitTypes;
  curLev := 0;
  nSym := 0;
  InitRuntime;
  if not rv then begin cDiv32u := RtAdr('rt_div32u'); cMod32u := RtAdr('rt_mod32u'); end;
  if rv then dataOrg := RvData else dataOrg := UserData;
  ExitIntSyms;
  ctxLoc[0] := 0; ctxFrozen[0] := false; ctxProc[0] := 0; ctxExit[0] := 0; ctxFS[0] := 0;
  { C's own state }
  tVoid := tUntyped;
  tCBool := NewType(fInt, 1); types[tCBool].lo := 0; types[tCBool].hi := 1;
  cCharPtr := CPtr(tByte, false);
  cParTop := 0; cDry := false; cFirstPass := false; cMacSnap := false;
  cUnits := 1;
  ZeroMem(MacHash, 512);
  cMacros := 0; cBodyTop := MacBody;
  cPoolTop := CPoolBase; cTmpTop := CTmpBase;
  cDepth := 0; cBarrier := 0; cFileDepth := 0; cKind := fkFile; cMac := 0; cPend := -1;
  cBol := true; cPP := false; cNoMacros := false; cCondN := 0;
  cLoopN := 0; cSwN := 0; cCaseN := 0; cLabN := 0;
  if rv then MacDefine('__SCHUB__', '1');
  { entry code (as for Pascal) }
  if rv then begin
    RPush(rRa);
    RLi(rS1, RvTmpTop);
    if DebugLines then RLi(3, DbgLineAdr);
    W32(0); W32(0); mainFix := pc - 8;
    DbgEnd;
    RPop(rRa);
    RRet;
  end else begin
    Gen($8B); Gen($0B); Gen($08);
    Op8($C2, $30);
    Gen($4B); Gen($62); endFix := pc; Gen16(0);
    Gen($8B); Gen($0B); Gen($08);
    Gen($3B); StaAbs(aSavesp);
    LdaImm(UserStack); Gen($1B);
    LdaImm(0); Gen($5B);
    Gen($8B);
    LdxImm(0); LdaImm(UserData); Gen($A8);
    Gen($A9); lenAt := pc; Gen16(0);
    Op8($54, $00); Gen($32);
    Gen($AB);
    Gen($A9); heapAt := pc; Gen16(0);
    StaAbs(aHeapbase);
    LdaImm(StrStackTop); StaAbs(aStp);
    if DebugHooks then begin LdaImm(0); Op24($8F, DbgLineAdr + 24); end;
    Jsl(aLibinit);
    intFix := pc; Gen($EA); Gen($EA); Gen($EA); Gen($EA);
    Gen($22); mainFix := pc; Gen24(0);
    DbgEnd;
    Op24($5C, aExit);
  end;
  { the text: the predefined macros first }
  curBase := SrcBase; srcPos := 0; srcEnd := srcLen; line := 1; col := 0;
  tokLine := 1; tokCol := 1;
  ch := #10;
  CIncludeFile('_PREDEF.H', true);
  x.a := AllocData(2);
  CNext;
  while sym <> sEOF do CExternalDecl;
  if cCondN <> 0 then CErr0(ceNoEndif);
  { functions called but not defined: the C library's }
  for i := 1 to nSym do
    if (syms[i].kind = skCFunc) and (syms[i].flags and (cfDefined or cfLib) = 0) and (syms[i].adr <> 0) then begin
      e := CLibFind(syms[i].name);
      if (e < 0) or (Mem[ExpBase + longint(e) * 40 + 20] <> 7) then CErr(ceUndefFunc, syms[i].name);
      FixCalls(syms[i].adr, ExpValue(e));
      syms[i].adr := ExpValue(e);
      syms[i].flags := syms[i].flags or cfLib;
    end;
  s := CFindC('main');
  if (s = 0) or (syms[s].kind <> skCFunc) or (syms[s].flags and cfDefined = 0) then CErr0(ceNoMain);
  { the start: main(1, ["MAIN", 0]), its result the exit code }
  stub := pc;
  nb := 0;
  if rv then RPush(rRa);
  if syms[s].npar >= 2 then begin
    a := AllocData(5);
    Mem[DataImg + a - dataOrg] := ord('M'); Mem[DataImg + a - dataOrg + 1] := ord('A');
    Mem[DataImg + a - dataOrg + 2] := ord('I'); Mem[DataImg + a - dataOrg + 3] := ord('N');
    argv := AllocData(2 * PtrSz);
    CPutConst(DataImg + argv - dataOrg, cCharPtr, a);
    if rv then begin RLi(rT1, argv); RPush(rT1); RLi(rT1, 1); RPush(rT1); nb := 8; end
    else begin PeaW(argv); PeaW(1); nb := 4; end;
  end;
  Jsl(syms[s].adr);
  PopBytes(nb);
  if (syms[s].typ <> tVoid) and IsInt(syms[s].typ) then begin
    e := Find('exitcode');
    if (e <> 0) and (syms[e].kind = skVar) then begin
      if rv then RStAbs(2, rA0, syms[e].adr) else StaAbs(syms[e].adr);
    end;
  end;
  if rv then begin RPop(rRa); RRet; end else Gen($6B);
  if rv then begin
    Put32(mainFix, LuiEnc(rT0, cBase + stub)); Put32(mainFix + 4, IEnc($67, 0, rRa, rT0, cBase + stub));
  end else begin
    Put16(mainFix, stub); Mem[cBase + mainFix + 2] := $30;
  end;
  if not rv then begin
    ProgramEnd;
    if usesInt then IntCode;
  end;
  if not rv then begin
    Put16(lenAt, dataTop - 1);
    Put16(heapAt, UserData + dataTop);
  end;
  CodeSize := pc;
  DataSize := dataTop;
  LinesDone := line;
  CompileC := true;
end;
