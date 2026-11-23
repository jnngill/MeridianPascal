{ MERIDIAN Pascal - the IDE on the PASCAL cartridge

  An 80-column editor with the on-device compiler. The source text lives
  in expansion RAM at $20:0000 (lines end with LF); the KRAN blitter moves
  the text on insertions and deletions. A compiled program runs with bank 0
  saved away and comes back to the editor when it ends.

  Keys:  F1 help   F2 save   F3 load   F4 new   F5 compile + run
         F6 drive  F7 standalone .MER  F8 directory   F9 compile   F10 quit to BASIC
         Ctrl+Y delete line   Ctrl+F find   Ctrl+L find again   Ctrl+K colours
         Ctrl+Home / Ctrl+End  start / end of the text
         PgUp PgDn Home End and the cursor keys move }
program PascalIDE;

uses Crt, Graph, Sprites, Audio, Input, Dos, Blitter, Copper, Schub, Basic, NComp, NAsm;

const
  TB = $200000;               { text buffer (= NComp.SrcBase) }
  Stage = $280000;            { loading area }
  MaxText = 60000;
  Rows = 27;                  { text rows on screen (2..28) }
  Cols = 80;
  AttrText = $E6;             { light blue on blue... set below }
  AttrBar = $16;              { white on blue }
  AttrStat = $61;             { blue on white }
  AttrCur = $6E;
  { tables in expansion RAM: bank 0 is short (the compiler's stack) }
  KeyWas = $3C0000;           { a key's press was handled (1 byte a scan code) }
  CkState = $3C0100;          { scanner state at every 256 bytes of text }
  RowPos = $3C0200;           { text position of each row at the last redraw (4 bytes) }

procedure RunUser(entry: longint); external 'runuser';
function RunMerFile: integer; external 'runmer';
{ fast loops in assembler (compiler/cart.js); text offsets are below 64 KB }
function FindLF(p, limit: word): word; external 'findlf';
function LineStartAt(p: word): word; external 'linestart';
procedure DrawRow(scr, text, n: word; attr: pointer; plain: word); external 'drawrow';

var
  Scr: array[0..2399] of word absolute $0400;
  len, cur, top: longint;            { text length, cursor, offset of the first shown line }
  curLine, topLine: integer;         { 1-based line numbers }
  left: integer;                     { first shown column }
  wantCol: integer;
  modified, quit, redrawAll: boolean;
  fileName: string[16];
  msg: string;
  findText: string[40];
  aText, aBar, aStat: byte;
  repT: longint;
  lastRow: integer;
  lastMsg: string;
  lastCur: longint;
  colours: boolean;                  { syntax colours on (Ctrl+K) }
  asmMode: boolean;                  { the text is assembly: its own colours }
  ckValid: longint;                  { checkpoints up to here are valid }
  rowSt, rowEnd: array[0..31] of byte;   { state at the start / after each screen row }
  rowsValid: boolean;                { rowPos still holds (no edit since) }
  cls: array[0..255] of byte;        { character classes for the colours }
  { colour of each column of the line being drawn; the assembler uses the
    same 512 bytes for its buffers while it assembles (bank 0 is short) }
  lineAttr: array[0..511] of byte;
  attrKw, attrComment, attrString, attrNumber: byte;
  plainAttr: array[0..79] of byte;   { colours for a row without syntax colours }
  drawnEnd: longint;                 { end of the line DrawLine drew last }
  scrollBy: integer;                 { lines the screen must scroll (Track) }
  { the mouse: pointer cell (-1 none), the word under it and the word shown }
  ptrCell: integer;
  ptrSaved, ptrWord: word;
  mouseSeen, ptrMoved: boolean;
  lastMX, lastMY: integer;
  lastButtons, lastWheel: byte;
  clickLatch: boolean;               { a left click seen while busy (SampleMouse) }
  latchX, latchY: integer;
  sampleB: byte;
  fLatch: word;                      { F1..F10 pressed while the screen was being drawn }
  startLine, editLine: integer;      { cursor line at the last Refresh; a line edited since, -1 none }

{ ------------------------------------------------------------- text }
function TC(p: longint): char;
begin
  TC := chr(Mem[TB + p]);
end;

function LineStart(p: longint): longint;
begin
  if p > len then p := len;
  LineStart := LineStartAt(p);
end;

function LineEnd(p: longint): longint;
begin
  if p >= len then LineEnd := p else LineEnd := FindLF(p, len);
end;

function ColOf(p: longint): integer;
begin
  ColOf := p - LineStart(p);
end;

function CountLines(upto: longint): integer;
var p: longint;
    n: integer;
begin
  n := 1;
  for p := 0 to upto - 1 do if Mem[TB + p] = 10 then n := n + 1;
  CountLines := n;
end;

{ the text changed at p: the colour checkpoints after p no longer hold }
procedure TextChanged(p: longint);
begin
  if p < ckValid then ckValid := p;
  rowsValid := false;
end;

procedure InsertChars(const s: string);
var n: integer;
    i: integer;
begin
  n := length(s);
  if len + n > MaxText then begin msg := 'TEXT FULL'; exit; end;
  { make room: KRAN copies backwards from the last byte (it takes the right
    end of the row as the address) }
  if len > cur then Blit(TB + len - 1, TB + len - 1 + n, len - cur, 1, 0, 0, bmCopy + bmBackwards, 0);
  BlitWait;
  for i := 1 to n do Mem[TB + cur + i - 1] := ord(s[i]);
  TextChanged(cur);
  len := len + n;
  cur := cur + n;
  modified := true;
end;

procedure DeleteChars(p: longint; n: longint);
begin
  if p + n > len then n := len - p;
  if n <= 0 then exit;
  if p + n < len then begin
    Blit(TB + p + n, TB + p, len - p - n, 1, 0, 0, bmCopy, 0);
    BlitWait;
  end;
  len := len - n;
  TextChanged(p);
  modified := true;
end;

{ ------------------------------------------------------------- screen }
procedure PutStr(x, y: integer; const s: string; attr: byte; width: integer);
var i, o: integer;
    w: word;
begin
  o := (y - 1) * Cols + (x - 1);
  w := word(attr) shl 8;
  for i := 1 to width do
    if i <= length(s) then Scr[o + i - 1] := w or ord(s[i])
    else Scr[o + i - 1] := w or 32;
end;

(* ------------------------------------------------------------- colours
  The scanner's state between characters: normal text, inside a brace
  comment or a paren-star comment, a brace-dollar directive, a string, a //
  comment, and the two halves of the paren-star brackets (so that every step
  takes one character). Comments and directives can run over several lines.
  The state at the start of the screen comes from the rows of the last
  redraw when it can (paging down), otherwise from checkpoints every 256
  bytes of text, which an edit makes invalid from its position on. *)
const
  stNormal = 0; stBrace = 1; stParen = 2; stString = 3; stLine = 4; stDirective = 5;
  stOpening = 6; stClosing = 7;
  CkStep = 256;
  colKeyword = 1; colComment = 13; colString = 7; colNumber = 3; colDirective = 8;
  cLetter = 1; cDigit = 2; cHex = 4;

function IsKeyword(const s: string): boolean;
begin
  case s[1] of
    'a': IsKeyword := (s = 'and') or (s = 'array') or (s = 'absolute');
    'b': IsKeyword := s = 'begin';
    'c': IsKeyword := (s = 'case') or (s = 'const');
    'd': IsKeyword := (s = 'do') or (s = 'div') or (s = 'downto');
    'e': IsKeyword := (s = 'end') or (s = 'else') or (s = 'external');
    'f': IsKeyword := (s = 'for') or (s = 'function') or (s = 'file') or (s = 'forward');
    'g': IsKeyword := s = 'goto';
    'i': IsKeyword := (s = 'if') or (s = 'in') or (s = 'interface') or (s = 'implementation') or (s = 'initialization');
    'l': IsKeyword := s = 'label';
    'm': IsKeyword := s = 'mod';
    'n': IsKeyword := (s = 'not') or (s = 'nil');
    'o': IsKeyword := (s = 'of') or (s = 'or');
    'p': IsKeyword := (s = 'procedure') or (s = 'program') or (s = 'packed');
    'r': IsKeyword := (s = 'repeat') or (s = 'record');
    's': IsKeyword := (s = 'set') or (s = 'shl') or (s = 'shr') or (s = 'string');
    't': IsKeyword := (s = 'then') or (s = 'to') or (s = 'type');
    'u': IsKeyword := (s = 'until') or (s = 'uses') or (s = 'unit');
    'v': IsKeyword := s = 'var';
    'w': IsKeyword := (s = 'while') or (s = 'with');
    'x': IsKeyword := s = 'xor';
  else
    IsKeyword := false;
  end;
end;

{ colour of the characters in a state (low nibble: text, high: background) }
function StateAttr(st: byte): byte;
begin
  case st of
    stBrace, stParen, stLine, stOpening, stClosing: StateAttr := (aText and $F0) or colComment;
    stDirective: StateAttr := (aText and $F0) or colDirective;
    stString: StateAttr := (aText and $F0) or colString;
  else
    StateAttr := aText;
  end;
end;

{ Scan the text from q up to (not including) upto, from state st. With paint,
  the colour of each character goes to lineAttr[col] (one line: upto is its
  end). Every loop takes whole runs (a word, a comment) where it can. }
procedure Scan(var q: longint; upto: longint; var st: byte; paint: boolean; var col: integer);
var c, n, a: byte;
    e: longint;
    i: integer;
    w: string[15];
begin
  while q < upto do begin
    c := Mem[TB + q];
    case st of
      stNormal:
        if (cls[c] and cLetter) <> 0 then begin
          { a word: keyword or name (state unchanged) }
          e := q; i := 0;
          while (e < upto) and ((cls[Mem[TB + e]] and (cLetter or cDigit)) <> 0) do begin
            if i < 15 then begin i := i + 1; w[i] := chr(Mem[TB + e] or 32); end;
            e := e + 1;
          end;
          if paint then begin
            w[0] := chr(i);
            a := aText;
            if (i >= 2) and (i <= 14) then if IsKeyword(w) then a := attrKw;
            while q < e do begin
              if col < 512 then lineAttr[col] := a;
              col := col + 1; q := q + 1;
            end;
          end else q := e;
        end
        else begin
          if q + 1 < len then n := Mem[TB + q + 1] else n := 0;
          a := aText;
          if c = 123 then begin                                   { brace }
            if n = 36 then st := stDirective else st := stBrace;
            a := StateAttr(st);
          end
          else if (c = 40) and (n = 42) then begin st := stOpening; a := attrComment; end
          else if (c = 47) and (n = 47) then begin st := stLine; a := attrComment; end
          else if c = 39 then begin st := stString; a := attrString; end
          else if paint and (((cls[c] and cDigit) <> 0) or ((c = 36) and ((cls[n] and cHex) <> 0))
                  or ((c = 35) and (((cls[n] and cDigit) <> 0) or (n = 36)))) then begin
            { a number, $hex, or a character code #13 #$0D (coloured like strings) }
            if c = 35 then a := attrString else a := attrNumber;
            e := q + 1;
            while (e < upto) and (((cls[Mem[TB + e]] and cHex) <> 0) or (Mem[TB + e] = 36) or
                  ((Mem[TB + e] = 46) and (e + 1 < upto) and ((cls[Mem[TB + e + 1]] and cDigit) <> 0))) do e := e + 1;
            while q + 1 < e do begin
              if col < 512 then lineAttr[col] := a;
              col := col + 1; q := q + 1;
            end;
          end;
          if paint then begin
            if col < 512 then lineAttr[col] := a;
            col := col + 1;
          end;
          q := q + 1;
        end;
      stBrace, stDirective: begin
        { to the closing brace }
        a := StateAttr(st);
        while (q < upto) and (Mem[TB + q] <> 125) do begin
          if paint then begin if col < 512 then lineAttr[col] := a; col := col + 1; end;
          q := q + 1;
        end;
        if q < upto then begin
          if paint then begin if col < 512 then lineAttr[col] := a; col := col + 1; end;
          q := q + 1; st := stNormal;
        end;
      end;
      stOpening, stClosing: begin
        { the second character of a paren-star bracket }
        if paint then begin if col < 512 then lineAttr[col] := attrComment; col := col + 1; end;
        q := q + 1;
        if st = stOpening then st := stParen else st := stNormal;
      end;
      stParen: begin
        { to the closing star-paren }
        while (q < upto) and not ((Mem[TB + q] = 42) and (q + 1 < len) and (Mem[TB + q + 1] = 41)) do begin
          if paint then begin if col < 512 then lineAttr[col] := attrComment; col := col + 1; end;
          q := q + 1;
        end;
        if q < upto then begin
          if paint then begin if col < 512 then lineAttr[col] := attrComment; col := col + 1; end;
          q := q + 1; st := stClosing;
        end;
      end;
      stString: begin
        { to the closing quote or the end of the line }
        while (q < upto) and (Mem[TB + q] <> 39) and (Mem[TB + q] <> 10) do begin
          if paint then begin if col < 512 then lineAttr[col] := attrString; col := col + 1; end;
          q := q + 1;
        end;
        if q < upto then begin
          if paint then begin if col < 512 then lineAttr[col] := attrString; col := col + 1; end;
          q := q + 1; st := stNormal;
        end;
      end;
      stLine: begin
        while (q < upto) and (Mem[TB + q] <> 10) do begin
          if paint then begin if col < 512 then lineAttr[col] := attrComment; col := col + 1; end;
          q := q + 1;
        end;
        if q < upto then begin q := q + 1; st := stNormal; end;
      end;
    end;
  end;
end;

{ assembly: one line at a time (comments end with the line) - ; comments,
  "strings" and 'c' characters, numbers, mnemonics, .directives }
procedure AsmPaint(q, upto: longint);
var c: byte;
    e: longint;
    i, col: integer;
    a: byte;
    w: string[16];
begin
  col := 0;
  while q < upto do begin
    c := Mem[TB + q];
    e := q + 1;
    a := aText;
    if c = 59 then begin e := upto; a := attrComment; end
    else if c = 34 then begin
      while (e < upto) and (Mem[TB + e] <> 34) do e := e + 1;
      if e < upto then e := e + 1;
      a := attrString;
    end
    else if (c = 39) and (q + 2 < upto) and (Mem[TB + q + 2] = 39) then begin e := q + 3; a := attrString; end
    else if ((cls[c] and cDigit) <> 0) or (((c = 36) or (c = 37)) and (q + 1 < upto) and ((cls[Mem[TB + q + 1]] and cHex) <> 0)) then begin
      while (e < upto) and ((cls[Mem[TB + e]] and cHex) <> 0) do e := e + 1;
      a := attrNumber;
    end
    else if ((cls[c] and cLetter) <> 0) or ((c = 46) and (q + 1 < upto) and ((cls[Mem[TB + q + 1]] and cLetter) <> 0)) then begin
      i := 0;
      while (e < upto) and ((cls[Mem[TB + e]] and (cLetter or cDigit)) <> 0) do e := e + 1;
      if c = 46 then a := (aText and $F0) or colDirective
      else if e - q <= 6 then begin
        w[0] := chr(e - q);
        for i := 1 to e - q do w[i] := chr(Mem[TB + q + i - 1]);
        if IsMnemonic(w) then a := attrKw;
      end;
    end;
    while q < e do begin
      if col < 512 then lineAttr[col] := a;
      col := col + 1;
      q := q + 1;
    end;
  end;
end;

function StateAt(p: longint): byte;
{ the state at text position p (the start of a line) }
var k, col: integer;
    q, e: longint;
    st: byte;
begin
  if asmMode then begin StateAt := stNormal; exit; end;
  { a row of the last redraw (paging down: the line after the screen) }
  if rowsValid then
    for k := 2 to Rows + 2 do
      if MemL[RowPos + k * 4] = p then begin StateAt := rowSt[k]; exit; end;
  k := p div CkStep;
  if longint(k) * CkStep > ckValid then k := ckValid div CkStep;
  q := longint(k) * CkStep;
  st := Mem[CkState + k];
  col := 0;
  while q < p do begin
    e := (q div CkStep + 1) * CkStep;
    if e > p then e := p;
    Scan(q, e, st, false, col);
    if q mod CkStep = 0 then begin
      Mem[CkState + q div CkStep] := st;
      if q > ckValid then ckValid := q;
    end;
  end;
  StateAt := st;
end;

function DrawLine(row: integer; p: longint; st: byte): byte;
{ draw the text line starting at p on screen row (2..28); st is the state at
  p, the result the state at the start of the next line }
var col: integer;
    e, q, n: longint;
begin
  e := LineEnd(p);
  drawnEnd := e;
  if colours and asmMode then begin
    AsmPaint(p, e);
    st := stNormal;
  end
  else if colours then begin
    q := p; col := 0;
    Scan(q, e, st, true, col);
    { a line ends strings and // comments }
    if (st = stString) or (st = stLine) then st := stNormal;
  end;
  { the visible part: from column left, at most 80 characters }
  n := e - p - left;
  if n < 0 then n := 0;
  if n > Cols then n := Cols;
  if colours and (left + Cols <= 512) then
    DrawRow($0400 + (row - 1) * Cols * 2, p + left, n, @lineAttr[left], (word(aText) shl 8) or 32)
  else
    DrawRow($0400 + (row - 1) * Cols * 2, p + left, n, @plainAttr[0], (word(aText) shl 8) or 32);
  if not colours then st := stNormal;
  DrawLine := st;
end;


{ the text is assembly: NAME.ASM, or ; as its first character }
function IsAsm: boolean;
begin
  IsAsm := IsAsmText(len, fileName);
end;

function TargetName: string;
begin
  { what F5/F7 will make: Ctrl+T, or $SCHUB / .schub at the top of the text }
  if IsAsm then begin
    if WantSchub or IsAsmSchub(len) then TargetName := 'ASM SCHUB' else TargetName := 'ASM 65C816';
  end
  else if WantSchub or SchubDirective(len) then TargetName := 'SCHUB' else TargetName := '65C816';
end;

procedure DrawStatus;
var s: string;
begin
  s := ' ' + fileName;
  if fileName = '' then s := ' (NO NAME)';
  if modified then s := s + ' *';
  s := s + '   LINE ' + IntToStr(curLine) + '  COL ' + IntToStr(ColOf(cur) + 1) + '   DRIVE ' + IntToStr(CurrentDrive) +
       '   ' + IntToStr(len) + ' BYTES   ' + TargetName;
  PutStr(1, 29, s, aStat, Cols);
  PutStr(1, 30, ' ' + msg, aBar, Cols);
end;

procedure DrawTitle;
begin
  PutStr(1, 1, ' MERIDIAN PASCAL   F1 HELP  F2 SAVE  F3 LOAD  F4 NEW  F5 RUN  F9 COMPILE  F10 END', aBar, Cols);
end;

{ the mouse pointer: the cell under it in black on light grey. It is taken
  away before the screen is drawn; a cell that was drawn anew meanwhile is
  left as it is. Shown only once the mouse has been moved or clicked. }
procedure HidePointer;
begin
  if ptrCell >= 0 then begin
    if Scr[ptrCell] = ptrWord then Scr[ptrCell] := ptrSaved;
    ptrCell := -1;
  end;
end;

procedure ShowPointer;
var c: integer;
begin
  HidePointer;
  if not mouseSeen then exit;
  c := (MouseY div 8) * Cols + MouseX div 8;
  if (c < 0) or (c >= 2400) then exit;
  ptrSaved := Scr[c];
  ptrWord := (ptrSaved and $00FF) or $F000;
  Scr[c] := ptrWord;
  ptrCell := c;
end;

{ notice a left click even while the screen is being drawn: it is kept
  until MouseKeys handles it }
{ the scan code of F1..F10 (i = 0..9) }
function FKeySc(i: integer): integer;
begin
  case i of
    0: FKeySc := $05; 1: FKeySc := $06; 2: FKeySc := $04; 3: FKeySc := $0C; 4: FKeySc := $03;
    5: FKeySc := $0B; 6: FKeySc := $02; 7: FKeySc := $0A; 8: FKeySc := $01;
  else
    FKeySc := $09;
  end;
end;

procedure SampleMouse;
var b: byte;
    i, sc: integer;
begin
  { a function key pressed now is kept until Pressed sees it }
  for i := 0 to 9 do begin
    sc := FKeySc(i);
    if (Mem[$033E00 + sc] <> 0) and (Mem[KeyWas + sc] = 0) then fLatch := fLatch or (1 shl i);
  end;
  b := MouseButtons and 1;
  if (b <> 0) and (sampleB = 0) then begin
    clickLatch := true;
    latchX := MouseX; latchY := MouseY;
  end;
  sampleB := b;
end;

{ mouse range: 640 x 240 in the editor (8 x 8 pixels per character cell),
  the default 320 x 240 while a program runs }
procedure EditorMouse(on: boolean);
begin
  if on then SetMouseLimits(639, 239) else SetMouseLimits(319, 239);
  lastMX := MouseX; lastMY := MouseY; lastButtons := MouseButtons; Mem[$C12A] := 0; lastWheel := Mem[$C125];
  sampleB := lastButtons and 1; clickLatch := false;
  ptrCell := -1;
end;

procedure ShowCursor(on: boolean);
var o, x: integer;
    w: word;
begin
  x := ColOf(cur) - left;
  if (x < 0) or (x >= Cols) then exit;
  o := (curLine - topLine + 1) * Cols + x;
  w := Scr[o];
  { swap foreground and background }
  Scr[o] := (w and $00FF) or (((w shr 4) and $0F00) or ((w shl 4) and $F000));
end;

procedure Redraw;
var r, col: integer;
    p, b, q: longint;
    st, cst: byte;
begin
  p := top;
  if colours then st := StateAt(top) else st := stNormal;
  for r := 2 to Rows + 2 do MemL[RowPos + r * 4] := -1;
  for r := 2 to Rows + 1 do begin
    SampleMouse;
    MemL[RowPos + r * 4] := p;
    rowSt[r] := st;
    st := DrawLine(r, p, st);
    rowEnd[r] := st;
    { checkpoints inside this line, while they follow on from the valid
      ones: paging up then finds one close by }
    if colours and not asmMode then begin
      b := (ckValid div CkStep + 1) * CkStep;
      while (b >= p) and (b <= drawnEnd) and (b <= len) do begin
        q := p; cst := rowSt[r]; col := 0;
        Scan(q, b, cst, false, col);
        Mem[CkState + b div CkStep] := cst;
        ckValid := b;
        b := b + CkStep;
      end;
    end;
    p := drawnEnd;
    if p < len then p := p + 1 else p := len + 1;
    if p > len then begin
      { past the end: empty rows }
      while r < Rows + 1 do begin r := r + 1; PutStr(1, r, '', aText, Cols); end;
      break;
    end;
  end;
  { the line after the screen: paging down starts there }
  if p <= len then begin MemL[RowPos + (Rows + 2) * 4] := p; rowSt[Rows + 2] := st; end;
  { the row states only mean something when they were worked out }
  rowsValid := colours;
end;

{ make the cursor visible: adjust top and left }
procedure Track;
var c: integer;
begin
  { vertical scrolling: Refresh moves the rows on the screen (ScrollRows) }
  while curLine < topLine do begin
    top := LineStart(top - 1);
    topLine := topLine - 1;
    scrollBy := scrollBy - 1;
  end;
  while curLine > topLine + Rows - 1 do begin
    top := LineEnd(top) + 1;
    topLine := topLine + 1;
    scrollBy := scrollBy + 1;
  end;
  c := ColOf(cur);
  if c < left then begin left := (c div 20) * 20; redrawAll := true; end;
  if c >= left + Cols then begin left := c - Cols + 20; redrawAll := true; end;
end;

function RowStart(row: integer): longint;
var p: longint;
    i: integer;
begin
  p := top;
  for i := 3 to row do if p <= len then p := LineEnd(p) + 1;
  RowStart := p;
end;

{ the text moved by d lines on the screen (d > 0: down the text): move the
  rows that stay with the blitter and draw only the new ones }
procedure ScrollRows(d: integer);
var r, n: integer;
    p: longint;
    st: byte;
begin
  if d > 0 then begin
    n := Rows - d;
    Blit($0400 + longint(1 + d) * Cols * 2, $0400 + Cols * 2, n * Cols * 2, 1, 0, 0, bmCopy, 0);
    for r := 2 to 1 + n do begin rowSt[r] := rowSt[r + d]; rowEnd[r] := rowEnd[r + d]; end;
    BlitWait;
    st := rowEnd[1 + n];
    p := RowStart(2 + n);
    for r := 2 + n to Rows + 1 do begin
      rowSt[r] := st;
      if p <= len then begin
        st := DrawLine(r, p, st);
        p := LineEnd(p) + 1;
      end else PutStr(1, r, '', aText, Cols);
      rowEnd[r] := st;
    end;
  end else begin
    d := -d;
    n := Rows - d;
    { backwards from the last byte (KRAN takes the right end as the address) }
    Blit($0400 + longint(1 + n) * Cols * 2 - 1, $0400 + longint(1 + n + d) * Cols * 2 - 1, n * Cols * 2, 1, 0, 0,
         bmCopy + bmBackwards, 0);
    for r := Rows + 1 downto 2 + d do begin rowSt[r] := rowSt[r - d]; rowEnd[r] := rowEnd[r - d]; end;
    BlitWait;
    if colours then st := StateAt(top) else st := stNormal;
    p := top;
    for r := 2 to 1 + d do begin
      rowSt[r] := st;
      st := DrawLine(r, p, st);
      rowEnd[r] := st;
      p := LineEnd(p) + 1;
    end;
    { the rows below begin as they did }
    if st <> rowSt[2 + d] then redrawAll := true;
  end;
  rowsValid := false;
end;

procedure Refresh;
var row: integer;
    p: longint;
begin
  HidePointer;
  Track;
  if IsAsm <> asmMode then begin asmMode := not asmMode; redrawAll := true; TextChanged(0); end;
  { an edit on a row that is neither the old nor the new cursor row }
  if (editLine <> -1) and (editLine <> curLine) then redrawAll := true;
  if (scrollBy <> 0) and not redrawAll then begin
    if abs(scrollBy) < Rows - 2 then begin
      ScrollRows(scrollBy);
      lastRow := lastRow - scrollBy;
    end else redrawAll := true;
  end;
  scrollBy := 0;
  row := curLine - topLine + 2;
  if not redrawAll then begin
    { the old cursor row (it may have changed) and the new one; a change that
      opens or closes a comment colours the rows below anew }
    if (lastRow <> row) and (lastRow >= 2) and (lastRow <= Rows + 1) then begin
      p := RowStart(lastRow);
      if p <= len then begin
        if DrawLine(lastRow, p, rowSt[lastRow]) <> rowEnd[lastRow] then redrawAll := true;
      end else PutStr(1, lastRow, '', aText, Cols);
    end;
    if not redrawAll then
      if DrawLine(row, LineStart(cur), rowSt[row]) <> rowEnd[row] then redrawAll := true;
  end;
  if redrawAll then Redraw;
  redrawAll := false;
  startLine := curLine;
  editLine := -1;
  lastRow := row;
  lastMsg := msg;
  lastCur := cur;
  DrawStatus;
  ShowCursor(true);
  ShowPointer;
  ptrMoved := false;
end;

{ ------------------------------------------------------------- cursor }
procedure JumpTo(p: longint);
begin
  if p < 0 then p := 0;
  if p > len then p := len;
  cur := p;
  curLine := CountLines(cur);
  top := LineStart(cur);
  topLine := curLine;
  { show some lines above }
  while (topLine > 1) and (curLine - topLine < Rows div 3) do begin
    top := LineStart(top - 1);
    topLine := topLine - 1;
  end;
  wantCol := ColOf(cur);
  redrawAll := true;
end;

procedure GoToLine(n: integer; col: integer);
var p: longint;
    l: integer;
begin
  p := 0; l := 1;
  while (l < n) and (p < len) do begin
    if Mem[TB + p] = 10 then l := l + 1;
    p := p + 1;
  end;
  if col > 1 then begin
    while (col > 1) and (p < len) and (Mem[TB + p] <> 10) do begin p := p + 1; col := col - 1; end;
  end;
  JumpTo(p);
end;

procedure MoveToCol(ls: longint);
var le: longint;
begin
  le := LineEnd(ls);
  if ls + wantCol < le then cur := ls + wantCol else cur := le;
end;

procedure CurUp;
begin
  if curLine = 1 then exit;
  MoveToCol(LineStart(LineStart(cur) - 1));
  curLine := curLine - 1;
end;

procedure CurDown;
var le: longint;
begin
  le := LineEnd(cur);
  if le >= len then exit;
  MoveToCol(le + 1);
  curLine := curLine + 1;
end;

procedure CurLeft;
begin
  if cur = 0 then exit;
  cur := cur - 1;
  if Mem[TB + cur] = 10 then curLine := curLine - 1;
  wantCol := ColOf(cur);
end;

procedure CurRight;
begin
  if cur >= len then exit;
  if Mem[TB + cur] = 10 then curLine := curLine + 1;
  cur := cur + 1;
  wantCol := ColOf(cur);
end;

{ ------------------------------------------------------------- editing }
procedure NewLine;
var ls, p: longint;
    ind: string;
begin
  { keep the indentation of the line }
  ls := LineStart(cur);
  ind := #10;
  p := ls;
  while (p < cur) and (Mem[TB + p] = 32) and (length(ind) < 60) do begin ind := ind + ' '; p := p + 1; end;
  InsertChars(ind);
  curLine := curLine + 1;
  wantCol := ColOf(cur);
  redrawAll := true;
end;

procedure Backspace;
begin
  if cur = 0 then exit;
  if Mem[TB + cur - 1] = 10 then begin curLine := curLine - 1; redrawAll := true; end;
  cur := cur - 1;
  DeleteChars(cur, 1);
  wantCol := ColOf(cur);
end;

procedure DeleteKey;
begin
  if cur >= len then exit;
  if Mem[TB + cur] = 10 then redrawAll := true;
  DeleteChars(cur, 1);
end;

procedure DeleteLine;
var ls, le: longint;
begin
  ls := LineStart(cur);
  le := LineEnd(cur);
  if le < len then le := le + 1;
  DeleteChars(ls, le - ls);
  cur := ls;
  if cur > len then cur := len;
  wantCol := 0;
  redrawAll := true;
end;

{ ------------------------------------------------------------- prompts }
function Prompt(const question: string; var answer: string; maxLen: integer): boolean;
var k: char;
    done: boolean;
begin
  Prompt := false;
  done := false;
  FlushKeys;
  repeat
    PutStr(1, 30, ' ' + question + ' ' + answer + '_', aBar, Cols);
    k := ReadKey;
    if k = #13 then begin done := true; Prompt := true; end
    else if k = #3 then done := true
    else if k = #8 then begin if length(answer) > 0 then answer[0] := chr(length(answer) - 1); end
    else if (k >= ' ') and (k < #127) and (length(answer) < maxLen) then answer := answer + k;
  until done;
  msg := '';
end;

function YesNo(const question: string): boolean;
var k: char;
begin
  PutStr(1, 30, ' ' + question + ' (Y/N)', aBar, Cols);
  FlushKeys;
  repeat k := UpCase(ReadKey) until (k = 'Y') or (k = 'N') or (k = #3);
  YesNo := k = 'Y';
  msg := '';
end;

procedure WaitAnyKey;
var k: char;
    b, b0: byte;
begin
  FlushKeys;
  b0 := MouseButtons and 1;
  repeat
    if KeyPressed then begin k := ReadKey; exit; end;
    b := MouseButtons and 1;
    if (b <> 0) and (b0 = 0) then begin
      { wait for the button to be let go, so the click does nothing else }
      while (MouseButtons and 1) <> 0 do ;
      sampleB := 0; clickLatch := false;
      exit;
    end;
    b0 := b;
  until false;
end;

{ ------------------------------------------------------------- files }
function WithExt(const n: string): string;
begin
  if Pos('.', n) = 0 then WithExt := UpperCase(n) + '.PAS' else WithExt := UpperCase(n);
end;

procedure SaveText;
var n: string;
begin
  n := fileName;
  if not Prompt('SAVE AS:', n, 12) then exit;
  if n = '' then exit;
  n := WithExt(n);
  msg := 'SAVING ' + n + ' ...';
  DrawStatus;
  if SaveFile(n, TB, len) then begin
    fileName := n; modified := false;
    msg := 'SAVED ' + n + ' (' + IntToStr(len) + ' BYTES) ON DRIVE ' + IntToStr(CurrentDrive);
  end else msg := 'SAVE FAILED: ' + DosErrorText(DosError);
end;

procedure RunNamed(n: string); forward;

procedure LoadText;
var n: string;
    got, i: longint;
    b: byte;
    lastCR: boolean;
begin
  if modified then if not YesNo('THE TEXT IS NOT SAVED. LOAD ANYWAY?') then exit;
  n := '';
  if not Prompt('LOAD:', n, 12) then exit;
  if n = '' then exit;
  n := WithExt(n);
  if Pos('.MER', n) > 0 then begin RunNamed(n); exit; end;
  msg := 'LOADING ' + n + ' ...';
  DrawStatus;
  got := LoadFile(n, Stage, MaxText);
  if got < 0 then begin msg := 'LOAD FAILED: ' + DosErrorText(DosError); exit; end;
  { line ends: CR LF, CR or LF -> LF; tabs -> two spaces }
  len := 0; TextChanged(0);
  lastCR := false;
  for i := 0 to got - 1 do begin
    b := Mem[Stage + i];
    if b = 13 then begin Mem[TB + len] := 10; len := len + 1; lastCR := true; end
    else if (b = 10) and lastCR then lastCR := false
    else begin
      lastCR := false;
      if b = 9 then begin Mem[TB + len] := 32; Mem[TB + len + 1] := 32; len := len + 2; end
      else begin Mem[TB + len] := b; len := len + 1; end;
    end;
    if len >= MaxText - 2 then break;
  end;
  fileName := n;
  modified := false;
  left := 0;
  JumpTo(0);
  msg := 'LOADED ' + n + ' (' + IntToStr(len) + ' BYTES)';
end;

procedure Directory;
var i, r, c: integer;
    n: string;
    sz: longint;
begin
  for r := 2 to Rows + 1 do PutStr(1, r, '', aText, Cols);
  PutStr(1, 2, ' DIRECTORY OF DRIVE ' + IntToStr(CurrentDrive), aText, Cols);
  i := 0; r := 4; c := 2;
  while DirEntry(i, n, sz) do begin
    PutStr(c, r, n + '  ' + IntToStr(sz), aText, 24);
    r := r + 1;
    if r > Rows then begin r := 4; c := c + 26; if c > 60 then break; end;
    i := i + 1;
  end;
  if (i = 0) and (DosError <> 2) then PutStr(2, 4, DosErrorText(DosError), aText, 40);
  PutStr(2, Rows + 1, IntToStr(DiskFree) + ' BYTES FREE.  PRESS A KEY.', aText, 60);
  WaitAnyKey;
  redrawAll := true;
end;

procedure NewText;
const T1 = 'program Hello;';
      T2 = 'uses Crt;';
      T3 = 'begin';
      T4 = '  ClrScr;';
      T5 = '  WriteLn(''HELLO FROM THE MERIDIAN!'');';
      T6 = 'end.';
begin
  len := 0; cur := 0; TextChanged(0);
  InsertChars(T1 + #10 + T2 + #10 + #10 + T3 + #10 + T4 + #10 + T5 + #10 + T6 + #10);
  fileName := '';
  modified := false;
  left := 0;
  JumpTo(0);
end;

{ ------------------------------------------------------------- compiler }
{ messages built a piece at a time: every string expression takes room
  on the stack, which bank 0 has little of }
procedure Add(const s: string);
begin
  msg := msg + s;
end;

procedure AddNum(v: longint);
begin
  msg := msg + IntToStr(v);
end;

procedure AddHex(v: longint);
begin
  msg := msg + IntToHex(v, 6);
end;

function Compile: boolean;
var t: longint;
    ok: boolean;
begin
  Compile := false;
  t := Frames;
  if IsAsm then begin
    msg := 'ASSEMBLING ...';
    DrawStatus;
    ok := AssembleSource(len, WantSchub or IsAsmSchub(len));
    if ok then begin
      msg := 'OK: '; AddNum(AsmLines); Add(' LINES, '); AddNum(AsmSize); Add(' BYTES AT $');
      AddHex(AsmOrigin); Add(', '); AddNum((Frames - t) * 10 div 6); Add('0 MS');
    end;
  end else begin
    msg := 'COMPILING ...';
    DrawStatus;
    ok := CompileSource(len);
    if ok then begin
      msg := 'OK: '; AddNum(LinesDone); Add(' LINES, '); AddNum(CodeSize); Add(' BYTES CODE, ');
      AddNum(DataSize); Add(' BYTES DATA, '); AddNum((Frames - t) * 10 div 6); Add('0 MS');
    end;
  end;
  if ok then Compile := true
  else begin
    if ErrUnit <> '' then begin
      msg := 'ERROR IN '; Add(ErrUnit); Add(' LINE '); AddNum(ErrLine); Add(': '); Add(UpperCase(ErrMsg));
    end
    else begin
      msg := 'ERROR LINE '; AddNum(ErrLine); Add(': '); Add(UpperCase(ErrMsg));
      GoToLine(ErrLine, ErrCol);
    end;
  end;
end;

{ F7: compile and save a .MER that runs from BASIC without the cartridge }
procedure MakeMer;
var n: string;
    p: integer;
    ok: boolean;
begin
  if not Compile then exit;
  n := fileName;
  p := Pos('.', n);
  if p > 0 then n := Copy(n, 1, p - 1);
  if not Prompt('SAVE PROGRAM AS:', n, 8) then exit;
  if n = '' then exit;
  p := Pos('.', n);
  if p > 0 then n := Copy(n, 1, p - 1);
  n := UpperCase(n) + '.MER';
  msg := 'SAVING ' + n + ' ...';
  DrawStatus;
  if IsAsm then ok := SaveAsmMer(n) else ok := SaveStandalone(n);
  if ok then begin
    msg := 'SAVED '; Add(n);
    if not IsAsm then begin Add(' ('); AddNum(MerSize); Add(' BYTES)'); end;
    Add(' - IN BASIC: BRUN "'); Add(Copy(n, 1, Pos('.', n) - 1)); Add('"');
  end
  else msg := UpperCase(ErrMsg);
end;

{ Ctrl+R (or F3 with a .MER name): run a program file from the current drive }
procedure RunNamed(n: string);
var r, e, i: integer;
begin
  if Pos('.', n) = 0 then n := n + '.MER';
  n := UpperCase(n);
  msg := 'RUNNING ' + n + ' ...';
  DrawStatus;
  Mem[$16C0] := CurrentDrive;
  Mem[$16C3] := 0; Mem[$16C4] := 0; Mem[$16C5] := 0;
  Mem[$16C6] := length(n);
  for i := 1 to length(n) do Mem[$16C6 + i] := ord(n[i]);
  Mem[$16E4] := $FF; Mem[$16E5] := $FF; Mem[$16E6] := $FF;
  MemL[$16E8] := $7FFFFFFF;
  EditorMouse(false);
  r := KernelMode(40);
  e := RunMerFile;
  if e = 0 then begin
    WriteLn;
    Write('-- PRESS A KEY --');
    WaitAnyKey;
  end;
  ResetDisplay;
  r := KernelMode(80);
  EditorMouse(true);
  DrawTitle;
  redrawAll := true;
  if e = 0 then msg := n + ' ENDED.' else msg := 'CANNOT RUN ' + n + ': ' + DosErrorText(e);
end;

procedure RunFile;
var n: string;
    p: integer;
begin
  n := fileName;
  p := Pos('.', n);
  if p > 0 then n := Copy(n, 1, p - 1);
  if not Prompt('RUN PROGRAM FILE (.MER):', n, 12) then exit;
  if n <> '' then RunNamed(n);
end;

procedure RunProgram;
var r: integer;
    isA: boolean;
begin
  if not Compile then exit;
  isA := IsAsm;
  if isA then if not AsmPrepareRun then begin msg := UpperCase(ErrMsg); exit; end;
  EditorMouse(false);
  r := KernelMode(40);
  if isA then RunUser(RunAt)
  else begin
    PrepareRun;
    RunUser(RunEntry);
  end;
  WriteLn;
  Write('-- PRESS A KEY --');
  WaitAnyKey;
  ResetDisplay;
  r := KernelMode(80);
  EditorMouse(true);
  DrawTitle;
  redrawAll := true;
  msg := 'PROGRAM ENDED.';
end;

procedure Help;
var r: integer;
procedure L(const s: string);
begin
  PutStr(2, r, s, aText, 78);
  r := r + 1;
end;
begin
  for r := 2 to Rows + 1 do PutStr(1, r, '', aText, Cols);
  r := 2;
  L('MERIDIAN PASCAL - ON THE MERIDIAN 816');
  L('');
  L('F1  THIS HELP          F2  SAVE              F3  LOAD');
  L('F4  NEW TEXT           F5  COMPILE AND RUN   F6  NEXT DRIVE (1, 2, 3)');
  L('F7  SAVE AS .MER (RUNS WITHOUT THE CARTRIDGE)');
  L('F8  DIRECTORY          F9  COMPILE           F10 BACK TO BASIC');
  L('CTRL+Y DELETE LINE     CTRL+F FIND           CTRL+L FIND AGAIN');
  L('CTRL+T TARGET 65C816 / SCHUB (OR {$SCHUB} AT THE TOP OF THE TEXT)');
  L('CTRL+R RUN A PROGRAM FILE (.MER) FROM THE DRIVE (ALSO F3 WITH NAME.MER)');
  L('CTRL+HOME/END START/END OF TEXT   CTRL+K COLOURS ON/OFF   PGUP PGDN HOME END');
  L('MOUSE: CLICK PLACES THE CURSOR, WHEEL SCROLLS, CLICK F-KEYS ON THE TOP LINE');
  L('THE LANGUAGE: PROGRAM, USES, CONST, TYPE, VAR, PROCEDURE, FUNCTION (NESTED),');
  L('INTEGER WORD BYTE SHORTINT LONGINT REAL CHAR BOOLEAN STRING[N] ARRAYS RECORDS');
  L('(ALSO VARIANT), SETS, POINTERS, ENUMS, SUBRANGES, IF WHILE REPEAT FOR CASE');
  L('WITH, EXIT BREAK CONTINUE, WRITE(LN) READ(LN) INC DEC NEW DISPOSE HALT STR');
  L('INCLUDE EXCLUDE TRUNC ROUND SQRT, MEM[] MEMW[] MEML[], ABSOLUTE, TYPED CONSTS.');
  L('FUNCTIONS CAN RETURN RECORDS, ARRAYS AND SETS. AND/OR STOP EARLY.');
  L('ALL LIBRARY UNITS ARE BUILT IN: CRT GRAPH SPRITES AUDIO BASIC');
  L('INPUT DOS BLITTER COPPER SCHUB AND SYSTEM (COPY POS SIN COS RANDOM ...).');
  L('ASSEMBLER: NAME.ASM OR ; ON TOP. 65C816 (ENDS WITH RTL); .SCHUB: RISC-V');
  L('YOUR OWN UNITS: USES MYUNIT READS MYUNIT.PAS FROM THE CURRENT DRIVE');
  L('(UNIT, INTERFACE, IMPLEMENTATION, BEGIN OR INITIALIZATION ... END.).');
  L('SCHUB PROGRAMS RUN ON THE RISC-V CO-PROCESSOR (SDRAM MODULE, SCHUB ON):');
  L('32-BIT POINTERS, VARIABLES AND HEAP UP TO ABOUT 1 MB.');
  L('PROGRAMS RUN IN 40 COLUMNS; ESC IN READKEY OR READLN ENDS THEM.');
  L('');
  L('PRESS A KEY.');
  WaitAnyKey;
  redrawAll := true;
end;

procedure Find(again: boolean);
var s: string;
    p, i: longint;
    n: integer;
    ok: boolean;
begin
  if not again or (findText = '') then begin
    s := findText;
    if not Prompt('FIND:', s, 40) then exit;
    findText := UpperCase(s);
  end;
  n := length(findText);
  if n = 0 then exit;
  p := cur + 1;
  while p + n <= len do begin
    ok := true;
    i := 0;
    while ok and (i < n) do begin
      if UpCase(TC(p + i)) <> findText[i + 1] then ok := false;
      i := i + 1;
    end;
    if ok then begin JumpTo(p); msg := ''; exit; end;
    p := p + 1;
  end;
  msg := '"' + findText + '" NOT FOUND';
end;

{ ------------------------------------------------------------- keys }
function Held(sc: integer): boolean;
begin
  Held := Mem[$033E00 + sc] <> 0;
end;

{ true once per press, repeating while held }
function Pressed(sc: integer): boolean;
var now: boolean;
    i: integer;
begin
  Pressed := false;
  now := Held(sc);
  if fLatch <> 0 then
    for i := 0 to 9 do
      if (FKeySc(i) = sc) and ((fLatch and (1 shl i)) <> 0) then begin
        fLatch := fLatch and not (1 shl i);
        if Mem[KeyWas + sc] = 0 then now := true;
      end;
  if now and (Mem[KeyWas + sc] = 0) then begin
    Mem[KeyWas + sc] := 1;
    repT := Frames + 20;
    Pressed := true;
  end else if now and (Frames >= repT) then begin
    repT := Frames + 3;
    Pressed := true;
  end else if not now then Mem[KeyWas + sc] := 0;
end;

function Ctrl: boolean;
begin
  Ctrl := Held($14) or Held($94);
end;

{ what F1..F10 do (keys, and clicks on the top line) }
procedure FKey(n: integer);
var d, i: integer;
begin
  case n of
    1: Help;
    2: SaveText;
    3: LoadText;
    4: if not modified or YesNo('THE TEXT IS NOT SAVED. CLEAR IT?') then NewText;
    5: RunProgram;
    6: begin
         d := CurrentDrive + 1;
         if d > 3 then d := 1;
         SetDrive(d);
         msg := 'DRIVE ' + IntToStr(d);
       end;
    7: MakeMer;
    8: Directory;
    9: i := ord(Compile);
    10: if not modified or YesNo('THE TEXT IS NOT SAVED. QUIT ANYWAY?') then quit := true;
  end;
end;

procedure CommandKeys;
var i: integer;
begin
  if Pressed($05) then FKey(1);
  if Pressed($06) then FKey(2);
  if Pressed($04) then FKey(3);
  if Pressed($0C) then FKey(4);
  if Pressed($03) then FKey(5);
  if Pressed($0B) then FKey(6);
  if Pressed($02) then FKey(7);
  if Pressed($0A) then FKey(8);
  if Pressed($01) then FKey(9);
  if Pressed($09) then FKey(10);
  if Pressed($80 + $7D) then for i := 1 to Rows - 1 do CurUp;      { PgUp }
  if Pressed($80 + $7A) then for i := 1 to Rows - 1 do CurDown;    { PgDn }
  if Pressed($80 + $69) then begin                                  { End }
    if Ctrl then JumpTo(len) else begin cur := LineEnd(cur); wantCol := ColOf(cur); end;
  end;
  if Ctrl then begin
    if Pressed(scY) then DeleteLine;
    if Pressed(scF) then Find(false);
    if Pressed(scL) then Find(true);
    if Pressed($2D) then RunFile;                                  { Ctrl+R }
    if Pressed(scT) then begin
      WantSchub := not WantSchub;
      if WantSchub then msg := 'TARGET: SCHUB (RISC-V CO-PROCESSOR)'
      else if SchubDirective(len) then msg := 'TARGET: SCHUB ($SCHUB AT THE TOP OF THE TEXT)'
      else msg := 'TARGET: 65C816';
    end;
    if Pressed(scK) then begin                                     { Ctrl+K }
      colours := not colours;
      rowsValid := false;
      if colours then msg := 'COLOURS ON' else msg := 'COLOURS OFF';
      redrawAll := true;
    end;
    if Pressed($80 + $6C) then JumpTo(0);                             { Ctrl+Home }
  end;
end;

{ ------------------------------------------------------------- mouse }
{ the view moves by n lines (n > 0: down the text); the cursor stays where
  it is unless it would leave the screen }
procedure ScrollView(n: integer);
var i: integer;
begin
  if n > 0 then begin
    for i := 1 to n do
      if LineEnd(top) < len then begin
        top := LineEnd(top) + 1;
        topLine := topLine + 1;
        scrollBy := scrollBy + 1;
      end;
    while curLine < topLine do CurDown;
  end else begin
    for i := 1 to -n do
      if topLine > 1 then begin
        top := LineStart(top - 1);
        topLine := topLine - 1;
        scrollBy := scrollBy - 1;
      end;
    while curLine > topLine + Rows - 1 do CurUp;
  end;
end;

{ the cursor to screen row (2..28) and column (0..79), or as near as the
  text allows }
procedure PlaceCursor(row, col: integer);
var p, e: longint;
    line: integer;
begin
  p := top; line := topLine;
  while (line < topLine + row - 2) and (LineEnd(p) < len) do begin
    p := LineEnd(p) + 1;
    line := line + 1;
  end;
  e := LineEnd(p);
  if p + left + col < e then cur := p + left + col else cur := e;
  curLine := line;
  wantCol := ColOf(cur);
end;

{ a click on the top line: the F-key whose name is under it }
procedure TitleClick(col: integer);
const Title = ' MERIDIAN PASCAL   F1 HELP  F2 SAVE  F3 LOAD  F4 NEW  F5 RUN  F9 COMPILE  F10 END';
var i, p: integer;
    nm: string[12];
begin
  for i := 1 to 10 do begin
    case i of
      1: nm := 'F1 HELP'; 2: nm := 'F2 SAVE'; 3: nm := 'F3 LOAD'; 4: nm := 'F4 NEW';
      5: nm := 'F5 RUN'; 9: nm := 'F9 COMPILE'; 10: nm := 'F10 END';
    else
      nm := '';
    end;
    if nm <> '' then begin
      p := Pos(nm, Title);
      if (p > 0) and (col >= p - 1) and (col < p - 1 + length(nm)) then begin FKey(i); exit; end;
    end;
  end;
end;

procedure MouseKeys;
var x, y, row, col, d: integer;
    b, w: byte;
begin
  SampleMouse;
  x := MouseX; y := MouseY; b := MouseButtons; Mem[$C12A] := 0; w := Mem[$C125];
  if (x <> lastMX) or (y <> lastMY) or (b <> lastButtons) or (w <> lastWheel) or clickLatch then mouseSeen := true;
  if not mouseSeen then exit;
  col := x div 8; row := y div 8 + 1;
  { the wheel: three lines a notch, forward = towards the start }
  d := integer(w) - integer(lastWheel);
  if d > 127 then d := d - 256;
  if d < -128 then d := d + 256;
  if d <> 0 then ScrollView(-3 * d);
  if clickLatch then begin
    { pressed (maybe let go again already): where it was pressed }
    clickLatch := false;
    lastButtons := b or 1;
    col := latchX div 8; row := latchY div 8 + 1;
      if row = 1 then TitleClick(col)
      else if row = 30 then begin
        if Copy(msg, 1, 11) = 'ERROR LINE ' then GoToLine(ErrLine, ErrCol);
      end
      else if (row >= 2) and (row <= Rows + 1) then PlaceCursor(row, col);
  end
  else if ((b and 1) <> 0) and (row >= 2) and (row <= Rows + 1) and ((x div 8 <> lastMX div 8) or (y div 8 <> lastMY div 8)) then
    PlaceCursor(row, col);                       { dragged: the cursor follows }
  if (x div 8 <> lastMX div 8) or (y div 8 <> lastMY div 8) then ptrMoved := true;
  lastMX := x; lastMY := y; lastButtons := MouseButtons; lastWheel := w;
end;

{ an edit on another line than the one Refresh last drew the cursor on }
procedure NoteEdit;
begin
  if curLine <> startLine then begin
    if (editLine <> -1) and (editLine <> curLine) then redrawAll := true;
    editLine := curLine;
  end;
end;

procedure TypedKey(k: char);
begin
  if (k = #8) or (k = #127) or (k = #9) or (k >= ' ') then NoteEdit;
  case k of
    #13: NewLine;
    #8: Backspace;
    #127: DeleteKey;
    #28: CurRight;
    #29: CurLeft;
    #30: CurUp;
    #31: CurDown;
    #1: if not Ctrl then begin cur := LineStart(cur); wantCol := 0; end;
    #9: InsertChars('  ');
  else
    if (k >= ' ') and (k <> #127) then InsertChars(k);
  end;
end;

{ ------------------------------------------------------------- main }
var k: char;
    i: integer;
    r: integer;
begin
  CheckBreak := false;
  aText := $6E;        { light blue on blue, like BASIC }
  aBar := $16;         { blue on white }
  aStat := $61;
  colours := true;
  asmMode := false;
  AsmWorkPtr := PAsmWork(@lineAttr);
  scrollBy := 0; startLine := 1; editLine := -1;
  ckValid := 0; Mem[CkState] := stNormal; rowsValid := false;
  attrKw := (aText and $F0) or colKeyword;
  attrComment := (aText and $F0) or colComment;
  attrString := (aText and $F0) or colString;
  attrNumber := (aText and $F0) or colNumber;
  for i := 0 to Cols - 1 do plainAttr[i] := aText;
  for i := 0 to 255 do cls[i] := 0;
  for i := ord('a') to ord('z') do cls[i] := cLetter;
  for i := ord('A') to ord('Z') do cls[i] := cLetter;
  cls[ord('_')] := cLetter;
  for i := ord('0') to ord('9') do cls[i] := cDigit + cHex;
  for i := ord('a') to ord('f') do cls[i] := cLetter + cHex;
  for i := ord('A') to ord('F') do cls[i] := cLetter + cHex;
  r := KernelMode(80);
  mouseSeen := false; ptrMoved := false; clickLatch := false; fLatch := 0;
  EditorMouse(true);
  for i := 0 to 255 do Mem[KeyWas + i] := 0;
  SetDrive(1);
  findText := '';
  msg := 'WELCOME TO MERIDIAN PASCAL. F1 FOR HELP.';
  if not CartPresent then msg := 'CARTRIDGE DIRECTORY MISSING';
  NewText;
  DrawTitle;
  redrawAll := true;
  quit := false;
  lastRow := 0;
  Refresh;
  repeat
    if KeyPressed then begin
      { all keys that are waiting first, then one screen update: holding a
        cursor key scrolls as fast as the screen can follow and stops when
        the key is let go }
      i := 0;
      repeat
        k := ReadKey;
        if not Ctrl then TypedKey(k);
        i := i + 1;
      until not KeyPressed or (i >= 64);
      Refresh;
    end else begin
      CommandKeys;
      MouseKeys;
      if redrawAll or (msg <> lastMsg) or (cur <> lastCur) or (scrollBy <> 0) or ptrMoved then Refresh;
    end;
  until quit;
  EditorMouse(false);
  ResetDisplay;
  r := KernelMode(40);
end.
