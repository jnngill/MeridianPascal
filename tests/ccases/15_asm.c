/* asm blocks: locals, parameters and globals by name */
#include <stdio.h>

enum { TEN = 10 };
int g;

int twice(int n)
{
    int r;
#ifdef __SCHUB__
    asm {
        lw a0, n(s0)        ; parameters take 4 bytes on SCHUB
        add a0, a0, a0
        sh a0, r(s0)
    }
#else
    asm {
        lda n               ; D is the frame: a local is a direct page address
        asl a
        sta r
    }
#endif
    return r;
}

void setg(void)
{
#ifdef __SCHUB__
    asm {
        li t0, TEN * 100
        la t1, g
        sh t0, 0(t1)
    }
#else
    asm {
        lda #TEN * 100
        sta g
    }
#endif
}

int sumto(int n)
{
    int s = 0;
#ifdef __SCHUB__
    asm {
        li t0, 0
        lh t1, n(s0)
    sloop:
        beqz t1, sdone
        add t0, t0, t1
        addi t1, t1, -1
        j sloop
    sdone:
        sh t0, s(s0)
    }
#else
    asm {
        stz s
        ldx n
    sloop:
        beq sdone
        txa
        clc
        adc s
        sta s
        dex
        bra sloop
    sdone:
    }
#endif
    return s;
}

int main(void)
{
    setg();
    printf("%d %d %d\n", twice(21), g, sumto(10));
    return 0;
}

/* EXPECT
42 1000 55
*/
