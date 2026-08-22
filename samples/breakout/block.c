// Sprout68k 作例: ブロック崩し
//
// 学習用ライブラリのL1と標準名の層だけを使う。
// L0 (x68_iocs_* など) は直接呼ばない。文字列リテラル以外の
// ポインタは使わず、配列と添字で書く。
// 最初にブロックをすべて描く。
// 以後は動いた部分だけ描き直す。

#include "x68.h"

enum {
  kScreenWidth = X68_SCREEN_W,
  kScreenHeight = X68_SCREEN_H,
  kPaddleWidth = 64,
  kPaddleHeight = 8,
  kPaddleY = kScreenHeight - 24,
  kPaddleSpeed = 4,
  kBallSize = 8,
  kBallSpeed = 2,
  kBlockRows = 4,
  kBlockColumns = 8,
  kBlockWidth = 56,
  kBlockHeight = 16,
  kBlockGapX = 4,
  kBlockGapY = 4,
  kBlockStartX = 8,
  kBlockStartY = 40,
  kBlockColorCount = 4,
};

static int block_alive[kBlockRows][kBlockColumns];
static int block_color_index[kBlockRows][kBlockColumns];

static int paddle_x;
static int ball_x;
static int ball_y;
static int ball_dx;
static int ball_dy;
static int score;
static long last_destroyed_index;

static int background_color;
static int paddle_color;
static int ball_color;
static int block_color[kBlockColorCount];

static void ResetBall(void) {
  ball_x = kScreenWidth / 2 - kBallSize / 2;
  ball_y = kScreenHeight / 2;
  ball_dx = kBallSpeed;
  ball_dy = -kBallSpeed;
}

void main(void) {
  x68_screen_open();
  srand(1);

  paddle_x = (kScreenWidth - kPaddleWidth) / 2;
  score = 0;
  last_destroyed_index = -1;

  background_color = x68_rgb(0, 0, 0);
  paddle_color = x68_rgb(255, 255, 255);
  ball_color = x68_rgb(255, 255, 0);
  // ブロックの色は4色から乱数で選ぶ。
  // 当たり判定や検証には
  // 影響しない。x68_rand_intの使用例も兼ねている。
  block_color[0] = x68_rgb(255, 64, 64);
  block_color[1] = x68_rgb(64, 255, 64);
  block_color[2] = x68_rgb(64, 64, 255);
  block_color[3] = x68_rgb(255, 255, 64);

  for (int row = 0; row < kBlockRows; ++row) {
    for (int column = 0; column < kBlockColumns; ++column) {
      block_alive[row][column] = 1;
      block_color_index[row][column] = x68_rand_int(kBlockColorCount);
    }
  }

  ResetBall();

  // 動かないブロックは最初に一度だけ描く。
  // 毎回32個を描き直すと
  // 68000ではゲームの動きそのものが遅くなる。
  x68_cls(background_color);
  for (int row = 0; row < kBlockRows; ++row) {
    for (int column = 0; column < kBlockColumns; ++column) {
      int block_x =
          kBlockStartX + column * (kBlockWidth + kBlockGapX);
      int block_y = kBlockStartY + row * (kBlockHeight + kBlockGapY);
      int color = block_color[block_color_index[row][column]];
      x68_box_fill(block_x, block_y, kBlockWidth, kBlockHeight, color);
    }
  }
  x68_box_fill(paddle_x, kPaddleY, kPaddleWidth, kPaddleHeight,
               paddle_color);
  x68_box_fill(ball_x, ball_y, kBallSize, kBallSize, ball_color);
  x68_locate(0, 0);
  printf("SCORE:%d", score);
  x68_screen_flip();

  for (;;) {
    int old_paddle_x = paddle_x;
    int old_ball_x = ball_x;
    int old_ball_y = ball_y;

    // 入力: パドル移動。
    if (x68_key_down(X68_KEY_LEFT)) paddle_x -= kPaddleSpeed;
    if (x68_key_down(X68_KEY_RIGHT)) paddle_x += kPaddleSpeed;
    if (paddle_x < 0) paddle_x = 0;
    if (paddle_x > kScreenWidth - kPaddleWidth) {
      paddle_x = kScreenWidth - kPaddleWidth;
    }

    // ボール移動。
    ball_x += ball_dx;
    ball_y += ball_dy;
    if (ball_x <= 0) {
      ball_x = 0;
      ball_dx = -ball_dx;
    }
    if (ball_x >= kScreenWidth - kBallSize) {
      ball_x = kScreenWidth - kBallSize;
      ball_dx = -ball_dx;
    }
    if (ball_y <= 0) {
      ball_y = 0;
      ball_dy = -ball_dy;
    }

    // 下向きに落ちてきてパドルへ触れたら跳ね返す。
    if (ball_dy > 0 && ball_y + kBallSize >= kPaddleY &&
        ball_y + kBallSize <= kPaddleY + kPaddleHeight &&
        ball_x + kBallSize >= paddle_x &&
        ball_x <= paddle_x + kPaddleWidth) {
      ball_dy = -ball_dy;
    }

    // 画面下に落ちたら中央へ戻す。
    if (ball_y > kScreenHeight) ResetBall();

    // 最初に当たったブロック1個だけ壊す。
    int hit = 0;
    int hit_x = 0;
    int hit_y = 0;
    for (int row = 0; row < kBlockRows && !hit; ++row) {
      for (int column = 0; column < kBlockColumns && !hit; ++column) {
        if (!block_alive[row][column]) continue;
        int block_x =
            kBlockStartX + column * (kBlockWidth + kBlockGapX);
        int block_y = kBlockStartY + row * (kBlockHeight + kBlockGapY);
        if (ball_x + kBallSize > block_x &&
            ball_x < block_x + kBlockWidth &&
            ball_y + kBallSize > block_y &&
            ball_y < block_y + kBlockHeight) {
          block_alive[row][column] = 0;
          ball_dy = -ball_dy;
          score += 10;
          last_destroyed_index =
              (long)(row * kBlockColumns + column);
          hit_x = block_x;
          hit_y = block_y;
          hit = 1;
        }
      }
    }

    // 前の動く物を消し、変わった所だけを描く。
    x68_frame_begin();
    x68_box_fill(old_paddle_x, kPaddleY, kPaddleWidth, kPaddleHeight,
                 background_color);
    x68_box_fill(old_ball_x, old_ball_y, kBallSize, kBallSize,
                 background_color);
    if (hit) {
      x68_box_fill(hit_x, hit_y, kBlockWidth, kBlockHeight,
                   background_color);
    }
    x68_box_fill(paddle_x, kPaddleY, kPaddleWidth, kPaddleHeight,
                 paddle_color);
    x68_box_fill(ball_x, ball_y, kBallSize, kBallSize, ball_color);

    // "SCORE:" と数字4桁程度なので、画面の64桁に収まる。
    if (hit) {
      x68_locate(0, 0);
      printf("SCORE:%d", score);
    }

    x68_screen_flip();
  }
}
