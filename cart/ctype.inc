{ MERIDIAN C on the MERIDIAN - part 2: types, names, declarations' types
  (included by ccomp.inc).

  C types are entries of the compiler's type table: integers (fInt: char
  unsigned 8 bit, int 16, long 32), the real (float and double), pointers
  (fPtr, base the target; sgn: __far, 32 bit; a pointer to a function is
  32 bit too: code addresses are 24 bit), arrays (fArr 0..n-1), structs and
  unions (fRec; hi bit 0 complete, bit 1 a union) and functions (fCFn).
  Parameter lists are in CParBase. Names are symbols as for Pascal; C keeps
  their case, and a name C does not know may be a Pascal one of the units
  #pragma unit named (the cartridge's export table, in lower case). }

var
  tVoid, tCBool: integer;
  cParTop: integer;
  cStatic: integer;       { the current function's statics: their names }

type
  TCSpec = record
    t: integer;           { the type }
    storage: byte;        { 0 none, 1 typedef, 2 extern, 3 static, 4 auto / register }
    any: boolean;         { a specifier was seen }
    far: boolean;         { __far among them: the first pointer of each declarator }
  end;
  TDOp = record
    k: byte;              { 1 pointer, 2 __far pointer, 3 array (v elements, -1 unknown), 4 function }
    v: longint;           { function: the first parameter in CParBase }
    f: integer;           { function: the number of parameters + 256 * flags }
  end;

var
  dOps: array[1..24] of TDOp;
  dN: integer;
  dName: TName;
  dHasName: boolean;
  dFar: boolean;          { the declarator's first pointer is __far (from the specifiers) }

{ ---------------------------------------------------------------- types }
function CIsInt(t: integer): boolean;
begin CIsInt := types[t].form in [fInt, fChar, fBool, fEnum]; end;
function CIsArith(t: integer): boolean;
begin CIsArith := types[t].form in [fInt, fChar, fBool, fEnum, fReal]; end;
function CIsPtr(t: integer): boolean;
begin CIsPtr := types[t].form in [fPtr, fNil]; end;
function CIsScalar(t: integer): boolean;
begin CIsScalar := types[t].form in [fInt, fChar, fBool, fEnum, fReal, fPtr, fNil]; end;
function CIsFar(t: integer): boolean;
begin CIsFar := (types[t].form = fPtr) and types[t].sgn; end;
function CIsFnPtr(t: integer): boolean;
begin CIsFnPtr := (types[t].form = fPtr) and (types[t].base <> 0) and (types[types[t].base].form = fCFn); end;
function CIsSigned(t: integer): boolean;
begin CIsSigned := (types[t].form in [fInt, fReal]) and types[t].sgn; end;

function CPtr(t: integer; far: boolean): integer;
var i: integer;
begin
  for i := nType downto 15 do
    if (types[i].form = fPtr) and (types[i].base = t) and (types[i].sgn = far) then begin CPtr := i; exit; end;
  if far or (types[t].form = fCFn) then i := NewType(fPtr, 4) else i := NewType(fPtr, PtrSz);
  types[i].base := t;
  types[i].sgn := far;
  CPtr := i;
end;

function CArr(t: integer; n: longint): integer;
var i: integer;
begin
  if n < 0 then i := NewType(fArr, 0) else begin
    if n * types[t].size > 65535 then CErr0(ceArrSize);
    i := NewType(fArr, n * types[t].size);
  end;
  types[i].lo := 0; types[i].hi := n - 1; types[i].base := t;
  CArr := i;
end;

function CFnType(ret: integer; par: longint; f: integer): integer;
var i: integer;
begin
  i := NewType(fCFn, 0);
  types[i].base := ret; types[i].fields := par;
  types[i].lo := f and 255; types[i].hi := f shr 8;
  CFnType := i;
end;

{ the type after the integer promotions }
function CPromote(t: integer): integer;
begin
  CPromote := t;
  case types[t].form of
    fInt: if types[t].size < 2 then CPromote := tInteger
          else if types[t].size = 2 then begin if types[t].sgn then CPromote := tInteger else CPromote := tWord; end
          else if types[t].sgn then CPromote := tLong else CPromote := tLongW;
    fChar, fBool: CPromote := tInteger;
    fEnum: if types[t].size = 1 then CPromote := tInteger else CPromote := tWord;
  end;
end;

{ the type of a binary arithmetic operation's operands (the usual conversions) }
function CArithType(a, b: integer): integer;
begin
  if (types[a].form = fReal) or (types[b].form = fReal) then begin CArithType := tReal; exit; end;
  a := CPromote(a); b := CPromote(b);
  if (types[a].size = 4) or (types[b].size = 4) then begin
    if ((types[a].size = 4) and not types[a].sgn) or ((types[b].size = 4) and not types[b].sgn) then CArithType := tLongW
    else CArithType := tLong;
  end else if not types[a].sgn or not types[b].sgn then CArithType := tWord
  else CArithType := tInteger;
end;

{ the element of an array, or the target of a pointer }
function CElem(t: integer): integer;
begin
  if types[t].form in [fArr, fPtr] then CElem := types[t].base else CElem := 0;
end;

function CSizeOf(t: integer): longint;
begin
  if (types[t].form = fRec) and (types[t].hi and 1 = 0) then CErr0(ceIncomplete);
  if t = tVoid then CSizeOf := 1 else CSizeOf := types[t].size;
end;

{ ---------------------------------------------------------------- names }
function CLower(const n: TName): TName;
var i: integer;
    r: TName;
begin
  r := n;
  for i := 1 to length(r) do r[i] := LoCase(r[i]);
  CLower := r;
end;

{ a name of the C text: symbols from the newest; 0 none }
function CFindC(const n: TName): integer;
var i: integer;
begin
  for i := nSym downto 1 do
    if (syms[i].name = n) and not (syms[i].kind in [skField, skPar, skTag]) and (syms[i].flags and 128 = 0) then begin
      CFindC := i; exit;
    end;
  CFindC := 0;
end;

{ a name: of C, else of a Pascal unit the text uses }
function CLookup(const n: TName): integer;
var i, e, u: integer;
    ln: TName;
begin
  i := CFindC(n);
  if i = 0 then begin
    ln := CLower(n);
    for i := nSym downto 1 do
      if (syms[i].flags and 128 <> 0) and (syms[i].name = ln) and not (syms[i].kind in [skField, skPar]) then begin
        CLookup := i; exit;
      end;
    i := 0;
    e := ExpFind(ln);
    if e >= 0 then begin
      u := Mem[ExpBase + longint(e) * 40 + 32];
      if (u < 32) and ((cUnits shr u) and 1 <> 0) and (Mem[ExpBase + longint(e) * 40 + 20] <= 5) then i := Import(e);
    end;
  end;
  CLookup := i;
end;

function CFindTag(const n: TName): integer;
var i: integer;
begin
  for i := nSym downto 1 do
    if (syms[i].kind = skTag) and (syms[i].name = n) then begin CFindTag := i; exit; end;
  CFindTag := 0;
end;

{ the C library's routine or variable n: its export index, -1 none }
function CLibFind(const n: TName): integer;
var e: integer;
begin
  CLibFind := -1;
  if length(n) > 14 then exit;
  e := ExpFind('.' + n);
  if e >= 0 then if Mem[ExpBase + longint(e) * 40 + 20] >= 7 then CLibFind := e;
end;

{ is the name a type (a typedef, or a Pascal type)? }
function CIsTypeName(const n: TName): boolean;
var s: integer;
begin
  s := CLookup(n);
  CIsTypeName := (s <> 0) and (syms[s].kind = skType);
end;

function CIsTypeStart: boolean;
begin
  case sym of
    kVoid, kChar, kShort, kInt, kLong, kFloat, kDouble, kSigned, kUnsigned, kBool, kStruct, kUnion,
    kEnum, kConst, kVolatile, kRestrict, kFar, kInline, kNoreturn, kTypedef, kExtern, kStatic, kAuto,
    kRegister, kAttribute: CIsTypeStart := true;
    sIdent: CIsTypeStart := CIsTypeName(id);
  else
    CIsTypeStart := false;
  end;
end;

{ ---------------------------------------------------------------- specifiers }
function CConstValue: longint; forward;
procedure CSpecifiers(var sp: TCSpec); forward;
procedure CDeclarator(abstr: boolean); forward;
function CApply(t, from, upto: integer): integer; forward;

{ __attribute__((...)): skipped }
procedure CSkipAttribute;
var depth: integer;
begin
  CNext;
  if sym <> tLpar then exit;
  depth := 0;
  repeat
    if sym = tLpar then depth := depth + 1
    else if sym = tRpar then depth := depth - 1;
    if sym = sEOF then CErr0(ceSyntax);
    CNext;
  until depth = 0;
end;

{ struct / union: the type }
function CStructSpec(isUnion: boolean): integer;
var t, s, f, prev, ft, k, al, a: integer;
    tag: TName;
    off, size: longint;
    sp: TCSpec;
begin
  CNext;
  tag := '';
  if sym = kAttribute then CSkipAttribute;
  if sym = sIdent then begin tag := id; CNext; end;
  t := 0;
  if tag <> '' then begin
    s := CFindTag(tag);
    if s <> 0 then begin
      t := syms[s].typ;
      { a body for a type that has one already: a new type (of this scope) }
      if (sym = tLbrace) and (types[t].hi and 1 <> 0) then t := 0;
    end;
  end else if sym <> tLbrace then CErr0(ceSyntax);
  if t = 0 then begin
    t := NewType(fRec, 0);
    types[t].hi := 0;
    if isUnion then types[t].hi := 2;
    if tag <> '' then begin s := NewSym(tag, skTag, t); syms[s].lev := curLev; end;
  end;
  if sym <> tLbrace then begin CStructSpec := t; exit; end;
  CNext;
  off := 0; size := 0; al := 1; prev := 0;
  while sym <> tRbrace do begin
    CSpecifiers(sp);
    if not sp.any then CErr0(ceType);
    repeat
      dN := 0; dHasName := false; dFar := sp.far;
      if sym <> tColon then CDeclarator(false);
      if sym = tColon then CErr0(ceBitfield);
      ft := CApply(sp.t, 1, dN);
      if not dHasName then CErr0(ceDecl);
      if (types[ft].form = fRec) and (types[ft].hi and 1 = 0) then CErr0(ceIncomplete);
      a := AlignOf(ft);
      if a > al then al := a;
      if isUnion then f := NewSym(dName, skField, ft)
      else begin
        off := (off + a - 1) div a * a;
        f := NewSym(dName, skField, ft);
        syms[f].adr := off;
        off := off + types[ft].size;
      end;
      if types[ft].size > size then size := types[ft].size;
      syms[f].lev := 0;
      if prev = 0 then types[t].fields := f else syms[prev].next := f;
      prev := f;
      if sym = tComma then CNext else break;
    until false;
    CExpect(tSemi);
  end;
  CNext;
  if sym = kAttribute then CSkipAttribute;
  if not isUnion then size := off;
  size := (size + al - 1) div al * al;
  types[t].size := size;
  types[t].al := al;
  types[t].hi := types[t].hi or 1;
  CStructSpec := t;
end;

function CEnumSpec: integer;
var s: integer;
    v: longint;
begin
  CNext;
  if sym = sIdent then begin
    if CFindTag(id) = 0 then begin s := NewSym(id, skTag, tInteger); syms[s].lev := curLev; end;
    CNext;
  end;
  if sym = tLbrace then begin
    CNext;
    v := 0;
    while sym <> tRbrace do begin
      if sym <> sIdent then CErr0(ceDecl);
      s := NewSym(id, skConst, tInteger);
      CNext;
      if sym = tAssign then begin CNext; v := CConstValue; end;
      syms[s].adr := v;
      v := v + 1;
      if sym = tComma then CNext else break;
    end;
    CExpect(tRbrace);
  end;
  CEnumSpec := tInteger;
end;

procedure CSpecifiers(var sp: TCSpec);
var nLong, nShort, nSign, nUns, base, s, t: integer;
begin
  sp.t := 0; sp.storage := 0; sp.any := false; sp.far := false;
  nLong := 0; nShort := 0; nSign := 0; nUns := 0; base := 0; t := 0;
  repeat
    case sym of
      kTypedef: sp.storage := 1;
      kExtern: sp.storage := 2;
      kStatic: sp.storage := 3;
      kAuto, kRegister: sp.storage := 4;
      kFar: sp.far := true;
      kConst, kVolatile, kRestrict, kInline, kNoreturn: ;
      kAttribute: begin CSkipAttribute; sp.any := true; continue; end;
      kVoid: base := 1;
      kChar: base := 2;
      kInt: if base = 0 then base := 3;
      kFloat, kDouble: base := 4;
      kBool: base := 5;
      kShort: nShort := nShort + 1;
      kLong: nLong := nLong + 1;
      kSigned: nSign := nSign + 1;
      kUnsigned: nUns := nUns + 1;
      kStruct, kUnion: begin
        if (base <> 0) or (t <> 0) then CErr0(ceTypeMix);
        t := CStructSpec(sym = kUnion); base := 9; sp.any := true;
        continue;
      end;
      kEnum: begin
        if (base <> 0) or (t <> 0) then CErr0(ceTypeMix);
        t := CEnumSpec; base := 9; sp.any := true;
        continue;
      end;
      sIdent: begin
        { a typedef name, only where no type was given yet }
        if (base <> 0) or (t <> 0) or (nLong + nShort + nSign + nUns <> 0) then break;
        s := CLookup(id);
        if (s = 0) or (syms[s].kind <> skType) then break;
        t := syms[s].typ; base := 9;
      end;
    else
      break;
    end;
    sp.any := true;
    CNext;
  until false;
  case base of
    1: t := tVoid;
    2: if nUns > 0 then t := tByte else if nSign > 0 then t := tShort else t := tByte;
    4: t := tReal;
    5: t := tCBool;
    9: ;
  else
    if nLong > 0 then begin if nUns > 0 then t := tLongW else t := tLong; end
    else if nUns > 0 then t := tWord
    else t := tInteger;
  end;
  sp.t := t;
end;

{ ---------------------------------------------------------------- declarators }
{ (  after a declarator's name or nothing: the parameters; ( * or ( ( or ( [
  : a declarator in parentheses }
function CNestedFollows: boolean;
begin
  while (ch = ' ') or (ch = #10) do CNextCh;
  CNestedFollows := (ch = '*') or (ch = '(') or (ch = '[') or (ch = '_');
end;

procedure CAddOp(k: byte; v: longint; f: integer);
begin
  if dN >= 24 then CErr0(ceNested);
  dN := dN + 1;
  dOps[dN].k := k; dOps[dN].v := v; dOps[dN].f := f;
end;

{ a function's parameter list (after its opening parenthesis): the
  parameters in CParBase; the op }
procedure CParamList;
var pt: array[1..16] of integer;
    pn: array[1..16] of TName;
    n, i, fl, save: integer;
    sp: TCSpec;
    t: integer;
    a: longint;
    oldName: TName;
    oldHas: boolean;
begin
  oldName := dName; oldHas := dHasName;
  n := 0; fl := 0;
  CNext;
  if sym = tRpar then fl := cfNoProto
  else
    repeat
      if sym = tEllipsis then begin fl := fl or cfVariadic; CNext; break; end;
      CSpecifiers(sp);
      if not sp.any then CErr0(ceType);
      save := dN;
      dHasName := false; dName := ''; dFar := sp.far;
      CDeclarator(true);
      t := CApply(sp.t, save + 1, dN);
      dN := save;
      if (t = tVoid) and not dHasName and (n = 0) and (sym = tRpar) then break;
      if types[t].form = fArr then t := CPtr(types[t].base, false)
      else if types[t].form = fCFn then t := CPtr(t, false);
      if n >= 16 then CErr0(ceParams);
      n := n + 1;
      pt[n] := t;
      if dHasName then pn[n] := dName else pn[n] := '';
      if sym = tComma then CNext else break;
    until false;
  CExpect(tRpar);
  if cParTop + n > MaxCPar then CErr0(ceParams);
  for i := 1 to n do begin
    a := CParBase + longint(cParTop + i - 1) * 20;
    MemW[a] := pt[i];
    Mem[a + 2] := length(pn[i]);
    for save := 1 to length(pn[i]) do Mem[a + 2 + save] := ord(pn[i][save]);
  end;
  CAddOp(4, cParTop, n + 256 * fl);
  cParTop := cParTop + n;
  dName := oldName; dHasName := oldHas;
end;

function CParType(p: longint): integer;
begin
  CParType := MemW[CParBase + p * 20];
end;

function CParName(p: longint): TName;
var a: longint;
    i: integer;
    r: TName;
begin
  a := CParBase + p * 20;
  r[0] := chr(Mem[a + 2]);
  for i := 1 to Mem[a + 2] do r[i] := chr(Mem[a + 2 + i]);
  CParName := r;
end;

{ a declarator: its operations go to dOps (in the order they make the type),
  its name to dName }
procedure CDeclarator(abstr: boolean);
var stars: array[1..8] of byte;
    suf: array[1..8] of TDOp;
    inner: array[1..12] of TDOp;
    ns, nsuf, ni, i, save: integer;
    far: boolean;
    n: longint;
begin
  ns := 0;
  while sym = tStar do begin
    CNext;
    far := dFar; dFar := false;
    while sym in [kConst, kVolatile, kRestrict, kFar] do begin if sym = kFar then far := true; CNext; end;
    if ns >= 8 then CErr0(ceNested);
    ns := ns + 1;
    if far then stars[ns] := 2 else stars[ns] := 1;
  end;
  ni := 0;
  if (sym = tLpar) and CNestedFollows then begin
    CNext;
    save := dN;
    CDeclarator(abstr);
    for i := save + 1 to dN do begin
      if ni >= 12 then CErr0(ceNested);
      ni := ni + 1; inner[ni] := dOps[i];
    end;
    dN := save;
    CExpect(tRpar);
  end else if sym = sIdent then begin
    dName := id; dHasName := true;
    CNext;
  end;
  nsuf := 0;
  repeat
    if sym = tLbrk then begin
      CNext;
      if sym = tRbrk then n := -1
      else begin
        n := CConstValue;
        if n < 0 then CErr0(ceArrSize);
      end;
      CExpect(tRbrk);
      if nsuf >= 8 then CErr0(ceNested);
      nsuf := nsuf + 1;
      suf[nsuf].k := 3; suf[nsuf].v := n; suf[nsuf].f := 0;
    end else if sym = tLpar then begin
      save := dN;
      CParamList;
      if nsuf >= 8 then CErr0(ceNested);
      nsuf := nsuf + 1;
      suf[nsuf] := dOps[dN];
      dN := save;
    end else if sym = kAttribute then CSkipAttribute
    else break;
  until false;
  for i := 1 to ns do CAddOp(stars[i], 0, 0);
  for i := nsuf downto 1 do CAddOp(suf[i].k, suf[i].v, suf[i].f);
  for i := 1 to ni do CAddOp(inner[i].k, inner[i].v, inner[i].f);
end;

function CApply(t, from, upto: integer): integer;
var i: integer;
begin
  for i := from to upto do
    case dOps[i].k of
      1: t := CPtr(t, false);
      2: t := CPtr(t, true);
      3: t := CArr(t, dOps[i].v);
      4: t := CFnType(t, dOps[i].v, dOps[i].f);
    end;
  CApply := t;
end;

{ a type name (casts, sizeof): specifiers and an abstract declarator }
function CTypeName: integer;
var sp: TCSpec;
    save: integer;
    oldName: TName;
    oldHas: boolean;
begin
  CSpecifiers(sp);
  if not sp.any then CErr0(ceType);
  oldName := dName; oldHas := dHasName;
  save := dN;
  dFar := sp.far;
  CDeclarator(true);
  CTypeName := CApply(sp.t, save + 1, dN);
  dN := save;
  dName := oldName; dHasName := oldHas;
end;
