program AsmBlocks;
{ asm ... end blocks and assembler routines: locals, parameters, var
  parameters, globals, constants, labels, function results }
const
  Ten = 10;
  Minus = -3;
var
  g: integer;
  gl: longint;
  i: integer;

{$IFDEF SCHUB}
function Twice(n: integer): integer; assembler;
asm
  lw a0, n(s0)
  add a0, a0, a0
  sh a0, Twice(s0)        ; the function's name: its result (integers: 16 bit)
end;

procedure AddTo(var v: integer; k: integer);
begin
  asm
    lw t0, v(s0)          ; a var parameter holds the address
    lh t1, 0(t0)
    lw t2, k(s0)
    add t1, t1, t2
    sh t1, 0(t0)
  end;
end;

function SumTo(n: integer): integer;
var s: integer;
begin
  asm
    li t0, 0
    lw t1, n(s0)
  loop:
    beqz t1, done
    add t0, t0, t1
    addi t1, t1, -1
    j loop
  done:
    sh t0, s(s0)
  end;
  SumTo := s;
end;

function Neg(n: integer): integer; assembler;
asm
  lw t0, n(s0)
  sub t0, zero, t0
  sh t0, Result(s0)
end;

procedure SetGlobals;
begin
  asm
    li t0, Ten * 100
    la t1, g
    sh t0, 0(t1)
    li t0, Minus
    la t1, gl
    sw t0, 0(t1)
  end;
end;
{$ELSE}
function Twice(n: integer): integer; assembler;
asm
  lda n
  asl a
  sta Twice               ; the function's name: its result
end;

procedure AddTo(var v: integer; k: integer);
begin
  asm
    lda (v)               ; a var parameter holds the address
    clc
    adc k
    sta (v)
  end;
end;

function SumTo(n: integer): integer;
var s: integer;
begin
  asm
    stz s
    ldx n
  loop:
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

function Neg(n: integer): integer; assembler;
asm
  lda #0
  sec
  sbc n
  sta Result
end;

procedure SetGlobals;
begin
  asm
    lda #Ten * 100
    sta g
    lda #Minus
    sta gl
    lda #$ffff
    sta gl+2
  end;
end;
{$ENDIF}

begin
  WriteLn(Twice(21));
  i := 5;
  AddTo(i, 37);
  WriteLn(i);
  WriteLn(SumTo(10));
  SetGlobals;
  WriteLn(g, ' ', gl);
  { End in a comment and 'end' in a string do not end the block }
  asm
    nop                   ; the end of the line is a comment
  end;
  WriteLn('done');
  WriteLn(Neg(7));
end.

(* EXPECT
42
42
55
1000 -3
done
-7
*)
