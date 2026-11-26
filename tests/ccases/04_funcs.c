#include <stdio.h>
#include <stdarg.h>

int fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }
long lfact(int n) { return n <= 1 ? 1 : n * lfact(n - 1); }
int fib(int n);

int add(int a, int b) { return a + b; }
int mul(int a, int b) { return a * b; }
int apply(int (*f)(int, int), int a, int b) { return f(a, b); }

int sum(int n, ...)
{
    va_list ap;
    int s = 0;
    va_start(ap, n);
    while (n--) s += va_arg(ap, int);
    va_end(ap);
    return s;
}

long lsum(int n, ...)
{
    va_list ap;
    long s = 0;
    va_start(ap, n);
    while (n--) s += va_arg(ap, long);
    va_end(ap);
    return s;
}

struct point { int x, y; };
struct point mkpoint(int x, int y) { struct point p; p.x = x; p.y = y; return p; }
struct point addp(struct point a, struct point b) { a.x += b.x; a.y += b.y; return a; }
int dist2(struct point p) { return p.x * p.x + p.y * p.y; }

static int counter(void) { static int n = 100; return n++; }

void swap(int *a, int *b) { int t = *a; *a = *b; *b = t; }

char upper(char c) { return c >= 'a' && c <= 'z' ? c - 32 : c; }

int main(void)
{
    int (*ops[2])(int, int) = { add, mul };
    struct point p = mkpoint(3, 4), q;
    int x = 1, y = 2;
    printf("%d %ld %d\n", fact(7), lfact(12), fib(20));
    printf("%d %d %d\n", apply(add, 3, 4), apply(mul, 3, 4), ops[1](5, 6));
    printf("%d %ld\n", sum(4, 1, 2, 3, 4), lsum(3, 100000L, 200000L, 300000L));
    q = addp(p, mkpoint(10, 20));
    printf("%d %d %d %d %d\n", p.x, p.y, q.x, q.y, dist2(p));
    printf("%d\n", mkpoint(7, 8).y);
    x = counter();
    y = counter();
    printf("%d %d %d\n", x, y, counter());
    x = 1; y = 2;
    swap(&x, &y);
    printf("%d %d %c%c\n", x, y, upper('q'), upper('Q'));
    return 0;
}

int fib(int n) { int a = 0, b = 1, t; while (n--) { t = a + b; a = b; b = t; } return a; }

/* EXPECT
5040 479001600 6765
7 12 30
10 600000
3 4 13 24 25
8
100 101 102
2 1 QQ
*/
