#ifndef _TIME_H
#define _TIME_H
#include <stddef.h>

/* clock() counts frames (60 a second); time() reads the real-time clock */
typedef long clock_t;
typedef long time_t;
#define CLOCKS_PER_SEC 60L

struct tm {
    int tm_sec, tm_min, tm_hour;
    int tm_mday, tm_mon, tm_year;     /* tm_mon 0..11, tm_year since 1900 */
    int tm_wday, tm_yday, tm_isdst;
};

clock_t clock(void);
time_t time(time_t *t);
double difftime(time_t a, time_t b);
time_t mktime(struct tm *tm);
struct tm *localtime(const time_t *t);
struct tm *gmtime(const time_t *t);
char *asctime(const struct tm *tm);
char *ctime(const time_t *t);
size_t strftime(char *buf, size_t max, const char *fmt, const struct tm *tm);

#pragma link "time.c"
#endif
