#include <stdio.h>

int main(void)
{
    char name[20];
    int a, b, c;
    printf("Name? ");
    gets(name);
    printf("Two numbers? ");
    scanf("%d %d", &a, &b);
    printf("Hello %s, %d + %d = %d\n", name, a, b, a + b);
    while ((c = getchar()) != '\n') ;
    printf("Key? ");
    c = getchar();
    printf("got %c\n", c);
    return 0;
}

/* KEYS:ADA\r12 30\rQ\r */
/* EXPECT
Name? ADA
Two numbers? 12 30
Hello ADA, 12 + 30 = 42
Key? Q
got Q
*/
