#include <stdio.h>

int g = 7;
long big = 123456789L;
unsigned char uc = 250;
signed char sc = -100;

int main(void)
{
    int a = 17, b = -5;
    unsigned u = 40000U;
    long l = -70000L;
    unsigned long ul = 3000000000UL;
    printf("%d %d %d %d %d\n", a + b, a - b, a * b, a / b, a % b);
    printf("%d %d %d\n", -17 / 5, -17 % 5, 17 / -5);
    printf("%u %u %u\n", u + 30000U, u / 3, u % 7);
    printf("%ld %ld %ld %ld\n", l * 3, l / 7, l % 7, l + big);
    printf("%lu %lu\n", ul / 7, ul % 1000);
    printf("%d %d %d %d\n", a << 3, a >> 2, b >> 1, -1 >> 4);
    printf("%ld %ld %lu\n", l >> 4, l << 3, ul >> 28);
    printf("%d %d %d\n", a & 12, a | 12, a ^ 12);
    printf("%d %d %d\n", ~a, !a, !0);
    printf("%d %d\n", uc + 10, sc - 30);
    uc += 10; sc -= 30;
    printf("%d %d\n", uc, sc);
    printf("%d %d %d %d\n", a > b, a < b, (unsigned)b > 5u, b < 5);
    printf("%d\n", (int)(long)70000L);
    printf("%ld\n", (long)a * 10000);
    g *= 3; g -= 1; g /= 2; g <<= 2; g %= 7;
    printf("%d\n", g);
    {
        int x = 5, y;
        y = x++ + ++x;
        printf("%d %d\n", x, y);
        y = x-- - --x;
        printf("%d %d\n", x, y);
    }
    printf("%d %d\n", sizeof(int), sizeof(long));
    printf("%d\n", 32767 + 1 == -32768);
    printf("%lu\n", 0xFFFFFFFFUL + 1UL);
    printf("%d %d\n", 1000 * 1000 / 1000, (int)(1000L * 1000L / 1000L));
    return 0;
}

/* EXPECT
12 22 -85 -3 2
-3 -2 -3
4464 13333 2
-210000 -10000 0 123386789
428571428 0
136 4 -3 -1
-4375 -560000 11
0 29 29
-18 0 1
260 -130
4 126
1 0 1 1
4464
170000
5
7 12
5 2
2 4
1
0
16 1000
*/
