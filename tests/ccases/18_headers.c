/* every header of the library compiles, and a few things from them */
#include <assert.h>
#include <ctype.h>
#include <errno.h>
#include <float.h>
#include <limits.h>
#include <math.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <meridian.h>
#include <crt.h>
#include <graph.h>
#include <sprites.h>
#include <input.h>
#include <audio.h>
#include <dos.h>
#include <blitter.h>
#include <copper.h>
#include <schub.h>
#include <workshop.h>

struct s { char c; long l; };

int main(void)
{
    struct tm tm;
    time_t t;
    char buf[40];
    bool ok = true;
    uint8_t u8 = 255;
    int32_t i32 = INT32_MIN;
    assert(ok);
    printf("%d %d %ld %u\n", INT_MAX, u8 + 1, (long)i32, UINT16_MAX);
    printf("%d\n", (int)offsetof(struct s, c));
    memset(&tm, 0, sizeof tm);
    tm.tm_year = 126; tm.tm_mon = 10; tm.tm_mday = 26; tm.tm_hour = 12;
    t = mktime(&tm);
    strftime(buf, sizeof buf, "%Y-%m-%d %H:%M %a", gmtime(&t));
    printf("%ld %s\n", t, buf);
    printf("%d\n", clock() >= 0);
    printf("%d %d\n", (int)(FLT_EPSILON < 1e-6), isnan(NAN) && !isnan(1.0));
    return 0;
}

/* EXPECT
32767 256 -2147483648 65535
0
1795694400 2026-11-26 12:00 Thu
1
1 1
*/
