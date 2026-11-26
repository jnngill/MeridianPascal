/* linked into 16_multi.c (not a test of its own: crun.js runs *.c files
   whose names start with a number) */
#include "util16.h"

const char *util_name = "util";
static int helper(int x) { return x * 3; }
int triple(int x) { return helper(x); }
int bump(void) { return ++shared; }
