/* a program in two files: the other one is linked by a #pragma */
#include <stdio.h>
#include "util16.h"

int shared = 5;

int main(void)
{
    printf("%d %d %s\n", triple(7), bump(), util_name);
    int b = bump();     /* arguments are evaluated from the last to the first */
    printf("%d %d\n", b, shared);
    return 0;
}

/* EXPECT
21 6 util
7 7
*/
