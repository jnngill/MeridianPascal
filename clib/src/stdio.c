/* MERIDIAN C - <stdio.h>
   The screen and the keyboard through the System unit, files through its
   file buffers (a bank of expansion RAM each, read and written directly). */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <errno.h>
#pragma unit system

struct __FILE {
    int kind;           /* 0 the screen, 1 the keyboard, 2 a file */
    int mode;           /* 'r', 'w' or 'a' */
    int update;         /* "+": reading and writing */
    int eof, err;
    int unget;          /* a character given back, or -1 */
    _TFile f;
};

static FILE con_out = { 0, 'w', 0, 0, 0, -1 };
static FILE con_in = { 1, 'r', 0, 0, 0, -1 };
FILE *stdout = &con_out;
FILE *stderr = &con_out;
FILE *stdin = &con_in;

/* ---- the screen */
int putchar(int c)
{
    if (c == '\n') _putchar(13);
    else _putchar(c);
    return c & 255;
}

int puts(const char *s)
{
    while (*s) putchar(*s++);
    putchar('\n');
    return 0;
}

/* ---- the keyboard: a line at a time */
static unsigned char line[258];
static int lpos = -1, llen;

int getchar(void)
{
    int c;
    if (con_in.unget >= 0) { c = con_in.unget; con_in.unget = -1; return c; }
    if (lpos < 0) {
        _readstr(line, 255);
        _readlnend();
        llen = line[0];
        lpos = 1;
    }
    if (lpos <= llen) return line[lpos++];
    lpos = -1;
    return '\n';
}

char *gets(char *buf)
{
    int c, n = 0;
    while ((c = getchar()) != '\n' && c != EOF) buf[n++] = c;
    buf[n] = 0;
    return buf;
}

/* ---- files */
FILE *fopen(const char *name, const char *mode)
{
    FILE *fp = calloc(1, sizeof(FILE));
    if (!fp) return NULL;
    fp->kind = 2;
    fp->unget = -1;
    fp->mode = mode[0];
    fp->update = strchr(mode, '+') != NULL;
    IOResult();
    Assign(&fp->f, name);
    if (mode[0] == 'r') _freset(&fp->f, 1);
    else if (mode[0] == 'w') _frewrite(&fp->f, 1);
    else if (mode[0] == 'a') {
        _freset(&fp->f, 1);
        if (IOResult() != 0) _frewrite(&fp->f, 1);
        else fp->f.pos = fp->f.len;
    } else { free(fp); errno = EINVAL; return NULL; }
    if (IOResult() != 0) { free(fp); errno = ENOENT; return NULL; }
    return fp;
}

int fclose(FILE *fp)
{
    int r;
    if (!fp || fp->kind != 2) return 0;
    IOResult();
    Close(&fp->f);
    r = IOResult();
    free(fp);
    if (r) { errno = EIO; return EOF; }
    return 0;
}

int fgetc(FILE *fp)
{
    int c;
    if (fp->unget >= 0) { c = fp->unget; fp->unget = -1; return c; }
    if (fp->kind == 1) return getchar();
    if (fp->kind != 2 || (fp->mode != 'r' && !fp->update)) { fp->err = 1; return EOF; }
    if (fp->f.pos >= fp->f.len) { fp->eof = 1; return EOF; }
    c = *(unsigned char __far *)(fp->f.buf + fp->f.pos);
    fp->f.pos++;
    return c;
}

int ungetc(int c, FILE *fp)
{
    if (c == EOF) return EOF;
    fp->unget = c & 255;
    fp->eof = 0;
    return c & 255;
}

int fputc(int c, FILE *fp)
{
    if (fp->kind == 0) return putchar(c);
    if (fp->kind != 2 || (fp->mode == 'r' && !fp->update)) { fp->err = 1; return EOF; }
    if (fp->f.pos >= 65536L) { fp->err = 1; errno = ENOSPC; return EOF; }
    *(unsigned char __far *)(fp->f.buf + fp->f.pos) = c;
    fp->f.pos++;
    if (fp->f.pos > fp->f.len) fp->f.len = fp->f.pos;
    fp->f.dirty = 1;
    return c & 255;
}

