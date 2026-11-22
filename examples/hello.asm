; HELLO.ASM - 65C816 assembly for the MERIDIAN 816
; F9 assembles, F5 runs, F7 saves HELLO.MER (in BASIC: BRUN "HELLO").
; A program is called with JSL and ends with RTL. It starts in native mode
; with D = 0; set the register widths you need first.
; It greets, then shows where the mouse is until a click or Esc.

CHROUT  = $FFC1                 ; kernel: print the character in A (A 8 bit)
ESCAPE  = $FFD0                 ; kernel: A = 3 when Esc was pressed (JSL)
LEFT    = $1D                   ; CHROUT control code: cursor left

; PFORTE mouse registers. They hold a copy of the mouse state from the last
; write to MOUSE_GET, so write it before each look.
MOUSE_X = $00C120               ; 16 bit
MOUSE_Y = $00C122               ; 16 bit
MOUSE_B = $00C124               ; buttons: bit 0 left, 1 right, 2 middle
MOUSE_GET = $00C12A

        * = $2000

start   phb
        phk
        plb                     ; data bank = program bank (for msg,x)
        sep #$20                ; A 8 bit
        rep #$10                ; X and Y 16 bit
        .as
        .xl
        ldx #msg
        jsr print
        rep #$20
        .al
        lda #$FFFF              ; no position shown yet
        sta lastx
        sep #$20
        .as

wait    lda #0
        sta @l MOUSE_GET        ; a fresh copy of the mouse state
        lda @l MOUSE_B
        and #7
        bne release             ; a button: the end
        jsl ESCAPE
        cmp #3
        beq done
        rep #$20
        .al
        lda @l MOUSE_X
        cmp lastx
        bne moved
        lda @l MOUSE_Y
        cmp lasty
        bne moved
        sep #$20
        .as
        bra wait

        .al
moved   lda @l MOUSE_X
        sta lastx
        lda @l MOUSE_Y
        sta lasty
        sep #$20
        .as
        ldx #tx
        jsr print
        lda lastx+1
        jsr hex
        lda lastx
        jsr hex
        ldx #ty
        jsr print
        lda lasty+1
        jsr hex
        lda lasty
        jsr hex
        ldx #back               ; back to the start of the line
        jsr print
        bra wait

release lda #0                  ; wait until the button is let go
        sta @l MOUSE_GET
        lda @l MOUSE_B
        and #7
        bne release
done    lda #13
        jsl CHROUT
        plb
        rtl

; print the text at X (ends with 0)
print   lda @w $0000,x
        beq +
        jsl CHROUT
        inx
        bra print
+       rts

; print A as two hex digits
hex     pha
        lsr a
        lsr a
        lsr a
        lsr a
        jsr digit
        pla
        and #$0F
digit   cmp #10
        bcc +
        adc #6                  ; carry is set: + 7, from "9" + 1 to "A"
+       adc #'0'
        jsl CHROUT
        rts

msg     .text "HELLO FROM THE MERIDIAN!", 13
        .text "MOVE THE MOUSE. CLICK OR ESC ENDS.", 13, 0
tx      .text "X $", 0
ty      .text "  Y $", 0
back    .fill 16, LEFT          ; as many as "X $0000  Y $0000" has characters
        .byte 0
lastx   .word 0
lasty   .word 0
