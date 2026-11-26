/* Guess the number: input with scanf */
#include <stdio.h>
#include <stdlib.h>
#include <crt.h>

int main(void)
{
    int secret, guess, tries = 0;
    srand((unsigned)Frames());
    secret = rand() % 100 + 1;
    printf("I am thinking of a number from 1 to 100.\n");
    for (;;) {
        printf("Your guess: ");
        if (scanf("%d", &guess) != 1) { getchar(); continue; }
        tries++;
        if (guess < secret) printf("Higher.\n");
        else if (guess > secret) printf("Lower.\n");
        else break;
    }
    printf("Yes, %d! %d tries.\n", secret, tries);
    return 0;
}
