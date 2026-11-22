; HELLO.ASM - 65C816 assembly for the MERIDIAN 816
; F9 assembles, F5 runs, F7 saves HELLO.MER (in BASIC: BRUN "HELLO").
; A program is called with JSL and ends with RTL. It starts in native mode
; with D = 0; set the register widths you need first.

CHROUT  = $FFC1                 ; kernel: print the character in A (JSL, A 8 bit)

        * = $2000

start   phb
        phk
        plb                     ; data bank = program bank (for msg,x)
        sep #$20                ; A 8 bit
        rep #$10                ; X and Y 16 bit
        .as
        .xl
        ldx #0
-       lda msg,x
        beq +
        jsl CHROUT
        inx
        bra -
+       plb
        rtl

msg     .text "HELLO FROM THE MERIDIAN!", 13, 0
