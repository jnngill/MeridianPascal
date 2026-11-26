// MERIDIAN Pascal - 65C816 machine-level runtime (near and far code model)
//
// Routines declared "external" in Pascal units get their arguments on the
// stack like Pascal procedures and return in A (/X); the others take
// register / rt_a, rt_b operands. Kernel calls use the long entry points
// ($FFC1 ...), so the runtime works from any bank (cartridge ROM too).

// runtime variables (near model: in the bss)
// rt_t0 .. RT_SCRATCH_END: the work variables an interrupt handler saves; then
// ExitProc, IntProc, IntStatus and the kernel's interrupt hook before IntProc
export const RT_VARS = [['rt_t0', 4], ['rt_a', 4], ['rt_b', 4], ['rt_fp', 4], ['rt_v', 4], ['rt_q', 4], ['rt_sign', 2],
  ['RT_SCRATCH_END', 0], ['rt_exitproc', 2], ['rt_intproc', 2], ['rt_intstat', 2], ['rt_oldhook', 2]];
// cartridge: fixed block at $2000 that the library init never overwrites
export const RT_VARS_CART = [['rt_savesp', 2], ['rt_heapbase', 2], ['rt_stp', 2], ['rt_t0', 4], ['rt_a', 4],
  ['rt_b', 4], ['rt_fp', 4], ['rt_v', 4], ['rt_q', 4], ['rt_sign', 2], ['rt_cS', 2], ['rt_cD', 2], ['rt_cR', 4],
  ['rt_cT', 2], ['rt_spare', 16]];