int fputs(const char *s, FILE *fp)
{
    while (*s)
        if (fputc(*s++, fp) == EOF) return EOF;
    return 0;
}

char *fgets(char *buf, int n, FILE *fp)
{
    int i = 0, c = 0;
    if (n <= 0) return NULL;
    while (i < n - 1 && (c = fgetc(fp)) != EOF) {
        buf[i++] = c;
        if (c == '\n') break;
    }
    buf[i] = 0;
    if (i == 0 && c == EOF) return NULL;
    return buf;
}

size_t fread(void *buf, size_t size, size_t n, FILE *fp)
{
    unsigned char *p = buf;
    size_t i, k;
    int c;
    for (i = 0; i < n; i++)
        for (k = 0; k < size; k++) {
            if ((c = fgetc(fp)) == EOF) return i;
            *p++ = c;
        }
    return n;
}

size_t fwrite(const void *buf, size_t size, size_t n, FILE *fp)
{
    const unsigned char *p = buf;
    size_t i, k;
    for (i = 0; i < n; i++)
        for (k = 0; k < size; k++)
            if (fputc(*p++, fp) == EOF) return i;
    return n;
}

int fseek(FILE *fp, long off, int whence)
{
    long p;
    if (fp->kind != 2) return -1;
    if (whence == SEEK_CUR) p = fp->f.pos + off;
    else if (whence == SEEK_END) p = fp->f.len + off;
    else p = off;
    if (p < 0 || p > fp->f.len) return -1;
    fp->f.pos = p;
    fp->eof = 0;
    fp->unget = -1;
    return 0;
}

long ftell(FILE *fp) { return fp->kind == 2 ? fp->f.pos - (fp->unget >= 0) : -1L; }
void rewind(FILE *fp) { fseek(fp, 0L, SEEK_SET); fp->err = 0; }
int fgetpos(FILE *fp, fpos_t *pos) { *pos = ftell(fp); return 0; }
int fsetpos(FILE *fp, const fpos_t *pos) { return fseek(fp, *pos, SEEK_SET); }
int feof(FILE *fp) { return fp->eof; }
int ferror(FILE *fp) { return fp->err; }
void clearerr(FILE *fp) { fp->eof = fp->err = 0; }
int fflush(FILE *fp) { return 0; }

int remove(const char *name)
{
    _TFile f;
    IOResult();
    Assign(&f, name);
    Erase(&f);
    return IOResult() ? -1 : 0;
}

int rename(const char *from, const char *to)
{
    _TFile f;
    IOResult();
    Assign(&f, from);
    Rename(&f, to);
    return IOResult() ? -1 : 0;
}

void perror(const char *s)
{
    if (s && *s) printf("%s: ", s);
    puts(strerror(errno));
}

/* ---- printf */
struct sink { FILE *fp; char *buf; size_t n, max; };

static void out(struct sink *s, int c)
{
    if (s->fp) fputc(c, s->fp);
    else if (s->n + 1 < s->max) s->buf[s->n] = c;
    s->n++;
}

static void pad(struct sink *s, int c, int n)
{
    while (n-- > 0) out(s, c);
}

#define F_LEFT 1
#define F_PLUS 2
#define F_SPACE 4
#define F_ZERO 8
#define F_ALT 16

/* digits (reversed in d), a prefix, the padding */
static void emitnum(struct sink *s, const char *pre, const char *d, int nd, int flags, int width)
{
    int np = strlen(pre);
    int padn = width - nd - np;
    if (!(flags & F_LEFT) && !(flags & F_ZERO)) pad(s, ' ', padn);
    while (*pre) out(s, *pre++);
    if (!(flags & F_LEFT) && (flags & F_ZERO)) pad(s, '0', padn);
    while (nd > 0) out(s, d[--nd]);
    if (flags & F_LEFT) pad(s, ' ', padn);
}

