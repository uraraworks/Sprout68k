/* Sprout68k 作例: ブロック崩し
 *
 * 学習用ライブラリ(L1 + 標準名の層)だけを使って書いた入門者向けの見本。
 * L0(x68_iocs_* 等)は直接呼ばない。ポインタは使わず、配列と添字だけで書く
 * (文字列リテラルを除く。docs/API設計_20260819.md「L1の設計原則」2)。
 *
 * 最初にブロックを全部描き、以後は動いた部分だけを描き直す。
 */
#include "x68.h"

#define SCREEN_W X68_SCREEN_W
#define SCREEN_H X68_SCREEN_H

/* --- パドル --- */
#define PADDLE_W 64
#define PADDLE_H 8
#define PADDLE_Y (SCREEN_H - 24)
#define PADDLE_SPEED 4

/* --- ボール --- */
#define BALL_SIZE 8
#define BALL_SPEED 2

/* --- ブロック(4行 x 8列) --- */
#define BLOCK_ROWS 4
#define BLOCK_COLS 8
#define BLOCK_W 56
#define BLOCK_H 16
#define BLOCK_GAP_X 4
#define BLOCK_GAP_Y 4
#define BLOCK_X0 8
#define BLOCK_Y0 40

static int block_alive[BLOCK_ROWS][BLOCK_COLS];
static int block_color_idx[BLOCK_ROWS][BLOCK_COLS];

static int paddle_x;
static int ball_x, ball_y;
static int ball_dx, ball_dy;
static int score;
static long last_destroyed_index;

static int color_bg, color_paddle, color_ball, color_block[4];

static void reset_ball(void) {
    ball_x = SCREEN_W / 2 - BALL_SIZE / 2;
    ball_y = SCREEN_H / 2;
    ball_dx = BALL_SPEED;
    ball_dy = -BALL_SPEED;
}

void main(void) {
    x68_screen_open();
    srand(1);

    paddle_x = (SCREEN_W - PADDLE_W) / 2;
    score = 0;
    last_destroyed_index = -1;

    color_bg = x68_rgb(0, 0, 0);
    color_paddle = x68_rgb(255, 255, 255);
    color_ball = x68_rgb(255, 255, 0);
    /* ブロックの色は4色から乱数で選ぶ(x68_rand_intの使用例)。当たり判定・
     * 検証には影響しない(色そのものは見た目だけの飾り)。 */
    color_block[0] = x68_rgb(255, 64, 64);
    color_block[1] = x68_rgb(64, 255, 64);
    color_block[2] = x68_rgb(64, 64, 255);
    color_block[3] = x68_rgb(255, 255, 64);

    for (int r = 0; r < BLOCK_ROWS; r++) {
        for (int c = 0; c < BLOCK_COLS; c++) {
            block_alive[r][c] = 1;
            block_color_idx[r][c] = x68_rand_int(4);
        }
    }

    reset_ball();

    /* 動かないブロックは最初に一度だけ描く。毎回32個を消して描き直すと、
     * 68000ではゲームの動きそのものが遅くなるため。 */
    x68_cls(color_bg);
    for (int r = 0; r < BLOCK_ROWS; r++) {
        for (int c = 0; c < BLOCK_COLS; c++) {
            int bx = BLOCK_X0 + c * (BLOCK_W + BLOCK_GAP_X);
            int by = BLOCK_Y0 + r * (BLOCK_H + BLOCK_GAP_Y);
            x68_box_fill(bx, by, BLOCK_W, BLOCK_H, color_block[block_color_idx[r][c]]);
        }
    }
    x68_box_fill(paddle_x, PADDLE_Y, PADDLE_W, PADDLE_H, color_paddle);
    x68_box_fill(ball_x, ball_y, BALL_SIZE, BALL_SIZE, color_ball);
    x68_locate(0, 0);
    printf("SCORE:%d", score);
    x68_screen_flip();

    for (;;) {
        int old_paddle_x = paddle_x;
        int old_ball_x = ball_x;
        int old_ball_y = ball_y;

        /* --- 入力: パドル移動 --- */
        if (x68_key_down(X68_KEY_LEFT)) paddle_x -= PADDLE_SPEED;
        if (x68_key_down(X68_KEY_RIGHT)) paddle_x += PADDLE_SPEED;
        if (paddle_x < 0) paddle_x = 0;
        if (paddle_x > SCREEN_W - PADDLE_W) paddle_x = SCREEN_W - PADDLE_W;

        /* --- ボール移動 --- */
        ball_x += ball_dx;
        ball_y += ball_dy;
        if (ball_x <= 0) { ball_x = 0; ball_dx = -ball_dx; }
        if (ball_x >= SCREEN_W - BALL_SIZE) { ball_x = SCREEN_W - BALL_SIZE; ball_dx = -ball_dx; }
        if (ball_y <= 0) { ball_y = 0; ball_dy = -ball_dy; }

        /* パドルとの反射(下向きに落ちてきてパドルへ触れたら跳ね返す) */
        if (ball_dy > 0 &&
            ball_y + BALL_SIZE >= PADDLE_Y && ball_y + BALL_SIZE <= PADDLE_Y + PADDLE_H &&
            ball_x + BALL_SIZE >= paddle_x && ball_x <= paddle_x + PADDLE_W) {
            ball_dy = -ball_dy;
        }

        /* 画面下に落ちたら中央へ戻す(ゲームオーバー/クリアの扱いは簡潔にする) */
        if (ball_y > SCREEN_H) {
            reset_ball();
        }

        /* --- ブロックとの当たり判定(最初に当たった1個だけ壊す) --- */
        int hit = 0;
        int hit_x = 0;
        int hit_y = 0;
        for (int r = 0; r < BLOCK_ROWS && !hit; r++) {
            for (int c = 0; c < BLOCK_COLS && !hit; c++) {
                if (!block_alive[r][c]) continue;
                int bx = BLOCK_X0 + c * (BLOCK_W + BLOCK_GAP_X);
                int by = BLOCK_Y0 + r * (BLOCK_H + BLOCK_GAP_Y);
                if (ball_x + BALL_SIZE > bx && ball_x < bx + BLOCK_W &&
                    ball_y + BALL_SIZE > by && ball_y < by + BLOCK_H) {
                    block_alive[r][c] = 0;
                    ball_dy = -ball_dy;
                    score += 10;
                    last_destroyed_index = (long)(r * BLOCK_COLS + c);
                    hit_x = bx;
                    hit_y = by;
                    hit = 1;
                }
            }
        }

        /* --- 描画: 前の動く物を消し、変わった所だけを描く --- */
        x68_frame_begin();
        x68_box_fill(old_paddle_x, PADDLE_Y, PADDLE_W, PADDLE_H, color_bg);
        x68_box_fill(old_ball_x, old_ball_y, BALL_SIZE, BALL_SIZE, color_bg);
        if (hit) x68_box_fill(hit_x, hit_y, BLOCK_W, BLOCK_H, color_bg);
        x68_box_fill(paddle_x, PADDLE_Y, PADDLE_W, PADDLE_H, color_paddle);
        x68_box_fill(ball_x, ball_y, BALL_SIZE, BALL_SIZE, color_ball);

        /* スコア表示。桁63までに収める(グラフィック面は512ドット=64桁ぶん)。
         * "SCORE:" + 数字4桁程度で桁10前後なので十分収まる。 */
        if (hit) {
            x68_locate(0, 0);
            printf("SCORE:%d", score);
        }

        x68_screen_flip();
    }
}