export function runtime816(far, cart) {
  const J = far ? 'jsl' : 'jsr';
  const R = far ? 'rtl' : 'rts';
  const A = (n) => n + (far ? 1 : 0);
  const JX = far ? 'jml' : 'jmp';
  return `
; ======================================================================
; runtime (65C816, ${far ? 'far' : 'near'} code model)
${far ? '' : 'rt_savesp\n\t.word 0\n'}
L_CHROUT  = $00FFC1
L_GETIN   = $00FFC4
L_MODUS   = $00FFC7
L_ANZEIGE = $00FFCA
L_STOPP   = $00FFD0

; kernel call frame: D = 0, A 8 bit (X/Y stay 16 bit)
rt_putchar              ; (c: char)
	lda ${A(3)},s
	phd
	pea $0000
	pld
	sep #$20
	jsl L_CHROUT
	rep #$20
	pld
	${R}

rt_getkey               ; : char  (0 = no key)
	phd
	pea $0000
	pld
	sep #$20
	jsl L_GETIN
	rep #$20
	pld
	and #$00ff
	${R}

rt_escape               ; : boolean (Esc next in the key buffer; consumes it)
	phd
	pea $0000
	pld
	sep #$20
	jsl L_STOPP
	rep #$20
	pld
	and #$00ff
	beq +
	lda #1
+	${R}

rt_kmode                ; (cols: integer) 40 or 80, clears the screen
	lda ${A(3)},s
	phd
	pea $0000
	pld
	sep #$20
	jsl L_MODUS
	rep #$20
	pld
	${R}

rt_kreset               ; reset the display like after a program
	phd
	pea $0000
	pld
	sep #$20
	jsl L_ANZEIGE
	rep #$20
	pld
	${R}

rt_dos                  ; (cmd: integer): integer   DOS call, parameter block at $16C0
	lda ${A(3)},s
	phd
	phb
	pea $0000
	pld
	sep #$20
	jsl $FF4000
	rep #$20
	plb
	pld
	and #$00ff
	${R}

rt_halt                 ; (code: integer)
	${JX} rt_exit

rt_heaporg              ; : pointer
	${far ? 'lda @w rt_heapbase' : 'lda #PAS_HEAP'}
	${R}

rt_sp                   ; : pointer (current stack pointer)
	tsc
	${R}

rt_target               ; : integer  1 = 65C816, 2 = SCHUB
	lda #1
	${R}

; move(const src; var dst; count: word)
rt_move
	lda ${A(3)},s
	beq _mv_done
	lda ${A(7)},s
	cmp ${A(5)},s
	bcc _mv_back
	lda ${A(7)},s
	tax
	lda ${A(5)},s
	tay
	lda ${A(3)},s
	dec a
	mvn #0,#0
_mv_done
	${R}
_mv_back
	lda ${A(7)},s
	clc
	adc ${A(3)},s
	dec a
	tax
	lda ${A(5)},s
	clc
	adc ${A(3)},s
	dec a
	tay
	lda ${A(3)},s
	dec a
	mvp #0,#0
	${R}

; fill(var dst; count: word; value: byte)
rt_fill
	lda ${A(5)},s
	beq _fi_done
	lda ${A(7)},s
	tax
	lda ${A(3)},s
	sep #$20
	sta @w 0,x
	rep #$20
	lda ${A(5)},s
	cmp #1
	beq _fi_done
	dec a
	dec a
	pha
	lda ${A(9)},s
	tax
	inc a
	tay
	pla
	mvn #0,#0
_fi_done
	${R}

; ---- runtime error: A = code; prints RUNTIME ERROR nnn and ends the program
rt_error
	rep #$30
	sta @w rt_q
	pea $0000
	pld
	lda #13
	sep #$20
	jsl L_CHROUT
	ldx #0
-	lda @l rt_errtext,x
	beq +
	jsl L_CHROUT
	inx
	bra -
+	rep #$20
	lda @w rt_q
	ldx #100
	${J} rt_div16u
	jsr rt_digit
	lda @w rt_t0+2
	ldx #10
	${J} rt_div16u
	jsr rt_digit
	lda @w rt_t0+2
	jsr rt_digit
	lda #13
	sep #$20
	jsl L_CHROUT
	rep #$20
	${JX} rt_exit
rt_digit
	ora #$30
	sep #$20
	jsl L_CHROUT
	rep #$20
	rts
rt_errtext
	.text "RUNTIME ERROR "
	.byte 0

; ---- 16-bit multiply: A = A * X
rt_mul16
	; A * X -> A (low 16 bits). The smaller factor (unsigned) is the
	; multiplier, shifted right until it is 0.
	stx @w rt_t0+2
	cmp @w rt_t0+2
	bcs +
	sta @w rt_t0+2
	txa
+	sta @w rt_t0
	lda #0
-	ldx @w rt_t0+2
	beq ++
	lsr @w rt_t0+2
	bcc +
	clc
	adc @w rt_t0
+	asl @w rt_t0
	bra -
+	${R}

; ---- 16-bit unsigned divide: A = A div X, rt_t0+2 = remainder
rt_div16u
	cpx #0
	bne +
	lda #200
	${JX} rt_error
+	stx @w rt_t0
	sta @w rt_t0+2
	lda #0
	ldx #16
-	asl @w rt_t0+2
	rol a
	cmp @w rt_t0
	bcc +
	sbc @w rt_t0
	inc @w rt_t0+2
+	dex
	bne -
	tax
	lda @w rt_t0+2
	stx @w rt_t0+2
	${R}
rt_mod16u
	${J} rt_div16u
	lda @w rt_t0+2
	${R}

; ---- signed: quotient truncates toward zero, remainder has the dividend's sign
rt_div16s
	stz @w rt_sign
	cmp #$8000
	bcc +
	eor #$ffff
	inc a
	pha
	lda #$8001
	sta @w rt_sign
	pla
+	cpx #$8000
	bcc +
	pha
	txa
	eor #$ffff
	inc a
	tax
	lda @w rt_sign
	eor #$8000
	sta @w rt_sign
	pla
+	${J} rt_div16u
	bit @w rt_sign
	bpl +
	eor #$ffff
	inc a
+	${R}
rt_mod16s
	${J} rt_div16s
	lda @w rt_sign
	lsr a
	lda @w rt_t0+2
	bcc +
	eor #$ffff
	inc a
+	${R}

; ---- 16-bit shifts: A = A shl/shr X
rt_shl16
	cpx #0
	beq +
-	asl a
	dex
	bne -
+	${R}
rt_shr16
	cpx #0
	beq +
-	lsr a
	dex
	bne -
+	${R}

; ---- 32 bit: operands in rt_a, rt_b; result in A (low) / X (high)
rt_mul32
	; low 32 bits of rt_a * rt_b (the same for signed and unsigned). The
	; multiplier is shifted right until it is 0, so small factors are quick;
	; when only rt_a fits in 16 bits, it becomes the multiplier.
	lda @w rt_b+2
	beq +
	lda @w rt_a+2
	bne +
	lda @w rt_a
	ldx @w rt_b
	sta @w rt_b
	stx @w rt_a
	lda @w rt_b+2
	stz @w rt_b+2
	sta @w rt_a+2
+	stz @w rt_q
	stz @w rt_q+2
-	lda @w rt_b
	ora @w rt_b+2
	beq ++
	lsr @w rt_b+2
	ror @w rt_b
	bcc +
	clc
	lda @w rt_q
	adc @w rt_a
	sta @w rt_q
	lda @w rt_q+2
	adc @w rt_a+2
	sta @w rt_q+2
+	asl @w rt_a
	rol @w rt_a+2
	bra -
+	ldx @w rt_q+2
	lda @w rt_q
	${R}

; unsigned rt_a div rt_b -> rt_a quotient, rt_q remainder
rt_udiv32
	lda @w rt_b
	ora @w rt_b+2
	bne +
	lda #200
	${JX} rt_error
+	stz @w rt_q
	stz @w rt_q+2
	ldy #32
-	asl @w rt_a
	rol @w rt_a+2
	rol @w rt_q
	rol @w rt_q+2
	lda @w rt_q
	sec
	sbc @w rt_b
	tax
	lda @w rt_q+2
	sbc @w rt_b+2
	bcc +
	sta @w rt_q+2
	stx @w rt_q
	inc @w rt_a
+	dey
	bne -
	${R}

rt_div32u
	${J} rt_udiv32
	ldx @w rt_a+2
	lda @w rt_a
	${R}
rt_mod32u
	${J} rt_udiv32
	ldx @w rt_q+2
	lda @w rt_q
	${R}

rt_abs32prep            ; make rt_a, rt_b positive, remember signs in rt_sign
	stz @w rt_sign
	lda @w rt_a+2
	bpl +
	${J} rt_nega
	lda #$8001
	sta @w rt_sign
+	lda @w rt_b+2
	bpl +
	lda #0
	sec
	sbc @w rt_b
	sta @w rt_b
	lda #0
	sbc @w rt_b+2
	sta @w rt_b+2
	lda @w rt_sign
	eor #$8000
	sta @w rt_sign
+	${R}
rt_nega
	lda #0
	sec
	sbc @w rt_a
	sta @w rt_a
	lda #0
	sbc @w rt_a+2
	sta @w rt_a+2
	${R}
rt_div32s
	${J} rt_abs32prep
	${J} rt_udiv32
	bit @w rt_sign
	bpl +
	${J} rt_nega
+	ldx @w rt_a+2
	lda @w rt_a
	${R}
rt_mod32s
	${J} rt_abs32prep
	${J} rt_udiv32
	lda @w rt_sign
	lsr a
	bcc +
	lda #0
	sec
	sbc @w rt_q
	sta @w rt_q
	lda #0
	sbc @w rt_q+2
	sta @w rt_q+2
+	ldx @w rt_q+2
	lda @w rt_q
	${R}

rt_shl32
	ldy @w rt_b
	beq +
-	asl @w rt_a
	rol @w rt_a+2
	dey
	bne -
+	ldx @w rt_a+2
	lda @w rt_a
	${R}
rt_shr32
	ldy @w rt_b
	beq +
-	lsr @w rt_a+2
	ror @w rt_a
	dey
	bne -
+	ldx @w rt_a+2
	lda @w rt_a
	${R}

; compare rt_a with rt_b -> A = -1 / 0 / 1 (flags from the final load)
rt_cmp32s
	lda @w rt_a+2
	eor #$8000
	sta @w rt_a+2
	lda @w rt_b+2
	eor #$8000
	sta @w rt_b+2
rt_cmp32u
	lda @w rt_a+2
	cmp @w rt_b+2
	bne +
	lda @w rt_a
	cmp @w rt_b
	bne +
	lda #0
	${R}
+	bcc +
	lda #1
	${R}
+	lda #$ffff
	${R}

; ---- far memory (24-bit address in rt_fp, offset in Y)
rt_ldf8
	phd
	pea rt_fp
	pld
	sep #$20
	lda [$00],y
	rep #$20
	pld
	and #$00ff
	${R}
rt_ldf16
	phd
	pea rt_fp
	pld
	lda [$00],y
	pld
	${R}
rt_ldf32
	phd
	pea rt_fp
	pld
	iny
	iny
	lda [$00],y
	tax
	dey
	dey
	lda [$00],y
	pld
	${R}
rt_stf8
	phd
	pea rt_fp
	pld
	lda @w rt_v
	sep #$20
	sta [$00],y
	rep #$20
	pld
	${R}
rt_stf16
	phd
	pea rt_fp
	pld
	lda @w rt_v
	sta [$00],y
	pld
	${R}
rt_stf32
	phd
	pea rt_fp
	pld
	lda @w rt_v
	sta [$00],y
	iny
	iny
	lda @w rt_v+2
	sta [$00],y
	pld
	${R}
${cart ? CART_RUNTIME : ''}`;
}

