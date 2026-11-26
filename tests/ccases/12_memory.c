/* __far pointers, PEEK and POKE: memory outside the program's bank */
#include <stdio.h>
#include <meridian.h>

#define BUF 0xE80000L          /* expansion RAM */

struct rec { int a; long b; char c; };

unsigned char near_buf[16];

long sum(unsigned char __far *p, int n)
{
    long s = 0;
    while (n--) s += *p++;
    return s;
}

int main(void)
{
    unsigned char __far *p = (unsigned char __far *)BUF;
    unsigned int __far *w = (unsigned int __far *)(BUF + 0x100);
    struct rec __far *r = (struct rec __far *)(BUF + 0x200);
    unsigned char __far *q;
    int i;
    for (i = 0; i < 10; i++) p[i] = i * 3;
    printf("%d %d %ld\n", p[4], *(p + 9), sum(p, 10));
    POKE(BUF + 50, 0xAB);
    printf("%x %x\n", PEEK(BUF + 50), p[50]);
    w[0] = 0x1234; w[1] = 0xBEEF;
    printf("%x %x %x\n", PEEK(BUF + 0x100), PEEK(BUF + 0x101), w[1]);
    POKEL(BUF + 0x300, 0x11223344L);
    printf("%lx %x\n", PEEKL(BUF + 0x300), PEEKW(BUF + 0x302));
    r->a = -5; r->b = 100000L; r->c = 'x';
    printf("%d %ld %c\n", r->a, r->b, r[0].c);
    q = FARPTR(near_buf);
    q[3] = 77;
    printf("%d\n", near_buf[3]);
    q = p + 5;
    printf("%ld %d\n", (long)(q - p), q > p);
    printf("%d\n", (int)sizeof(p));
    return 0;
}

/* EXPECT
12 27 135
ab ab
34 12 beef
11223344 1122
-5 100000 x
77
5 1
4
*/
