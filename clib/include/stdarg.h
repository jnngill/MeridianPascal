#ifndef _STDARG_H
#define _STDARG_H

/* Arguments are pushed from the last to the first, so the ones after the
   last named parameter follow it in memory. Each takes 2 bytes (int,
   char, pointer) or 4 (long, float, double) on the 65C816, 4 on SCHUB. */
typedef char *va_list;
#ifdef __SCHUB__
#define __va_slot(x) 4
#else
#define __va_slot(x) (sizeof(x) <= 2 ? 2 : 4)
#endif
#define va_start(ap, last) ((ap) = (char *)&(last) + __va_slot(last))
#define va_arg(ap, type) __builtin_va_arg(ap, type)
#define va_end(ap) ((void)0)
#define va_copy(d, s) ((d) = (s))

#endif
