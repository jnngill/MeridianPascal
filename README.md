# MERIDIAN Pascal

A complete Pascal development system for the **MERIDIAN 816** home computer
(65C816, MiSTer core) and its **SCHUB** RV32IM co-processor:

- **Compiler**: a Turbo Pascal-style language (units, nested procedures,
  records, sets, pointers, strings, software reals) with two native back ends:
  65C816 code, or RISC-V code for SCHUB with a 65C816 host stub. Its output is
  `.MER` files that run on the real machine.
- **Libraries**: `System`, `Crt`, `Graph` (PINSEL), `Sprites` (KOBOLD),
  `Audio` (ORGEL), `Input` (PFORTE), `Dos` (TRUHE/DOS), `Blitter` (KRAN),
  `Copper` (LOTSE), `Schub`.
- **IDE**: runs in the browser and is served by a local Node.js server with no
  dependencies. It has a code editor, build, error navigation, assembly and
  listing views, a built-in MERIDIAN emulator, and *Send to MiSTer*.
- **Emulator**: a 65C816 core and an RV32IM core plus the MERIDIAN chips. It
  runs the real kernel ROM.
- **PASCAL.MOD**: a cartridge with an editor and a compiler that run on the
  MERIDIAN itself (`node compiler/mkcart.js`, or the *PASCAL cartridge*
  button in the IDE). Insert it in the MiSTer OSD and the machine starts into
  the editor: F5 compiles and runs, F2/F3 save and load on the drives,
  F7 saves a standalone `.MER` (start it from BASIC with `BRUN "NAME"`),
  Ctrl+R runs a `.MER` from a drive,
  Ctrl+T switches between 65C816 and SCHUB code.

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

## Tests

```sh
node tests/run.js        # language and library tests on both targets, in the emulator
node tests/examples.js   # every example, both targets
node tests/ncrun.js      # the on-device compiler (inside the cartridge, in the emulator)
node tests/cartide.js    # the cartridge IDE, driven through the keyboard
node tests/ncrun.js --schub  # the same programs compiled on the MERIDIAN for SCHUB
node tests/standalone.js # standalone .MER files saved by the cartridge IDE (65C816 and SCHUB)
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