// cartridge-only runtime: run a program compiled on the MERIDIAN (bank 0
// saved in bank $31 meanwhile), and a catch/throw pair that the on-device
// compiler uses to abort on its first error
const CART_RUNTIME = `
RUNSAVE = $31FFF0
rt_runuser              ; (entry: longint)
	rep #$30
	lda 4,s
	sta @l RUNSAVE
	lda 6,s
	sta @l RUNSAVE+2
	tsc
	sta @l RUNSAVE+4
	tdc
	sta @l RUNSAVE+6
	phb
	ldx #$2000
	ldy #$2000
	lda #$97FF
	mvn #$00,#$31
	plb
	lda #$017F              ; below whatever the kernel keeps on its stack page
	tcs
	lda #0
	tcd
	lda @l RUNSAVE
	sta @w rt_t0
	lda @l RUNSAVE+2
	sta @w rt_t0+2
	sep #$20
	phk
	rep #$20
	pea rt_runret-1
	jml [rt_t0]
rt_runret
	rep #$30
	ldx #$2000
	ldy #$2000
	lda #$97FF
	mvn #$31,#$00
	lda @l RUNSAVE+4
	tcs
	lda @l RUNSAVE+6
	tcd
	rtl

; run a .MER file: the DOS parameter block ($16C0) names it, with load address
; $FFFFFF (= the one in its header). Bank 0 is saved like for rt_runuser, the
; file is loaded and called at its load address (JSL, back with RTL).
rt_runmer               ; : integer  DOS error, 0 = it ran
	rep #$30
	tsc
	sta @l RUNSAVE+4
	tdc
	sta @l RUNSAVE+6
	phb
	ldx #$2000
	ldy #$2000
	lda #$97FF
	mvn #$00,#$31
	plb
	lda #$017F
	tcs
	lda #0
	tcd
	sep #$20
	jsl $FF4000             ; A = 0: load
	rep #$20
	and #$00ff
	sta @l RUNSAVE+8
	bne rm_back
	sep #$20
	phk
	rep #$20
	pea rm_ret-1
	jml [$16E4]             ; D_ADR: where the DOS put it
rm_ret
	rep #$30
	lda #0
	sta @l RUNSAVE+8
rm_back
	rep #$30
	ldx #$2000
	ldy #$2000
	lda #$97FF
	mvn #$31,#$00
	lda @l RUNSAVE+4
	tcs
	lda @l RUNSAVE+6
	tcd
	lda @l RUNSAVE+8
	rtl

rt_catch                ; : integer  0 now, 1 when rt_throw comes back here
	tsc
	clc
	adc #3
	sta @w rt_cS
	tdc
	sta @w rt_cD
	lda 1,s
	sta @w rt_cR
	lda 2,s
	sta @w rt_cR+1
	lda @w rt_stp
	sta @w rt_cT
	lda #0
	rtl
rt_throw
	rep #$30
	lda @w rt_cS
	tcs
	lda @w rt_cD
	tcd
	lda @w rt_cT
	sta @w rt_stp
	sep #$20
	lda @w rt_cR+2
	pha
	rep #$20
	lda @w rt_cR
	pha
	lda #1
	rtl
`;
