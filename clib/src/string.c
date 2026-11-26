/* MERIDIAN C - <string.h> */
#include <string.h>
#include <stdlib.h>
#pragma unit system

void *memmove(void *dst, const void *src, size_t n)
{
    char *d = dst;
    const char *s = src;
    while (n > 0xF000) { Move(s, d, 0xF000); s += 0xF000; d += 0xF000; n -= 0xF000; }
    if (n) Move(s, d, n);
    return dst;
}

void *memcpy(void *dst, const void *src, size_t n) { return memmove(dst, src, n); }

void *memset(void *dst, int c, size_t n)
{
    char *d = dst;
    while (n > 0xF000) { FillChar(d, 0xF000, c); d += 0xF000; n -= 0xF000; }
    if (n) FillChar(d, n, c);
    return dst;
}

int memcmp(const void *a, const void *b, size_t n)
{
    const unsigned char *p = a, *q = b;
    for (; n; n--, p++, q++)
        if (*p != *q) return *p < *q ? -1 : 1;
    return 0;
}

void *memchr(const void *s, int c, size_t n)
{
    const unsigned char *p = s;
    for (; n; n--, p++)
        if (*p == (unsigned char)c) return (void *)p;
    return NULL;
}

size_t strlen(const char *s)
{
    const char *p = s;
    while (*p) p++;
    return p - s;
}

size_t strnlen(const char *s, size_t max)
{
    size_t n = 0;
    while (n < max && s[n]) n++;
    return n;
}

char *strcpy(char *dst, const char *src)
{
    char *d = dst;
    while ((*d++ = *src++) != 0) ;
    return dst;
}

char *strncpy(char *dst, const char *src, size_t n)
{
    char *d = dst;
    while (n && *src) { *d++ = *src++; n--; }
    while (n) { *d++ = 0; n--; }
    return dst;
}

char *strcat(char *dst, const char *src)
{
    strcpy(dst + strlen(dst), src);
    return dst;
}

char *strncat(char *dst, const char *src, size_t n)
{
    char *d = dst + strlen(dst);
    while (n && *src) { *d++ = *src++; n--; }
    *d = 0;
    return dst;
}

int strcmp(const char *a, const char *b)
{
    while (*a && *a == *b) { a++; b++; }
    return (unsigned char)*a - (unsigned char)*b;
}

int strncmp(const char *a, const char *b, size_t n)
{
    for (; n; n--, a++, b++) {
        if (*a != *b) return (unsigned char)*a - (unsigned char)*b;
        if (!*a) return 0;
    }
    return 0;
}

static int lower(int c) { return c >= 'A' && c <= 'Z' ? c + 32 : c; }

int strcasecmp(const char *a, const char *b)
{
    while (*a && lower(*a) == lower(*b)) { a++; b++; }
    return lower((unsigned char)*a) - lower((unsigned char)*b);
}

int strncasecmp(const char *a, const char *b, size_t n)
{
    for (; n; n--, a++, b++) {
        if (lower(*a) != lower(*b)) return lower((unsigned char)*a) - lower((unsigned char)*b);
        if (!*a) return 0;
    }
    return 0;
}

int strcoll(const char *a, const char *b) { return strcmp(a, b); }

char *strchr(const char *s, int c)
{
    for (;; s++) {
        if (*s == (char)c) return (char *)s;
        if (!*s) return NULL;
    }
}

char *strrchr(const char *s, int c)
{
    const char *r = NULL;
    for (;; s++) {
        if (*s == (char)c) r = s;
        if (!*s) return (char *)r;
    }
}

char *strstr(const char *s, const char *sub)
{
    size_t n = strlen(sub);
    if (!n) return (char *)s;
    for (; *s; s++)
        if (*s == *sub && !strncmp(s, sub, n)) return (char *)s;
    return NULL;
}

size_t strspn(const char *s, const char *set)
{
    size_t n = 0;
    while (s[n] && strchr(set, s[n])) n++;
    return n;
}

size_t strcspn(const char *s, const char *set)
{
    size_t n = 0;
    while (s[n] && !strchr(set, s[n])) n++;
    return n;
}

char *strpbrk(const char *s, const char *set)
{
    for (; *s; s++)
        if (strchr(set, *s)) return (char *)s;
    return NULL;
}

char *strtok(char *s, const char *delim)
{
    static char *next;
    char *t;
    if (!s) s = next;
    if (!s) return NULL;
    s += strspn(s, delim);
    if (!*s) { next = NULL; return NULL; }
    t = s + strcspn(s, delim);
    if (*t) { *t = 0; next = t + 1; } else next = NULL;
    return s;
}

char *strdup(const char *s)
{
    char *d = malloc(strlen(s) + 1);
    if (d) strcpy(d, s);
    return d;
}

char *strerror(int e)
{
    switch (e) {
    case 0: return "no error";
    case 2: return "file not found";
    case 5: return "input/output error";
    case 12: return "out of memory";
    case 22: return "invalid argument";
    case 28: return "disk full";
    case 33: return "argument out of domain";
    case 34: return "result out of range";
    }
    return "error";
}
