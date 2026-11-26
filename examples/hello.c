/* Hello in C: the C standard library and the Crt unit side by side */
#include <stdio.h>
#include <crt.h>

int main(void)
{
    int i;
    ClrScr();
    TextColor(Yellow);
    printf("Hello from MERIDIAN C!\n\n");
    TextColor(White);
    for (i = 1; i <= 10; i++)
        printf("%2d * %2d = %3d\n", i, i, i * i);
    printf("\nPress a key.\n");
    ReadKey();
    return 0;
}
