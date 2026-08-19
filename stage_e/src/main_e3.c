/* Stage E-3 テストプログラム(C、再測定版)。
 *
 * 目的: メインメモリ上の領域から GVRAM へ K バイト転送する間に経過した垂直同期の
 * 回数を実測し、1フレームあたりの転送スループット(バイト/フレーム)を求める。
 *
 * 【旧版からの変更】旧main_e3.cは1ワードコピーするごとに毎回MFP GPIPを読んでいた
 * ため、低速なI/Oバス読み出しが支配的になり「転送速度」ではなく「転送+ワード毎
 * ポーリング」の速度を測っていた(詳細はstage_e/src/e3_copy.Sの先頭コメント、
 * docs/StageE-2-3_実測_20260819.mdの訂正箇所を参照)。今回はポーリングを内側
 * ループから出し(poll_interval個のコピー単位ごとに1回)、かつ転送方式を
 * word/long/movemの3通りで比較できるようにした。実体は stage_e/src/e3_copy.S。
 *
 * 垂直同期の検出方法(MFP GPIP $E88001 bit4 の立下りエッジ)は Stage E-2 で
 * 実測確定した内容をそのまま使う。
 *
 * ビルド時に -D で指定するマクロ:
 *   TRANSFER_WORDS   転送する総ワード数(Kバイト/2)
 *   TRANSFER_METHOD  0=word版、1=long版、2=movem版
 *   POLL_INTERVAL    何コピー単位ごとに1回 MFP を読むか(単位は方式依存。
 *                     word版=ワード数、long版=ロング数、movem版=バッチ数)
 *   N_REPEATS        同じK バイトの転送を何回繰り返すか(1フレーム未満で終わる
 *                     ほど速い方式・小さいKでは、垂直同期を1回数えるだけの粒度
 *                     では量子化誤差が支配的になる(実測: movem版はK=512KBでも
 *                     1回の転送がguestVsyncEvents=0か1にしかならず、Nを振っても
 *                     「収束」を確認できなかった)。同じ転送をN_REPEATS回繰り返し、
 *                     累積した垂直同期回数で割ることで量子化誤差を薄める。
 *                     host側は total_bytes = TRANSFER_WORDS*2*N_REPEATS を
 *                     guestVsyncEvents(累積)で割ってスループットを求める。
 *
 * 転送元(SRC)・完了通知(DONE_FLAG)・カウンタ(VSYNC_COUNT)のアドレスは
 * 旧main_e3.cと同じ固定アドレスを使う(build_stage_e3.shの安全域チェックも
 * 同じ考え方を踏襲)。
 *
 * newlib は使わない。ヒープも使わない。フリースタンディング。
 */
typedef volatile unsigned char vu8;
typedef volatile unsigned short vu16;
typedef volatile unsigned long vu32;

#define CRTC_R20 (*(vu8 *)0x00E80028)
#define VC_R0    (*(vu8 *)0x00E82401)
#define VC_R2    (*(vu8 *)0x00E82601)
#define GVRAM    ((vu16 *)0x00C00000)

#define SRC ((vu16 *)0x00020000)

#define DONE_FLAG    (*(vu8 *)0x000E0010)
#define VSYNC_COUNT  (*(vu32 *)0x000E0014)

#ifndef TRANSFER_WORDS
#error "TRANSFER_WORDS must be defined by the build script (K bytes / 2)"
#endif
#ifndef TRANSFER_METHOD
#error "TRANSFER_METHOD must be defined by the build script (0=word,1=long,2=movem)"
#endif
#ifndef POLL_INTERVAL
#error "POLL_INTERVAL must be defined by the build script"
#endif
#ifndef N_REPEATS
#error "N_REPEATS must be defined by the build script"
#endif

extern unsigned long e3_copy_word(vu16 *dst, vu16 *src, unsigned long count_words, unsigned long poll_interval);
extern unsigned long e3_copy_long(vu16 *dst, vu16 *src, unsigned long count_longs, unsigned long poll_interval);
extern unsigned long e3_copy_movem(vu16 *dst, vu16 *src, unsigned long count_batches, unsigned long poll_interval);

void main(void) {
    unsigned long total_vsync_events = 0;
    unsigned long r;

    /* Stage B/C/E-1 と同じレジスタ設定(実測済み): 65536色1ページモード */
    CRTC_R20 = 0x08;
    VC_R0 = 0x03;
    VC_R2 = 0x01;

    DONE_FLAG = 0;
    VSYNC_COUNT = 0;

    /* GVRAM/SRC のポインタは毎回関数呼び出しで新規に渡す(呼び出しごとに先頭へ
     * 巻き戻る)。GVRAM の最終的な表示内容はこの測定の関心事ではない
     * (スループットだけを見る)ので、同じ範囲へ繰り返し書いて構わない。 */
    for (r = 0; r < N_REPEATS; r++) {
#if TRANSFER_METHOD == 0
        total_vsync_events += e3_copy_word(GVRAM, SRC, TRANSFER_WORDS, POLL_INTERVAL);
#elif TRANSFER_METHOD == 1
        total_vsync_events += e3_copy_long(GVRAM, SRC, TRANSFER_WORDS / 2, POLL_INTERVAL);
#elif TRANSFER_METHOD == 2
        total_vsync_events += e3_copy_movem(GVRAM, SRC, TRANSFER_WORDS / 16, POLL_INTERVAL);
#else
#error "TRANSFER_METHOD must be 0, 1, or 2"
#endif
    }

    VSYNC_COUNT = total_vsync_events;
    DONE_FLAG = 1;

    for (;;) { }
}