static void fmtint(struct sink *s, unsigned long u, int neg, int base, int upper, int flags, int width, int prec)
{
    char d[40], pre[4];
    int n = 0, k = 0;
    const char *dig = upper ? "0123456789ABCDEF" : "0123456789abcdef";
    if (!(prec == 0 && u == 0))
        do { d[n++] = dig[(int)(u % base)]; u /= base; } while (u);
    while (n < prec && n < 38) d[n++] = '0';
    if (neg) pre[k++] = '-';
    else if (flags & F_PLUS) pre[k++] = '+';
    else if (flags & F_SPACE) pre[k++] = ' ';
    if ((flags & F_ALT) && base == 16 && n && !(n == 1 && d[0] == '0')) { pre[k++] = '0'; pre[k++] = upper ? 'X' : 'x'; }
    if ((flags & F_ALT) && base == 8 && (n == 0 || d[n - 1] != '0')) d[n++] = '0';
    pre[k] = 0;
    if (prec >= 0) flags &= ~F_ZERO;
    emitnum(s, pre, d, n, flags, width);
}

/* a float as text (no sign): fixed with prec decimals, or d.ddde+xx */
static float p10(int n) { float r = 1; while (n-- > 0) r *= 10; return r; }

static int digitsof(char *d, long v, int min)
{
    int n = 0;
    do { d[n++] = '0' + (int)(v % 10); v /= 10; } while (v);
    while (n < min) d[n++] = '0';
    return n;    /* reversed */
}

static int fmte(char *o, float v, int prec, int upper, int alt)
{
    char d[16];
    int e = 0, n, i, k = 0;
    long ip;
    if (prec > 8) prec = 8;
    if (v != 0) {
        while (v >= 10) { v /= 10; e++; }
        while (v < 1) { v *= 10; e--; }
    }
    ip = (long)(v * p10(prec) + 0.5f);
    if (ip >= (long)p10(prec + 1)) { ip /= 10; e++; }
    n = digitsof(d, ip, prec + 1);
    o[k++] = d[--n];
    if (prec > 0 || alt) o[k++] = '.';
    for (i = 0; i < prec; i++) o[k++] = n > 0 ? d[--n] : '0';
    o[k++] = upper ? 'E' : 'e';
    if (e < 0) { o[k++] = '-'; e = -e; } else o[k++] = '+';
    if (e >= 10) o[k++] = '0' + e / 10; else o[k++] = '0';
    o[k++] = '0' + e % 10;
    o[k] = 0;
    return k;
}

static int fmtf(char *o, float v, int prec, int upper, int alt)
{
    char d[24];
    int n, k = 0;
    long ip;
    long fp;
    float lim;
    if (prec > 9) prec = 9;
    lim = p10(prec);
    if (v >= 2.0e9f) {
        /* the float's 8 digits, then zeros */
        int e = 0;
        while (v >= 1.0e8f) { v /= 10; e++; }
        n = digitsof(d, (long)(v + 0.5f), 1);
        while (n > 0) o[k++] = d[--n];
        while (e-- > 0) o[k++] = '0';
        fp = 0;
    } else {
        ip = (long)v;
        fp = (long)((v - ip) * lim + 0.5f);
        if (fp >= (long)lim) { fp -= (long)lim; ip++; }
        n = digitsof(d, ip, 1);
        while (n > 0) o[k++] = d[--n];
    }
    if (prec > 0 || alt) o[k++] = '.';
    if (prec > 0) {
        n = digitsof(d, fp, prec);
        while (n > 0) o[k++] = d[--n];
    }
    o[k] = 0;
    return k;
}

