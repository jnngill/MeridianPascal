#include <stdio.h>
#include <math.h>

double area(double r) { return M_PI * r * r; }

int main(void)
{
    float a = 1.5f, b = -2.25;
    double c = 10;
    int i = 7;
    long l = 100000L;
    printf("%f %f %f %f\n", a + b, a - b, a * b, a / b);
    printf("%.2f %.0f %.3f\n", area(2), 2.5 * 3, (double)i / 3);
    printf("%e %E\n", 12345.678, 0.000123);
    printf("%g %g %g %g\n", 100.0, 0.0001, 123456789.0, 1.5);
    printf("%d %ld %d\n", (int)3.99, (long)-2.5, (int)(a * 4));
    printf("%f %f\n", (float)i, (float)l);
    printf("%d %d %d %d\n", a > b, a < b, a == 1.5, b != b);
    c /= 4;
    c += 0.5;
    printf("%.4f\n", c);
    printf("%.4f %.4f %.4f\n", sqrt(2.0), sin(M_PI / 6), cos(0));
    printf("%.3f %.3f %.3f\n", exp(1.0), log(10.0), pow(2, 10));
    printf("%.2f %.2f %.2f %.2f\n", floor(-2.5), ceil(-2.5), fabs(-3.25), fmod(7.5, 2));
    printf("%.4f %.4f\n", atan2(1, 1), atan(1) * 4);
    printf("%8.3f|%-8.2f|%+.1f\n", 3.14159, 2.5, 7.0);
    {
        float s = 0;
        for (i = 1; i <= 100; i++) s += 1.0f / i;
        printf("%.5f\n", s);
    }
    printf("%d\n", -a < 0);
    if (0.0) printf("zero is true\n"); else printf("zero is false\n");
    return 0;
}

/* EXPECT
-0.750000 3.750000 -3.375000 -0.666667
12.57 8 2.333
1.234568e+04 1.230000E-04
100 0.0001 1.23457e+08 1.5
3 -2 6
7.000000 100000.000000
1 0 1 0
3.0000
1.4142 0.5000 1.0000
2.718 2.303 1024.000
-3.00 -2.00 3.25 1.50
0.7854 3.1416
   3.142|2.50    |+7.0
5.18738
1
zero is false
*/
