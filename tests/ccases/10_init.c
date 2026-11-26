#include <stdio.h>
#include <string.h>

int nums[] = { 1, 2, 3, 4, 5 };
char msg[] = "global";
char small[3] = "ab";
const char *ptrs[] = { msg, "lit", &msg[2] };
int *pn = &nums[3];
static long table[2][3] = { { 1, 2, 3 }, { 4 } };
struct pair { int a; char *s; } pairs[] = { { 1, "one" }, { 2, "two" } };
int zeros[4];
int (*fp)(const char *) = puts;

int main(void)
{
    int local[] = { 10, 20, 30, 40, 50, 60 };
    char lmsg[] = "local";
    int partial[5] = { 7, 8 };
    struct pair lp = { 3, "three" };
    int n = 4;
    int computed[3] = { n, n * 2, n * 3 };
    char grid[2][4] = { "ab", "cde" };
    printf("%d %d %s %s %d\n", (int)(sizeof(nums) / sizeof(nums[0])), nums[4], msg, small, (int)sizeof(msg));
    printf("%s %s %s %d\n", ptrs[0], ptrs[1], ptrs[2], *pn);
    printf("%ld %ld %ld %ld\n", table[0][2], table[1][0], table[1][1], table[1][2]);
    printf("%d %s %d %s\n", pairs[0].a, pairs[0].s, pairs[1].a, pairs[1].s);
    printf("%d %d %d\n", zeros[0], zeros[3], (int)(sizeof(local) / sizeof(int)));
    printf("%d %d %s %d\n", local[0], local[5], lmsg, (int)sizeof(lmsg));
    printf("%d %d %d %d\n", partial[0], partial[1], partial[2], partial[4]);
    printf("%d %s\n", lp.a, lp.s);
    printf("%d %d %d\n", computed[0], computed[1], computed[2]);
    printf("%s %s %d\n", grid[0], grid[1], grid[0][3]);
    fp("through a pointer");
    {
        static int calls;
        calls++;
        printf("%d\n", calls);
    }
    {
        int *p = (int[]){ 9, 8, 7 };
        printf("%d %d\n", p[0], p[2]);
    }
    return 0;
}

/* EXPECT
5 5 global ab 7
global lit obal 4
3 4 0 0
1 one 2 two
0 0 6
10 60 local 6
7 8 0 0
3 three
4 8 12
ab cde 0
through a pointer
1
9 7
*/
