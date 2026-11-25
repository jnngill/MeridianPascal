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

- **Compiler**: a Turbo Pascal-style language (units, nested procedures,
  records, sets, pointers, strings, software reals, files, objects with
  virtual methods, procedural types, open arrays, `goto`) with two native back ends:
  65C816 code, or RISC-V code for SCHUB with a 65C816 host stub. Its output is
  `.MER` files that run on the real machine.
- **Libraries**: `System`, `Crt`, `Graph` (PINSEL), `Sprites` (KOBOLD),
  `Audio` (ORGEL), `Input` (PFORTE), `Dos` (TRUHE/DOS), `Blitter` (KRAN),
  `Copper` (LOTSE), `Schub`, `Basic` (read and set the variables of the BASIC
  program that started the program with `BRUN`).
- **IDE**: runs in the browser and is served by a local Node.js server with no
  dependencies. It has a code editor, build, error navigation, assembly and
  listing views, a built-in MERIDIAN emulator, and *Send to MiSTer*.
- **Emulator**: a 65C816 core and an RV32IM core plus the MERIDIAN chips. It
  runs the real kernel ROM.
- **PASCAL.MOD**: a cartridge with an editor and a compiler that run on the
  MERIDIAN itself (`node compiler/mkcart.js`, or the *PASCAL cartridge*
  button in the IDE). Insert it in the MiSTer OSD and the machine starts into
  the editor, which looks and works like the workshop's EDIT (tabs on top,
  the keys at the bottom, Ctrl+S/O/N/F/G/L/X/C/V as there, Ctrl+Z undo): F5 compiles
  and runs, F2/F3 save and open on the drives,
  F7 saves a standalone `.MER` (start it from BASIC with `BRUN "NAME"`),
  Ctrl+R runs a `.MER` from a drive,
  Ctrl+T switches between 65C816 and SCHUB code, Ctrl+K turns the syntax
  colours on or off. After F5 a runtime error names its line and the
  cursor goes there. Debugger: Ctrl+B breakpoint, Ctrl+F7 trace; when
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
| `compiler/` | lexer, front end (IR), 65C816 and RV32IM back ends, both assemblers, driver, `mpc.js` CLI, cartridge builder (`cart.js`, `mkcart.js`) |
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
