/* The Mandelbrot set in fixed-point arithmetic, drawn with the Graph unit.
   Build it for both targets and compare the time: SCHUB multiplies in hardware. */
#include <stdio.h>
#include <crt.h>
#include <graph.h>
#include <meridian.h>

#define STEP 2          /* pixel size: 1 = full 320x240, 2 = 160x120 blocks */
#define MAXITER 28
#define SHIFT 12        /* fixed point 20.12 */

int main(void)
{
    int px, py, it;
    long x0, y0, x, y, x2, y2, t, start;
    unsigned char c;
    char msg[40];
    InitGraph();
    start = Frames();
    for (py = 0; py < 240; py += STEP) {
        y0 = (long)(py - 120) * 4096 * 5 / 480;          /* -1.25 .. 1.25 */
        for (px = 0; px < 320; px += STEP) {
            x0 = (long)(px - 210) * 4096 * 7 / 640;      /* -2.3 .. 1.2 */
            x = y = 0;
            for (it = 0; it < MAXITER; it++) {
                x2 = (x * x) >> SHIFT;
                y2 = (y * y) >> SHIFT;
                if (x2 + y2 > 4L * 4096) break;
                t = x2 - y2 + x0;
                y = (x * y) / 2048 + y0;
                x = t;
            }
            c = it == MAXITER ? 0 : 16 + (it * 8) % 240;
            if (STEP == 1) PutPixel(px, py, c);
            else Bar(px, py, px + STEP - 1, py + STEP - 1, c);
        }
        if (EscPressed()) break;
    }
    start = Frames() - start;
    sprintf(msg, " %ld.%ld S ", start / 60, start % 60 / 6);
    OutTextXYBg(4, 228, msg, 1, 6);
    OutTextXY(80, 228, Target() == TARGET_SCHUB ? "ON SCHUB" : "ON THE 65C816", 7);
    ReadKey();
    CloseGraph();
    return 0;
}