static void fmtfloat(struct sink *s, float v, int conv, int flags, int width, int prec)
{
    char o[48], d[48];
    int neg = 0, n, i, upper = conv == 'E' || conv == 'G' || conv == 'F';
    union { float f; unsigned long u; } b;
    b.f = v;
    if (b.u & 0x80000000UL) { neg = 1; b.u &= 0x7FFFFFFFUL; v = b.f; }
    if ((b.u & 0x7F800000UL) == 0x7F800000UL) {
        strcpy(o, (b.u & 0x7FFFFFUL) ? (upper ? "NAN" : "nan") : (upper ? "INF" : "inf"));
        flags &= ~F_ZERO;
    } else {
        if (prec < 0) prec = 6;
        if (conv == 'f' || conv == 'F') fmtf(o, v, prec, upper, flags & F_ALT);
        else if (conv == 'e' || conv == 'E') fmte(o, v, prec, upper, flags & F_ALT);
        else {
            /* %g: the shorter of the two, no trailing zeros */
            int P = prec == 0 ? 1 : prec, x = 0;
            float t = v;
            if (P > 8) P = 8;
            if (t != 0) {
                while (t >= 10) { t /= 10; x++; }
                while (t < 1) { t *= 10; x--; }
                if ((long)(t * p10(P - 1) + 0.5f) >= (long)p10(P)) x++;
            }
            if (P > x && x >= -4) fmtf(o, v, P - 1 - x, upper, flags & F_ALT);
            else fmte(o, v, P - 1, upper, flags & F_ALT);
            if (!(flags & F_ALT) && strchr(o, '.')) {
                char *ep = strchr(o, upper ? 'E' : 'e');
                char tail[8];
                int m;
                tail[0] = 0;
                if (ep) { strcpy(tail, ep); *ep = 0; }
                m = strlen(o);
                while (m > 0 && o[m - 1] == '0') o[--m] = 0;
                if (m > 0 && o[m - 1] == '.') o[--m] = 0;
                strcat(o, tail);
            }
        }
    }
    n = strlen(o);
    for (i = 0; i < n; i++) d[i] = o[n - 1 - i];
    o[0] = 0;
    if (neg) strcpy(o, "-");
    else if (flags & F_PLUS) strcpy(o, "+");
    else if (flags & F_SPACE) strcpy(o, " ");
    emitnum(s, o, d, n, flags, width);
}

static int vformat(struct sink *s, const char *fmt, va_list ap)
{
    for (; *fmt; fmt++) {
        int flags = 0, width = 0, prec = -1, lng = 0, c;
        if (*fmt != '%') { out(s, *fmt); continue; }
        fmt++;
        for (;; fmt++) {
            if (*fmt == '-') flags |= F_LEFT;
            else if (*fmt == '+') flags |= F_PLUS;
            else if (*fmt == ' ') flags |= F_SPACE;
            else if (*fmt == '0') flags |= F_ZERO;
            else if (*fmt == '#') flags |= F_ALT;
            else break;
        }
        if (*fmt == '*') { width = va_arg(ap, int); if (width < 0) { flags |= F_LEFT; width = -width; } fmt++; }
        else while (isdigit(*fmt)) width = width * 10 + (*fmt++ - '0');
        if (*fmt == '.') {
            fmt++;
            prec = 0;
            if (*fmt == '*') { prec = va_arg(ap, int); fmt++; }
            else while (isdigit(*fmt)) prec = prec * 10 + (*fmt++ - '0');
        }
        if (flags & F_LEFT) flags &= ~F_ZERO;
        for (;; fmt++) {
            if (*fmt == 'l' || *fmt == 'j') lng = 1;
#ifdef __SCHUB__
            else if (*fmt == 'z' || *fmt == 't') lng = 1;
#else
            else if (*fmt == 'z' || *fmt == 't') ;
#endif
            else if (*fmt == 'h' || *fmt == 'L') ;
            else break;
        }
        c = *fmt;
        switch (c) {
        case 'd': case 'i': {
            long v = lng ? va_arg(ap, long) : va_arg(ap, int);
            fmtint(s, v < 0 ? -(unsigned long)v : (unsigned long)v, v < 0, 10, 0, flags, width, prec);
            break;
        }
        case 'u': case 'x': case 'X': case 'o': case 'b': {
            unsigned long v = lng ? va_arg(ap, unsigned long) : va_arg(ap, unsigned);
            fmtint(s, v, 0, c == 'u' ? 10 : c == 'o' ? 8 : c == 'b' ? 2 : 16, c == 'X', flags, width, prec);
            break;
        }
        case 'p': {
            void *p = va_arg(ap, void *);
            fmtint(s, (unsigned long)p, 0, 16, 0, flags | F_ALT, width, sizeof(void *) * 2);
            break;
        }
        case 'c': {
            int ch = va_arg(ap, int);
            if (!(flags & F_LEFT)) pad(s, ' ', width - 1);
            out(s, ch);
            if (flags & F_LEFT) pad(s, ' ', width - 1);
            break;
        }
        case 's': {
            const char *str = va_arg(ap, const char *);
            int n, len;
            if (!str) str = "(null)";
            len = n = prec >= 0 ? strnlen(str, prec) : strlen(str);
            if (!(flags & F_LEFT)) pad(s, ' ', width - len);
            while (n-- > 0) out(s, *str++);
            if (flags & F_LEFT) pad(s, ' ', width - len);
            break;
        }
        case 'f': case 'F': case 'e': case 'E': case 'g': case 'G':
            fmtfloat(s, va_arg(ap, double), c, flags, width, prec);
            break;
        case 'n': *va_arg(ap, int *) = s->n; break;
        case '%': out(s, '%'); break;
        case 0: return s->n;
        default: out(s, '%'); out(s, c); break;
        }
    }
    return s->n;
}

