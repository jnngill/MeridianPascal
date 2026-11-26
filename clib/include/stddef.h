#ifndef _STDDEF_H
#define _STDDEF_H

#ifdef __SCHUB__
typedef unsigned long size_t;
typedef long ptrdiff_t;
#else
typedef unsigned int size_t;
typedef int ptrdiff_t;
#endif
typedef unsigned char wchar_t;

#ifndef NULL
#define NULL ((void *)0)
#endif
#define offsetof(type, member) ((size_t)&((type *)0)->member)

#endif
