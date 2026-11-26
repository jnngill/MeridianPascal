/* A plasma written straight into the bitmap through a __far pointer: the
   Graph unit's picture is 320 x 240 bytes in chip RAM at $02:0000. */
#include <crt.h>
#include <graph.h>
#include <meridian.h>

static unsigned char sine[256];

static void make_palette(void)
{
    int i;
    for (i = 0; i < 64; i++) {
        SetRGB8(i, i * 4, 0, 255 - i * 4);
        SetRGB8(64 + i, 255, i * 4, 0);
        SetRGB8(128 + i, 255 - i * 4, 255, i * 4);
        SetRGB8(192 + i, 0, 255 - i * 4, 255);
    }
}

int main(void)
{
    unsigned char __far *vram = (unsigned char __far *)GraphBase;
    unsigned char __far *row;
    int x, y, frame = 0, i;
    for (i = 0; i < 256; i++)
        sine[i] = 128 + (int)(127 * Sin(i * 3.14159265 / 128));
    InitGraph();
    make_palette();
    while (!KeyPressed() && !EscPressed()) {
        for (y = 0; y < 240; y += 2) {
            unsigned char sy = sine[(y + frame) & 255];
            row = vram + (long)y * 320;
            for (x = 0; x < 320; x += 2) {
                unsigned char v = sine[(x + sy) & 255] + sine[(x + y + frame * 2) & 255];
                row[x] = v;
                row[x + 1] = v;
                row[x + 320] = v;
                row[x + 321] = v;
            }
        }
        frame += 3;
    }
    CloseGraph();
    return 0;
}