int vfprintf(FILE *fp, const char *fmt, va_list ap)
{
    struct sink s;
    s.fp = fp; s.buf = NULL; s.n = 0; s.max = 0;
    return vformat(&s, fmt, ap);
}

int vsnprintf(char *buf, size_t n, const char *fmt, va_list ap)
{
    struct sink s;
    int r;
    s.fp = NULL; s.buf = buf; s.n = 0; s.max = n;
    r = vformat(&s, fmt, ap);
    if (n) buf[s.n < n ? s.n : n - 1] = 0;
    return r;
}

int vsprintf(char *buf, const char *fmt, va_list ap) { return vsnprintf(buf, (size_t)-1, fmt, ap); }
int vprintf(const char *fmt, va_list ap) { return vfprintf(stdout, fmt, ap); }

int printf(const char *fmt, ...)
{
    va_list ap;
    int r;
    va_start(ap, fmt);
    r = vfprintf(stdout, fmt, ap);
    va_end(ap);
    return r;
}

int fprintf(FILE *fp, const char *fmt, ...)
{
    va_list ap;
    int r;
    va_start(ap, fmt);
    r = vfprintf(fp, fmt, ap);
    va_end(ap);
    return r;
}

int sprintf(char *buf, const char *fmt, ...)
{
    va_list ap;
    int r;
    va_start(ap, fmt);
    r = vsnprintf(buf, (size_t)-1, fmt, ap);
    va_end(ap);
    return r;
}

int snprintf(char *buf, size_t n, const char *fmt, ...)
{
    va_list ap;
    int r;
    va_start(ap, fmt);
    r = vsnprintf(buf, n, fmt, ap);
    va_end(ap);
    return r;
}

/* ---- scanf */
struct src { const char *s; FILE *fp; int n; };

static int sget(struct src *in)
{
    int c;
    if (in->fp) c = fgetc(in->fp);
    else { c = *in->s ? (unsigned char)*in->s++ : EOF; }
    if (c != EOF) in->n++;
    return c;
}

static void sunget(struct src *in, int c)
{
    if (c == EOF) return;
    in->n--;
    if (in->fp) ungetc(c, in->fp); else in->s--;
}

