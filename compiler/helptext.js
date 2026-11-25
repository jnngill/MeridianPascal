// The PASCAL cartridge editor's help screen (F1, cart/ide.pas, procedure
// Help), kept in the cartridge ROM instead of bank 0, where the 65C816
// editor's string constants live and where room is short (the compiler's
// stack). Both builds carry it: the cartridge next to the editor's assembler
// routines (compiler/cart.js), the SCHUB editor with its externals
// (compiler/mkschubide.js). The editor finds it with the external 'helptext'
// and draws one line a row from the third text row on (the first row is the
// title, which differs between the two editors, the second is empty).
// At most 24 lines of at most 78 characters.
export const HELP_LINES = [
  'F1  this help          F2  save              F3  open (NAME.MER: run it)',
  'F4  new text           F5  compile and run   F6  next drive (1, 2, 3)',
  'F7  save as .MER (runs without the cartridge, BRUN in BASIC)',
  'F8  directory          F9  compile           F10 back to BASIC',
  '^F find  ^G next  ^H replace  ^L go to line  ^Y delete line  ^K colours',
  'As in EDIT: ^S save  ^O open  ^N new text  ^X cut line  ^C copy line  ^V paste',
  '^Z undo the last edit, again: the one before; Shift+^Z redo',
  'Shift+cursor keys or a mouse drag select (^A: all); ^X ^C ^V, typing, Del',
  '^T target 65C816 / SCHUB (or {$SCHUB} at the top)  ^R run a .MER file',
  '^Home/^End start/end of the text, PgUp PgDn Home End, Tab: two spaces',
  'Mouse: a click places the cursor, the wheel scrolls; click the F-keys on top',
  'Debug: ^B breakpoint, ^F7 trace from the start, ^W watch a variable.',
  'Stopped: F5 go, F7 into, F8 over, F4 to the cursor, ^F2 end.',
  "The language is the PC compiler's: units, nested routines, records, sets,",
  'pointers, reals, strings, files, objects, procedural types, open arrays,',
  'goto, {$R+} {$Q+} {$I-}, {$DEFINE}/{$IFDEF}, {$I file}. Your own units:',
  'USES MYUNIT reads MYUNIT.PAS from the current drive.',
  'All library units are built in: Crt Graph Sprites Audio Input Dos Blitter',
  'Copper Schub Basic, and System.',
  'Assembler: NAME.ASM or ; on top; 65C816 (ends with RTL), .SCHUB: RISC-V.',
  'Programs run in 40 columns; Esc in ReadKey or ReadLn ends them. After a',
  'crash, reset: the editor offers the unsaved text back.',
  'Press a key.',
];

for (const l of HELP_LINES) if (l.length > 78) throw new Error(`help line longer than 78: ${l}`);
if (HELP_LINES.length > 24) throw new Error('more than 24 help lines');

// the lines, each ended by LF, then 0
export function helpBytes() {
  const b = [];
  for (const l of HELP_LINES) { for (const c of l) b.push(c.charCodeAt(0) & 255); b.push(10); }
  b.push(0);
  return b;
}

const byteLines = (b) => { const o = []; for (let i = 0; i < b.length; i += 32) o.push('\t.byte ' + b.slice(i, i + 32).join(',')); return o.join('\n'); };

// 65C816 (in the cartridge, outside the library block): helptext: longint,
// the result in A (low) and X (high)
export function helpAsm816() {
  return `
	.al
	.xl
; external 'helptext': the help screen's address
rt_helptext
	rep #$30
	lda #HELPTEXT & $ffff
	ldx #HELPTEXT >> 16
	rtl
HELPTEXT
${byteLines(helpBytes())}
`;
}

// SCHUB (with the SCHUB editor's externals): the result in a0
export function helpAsmRV() {
  return `
# external 'helptext': the help screen's address
rt_helptext:
	la a0, HELPTEXT
	ret
HELPTEXT:
${byteLines(helpBytes())}
	.align 4
`;
}
