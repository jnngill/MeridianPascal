#include <stdio.h>

#define SQR(x) ((x) * (x))
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define STR(x) #x
#define XSTR(x) STR(x)
#define CAT(a, b) a ## b
#define VERSION 3
#define LOG(fmt, ...) printf("log: " fmt "\n", __VA_ARGS__)
#define LOG0(fmt, ...) printf(fmt "\n", ## __VA_ARGS__)
#define LONG_MACRO(a, b) \
    ((a) + \
     (b))

#if VERSION > 2 && defined(SQR)
#define NEW 1
#elif VERSION == 2
#define NEW 2
#else
#define NEW 0
#endif

#ifdef __M816__
#define CPU "65C816"
#endif
#ifdef __SCHUB__
#define CPU "SCHUB"
#endif

#ifndef CPU
#error no CPU
#endif

int CAT(my, var) = 42;

int main(void)
{
    printf("%d %d %d\n", SQR(5), SQR(1 + 2), MAX(3, 9));
    printf("%s %s %s\n", STR(hello world), XSTR(VERSION), STR(a "b" c));
    printf("%d %d\n", myvar, NEW);
    LOG("%d+%d", 1, 2);
    LOG0("no args");
    printf("%d\n", LONG_MACRO(10, 20));
    printf("%d %d\n", __LINE__, (int)sizeof(CPU) > 1);
#undef SQR
#define SQR 7
    printf("%d\n", SQR);
#if 0
    this is not compiled
#endif
    printf("%s\n", __FILE__);
    return 0;
}

/* EXPECT
25 9 9
hello world 3 a "b" c
42 1
log: 1+2
no args
30
44 1
7
08_preproc.c
*/
