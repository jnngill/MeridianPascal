# MERIDIAN Pascal

A complete Pascal development system for the **MERIDIAN 816** home computer
(65C816, MiSTer core) and its **SCHUB** RV32IM co-processor.

## Two ways to use it

| | **On a PC: Node.js** | **On the MERIDIAN: PASCAL.MOD** |
|---|---|---|
| What runs | the cross compiler and the browser IDE, on Windows, macOS or Linux | an editor and a compiler in a cartridge, on the MiSTer itself |
| You need | Node.js (no packages to install) | the MERIDIAN core with the SDRAM module |
| Get it | clone this repository | download `PASCAL.MOD` from the [latest release](https://github.com/jnngill/MeridianPascal/releases/latest), or [build it](#building-pascalmod) |
| Start | `node ide/server.js`, or `node compiler/mpc.js prog.pas` | copy it to `/media/fat/games/MERIDIAN/`, OSD → *Insert cartridge* |
| Write and run | edit in the browser, F5 runs in the built-in emulator, F8 sends to the MiSTer | edit on the MERIDIAN, F5 compiles and runs at once |
| Output | `.MER` files for 65C816 or SCHUB | the same: F7 saves a `.MER` that runs without the cartridge (`BRUN "NAME"` in BASIC) |

Both compile the same language with the same library units (on the MERIDIAN,
identifiers count to 15 characters), and both make code for either the
65C816 or SCHUB. The Node.js compiler also gives
assembly and listing views and error navigation; the cartridge needs no PC at
all. See [Start](#start) for the PC side and
[Building PASCAL.MOD](#building-pascalmod) for the cartridge.

## What's in it

- **C compiler**: C89 with the common C99 parts, for the same two targets,
  with a standard library and access to every library unit ([C](#c)).
- **Compiler**: a Turbo Pascal-style language (units, nested procedures,
  records, sets, pointers, strings, software reals, files, objects with
  virtual methods, procedural types, open arrays, `goto`, [`asm` blocks](#asm-blocks))
  with two native back ends:
  65C816 code, or RISC-V code for SCHUB with a 65C816 host stub. Its output is
  `.MER` files that run on the real machine.
- **Libraries**: `System`, `Crt`, `Graph` (PINSEL), `Sprites` (KOBOLD),
  `Audio` (ORGEL), `Input` (PFORTE), `Dos` (TRUHE/DOS), `Blitter` (KRAN),
  `Copper` (LOTSE), `Schub`, `Basic` (read and set the variables of the BASIC
  program that started the program with `BRUN`), `Workshop` (the sprites,
  tiles, maps, sounds, look and font made in BASIC's workshop: load them from
  a `.BAS` file and use them like `MAP`, `TILE`, `SFX` and `LOOK`).
- **IDE**: runs in the browser and is served by a local Node.js server with no
  dependencies. It has a code editor, build, error navigation, assembly and
  listing views, a built-in MERIDIAN emulator, and *Send to MiSTer*.
- **Emulator**: a 65C816 core and an RV32IM core plus the MERIDIAN chips. It
  runs the real kernel ROM.
- **PASCAL.MOD**: a cartridge with an editor and a compiler that run on the
  MERIDIAN itself (`node compiler/mkcart.js`, or the *PASCAL cartridge*
  button in the IDE). Insert it in the MiSTer OSD and the machine starts into
  the editor, which looks and works like the workshop's EDIT (tabs on top,
  the keys at the bottom, Ctrl+S/O/N/F/G/L/X/C/V as there, Ctrl+Z undo,
  Shift+Ctrl+Z redo, Ctrl+H replace, Shift+cursor keys or the mouse select,
  Tab and Shift+Tab indent the selected lines;
  an error in a unit opens the unit there): F5 compiles
  and runs, F2/F3 save and open on the drives,
  F7 saves a standalone `.MER` (start it from BASIC with `BRUN "NAME"`),
  Ctrl+R runs a `.MER` from a drive,
  Ctrl+T switches between 65C816 and SCHUB code, Ctrl+K turns the syntax
  colours on or off. After F5 a runtime error names its line and the
  cursor goes there. A program that hangs needs a reset; after it the editor
  offers the unsaved text back. Debugger: Ctrl+B breakpoint, Ctrl+F7 trace; when
  stopped F5 go, F7 into, F8 over, F4 to the cursor, Ctrl+W watch. With a mouse: click to place the cursor, the wheel
  scrolls, and the F-key names on the top line can be clicked.
  It also assembles: a NAME.ASM text is 65C816 assembly (or RV32IM for
  SCHUB with `.schub`), with the same F9/F5/F7 and the syntax of the PC
  assemblers (examples/hello.asm, examples/hellorv.asm; both also show
  the mouse position until a click or Esc).
  On a core with SCHUB the cartridge starts a SCHUB build of the same
  editor, compiler and assembler: it compiles about ten times faster and
  scrolls about three times faster, with the same results. The welcome line
  says "on SCHUB"; Ctrl+F10 switches to the 65C816 editor. On a core without
  SCHUB the cartridge starts the 65C816 editor.

## asm blocks

`asm ... end` is a statement of assembly for the CPU the program is compiled
for, in the syntax of the MERIDIAN assemblers. A routine marked `assembler`
has an `asm ... end` block as its body. Both compilers, the PC one and the one
in the cartridge, understand the same blocks.

```pascal
function SumTo(n: integer): integer;
var s: integer;
begin
  asm
    stz s           ; locals and parameters: direct page addresses
    ldx n
  loop:             ; a label: a name and a colon, anywhere on the line
    beq done
    txa
    clc
    adc s
    sta s
    dex
    bra loop
  done:
  end;
  SumTo := s;
end;
```

- There is one instruction on each line. A comment starts with `;`, and
  `{ }` comments work too. The block ends at the word `end`.
- Names of Pascal things stand for these values:
  - the routine's own local variables and parameters: their place in the frame;
  - global variables: their address;
  - integer constants: their value;
  - the function's name, or `Result`: its result variable.

  A `var` parameter is the place that holds its variable's address. Locals of
  an outer routine, routines, strings and reals can't be used.
- **65C816**: D is the frame, so a local is a direct page address (`lda n`,
  `sta (v)` for a `var` parameter, `lda x+2` for the high word of a
  longint). A, X and Y are free to use. The data bank must stay 0, the stack
  must be left as it was, and registers must be back to 16 bits
  (`rep #$30`) by the end of the block.
- **SCHUB**: a local is an offset from `s0` (`lw a0, n(s0)`; integers are
  16 bit: `lh`/`sh`). Parameters take 4 bytes each. a0-a7 and t0-t6 are free
  to use; s0-s11, sp, gp and tp must keep their values.
- To write code for both CPUs, use `{$IFDEF SCHUB} ... {$ELSE} ... {$ENDIF}`
  around the routines (see `tests/cases/23_asm.pas`).
- The debugger treats a block as one statement. Ctrl+B on a line inside a
  block puts the breakpoint on the block's `asm` line, where the program
  stops before the block runs; F7 and F8 run the whole block in one step.

## ExitProc and interrupts

**ExitProc** is a procedure variable that runs when the program ends: at its
`end.`, at `Halt`, after a runtime error, or when Esc stops it. Each exit
procedure may set the next one, so they chain:

```pascal
var OldExit: procedure;

procedure Done;
begin
  Mem[$C00B] := 1;           { the frame interrupt only, as before }
  ExitProc := OldExit;       { the one before runs next }
end;

begin
  OldExit := ExitProc;
  ExitProc := Done;
  ...
```

**IntProc** (65C816 programs) is a procedure variable that runs at every
interrupt. The frame interrupt comes once every frame, and a raster
line interrupt can be switched on with the graphics chip's registers:

- `Mem[$C00B]` enables interrupts: bit 0 the frame end, bit 1 the raster line.
- `Mem[$C00D]`/`Mem[$C00E]` set the raster line.
- Inside IntProc, **IntStatus** says which interrupt came (the same bits).

```pascal
procedure Tick;                { uses Graph, for SetRGB }
begin
  if IntStatus and 2 <> 0 then SetRGB(6, 10, 0, 0);   { from the raster line: red }
  if IntStatus and 1 <> 0 then SetRGB(6, 2, 3, 8);    { the top of the frame: blue }
end;

begin
  IntProc := Tick;
  Mem[$C00D] := 120; Mem[$C00E] := 0;
  Mem[$C00B] := 3;           { frame end and raster line }
  ...
```

- The program puts its own entry into the kernel's interrupt hook ($00:0300)
  when it uses IntProc, calls the hook that was there after IntProc, and puts
  it back however the program ends. The old hook acknowledges the raster line
  and the timers.
- IntProc can use the whole language. The runtime's work variables are saved
  around it, so it does not disturb the program it interrupts. Keep it short:
  it runs inside the interrupt.
- While IntProc is set, a BASIC `SONG` playing in the background stops (the
  kernel gives Timer A to a program's own hook).
- In the cartridge editor a breakpoint inside IntProc does not stop the
  program there.
- SCHUB has no interrupts of its own: IntProc and IntStatus are for 65C816
  programs; ExitProc works for both.

## C

The same toolchain also compiles **C**: open or create a `.c` file in the IDE
(*New* → *C program*) and press F5, or use `node compiler/mcc.js`. C programs
are made by the same back ends as Pascal ones, so they run on the 65C816 or
on SCHUB, and they can use every library unit.

```c
#include <stdio.h>
#include <crt.h>
#include <graph.h>

int main(void)
{
    int i;
    InitGraph();
    for (i = 0; i < 200; i++) Line(160, 120, i + 60, 20, i);
    ReadKey();
    CloseGraph();
    printf("%d lines, %.2f seconds\n", i, Frames() / 60.0);
    return 0;
}
```

**The language** is C89 with the common C99 parts: `//` comments,
declarations anywhere and in `for`, `_Bool`/`<stdbool.h>`, designated
initializers (`.x = 1`, `[3] = 5`), compound literals, `inline` (ignored),
variadic macros, `__func__`, `_Static_assert`, and GNU `case 1 ... 5`.
Structs, unions, bit-fields, enums, typedef, function pointers, struct
arguments and results, `static` locals, `goto`, `switch`, and the full
preprocessor (`#include`, `#define` with `#` and `##`, `#if`/`#elif`,
`#error`, `#pragma once`). Programs can be several files: a header can
say `#pragma link "other.c"` to bring the file in, or give them all to
`mcc` (`mcc main.c util.c`).

**Types:** `char` is 8 bit and unsigned, `short` and `int` 16 bit, `long`
32 bit (`long long` too); `float`, `double` and `long double` are the
32-bit reals of the runtime. Pointers are 16 bit into bank 0 on the 65C816
and 32 bit on SCHUB; on SCHUB structs are laid out with natural alignment.
A pointer declared `__far` is 32 bit on both and reaches all memory (chip
RAM, expansion RAM, the chips' registers; on SCHUB through the uncached
alias):

```c
#include <meridian.h>
unsigned char __far *vram = (unsigned char __far *)0x020000L;   /* the Graph bitmap */
vram[320 * y + x] = colour;
POKE(0xC00B, 1);                 /* PEEK/POKE/PEEKW/POKEW/PEEKL/POKEL: any address */
```

**The standard library** (`clib/`): `stdio.h` (`printf` and friends with
`%d %u %x %o %c %s %p %f %e %g`, widths, flags and `*`; `scanf`, `sscanf`;
files with `fopen`, `fgets`, `fread`, `fseek` ... on the drives, names like
`"1:DATA.TXT"`), `stdlib.h` (`malloc`/`free` on the System heap, `qsort`,
`bsearch`, `strtol`, `atof`, `rand`, `exit`, `atexit`), `string.h`,
`ctype.h`, `math.h`, `time.h` (`clock()` counts frames; `time()` reads the
real-time clock), `stdarg.h`, `stdint.h`, `stddef.h`, `limits.h`,
`float.h`, `assert.h`, `errno.h`, `stdbool.h`. `stdout` is the screen,
`stdin` the keyboard a line at a time.

**The library units from C:** `<crt.h>`, `<graph.h>`, `<sprites.h>`,
`<input.h>`, `<audio.h>`, `<dos.h>`, `<blitter.h>`, `<copper.h>`,
`<schub.h>`, `<basic.h>` and `<workshop.h>` make a unit's routines,
constants, variables and types visible under their Pascal names, in any
case (`ClrScr()`, `clrscr()`). The System unit is always there
(`EscPressed()`, `Random(10)`, `KernelMode(80)`, `IntToStr(n)`, ...), and
`<meridian.h>` adds PEEK/POKE. The types match up: `integer` is `int`,
`word` `unsigned`, `byte` `unsigned char`, `longint` `long`, `real`
`float`, `boolean` an int that is 0 or 1. A Pascal `string` parameter takes
a C string; a function that returns a `string` gives a `char *` (valid
until the calling function returns); a `var` parameter takes an address
(`GetTime(&h, &m, &s)`). Your own Pascal units work the same way:
`#pragma unit myunit` makes `myunit.pas` next to the program visible.

**asm blocks** work as in Pascal, with braces: `asm { ... }` holds one
instruction a line, and names of the function's locals and parameters,
globals and enum constants stand for their places and values (see
`tests/ccases/15_asm.c`). On SCHUB every parameter takes 4 bytes; `int`
is 16 bit (`lh`/`sh`).

**Things to know:** arguments are evaluated from the last to the first
(their order is unspecified in C; don't rely on it). There is no 64-bit
integer type, no `setjmp`/`longjmp`, no variable-length arrays, and old
(K&R) parameter lists are not accepted. A `__far` pointer cannot point at a
function. The C compiler runs on the PC (in the IDE and in `mcc`); the
PASCAL cartridge compiles Pascal only.

Command line:

```sh
node compiler/mcc.js examples/mandel.c               # -> examples/mandel.mer (65C816)
node compiler/mcc.js examples/mandel.c -t schub -S   # SCHUB, and the assembly
node compiler/mcc.js main.c util.c -I include -D DEBUG=1
```

## Start

```sh
node ide/server.js          # then open http://127.0.0.1:8165/
```

Press **F5** to build and run in the emulator, **F9** to build, and **F8** to
send to the MiSTer. *Send to MiSTer* needs the MiSTer address and the MERIDIAN
repository folder in *Settings*, plus an ssh key for `root`. It uses that
repository's `tools/senden.py`.

Command line:

```sh
node compiler/mpc.js examples/hello.pas              # -> examples/hello.mer (65C816)
node compiler/mpc.js examples/primes.pas -t schub    # SCHUB RV32IM
```

Copy the `.MER` file to `/media/fat/games/MERIDIAN/` and choose *Load program*
in the MiSTer menu.

## Building PASCAL.MOD

`PASCAL.MOD` is not in the repository. Each
[release](https://github.com/jnngill/MeridianPascal/releases) has a
ready-made one. To build your own from the sources here, you need Node.js
(developed with v24); there are no packages to install.

1. Get the sources:

   ```sh
   git clone https://github.com/jnngill/MeridianPascal.git
   cd MeridianPascal
   ```

2. Build the cartridge:

   ```sh
   node compiler/mkcart.js            # or: npm run cart
   ```

   This compiles the editor (`cart/ide.pas`), the on-device compiler
   (`cart/ncomp.pas`), the assembler (`cart/nasm.pas`) and every library
   unit in `lib/`, for the 65C816, and the editor, compiler and assembler
   once more for SCHUB (`compiler/mkschubide.js`). It writes `PASCAL.MOD`
   (about 700 KB) to the repository folder. When it works it prints one
   line, for example:

   ```
   .../MeridianPascal/PASCAL.MOD: 712088 bytes ROM, 406 library symbols, bank 0 data up to $A08F, programs from $2672
   ```

   Options: `-o FILE` writes somewhere else, `-l` also writes a listing
   (`PASCAL.lst`), `--no-schub` leaves the SCHUB editor out (about 390 KB). Compile errors are printed as `file(line,col): error: ...`
   and nothing is written.

   Instead of the command line you can use the *PASCAL cartridge* button in
   the IDE: it builds the cartridge, starts it in the built-in emulator and
   saves `PASCAL.MOD` in the IDE's workspace (`projects/`).

3. Optional: check it before putting it on the machine. `npm test` runs every
   suite, including the cartridge ones (`tests/cartide.js`,
   `tests/standalone.js`, `tests/brun.js`), in the emulator.

4. Put it on the MiSTer. Copy it to `/media/fat/games/MERIDIAN/` on the SD
   card, or over the network:

   ```sh
   scp PASCAL.MOD root@mister.local:/media/fat/games/MERIDIAN/
   ```

5. Load the MERIDIAN core, open the OSD (F12), choose *Insert cartridge* and
   pick `PASCAL.MOD`. The MERIDIAN restarts into the editor; F10 goes to
   BASIC. The cartridge needs the SDRAM module. `BRUN` in BASIC needs a
   MERIDIAN core from 22 November 2026 or later.

**After a rebuild:** standalone `.MER` files saved with F7 carry a
fingerprint of the library. With the PASCAL cartridge inserted, a `.MER` runs
only if the cartridge's library has the same fingerprint. Otherwise it says
that another cartridge is inserted (without a cartridge it always runs).
Changes to the editor or the on-device compiler keep the fingerprint; changes
to `lib/`, the runtime (`compiler/rt816.js`) or the 65C816 code generator
change it. After such a rebuild, load each program in the editor and press F7
again to save it with the new library.

## Tests

```sh
node tests/run.js        # language and library tests on both targets, in the emulator
node tests/crun.js       # the same for C (tests/ccases), both targets
node tests/cerrors.js    # C compile errors: message and line
node tests/examples.js   # every example, both targets
node tests/ncrun.js      # the on-device compiler (inside the cartridge, in the emulator)
node tests/cartide.js    # the cartridge IDE, driven through the keyboard
node tests/ncrun.js --schub  # the same programs compiled on the MERIDIAN for SCHUB
node tests/standalone.js # standalone .MER files saved by the cartridge IDE (65C816 and SCHUB)
node tests/schubide.js   # the editor on SCHUB: same output as on the 65C816, F5, F7, Ctrl+F10
```

## Layout

| | |
|---|---|
| `compiler/` | lexer, front end (IR), 65C816 and RV32IM back ends, both assemblers, driver, `mpc.js` CLI, cartridge builder (`cart.js`, `mkcart.js`); the C preprocessor (`cpp.js`), C front end (`cfront.js`) and `mcc.js` CLI |
| `clib/` | the C library: headers (`include/`), sources (`src/`); `mkheaders.js` makes the headers of the units |
| `cart/` | the on-device IDE (`ide.pas`) and compiler (`ncomp.pas`) of PASCAL.MOD |
| `lib/` | the units, in Pascal |
| `emu/` | 65C816 and RV32IM emulators and the MERIDIAN machine model; `emu/rom/` holds the MERIDIAN kernel and system ROMs (GPL-3.0, from the MERIDIAN repository) |
| `ide/` | `server.js` and the browser IDE in `public/` |
| `docs/` | reference manual (the IDE's Help) |
| `examples/` | example programs |
| `tests/` | test cases with expected output, harness |

The full reference is in `docs/index.html`.

## License

GPL-3.0-or-later, like MERIDIAN 816. The ROM images in `emu/rom/` come from
the MERIDIAN 816 repository (© retro-modern.net, GPL-3.0-or-later).
