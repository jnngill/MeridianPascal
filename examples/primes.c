/* The sieve of Eratosthenes, timed: build it for both targets and compare */
#include <stdio.h>
#include <string.h>
#include <crt.h>

#define N 8000

static char composite[N + 1];

int main(void)
{
    long start = Frames();
    int i, j, count = 0;
    memset(composite, 0, sizeof composite);
    for (i = 2; i * i <= N; i++)
        if (!composite[i])
            for (j = i * i; j <= N; j += i) composite[j] = 1;
    for (i = 2; i <= N; i++)
        if (!composite[i]) {
            count++;
            if (i > N - 200) printf("%d ", i);
        }
    printf("\n\n%d primes up to %d in %ld frames\n", count, N, Frames() - start);
    return 0;
}
