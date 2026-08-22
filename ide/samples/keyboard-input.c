#include "x68.h"

void main(void)
{
    int previous = 0;
    x68_screen_open();
    printf("[READY]");
    for (;;) {
        int current = 0;
        if (x68_key_down(X68_KEY_LEFT)) current = 1;
        else if (x68_key_down(X68_KEY_UP)) current = 2;
        else if (x68_key_down(X68_KEY_RIGHT)) current = 3;
        else if (x68_key_down(X68_KEY_DOWN)) current = 4;
        else if (x68_key_down(X68_KEY_SPACE)) current = 5;
        else if (x68_key_down(X68_KEY_ENTER)) current = 6;
        else if (x68_key_down(X68_KEY_ESC)) current = 7;
        else if (x68_key_down(X68_KEY_A)) current = 8;
        else if (x68_key_down(X68_KEY_1)) current = 9;

        if (current != previous) {
            if (current == 0) printf("\n[RELEASE]");
            else if (current == 1) printf("\n[LEFT]");
            else if (current == 2) printf("\n[UP]");
            else if (current == 3) printf("\n[RIGHT]");
            else if (current == 4) printf("\n[DOWN]");
            else if (current == 5) printf("\n[SPACE]");
            else if (current == 6) printf("\n[ENTER]");
            else if (current == 7) printf("\n[ESC]");
            else if (current == 8) printf("\n[A]");
            else printf("\n[1]");
            previous = current;
        }
    }
}
