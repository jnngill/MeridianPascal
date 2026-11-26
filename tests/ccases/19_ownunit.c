/* a Pascal unit of one's own, next to the C program */
#include <stdio.h>
#pragma unit cunit19

int main(void)
{
    TPoint p;
    p.x = 1; p.y = 2;
    printf("%s %d\n", Greeting, Factor);
    printf("%d %d\n", Scale(14), scale(2));
    Mirror(&p);
    printf("%d %d %d\n", p.x, p.y, Calls);
    printf("%s\n", Describe(&p, "p"));
    return 0;
}

/* EXPECT
hello from Pascal 3
42 6
2 1 2
p=(2,1)
*/
