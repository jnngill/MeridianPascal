#ifndef _STDIO_H
#define _STDIO_H
#include <stddef.h>
#include <stdarg.h>

/* stdout is the screen (through the kernel, like Pascal's Write), stdin the
   keyboard a line at a time (with echo, like Readln). Files are those of the
   System unit: up to 64 KB, kept in a bank of expansion RAM while open; a
   name may start with the drive, "1:DATA.TXT" (0..3, see <dos.h>). */

#define EOF (-1)
#define BUFSIZ 256
#define FILENAME_MAX 18
#define FOPEN_MAX 7
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2

typedef struct __FILE FILE;
typedef long fpos_t;
extern FILE *stdin, *stdout, *stderr;

int putchar(int c);
int puts(const char *s);
int printf(const char *fmt, ...);
int sprintf(char *buf, const char *fmt, ...);
int snprintf(char *buf, size_t n, const char *fmt, ...);
int vprintf(const char *fmt, va_list ap);
int vsprintf(char *buf, const char *fmt, va_list ap);
int vsnprintf(char *buf, size_t n, const char *fmt, va_list ap);
int fprintf(FILE *f, const char *fmt, ...);
int vfprintf(FILE *f, const char *fmt, va_list ap);
int getchar(void);
char *gets(char *buf);
char *fgets(char *buf, int n, FILE *f);
int fputs(const char *s, FILE *f);
int fputc(int c, FILE *f);
int fgetc(FILE *f);
int ungetc(int c, FILE *f);
#define putc(c, f) fputc(c, f)
#define getc(f) fgetc(f)
int scanf(const char *fmt, ...);
int sscanf(const char *s, const char *fmt, ...);
int fscanf(FILE *f, const char *fmt, ...);

FILE *fopen(const char *name, const char *mode);
int fclose(FILE *f);
size_t fread(void *buf, size_t size, size_t n, FILE *f);
size_t fwrite(const void *buf, size_t size, size_t n, FILE *f);
int fseek(FILE *f, long off, int whence);
long ftell(FILE *f);
void rewind(FILE *f);
int fgetpos(FILE *f, fpos_t *pos);
int fsetpos(FILE *f, const fpos_t *pos);
int feof(FILE *f);
int ferror(FILE *f);
void clearerr(FILE *f);
int fflush(FILE *f);
int remove(const char *name);
int rename(const char *from, const char *to);
void perror(const char *s);

#pragma link "stdio.c"
#endif
