// Sprout68k 作例: 星空を流す
//
// 配列を使うと、たくさんの物をまとめて動かせる。ここでは星を220個持ち、
// 1周ごとに全部を少しずつ左へずらしている。
// 星ごとに速さを変えると、遠近感が出る（速い星ほど手前に見える）。

#include "x68.h"

enum {
  kStarCount = 220,
};

static int star_x[kStarCount];
static int star_y[kStarCount];
static int star_speed[kStarCount];

// 星を1つ、指定した横位置に置き直す。縦位置と速さはその都度くじを引く。
static void ResetStar(int index, int x) {
  star_x[index] = x;
  star_y[index] = x68_rand_int(X68_SCREEN_H);
  star_speed[index] = 1 + x68_rand_int(3);
}

void main(void) {
  int background = x68_rgb(0, 0, 0);
  int i;

  x68_screen_open();
  srand(20260823);

  // 最初は画面のあちこちに散らばらせる。
  for (i = 0; i < kStarCount; i++) {
    ResetStar(i, x68_rand_int(X68_SCREEN_W));
  }

  for (;;) {
    x68_cls(background);
    for (i = 0; i < kStarCount; i++) {
      star_x[i] -= star_speed[i];

      // 左端まで来たら右端へ戻す。こうすると星が尽きない。
      if (star_x[i] < 0) ResetStar(i, X68_SCREEN_W - 1);

      // 速い星ほど明るく描くと、手前にあるように見える。
      x68_pset(star_x[i], star_y[i],
               x68_rgb(70 * star_speed[i], 70 * star_speed[i],
                       85 * star_speed[i]));
    }
    x68_screen_flip();
  }
}
