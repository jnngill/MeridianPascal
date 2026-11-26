#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

int cmp(const void *a, const void *b) { return *(const int *)a - *(const int *)b; }
int scmp(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

int main(void)
{
    int v[8] = { 5, 3, 9, 1, 7, 2, 8, 6 }, i, key = 7, *hit;
    char *names[] = { "pear", "apple", "fig", "kiwi" };
    char buf[64], *end;
    int *heap;
    long n;
    int a, b, c;
    float f;
    char word[16];
    qsort(v, 8, sizeof(int), cmp);
    for (i = 0; i < 8; i++) printf("%d ", v[i]);
    hit = bsearch(&key, v, 8, sizeof(int), cmp);
    printf("found at %d\n", (int)(hit - v));
    qsort(names, 4, sizeof(char *), scmp);
    printf("%s %s %s %s\n", names[0], names[1], names[2], names[3]);
    heap = malloc(100 * sizeof(int));
    for (i = 0; i < 100; i++) heap[i] = i;
    heap = realloc(heap, 200 * sizeof(int));
    printf("%d %d\n", heap[50], heap[99]);
    free(heap);
    heap = calloc(10, sizeof(int));
    printf("%d\n", heap[9]);
    free(heap);
    printf("%d %ld %ld %lu\n", atoi("-123"), atol("70000"), strtol("0x1F", NULL, 0), strtoul("777", NULL, 8));
    n = strtol("  42abc", &end, 10);
    printf("%ld [%s]\n", n, end);
    printf("%.2f %.1f\n", atof("3.25"), strtod("-1.5e2", NULL));
    sprintf(buf, "%d-%s-%04x", 7, "x", 0xab);
    printf("%s %d\n", buf, (int)strlen(buf));
    snprintf(buf, 6, "%s", "truncated");
    printf("%s\n", buf);
    i = sscanf("12 34 56 2.5 word", "%d %d %d %f %s", &a, &b, &c, &f, word);
    printf("%d: %d %d %d %.1f %s\n", i, a, b, c, f, word);
    printf("%d %d %c %c %d\n", isdigit('5'), isalpha('5') != 0, toupper('m'), tolower('M'), isspace('\t') != 0);
    printf("%d %ld\n", abs(-9), labs(-90000L));
    {
        div_t d = div(17, 5);
        printf("%d %d\n", d.quot, d.rem);
    }
    srand(1);
    a = rand(); b = rand();
    printf("%d\n", a != b && a >= 0 && a <= RAND_MAX);
    {
        char t[] = "a,b;;c";
        char *tok = strtok(t, ",;");
        while (tok) { printf("[%s]", tok); tok = strtok(NULL, ",;"); }
        printf("\n");
    }
    memset(buf, 'z', 5);
    buf[5] = 0;
    memmove(buf + 1, buf, 3);
    printf("%s %d\n", buf, memcmp("abc", "abd", 3) < 0);
    return 0;
}

/* EXPECT
1 2 3 5 6 7 8 9 found at 5
apple fig kiwi pear
50 99
0
-123 70000 31 511
42 [abc]
3.25 -150.0
7-x-00ab 8
trunc
5: 12 34 56 2.5 word
1 0 M m 1
9 90000
3 2
1
[a][b][c]
zzzzz 1
*/
