#include <stdio.h>
#include <string.h>

typedef int (*binop)(int, int);
static int plus(int a, int b) { return a + b; }
static int minus(int a, int b) { return a - b; }
struct optab { char sym; binop fn; } ops[] = { { '+', plus }, { '-', minus } };
const char *tail = "abcdef" + 2;

struct inner { int v[3]; };
struct outer { char tag; struct inner in; struct inner *ip; };

void qs(int *a, int lo, int hi)
{
    int i = lo, j = hi, pivot = a[(lo + hi) / 2], t;
    int scratch[20];            /* a big frame in a recursive function */
    scratch[19] = pivot;
    while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) { t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (lo < j) qs(a, lo, j);
    if (i < hi) qs(a, i, hi);
    if (scratch[19] != pivot) puts("frame broken");
}

int big_frame(void)
{
    char buf[600];
    int i, s = 0;
    for (i = 0; i < 600; i++) buf[i] = i & 7;
    for (i = 0; i < 600; i++) s += buf[i];
    return s;
}

int main(void)
{
    int a[6] = { 1, 2, 3, 4, 5, 6 }, *p = a, i = 0;
    signed char sc = -1;
    unsigned char uc = 200;
    char c = 255;
    long l = -1;
    unsigned long ul = 0x80000000UL;
    struct outer o, o2;
    int arr[] = { 9, 4, 7, 1, 8, 2, 6, 3, 5, 0 };
    *p++ += 10;
    a[i++] *= 3;
    printf("%d %d %d %d\n", a[0], a[1], i, (int)(p - a));
    printf("%d %d %d %u\n", sc, uc, c, (unsigned)sc);
    printf("%ld %d %d\n", (long)sc, (int)(unsigned char)sc, sc < 0);
    printf("%d %d\n", l < 0, ul > 0x7FFFFFFFUL);
    printf("%d %d\n", (unsigned)-1 > 0, -1 < (int)0u);
    printf("%c %d %c %d\n", ops[0].sym, ops[0].fn(5, 3), ops[1].sym, ops[1].fn(5, 3));
    printf("%s\n", tail);
    o.tag = 'T';
    o.in.v[0] = 1; o.in.v[2] = 3;
    o.ip = &o.in;
    o2 = o;
    o2.in.v[2] = 33;
    printf("%c %d %d %d\n", o2.tag, o2.in.v[0], o.ip->v[2], o2.in.v[2]);
    qs(arr, 0, 9);
    for (i = 0; i < 10; i++) printf("%d", arr[i]);
    printf("\n%d\n", big_frame());
    printf("[\x41\101\t|\\|\'|\"]\n");
    {
        char s[8];
        int n = 0;
        while (n < 3) s[n++] = 'a' + n;
        s[n] = 0;
        printf("%s %d\n", s, n);
    }
    {
        int x = 10;
        int *px = &x, **ppx = &px;
        **ppx += 5;
        printf("%d\n", x);
    }
    {
        unsigned v = 0xF0F0;
        v >>= 4; v |= 1; v ^= 0x0F00;
        printf("%x\n", v);
    }
    {
        long big = 1;
        for (i = 0; i < 31; i++) big <<= 1;
        printf("%ld %ld\n", big, big >> 31);
    }
    printf("%d\n", (int)strlen("tab\there"));
    return 0;
}

/* EXPECT
33 2 1 1
-1 200 255 65535
-1 255 1
1 1
1 1
+ 8 - 2
cdef
T 1 3 33
0123456789
2100
[AA|\|'|"]
bcd 3
15
f
-2147483648 -1
8
*/
