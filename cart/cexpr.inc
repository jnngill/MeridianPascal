{ MERIDIAN C on the MERIDIAN - part 3: expressions (included by ccomp.inc).

  Expressions are items as in the Pascal compiler; its routines load,
  store and branch. C's own rules are here: the usual arithmetic
  conversions (unsigned wins at the same size), signed shifts to the right,
  pointer arithmetic, conditions from any scalar. Calls push the
  arguments from the first to the last, then turn them around on the
  stack: the callee finds the first one next to its return address, as the
  PC compiler's C does. }

const
  mTInd = 13;       { an address in a frame slot (a = offset, fj = the slot's dp) }
  mTFar = 14;       { a 24-bit address in a frame slot }

var
  cDry: boolean;              { the first pass over a function, or sizeof: no call chains }
  cDiv32u, cMod32u: longint;

  cCharPtr: integer;
  cRetT: integer;             { the current function's result }
  cHidDp: integer;            { its hidden result pointer's parameter offset (-1: none) }
  cIsMain: boolean;

procedure CExpr(var x: TItem); forward;
procedure CAssignExpr(var x: TItem); forward;
procedure CUnary(var x: TItem); forward;
procedure CCondExpr(var x: TItem); forward;

{ ---------------------------------------------------------------- items }
procedure CConstOf(var x: TItem; v: longint; t: integer);
begin
  if types[t].form <> fReal then
    if types[t].size = 1 then begin
      v := v and 255;
      if CIsSigned(t) and (v > 127) then v := v - 256;
    end else if types[t].size = 2 then begin
      v := v and $FFFF;
      if CIsSigned(t) and (v > 32767) then v := v - 65536;
    end;
  MakeConst(x, v, t);
end;

{ a frame offset beyond the direct page (65C816) }
function CBigLoc(var x: TItem): boolean;
begin
  CBigLoc := not rv and (x.mode = mLoc) and (x.a + types[x.typ].size > 255);
end;

procedure CNormBig(var x: TItem);
begin
  if CBigLoc(x) then begin LoadAdr(x); x.mode := mInd; x.a := 0; end;
end;

{ the value of a scalar into A (A/X) }
procedure CLoad(var x: TItem);
begin
  CNormBig(x);
  Load(x);
end;

{ A (A/X) into the variable x }
procedure CStore(var x: TItem);
var sz: integer;
begin
  sz := types[x.typ].size;
  if CBigLoc(x) then begin
    StaAbs(aT0); if sz = 4 then Op16($8E, aT0 + 2);
    Gen($7B); Gen($18); Op16($69, x.a); Gen($AA);          { tdc clc adc tax }
    if sz = 4 then begin LdaAbs(aT0 + 2); Op16($9D, 2); end;
    LdaAbs(aT0);
    if sz = 1 then begin Sep; Op16($9D, 0); Rep; end else Op16($9D, 0);
    exit;
  end;
  Store(x);
end;

{ a 24-bit address in A/X (a0): + n }
procedure CFarAdd(n: longint);
begin
  if n = 0 then exit;
  if rv then RAddi(rA0, rA0, n)
  else begin
    Gen($18); Op16($69, n and $FFFF); Gen($A8);             { clc adc tay }
    Gen($8A); Op16($69, (n shr 16) and $FFFF); Gen($AA); Gen($98);   { txa adc tax tya }
  end;
end;

{ the address of an lvalue item into A (A/X for far ones; a0) }
procedure CLoadAdr(var x: TItem);
begin
  case x.mode of
    mFar: begin CFarAdd(x.a); x.mode := mReg; x.a := 0; end;
    mFarC: begin MakeConst(x, x.a, x.typ); Load(x); end;
    mStk: begin
      if rv then begin RPop(rA0); RAddi(rA0, rA0, x.a); end
      else begin Gen($68); if x.a <> 0 then begin Gen($18); Op16($69, x.a); end; end;
      x.mode := mReg; x.a := 0;
    end;
  else
    LoadAdr(x);
  end;
end;

function CFnTypeOf(s: integer): integer;
var i: integer;
begin
  for i := nType downto 15 do
    if (types[i].form = fCFn) and (types[i].base = syms[s].typ) and (types[i].fields = syms[s].first) and
       (types[i].lo = syms[s].npar) then begin CFnTypeOf := i; exit; end;
  CFnTypeOf := CFnType(syms[s].typ, syms[s].first, syms[s].npar + 256 * (syms[s].flags and (cfVariadic or cfNoProto)));
end;

{ a C function the text declares but does not define: the C library's }
function CBindLib(s: integer): boolean;
var e: integer;
begin
  CBindLib := false;
  if syms[s].flags and (cfDefined or cfLib) <> 0 then begin CBindLib := true; exit; end;
  if syms[s].adr <> 0 then exit;          { calls are chained already }
  e := CLibFind(syms[s].name);
  if (e < 0) or (Mem[ExpBase + longint(e) * 40 + 20] <> 7) then exit;
  syms[s].adr := ExpValue(e);
  syms[s].flags := syms[s].flags or cfLib;
  CBindLib := true;
end;

{ arrays and functions as pointers; a far frame variable as an address }
procedure CDecay(var x: TItem);
var t, s: integer;
    far: boolean;
begin
  if x.mode = mFn then begin
    s := x.a;
    if not CBindLib(s) then begin
      if not cDry then CErr(ceFuncAddr, syms[s].name);
      MakeConst(x, 0, CPtr(CFnTypeOf(s), false));
      exit;
    end;
    MakeConst(x, syms[s].adr, CPtr(CFnTypeOf(s), false));
    exit;
  end;
  if x.mode = mPfn then CErr(ceNotHere, syms[x.a].name);
  if types[x.typ].form <> fArr then begin CNormBig(x); exit; end;
  far := x.mode in [mFar, mFarC];
  t := CPtr(types[x.typ].base, far);
  case x.mode of
    mGlob, mFarC: x.mode := mConst;
    mConst: ;
  else
    CLoadAdr(x);
  end;
  x.typ := t;
end;

{ an rvalue in A (A/X; a0): constants stay constants }
procedure CValue(var x: TItem);
begin
  CDecay(x);
  if x.mode = mCond then begin LoadBool(x); x.typ := tInteger; exit; end;
  if types[x.typ].form = fRec then exit;
  if x.typ = tVoid then CErr0(ceVoid);
  if x.mode <> mConst then Load(x);
end;

procedure CLoadV(var x: TItem);
begin
  CValue(x);
  if (x.mode = mConst) and (types[x.typ].form <> fRec) then Load(x);
end;

{ the left operand of a binary operation: a constant, or pushed }
procedure CPushV(var x: TItem);
begin
  CDecay(x);
  if x.mode = mCond then begin LoadBool(x); x.typ := tInteger; end;
  if types[x.typ].form = fRec then CErr0(ceNotScalar);
  if x.typ = tVoid then CErr0(ceVoid);
  Push(x);
end;

{ any scalar as a condition (an mCond item of type boolean) }
procedure CCondOf(var x: TItem);
var sz: integer;
begin
  CDecay(x);
  if (x.typ = tBool) and (x.mode = mCond) then exit;
  if not CIsScalar(x.typ) then CErr0(ceNotScalar);
  if x.mode = mConst then begin
    if IsReal(x.typ) then x.a := ord(x.a and $7FFFFFFF <> 0) else x.a := ord(x.a <> 0);
    x.typ := tBool;
    exit;
  end;
  sz := types[x.typ].size;
  Load(x);
  if rv then begin
    if IsReal(x.typ) then RSlli(rA0, rA0, 1);
  end else if sz = 4 then begin
    Op16($8E, aT0);                            { stx t0 }
    if IsReal(x.typ) then Op16($0E, aT0);      { asl t0: not the sign }
    Op16($0D, aT0);                            { ora t0 }
  end else Op16($C9, 0);                       { cmp #0 }
  x.mode := mCond; x.a := cNe; x.tj := 0; x.fj := 0; x.typ := tBool;
end;

{ an expression whose value is not used }
procedure CDiscard(var x: TItem);
begin
  if x.mode = mCond then begin FixChain(x.tj, pc); FixChain(x.fj, pc); end;
  x.mode := mReg;
end;

{ ---------------------------------------------------------------- conversions }
function CIntOfSize(sz: integer; sg: boolean): integer;
begin
  if sz = 4 then begin if sg then CIntOfSize := tLong else CIntOfSize := tLongW; end
  else if sg then CIntOfSize := tInteger else CIntOfSize := tWord;
end;

{ y as a value of type t: loaded (a constant stays one) }
procedure CConvTo(var y: TItem; t: integer);
var u: TRealBits;
    f: integer;
begin
  CDecay(y);
  if y.mode = mCond then begin LoadBool(y); y.typ := tInteger; end;
  if t = tVoid then begin y.typ := tVoid; exit; end;
  f := types[t].form;
  if f = fRec then begin
    if (types[y.typ].form <> fRec) or (types[y.typ].size <> types[t].size) then CErr0(ceConv);
    exit;
  end;
  if y.typ = tVoid then CErr0(ceVoid);
  if not CIsScalar(y.typ) then CErr0(ceConv);
  if f = fReal then begin
    if IsReal(y.typ) then begin if y.mode <> mConst then Load(y); exit; end;
    if y.mode = mConst then begin y.a := IntToRealBits(y.a); y.typ := tReal; exit; end;
    if y.typ = tLongW then begin
      Load(y); PushA(4); LibCallPop('_cardtoreal');
      y.mode := mReg; y.typ := tReal; exit;
    end;
    y.typ := CPromote(y.typ);
    LoadReal(y);
    exit;
  end;
  if IsReal(y.typ) then begin
    if y.mode = mConst then begin
      u.l := y.a;
      CConstOf(y, Trunc(u.r), tLong);
    end else begin
      Load(y); PushA(4); LibCallPop('_truncreal');
      y.mode := mReg; y.typ := tLong;
    end;
  end;
  if t = tCBool then begin
    CCondOf(y);
    if y.mode <> mConst then LoadBool(y);
    y.typ := t;
    exit;
  end;
  if types[y.typ].form in [fChar, fBool, fEnum] then y.typ := CPromote(y.typ);
  if y.mode = mConst then begin CConstOf(y, y.a, t); exit; end;
  Cast(y, t);
  if y.mode <> mReg then Load(y);
end;

{ ---------------------------------------------------------------- arithmetic }
function CPow2(v: longint): integer;
var n: integer;
begin
  CPow2 := -1;
  if (v <= 0) or (v and (v - 1) <> 0) then exit;
  n := 0;
  while (v shr n) and 1 = 0 do n := n + 1;
  CPow2 := n;
end;

function CWrap(v: longint; t: integer): longint;
var x: TItem;
begin
  CConstOf(x, v, t);
  CWrap := x.a;
end;

function CFold(op: integer; a, b: longint; t: integer): longint;
var r: longint;
begin
  a := CWrap(a, t); b := CWrap(b, t);
  r := 0;
  case op of
    sPlus: r := a + b;
    sMinus: r := a - b;
    sTimes: r := a * b;
    sDiv: begin if b = 0 then CErr0(ceDivZero); r := a div b; end;
    sMod: begin if b = 0 then CErr0(ceDivZero); r := a mod b; end;
    sAnd: r := a and b;
    sOr: r := a or b;
    sXor: r := a xor b;
    sShl: r := a shl (b and 31);
    sShr: if CIsSigned(t) and (a < 0) then r := not ((not a) shr (b and 31))
          else if types[t].size = 2 then r := (a and $FFFF) shr (b and 31)
          else r := a shr (b and 31);
  end;
  CFold := CWrap(r, t);
end;

{ a constant real operation the library would stop at (an overflow, an
  infinity or a NaN): its IEEE result in r; false: an ordinary one }
function CRealSafe(op: integer; a, b: longint; var r: longint): boolean;
var ea, eb, sa, sb, inf, nan: longint;
begin
  CRealSafe := true;
  inf := $7F800000; nan := $7FC00000;
  if op = sMinus then begin b := b xor longint($80000000); op := sPlus; end;
  ea := (a shr 23) and 255; eb := (b shr 23) and 255;
  sa := a and longint($80000000); sb := b and longint($80000000);
  if (ea = 255) or (eb = 255) then begin
    if ((ea = 255) and (a and $7FFFFF <> 0)) or ((eb = 255) and (b and $7FFFFF <> 0)) then r := nan
    else case op of
      sPlus: if (ea = 255) and (eb = 255) and (sa <> sb) then r := nan else if ea = 255 then r := a else r := b;
      sTimes: if (a and $7FFFFFFF = 0) or (b and $7FFFFFFF = 0) then r := nan else r := inf or (sa xor sb);
      sSlash: if (ea = 255) and (eb = 255) then r := nan
              else if ea = 255 then r := inf or (sa xor sb) else r := sa xor sb;
    end;
    exit;
  end;
  if (op = sTimes) and (ea <> 0) and (eb <> 0) and (ea + eb - 127 >= 254) then begin r := inf or (sa xor sb); exit; end;
  if op = sSlash then begin
    if b and $7FFFFFFF = 0 then begin
      if a and $7FFFFFFF = 0 then r := nan else r := inf or (sa xor sb);
      exit;
    end;
    if (ea <> 0) and (ea - eb + 127 >= 254) then begin r := inf or (sa xor sb); exit; end;
  end;
  if (op = sPlus) and (ea >= 254) and (eb >= 254) and (sa = sb) then begin r := inf or sa; exit; end;
  CRealSafe := false;
end;

{ 65C816: A signed, shifted right by X (or by n, n >= 0) }
procedure CSar16(n: integer);
var i: integer;
begin
  if n >= 0 then begin
    n := n and 15;
    for i := 1 to n do begin Op16($C9, $8000); Gen($6A); end;     { cmp #$8000 / ror a }
    exit;
  end;
  Op16($E0, 0); Op8($F0, 7);                                       { cpx #0 / beq done }
  Op16($C9, $8000); Gen($6A); Gen($CA); Op8($D0, $F9);             { cmp / ror / dex / bne }
end;

{ 65C816: rt_a signed, shifted right by rt_b (or by n); A/X the result }
procedure CSar32(n: integer);
begin
  if n = 0 then begin LdaAbs(aA); Op16($AE, aA + 2); exit; end;
  if n > 0 then LdxImm(n and 31)
  else begin Op16($AE, aB); Op8($F0, 15); end;                     { ldx rt_b / beq done }
  LdaAbs(aA + 2); Op16($C9, $8000);                                { the sign into C }
  Op16($6E, aA + 2); Op16($6E, aA);                                { ror ror }
  Gen($CA); Op8($D0, $F1);                                         { dex / bne }
  LdaAbs(aA); Op16($AE, aA + 2);
end;

{ x op y: x pushed or a constant, y any value; t the type of the operation }
procedure CIntOp(op: integer; var x, y: TItem; t: integer);
var sg, long: boolean;
    n, i: integer;
begin
  sg := CIsSigned(t);
  long := types[t].size = 4;
  if rv then begin
    if x.mode = mConst then begin CLoad(y); RLi(rA1, x.a); end
    else if y.mode = mConst then begin RPop(rA1); RLi(rA0, y.a); end
    else begin CLoad(y); RPop(rA1); end;
    if not long and (op in [sDiv, sMod, sShr]) then begin
      RNormSz(rA1, 2, sg);
      if op <> sShr then RNormSz(rA0, 2, sg);
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
        if op = sDiv then begin if sg then RR(1, 4, rA0, rA1, rA0) else RR(1, 5, rA0, rA1, rA0); end
        else begin if sg then RR(1, 6, rA0, rA1, rA0) else RR(1, 7, rA0, rA1, rA0); end;
      end;
      sShl: RR(0, 1, rA0, rA1, rA0);
      sShr: if sg then RR($20, 5, rA0, rA1, rA0) else RR(0, 5, rA0, rA1, rA0);
    end;
    if not long then RNormSz(rA0, 2, sg);
    x.mode := mReg; x.typ := t;
    exit;
  end;
  if long then begin
    CNormBig(y);
    ToAB(x, y);
    case op of
      sPlus, sMinus, sAnd, sOr, sXor: begin
        case op of
          sPlus: n := $6D; sMinus: n := $ED; sAnd: n := $2D; sOr: n := $0D; sXor: n := $4D;
        end;
        LdaAbs(aA);
        if op = sPlus then Gen($18) else if op = sMinus then Gen($38);
        Op16(n, aB); Gen($A8);
        LdaAbs(aA + 2); Op16(n, aB + 2);
        Gen($AA); Gen($98);
      end;
      sTimes:
        if (y.mode = mConst) and (CPow2(y.a) >= 0) then ShiftConstAB(true, CPow2(y.a))
        else if (y.mode = mConst) and MulConstOk(y.a) then MulConstAB(y.a)
        else Jsl(aMul32);
      sDiv: if sg then Jsl(aDiv32s) else Jsl(cDiv32u);
      sMod: if sg then Jsl(aMod32s) else Jsl(cMod32u);
      sShl: if y.mode = mConst then ShiftConstAB(true, y.a) else Jsl(aShl32);
      sShr: if sg then begin if y.mode = mConst then CSar32(y.a and 31) else CSar32(-1); end
            else if y.mode = mConst then ShiftConstAB(false, y.a) else Jsl(aShr32);
    end;
    x.mode := mReg; x.typ := t;
    exit;
  end;
  if x.mode = mConst then begin
    CLoad(y);
    case op of
      sPlus: begin Gen($18); Op16($69, x.a); end;
      sMinus: begin Op16($49, $FFFF); Gen($38); Op16($69, x.a); end;
      sAnd: Op16($29, x.a);
      sOr: Op16($09, x.a);
      sXor: Op16($49, x.a);
      sTimes: MulConstA(x.a);
      sDiv, sMod, sShl, sShr: begin
        Gen($AA); LdaImm(x.a);
        case op of
          sDiv: if sg then Jsl(aDiv16s) else Jsl(aDiv16u);
          sMod: if sg then Jsl(aMod16s) else Jsl(aMod16u);
          sShl: Jsl(aShl16);
          sShr: if sg then CSar16(-1) else Jsl(aShr16);
        end;
      end;
    end;
  end else if y.mode = mConst then begin
    if not UnPush then Gen($68);
    case op of
      sPlus: if y.a = 1 then Gen($1A) else begin Gen($18); Op16($69, y.a); end;
      sMinus: if y.a = 1 then Gen($3A) else begin Gen($38); Op16($E9, y.a); end;
      sAnd: Op16($29, y.a);
      sOr: Op16($09, y.a);
      sXor: Op16($49, y.a);
      sTimes: MulConstA(y.a);
      sDiv: begin LdxImm(y.a); if sg then Jsl(aDiv16s) else Jsl(aDiv16u); end;
      sMod: begin LdxImm(y.a); if sg then Jsl(aMod16s) else Jsl(aMod16u); end;
      sShl: begin n := y.a and 15; for i := 1 to n do Gen($0A); end;
      sShr: if sg then CSar16(y.a) else begin n := y.a and 15; for i := 1 to n do Gen($4A); end;
    end;
  end else if (op in [sPlus, sMinus, sAnd, sOr, sXor]) and PlainY(y) and UnPush then begin
    case op of
      sPlus: begin Gen($18); OpY($69, $6D, $65, y); end;
      sMinus: begin Gen($38); OpY($E9, $ED, $E5, y); end;
      sAnd: OpY($29, $2D, $25, y);
      sOr: OpY($09, $0D, $05, y);
      sXor: OpY($49, $4D, $45, y);
    end;
  end else begin
    CLoad(y);
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
      sShr: begin Gen($AA); Gen($68); if sg then CSar16(-1) else Jsl(aShr16); end;
    end;
  end;
  x.mode := mReg; x.typ := t;
end;

{ x op y with C's conversions; x pushed (CPushV) or a constant }
procedure CArith(op: integer; var x, y: TItem);
var t: integer;
    r: longint;
begin
  CDecay(y);
  if y.mode = mCond then begin LoadBool(y); y.typ := tInteger; end;
  if not CIsArith(x.typ) or not CIsArith(y.typ) then CErr0(ceConv);
  if op in [sShl, sShr] then t := CPromote(x.typ) else t := CArithType(x.typ, y.typ);
  if t = tReal then begin
    if op = sDiv then op := sSlash;
    if not (op in [sPlus, sMinus, sTimes, sSlash]) then CErr0(ceConv);
    if not IsReal(y.typ) then y.typ := CPromote(y.typ);
    if not IsReal(x.typ) then x.typ := CPromote(x.typ);
    if (x.mode = mConst) and (y.mode = mConst) then begin
      if not IsReal(x.typ) then x.a := IntToRealBits(x.a);
      if not IsReal(y.typ) then y.a := IntToRealBits(y.a);
      if CRealSafe(op, x.a, y.a, r) then begin MakeConst(x, r, tReal); exit; end;
      MakeConst(x, RealFold(op, x.a, y.a), tReal);
      exit;
    end;
    CNormBig(y);
    RealArith(op, x, y);
    exit;
  end;
  if types[x.typ].form <> fInt then x.typ := CPromote(x.typ);
  if types[y.typ].form <> fInt then y.typ := CPromote(y.typ);
  if (x.mode = mConst) and (y.mode = mConst) then begin
    CConstOf(x, CFold(op, x.a, y.a, t), t);
    exit;
  end;
  CIntOp(op, x, y, t);
end;

{ ---------------------------------------------------------------- comparisons }
procedure CRel(op: integer; var x, y: TItem);
var c, r: integer;
    t: integer;
    sg: boolean;
    xa, ya: longint;
begin
  CDecay(y);
  if y.mode = mCond then begin LoadBool(y); y.typ := tInteger; end;
  case op of
    tEq: c := cEq; tNe: c := cNe; tLt: c := cLt; tLe: c := cLe; tGt: c := cGt; tGe: c := cGe;
  end;
  if CIsPtr(x.typ) or CIsPtr(y.typ) then begin
    if CIsPtr(x.typ) then t := CIntOfSize(types[x.typ].size, false) else t := CIntOfSize(types[y.typ].size, false);
    if CIsPtr(x.typ) then x.typ := CIntOfSize(types[x.typ].size, false);
    if CIsPtr(y.typ) then y.typ := CIntOfSize(types[y.typ].size, false);
  end else begin
    if not CIsArith(x.typ) or not CIsArith(y.typ) then CErr0(ceConv);
    t := CArithType(x.typ, y.typ);
  end;
  if t = tReal then begin
    if not IsReal(y.typ) then y.typ := CPromote(y.typ);
    if not IsReal(x.typ) then x.typ := CPromote(x.typ);
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
    CNormBig(y);
    PushReals(x, y);
    LibCallPop('_cmpreal');
    if rv then begin RSetCmp(c, true, rA0, rZero); CondResult(x, cNe); exit; end;
    Op16($49, $8000); Op16($C9, $8000);
    CondResult(x, c);
    exit;
  end;
  if types[x.typ].form <> fInt then x.typ := CPromote(x.typ);
  if types[y.typ].form <> fInt then y.typ := CPromote(y.typ);
  sg := CIsSigned(t);
  if (x.mode = mConst) and (y.mode = mConst) then begin
    xa := CWrap(x.a, t); ya := CWrap(y.a, t);
    if not sg and (types[t].size = 4) then begin xa := xa xor longint($80000000); ya := ya xor longint($80000000); end;
    case c of
      cEq: x.a := ord(xa = ya); cNe: x.a := ord(xa <> ya); cLt: x.a := ord(xa < ya);
      cLe: x.a := ord(xa <= ya); cGt: x.a := ord(xa > ya); cGe: x.a := ord(xa >= ya);
    end;
    x.typ := tBool;
    exit;
  end;
  if rv then begin
    if x.mode = mConst then begin CLoad(y); RLi(rA1, x.a); end
    else if y.mode = mConst then begin RPop(rA1); RLi(rA0, y.a); end
    else begin CLoad(y); RPop(rA1); end;
    if types[t].size < 4 then begin RNormSz(rA0, 2, sg); RNormSz(rA1, 2, sg); end;
    RSetCmp(c, sg, rA1, rA0);
    CondResult(x, cNe);
    exit;
  end;
  if types[t].size = 4 then begin
    CNormBig(y);
    ToAB(x, y);
    case c of
      cEq, cNe: begin
        LdaAbs(aA); Op16($CD, aB); Op8($D0, 6);
        LdaAbs(aA + 2); Op16($CD, aB + 2);
        CondResult(x, c);
      end;
      cLt, cGe: begin
        LdaAbs(aA); Op16($CD, aB); LdaAbs(aA + 2); Op16($ED, aB + 2);
        if sg then begin Op8($50, 3); Op16($49, $8000); CondResult(x, c + 10); end
        else CondResult(x, c);
      end;
      cGt, cLe: begin
        LdaAbs(aB); Op16($CD, aA); LdaAbs(aB + 2); Op16($ED, aA + 2);
        if sg then begin
          Op8($50, 3); Op16($49, $8000);
          if c = cGt then CondResult(x, cLt + 10) else CondResult(x, cGe + 10);
        end else if c = cGt then CondResult(x, cLt) else CondResult(x, cGe);
      end;
    end;
    exit;
  end;
  if x.mode = mConst then begin
    CLoad(y);
    if sg then begin Op16($49, $8000); Op16($C9, (x.a xor $8000) and $FFFF); end
    else Op16($C9, x.a and $FFFF);
    case c of
      cLt: c := cGt; cGt: c := cLt; cLe: c := cGe; cGe: c := cLe;
    end;
  end else if y.mode = mConst then begin
    if not UnPush then Gen($68);
    if sg then begin Op16($49, $8000); Op16($C9, (y.a xor $8000) and $FFFF); end
    else Op16($C9, y.a and $FFFF);
  end else if not sg and PlainY(y) and UnPush then begin
    OpY($C9, $CD, $C5, y);
  end else begin
    CLoad(y);
    if sg then Op16($49, $8000);
    StaAbs(aT0);
    Gen($68);
    if sg then Op16($49, $8000);
    Op16($CD, aT0);
  end;
  CondResult(x, c);
end;

{ ---------------------------------------------------------------- pointers }
{ y (an integer) times n, as an integer of sz bytes (the size of the pointer) }
procedure CScale(var y: TItem; n: longint; sz: integer);
var k: integer;
begin
  CDecay(y);
  if y.mode = mCond then begin LoadBool(y); y.typ := tInteger; end;
  if not CIsInt(y.typ) then CErr0(ceConv);
  if y.mode = mConst then begin CConstOf(y, y.a * n, CIntOfSize(sz, true)); exit; end;
  CConvTo(y, CIntOfSize(sz, CIsSigned(CPromote(y.typ)) or (types[y.typ].size < 2)));
  y.typ := CIntOfSize(sz, true);
  if n = 1 then exit;
  k := CPow2(n);
  if rv then begin
    if k >= 0 then RSlli(rA0, rA0, k) else begin RLi(rT1, n); RR(1, 0, rA0, rA0, rT1); end;
  end else if sz = 2 then MulConstA(n)
  else begin
    StaAbs(aA); Op16($8E, aA + 2);
    if k >= 0 then ShiftConstAB(true, k)
    else if MulConstOk(n) then MulConstAB(n)
    else begin LdaImm(n); StaAbs(aB); Op16($9C, aB + 2); Jsl(aMul32); end;
  end;
end;

{ x + y / x - y: x pushed or a constant }
procedure CAddSub(op: integer; var x, y: TItem);
var pt, esz, k: integer;
    xp, yp: boolean;
    v: TItem;
begin
  CDecay(y);
  if y.mode = mCond then begin LoadBool(y); y.typ := tInteger; end;
  xp := CIsPtr(x.typ); yp := CIsPtr(y.typ);
  if not xp and not yp then begin CArith(op, x, y); exit; end;
  if xp and yp then begin
    if op <> sMinus then CErr0(ceConv);
    esz := CSizeOf(types[x.typ].base);
    k := types[x.typ].size;
    x.typ := CIntOfSize(k, false); y.typ := CIntOfSize(k, false);
    CArith(sMinus, x, y);
    x.typ := CIntOfSize(k, true);
    if esz > 1 then begin
      if x.mode = mConst then CConstOf(x, x.a div esz, x.typ)
      else begin
        Push(x);
        MakeConst(v, esz, x.typ);
        CArith(sDiv, x, v);
      end;
    end;
    exit;
  end;
  if yp then begin
    { n + p: only a constant n }
    if (op <> sPlus) or (x.mode <> mConst) then CErr0(ceNotHere);
    v := x; x := y; y := v;
    CPushV(x);
  end;
  pt := x.typ;
  esz := CSizeOf(types[pt].base);
  CScale(y, esz, types[pt].size);
  x.typ := CIntOfSize(types[pt].size, false);
  y.typ := x.typ;
  CArith(op, x, y);
  x.typ := pt;
end;

{ *x }
procedure CDeref(var x: TItem);
var t: integer;
begin
  CDecay(x);
  if not CIsPtr(x.typ) then CErr0(ceNotPointer);
  t := types[x.typ].base;
  if t = 0 then CErr0(ceNotPointer);
  if types[t].form = fCFn then exit;          { (*fp)(...): the pointer is called }
  if x.mode = mConst then begin
    if CIsFar(x.typ) then x.mode := mFarC else x.mode := mGlob;
  end else begin
    Load(x);
    if CIsFar(x.typ) then x.mode := mFar else x.mode := mInd;
    x.a := 0;
  end;
  x.typ := t;
end;

procedure CMember(var x: TItem);
var f: integer;
begin
  if types[x.typ].form <> fRec then CErr0(ceNotStruct);
  if sym <> sIdent then CErr(ceExpected, CTokText(sIdent));
  f := Member(x.typ, id);
  if f = 0 then CErr(ceNoMember, id);
  CNext;
  if x.mode = mReg then begin x.mode := mInd; x.a := 0; end;
  if not (x.mode in [mGlob, mLoc, mInd, mFar, mFarC, mStk]) then CErr0(ceNotLvalue);
  x.a := x.a + syms[f].adr;
  x.typ := syms[f].typ;
end;

{ x[i] }
procedure CIndex(var x: TItem);
var y: TItem;
    esz, et: integer;
    t: integer;
begin
  CNext;
  if (types[x.typ].form = fArr) and (x.mode in [mGlob, mLoc, mInd, mFar, mFarC]) then begin
    { an array variable: a constant index into its address, a variable one added to it }
    et := types[x.typ].base;
    esz := types[et].size;
    if x.mode = mInd then begin PushA(PtrSz); x.mode := mStk; end
    else if x.mode = mFar then begin PushA(4); x.mode := mFarStk; end;
    CExpr(y);
    CExpect(tRbrk);
    CDecay(y);
    if y.mode = mCond then begin LoadBool(y); y.typ := tInteger; end;
    if not CIsInt(y.typ) then CErr0(ceConv);
    if y.mode = mConst then begin
      if x.mode = mStk then begin PopA; x.mode := mInd; end
      else if x.mode = mFarStk then begin
        if rv then RPop(rA0) else begin Gen($68); Gen($FA); end;
        x.mode := mFar;
      end;
      x.a := x.a + y.a * esz;
      x.typ := et;
      exit;
    end;
    if x.mode in [mFarC, mFarStk] then begin
      { a far array: the address + the index, 32 bits }
      CScale(y, esz, 4);
      if x.mode = mFarC then begin
        if rv then begin RLi(rT1, x.a); RR(0, 0, rA0, rA0, rT1); end
        else begin Gen($18); Op16($69, x.a and $FFFF); Gen($A8); Gen($8A); Op16($69, (x.a shr 16) and $FFFF); Gen($AA); Gen($98); end;
        x.a := 0;
      end else begin
        if rv then begin RPop(rT1); RR(0, 0, rA0, rA0, rT1); end
        else begin
          Gen($18); Op8($63, 1); Gen($A8); Gen($8A); Op8($63, 3); Gen($AA);   { clc adc 1,s tay txa adc 3,s tax }
          Gen($7A); Gen($7A); Gen($98);                                      { ply ply tya }
        end;
      end;
      x.mode := mFar; x.typ := et;
      exit;
    end;
    CScale(y, esz, PtrSz);
    if rv then begin
      case x.mode of
        mGlob: begin RLi(rT1, x.a); RR(0, 0, rA0, rA0, rT1); x.a := 0; end;
        mLoc: begin RAddi(rT1, rS0, x.a); RR(0, 0, rA0, rA0, rT1); x.a := 0; end;
        mStk: begin RPop(rT1); RR(0, 0, rA0, rA0, rT1); end;
      end;
    end else
      case x.mode of
        mGlob: begin Gen($18); Op16($69, x.a); x.a := 0; end;
        mLoc: begin StaAbs(aT0); Gen($7B); Gen($18); Op16($69, x.a); Gen($18); Op16($6D, aT0); x.a := 0; end;
        mStk: begin Gen($18); Op8($63, 1); Gen($7A); end;
      end;
    x.mode := mInd; x.typ := et;
    exit;
  end;
  { a pointer: *(p + i) }
  CPushV(x);
  t := x.typ;
  if not CIsPtr(t) then CErr0(ceNotPointer);
  CExpr(y);
  CExpect(tRbrk);
  CAddSub(sPlus, x, y);
  CDeref(x);
end;

{ ---------------------------------------------------------------- struct copies }
{ src (a struct value) into dst: dst's address was prepared (a constant
  address, a frame variable, or pushed: mStk) }
procedure CCopyStruct(var dst, src: TItem);
var n: integer;
begin
  n := types[dst.typ].size;
  if src.mode in [mFar, mFarC] then CErr0(ceNotHere);
  if dst.mode in [mFar, mFarC, mFarStk] then CErr0(ceNotHere);
  if n = 0 then exit;
  if rv then begin
    CLoadAdr(src); RMv(rA1, rA0);
    if dst.mode = mStk then begin RPop(rA0); RAddi(rA0, rA0, dst.a); end
    else begin RPush(rA1); LoadAdr(dst); RPop(rA1); end;
    RLi(rA2, n);
    RCall(aMemmove);
    exit;
  end;
  CLoadAdr(src);
  if dst.mode = mStk then begin
    Gen($AA); Gen($7A);                                  { tax / ply }
    if dst.a <> 0 then begin Gen($98); Gen($18); Op16($69, dst.a); Gen($A8); end;
  end else begin
    Gen($48);                                            { pha: the source }
    LoadAdr(dst); Gen($A8); Gen($FA);                    { tay / plx }
  end;
  LdaImm(n - 1);
  Op8($54, 0); Gen(0);                                   { mvn 0,0 }
end;

{ ---------------------------------------------------------------- calls }
{ the arguments of a call (ch after its opening parenthesis is read):
  converted, pushed, turned around; a struct result's buffer too.
  nb: the bytes pushed, sret: the frame offset of the result buffer }
procedure CArgs(par: longint; np, fl, ret: integer; var nb: integer; var sret: integer);
var sz: array[1..16] of byte;
    perm, inv: array[0..31] of byte;
    done: array[0..31] of boolean;
    cur, tgt: array[1..16] of integer;
    n, i, j, w, s, d, p, slot, tmp: integer;
    y, z: TItem;
    pt: integer;
begin
  CNext;
  n := 0;
  if sym <> tRpar then
    repeat
      CAssignExpr(y);
      if n < np then pt := CParType(par + n)
      else begin
        if fl and (cfVariadic or cfNoProto) = 0 then CErr0(ceArgs);
        CDecay(y);
        if y.mode = mCond then begin LoadBool(y); y.typ := tInteger; end;
        pt := y.typ;
        if CIsInt(pt) then pt := CPromote(pt);
      end;
      if types[pt].form = fRec then begin
        { a struct: a copy in the frame, passed by its address }
        tmp := AllocLocal(types[pt].size);
        z.mode := mLoc; z.a := LocDp(tmp); z.typ := pt; z.tmp := false;
        CConvTo(y, pt);
        CCopyStruct(z, y);
        z.mode := mLoc; z.a := LocDp(tmp);
        LoadAdr(z);
        PushA(PtrSz);
        if rv then slot := 4 else slot := 2;
      end else begin
        CConvTo(y, pt);
        if y.mode = mConst then Load(y);
        PushA(types[pt].size);
        if rv or (types[pt].size > 2) then slot := 4 else slot := 2;
      end;
      if n >= 16 then CErr0(ceArgs);
      n := n + 1;
      sz[n] := slot;
      if sym = tComma then CNext else break;
    until false;
  CExpect(tRpar);
  if (n < np) and (fl and cfNoProto = 0) then CErr0(ceArgs);
  nb := 0;
  for i := 1 to n do nb := nb + sz[i];
  { the first argument goes on top }
  if n > 1 then begin
    if rv then
      for i := 1 to n div 2 do begin
        RLd(4, false, rT0, rSp, 4 * (i - 1)); RLd(4, false, rT1, rSp, 4 * (n - i));
        RSt(4, rT0, rSp, 4 * (n - i)); RSt(4, rT1, rSp, 4 * (i - 1));
      end
    else begin
      { 65C816: words; arg i is at cur(i), it goes to tgt(i) }
      s := 0;
      for i := n downto 1 do begin cur[i] := s; s := s + sz[i]; end;
      s := 0;
      for i := 1 to n do begin tgt[i] := s; s := s + sz[i]; end;
      for i := 1 to n do
        for w := 0 to sz[i] div 2 - 1 do perm[(cur[i] + 2 * w) div 2] := (tgt[i] + 2 * w) div 2;
      for j := 0 to nb div 2 - 1 do begin inv[perm[j]] := j; done[j] := false; end;
      for j := 0 to nb div 2 - 1 do
        if not done[j] and (perm[j] <> j) then begin
          Op8($A3, 2 * j + 1); StaAbs(aT0);               { the word at j aside }
          d := j;
          repeat
            p := inv[d];
            done[d] := true;
            if p = j then break;
            Op8($A3, 2 * p + 1); Op8($83, 2 * d + 1);     { lda p,s / sta d,s }
            d := p;
          until false;
          LdaAbs(aT0); Op8($83, 2 * d + 1);
        end;
    end;
  end;
  sret := -1;
  if types[ret].form = fRec then begin
    sret := AllocLocal(types[ret].size);
    z.mode := mLoc; z.a := LocDp(sret); z.typ := ret;
    LoadAdr(z);
    PushA(PtrSz);
    if rv then nb := nb + 4 else nb := nb + 2;
  end;
end;

procedure CResult(var x: TItem; ret: integer);
begin
  x.tmp := false; x.tj := 0; x.fj := 0; x.a := 0;
  if types[ret].form = fRec then x.mode := mInd else x.mode := mReg;
  x.typ := ret;
  if not rv and (types[ret].size = 1) then begin
    if CIsSigned(ret) then SignExt8 else Op16($29, $FF);
  end;
end;

procedure CCallFunc(s: integer; var x: TItem);
var nb, sret: integer;
begin
  CArgs(syms[s].first, syms[s].npar, syms[s].flags, syms[s].typ, nb, sret);
  if (syms[s].flags and cfDefined = 0) then CBindLib(s);
  if syms[s].flags and (cfDefined or cfLib) <> 0 then Jsl(syms[s].adr)
  else if cDry then Jsl(0)
  else if rv then begin
    W32(syms[s].adr); W32(0);
    syms[s].adr := pc - 8;
  end else begin
    Gen($22); Gen16(syms[s].adr); Gen(0);
    syms[s].adr := pc - 3;
  end;
  syms[s].flags := syms[s].flags or cfUsed;
  PopBytes(nb);
  lastDbg := -1;
  CResult(x, syms[s].typ);
end;

{ a call through a function pointer x }
procedure CCallPtr(var x: TItem);
var ft, nb, sret: integer;
begin
  CDecay(x);
  if not CIsFnPtr(x.typ) then CErr0(ceNotFunc);
  ft := types[x.typ].base;
  CLoadV(x);
  PushA(4);
  CArgs(types[ft].fields, types[ft].lo, types[ft].hi, types[ft].base, nb, sret);
  if rv then begin
    RLd(4, false, rT0, rSp, nb);
    RI($67, 0, rRa, rT0, 0);                             { jalr ra, 0(t0) }
  end else begin
    Op8($A3, nb + 1); StaAbs(aT0);
    Op8($A3, nb + 3); StaAbs(aT0 + 2);
    Gen($4B); Gen($62); Gen16(2); Gen($DC); Gen16(aT0);  { phk / per / jml [rt_t0] }
  end;
  PopBytes(nb + 4);
  lastDbg := -1;
  CResult(x, types[ft].base);
end;

{ a routine of a Pascal unit: its conventions (the arguments from the
  first on, a string as a Pascal string) }
procedure CCallPascal(s: integer; var x: TItem);
var p, pt, buf, tmp, n, e: integer;
    y, z: TItem;
    c2p: longint;
begin
  buf := -1;
  if syms[s].flags and 1 <> 0 then begin
    buf := AllocLocal(256);
    z.mode := mLoc; z.a := LocDp(buf); z.typ := tByte;
    LoadAdr(z); PushA(PtrSz);
  end;
  CNext;
  p := syms[s].first;
  n := 0;
  if sym <> tRpar then
    repeat
      if p = 0 then CErr0(ceArgs);
      pt := syms[p].typ;
      CAssignExpr(y);
      if (syms[p].flags and 1 <> 0) or (types[pt].form = fUntyped) then begin
        { var: the C program passes the address }
        CLoadV(y);
        if not CIsPtr(y.typ) and not CIsInt(y.typ) then CErr0(ceConv);
        PushA(PtrSz);
      end else if types[pt].form = fStr then begin
        { a C string as a Pascal string, in a buffer of the frame }
        e := CLibFind('__c2pstr');
        if e < 0 then CErr0(ceNotHere);
        c2p := ExpValue(e);
        tmp := AllocLocal(256);
        CLoadV(y); PushA(PtrSz);
        z.mode := mLoc; z.a := LocDp(tmp); z.typ := tByte;
        LoadAdr(z); PushA(PtrSz);
        Jsl(c2p);
        PopBytes(2 * PtrSz);
        PushA(PtrSz);
      end else if types[pt].form in [fArr, fRec] then begin
        CDecay(y);
        if y.mode in [mGlob, mLoc, mInd, mStk] then CLoadAdr(y) else CLoadV(y);
        PushA(PtrSz);
      end else if types[pt].form = fChar then begin
        CConvTo(y, tByte); if y.mode = mConst then Load(y); PushA(2);
      end else if types[pt].form = fBool then begin
        CCondOf(y); LoadBool(y); PushA(2);
      end else if types[pt].form in [fInt, fReal, fPtr, fNil, fEnum] then begin
        if types[pt].form = fEnum then pt := CIntOfSize(types[pt].size, false);
        CConvTo(y, pt); if y.mode = mConst then Load(y); PushA(types[pt].size);
      end else if types[pt].form = fProc then begin
        CConvTo(y, tLong); if y.mode = mConst then Load(y); PushA(4);
      end else CErr0(ceConv);
      p := syms[p].next;
      n := n + 1;
      if sym = tComma then CNext else break;
    until false;
  CExpect(tRpar);
  if p <> 0 then CErr0(ceArgs);
  Jsl(syms[s].adr);
  PopBytes(syms[s].parsz);
  lastDbg := -1;
  x.tmp := false; x.tj := 0; x.fj := 0; x.a := 0; x.mode := mReg;
  if buf >= 0 then begin
    { the Pascal string result as a C string (in its buffer) }
    e := CLibFind('__p2cstr');
    if e < 0 then CErr0(ceNotHere);
    z.mode := mLoc; z.a := LocDp(buf); z.typ := tByte;
    LoadAdr(z); PushA(PtrSz);
    Jsl(ExpValue(e));
    PopBytes(PtrSz);
    x.typ := cCharPtr;
    exit;
  end;
  if syms[s].kind <> skProc then CErr0(ceNotFunc);
  if syms[s].typ = 0 then x.typ := tVoid
  else begin
    x.typ := syms[s].typ;
    if not rv and (types[x.typ].size = 1) then Op16($29, $FF);
    if types[x.typ].form in [fChar, fBool] then x.typ := tByte;
  end;
end;

{ ---------------------------------------------------------------- primaries }
procedure CVarItem(s: integer; var x: TItem);
var dp: longint;
begin
  x.typ := syms[s].typ; x.tmp := false; x.tj := 0; x.fj := 0;
  if syms[s].lev = 0 then begin
    if syms[s].flags and 32 <> 0 then x.mode := mFarC else x.mode := mGlob;
    x.a := syms[s].adr;
    exit;
  end;
  if syms[s].isPar then dp := ParDp(1, syms[s].adr) else dp := LocDp(syms[s].adr);
  if syms[s].isRef then begin LdaDp(dp); x.mode := mInd; x.a := 0; end
  else begin x.mode := mLoc; x.a := dp; end;
end;

{ a string literal (and the ones right after it): its address }
procedure CStringLit(var x: TItem);
var a: longint;
    i: integer;
    s: string;
begin
  s := str;
  CNext;
  while sym = sString do begin
    if length(s) + length(str) > 255 then CErr0(ceStrLong);
    s := s + str;
    CNext;
  end;
  a := AllocData(length(s) + 1);
  for i := 1 to length(s) do Mem[DataImg + a - dataOrg + i - 1] := ord(s[i]);
  MakeConst(x, a, cCharPtr);
end;

procedure CPrimary(var x: TItem);
var s: integer;
begin
  case sym of
    sNumber: begin MakeConst(x, num, cNumTyp); CNext; end;
    sReal: begin MakeConst(x, num, tReal); CNext; end;
    sString: CStringLit(x);
    sIdent: begin
      if cPP then begin
        { #if: defined NAME, defined(NAME); other names are 0 }
        if id = 'defined' then begin
          cNoMacros := true;
          CNext;
          if sym = tLpar then begin
            CNext;
            MakeConst(x, ord(MacFind(cName) <> 0), tInteger);
            CNext;
            cNoMacros := false;
            CExpect(tRpar);
          end else begin
            MakeConst(x, ord(MacFind(cName) <> 0), tInteger);
            cNoMacros := false;
            CNext;
          end;
        end else begin MakeConst(x, 0, tInteger); CNext; end;
        exit;
      end;
      s := CLookup(id);
      if s = 0 then CErr(ceUndeclared, id);
      CNext;
      case syms[s].kind of
        skVar: CVarItem(s, x);
        skConst: begin
          MakeConst(x, syms[s].adr, syms[s].typ);
          if types[x.typ].form in [fChar, fBool, fEnum] then x.typ := tInteger;
        end;
        skCFunc: begin MakeConst(x, s, syms[s].typ); x.mode := mFn; end;
        skProc: begin MakeConst(x, s, syms[s].typ); x.mode := mPfn; end;
      else
        CErr(ceUndeclared, syms[s].name);
      end;
    end;
  else
    CErr0(ceSyntax);
  end;
end;

procedure CVaArg(var x: TItem);
var ap, v: TItem;
    t, slot: integer;
begin
  CNext;
  CExpect(tLpar);
  CAssignExpr(ap);
  if not (ap.mode in [mGlob, mLoc]) then CErr0(ceNotLvalue);
  CExpect(tComma);
  t := CTypeName;
  CExpect(tRpar);
  if rv or (types[t].size > 2) then slot := 4 else slot := 2;
  v := ap;
  CLoad(v);
  if rv then begin RPush(rA0); RAddi(rA0, rA0, slot); CStore(ap); RPop(rA0); end
  else begin Gen($48); Gen($18); Op16($69, slot); CStore(ap); Gen($68); end;
  x.mode := mInd; x.a := 0; x.typ := t; x.tmp := false; x.tj := 0; x.fj := 0;
end;

{ ---------------------------------------------------------------- ++ -- }
{ an lvalue whose address does not change while it is used twice: a
  computed address goes to a frame slot }
procedure CStable(var x: TItem);
var tmp, k: integer;
begin
  if x.mode = mInd then begin
    tmp := AllocLocal(PtrSz);
    k := LocDp(tmp);
    if rv then RSt(4, rA0, rS0, k) else Op8($85, k);
    x.mode := mTInd; x.fj := k;
  end else if x.mode = mFar then begin
    tmp := AllocLocal(4);
    k := LocDp(tmp);
    if rv then RSt(4, rA0, rS0, k) else begin Op8($85, k); Op8($86, k + 2); end;
    x.mode := mTFar; x.fj := k;
  end else if not (x.mode in [mGlob, mLoc, mFarC]) then CErr0(ceNotLvalue);
end;

{ a stable lvalue as an item to load or store }
procedure CUse(var x, y: TItem);
begin
  y := x;
  if x.mode = mTInd then begin
    if rv then RLd(4, false, rA0, rS0, x.fj) else Op8($A5, x.fj);
    y.mode := mInd;
  end else if x.mode = mTFar then begin
    if rv then RLd(4, false, rA0, rS0, x.fj) else begin Op8($A6, x.fj + 2); Op8($A5, x.fj); end;
    y.mode := mFar;
  end;
  y.fj := 0;
end;

{ A (A/X) into a stable lvalue }
procedure CStoreStable(var x: TItem);
var sz: integer;
begin
  sz := types[x.typ].size;
  if x.mode = mTInd then begin
    if rv then begin RLd(4, false, rT1, rS0, x.fj); RSt(sz, rA0, rT1, x.a); exit; end;
    if sz = 4 then begin
      Gen($48); Gen($8A); Op8($A6, x.fj); Op16($9D, x.a + 2); Gen($68); Op16($9D, x.a);   { pha txa ldx sta pla sta }
    end else begin
      Op8($A6, x.fj);                                        { ldx slot }
      if sz = 1 then begin Sep; Op16($9D, x.a); Rep; end else Op16($9D, x.a);
    end;
    exit;
  end;
  if x.mode = mTFar then begin
    if rv then begin
      RLd(4, false, rT1, rS0, x.fj); RLi(rT0, longint($80000000)); RR(0, 6, rT1, rT1, rT0);
      RSt(sz, rA0, rT1, x.a);
      exit;
    end;
    StaAbs(aV); if sz = 4 then Op16($8E, aV + 2);
    Op8($A5, x.fj); StaAbs(aFp); Op8($A5, x.fj + 2); StaAbs(aFp + 2);
    Op16($A0, x.a);
    if sz = 1 then Jsl(aStf8) else if sz = 2 then Jsl(aStf16) else Jsl(aStf32);
    exit;
  end;
  CStore(x);
end;

{ ++x, --x, x++, x--; the value is the new (or for post the old) one }
procedure CIncDec(var x: TItem; dec, post: boolean);
var v, y: TItem;
    d: longint;
    sz: integer;
begin
  if not CIsScalar(x.typ) then CErr0(ceNotScalar);
  CStable(x);
  CUse(x, v);
  CLoad(v);
  v.mode := mReg;
  sz := types[x.typ].size;
  if post then begin
    if rv then RPush(rA0) else PushA(sz);
  end;
  if CIsPtr(x.typ) then d := CSizeOf(types[x.typ].base) else d := 1;
  if IsReal(x.typ) then begin
    PushA(4);
    v.mode := mStk;
    MakeConst(y, IntToRealBits(1), tReal);
    if dec then RealArith(sMinus, v, y) else RealArith(sPlus, v, y);
  end else if rv then begin
    if dec then RAddi(rA0, rA0, -d) else RAddi(rA0, rA0, d);
    if (sz < 4) and not CIsPtr(x.typ) then RNormSz(rA0, sz, CIsSigned(x.typ));
  end else if sz = 4 then begin
    if dec then d := -d;
    Gen($18); Op16($69, d and $FFFF); Gen($A8); Gen($8A); Op16($69, (d shr 16) and $FFFF); Gen($AA); Gen($98);
  end else if d = 1 then begin
    if dec then Gen($3A) else Gen($1A);
  end else if dec then begin Gen($38); Op16($E9, d); end
  else begin Gen($18); Op16($69, d); end;
  CStoreStable(x);
  if post then begin
    if rv then RPop(rA0) else begin Gen($68); if sz = 4 then Gen($FA); end;
  end;
  x.mode := mReg;
  if types[x.typ].form in [fChar, fBool] then x.typ := tByte;
end;

{ ---------------------------------------------------------------- unary }
procedure CPostfix(var x: TItem);
begin
  repeat
    case sym of
      tLbrk: CIndex(x);
      tLpar: begin
        if x.mode = mFn then CCallFunc(x.a, x)
        else if x.mode = mPfn then CCallPascal(x.a, x)
        else CCallPtr(x);
      end;
      tDot: begin CNext; CMember(x); end;
      tArrow: begin CNext; CDeref(x); CMember(x); end;
      tInc: begin CNext; CIncDec(x, false, true); end;
      tDec: begin CNext; CIncDec(x, true, true); end;
    else
      exit;
    end;
  until false;
end;

{ sizeof's operand: parsed, its code thrown away }
function CSizeOperand(paren: boolean): longint;
var x: TItem;
    p0, d0: longint;
    dry: boolean;
begin
  p0 := pc; d0 := dataTop; dry := cDry;
  cDry := true;
  if paren then begin CExpr(x); CExpect(tRpar); CPostfix(x); end else CUnary(x);
  cDry := dry;
  pc := p0; dataTop := d0;
  if x.mode in [mFn, mPfn] then CErr0(ceNotHere);
  if x.mode = mCond then begin FixChain(x.tj, 0); x.typ := tInteger; end;
  CSizeOperand := CSizeOf(x.typ);
end;

procedure CUnary(var x: TItem);
var op, t: integer;
    v: longint;
begin
  case sym of
    tInc, tDec: begin
      op := sym; CNext;
      CUnary(x);
      CIncDec(x, op = tDec, false);
    end;
    tAmp: begin
      CNext;
      CUnary(x);
      if x.mode = mFn then begin CDecay(x); exit; end;
      t := x.typ;
      if x.mode in [mGlob, mFarC] then MakeConst(x, x.a, CPtr(t, x.mode = mFarC))
      else if x.mode in [mLoc, mInd, mStk] then begin CLoadAdr(x); x.typ := CPtr(t, false); end
      else if x.mode = mFar then begin CLoadAdr(x); x.typ := CPtr(t, true); end
      else CErr0(ceNotLvalue);
    end;
    tStar: begin CNext; CUnary(x); CDeref(x); end;
    tMinus, tPlus, tTilde: begin
      op := sym; CNext;
      CUnary(x);
      CValue(x);
      if not CIsArith(x.typ) then CErr0(ceConv);
      if op = tPlus then begin if not IsReal(x.typ) then x.typ := CPromote(x.typ); exit; end;
      if IsReal(x.typ) then begin
        if op = tTilde then CErr0(ceConv);
        if x.mode = mConst then x.a := x.a xor longint($80000000)
        else if rv then begin RLi(rT1, longint($80000000)); RR(0, 4, rA0, rA0, rT1); end
        else begin Gen($48); Gen($8A); Op16($49, $8000); Gen($AA); Gen($68); end;
        if x.mode <> mConst then x.mode := mReg;
        exit;
      end;
      t := CPromote(x.typ);
      if x.mode = mConst then begin
        if op = tMinus then CConstOf(x, -x.a, t) else CConstOf(x, not x.a, t);
        exit;
      end;
      if rv then begin
        if op = tMinus then RR($20, 0, rA0, rZero, rA0) else RI($13, 4, rA0, rA0, -1);
        if types[t].size < 4 then RNormSz(rA0, 2, CIsSigned(t));
      end else if types[t].size = 4 then begin
        if types[x.typ].size < 4 then Extend(x.typ);
        if op = tMinus then begin
          StaAbs(aB); Op16($8E, aB + 2);
          LdaImm(0); Gen($38); Op16($ED, aB); Gen($A8); LdaImm(0); Op16($ED, aB + 2); Gen($AA); Gen($98);
        end else begin
          Op16($49, $FFFF); Gen($A8); Gen($8A); Op16($49, $FFFF); Gen($AA); Gen($98);
        end;
      end else begin
        Op16($49, $FFFF);
        if op = tMinus then Gen($1A);
      end;
      x.mode := mReg; x.typ := t;
    end;
    tNot: begin
      CNext;
      CUnary(x);
      CCondOf(x);
      if x.mode = mConst then begin x.a := 1 - x.a; exit; end;
      x.a := Inverse(x.a);
      v := x.tj; x.tj := x.fj; x.fj := v;
    end;
    kSizeof: begin
      CNext;
      if sym = tLpar then begin
        CNext;
        if CIsTypeStart then begin
          t := CTypeName;
          CExpect(tRpar);
          v := CSizeOf(t);
        end else v := CSizeOperand(true);
      end else v := CSizeOperand(false);
      if rv then MakeConst(x, v, tLongW) else MakeConst(x, v, tWord);
    end;
    tLpar: begin
      CNext;
      if CIsTypeStart then begin
        t := CTypeName;
        CExpect(tRpar);
        if sym = tLbrace then CErr0(ceNotHere);
        CUnary(x);
        CConvTo(x, t);
        x.typ := t;
        if types[t].form in [fChar, fBool] then x.typ := tByte;
        exit;
      end;
      CExpr(x);
      CExpect(tRpar);
      CPostfix(x);
    end;
    kVaArg: begin CVaArg(x); CPostfix(x); end;
  else
    CPrimary(x);
    CPostfix(x);
  end;
end;

{ ---------------------------------------------------------------- binary }
procedure CMulExpr(var x: TItem);
var y: TItem;
    op: integer;
begin
  CUnary(x);
  while sym in [tStar, tSlash, tPercent] do begin
    case sym of tStar: op := sTimes; tSlash: op := sDiv; tPercent: op := sMod; end;
    CNext;
    CPushV(x);
    CUnary(y);
    CArith(op, x, y);
  end;
end;

procedure CAddExpr(var x: TItem);
var y: TItem;
    op: integer;
begin
  CMulExpr(x);
  while sym in [tPlus, tMinus] do begin
    if sym = tPlus then op := sPlus else op := sMinus;
    CNext;
    CPushV(x);
    CMulExpr(y);
    CAddSub(op, x, y);
  end;
end;

procedure CShiftExpr(var x: TItem);
var y: TItem;
    op: integer;
begin
  CAddExpr(x);
  while sym in [tShl, tShr] do begin
    if sym = tShl then op := sShl else op := sShr;
    CNext;
    CPushV(x);
    CAddExpr(y);
    CArith(op, x, y);
  end;
end;

procedure CRelExpr(var x: TItem);
var y: TItem;
    op: integer;
begin
  CShiftExpr(x);
  while sym in [tLt, tLe, tGt, tGe] do begin
    op := sym; CNext;
    CPushV(x);
    CShiftExpr(y);
    CRel(op, x, y);
  end;
end;

procedure CEqExpr(var x: TItem);
var y: TItem;
    op: integer;
begin
  CRelExpr(x);
  while sym in [tEq, tNe] do begin
    op := sym; CNext;
    CPushV(x);
    CRelExpr(y);
    CRel(op, x, y);
  end;
end;

procedure CBitAnd(var x: TItem);
var y: TItem;
begin
  CEqExpr(x);
  while sym = tAmp do begin CNext; CPushV(x); CEqExpr(y); CArith(sAnd, x, y); end;
end;

procedure CBitXor(var x: TItem);
var y: TItem;
begin
  CBitAnd(x);
  while sym = tCaret do begin CNext; CPushV(x); CBitAnd(y); CArith(sXor, x, y); end;
end;

procedure CBitOr(var x: TItem);
var y: TItem;
begin
  CBitXor(x);
  while sym = tBar do begin CNext; CPushV(x); CBitXor(y); CArith(sOr, x, y); end;
end;

procedure CLogAnd(var x: TItem);
var y: TItem;
begin
  CBitOr(x);
  while sym = tAndAnd do begin
    CNext;
    CCondOf(x);
    if x.mode = mConst then begin
      CBitOr(y); CCondOf(y);
      if x.a = 0 then begin CDiscard(y); MakeConst(x, 0, tBool); end else x := y;
    end else begin
      CondTrue(x.a, 3); BrlFwd(x.fj);
      FixChain(x.tj, pc); x.tj := 0;
      CBitOr(y);
      CCondOf(y);
      if y.mode = mConst then begin
        if y.a = 0 then begin FixChain(x.fj, pc); MakeConst(x, 0, tBool); end
        else begin
          { x && 1: x's own jumps, then true }
          LdaImm(1);
          if not rv then Op16($C9, 0);
          y.mode := mCond; y.a := cNe; y.tj := 0; y.fj := x.fj;
          x := y;
        end;
      end else begin
        y.fj := MergeChain(y.fj, x.fj);
        x := y;
      end;
    end;
  end;
end;

procedure CLogOr(var x: TItem);
var y: TItem;
begin
  CLogAnd(x);
  while sym = tOrOr do begin
    CNext;
    CCondOf(x);
    if x.mode = mConst then begin
      CLogAnd(y); CCondOf(y);
      if x.a <> 0 then begin CDiscard(y); MakeConst(x, 1, tBool); end else x := y;
    end else begin
      CondTrue(Inverse(x.a), 3); BrlFwd(x.tj);
      FixChain(x.fj, pc); x.fj := 0;
      CLogAnd(y);
      CCondOf(y);
      if y.mode = mConst then begin
        if y.a <> 0 then begin FixChain(x.tj, pc); MakeConst(x, 1, tBool); end
        else begin
          LdaImm(0);
          if not rv then Op16($C9, 0);
          y.mode := mCond; y.a := cNe; y.fj := 0; y.tj := x.tj;
          x := y;
        end;
      end else begin
        y.tj := MergeChain(y.tj, x.tj);
        x := y;
      end;
    end;
  end;
end;

{ a value in A of type a, as type b (code at the end of the first branch of ?:) }
procedure CRegConv(a, b: integer);
var x: TItem;
begin
  if a = b then exit;
  x.mode := mReg; x.typ := a; x.a := 0; x.tj := 0; x.fj := 0; x.tmp := false;
  CConvTo(x, b);
end;

procedure CCondExpr(var x: TItem);
var y: TItem;
    f, e1, e2, p0: longint;
    t1, t2, t: integer;
begin
  CLogOr(x);
  if sym <> tQuest then exit;
  CNext;
  CCondOf(x);
  f := 0;
  JumpFalse(x, f);
  CExpr(y);
  CDecay(y);
  if y.typ <> tVoid then CValue(y) else CDiscard(y);
  if (y.mode = mConst) and (types[y.typ].form <> fRec) and (y.typ <> tVoid) then Load(y);
  t1 := y.typ;
  e1 := 0; BrlFwd(e1);
  FixChain(f, pc);
  CExpect(tColon);
  CCondExpr(x);
  CDecay(x);
  if x.typ <> tVoid then CValue(x) else CDiscard(x);
  t2 := x.typ;
  { the type of the whole: the usual conversions, or the pointer }
  if CIsArith(t1) and CIsArith(t2) then t := CArithType(t1, t2)
  else if CIsPtr(t1) then t := t1
  else if CIsPtr(t2) then t := t2
  else t := t1;
  if (t1 = tVoid) or (t2 = tVoid) then t := tVoid;
  if (types[t2].form <> fRec) and (t <> tVoid) then begin CConvTo(x, t); if x.mode = mConst then Load(x); end
  else if (x.mode = mConst) and (t <> tVoid) then Load(x);
  if (t1 <> t) and CIsArith(t1) and CIsArith(t) and ((types[t1].size <> types[t].size) or (t = tReal) <> (t1 = tReal)) then begin
    e2 := 0; BrlFwd(e2);
    FixChain(e1, pc);
    CRegConv(t1, t);
    FixChain(e2, pc);
  end else FixChain(e1, pc);
  x.mode := mReg; x.typ := t; x.a := 0; x.tj := 0; x.fj := 0;
  if types[t].form = fRec then x.mode := mInd;
end;

procedure CAssignExpr(var x: TItem);
var y, v: TItem;
    op, sz: integer;
    keep: boolean;
begin
  CCondExpr(x);
  if not (sym in [tAssign, tAddAs, tSubAs, tMulAs, tDivAs, tModAs, tAndAs, tOrAs, tXorAs, tShlAs, tShrAs]) then exit;
  op := sym;
  CNext;
  if x.mode in [mFn, mPfn, mConst, mReg, mCond] then CErr0(ceNotLvalue);
  if types[x.typ].form = fArr then CErr0(ceNotLvalue);
  keep := x.mode in [mGlob, mLoc, mFarC];
  if op = tAssign then begin
    if x.mode in [mInd, mFar] then PrepStore(x);
    CAssignExpr(y);
    if types[x.typ].form = fRec then begin
      CConvTo(y, x.typ);
      CCopyStruct(x, y);
      if not keep then CErr0(ceNotHere);
      exit;
    end;
    CConvTo(y, x.typ);
    if y.mode = mConst then Load(y);
    if (x.mode = mFarStk) and not rv then begin
      { a far store keeps A in rt_v }
      Store(x);
      LdaAbs(aV);
      if types[x.typ].size = 4 then Op16($AE, aV + 2);
    end else CStore(x);
    if not keep then begin x.mode := mReg; x.a := 0; end;
    exit;
  end;
  { x op= y }
  if not CIsScalar(x.typ) then CErr0(ceNotScalar);
  CStable(x);
  CUse(x, v);
  CLoad(v);
  v.mode := mReg;
  PushA(types[x.typ].size);
  v.mode := mStk;
  if not rv and (types[x.typ].size <= 2) then pushAt := pc;
  CAssignExpr(y);
  case op of
    tAddAs: CAddSub(sPlus, v, y);
    tSubAs: CAddSub(sMinus, v, y);
    tMulAs: CArith(sTimes, v, y);
    tDivAs: CArith(sDiv, v, y);
    tModAs: CArith(sMod, v, y);
    tAndAs: CArith(sAnd, v, y);
    tOrAs: CArith(sOr, v, y);
    tXorAs: CArith(sXor, v, y);
    tShlAs: CArith(sShl, v, y);
    tShrAs: CArith(sShr, v, y);
  end;
  CConvTo(v, x.typ);
  if v.mode = mConst then Load(v);
  CStoreStable(x);
  if keep then exit;
  x.mode := mReg; x.a := 0;
  if types[x.typ].form in [fChar, fBool] then x.typ := tByte;
end;

procedure CExpr(var x: TItem);
begin
  CAssignExpr(x);
  while sym = tComma do begin
    CNext;
    CDiscard(x);
    CAssignExpr(x);
  end;
end;

{ a constant expression (array sizes, case labels, #if, enums) }
function CConstValue: longint;
var x: TItem;
    p0: longint;
begin
  p0 := pc;
  CCondExpr(x);
  if x.mode <> mConst then CErr0(ceConst);
  if IsReal(x.typ) then CErr0(ceConst);
  pc := p0;
  CConstValue := x.a;
end;
