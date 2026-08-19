/* X68kDev L1(65536色1ページ + 矩形追跡の部分転送)の検証用テストプログラム。
 *
 * host側(verify/verify_l1.mts)からゲストメモリへ書き込む手段(poke)が
 * 無い(LibretroHostはpeekByte/peekWordしか提供していない)ため、台本は
 * このファイルに固定で書き下ろす。host側は同じ台本をTSで独立に再実装し、
 * 「今どのフレームの flip() まで終わったか」を HV2_PROGRESS で追いながら、
 * 各flip直後に実際にレンダリングされたcanvas全体(512x512、decode16to24で
 * GVRAM語形式から変換)をhost側モデルと突き合わせる(サンプリングではなく
 * 全画素比較。docs/L1実装_20260819.md参照。GVRAMをpeekWordで直接読む方式は
 * 「ゲストのメインメモリ」しか読めず機能しなかった経緯も同ドキュメントに
 * 記録している)。
 *
 * ビルド時に X68_L1_EMPTY_SCRIPT を定義すると、陰性対照用の「何も描かない」
 * 最小台本(open+cls+flipのみ、1フレーム)に切り替わる
 * (tools/build_l1_test.sh の script 引数)。
 */
#include "x68.h"

typedef volatile unsigned long vu32;

/* lib/src/x68_l1.c が公開する非公式カウンタ(x68.hには宣言しない。
 * 検証プログラムだけがexternで直接参照する)。 */
extern unsigned long x68_l1_last_flip_bytes;

/* ============================================================
 * host側との受け渡しアドレス(HOSTVAR)。lib_test/src/main.c が使う
 * 0x000D0000台とは別の 0x000D8000台を使う(念のため分けてある。
 * 別ディスクイメージで独立起動するため実害は無い)。
 * ============================================================ */
#define HV2_BASE 0x000D8000UL

/* 完了したflip()の回数(0始まり、frame番号+1になる)。hostはこれが
 * N+1になった瞬間(=frame Nのflip()が完了した直後)に全画素比較を行う。 */
#define HV2_PROGRESS (*(vu32 *)(HV2_BASE + 0x00))

/* 各flip()で実際にGVRAMへ転送したバイト数(x68_l1_last_flip_bytesのコピー)。
 * 添字はframe番号(0始まり)。 */
#define HV2_FLIP_BYTES(i) (*(vu32 *)(HV2_BASE + 0x10 + (unsigned long)(i) * 4UL))

/* x68_rgb()の戻り値をhostが独立照合するための記録(3点)。 */
#define HV2_RGB_RESULT(i) (*(vu32 *)(HV2_BASE + 0x0100 + (unsigned long)(i) * 4UL))

/* 全工程完了の目印。 */
#define HV2_DONE (*(vu32 *)(HV2_BASE + 0x0200))
#define HV2_DONE_MAGIC 0xC1D2E3F4UL

/* ============================================================
 * 台本の定数(verify/verify_l1.mts のTS側と1桁単位で一致させること)。
 * ============================================================ */
#define MOVER_W 16
#define MOVER_H 16
#define MOVER_Y 100

#define EDGE_X 495
#define EDGE_Y 300
#define EDGE_W 40
#define EDGE_H 20

void main(void) {
    HV2_PROGRESS = 0;
    HV2_DONE = 0;

    x68_screen_open();

    int c_bg1 = x68_rgb(0, 0, 0);
    int c_bg2 = x68_rgb(255, 255, 255);
    int c_mover = x68_rgb(255, 255, 0);
    int c_edge = x68_rgb(0, 255, 255);
    int c_point = x68_rgb(255, 0, 255);
    int c_line = x68_rgb(128, 0, 255);
    int c_circle = x68_rgb(0, 255, 0);

    /* x68_rgb()の自己申告をhostが独立に計算式で照合できるよう記録する
     * (3点。host_independent照合はverify_l1.mts側)。 */
    HV2_RGB_RESULT(0) = (unsigned long)(unsigned int)c_bg1;
    HV2_RGB_RESULT(1) = (unsigned long)(unsigned int)c_mover;
    HV2_RGB_RESULT(2) = (unsigned long)(unsigned int)c_circle;

#ifdef X68_L1_EMPTY_SCRIPT
    /* 陰性対照: 何も描かない(cls済みの背景だけ)。他の色定数はこの台本では
     * 使わないので、未使用変数の警告だけ潰しておく(挙動には無関係)。 */
    (void)c_bg2; (void)c_mover; (void)c_edge; (void)c_point; (void)c_line;
    x68_cls(c_bg1);
    x68_screen_flip();
    HV2_FLIP_BYTES(0) = x68_l1_last_flip_bytes;
    HV2_PROGRESS = 1;
    for (int s = 0; s < 3; s++) x68_vsync_wait();
#else
    for (int frame = 0; frame < 8; frame++) {
        int bg = (frame < 6) ? c_bg1 : c_bg2;
        x68_cls(bg);

        int mx = 40 + frame * 20;
        x68_box_fill(mx, MOVER_Y, MOVER_W, MOVER_H, c_mover);

        if (frame >= 2 && frame <= 4) {
            x68_box_fill(EDGE_X, EDGE_Y, EDGE_W, EDGE_H, c_edge);
        }

        if (frame == 5) {
            x68_pset(256, 50, c_point);
            x68_line(10, 10, 120, 90, c_line);
            x68_line(-50, -50, -10, -10, c_line); /* 両端とも画面外: 何も描かれないはず */
            x68_circle(300, 300, 25, c_circle);
            x68_box(350, 150, 40, 30, c_edge); /* 枠のみ(x68_box_fillとは別関数の確認) */
        }

        x68_screen_flip();
        HV2_FLIP_BYTES(frame) = x68_l1_last_flip_bytes;
        HV2_PROGRESS = (unsigned long)(frame + 1);

        /* host側がpx68kのビデオリフレッシュを確実に拾ってから(canvas経由の
         * 全画素比較なので、GVRAM書き込み直後の1フレームだけでは映像に
         * 反映されていない可能性がある)このフレームのGVRAM内容を読めるよう、
         * 何も描かずに数回だけ垂直同期を待つ「静止区間」を設ける。この間は
         * 裏バッファ・GVRAMどちらも変化しない(host側が追加でrunFrame()を
         * 呼んでも安全に同じ内容を観測できる)。 */
        for (int s = 0; s < 3; s++) x68_vsync_wait();
    }
#endif

    HV2_DONE = HV2_DONE_MAGIC;
    for (;;) { }
}
