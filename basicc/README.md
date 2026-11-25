# MERIDIAN BASIC compiler (prototype)

Compiles a MERIDIAN BASIC program, written as text with line numbers the way
it is typed, into a `.MER` for the 65C816. It translates the BASIC to Pascal
and builds that with MERIDIAN Pascal (`compiler/`).

```
node basicc/bc.js GAME.BAS            -> GAME.MER
node basicc/bc.js GAME.BAS --pas      -> also GAME.PAS, the Pascal it made
node basicc/compare.js GAME.BAS       interpreted vs compiled: output and time
node basicc/profile.js GAME.BAS       where the compiled program spends its time
node basicc/tests/run.js [--bench]    tests: same output as the real interpreter
```

The comparison runs the **real MERIDIAN BASIC ROM** in the emulator, using
the ROMs in `../MERIDIAN_SCHUB_MiSTer/rom` (set `MERIDIAN_CORE_ROM` to use
other ROMs). `interp.js` adds the two things BASIC needs that the emulator did
not model: the SPIEGEL bank mirror ($C800 bit 0) and waking from `WAI` at the
frame interrupt.

## How it works

- **Lexing like Microsoft's CRUNCH.** Keywords are found anywhere outside
  strings, so `SCORE` is `SC OR E`, exactly as in BASIC. Only the first two
  letters of a name count.
- **Whole-number variables become 32-bit integers.** A numeric variable is a
  real only if something real can be stored in it: a `/` or `^`, `SIN`,
  `RND`, `VAL`, `INPUT`, a real constant, or another real variable. `INT(a/b)`
  of whole numbers is an integer division. Constants are folded the way BASIC
  computes them.
- **Loops are matched at compile time.** FOR/NEXT, WHILE/WEND and
  REPEAT/UNTIL become jumps. GOSUB/RETURN uses a stack of return points.
- **MERIDIAN commands call the kernel routines BASIC calls**: `SPRITE`,
  `PATTERN`, `PALETTE`, `BLIT`, `STAMP`, `GRADIENT`, `MOUSE`, `SILENCE`,
  `GRAPHIC`, `PLOT`, `LINE`, and the functions `KEY JOY HIT CLOCK MOUSE`. So
  they behave exactly as in BASIC. Their addresses are taken from `kern.lbl`
  when compiling, because `bb_befehl`, `bb_funktion`, `punkt`, `linie` and
  `grafik_setzen` are not in the kernel's jump table. **A compiled program
  only runs on the kernel build it was compiled against.**
- Esc stops a compiled program (checked every 256 loop iterations or
  backward jumps), with `BREAK IN line`.

## Differences from the interpreter

- Reals are IEEE single precision: about 7 digits, not 9. `PRINT 1/3` shows
  `.3333333`.
- 32-bit integers can overflow where BASIC would switch to floating point,
  for example a product of two large variables beyond 2^31.
- Arrays need `DIM` with constant sizes, or they get the default size of 10.
  String array elements hold up to 80 characters.
- `RND` is a different generator: the numbers are random, but not BASIC's
  sequence.

## Not in the prototype yet

`DEF FN`, `SOUND`, `PLAY`, `SONG`, `SAMPLE`, `SFX`, `MAP`, `TILE`, `SHINE`,
`GLOW`, `INK`, `LOOK`, `MODE`, `NET`, `USR`, `WAIT`, the file commands, a full
`INPUT`, string `DIM` sizes and dynamic `DIM`, tokenized `.BAS` files, and
the workshop data saved with a program. The SCHUB target is also missing.
