/* MERIDIAN C - runtime helpers the compiler calls.
   Compiled into every C program (only what is used ends up in it). */

/* a C string as a Pascal string (length byte first, at most 255) */
char *__c2pstr(unsigned char *d, const char *s)
{
    unsigned n = 0;
    if (s)
        while (s[n] && n < 255) { d[n + 1] = s[n]; n++; }
    d[0] = n;
    return (char *)d;
}

/* a Pascal string, in place, as a C string */
char *__p2cstr(unsigned char *s)
{
    unsigned n = s[0], i;
    for (i = 0; i < n; i++) s[i] = s[i + 1];
    s[n] = 0;
    return (char *)s;
}
