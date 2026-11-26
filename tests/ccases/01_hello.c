#include <stdio.h>

int main(void)
{
    int i;
    puts("Hello, MERIDIAN!");
    for (i = 1; i <= 3; i++)
        printf("%d squared is %d\n", i, i * i);
    printf("[%5d|%-5d|%05d|%x|%X|%o|%c|%s]\n", 42, 42, 42, 255, 255, 8, 'A', "str");
    printf("%ld %lu %u %d\n", 100000L, 4000000000UL, 65535U, -32768);
    return 0;
}

/* EXPECT
Hello, MERIDIAN!
1 squared is 1
2 squared is 4
3 squared is 9
[   42|42   |00042|ff|FF|10|A|str]
100000 4000000000 65535 -32768
*/
