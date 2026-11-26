/* MERIDIAN C - <stdlib.h>: memory, numbers, sorting, the end of the program.
   The heap is the one of the System unit (Pascal's GetMem/FreeMem). */
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#pragma unit system

int errno;

/* each block keeps its size in front of it */
typedef union { size_t n; long align; } header;

void *malloc(size_t n)
{
    header *h;
    size_t total = n + sizeof(header);
    if (total < n) return NULL;
#ifndef __SCHUB__
    if (total > 0xFF00) return NULL;
#endif
    HeapError = 1;          /* nil instead of runtime error 203 */
    h = _getmem(total);
    if (!h) { errno = ENOMEM; return NULL; }
    h->n = total;
    return h + 1;
}

void free(void *p)
{
    header *h;
    if (!p) return;
    h = (header *)p - 1;
    _freemem(h, h->n);
}

void *calloc(size_t n, size_t size)
{
    size_t t = n * size;
    void *p;
    if (size && t / size != n) return NULL;
    p = malloc(t);
    if (p) memset(p, 0, t);
    return p;
}

void *realloc(void *p, size_t n)
{
    void *q;
    size_t old;
    if (!p) return malloc(n);
    if (!n) { free(p); return NULL; }
    old = ((header *)p - 1)->n - sizeof(header);
    if (n <= old) return p;
    q = malloc(n);
    if (!q) return NULL;
    memcpy(q, p, old);
    free(p);
    return q;
}

/* ---- the end */
static void (*exitfns[16])(void);
static int nexit;

int atexit(void (*fn)(void))
{
    if (nexit >= 16) return -1;
    exitfns[nexit++] = fn;
    return 0;
}

void exit(int code)
{
    while (nexit > 0) exitfns[--nexit]();
    fflush(stdout);
    ExitCode = code;
    _halt(code);
}

void abort(void)
{
    puts("abnormal program termination");
    _halt(3);
}

void __assert_fail(const char *expr, const char *file, int line)
{
    printf("Assertion failed: %s, file %s, line %d\n", expr, file, line);
    abort();
}

/* ---- numbers */
int abs(int x) { return x < 0 ? -x : x; }
long labs(long x) { return x < 0 ? -x : x; }
div_t div(int a, int b) { div_t r; r.quot = a / b; r.rem = a % b; return r; }
ldiv_t ldiv(long a, long b) { ldiv_t r; r.quot = a / b; r.rem = a % b; return r; }

unsigned long strtoul(const char *s, char **end, int base)
{
    const char *p = s;
    unsigned long v = 0;
    int neg = 0, any = 0, d;
    while (isspace(*p)) p++;
    if (*p == '-') { neg = 1; p++; } else if (*p == '+') p++;
    if ((base == 0 || base == 16) && p[0] == '0' && (p[1] == 'x' || p[1] == 'X') && isxdigit(p[2])) { p += 2; base = 16; }
    else if (base == 0 && p[0] == '0') base = 8;
    else if (base == 0) base = 10;
    for (;; p++) {
        if (isdigit(*p)) d = *p - '0';
        else if (*p >= 'a' && *p <= 'z') d = *p - 'a' + 10;
        else if (*p >= 'A' && *p <= 'Z') d = *p - 'A' + 10;
        else break;
        if (d >= base) break;
        v = v * base + d;
        any = 1;
    }
    if (end) *end = (char *)(any ? p : s);
    return neg ? -v : v;
}

long strtol(const char *s, char **end, int base) { return (long)strtoul(s, end, base); }
int atoi(const char *s) { return (int)strtol(s, NULL, 10); }
long atol(const char *s) { return strtol(s, NULL, 10); }

double strtod(const char *s, char **end)
{
    const char *p = s;
    double v = 0, scale;
    int neg = 0, any = 0, e = 0, eneg = 0;
    while (isspace(*p)) p++;
    if (*p == '-') { neg = 1; p++; } else if (*p == '+') p++;
    while (isdigit(*p)) { v = v * 10 + (*p - '0'); p++; any = 1; }
    if (*p == '.') {
        p++;
        scale = 0.1;
        while (isdigit(*p)) { v = v + (*p - '0') * scale; scale = scale / 10; p++; any = 1; }
    }
    if (any && (*p == 'e' || *p == 'E')) {
        const char *q = p + 1;
        if (*q == '-') { eneg = 1; q++; } else if (*q == '+') q++;
        if (isdigit(*q)) {
            while (isdigit(*q)) { e = e * 10 + (*q - '0'); q++; }
            p = q;
            while (e-- > 0) v = eneg ? v / 10 : v * 10;
        }
    }
    if (end) *end = (char *)(any ? p : s);
    return neg ? -v : v;
}

float strtof(const char *s, char **end) { return strtod(s, end); }
double atof(const char *s) { return strtod(s, NULL); }

char *ltoa(long v, char *buf, int base)
{
    char tmp[34];
    int i = 0, j = 0;
    unsigned long u = v;
    if (v < 0 && base == 10) { buf[j++] = '-'; u = -v; }
    do { int d = u % base; tmp[i++] = d < 10 ? '0' + d : 'a' + d - 10; u /= base; } while (u);
    while (i) buf[j++] = tmp[--i];
    buf[j] = 0;
    return buf;
}

char *itoa(int v, char *buf, int base)
{
    if (base != 10) return ltoa((unsigned)v, buf, base);
    return ltoa(v, buf, base);
}

/* ---- random numbers: the ANSI example generator */
static unsigned long seed = 1;
int rand(void)
{
    seed = seed * 1103515245UL + 12345;
    return (int)((seed >> 16) & 32767);
}
void srand(unsigned s) { seed = s; }

/* ---- sorting: Shell sort, no recursion */
static void swapb(char *a, char *b, size_t n)
{
    char t;
    while (n--) { t = *a; *a++ = *b; *b++ = t; }
}

void qsort(void *base, size_t n, size_t size, int (*cmp)(const void *, const void *))
{
    char *b = base;
    size_t gap, i, j;
    for (gap = n / 2; gap > 0; gap /= 2)
        for (i = gap; i < n; i++)
            for (j = i; j >= gap && cmp(b + (j - gap) * size, b + j * size) > 0; j -= gap)
                swapb(b + (j - gap) * size, b + j * size, size);
}

void *bsearch(const void *key, const void *base, size_t n, size_t size, int (*cmp)(const void *, const void *))
{
    const char *b = base;
    size_t lo = 0, hi = n;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        int c = cmp(key, b + mid * size);
        if (c == 0) return (void *)(b + mid * size);
        if (c < 0) hi = mid; else lo = mid + 1;
    }
    return NULL;
}

char *getenv(const char *name) { return NULL; }
int system(const char *cmd) { return -1; }
