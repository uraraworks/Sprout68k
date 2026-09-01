/* Sprout68k L1(65536色1ページ + 描画命令の差分転送)の検証用テストプログラム。
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
 * ビルド時に以下のいずれかを定義すると、台本が切り替わる
 * (tools/build_l1_test.sh の script 引数):
 *   X68_L1_EMPTY_SCRIPT       陰性対照用の「何も描かない」最小台本(1フレーム)
 *   X68_L1_DIFF_SCRIPT        描画命令の差分転送(2026-08-20導入)を狙った台本。
 *                             静止物と動く物の同居・色だけの変更・命令数が減る
 *                             場面・一覧が溢れる場面を1本の台本にまとめてある
 *                             (docs/L1実装_20260819.md「差分転送」節参照)。
 *   X68_L1_FRAME_BEGIN_SCRIPT x68_frame_begin()を使う「追記フレーム」方式
 *                             (samples/breakout/block.cと同じ使い方)を狙った
 *                             台本(docs/L1差分描画_20260901.md「追記(2026-09-01)」
 *                             節)。動かない絵をx68_clsのフレームで1回だけ描き、
 *                             以後はframe_beginだけを使って前の位置を背景色で
 *                             消して新しい位置に描く。静止物が再発行されなくても
 *                             消えないことを確認する。
 *   (未定義)                   旧来の8フレーム台本(全画素比較の基本台本)
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

/* x68_rgb()の戻り値をhostが独立照合するための記録(3点、旧来の8フレーム台本のみ)。 */
#define HV2_RGB_RESULT(i) (*(vu32 *)(HV2_BASE + 0x0100 + (unsigned long)(i) * 4UL))

/* 全工程完了の目印。 */
#define HV2_DONE (*(vu32 *)(HV2_BASE + 0x0200))
#define HV2_DONE_MAGIC 0xC1D2E3F4UL

#if defined(X68_L1_EMPTY_SCRIPT)

void main(void) {
    HV2_PROGRESS = 0;
    HV2_DONE = 0;
    x68_screen_open();

    /* 陰性対照: 何も描かない(cls済みの背景だけ)。 */
    int c_bg1 = x68_rgb(0, 0, 0);
    x68_cls(c_bg1);
    x68_screen_flip();
    HV2_FLIP_BYTES(0) = x68_l1_last_flip_bytes;
    HV2_PROGRESS = 1;
    for (int s = 0; s < 3; s++) x68_vsync_wait();

    HV2_DONE = HV2_DONE_MAGIC;
    for (;;) { }
}

#elif defined(X68_L1_DIFF_SCRIPT)

/* ============================================================
 * 差分転送を狙った台本(verify/verify_l1.mts のTS側と1桁単位で一致させること)。
 * 7フレーム:
 *   F0: 初回(force_full。全画面転送になるのが正しい)
 *   F1: 静止物(ブロック5個、命令が前フレームと同一)+動く物(モーター)の同居。
 *       差分転送が効けばモーターの矩形だけが転送されるはず
 *   F2: ブロック1個の色だけを変える(座標・種別は同じ)。色比較を外すと
 *       検出できないはずの変化
 *   F3: ブロックを1個減らす(命令数が減る場面。消えたブロックの領域を
 *       GVRAMから消す転送が要る)
 *   F4: 命令一覧が溢れるほど大量のpsetを1フレームで発行する(overflow)。
 *       安全側フォールバック(全画面転送)が効くはず
 *   F5: F4の直後(prevCmdsがoverflowed)。差分判定ができないため、この
 *       フレームも安全側で全画面転送になる(実装の仕様。docs/L1実装_20260819.md
 *       参照)
 *   F6: 通常の小さい台本に復帰。差分転送が再び効いて転送量が下がるはず
 * ============================================================ */
#define BLK_W 20
#define BLK_H 20
#define BLK_Y 20
#define BLK_X(i) (20 + (i) * 40)

#define MOVER_W 16
#define MOVER_H 16
#define MOVER_Y 200

#define BURST_COUNT 520 /* X68_L1_MAX_RECTS(512)を超えさせるための命令数
                          * (2026-09-01: 64→512に引き上げたのに合わせて70→520に変更) */
#define BURST_Y 400

