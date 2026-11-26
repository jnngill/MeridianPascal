#include <stdio.h>

typedef enum { RED, GREEN = 5, BLUE } colour;

struct node { int val; struct node *next; };

typedef struct {
    char name[8];
    int age;
    long id;
    colour fav;
} person;

union bits { unsigned long l; unsigned int w[2]; unsigned char b[4]; };

struct flags {
    unsigned a : 3;
    unsigned b : 5;
    int c : 4;
    unsigned d : 1;
};

person people[] = {
    { "Ann", 31, 1001L, GREEN },
    { "Bob", 42, 1002L },
    { .age = 7, .name = "Cy", .fav = BLUE },
};

struct { int x, y; } pts[3] = { [2] = { 5, 6 }, [0] = { 1, 2 } };

int main(void)
{
    struct node n3 = { 3, NULL }, n2 = { 2, &n3 }, n1 = { 1, &n2 };
    struct node *p;
    union bits u;
    struct flags f = { 5, 17, -3, 1 };
    person me = people[0];
    int i;
    for (p = &n1; p; p = p->next) printf("%d ", p->val);
    printf("\n");
    for (i = 0; i < 3; i++) printf("%s %d %ld %d\n", people[i].name, people[i].age, people[i].id, people[i].fav);
    printf("%d %d %d\n", RED, GREEN, BLUE);
    u.l = 0x12345678UL;
    printf("%x %x %x %x\n", u.w[0], u.w[1], u.b[0], u.b[3]);
    printf("%d %d %d %d %d\n", f.a, f.b, f.c, f.d, (int)sizeof(struct flags));
    f.b = 31; f.a++; f.c = 7;
    printf("%d %d %d %d\n", f.a, f.b, f.c, f.d);
    f.c -= 9;
    printf("%d\n", f.c);
    me.age++;
    printf("%s %d %d\n", me.name, me.age, people[0].age);
    printf("%d %d %d %d\n", pts[0].x, pts[1].y, pts[2].x, pts[2].y);
    {
        person *pp = &people[1];
        pp->name[0] = 'R';
        (*pp).age = 43;
        printf("%s %d\n", people[1].name, pp->age);
    }
    printf("%d\n", (int)sizeof(person) >= 16);
    return 0;
}

/* EXPECT
1 2 3
Ann 31 1001 5
Bob 42 1002 0
Cy 7 0 6
0 5 6
5678 1234 78 12
5 17 -3 1 2
6 31 7 1
-2
Ann 32 31
1 0 5 6
Rob 43
1
*/
