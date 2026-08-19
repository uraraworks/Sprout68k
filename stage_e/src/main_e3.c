/* Stage E-3 テストプログラム(C、rev3)。
 *
 * 目的: メインメモリ上の領域から GVRAM へ K バイトの転送を N_REPEATS 回繰り返す
 * のに要する時間を、ホスト側が runFrame() の呼び出し回数で測れるようにする。
 *
 * 【rev1/rev2からの変更】rev1・rev2はどちらも「ゲスト側の転送ループの中で
 * 垂直同期(MFP GPIP)を数える」方式だったが、rev1はポーリングが重すぎて
 * 遅く出て(転送速度ではなくポーリング速度を測っていた)、rev2はポーリングを
 * 疎にした結果、垂直帰線期間(数%しかない)をまたいで飛び越しエッジを
 * 見落とし、速く出すぎた(詳細は stage_e/src/e3_copy.S 冒頭コメント、
 * docs/StageE-2-3_実測_20260819.md の訂正箇所を参照)。
 *
 * rev3ではゲスト側から時間計測(GPIPポーリング)を完全に無くす。ゲストは
 * 転送開始の直前に START_FLAG を、N_REPEATS回すべて完了した直後に DONE_FLAG
 * を書くだけで、垂直同期を一切数えない(ループ内オーバーヘッドがゼロになる)。
 * host側(verify/verify_e3.mts)が START_FLAG が立ってから DONE_FLAG が立つ
 * までの runFrame() 呼び出し回数を数えることで所要フレーム数を求める。
 *
 * ビルド時に -D で指定するマクロ:
 *   TRANSFER_WORDS   1回の転送で送るワード数(Kバイト/2)
 *   TRANSFER_METHOD  0=word版、1=long版、2=movem版
 *   N_REPEATS        転送を何回繰り返すか(host側が数えるフレーム数が最低30
 *                     フレーム以上になるよう、verify_e3.mts側で方式ごとに
 *                     選ぶ。0を指定すると陰性対照(転送なし)になる)
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

/* host側が peekByte() で監視する2つのフラグ。E-2/rev1/rev2までの
 * DONE_FLAG($000E0010)と衝突しないよう、START_FLAGは別の固定アドレスに置く。 */
#define START_FLAG (*(vu8 *)0x000E0020)
#define DONE_FLAG  (*(vu8 *)0x000E0010)

#ifndef TRANSFER_WORDS
#error "TRANSFER_WORDS must be defined by the build script (K bytes / 2)"
#endif
#ifndef TRANSFER_METHOD
#error "TRANSFER_METHOD must be defined by the build script (0=word,1=long,2=movem)"
#endif
#ifndef N_REPEATS
#error "N_REPEATS must be defined by the build script"
#endif

extern void e3_copy_word(vu16 *dst, vu16 *src, unsigned long count_words);
extern void e3_copy_long(vu16 *dst, vu16 *src, unsigned long count_longs);
extern void e3_copy_movem(vu16 *dst, vu16 *src, unsigned long count_batches);

void main(void) {
    unsigned long r;

    /* Stage B/C/E-1 と同じレジスタ設定(実測済み): 65536色1ページモード。
     * この設定コスト(レジスタ3回書き)は転送ループ本体に比べて無視できるほど
     * 小さいので、計測区間(START_FLAG〜DONE_FLAG)の外に置く。 */
    CRTC_R20 = 0x08;
    VC_R0 = 0x03;
    VC_R2 = 0x01;

    DONE_FLAG = 0;
    START_FLAG = 1;   /* host側はこれが立った時点を計測開始の目印として使う */

    for (r = 0; r < N_REPEATS; r++) {
#if TRANSFER_METHOD == 0
        e3_copy_word(GVRAM, SRC, TRANSFER_WORDS);
#elif TRANSFER_METHOD == 1
        e3_copy_long(GVRAM, SRC, TRANSFER_WORDS / 2);
#elif TRANSFER_METHOD == 2
        e3_copy_movem(GVRAM, SRC, TRANSFER_WORDS / 16);
#else
#error "TRANSFER_METHOD must be 0, 1, or 2"
#endif
    }

    DONE_FLAG = 1;

    for (;;) { }
}