void main(void) {
    HV2_PROGRESS = 0;
    HV2_DONE = 0;
    x68_screen_open();

    int c_bg = x68_rgb(0, 0, 0);
    int c_s0 = x68_rgb(200, 50, 50);
    int c_s1 = x68_rgb(50, 200, 50);
    int c_s2 = x68_rgb(50, 50, 200);
    int c_s2_new = x68_rgb(50, 200, 200); /* F2以降、block2はこの色に変わる(座標は同じ) */
    int c_s3 = x68_rgb(200, 200, 50);
    int c_s4 = x68_rgb(200, 50, 200);
    int c_mover = x68_rgb(255, 255, 0);
    int c_burst = x68_rgb(128, 128, 128);

    for (int frame = 0; frame < 7; frame++) {
        x68_cls(c_bg); /* 背景色は全フレーム共通(F0のみ初回で全画面転送になる) */

        /* ブロック0〜3は全フレーム共通(F0〜F6)。ブロック2はF2以降、色だけ
         * 変わる(座標・サイズは同じ)。 */
        x68_box_fill(BLK_X(0), BLK_Y, BLK_W, BLK_H, c_s0);
        x68_box_fill(BLK_X(1), BLK_Y, BLK_W, BLK_H, c_s1);
        x68_box_fill(BLK_X(2), BLK_Y, BLK_W, BLK_H, (frame >= 2) ? c_s2_new : c_s2);
        x68_box_fill(BLK_X(3), BLK_Y, BLK_W, BLK_H, c_s3);
        /* ブロック4はF0・F1のみ(F2以降は描かない=消える。命令数が減る場面)。 */
        if (frame <= 1) {
            x68_box_fill(BLK_X(4), BLK_Y, BLK_W, BLK_H, c_s4);
        }

        /* モーター: 全フレームで毎回位置が変わる(動く物)。 */
        int mx = 40 + frame * 10;
        x68_box_fill(mx, MOVER_Y, MOVER_W, MOVER_H, c_mover);

        /* F4だけ、命令一覧が溢れるほど大量のpsetを発行する。 */
        if (frame == 4) {
            for (int i = 0; i < BURST_COUNT; i++) {
                /* x座標を画面幅(512)内に折り返す。X68_SCREEN_Wを超えると
                 * clip_to_screen()で弾かれ命令一覧に積まれない
                 * (=溢れさせるための発行回数が足りなくなる)ため。 */
                x68_pset(10 + (i % 490), BURST_Y, c_burst);
            }
        }

        x68_screen_flip();
        HV2_FLIP_BYTES(frame) = x68_l1_last_flip_bytes;
        HV2_PROGRESS = (unsigned long)(frame + 1);

        /* host側がpx68kのビデオリフレッシュを確実に拾ってから(canvas経由の
         * 全画素比較なので、GVRAM書き込み直後の1フレームだけでは映像に
         * 反映されていない可能性がある)このフレームのGVRAM内容を読めるよう、
         * 何も描かずに数回だけ垂直同期を待つ「静止区間」を設ける。 */
        for (int s = 0; s < 3; s++) x68_vsync_wait();
    }

    HV2_DONE = HV2_DONE_MAGIC;
    for (;;) { }
}

#elif defined(X68_L1_FRAME_BEGIN_SCRIPT)

/* ============================================================
 * x68_frame_begin()方式(追記フレーム)を狙った台本(verify/verify_l1.mts の
 * TS側と1桁単位で一致させること)。samples/breakout/block.cと同じ使い方:
 *   F0: x68_cls(bg)で初期化(再構築フレーム)。動かない絵(静止四角2個)を
 *       ここで1回だけ描く。動く四角の初期位置もここで描く。
 *   F1〜F3: x68_frame_begin()だけを使う(追記フレーム)。cls()は呼ばない。
 *       動く四角の「前の位置」を背景色で消し、「新しい位置」に描く。
 *       静止四角は一度も再発行しない — 差分方式の第一版はここで消えていた
 *       (docs/L1差分描画_20260901.md「追記(2026-09-01)」節参照)。
 * ============================================================ */
#define FB_STATIC0_X 60
#define FB_STATIC0_Y 60
#define FB_STATIC1_X 400
#define FB_STATIC1_Y 350
#define FB_STATIC_W 30
#define FB_STATIC_H 30

#define FB_MOVE_W 20
#define FB_MOVE_H 20
#define FB_MOVE_Y 200
#define FB_MOVE_X(f) (40 + (f) * 30)

void main(void) {
    HV2_PROGRESS = 0;
    HV2_DONE = 0;
    x68_screen_open();

    int c_bg = x68_rgb(0, 0, 0);
    int c_static0 = x68_rgb(200, 50, 50);
    int c_static1 = x68_rgb(50, 50, 200);
    int c_move = x68_rgb(255, 255, 0);

    /* F0: 再構築フレーム。静止物・動く物の初期位置をここでまとめて描く。 */
    x68_cls(c_bg);
    x68_box_fill(FB_STATIC0_X, FB_STATIC0_Y, FB_STATIC_W, FB_STATIC_H, c_static0);
    x68_box_fill(FB_STATIC1_X, FB_STATIC1_Y, FB_STATIC_W, FB_STATIC_H, c_static1);
    x68_box_fill(FB_MOVE_X(0), FB_MOVE_Y, FB_MOVE_W, FB_MOVE_H, c_move);
    x68_screen_flip();
    HV2_FLIP_BYTES(0) = x68_l1_last_flip_bytes;
    HV2_PROGRESS = 1;
    for (int s = 0; s < 3; s++) x68_vsync_wait();

    /* F1〜F3: 追記フレーム。cls()は一切呼ばない。静止物も一切再発行しない。 */
    for (int frame = 1; frame <= 3; frame++) {
        x68_frame_begin();
        int oldx = FB_MOVE_X(frame - 1);
        int newx = FB_MOVE_X(frame);
        x68_box_fill(oldx, FB_MOVE_Y, FB_MOVE_W, FB_MOVE_H, c_bg);   /* 前の位置を背景色で消す */
        x68_box_fill(newx, FB_MOVE_Y, FB_MOVE_W, FB_MOVE_H, c_move); /* 新しい位置に描く */
        x68_screen_flip();
        HV2_FLIP_BYTES(frame) = x68_l1_last_flip_bytes;
        HV2_PROGRESS = (unsigned long)(frame + 1);
        for (int s = 0; s < 3; s++) x68_vsync_wait();
    }

    HV2_DONE = HV2_DONE_MAGIC;
    for (;;) { }
}

#else

/* ============================================================
 * 旧来の8フレーム台本の定数(verify/verify_l1.mts のTS側と1桁単位で一致させること)。
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

    HV2_DONE = HV2_DONE_MAGIC;
    for (;;) { }
}

#endif
