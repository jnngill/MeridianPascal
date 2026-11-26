#include <stdio.h>

static const char *name(int d)
{
    switch (d) {
    case 0: return "zero";
    case 1: case 2: return "small";
    case 3 ... 5: return "medium";
    case -1: return "minus one";
    default: return "big";
    }
}

int main(void)
{
    int i, j, n = 0;
    for (i = -1; i < 8; i++) printf("%d=%s ", i, name(i));
    printf("\n");
    i = 0;
    while (1) {
        if (++i > 10) break;
        if (i % 2) continue;
        n += i;
    }
    printf("sum of evens %d\n", n);
    i = 0;
    do { i += 3; } while (i < 20);
    printf("do %d\n", i);
    for (i = 0; i < 3; i++)
        for (j = 0; j < 3; j++) {
            if (j == i) continue;
            if (i == 2 && j == 1) goto out;
            printf("%d%d ", i, j);
        }
out:
    printf("\n");
    n = 0;
    for (int k = 0, m = 10; k < m; k++, m--) n += k * m;
    printf("comma loop %d\n", n);
    printf("%s %s\n", n > 50 ? "yes" : "no", n < 50 ? "yes" : "no");
    printf("%d %d\n", (1 && 0) || 5, 0 || (2 && 3));
    j = 0;
    if (j != 0 && 10 / j) printf("never\n"); else printf("short circuit\n");
    switch (3) {
    case 1: printf("one\n");
    case 3: printf("three ");
    case 4: printf("four ");
        break;
    case 5: printf("five\n");
    }
    printf("\n");
    {
        long big = 100000L;
        switch (big) {
        case 100000L: printf("long case\n"); break;
        default: printf("bad\n");
        }
    }
    return 0;
}

/* EXPECT
-1=minus one 0=zero 1=small 2=small 3=medium 4=medium 5=medium 6=big 7=big
sum of evens 30
do 21
01 02 10 12 20
comma loop 70
yes no
1 1
short circuit
three four
long case
*/
