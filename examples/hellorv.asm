; HELLORV.ASM - RISC-V assembly for the SCHUB co-processor
; .schub on the first line selects RV32IM. The program starts at $04:0400,
; behind the PASCAL cartridge's 65C816 host stub, which does the printing:
; the program asks it through the mailbox (a0 = what, a1 = value).
;   1 print the character a1      2 read a key (0 = none) into a0
;   3 Esc pressed? into a0         4 end the program
        .schub

MBOX = $800403F0                ; the mailbox (uncached)

start:  li sp, $7FFF0           ; stack at the top of SCHUB's memory
        la s0, msg
loop:   lbu a1, 0(s0)
        beqz a1, done
        li a0, 1                ; print a1
        call sys
        addi s0, s0, 1
        j loop
done:   li a0, 4                ; end
        li a1, 0
        call sys

; one request to the 65C816: a0 what, a1 value; the answer in a0
sys:    li t0, MBOX
        sw a1, 8(t0)
        sw a0, 4(t0)
        li t1, 1
        sw t1, 0(t0)            ; 1: a request is waiting
        li t2, 2
wait:   lw t1, 0(t0)
        bne t1, t2, wait        ; 2: answered
        lw a0, 12(t0)
        sw zero, 0(t0)
        ret

msg:    .text "HELLO FROM SCHUB!", 13, 0
