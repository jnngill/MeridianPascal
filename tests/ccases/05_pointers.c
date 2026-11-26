#include <stdio.h>
#include <string.h>

int grid[3][4];
char *words[] = { "alpha", "beta", "gamma", NULL };

int strsum(const char *s) { int n = 0; while (*s) n += *s++; return n; }

void fill(int (*g)[4], int rows)
{
    int r, c;
    for (r = 0; r < rows; r++)
        for (c = 0; c < 4; c++) g[r][c] = r * 10 + c;
}

int main(void)
{
    int a[10], *p, *q, i;
    char buf[32];
    char **w;
    long la[3] = { 1L, 2L, 3L };
    long *lp = la;
    for (i = 0; i < 10; i++) a[i] = i * i;
    p = a + 3;
    q = &a[8];
    printf("%d %d %d %d\n", *p, p[2], *(q - 1), (int)(q - p));
    p++; ++p; p += 2; p -= 1;
    printf("%d %d\n", *p, p > q);
    *p++ = 99;
    printf("%d %d\n", a[6], *p);
    fill(grid, 3);
    printf("%d %d %d\n", grid[0][3], grid[2][1], grid[1][2]);
    printf("%d %d\n", (int)sizeof(grid), (int)sizeof(grid[0]));
    for (w = words; *w; w++) printf("%s:%d ", *w, (int)strlen(*w));
    printf("\n");
    strcpy(buf, "Hello");
    strcat(buf, ", world");
    printf("%s %d %d\n", buf, (int)strlen(buf), strcmp(buf, "Hello") > 0);
    printf("%s|%s|%d\n", strchr(buf, 'w'), strrchr(buf, 'l'), (int)(strstr(buf, "wor") - buf));
    printf("%d\n", strsum("ABC"));
    lp[1] += 40000L;
    printf("%ld %ld\n", lp[1], *(lp + 2));
    {
        void *v = buf;
        char *c = v;
        printf("%c%c\n", c[0], *(char *)v);
    }
    {
        int *np = NULL;
        printf("%d %d\n", np == NULL, !np);
    }
    return 0;
}

/* EXPECT
9 25 49 5
36 0
99 49
3 21 12
24 8
alpha:5 beta:4 gamma:5
Hello, world 12 1
world|ld|7
198
40002 3
HH
1 1
*/
