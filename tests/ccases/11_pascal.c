/* the Pascal library units from C */
#include <stdio.h>
#include <crt.h>
#include <meridian.h>
#include <dos.h>

int main(void)
{
    char *s;
    int x, y;
    long l;
    ClrScr();
    GotoXY(5, 3);
    x = WhereX(); y = wherey();
    printf("at %d %d\n", x, y);
    printf("%d %d %d\n", Red, LightGray, ScreenRows);
    printf("%d %d\n", kbEsc, kbEnter);
    s = IntToStr(-12345L);
    printf("[%s] %d\n", s, (int)sizeof(CheckBreak));
    printf("[%s]\n", UpperCase("mixed Case"));
    printf("%d %d\n", Pos("lo", "hello"), (int)Max(3, 99));
    PutCharAt(1, 10, 'Z', 1);
    printf("%c\n", GetCharAt(1, 10));
    l = MemAvail();
    printf("%d\n", l > 1000);
    printf("%d\n", Target() == (TARGET_M816 + 0) || Target() == TARGET_SCHUB);
    printf("%s\n", DosErrorText(deNotFound));
    printf("%d\n", KeyPressed());
    return 0;
}

/* EXPECT
at 5 3
2 15 30
3 13
[-12345] 1
[MIXED CASE]
4 99
Z
1
1
FILE NOT FOUND
0
*/
