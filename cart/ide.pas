{ MERIDIAN Pascal - the IDE on the PASCAL cartridge

  An 80-column editor with the on-device compiler. The source text lives
  in expansion RAM at $20:0000 (lines end with LF); the KRAN blitter moves
  the text on insertions and deletions. A compiled program runs with bank 0
  saved away and comes back to the editor when it ends.

  Keys:  F1 help   F2 save   F3 load   F4 new   F5 compile + run
         F6 drive  F7 standalone .MER  F8 directory   F9 compile   F10 quit to BASIC
         Ctrl+Y delete line   Ctrl+F find   Ctrl+G find again   Ctrl+L go to line
         Ctrl+K colours   as in EDIT: Ctrl+S save, Ctrl+O open, Ctrl+N new,
         Ctrl+X cut line (in a row: collect), Ctrl+C copy line, Ctrl+V paste
         Ctrl+Home / Ctrl+End  start / end of the text
         PgUp PgDn Home End and the cursor keys move }
program PascalIDE;

uses Crt, Graph, Sprites, Audio, Input, Dos, Blitter, Copper, Schub, Basic, NComp, NAsm;

const
  RtText = 'RUNTIME ERROR ';  { what rt_error writes }
  { the debugger: its state (DbgLineAdr in NComp, see compiler/cart.js),
    the breakpoints (a bit a line), the watches (16 bytes a name), the
    program's screen while it is stopped }
  DbgBase = $3D7F00;
  DbgBits = $3D7000;
  WatchBase = $3D7400;
  MaxWatch = 6;
  ScrSave = $3E0000;
  aStopLine = $51;            { the line the program stopped at: white on green }
  aBreakLine = $21;           { a breakpoint: white on red }
  TB = $200000;               { text buffer (= NComp.SrcBase) }
  Stage = $280000;            { loading area }
  MaxText = 60000;
  { the screen as in the workshop and EDIT: row 1 the tabs and F-keys, row 2
    the file and the position, the text from row TT, row 29 the keys, row 30
    the message (or more keys) }
  Rows = 26;                  { text rows on screen (TT..TT + 25) }
  TT = 3;                     { the first text row }
  Cols = 80;
  { the workshop's colours (rom/werkstatt.asm: F_REITER, F_AKTIV, F_TITEL,
    F_STATUS); colour = foreground + 16 * background }
  aTabs = $BF;                { light grey on dark grey: tabs, keys }
  aTabOn = $70;               { black on yellow: this tab }
  aHead = $67;                { yellow on blue: file and position }
  aLine = $F0;                { black on light grey: message, prompts }
  aSel = $C1;                 { white on grey: the selection }
  TabKeys = '  F1 help  F2 save  F3 open  F4 new  F5 run  F9 compile';
  Hint1 = ' ^Z undo  ^F find  ^G next  ^L go to line  ^X cut  ^C copy  ^V paste  ^B break';
  Hint2 = ' F6 drive  F7 .MER  F8 dir  ^R run .MER  ^F7 trace  ^W watch  ^K colours';
  HintStop = ' F5 go  F7 into  F8 over  F4 to cursor  ^F2 end  ^B breakpoint  ^W watch';
  { tables in expansion RAM: bank 0 is short (the compiler's stack) }
  KeyWas = $3C0000;           { a key's press was handled (1 byte a scan code) }
  CkState = $3C0100;          { scanner state at every 256 bytes of text }
  RowPos = $3C0200;           { text position of each row at the last redraw (4 bytes) }
  ClipBase = $3C1000;         { the clipboard: whole lines (^X ^C ^V, as in EDIT) }
  ClipMax = $E000;
  { the undo log (^Z): records of the edits, the newest last. A record is
    kind (1 inserted, 2 deleted), join kind, position, count, group (2 bytes
    each, written byte by byte: SCHUB faults on unaligned words), the
    deleted bytes, and its size at the end, so the log is read backwards }
  UndoBase = $3E2000;         { after ScrSave's 4803 bytes }
  { crash protection: what the editor knows about the text (its length,
    cursor, name, whether it is saved), kept next to the text in expansion
    RAM, which a reset leaves alone. When a program hangs or crashes and the
    machine is reset, the editor finds the unsaved text again on its start.
    'MPTX', length (3 bytes), cursor (3 bytes), unsaved (1), name (17). }
  RecBase = $3C0F00;
  UndoMax = 64000;
  { the redo log (Shift+^Z), the same records: what ^Z took back }
  RedoBase = $3F1C00;
  RedoMax = 57000;

procedure RunUser(entry: longint); external 'runuser';
function RunMerFile: integer; external 'runmer';
{ fast loops in assembler (compiler/cart.js); text offsets are below 64 KB }
function FindLF(p, limit: word): word; external 'findlf';
function LineStartAt(p: word): word; external 'linestart';
procedure DrawRow(scr, text, n: word; attr: pointer; plain: word); external 'drawrow';
{ the debugger (compiler/cart.js, DEBUG_ASM): continue a stopped 65C816
  program; let its stops come back to this editor }
procedure DbgResume; external 'dbgresume';
procedure DbgSetVec; external 'dbgsetvec';

var
  Scr: array[0..2399] of word absolute $0400;
  len, cur, top: longint;            { text length, cursor, offset of the first shown line }
  curLine, topLine: integer;         { 1-based line numbers }
  left: integer;                     { first shown column }
  wantCol: integer;
  modified, quit, redrawAll: boolean;
  fileName: string[16];
  msg: string[80];                  { the screen is 80 wide }
  findText: string[40];
  replText: string[40];              { what ^H puts in }
  primary: string[16];               { an error took the editor into a unit: the program to compile, else '' }
  rtLine: integer;                   { the line of the last runtime error, 0 = none }
  dbgActive: boolean;                { a program is stopped in the debugger }
  dbgLine: integer;                  { its line (in the program, not a unit) }
  dbgSchub: boolean;                 { it is a SCHUB program }
  dbgCols: integer;                  { its screen: 40 or 80 columns }
  nWatch: integer;
  aText: byte;
  repT: longint;
  lastRow: integer;
  lastMsg: string[80];
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
  clipLen: longint;                  { bytes in the clipboard }
  clipRun: boolean;                  { the last key was ^X: the next cut adds to the clipboard }
  uTop: longint;                     { bytes in the undo log }
  uGroup: longint;                   { the edit being logged: ^Z undoes a group }
  uJoin: byte;                       { the key being handled: 1 typing, 2 Backspace, 3 Delete, 4 ^X, 0 other }
  logTo: byte;                       { edits go to: 0 the undo log (and nothing to redo), 1 the redo log (^Z), 2 the undo log (redo) }
  rTop: longint;                     { bytes in the redo log }
  uFresh: boolean;                   { the next record starts a group whatever uJoin says }
  uKeep: boolean;                    { the next record belongs to the group of the last one }
  selA: longint;                     { the selection runs from here to the cursor; -1 none }
  dragAnchor: longint;               { where the mouse button went down; -1 none }
  clipChars: boolean;                { the clipboard holds a selection, not whole lines }
  mvLine: integer;                   { the cursor's line before a cursor key (MoveFrom) }

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
  if selA >= 0 then begin selA := -1; redrawAll := true; end;
  if dbgActive then begin dbgActive := false; msg := 'Program reset: the text changed.'; end;
end;

{ ------------------------------------------------------------- undo }
function UW(a: longint): longint;
begin
  UW := Mem[a] + Mem[a + 1] * 256;
end;

procedure PutUW(a, v: longint);
begin
  Mem[a] := v and 255;
  Mem[a + 1] := (v shr 8) and 255;
end;

{ the newest record's offset in a log }
function UTopRec(base, top: longint): longint;
begin
  UTopRec := top - UW(base + top - 2);
end;

function URecSize(base, o: longint): longint;
begin
  if Mem[base + o] = 2 then URecSize := 10 + UW(base + o + 4) else URecSize := 10;
end;

{ room for need more bytes: when the log is full the oldest records go, a
  quarter of the log at least, so that it moves seldom }
function UndoRoom(base, max: longint; var top: longint; need: longint): boolean;
var off, keep, s, c: longint;
begin
  UndoRoom := false;
  if need > max then begin top := 0; exit; end;
  if top + need > max then begin
    off := 0;
    while (off < top) and ((top - off + need > max) or (off < max div 4)) do
      off := off + URecSize(base, off);
    if off >= top then top := 0
    else begin
      { move the rest down in pieces that do not overlap }
      keep := top - off; s := 0;
      while s < keep do begin
        c := keep - s;
        if c > off then c := off;
        CopyMem(base + off + s, base + s, c);
        BlitWait;
        s := s + c;
      end;
      top := keep;
    end;
  end;
  UndoRoom := true;
end;

{ an edit for a log: kind 1 = n bytes inserted at pos, kind 2 = n bytes at
  pos are about to be deleted. Typing in a row, Backspace in a row,
  Delete in a row and ^X in a row make one group, and typing in a row one
  record. }
procedure LogRec(base, max: longint; var top: longint; kind: byte; pos, n: longint);
var t, a, size: longint;
    newGroup: boolean;
begin
  newGroup := (uJoin = 0) or (top = 0) or uFresh;
  uFresh := false;
  if not newGroup then begin
    t := base + UTopRec(base, top);
    if Mem[t + 1] <> uJoin then newGroup := true
    else case uJoin of
      1: newGroup := (kind <> 1) or (pos <> UW(t + 2) + UW(t + 4));
      2: newGroup := pos + n <> UW(t + 2);
      3, 4: newGroup := pos <> UW(t + 2);
    end;
    if not newGroup and (kind = 1) and (Mem[t] = 1) then begin
      PutUW(t + 4, UW(t + 4) + n);
      exit;
    end;
  end;
  { typing over a selection: the deleted selection and the new text are one }
  if uKeep and (top > 0) then newGroup := false;
  uKeep := false;
  if newGroup then uGroup := uGroup + 1;
  size := 10;
  if kind = 2 then size := 10 + n;
  if not UndoRoom(base, max, top, size) then exit;
  a := base + top;
  Mem[a] := kind;
  Mem[a + 1] := uJoin;
  PutUW(a + 2, pos);
  PutUW(a + 4, n);
  PutUW(a + 6, uGroup);
  if kind = 2 then begin CopyMem(TB + pos, a + 8, n); BlitWait; end;
  PutUW(a + size - 2, size);
  top := top + size;
end;

procedure UndoLog(kind: byte; pos, n: longint);
begin
  if n <= 0 then exit;
  case logTo of
    0: begin rTop := 0; LogRec(UndoBase, UndoMax, uTop, kind, pos, n); end;   { a new edit: nothing to redo }
    1: LogRec(RedoBase, RedoMax, rTop, kind, pos, n);
    2: LogRec(UndoBase, UndoMax, uTop, kind, pos, n);
  end;
end;

procedure InsertChars(const s: string);
var n: integer;
    i: integer;
begin
  n := length(s);
  if len + n > MaxText then begin msg := 'The text is full'; exit; end;
  UndoLog(1, cur, n);
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
  UndoLog(2, p, n);
  if p + n < len then begin
    Blit(TB + p + n, TB + p, len - p - n, 1, 0, 0, bmCopy, 0);
    BlitWait;
  end;
  len := len - n;
  TextChanged(p);
  modified := true;
end;

{ ------------------------------------------------------------- crash protection }
procedure Put3(a, v: longint);
begin
  Mem[a] := v and 255;
  Mem[a + 1] := (v shr 8) and 255;
  Mem[a + 2] := (v shr 16) and 255;
end;

function Get3(a: longint): longint;
begin
  Get3 := Mem[a] + Mem[a + 1] * 256 + longint(Mem[a + 2]) * 65536;
end;

{ the record up to date (after every screen update and before a program runs) }
procedure SaveRecord;
var i: integer;
begin
  Mem[RecBase] := ord('M'); Mem[RecBase + 1] := ord('P');
  Mem[RecBase + 2] := ord('T'); Mem[RecBase + 3] := ord('X');
  Put3(RecBase + 4, len);
  Put3(RecBase + 7, cur);
  Mem[RecBase + 10] := ord(modified);
  for i := 0 to 16 do Mem[RecBase + 16 + i] := ord(fileName[i]);
end;

{ ------------------------------------------------------------- selection }
function HasSel: boolean;
begin
  HasSel := (selA >= 0) and (selA <> cur);
end;

{ the selection as a <= b }
procedure SelRange(var a, b: longint);
begin
  if selA < cur then begin a := selA; b := cur; end else begin a := cur; b := selA; end;
end;

procedure ClearSel;
begin
  if selA < 0 then exit;
  { a selection over more lines than the cursor's: draw them all anew }
  if (selA < LineStart(cur)) or (selA > LineEnd(cur)) then redrawAll := true;
  selA := -1;
end;

function ShiftHeld: boolean; forward;

{ the selected text goes; the cursor is where it began. One edit for ^Z;
  the caller sets uKeep when what it types or pastes belongs to it }
procedure DeleteSel;
var a, b, q: longint;
    j: byte;
begin
  SelRange(a, b);
  for q := a to cur - 1 do if Mem[TB + q] = 10 then curLine := curLine - 1;
  j := uJoin;
  uJoin := 0;
  DeleteChars(a, b - a);
  uJoin := j;
  cur := a;
  wantCol := ColOf(cur);
  selA := -1;
  redrawAll := true;
end;

{ a cursor key with or without Shift: start/extend or end the selection
  (MoveFrom before the move, MoveTo after it) }
procedure MoveFrom;
begin
  if ShiftHeld then begin
    if selA < 0 then selA := cur;
  end else ClearSel;
  mvLine := curLine;
end;

procedure MoveTo;
begin
  if selA = cur then selA := -1;
  if abs(curLine - mvLine) > 1 then redrawAll := true;
end;

{ ------------------------------------------------------------- screen }
{ the library's texts (DosErrorText) in small letters, as messages here are }
function Lower(const s: string): string;
var t: string;
    i: integer;
begin
  t := s;
  for i := 1 to length(t) do if (t[i] >= 'A') and (t[i] <= 'Z') then t[i] := chr(ord(t[i]) + 32);
  Lower := t;
end;

{ a message of the compiler on its own: a capital first }
function Cap(const s: string): string;
var t: string;
begin
  t := s;
  if (length(t) > 0) and (t[1] >= 'a') and (t[1] <= 'z') then t[1] := chr(ord(t[1]) - 32);
  Cap := t;
end;

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
  { in an asm block: its text, a ; comment, a brace comment, a "string" }
  stAsm = 8; stAsmLine = 9; stAsmBrace = 10; stAsmStr = 11;
  CkStep = 256;
  colKeyword = 1; colComment = 13; colString = 7; colNumber = 3; colDirective = 8;
  cLetter = 1; cDigit = 2; cHex = 4;

function IsKeyword(const s: string): boolean;
begin
  case s[1] of
    'a': IsKeyword := (s = 'and') or (s = 'array') or (s = 'absolute') or (s = 'asm') or (s = 'assembler');
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
    stBrace, stParen, stLine, stOpening, stClosing, stAsmLine, stAsmBrace: StateAttr := (aText and $F0) or colComment;
    stAsmStr: StateAttr := (aText and $F0) or colString;
    stDirective: StateAttr := (aText and $F0) or colDirective;
    stString: StateAttr := (aText and $F0) or colString;
  else
    StateAttr := aText;
  end;
end;

{ the word s (lower case) stands at q: not part of a longer word (checkpoints
  may cut a word, so the text around is looked at, not just up to upto) }
function WordAt(q: longint; const s: string): boolean;
var i, n: integer;
begin
  WordAt := false;
  n := length(s);
  if (q > 0) and ((cls[Mem[TB + q - 1]] and (cLetter or cDigit)) <> 0) then exit;
  if q + n > len then exit;
  for i := 1 to n do if chr(Mem[TB + q + i - 1] or 32) <> s[i] then exit;
  if (q + n < len) and ((cls[Mem[TB + q + n]] and (cLetter or cDigit)) <> 0) then exit;
  WordAt := true;
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
          { a word: keyword or name (ASM starts an asm block) }
          e := q; i := 0;
          while (e < upto) and ((cls[Mem[TB + e]] and (cLetter or cDigit)) <> 0) do begin
            if i < 15 then begin i := i + 1; w[i] := chr(Mem[TB + e] or 32); end;
            e := e + 1;
          end;
          if (c or 32 = 97) and WordAt(q, 'asm') then st := stAsm;
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
      stAsm: begin
        { an asm block: mnemonics, numbers, comments, strings, END }
        e := q + 1;
        a := aText;
        if (q > 0) and (Mem[TB + q - 1] = 39) and (q + 1 < len) and (Mem[TB + q + 1] = 39) then
          a := attrString                                       { the c of 'c' (a checkpoint cut it) }
        else if c = 59 then begin st := stAsmLine; a := attrComment; end
        else if c = 123 then begin st := stAsmBrace; a := attrComment; end
        else if c = 34 then begin st := stAsmStr; a := attrString; end
        else if (c = 39) and (q + 2 < len) and (Mem[TB + q + 2] = 39) then begin
          e := q + 3; a := attrString;
        end
        else if (cls[c] and cLetter) <> 0 then begin
          while (e < upto) and ((cls[Mem[TB + e]] and (cLetter or cDigit)) <> 0) do e := e + 1;
          if (c or 32 = 101) and WordAt(q, 'end') then begin st := stNormal; a := attrKw; end
          else if paint and (e - q <= 6) then begin
            w[0] := chr(e - q);
            for i := 1 to e - q do w[i] := chr(Mem[TB + q + i - 1]);
            if IsMnemonic(w) then a := attrKw;
          end;
        end
        else if (c = 46) and (q + 1 < upto) and ((cls[Mem[TB + q + 1]] and cLetter) <> 0) then begin
          while (e < upto) and ((cls[Mem[TB + e]] and (cLetter or cDigit)) <> 0) do e := e + 1;
          a := (aText and $F0) or colDirective;
        end
        else if ((cls[c] and cDigit) <> 0) or (((c = 36) or (c = 37)) and (q + 1 < upto) and ((cls[Mem[TB + q + 1]] and cHex) <> 0)) then begin
          while (e < upto) and ((cls[Mem[TB + e]] and cHex) <> 0) do e := e + 1;
          a := attrNumber;
        end;
        if e > upto then e := upto;
        while q < e do begin
          if paint then begin if col < 512 then lineAttr[col] := a; col := col + 1; end;
          q := q + 1;
        end;
      end;
      stAsmLine: begin
        while (q < upto) and (Mem[TB + q] <> 10) do begin
          if paint then begin if col < 512 then lineAttr[col] := attrComment; col := col + 1; end;
          q := q + 1;
        end;
        if q < upto then begin q := q + 1; st := stAsm; end;
      end;
      stAsmBrace, stAsmStr: begin
        { to the closing brace / quote (a string also ends with its line) }
        a := StateAttr(st);
        if st = stAsmBrace then n := 125 else n := 34;
        while (q < upto) and (Mem[TB + q] <> n) and not ((n = 34) and (Mem[TB + q] = 10)) do begin
          if paint then begin if col < 512 then lineAttr[col] := a; col := col + 1; end;
          q := q + 1;
        end;
        if q < upto then begin
          if paint then begin if col < 512 then lineAttr[col] := a; col := col + 1; end;
          q := q + 1; st := stAsm;
        end;
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
    for k := TT to Rows + TT do
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

function BreakAt(line: integer): boolean;
begin
  BreakAt := (line < 4096) and (Mem[DbgBits + (line shr 3)] and (1 shl (line and 7)) <> 0);
end;

{ the line a breakpoint at the cursor goes on: the debugger stops at the
  start of statements, and an asm block is one statement, so inside a block
  it is the block's asm line (the first line whose start is not in it) }
function BreakLine: integer;
var p: longint;
    l: integer;
begin
  p := LineStart(cur);
  l := curLine;
  if not asmMode then
    while (p > 0) and (StateAt(p) in [stAsm, stAsmBrace]) do begin
      p := LineStart(p - 1);
      l := l - 1;
    end;
  BreakLine := l;
end;

{ the debugger's colours on a row: the line the program stopped at, a
  breakpoint }
procedure MarkRow(row: integer);
var line, c, a: integer;
    o: word;
begin
  line := topLine + row - TT;
  if dbgActive and (line = dbgLine) then a := aStopLine
  else if BreakAt(line) then a := aBreakLine
  else exit;
  o := (row - 1) * Cols;
  for c := 0 to Cols - 1 do Scr[o + c] := (Scr[o + c] and $FF) or (a shl 8);
end;

{ the selected part of the line p..e (with its line end) in aSel }
procedure MarkSel(row: integer; p, e: longint);
var a, b, q: longint;
    c: integer;
    o: word;
begin
  if not HasSel then exit;
  SelRange(a, b);
  if a < p then a := p;
  if b > e + 1 then b := e + 1;
  if a >= b then exit;
  o := (row - 1) * Cols;
  for q := a to b - 1 do begin
    c := q - p - left;
    if (c >= 0) and (c < Cols) then Scr[o + c] := (Scr[o + c] and $FF) or (aSel shl 8);
  end;
end;

function DrawLine(row: integer; p: longint; st: byte): byte;
{ draw the text line starting at p on screen row (TT..); st is the state at
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
    if (st = stAsmLine) or (st = stAsmStr) then st := stAsm;
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
  MarkRow(row);
  MarkSel(row, p, e);
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
    if WantSchub or IsAsmSchub(len) then TargetName := 'SCHUB assembly' else TargetName := '65C816 assembly';
  end
  else if WantSchub or SchubDirective(len) then TargetName := 'SCHUB' else TargetName := '65C816';
end;

procedure DrawStatus;
var s: string;
begin
  { row 2: the file, drive and target; the position on the right, as in EDIT }
  if fileName = '' then s := ' (new)' else s := ' ' + fileName;
  s := s + '  drive ' + IntToStr(CurrentDrive);
  if modified then s := s + '  *';
  s := s + '   ' + TargetName + '   ' + IntToStr(len) + ' bytes';
  PutStr(1, 2, s, aHead, 56);
  PutStr(57, 2, 'Ln ' + IntToStr(curLine) + ' Col ' + IntToStr(ColOf(cur) + 1), aHead, 24);
  { rows 29 and 30: the keys; a message takes the place of the second line }
  if dbgActive then PutStr(1, 29, HintStop, aTabs, Cols) else PutStr(1, 29, Hint1, aTabs, Cols);
  if msg <> '' then PutStr(1, 30, ' ' + msg, aLine, Cols) else PutStr(1, 30, Hint2, aLine, Cols);
end;

{ row 1, like the workshop's tabs: this tab, the F-keys, the way out }
procedure DrawTitle;
begin
  PutStr(1, 1, '', aTabs, 1);
  PutStr(2, 1, ' PASCAL ', aTabOn, 8);
  PutStr(10, 1, TabKeys, aTabs, 57);
  PutStr(67, 1, 'F10: to BASIC', aTabs, 14);
end;

{ the mouse pointer: the cell under it in black on light blue. It is taken
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
  ptrWord := (ptrSaved and $00FF) or $E000;      { black on light blue }
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
  o := (curLine - topLine + TT - 1) * Cols + x;
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
  for r := TT to Rows + TT do MemL[RowPos + r * 4] := -1;
  for r := TT to Rows + TT - 1 do begin
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
      while r < Rows + TT - 1 do begin r := r + 1; PutStr(1, r, '', aText, Cols); end;
      break;
    end;
  end;
  { the line after the screen: paging down starts there }
  if p <= len then begin MemL[RowPos + (Rows + TT) * 4] := p; rowSt[Rows + TT] := st; end;
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
  for i := TT + 1 to row do if p <= len then p := LineEnd(p) + 1;
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
    Blit($0400 + longint(TT - 1 + d) * Cols * 2, $0400 + longint(TT - 1) * Cols * 2, n * Cols * 2, 1, 0, 0, bmCopy, 0);
    for r := TT to TT - 1 + n do begin rowSt[r] := rowSt[r + d]; rowEnd[r] := rowEnd[r + d]; end;
    BlitWait;
    st := rowEnd[TT - 1 + n];
    p := RowStart(TT + n);
    for r := TT + n to Rows + TT - 1 do begin
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
    Blit($0400 + longint(TT - 1 + n) * Cols * 2 - 1, $0400 + longint(TT - 1 + n + d) * Cols * 2 - 1, n * Cols * 2, 1, 0, 0,
         bmCopy + bmBackwards, 0);
    for r := Rows + TT - 1 downto TT + d do begin rowSt[r] := rowSt[r - d]; rowEnd[r] := rowEnd[r - d]; end;
    BlitWait;
    if colours then st := StateAt(top) else st := stNormal;
    p := top;
    for r := TT to TT - 1 + d do begin
      rowSt[r] := st;
      st := DrawLine(r, p, st);
      rowEnd[r] := st;
      p := LineEnd(p) + 1;
    end;
    { the rows below begin as they did }
    if st <> rowSt[TT + d] then redrawAll := true;
  end;
  rowsValid := false;
end;

{ the watches, at the bottom of the text while a program is stopped }
procedure DrawWatches;
var i, k: integer;
    n: string[16];
begin
  if not dbgActive then exit;
  for i := 1 to nWatch do begin
    n[0] := chr(Mem[WatchBase + (i - 1) * 16]);
    for k := 1 to length(n) do n[k] := chr(Mem[WatchBase + (i - 1) * 16 + k]);
    PutStr(1, Rows + TT - 1 - nWatch + i, ' ' + n + ' = ' + DebugValue(n), aHead, Cols);
  end;
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
  row := curLine - topLine + TT;
  if not redrawAll then begin
    { the old cursor row (it may have changed) and the new one; a change that
      opens or closes a comment colours the rows below anew }
    if (lastRow <> row) and (lastRow >= TT) and (lastRow <= Rows + TT - 1) then begin
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
  DrawWatches;
  DrawStatus;
  ShowCursor(true);
  ShowPointer;
  ptrMoved := false;
  SaveRecord;
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
  ClearSel;
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
    PutStr(1, 30, ' ' + question + ' ' + answer + '_', aLine, Cols);
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
  PutStr(1, 30, ' ' + question + ' (Y/N)', aLine, Cols);
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
  if not Prompt('Save as:', n, 12) then exit;
  if n = '' then exit;
  n := WithExt(n);
  msg := 'Saving ' + n + '...';
  DrawStatus;
  if SaveFile(n, TB, len) then begin
    fileName := n; modified := false;
    msg := 'Saved ' + n + ' (' + IntToStr(len) + ' bytes) on drive ' + IntToStr(CurrentDrive);
  end else msg := 'Save failed: ' + Lower(DosErrorText(DosError));
end;

procedure RunNamed(n: string); forward;

{ the file n from the current drive into the editor }
function LoadNamed(const n: string): boolean;
var got, i: longint;
    b: byte;
    lastCR: boolean;
begin
  LoadNamed := false;
  msg := 'Opening ' + n + '...';
  DrawStatus;
  got := LoadFile(n, Stage, MaxText);
  if got < 0 then begin msg := 'Open failed: ' + Lower(DosErrorText(DosError)); exit; end;
  LoadNamed := true;
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
  uTop := 0; rTop := 0;                     { another text: nothing to undo }
  left := 0;
  JumpTo(0);
  msg := 'Opened ' + n + ' (' + IntToStr(len) + ' bytes)';
end;

procedure LoadText;
var n: string;
begin
  if modified then if not YesNo('The text is not saved. Open another anyway?') then exit;
  n := '';
  if not Prompt('Open:', n, 12) then exit;
  if n = '' then exit;
  n := WithExt(n);
  if Pos('.MER', n) > 0 then begin RunNamed(n); exit; end;
  if LoadNamed(n) then primary := '';
end;

procedure Directory;
var i, r, c: integer;
    n: string;
    sz: longint;
begin
  for r := TT to Rows + TT - 1 do PutStr(1, r, '', aText, Cols);
  PutStr(2, TT, 'Directory of drive ' + IntToStr(CurrentDrive), aHead, 40);
  i := 0; r := TT + 2; c := 2;
  while DirEntry(i, n, sz) do begin
    PutStr(c, r, n + '  ' + IntToStr(sz), aText, 24);
    r := r + 1;
    if r > Rows + TT - 3 then begin r := TT + 2; c := c + 26; if c > 60 then break; end;
    i := i + 1;
  end;
  if (i = 0) and (DosError <> 2) then PutStr(2, TT + 2, Lower(DosErrorText(DosError)), aText, 40);
  PutStr(2, Rows + TT - 1, IntToStr(DiskFree) + ' bytes free. Press a key.', aHead, 60);
  WaitAnyKey;
  redrawAll := true;
end;

{ on start: unsaved text from before a reset? Offer it back }
function RecoverText: boolean;
var n, c, i: longint;
    bad: longint;
    nm: string[16];
    q: string;
begin
  RecoverText := false;
  if (Mem[RecBase] <> ord('M')) or (Mem[RecBase + 1] <> ord('P')) or
     (Mem[RecBase + 2] <> ord('T')) or (Mem[RecBase + 3] <> ord('X')) then exit;
  n := Get3(RecBase + 4);
  c := Get3(RecBase + 7);
  if (Mem[RecBase + 10] <> 1) or (n <= 0) or (n > MaxText) or (Mem[RecBase + 16] > 16) then exit;
  nm[0] := chr(Mem[RecBase + 16]);
  for i := 1 to length(nm) do nm[i] := chr(Mem[RecBase + 16 + i]);
  { a program that ran wild may have written into it: text has no control
    characters but line ends }
  bad := 0;
  for i := 0 to n - 1 do if (Mem[TB + i] < 32) and (Mem[TB + i] <> 10) then bad := bad + 1;
  if nm = '' then q := 'a new text' else q := nm;
  q := 'Unsaved text from before the restart: ' + q + ', ' + IntToStr(n) + ' bytes';
  if bad > 0 then q := q + ', damaged';
  if not YesNo(q + '. Recover it?') then exit;
  len := n;
  if (c < 0) or (c > len) then c := 0;
  fileName := nm;
  modified := true;
  uTop := 0; rTop := 0;
  TextChanged(0);
  left := 0;
  JumpTo(c);
  if bad = 1 then msg := 'Recovered, but 1 byte looks damaged: check it before saving'
  else if bad > 0 then msg := 'Recovered, but ' + IntToStr(bad) + ' bytes look damaged: check it before saving'
  else msg := 'Recovered. F2 saves it.';
  RecoverText := true;
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
  primary := '';
  uTop := 0; rTop := 0;                     { a new text: nothing to undo }
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

{ the text as it is, under its name, without asking }
function SaveQuiet: boolean;
begin
  SaveQuiet := true;
  if not modified then exit;
  if SaveFile(fileName, TB, len) then modified := false
  else begin
    msg := 'Save failed: ' + Lower(DosErrorText(DosError));
    SaveQuiet := false;
  end;
end;

{ an error in a unit: open the unit at the error (the program saved first);
  F9 F5 F7 there save the unit and compile the program again }
procedure OpenUnitError;
var u, p: string[16];
    m: string;
    l, c: integer;
begin
  u := ErrUnit; l := ErrLine; c := ErrCol; m := msg;
  if not YesNo('Error in ' + u + ' line ' + IntToStr(l) + '. Open ' + u + ' there?') then begin msg := m; exit; end;
  if fileName = '' then SaveText
  else if not SaveQuiet then exit;
  if modified or (fileName = '') then begin msg := m; exit; end;
  p := fileName;
  if not LoadNamed(u) then exit;
  primary := p;
  GoToLine(l, c);
  msg := 'Error line '; AddNum(l); Add(': '); Add(ErrMsg); Add(' (F9: back to '); Add(p); Add(')');
end;

function Compile: boolean;
var t: longint;
    ok: boolean;
begin
  Compile := false;
  { in a unit because of an error: save it, then the program again }
  if (primary <> '') and (primary <> fileName) then begin
    if not SaveQuiet then exit;
    if not LoadNamed(primary) then exit;
  end;
  primary := '';
  t := Frames;
  if IsAsm then begin
    msg := 'Assembling...';
    DrawStatus;
    ok := AssembleSource(len, WantSchub or IsAsmSchub(len));
    if ok then begin
      msg := 'Assembled: '; AddNum(AsmLines); Add(' lines, '); AddNum(AsmSize); Add(' bytes at $');
      AddHex(AsmOrigin); Add(', '); AddNum((Frames - t) * 10 div 6); Add('0 ms');
    end;
  end else begin
    msg := 'Compiling...';
    DrawStatus;
    ok := CompileSource(len);
    if ok then begin
      msg := 'Compiled: '; AddNum(LinesDone); Add(' lines, '); AddNum(CodeSize); Add(' bytes code, ');
      AddNum(DataSize); Add(' bytes data, '); AddNum((Frames - t) * 10 div 6); Add('0 ms');
    end;
  end;
  if ok then Compile := true
  else begin
    if ErrUnit <> '' then begin
      msg := 'Error in '; Add(ErrUnit); Add(' line '); AddNum(ErrLine); Add(': '); Add(ErrMsg);
      OpenUnitError;
    end
    else begin
      msg := 'Error line '; AddNum(ErrLine); Add(': '); Add(ErrMsg);
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
  DebugLines := false;                     { a standalone program without them }
  ok := Compile;
  DebugLines := true;
  if not ok then exit;
  n := fileName;
  p := Pos('.', n);
  if p > 0 then n := Copy(n, 1, p - 1);
  if not Prompt('Save the program as:', n, 8) then exit;
  if n = '' then exit;
  p := Pos('.', n);
  if p > 0 then n := Copy(n, 1, p - 1);
  n := UpperCase(n) + '.MER';
  msg := 'Saving ' + n + '...';
  DrawStatus;
  if IsAsm then ok := SaveAsmMer(n) else ok := SaveStandalone(n);
  if ok then begin
    msg := 'Saved '; Add(n);
    if not IsAsm then begin Add(' ('); AddNum(MerSize); Add(' bytes)'); end;
    Add(' - in BASIC: BRUN "'); Add(Copy(n, 1, Pos('.', n) - 1)); Add('"');
  end
  else msg := Cap(ErrMsg);
end;

{ Ctrl+R (or F3 with a .MER name): run a program file from the current drive }
procedure RunNamed(n: string);
var r, e, i: integer;
begin
  SaveRecord;
  if Pos('.', n) = 0 then n := n + '.MER';
  n := UpperCase(n);
  msg := 'Running ' + n + '...';
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
  if e = 0 then msg := n + ' ended.' else msg := 'Cannot run ' + n + ': ' + Lower(DosErrorText(e));
end;

procedure RunFile;
var n: string;
    p: integer;
begin
  n := fileName;
  p := Pos('.', n);
  if p > 0 then n := Copy(n, 1, p - 1);
  if not Prompt('Run a program file (.MER):', n, 12) then exit;
  if n <> '' then RunNamed(n);
end;

{ after a program ran: RUNTIME ERROR n on the screen (rt_error writes it at
  the start of a line); 0 = none }
function ScreenError: integer;
var row, c, v: integer;
    a: longint;
    ok: boolean;
    t: string[14];
begin
  ScreenError := 0;
  t := RtText;
  for row := 0 to 29 do begin
    a := $0400 + longint(row) * 80;
    ok := true;
    for c := 1 to 14 do
      if Mem[a + (c - 1) * 2] <> ord(t[c]) then ok := false;
    if ok then begin
      v := 0; c := 14;
      while (Mem[a + c * 2] >= ord('0')) and (Mem[a + c * 2] <= ord('9')) and (c < 20) do begin
        v := v * 10 + Mem[a + c * 2] - ord('0'); c := c + 1;
      end;
      ScreenError := v;
    end;
  end;
end;

{ the message after a run: where it ended, when that was not the end }
procedure RunResult(dl: word; err: integer);
var u: integer;
begin
  rtLine := 0;
  if err <> 0 then begin msg := 'Runtime error '; AddNum(err); end
  else if dl = $FFFF then begin msg := 'Program ended.'; exit; end
  else if dl = $FFFE then begin msg := 'Program stopped.'; exit; end
  else msg := 'Program stopped';
  if dl >= $FFFE then exit;                     { no line known ($D-) }
  u := dl shr 12;
  Add(' at line '); AddNum(dl and $FFF);
  if u <> 0 then begin Add(' in '); Add(DebugUnitName(u)); end
  else begin rtLine := dl and $FFF; GoToLine(rtLine, 1); end;
end;

{ the program's screen while it is stopped: kept, and back before it goes on }
procedure SaveUserScreen;
begin
  dbgCols := Mem[$15];
  CopyMem($0400, ScrSave, 4800);
  Mem[ScrSave + 4800] := Mem[$10]; Mem[ScrSave + 4801] := Mem[$11]; Mem[ScrSave + 4802] := Mem[$12];
end;

procedure RestoreUserScreen;
var r: integer;
begin
  r := KernelMode(dbgCols);
  CopyMem(ScrSave, $0400, 4800);
  Mem[$10] := Mem[ScrSave + 4800]; Mem[$11] := Mem[ScrSave + 4801]; Mem[$12] := Mem[ScrSave + 4802];
end;

function AnyBreak: boolean;
var i: integer;
begin
  AnyBreak := false;
  for i := 0 to 511 do if Mem[DbgBits + i] <> 0 then AnyBreak := true;
end;

{ after the program ran: it ended, or the debugger stopped it }
procedure AfterRun;
var r, err: integer;
    dl: word;
begin
  dl := MemW[DbgLineAdr];
  if Mem[DbgBase + 3] = 1 then begin
    { stopped: the editor shows where }
    SaveUserScreen;
    dbgActive := true;
    ResetDisplay;
    r := KernelMode(80);
    EditorMouse(true);
    DrawTitle;
    redrawAll := true;
    rtLine := 0;
    if dl shr 12 <> 0 then begin
      dbgLine := 0;
      msg := 'Stopped in '; Add(DebugUnitName(dl shr 12)); Add(' line '); AddNum(dl and $FFF);
    end else begin
      dbgLine := dl and $FFF;
      GoToLine(dbgLine, 1);
      msg := 'Stopped at line '; AddNum(dbgLine);
    end;
    Add('.');
    exit;
  end;
  dbgActive := false;
  err := ScreenError;
  WriteLn;
  Write('-- PRESS A KEY --');
  WaitAnyKey;
  ResetDisplay;
  r := KernelMode(80);
  EditorMouse(true);
  DrawTitle;
  redrawAll := true;
  RunResult(dl, err);
end;

{ the stopped program goes on: mode 0 to the next breakpoint, 1 into the
  next line, 2 over calls, 3 to the cursor's line }
procedure DbgGo(mode: integer);
begin
  Mem[DbgBase + 2] := mode;
  MemW[DbgBase + 8] := curLine;
  dbgActive := false;
  EditorMouse(false);
  RestoreUserScreen;
  if dbgSchub then RunUser(RunEntry + 2) else DbgResume;
  AfterRun;
end;

{ start the program: hooks when there are breakpoints or it is traced }
procedure StartRun(hooks: boolean; mode: integer);
var r: integer;
    isA: boolean;
begin
  SaveRecord;
  DebugLines := true;
  DebugHooks := hooks;
  if not Compile then exit;
  isA := IsAsm;
  if isA then if not AsmPrepareRun then begin msg := Cap(ErrMsg); exit; end;
  dbgSchub := IsSchub;
  Mem[DbgBase + 2] := mode;
  Mem[DbgBase + 3] := 0;
  MemW[DbgBase + 8] := curLine;
  DbgSetVec;
  EditorMouse(false);
  r := KernelMode(40);
  MemW[DbgLineAdr] := $FFFF;                { assembly: no lines }
  if isA then RunUser(RunAt)
  else begin
    PrepareRun;
    RunUser(RunEntry);
  end;
  AfterRun;
end;

procedure RunProgram;
var r, err: integer;
    isA: boolean;
    dl: word;
begin
  SaveRecord;
  if dbgActive then begin DbgGo(0); exit; end;
  if AnyBreak then begin StartRun(true, 0); exit; end;
  DebugLines := true;
  DebugHooks := false;
  if not Compile then exit;
  isA := IsAsm;
  if isA then if not AsmPrepareRun then begin msg := Cap(ErrMsg); exit; end;
  EditorMouse(false);
  r := KernelMode(40);
  MemW[DbgLineAdr] := $FFFF;                { assembly: no lines }
  if isA then RunUser(RunAt)
  else begin
    PrepareRun;
    RunUser(RunEntry);
  end;
  dl := MemW[DbgLineAdr];
  err := ScreenError;
  WriteLn;
  Write('-- PRESS A KEY --');
  WaitAnyKey;
  ResetDisplay;
  r := KernelMode(80);
  EditorMouse(true);
  DrawTitle;
  redrawAll := true;
  RunResult(dl, err);
end;

{ the help screen: the title here, the rest from the cartridge ROM
  (compiler/helptext.js), which keeps it out of bank 0 }
function HelpText: longint; external 'helptext';

procedure Help;
var r, c: integer;
    a: longint;
    o: word;
begin
  for r := TT to Rows + TT - 1 do PutStr(1, r, '', aText, Cols);
{$IFDEF SCHUB}
  PutStr(2, TT, 'MERIDIAN Pascal - the editor on SCHUB.  Ctrl+F10: the 65C816 editor', aText, 78);
{$ELSE}
  PutStr(2, TT, 'MERIDIAN Pascal - on the MERIDIAN 816', aText, 78);
{$ENDIF}
  a := HelpText;
  r := TT + 2;
  { straight onto the screen (the rows are clear), from column 2 }
  while (Mem[a] <> 0) and (r <= Rows + TT - 1) do begin
    o := (r - 1) * Cols + 1;
    c := 0;
    while (Mem[a] <> 10) and (Mem[a] <> 0) do begin
      if c < 78 then Scr[o + c] := Mem[a] or (word(aText) shl 8);
      c := c + 1;
      a := a + 1;
    end;
    if Mem[a] = 10 then a := a + 1;
    r := r + 1;
  end;
  WaitAnyKey;
  redrawAll := true;
end;

{ where findText comes next from p on (any case), -1 nowhere }
function FindFrom(p: longint): longint;
var i, n: integer;
    ok: boolean;
begin
  FindFrom := -1;
  n := length(findText);
  if n = 0 then exit;
  while p + n <= len do begin
    ok := true;
    i := 0;
    while ok and (i < n) do begin
      if UpCase(TC(p + i)) <> findText[i + 1] then ok := false;
      i := i + 1;
    end;
    if ok then begin FindFrom := p; exit; end;
    p := p + 1;
  end;
end;

{ show a find at p, selected, so that typing replaces it }
procedure ShowFound(p: longint);
begin
  ClearSel;
  JumpTo(p);
  selA := p + length(findText);
  redrawAll := true;
end;

procedure Find(again: boolean);
var s: string;
    p: longint;
begin
  clipRun := false;
  if not again or (findText = '') then begin
    s := findText;
    if not Prompt('Find:', s, 40) then exit;
    findText := UpperCase(s);
  end;
  if findText = '' then exit;
  p := FindFrom(cur + 1);
  if p >= 0 then begin ShowFound(p); msg := ''; end
  else msg := 'Not found: ' + findText;
end;

{ ^H: find and replace, asking at each place (Y, N, A all, Esc); all the
  replacements are one edit for ^Z }
procedure Replace;
var s: string;
    p, a, b: longint;
    k: char;
    all, first: boolean;
    count: integer;
begin
  clipRun := false;
  s := findText;
  if not Prompt('Replace:', s, 40) then exit;
  findText := UpperCase(s);
  if findText = '' then exit;
  s := replText;
  if not Prompt('Replace ' + findText + ' with:', s, 40) then exit;
  replText := s;
  { from the selection's start (a find selects), or else the cursor }
  p := cur;
  if HasSel then begin SelRange(a, b); p := a; end;
  p := FindFrom(p);
  if p < 0 then begin msg := 'Not found: ' + findText; exit; end;
  all := false; first := true; count := 0; k := 'Y';
  while p >= 0 do begin
    if not all then begin
      ShowFound(p);
      msg := '';
      Refresh;
      PutStr(1, 30, ' Replace it?  Y yes  N no, the next  A all  Esc stop', aLine, Cols);
      FlushKeys;
      repeat k := UpCase(ReadKey) until (k = 'Y') or (k = 'N') or (k = 'A') or (k = #27) or (k = #3);
      if (k = #27) or (k = #3) then break;
      if k = 'A' then all := true;
    end;
    if k = 'N' then p := FindFrom(p + 1)
    else begin
      ClearSel;
      if first then uFresh := true else uKeep := true;
      first := false;
      DeleteChars(p, length(findText));
      cur := p;
      uKeep := true;
      InsertChars(replText);
      uKeep := false;
      count := count + 1;
      p := FindFrom(p + length(replText));
    end;
  end;
  uFresh := false; uKeep := false;
  ClearSel;
  JumpTo(cur);
  if count = 1 then msg := 'Replaced 1 time'
  else begin msg := 'Replaced '; AddNum(count); Add(' times'); end;
end;

{ ^X / ^C: the cursor's line to the clipboard; cuts in a row collect }
procedure CopySel(cut: boolean);
var a, b: longint;
begin
  SelRange(a, b);
  if b - a > ClipMax then begin msg := 'Too much for the clipboard'; exit; end;
  CopyMem(TB + a, ClipBase, b - a);
  BlitWait;
  clipLen := b - a;
  clipChars := true;
  clipRun := false;
  if cut then begin
    DeleteSel;
    msg := 'Cut: ^V pastes it';
  end else msg := 'Copied: ^V pastes it';
end;

procedure CopyLine(cut: boolean);
var ls, le, n: longint;
begin
  { a selection: that, not the line }
  if HasSel then begin CopySel(cut); exit; end;
  ls := LineStart(cur);
  le := LineEnd(cur);
  if le < len then le := le + 1;
  n := le - ls;
  if not (cut and clipRun) then clipLen := 0;
  clipChars := false;
  if clipLen + n + 1 > ClipMax then begin msg := 'Clipboard full'; exit; end;
  if n > 0 then CopyMem(TB + ls, ClipBase + clipLen, n);
  clipLen := clipLen + n;
  { the last line of the text has no LF: it gets one in the clipboard }
  if (clipLen > 0) and (Mem[ClipBase + clipLen - 1] <> 10) then begin
    Mem[ClipBase + clipLen] := 10;
    clipLen := clipLen + 1;
  end;
  if cut then begin
    { cuts in a row collect: one edit for ^Z, too }
    uFresh := not clipRun;
    uJoin := 4;
    DeleteLine;
    uJoin := 0;
    clipRun := true;
    msg := 'Cut: ^V pastes it';
  end else begin
    clipRun := false;
    msg := 'Line copied: ^V pastes it';
  end;
end;

{ ^V: the clipboard's lines in front of the cursor's line }
procedure PasteLines;
begin
  clipRun := false;
  if clipLen = 0 then begin msg := 'Clipboard empty: ^X cuts a line, ^C copies it'; exit; end;
  if len + clipLen > MaxText then begin msg := 'The text is full'; exit; end;
  { over a selection: it goes, and the paste is the same edit for ^Z }
  if HasSel then begin DeleteSel; uKeep := true; end;
  { whole lines go in front of the cursor's line, a selection at the cursor }
  if not clipChars then cur := LineStart(cur);
  UndoLog(1, cur, clipLen);
  uKeep := false;
  if len > cur then Blit(TB + len - 1, TB + len - 1 + clipLen, len - cur, 1, 0, 0, bmCopy + bmBackwards, 0);
  BlitWait;
  CopyMem(ClipBase, TB + cur, clipLen);
  TextChanged(cur);
  len := len + clipLen;
  cur := cur + clipLen;
  curLine := CountLines(cur);
  wantCol := ColOf(cur);
  modified := true;
  redrawAll := true;
  msg := '';
end;

{ ^Z: the last edit undone (typing in a row, Backspace or Delete in a row,
  a new line, a cut, a paste, a deleted line); ^Z again the one before.
  Shift+^Z: what ^Z took back done again. Each takes a group from its log
  and writes what it does to the other one, as one group. }
procedure Revert(redo: boolean);
var t, a, base, lt, pos, n, g, low: longint;
    first: boolean;
begin
  clipRun := false;
  if redo then begin base := RedoBase; lt := rTop; logTo := 2; end
  else begin base := UndoBase; lt := uTop; logTo := 1; end;
  if lt = 0 then begin
    logTo := 0;
    if redo then msg := 'Nothing to redo' else msg := 'Nothing to undo';
    exit;
  end;
  g := UW(base + UTopRec(base, lt) + 6);
  low := len;
  first := true;
  uJoin := 0;
  repeat
    t := UTopRec(base, lt);
    a := base + t;
    pos := UW(a + 2);
    n := UW(a + 4);
    if first then uFresh := true else uKeep := true;
    first := false;
    if Mem[a] = 1 then begin
      DeleteChars(pos, n);
      cur := pos;
    end else begin
      if len + n > MaxText then begin lt := 0; break; end;
      if len > pos then Blit(TB + len - 1, TB + len - 1 + n, len - pos, 1, 0, 0, bmCopy + bmBackwards, 0);
      BlitWait;
      CopyMem(a + 8, TB + pos, n);
      BlitWait;
      TextChanged(pos);
      len := len + n;
      modified := true;
      UndoLog(1, pos, n);
      if Mem[a + 1] = 2 then cur := pos + n else cur := pos;
    end;
    if pos < low then low := pos;
    lt := t;
  until (lt = 0) or (UW(base + UTopRec(base, lt) + 6) <> g);
  logTo := 0;
  uKeep := false; uFresh := false;
  if redo then rTop := lt else uTop := lt;
  if cur > len then cur := len;
  { an edit above the first shown line moves the text under it: show the
    cursor afresh; otherwise the view stays }
  if low < top then JumpTo(cur)
  else begin
    curLine := CountLines(cur);
    wantCol := ColOf(cur);
    redrawAll := true;
  end;
  if redo then begin
    if rTop = 0 then msg := 'Redone (nothing more to redo)' else msg := 'Redone: Shift+^Z redoes the next';
  end else begin
    if uTop = 0 then msg := 'Undone (nothing more to undo)' else msg := 'Undone: ^Z undoes the edit before';
  end;
end;

{ ^L: go to a line }
procedure GoToKey;
var t: string;
    n, c: integer;
begin
  clipRun := false;
  t := '';
  if not Prompt('Go to line:', t, 5) then exit;
  Val(t, n, c);
  if (c = 0) and (n > 0) then GoToLine(n, 1);
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

function ShiftHeld: boolean;
begin
  ShiftHeld := Held(scShift) or Held(scRShift);
end;

function Ctrl: boolean;
begin
  Ctrl := Held($14) or Held($94);
end;

{ what F1..F10 do (keys, and clicks on the top line) }
procedure FKey(n: integer);
var d, i: integer;
    c: boolean;
begin
  clipRun := false;
  c := Ctrl;                       { as the key was pressed (a question may follow) }
  if dbgActive then
    case n of
      4: begin DbgGo(3); exit; end;
      5: begin DbgGo(0); exit; end;
      7: begin DbgGo(1); exit; end;
      8: begin DbgGo(2); exit; end;
      2: if Ctrl then begin dbgActive := false; redrawAll := true; msg := 'Program ended (Ctrl+F2).'; exit; end;
    end
  else if Ctrl and (n = 7) then begin StartRun(true, 1); exit; end;
  case n of
    1: Help;
    2: SaveText;
    3: LoadText;
    4: if not modified or YesNo('The text is not saved. Clear it?') then NewText;
    5: RunProgram;
    6: begin
         d := CurrentDrive + 1;
         if d > 3 then d := 1;
         SetDrive(d);
         msg := 'Drive ' + IntToStr(d);
       end;
    7: MakeMer;
    8: Directory;
    9: i := ord(Compile);
    10: if not modified or YesNo('The text is not saved. Leave anyway?') then begin
          quit := true;
{$IFDEF SCHUB}
          { Ctrl+F10: the cartridge starts the 65C816 editor (compiler/cart.js) }
          if c then Mem[$B00000] := 1;
{$ENDIF}
        end;
  end;
end;

{ Ctrl+W: a variable to watch; an empty name takes the last one away }
procedure WatchKey;
var n: string;
    k: integer;
begin
  n := '';
  if not Prompt('Watch (variable, r.field, a[3]; empty: remove the last):', n, 15) then exit;
  if n = '' then begin
    if nWatch > 0 then nWatch := nWatch - 1;
  end else begin
    if nWatch >= MaxWatch then nWatch := MaxWatch - 1;
    nWatch := nWatch + 1;
    Mem[WatchBase + (nWatch - 1) * 16] := length(n);
    for k := 1 to length(n) do Mem[WatchBase + (nWatch - 1) * 16 + k] := ord(UpCase(n[k]));
  end;
  redrawAll := true;
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
  if Pressed($80 + $7D) then begin MoveFrom; for i := 1 to Rows - 1 do CurUp; MoveTo; end;     { PgUp }
  if Pressed($80 + $7A) then begin MoveFrom; for i := 1 to Rows - 1 do CurDown; MoveTo; end;   { PgDn }
  if Pressed($80 + $69) then begin                                  { End }
    MoveFrom;
    if Ctrl then JumpTo(len) else begin cur := LineEnd(cur); wantCol := ColOf(cur); end;
    MoveTo;
  end;
  if Ctrl then begin
    if Pressed(scY) then begin clipRun := false; DeleteLine; end;
    if Pressed(scF) then Find(false);
    if Pressed(scG) then Find(true);                              { ^G: find next }
    if Pressed(scH) then Replace;                                 { ^H: replace }
    if Pressed(scL) then GoToKey;
    if Pressed(scS) then FKey(2);                                 { ^S ^O ^N: as in EDIT }
    if Pressed(scO) then FKey(3);
    if Pressed(scN) then FKey(4);
    if Pressed(scX) then CopyLine(true);
    if Pressed(scC) then CopyLine(false);
    if Pressed(scV) then PasteLines;
    if Pressed(scZ) then Revert(ShiftHeld);                        { ^Z undo, Shift+^Z redo }
    if Pressed($2D) then RunFile;                                  { Ctrl+R }
    if Pressed(scT) then begin
      WantSchub := not WantSchub;
      if WantSchub then msg := 'Target: SCHUB (the RISC-V co-processor)'
      else if SchubDirective(len) then msg := 'Target: SCHUB ($SCHUB at the top of the text)'
      else msg := 'Target: 65C816';
    end;
    if Pressed(scB) then begin                                     { Ctrl+B: breakpoint }
      i := BreakLine;
      if i < 4096 then begin
        Mem[DbgBits + (i shr 3)] := Mem[DbgBits + (i shr 3)] xor (1 shl (i and 7));
        if BreakAt(i) then msg := 'Breakpoint at line ' else msg := 'No breakpoint at line ';
        AddNum(i);
        if i <> curLine then Add(' (the asm line)');
        redrawAll := true;
      end;
    end;
    if Pressed(scW) then WatchKey;                                 { Ctrl+W: watch }
    if Pressed(scK) then begin                                     { Ctrl+K }
      colours := not colours;
      rowsValid := false;
      if colours then msg := 'Colours on' else msg := 'Colours off';
      redrawAll := true;
    end;
    if Pressed($80 + $6C) then begin MoveFrom; JumpTo(0); MoveTo; end;   { Ctrl+Home }
    if Pressed(scA) then begin                                     { Ctrl+A: all }
      JumpTo(len);
      if len > 0 then selA := 0;
      redrawAll := true;
    end;
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

{ the cursor to screen row (TT..) and column (0..79), or as near as the
  text allows }
procedure PlaceCursor(row, col: integer);
var p, e: longint;
    line: integer;
begin
  p := top; line := topLine;
  while (line < topLine + row - TT) and (LineEnd(p) < len) do begin
    p := LineEnd(p) + 1;
    line := line + 1;
  end;
  e := LineEnd(p);
  if p + left + col < e then cur := p + left + col else cur := e;
  curLine := line;
  wantCol := ColOf(cur);
end;

{ a click on the top line: the F-key whose name is under it (TabKeys
  starts in column 10, F10 in column 67) }
procedure TitleClick(col: integer);
var i, p: integer;
    nm: string[12];
begin
  if col >= 66 then begin FKey(10); exit; end;
  for i := 1 to 9 do begin
    case i of
      1: nm := 'F1 help'; 2: nm := 'F2 save'; 3: nm := 'F3 open'; 4: nm := 'F4 new';
      5: nm := 'F5 run'; 9: nm := 'F9 compile';
    else
      nm := '';
    end;
    if nm <> '' then begin
      p := Pos(nm, TabKeys);
      if (p > 0) and (col >= p + 8) and (col < p + 8 + length(nm)) then begin FKey(i); exit; end;
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
        if Copy(msg, 1, 11) = 'Error line ' then GoToLine(ErrLine, ErrCol)
        else if rtLine > 0 then GoToLine(rtLine, 1);
      end
      else if (row >= TT) and (row <= Rows + TT - 1) then begin
        ClearSel;
        PlaceCursor(row, col);
        dragAnchor := cur;
      end;
  end
  else if ((b and 1) <> 0) and (row >= TT) and (row <= Rows + TT - 1) and ((x div 8 <> lastMX div 8) or (y div 8 <> lastMY div 8)) then begin
    { dragged: the cursor follows and selects from where the button went down }
    if dragAnchor < 0 then dragAnchor := cur;
    mvLine := curLine;
    PlaceCursor(row, col);
    selA := dragAnchor;
    MoveTo;
  end;
  if (b and 1) = 0 then dragAnchor := -1;
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

{ Tab with a selection, Shift+Tab: two spaces more (or up to two less) at
  the start of every line the selection touches (Shift+Tab without one: the
  cursor's line). One ^Z; afterwards the lines are selected. }
procedure IndentLines(more: boolean);
var a, b, p, q, n, line0: longint;
    lines: integer;
    sel, first: boolean;
begin
  sel := HasSel;
  if sel then SelRange(a, b) else begin a := cur; b := cur; end;
  { a selection that ends at the start of a line leaves that line alone }
  if (b > a) and (Mem[TB + b - 1] = 10) then b := b - 1;
  line0 := curLine;
  for p := a to cur - 1 do if Mem[TB + p] = 10 then line0 := line0 - 1;
  p := LineStart(a);
  a := p;
  lines := 0;
  first := true;
  uJoin := 0;
  repeat
    if more then begin
      if LineEnd(p) > p then begin            { not on empty lines }
        if first then uFresh := true else uKeep := true;
        first := false;
        cur := p; InsertChars('  ');
        b := b + 2;
      end;
    end else begin
      n := 0;
      while (n < 2) and (p + n < len) and (Mem[TB + p + n] = 32) do n := n + 1;
      if n > 0 then begin
        if first then uFresh := true else uKeep := true;
        first := false;
        DeleteChars(p, n);
        if sel or (cur > p + n) then b := b - n else b := p;
      end;
    end;
    uFresh := false; uKeep := false;
    lines := lines + 1;
    q := LineEnd(p);
    if (q >= b) or (q >= len) then break;
    p := q + 1;
  until false;
  if sel then begin
    selA := a;
    cur := LineEnd(p);
    curLine := line0 + lines - 1;
  end else begin
    { Shift+Tab on the cursor's line: the cursor stays on its character }
    cur := b;
    if cur < p then cur := p;
    curLine := line0;
  end;
  wantCol := ColOf(cur);
  redrawAll := true;
end;

procedure TypedKey(k: char);
begin
  if (k = #8) and Held(scH) then exit;     { ^H: replace, not Backspace }
  clipRun := false;
  if (k = #8) or (k = #127) or (k = #9) or (k >= ' ') then NoteEdit;
  { an edit after ^Z: what ^Z said no longer holds }
  if ((k = #8) or (k = #127) or (k = #9) or (k = #13) or (k >= ' ')) and (Copy(msg, 1, 6) = 'Undone') then msg := '';
  { which edits in a row make one for ^Z }
  if k = #8 then uJoin := 2
  else if k = #127 then uJoin := 3
  else if (k = #9) or (k >= ' ') then uJoin := 1
  else uJoin := 0;
  if (k = #1) or ((k >= #28) and (k <= #31)) then begin
    { the cursor keys: with Shift they select }
    MoveFrom;
    case k of
      #28: CurRight;
      #29: CurLeft;
      #30: CurUp;
      #31: CurDown;
      #1: begin cur := LineStart(cur); wantCol := 0; end;
    end;
    MoveTo;
  end else if (k = #9) and (HasSel or ShiftHeld) then
    IndentLines(not ShiftHeld)
  else begin
    { an edit over a selection: it goes first; Backspace and Delete only take it }
    if HasSel and ((k = #8) or (k = #127) or (k = #13) or (k = #9) or (k >= ' ')) then begin
      DeleteSel;
      if (k = #8) or (k = #127) then k := #0 else uKeep := true;
    end;
    case k of
      #13: NewLine;
      #8: Backspace;
      #127: DeleteKey;
      #9: InsertChars('  ');
    else
      if (k >= ' ') and (k <> #127) then InsertChars(k);
    end;
  end;
  uJoin := 0;
  uKeep := false;
end;

{ ------------------------------------------------------------- main }
var k: char;
    i: integer;
    r: integer;
begin
  CheckBreak := false;
  aText := $6E;        { light blue on blue, like BASIC }
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
  FillMem(DbgBits, 512, 0);
  nWatch := 0; dbgActive := false;
  clipLen := 0; clipRun := false;
  primary := '';
  uTop := 0; rTop := 0; uGroup := 0; uJoin := 0; logTo := 0; uFresh := false; uKeep := false;
  selA := -1; dragAnchor := -1; clipChars := false;
  SetDrive(1);
  findText := '';
{$IFDEF SCHUB}
  msg := 'Welcome to MERIDIAN Pascal on SCHUB. F1 for help.';
{$ELSE}
  msg := 'Welcome to MERIDIAN Pascal. F1 for help.';
{$ENDIF}
  if not CartPresent then msg := 'The cartridge directory is missing';
  DrawTitle;
  for i := TT to Rows + TT - 1 do PutStr(1, i, '', aText, Cols);
  if not RecoverText then NewText;
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
  Mem[RecBase] := 0;             { left on purpose: nothing to offer back }
  EditorMouse(false);
  ResetDisplay;
  r := KernelMode(40);
end.
