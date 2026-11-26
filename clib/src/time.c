/* MERIDIAN C - <time.h>: the frame counter and the real-time clock */
#include <time.h>
#include <stdio.h>
#include <string.h>
#pragma unit crt
#pragma unit input

clock_t clock(void) { return Frames(); }

static int leap(int y) { return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0; }
static const int mdays[12] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };

time_t mktime(struct tm *tm)
{
    long days = 0;
    int y, m, year = tm->tm_year + 1900;
    for (y = 1970; y < year; y++) days += leap(y) ? 366 : 365;
    for (m = 0; m < tm->tm_mon; m++) days += mdays[m] + (m == 1 && leap(year));
    days += tm->tm_mday - 1;
    tm->tm_yday = (int)(days - 0);
    tm->tm_wday = (int)((days + 4) % 7);
    return ((days * 24 + tm->tm_hour) * 60 + tm->tm_min) * 60L + tm->tm_sec;
}

time_t time(time_t *t)
{
    struct tm tm;
    int h, mi, s, y, mo, d, wd;
    time_t r;
    GetDate(&y, &mo, &d, &wd);
    GetTime(&h, &mi, &s);
    tm.tm_year = (y < 100 ? y + 2000 : y) - 1900;
    tm.tm_mon = mo - 1; tm.tm_mday = d;
    tm.tm_hour = h; tm.tm_min = mi; tm.tm_sec = s;
    r = mktime(&tm);
    if (t) *t = r;
    return r;
}

double difftime(time_t a, time_t b) { return (double)(a - b); }

struct tm *gmtime(const time_t *t)
{
    static struct tm tm;
    long s = *t, days = s / 86400L, rem = s % 86400L;
    int y = 1970, m = 0;
    tm.tm_hour = (int)(rem / 3600); tm.tm_min = (int)(rem / 60 % 60); tm.tm_sec = (int)(rem % 60);
    tm.tm_wday = (int)((days + 4) % 7);
    while (days >= (leap(y) ? 366 : 365)) { days -= leap(y) ? 366 : 365; y++; }
    tm.tm_yday = (int)days;
    while (days >= mdays[m] + (m == 1 && leap(y))) { days -= mdays[m] + (m == 1 && leap(y)); m++; }
    tm.tm_year = y - 1900; tm.tm_mon = m; tm.tm_mday = (int)days + 1;
    tm.tm_isdst = 0;
    return &tm;
}

struct tm *localtime(const time_t *t) { return gmtime(t); }

static const char *wd[7] = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };
static const char *mn[12] = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };

char *asctime(const struct tm *tm)
{
    static char buf[32];
    sprintf(buf, "%s %s %2d %02d:%02d:%02d %d\n", wd[tm->tm_wday % 7], mn[tm->tm_mon % 12], tm->tm_mday,
            tm->tm_hour, tm->tm_min, tm->tm_sec, tm->tm_year + 1900);
    return buf;
}

char *ctime(const time_t *t) { return asctime(localtime(t)); }

size_t strftime(char *buf, size_t max, const char *fmt, const struct tm *tm)
{
    size_t n = 0;
    char tmp[16];
    for (; *fmt && n + 1 < max; fmt++) {
        const char *s = tmp;
        if (*fmt != '%') { buf[n++] = *fmt; continue; }
        switch (*++fmt) {
        case 'Y': sprintf(tmp, "%d", tm->tm_year + 1900); break;
        case 'y': sprintf(tmp, "%02d", tm->tm_year % 100); break;
        case 'm': sprintf(tmp, "%02d", tm->tm_mon + 1); break;
        case 'd': sprintf(tmp, "%02d", tm->tm_mday); break;
        case 'H': sprintf(tmp, "%02d", tm->tm_hour); break;
        case 'M': sprintf(tmp, "%02d", tm->tm_min); break;
        case 'S': sprintf(tmp, "%02d", tm->tm_sec); break;
        case 'a': s = wd[tm->tm_wday % 7]; break;
        case 'b': s = mn[tm->tm_mon % 12]; break;
        case 'j': sprintf(tmp, "%03d", tm->tm_yday + 1); break;
        case '%': s = "%"; break;
        default: tmp[0] = '%'; tmp[1] = *fmt; tmp[2] = 0; break;
        }
        while (*s && n + 1 < max) buf[n++] = *s++;
    }
    buf[n] = 0;
    return n;
}
