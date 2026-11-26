#ifndef _STDINT_H
#define _STDINT_H

typedef signed char int8_t;
typedef unsigned char uint8_t;
typedef int int16_t;
typedef unsigned int uint16_t;
typedef long int32_t;
typedef unsigned long uint32_t;
typedef long intmax_t;
typedef unsigned long uintmax_t;
typedef int8_t int_least8_t;
typedef uint8_t uint_least8_t;
typedef int16_t int_least16_t;
typedef uint16_t uint_least16_t;
typedef int32_t int_least32_t;
typedef uint32_t uint_least32_t;
typedef int16_t int_fast8_t;
typedef uint16_t uint_fast8_t;
typedef int16_t int_fast16_t;
typedef uint16_t uint_fast16_t;
typedef int32_t int_fast32_t;
typedef uint32_t uint_fast32_t;
#ifdef __SCHUB__
typedef long intptr_t;
typedef unsigned long uintptr_t;
#define INTPTR_MAX 2147483647L
#define UINTPTR_MAX 4294967295UL
#else
typedef int intptr_t;
typedef unsigned int uintptr_t;
#define INTPTR_MAX 32767
#define UINTPTR_MAX 65535U
#endif

#define INT8_MIN (-128)
#define INT8_MAX 127
#define UINT8_MAX 255
#define INT16_MIN (-32767 - 1)
#define INT16_MAX 32767
#define UINT16_MAX 65535U
#define INT32_MIN (-2147483647L - 1)
#define INT32_MAX 2147483647L
#define UINT32_MAX 4294967295UL
#define INTMAX_MAX INT32_MAX
#define UINTMAX_MAX UINT32_MAX

#define INT8_C(x) (x)
#define UINT8_C(x) (x)
#define INT16_C(x) (x)
#define UINT16_C(x) (x ## U)
#define INT32_C(x) (x ## L)
#define UINT32_C(x) (x ## UL)

#endif
