// Sprout68k 作例: ライフゲーム
//
// 格子の上のマスが「生きている」か「死んでいる」かを、周りの8マスの数だけで
// 決めていく。規則はこの3つだけ。
//   ・生きているマスは、周りが2つか3つなら生き残る
//   ・生きているマスは、それ以外なら死ぬ
//   ・死んでいるマスは、周りがちょうど3つなら生まれる
// たったこれだけで、模様が動いたり増えたりする。
//
// 2次元配列を2枚使うのが要点。今の世代を見ながら次の世代を別の紙に書き、
// 書き終わってから入れ替える。1枚で書き換えると、まだ見ていないマスが
// 書き換わってしまって規則が崩れる。

#include "x68.h"

enum {
  kCols = 32,   // 横のマス数
  kRows = 32,   // 縦のマス数
  kCell = 16,   // 1マスの大きさ（ドット）
};

static char cells[kRows][kCols];
static char work[kRows][kCols];

// 周りの8マスのうち、生きている数を数える。
// 画面の外は「死んでいる」として数えない。
static int CountNeighbors(int row, int col) {
  int count = 0;
  int dr;
  int dc;

  for (dr = -1; dr <= 1; dr++) {
    for (dc = -1; dc <= 1; dc++) {
      int r = row + dr;
      int c = col + dc;

      if (dr == 0 && dc == 0) continue;
      if (r < 0 || r >= kRows || c < 0 || c >= kCols) continue;
      if (cells[r][c]) count++;
    }
  }
  return count;
}

// 次の世代を work に書き、書き終わってから cells へ移す。
static void StepGeneration(void) {
  int row;
  int col;

  for (row = 0; row < kRows; row++) {
    for (col = 0; col < kCols; col++) {
      int neighbors = CountNeighbors(row, col);

      if (cells[row][col]) {
        work[row][col] = (neighbors == 2 || neighbors == 3);
      } else {
        work[row][col] = (neighbors == 3);
      }
    }
  }
  memcpy(cells, work, sizeof(cells));
}

static void Draw(void) {
  int alive = x68_rgb(0, 255, 128);
  int row;
  int col;

  x68_cls(x68_rgb(0, 0, 32));
  for (row = 0; row < kRows; row++) {
    for (col = 0; col < kCols; col++) {
      if (cells[row][col]) {
        x68_box_fill(col * kCell, row * kCell, kCell - 1, kCell - 1, alive);
      }
    }
  }
}

void main(void) {
  int row;
  int col;

  x68_screen_open();
  srand(20260823);

  // 最初の世代をくじで決める。3回に1回くらい生きているようにする。
  for (row = 0; row < kRows; row++) {
    for (col = 0; col < kCols; col++) {
      cells[row][col] = (x68_rand_int(3) == 0);
    }
  }

  for (;;) {
    Draw();
    x68_screen_flip();
    StepGeneration();
  }
}
