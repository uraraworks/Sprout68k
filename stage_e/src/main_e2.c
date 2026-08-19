/* Stage E-2 テストプログラム(C)。
 *
 * 目的: 垂直同期(垂直帰線期間)の検出方法を実測で確定する。
 *
 * 候補(解読による。px68k-libretro x68k/mfp.c の GetGPIP() を読んで見つけた):
 *   MFP(MC68901相当) の GPIP レジスタ($00E88001)の bit4(0x10)が、
 *   CRTC の表示期間中(vline が CRTC_VSTART..CRTC_VEND の範囲内)は1、
 *   垂直帰線期間中は0になる。これは実機の一般的な VDISP 信号の極性と同じ
 *   想定だが、あくまで px68k のソースコードを読んで立てた「候補」であり、
 *   「実測で確認した事実」ではない。実測はこのプログラムの実行結果そのもの
 *   (verify/verify_e2.mts が host 側から観測する)で行う。
 *
 * 動作: 無限ループで「表示期間に入るまで待つ→帰線期間に入るまで待つ」を1回
 * (=1回の垂直同期待ち)として繰り返し、待った回数を32bitカウンタとして
 * 固定RAMアドレス(HOSTVAR_COUNTER)に書き続ける。host側は px68k の
 * runFrame() 呼び出し回数とこのカウンタの増分を突き合わせる。
 *
 * USE_VSYNC_WAIT が0の場合は wait_vsync() を空にする(陰性対照。同期待ちを
 * 外した場合にホストフレーム数とカウンタの関係が崩れることを示すための版)。
 *
 * newlib は使わない。ヒープも使わない。フリースタンディング。
 */
typedef volatile unsigned char vu8;
typedef volatile unsigned long vu32;

#define MFP_GPIP (*(vu8 *)0x00E88001)

/* host側から peekWord を2回(上位ワード→下位ワード)読んで合成する固定アドレス。
 * stage_c のロードアドレス($3000)・スタック($F0000, RAM_SIZE=1MBのとき)の
 * どちらとも十分離れた位置に固定で置く(build_stage_e2.sh 側でも整合を保つ)。 */
#define HOSTVAR_COUNTER (*(vu32 *)0x000E0000)

#ifndef USE_VSYNC_WAIT
#error "USE_VSYNC_WAIT must be defined by the build script (0 or 1)"
#endif

#if USE_VSYNC_WAIT
static void wait_vsync(void) {
    /* 既に帰線期間の途中かもしれないので、まず表示期間に入るのを待ってから
     * 帰線期間に入る立下りエッジを待つ(エッジを1回だけ確実に検出するため)。 */
    while (!(MFP_GPIP & 0x10)) { }
    while (MFP_GPIP & 0x10) { }
}
#else
static void wait_vsync(void) {
    /* 陰性対照: 同期待ちをしない */
}
#endif

void main(void) {
    unsigned long c = 0;
    HOSTVAR_COUNTER = 0;
    for (;;) {
        wait_vsync();
        c++;
        HOSTVAR_COUNTER = c;
    }
}
