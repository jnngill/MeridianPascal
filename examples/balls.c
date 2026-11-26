/* Sprites in C: a ship on joystick 1 / the cursor keys and bouncing balls */
#include <stdio.h>
#include <stdlib.h>
#include <crt.h>
#include <sprites.h>
#include <input.h>

#define BALLS 12

struct ball { int x, y, dx, dy; };
static struct ball balls[BALLS];

static const char *ship[16] = {
    "0000000FF0000000", "000000FFFF000000", "000000F33F000000", "00000FF33FF00000",
    "00000FFFFFF00000", "0000FFFFFFFF0000", "000FFFFFFFFFF000", "00FFF5FFFF5FFF00",
    "0FFFF5FFFF5FFFF0", "FFFFFFFFFFFFFFFF", "FF00FFFFFFFF00FF", "F0000FFFFFF0000F",
    "00000AA00AA00000", "0000AA0000AA0000", "0000A000000A0000", "0000000000000000",
};
static const char *ball[16] = {
    "0000000000000000", "0000000000000000", "0000000000000000", "0000066666600000",
    "0006677777660000", "0067711777766000", "0677117777776600", "0677777777776600",
    "0677777777776600", "0667777777766600", "0066777777666000", "0006666666600000",
    "0000000000000000", "0000000000000000", "0000000000000000", "0000000000000000",
};

int main(void)
{
    int i, sx = 152, sy = 200, hits = 0;
    unsigned joy;
    ClrScr();
    TextColor(Yellow);
    printf("SPRITES IN C - CURSOR KEYS OR JOYSTICK 1,\nESC ENDS.\n");
    for (i = 0; i < 16; i++) { SetPatternRow(0, i, ship[i]); SetPatternRow(1, i, ball[i]); }
    SetSprite(0, sx, sy, 0, 1);
    SetSpriteFlags(0, sfDouble);
    srand((unsigned)Frames());
    for (i = 0; i < BALLS; i++) {
        struct ball *b = &balls[i];
        b->x = rand() % 300; b->y = 20 + rand() % 150;
        b->dx = rand() % 5 - 2; if (!b->dx) b->dx = 1;
        b->dy = rand() % 5 - 2; if (!b->dy) b->dy = -1;
        SetSprite(i + 1, b->x, b->y, 1, 2 + (i + 1) % 6);
    }
    SpritesOn();
    while (!EscPressed()) {
        joy = Joy(1);
        if ((joy & joyLeft) || KeyDown(scLeft)) sx -= 2;
        if ((joy & joyRight) || KeyDown(scRight)) sx += 2;
        if ((joy & joyUp) || KeyDown(scUp)) sy -= 2;
        if ((joy & joyDown) || KeyDown(scDown)) sy += 2;
        if (sx < 0) sx = 0; if (sx > 288) sx = 288;
        if (sy < 16) sy = 16; if (sy > 208) sy = 208;
        MoveSprite(0, sx, sy);
        for (i = 0; i < BALLS; i++) {
            struct ball *b = &balls[i];
            b->x += b->dx; b->y += b->dy;
            if (b->x < 0 || b->x > 304) b->dx = -b->dx;
            if (b->y < 16 || b->y > 224) b->dy = -b->dy;
            MoveSprite(i + 1, b->x, b->y);
        }
        if (SpriteHit(0)) { hits++; GotoXY(1, 4); printf("HITS: %d  ", hits); ClearHits(); }
        WaitVSync();
    }
    HideAllSprites();
    SpritesOff();
    return 0;
}
