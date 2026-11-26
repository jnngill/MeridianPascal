/* MERIDIAN C - <math.h>, on the software reals of the System unit */
#include <math.h>
#pragma unit system

double sqrt(double x) { return x <= 0 ? 0 : _sqrtreal(x); }
double sin(double x) { return Sin(x); }
double cos(double x) { return Cos(x); }
double tan(double x) { return Sin(x) / Cos(x); }
double atan(double x) { return ArcTan(x); }

double atan2(double y, double x)
{
    if (x > 0) return ArcTan(y / x);
    if (x < 0) return y >= 0 ? ArcTan(y / x) + M_PI : ArcTan(y / x) - M_PI;
    if (y > 0) return M_PI_2;
    if (y < 0) return -M_PI_2;
    return 0;
}

double asin(double x) { return atan2(x, sqrt(1 - x * x)); }
double acos(double x) { return atan2(sqrt(1 - x * x), x); }
double exp(double x) { return Exp(x); }
double log(double x) { return Ln(x); }
double log10(double x) { return Ln(x) / M_LN10; }
double log2(double x) { return Ln(x) / M_LN2; }

double pow(double x, double y)
{
    long n = (long)y;
    if (y == n && n > -32 && n < 32) {
        double r = 1;
        int neg = n < 0;
        if (neg) n = -n;
        while (n--) r *= x;
        return neg ? 1 / r : r;
    }
    if (x <= 0) return 0;
    return Exp(y * Ln(x));
}

double sinh(double x) { double e = Exp(x); return (e - 1 / e) / 2; }
double cosh(double x) { double e = Exp(x); return (e + 1 / e) / 2; }
double tanh(double x) { double e = Exp(2 * x); return (e - 1) / (e + 1); }
double cbrt(double x) { return x < 0 ? -pow(-x, 1.0 / 3) : x == 0 ? 0 : pow(x, 1.0 / 3); }
double hypot(double x, double y) { return sqrt(x * x + y * y); }
double fabs(double x) { return x < 0 ? -x : x; }
double trunc(double x) { return _intreal(x); }
double floor(double x) { double t = _intreal(x); return t > x ? t - 1 : t; }
double ceil(double x) { double t = _intreal(x); return t < x ? t + 1 : t; }
double round(double x) { return x < 0 ? -floor(-x + 0.5) : floor(x + 0.5); }
long lround(double x) { return (long)round(x); }
double fmod(double x, double y) { return y == 0 ? 0 : x - _intreal(x / y) * y; }
double modf(double x, double *ip) { double t = _intreal(x); *ip = t; return x - t; }
double fmin(double a, double b) { return a < b ? a : b; }
double fmax(double a, double b) { return a > b ? a : b; }
double copysign(double a, double b) { a = fabs(a); return b < 0 ? -a : a; }

double frexp(double x, int *e)
{
    int n = 0;
    if (x == 0) { *e = 0; return 0; }
    while (fabs(x) >= 1) { x /= 2; n++; }
    while (fabs(x) < 0.5) { x *= 2; n--; }
    *e = n;
    return x;
}

double ldexp(double x, int e)
{
    while (e > 0) { x *= 2; e--; }
    while (e < 0) { x /= 2; e++; }
    return x;
}

int isnan(double x)
{
    union { float f; unsigned long u; } b;
    b.f = x;
    return (b.u & 0x7F800000UL) == 0x7F800000UL && (b.u & 0x7FFFFFUL);
}

int isinf(double x)
{
    union { float f; unsigned long u; } b;
    b.f = x;
    return (b.u & 0x7FFFFFFFUL) == 0x7F800000UL;
}
