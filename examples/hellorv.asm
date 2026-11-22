; HELLORV.ASM - RISC-V assembly for the SCHUB co-processor
; .schub on the first line selects RV32IM. The program starts at $04:0400,
; behind the PASCAL cartridge's 65C816 host stub, which does the printing:
; the program asks it through the mailbox (a0 = what, a1 = value).
;   1 print the character a1      2 read a key (0 = none) into a0
;   3 Esc pressed? into a0         4 end the program
; It greets, then shows where the mouse is until a click or Esc.
        .schub

MBOX = $800403F0                ; the mailbox (uncached)
LEFT = $1D                      ; control code: cursor left

; PFORTE's mouse registers, read by SCHUB itself through the uncached alias.
; They hold a copy of the mouse state from the last write to +10, so write
; it before each look.
;   +0 X (16 bit)   +2 Y (16 bit)   +4 buttons: bit 0 left, 1 right, 2 middle
MOUSE = $8000C120

start:  li sp, $7FFF0           ; stack at the top of SCHUB's memory
        la s0, msg
        call puts
        li s1, -1               ; no position shown yet
        li s2, -1
        li s3, MOUSE
wait:   sb zero, 10(s3)         ; a fresh copy of the mouse state
        lbu t0, 4(s3)
        andi t0, t0, 7
        bnez t0, release        ; a button: the end
        li a0, 3                ; Esc?
        call sys
        bnez a0, done
        lhu s4, 0(s3)
        lhu s5, 2(s3)
        bne s4, s1, moved
        beq s5, s2, wait
moved:  mv s1, s4
        mv s2, s5
        la s0, tx
        call puts
        mv a2, s1
        call hex4
        la s0, ty
        call puts
        mv a2, s2
        call hex4
        la s0, back             ; back to the start of the line
        call puts
        j wait

release: sb zero, 10(s3)        ; wait until the button is let go
        lbu t0, 4(s3)
        andi t0, t0, 7
        bnez t0, release
done:   li a0, 1
        li a1, 13
        call sys
        li a0, 4                ; end
        li a1, 0
        call sys

; print the text at s0 (ends with 0)
puts:   addi sp, sp, -16
        sw ra, 0(sp)
putsl:  lbu a1, 0(s0)
        beqz a1, putse
        li a0, 1                ; print a1
        call sys
        addi s0, s0, 1
        j putsl
putse:  lw ra, 0(sp)
        addi sp, sp, 16
        ret

; print a2 as four hex digits
hex4:   addi sp, sp, -16
        sw ra, 0(sp)
        sw s6, 4(sp)
        li s6, 12
hexl:   srl a1, a2, s6
        andi a1, a1, 15
        li t3, 10
        blt a1, t3, hexd
        addi a1, a1, 7          ; from "9" + 1 to "A"
hexd:   addi a1, a1, 48
        li a0, 1
        call sys
        addi s6, s6, -4
        bgez s6, hexl
        lw s6, 4(sp)
        lw ra, 0(sp)
        addi sp, sp, 16
        ret

; one request to the 65C816: a0 what, a1 value; the answer in a0
sys:    li t0, MBOX
        sw a1, 8(t0)
        sw a0, 4(t0)
        li t1, 1
        sw t1, 0(t0)            ; 1: a request is waiting
        li t2, 2
wait2:  lw t1, 0(t0)
        bne t1, t2, wait2       ; 2: answered
        lw a0, 12(t0)
        sw zero, 0(t0)
        ret

msg:    .text "HELLO FROM SCHUB!", 13
        .text "MOVE THE MOUSE. CLICK OR ESC ENDS.", 13, 0
tx:     .text "X $", 0
ty:     .text "  Y $", 0
; as many cursor lefts as "X $0000  Y $0000" has characters
back:   .byte LEFT, LEFT, LEFT, LEFT, LEFT, LEFT, LEFT, LEFT
        .byte LEFT, LEFT, LEFT, LEFT, LEFT, LEFT, LEFT, LEFT, 0
