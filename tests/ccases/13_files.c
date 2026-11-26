#include <stdio.h>
#include <string.h>

struct rec { int a; char name[6]; };

int main(void)
{
    FILE *f;
    char line[40];
    int n, x;
    struct rec r, back;
    f = fopen("C1.TXT", "w");
    if (!f) { puts("cannot write"); return 1; }
    fprintf(f, "first line %d\n", 42);
    fputs("second\n", f);
    fputc('3', f);
    fclose(f);
    f = fopen("C1.TXT", "r");
    while (fgets(line, sizeof line, f)) printf("[%s]", line);
    printf("\n");
    fclose(f);
    f = fopen("C1.TXT", "a");
    fputs("\nmore 17\n", f);
    fclose(f);
    f = fopen("C1.TXT", "r");
    n = 0;
    while (fgets(line, sizeof line, f)) n++;
    printf("lines %d\n", n);
    rewind(f);
    fscanf(f, "%s %s %d", line, line + 10, &x);
    printf("%s %s %d %ld\n", line, line + 10, x, ftell(f));
    fseek(f, -3L, SEEK_END);
    n = fgetc(f);
    x = fgetc(f);
    printf("%c%c %d", n, x, feof(f));
    n = fgetc(f);
    x = fgetc(f);
    printf(" %d %d %d\n", n, x == EOF, feof(f) != 0);
    fclose(f);
    f = fopen("C2.DAT", "wb");
    r.a = 1234; strcpy(r.name, "rec");
    fwrite(&r, sizeof r, 1, f);
    r.a = 5678; strcpy(r.name, "two");
    fwrite(&r, sizeof r, 1, f);
    fclose(f);
    f = fopen("C2.DAT", "rb");
    fseek(f, (long)sizeof r, SEEK_SET);
    n = fread(&back, sizeof back, 1, f);
    printf("%d %d %s\n", n, back.a, back.name);
    n = fread(&back, sizeof back, 1, f);
    printf("%d %d\n", n, feof(f));
    fclose(f);
    printf("%d\n", fopen("NONE.TXT", "r") == NULL);
    n = remove("C2.DAT");
    printf("%d %d\n", n, fopen("C2.DAT", "r") == NULL);
    return 0;
}

/* EXPECT
[first line 42
][second
][3]
lines 4
first line 42 13
17 0 10 1 1
1 5678 two
0 1
1
0 1
*/
