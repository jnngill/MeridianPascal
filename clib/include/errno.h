#ifndef _ERRNO_H
#define _ERRNO_H

extern int errno;
#define EDOM 33
#define ERANGE 34
#define ENOENT 2
#define EIO 5
#define ENOMEM 12
#define EINVAL 22
#define ENOSPC 28

#pragma link "stdlib.c"
#endif