static int vscan(struct src *in, const char *fmt, va_list ap)
{
    int count = 0, c;
    for (; *fmt; fmt++) {
        int skip = 0, width = 0, lng = 0, half = 0, conv;
        if (isspace(*fmt)) {
            while ((c = sget(in)) != EOF && isspace(c)) ;
            sunget(in, c);
            continue;
        }
        if (*fmt != '%' || fmt[1] == '%') {
            if (*fmt == '%') fmt++;
            c = sget(in);
            if (c != (unsigned char)*fmt) { sunget(in, c); return c == EOF && !count ? EOF : count; }
            continue;
        }
        fmt++;
        if (*fmt == '*') { skip = 1; fmt++; }
        while (isdigit(*fmt)) width = width * 10 + (*fmt++ - '0');
        for (;; fmt++) {
            if (*fmt == 'l') lng = 1;
            else if (*fmt == 'h') half = 1;
            else if (*fmt == 'L' || *fmt == 'z' || *fmt == 'j' || *fmt == 't') ;
            else break;
        }
        conv = *fmt;
        if (!width) width = 32767;
        if (conv != 'c' && conv != '[' && conv != 'n') {
            while ((c = sget(in)) != EOF && isspace(c)) ;
            if (c == EOF) return count ? count : EOF;
            sunget(in, c);
        }
        switch (conv) {
        case 'd': case 'i': case 'u': case 'x': case 'X': case 'o': {
            char buf[40];
            int n = 0, base = conv == 'x' || conv == 'X' ? 16 : conv == 'o' ? 8 : conv == 'i' ? 0 : 10;
            long v;
            c = sget(in);
            if ((c == '-' || c == '+') && n < width) { buf[n++] = c; c = sget(in); }
            while (c != EOF && n < width && n < 38 && (isxdigit(c) || ((c == 'x' || c == 'X') && (base == 16 || base == 0)))) {
                if (base == 10 && !isdigit(c)) break;
                if (base == 8 && (c < '0' || c > '7')) break;
                buf[n++] = c;
                c = sget(in);
            }
            sunget(in, c);
            buf[n] = 0;
            if (!n || (n == 1 && (buf[0] == '-' || buf[0] == '+'))) return count;
            v = strtol(buf, NULL, base);
            if (!skip) {
                if (lng) *va_arg(ap, long *) = v;
                else if (half) *va_arg(ap, short *) = v;
                else *va_arg(ap, int *) = v;
                count++;
            }
            break;
        }
        case 'f': case 'e': case 'g': case 'E': case 'G': {
            char buf[40];
            int n = 0;
            c = sget(in);
            while (c != EOF && n < width && n < 38 && (isdigit(c) || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E')) {
                buf[n++] = c;
                c = sget(in);
            }
            sunget(in, c);
            buf[n] = 0;
            if (!n) return count;
            if (!skip) {
                if (lng) *va_arg(ap, double *) = strtod(buf, NULL);
                else *va_arg(ap, float *) = strtod(buf, NULL);
                count++;
            }
            break;
        }
        case 's': {
            char *p = skip ? NULL : va_arg(ap, char *);
            int n = 0;
            while ((c = sget(in)) != EOF && !isspace(c) && n < width) { if (p) *p++ = c; n++; }
            sunget(in, c);
            if (p) { *p = 0; count++; }
            break;
        }
        case 'c': {
            char *p = skip ? NULL : va_arg(ap, char *);
            int n = 0;
            if (width == 32767) width = 1;
            while (n < width && (c = sget(in)) != EOF) { if (p) *p++ = c; n++; }
            if (!n) return count ? count : EOF;
            if (p) count++;
            break;
        }
        case '[': {
            char set[128];
            int k = 0, neg = 0, n = 0;
            char *p;
            fmt++;
            if (*fmt == '^') { neg = 1; fmt++; }
            if (*fmt == ']') set[k++] = *fmt++;
            while (*fmt && *fmt != ']' && k < 126) set[k++] = *fmt++;
            set[k] = 0;
            p = skip ? NULL : va_arg(ap, char *);
            while (n < width && (c = sget(in)) != EOF && ((strchr(set, c) != NULL) != neg)) { if (p) *p++ = c; n++; }
            if (n < width) sunget(in, c);
            if (!n) return count;
            if (p) { *p = 0; count++; }
            break;
        }
        case 'n':
            if (!skip) *va_arg(ap, int *) = in->n;
            break;
        default:
            return count;
        }
    }
    return count;
}

int sscanf(const char *str, const char *fmt, ...)
{
    struct src in;
    va_list ap;
    int r;
    in.s = str; in.fp = NULL; in.n = 0;
    va_start(ap, fmt);
    r = vscan(&in, fmt, ap);
    va_end(ap);
    return r;
}

int fscanf(FILE *fp, const char *fmt, ...)
{
    struct src in;
    va_list ap;
    int r;
    in.s = NULL; in.fp = fp; in.n = 0;
    va_start(ap, fmt);
    r = vscan(&in, fmt, ap);
    va_end(ap);
    return r;
}

int scanf(const char *fmt, ...)
{
    struct src in;
    va_list ap;
    int r;
    in.s = NULL; in.fp = stdin; in.n = 0;
    va_start(ap, fmt);
    r = vscan(&in, fmt, ap);
    va_end(ap);
    return r;
}
