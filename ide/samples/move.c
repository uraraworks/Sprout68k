// Sprout68k 作例: 四角を動かす
//
// 動くものを作るときは、この1周をずっと繰り返す。どのゲームでも形は同じ。
//   1. 画面を消す
//   2. キーを読む
//   3. 位置を計算する
//   4. 描く
//   5. 画面に出す
//
// 5 の x68_screen_flip() が画面の書き換えを待つので、この1周は毎秒およそ
// 55〜60回になる（描く物がおよそ60件までなら毎秒60回を保てる。描く物が
// 増えると1周が2フレーム、3フレームとかかるようになり、遅くなる）。

#include "x68.h"

enum {
  kSize = 40,   // 四角の大きさ
  kSpeed = 4,   // 1周で動く距離（毎秒およそ60周なので毎秒約240ドット）
};

static int player_x = 236;
static int player_y = 236;

// キーを読んで位置を動かす。
// x68_key_down() は押している間ずっと真になるので、押しっぱなしで動き続ける。
// 上下左右を別々に調べているため、2つ同時に押せば斜めに動く。
static void MovePlayer(void) {
  if (x68_key_down(X68_KEY_LEFT)) player_x -= kSpeed;
  if (x68_key_down(X68_KEY_RIGHT)) player_x += kSpeed;
  if (x68_key_down(X68_KEY_UP)) player_y -= kSpeed;
  if (x68_key_down(X68_KEY_DOWN)) player_y += kSpeed;

  // 動かしたあとで、画面からはみ出していたら引き戻す。
  if (player_x < 0) player_x = 0;
  if (player_y < 0) player_y = 0;
  if (player_x + kSize > X68_SCREEN_W) player_x = X68_SCREEN_W - kSize;
  if (player_y + kSize > X68_SCREEN_H) player_y = X68_SCREEN_H - kSize;
}

void main(void) {
  int background = x68_rgb(0, 0, 48);
  int player_color = x68_rgb(0, 255, 255);

  x68_screen_open();
  for (;;) {
    x68_cls(background);
    MovePlayer();
    x68_box_fill(player_x, player_y, kSize, kSize, player_color);

    // 末尾に空白を入れているのは、桁が減ったときに前の数字を消すため。
    x68_locate(0, 0);
    printf("X=%d Y=%d  ", player_x, player_y);

    x68_screen_flip();
  }
}
