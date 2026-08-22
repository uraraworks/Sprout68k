// Sprout68k 作例: 落ちてくる四角を受け止める
//
// move.c のゲームの形に「当たり判定」と「点数」を足したもの。
// 当たり判定は難しく見えるが、四角どうしなら4つの辺を比べるだけでよい。

#include "x68.h"

enum {
  kPlayerW = 48,     // 棒の幅
  kPlayerH = 12,     // 棒の高さ
  kPlayerY = 460,    // 棒の縦位置（動かさない）
  kItemSize = 16,    // 落ちてくる四角の大きさ
  kPlayerSpeed = 6,  // 棒が1周で動く距離
  kFallSpeed = 4,    // 四角が1周で落ちる距離
};

static int player_x = 232;
static int item_x = 100;
static int item_y = 0;
static int score = 0;

// 落ちてくる四角を、画面の上のどこかに置き直す。
static void ResetItem(void) {
  item_y = 0;
  item_x = x68_rand_int(X68_SCREEN_W - kItemSize);
}

// キーを読んで棒を動かす。
static void ReadInput(void) {
  if (x68_key_down(X68_KEY_LEFT)) player_x -= kPlayerSpeed;
  if (x68_key_down(X68_KEY_RIGHT)) player_x += kPlayerSpeed;
  if (player_x < 0) player_x = 0;
  if (player_x + kPlayerW > X68_SCREEN_W) player_x = X68_SCREEN_W - kPlayerW;
}

// 四角を落として、受け止めたかどうかを見る。
static void UpdateItem(void) {
  int caught;

  item_y += kFallSpeed;

  // 四角どうしの当たり判定。「重なっている」= 縦も横も重なっている。
  caught = (item_y + kItemSize >= kPlayerY) &&
           (item_x + kItemSize > player_x) &&
           (item_x < player_x + kPlayerW);
  if (caught) score++;

  // 受け止めたときも、下まで落ちきったときも、上に戻す。
  if (caught || item_y > X68_SCREEN_H) ResetItem();
}

static void Draw(void) {
  x68_cls(x68_rgb(0, 0, 48));
  x68_box_fill(player_x, kPlayerY, kPlayerW, kPlayerH, x68_rgb(0, 255, 255));
  x68_box_fill(item_x, item_y, kItemSize, kItemSize, x68_rgb(255, 224, 0));
  x68_locate(0, 0);
  printf("SCORE %d  ", score);
}

void main(void) {
  x68_screen_open();

  // 乱数の出発点。同じ値を渡すと毎回同じ並びになるので、動きを確かめる
  // ときに便利。毎回違う動きにしたいときは、この行を消してみるとよい。
  srand(20260823);
  ResetItem();

  for (;;) {
    ReadInput();
    UpdateItem();
    Draw();
    x68_screen_flip();
  }
}
