#ifndef _MATH_H
#define _MATH_H

/* double is the 32-bit real of the runtime (about 7 digits) */
#define M_PI 3.14159265358979
#define M_PI_2 1.57079632679490
#define M_PI_4 0.785398163397448
#define M_E 2.71828182845905
#define M_LN2 0.693147180559945
#define M_LN10 2.30258509299405
#define M_SQRT2 1.41421356237310
#define HUGE_VAL (1.0e30f * 1.0e30f)
#define INFINITY HUGE_VAL
#define NAN (INFINITY - INFINITY)

double sin(double x);
double cos(double x);
double tan(double x);
double asin(double x);
double acos(double x);
double atan(double x);
double atan2(double y, double x);
double sinh(double x);
double cosh(double x);
double tanh(double x);
double exp(double x);
double log(double x);
double log10(double x);
double log2(double x);
double pow(double x, double y);
double sqrt(double x);
double cbrt(double x);
double hypot(double x, double y);
double ceil(double x);
double floor(double x);
double trunc(double x);
double round(double x);
long lround(double x);
double fabs(double x);
double fmod(double x, double y);
double modf(double x, double *ip);
double frexp(double x, int *e);
double ldexp(double x, int e);
double fmin(double a, double b);
double fmax(double a, double b);
double copysign(double a, double b);
int isnan(double x);
int isinf(double x);

#define sinf sin
#define cosf cos
#define tanf tan
#define asinf asin
#define acosf acos
#define atanf atan
#define atan2f atan2
#define expf exp
#define logf log
#define log10f log10
#define powf pow
#define sqrtf sqrt
#define ceilf ceil
#define floorf floor
#define truncf trunc
#define roundf round
#define fabsf fabs
#define fmodf fmod
#define hypotf hypot

#pragma link "math.c"
#endif
