/* X68kDev パニック画面の検証用テストプログラム(verify/verify_panic.mts)。
 *
 * ビルド時に -D で指定するマクロ:
 *   MODE      0=例外を起こす(陽性: パニック画面が出るはず)
 *             1=例外を起こさない(陰性対照: パニック画面が出ないはず)
 *   EXC_TYPE  MODE==0のときだけ意味を持つ。ベクタ番号と揃えてある
 *             (lib/asm/x68_panic.Sのx68_panic_showのtype引数と同じ):
 *               2=バスエラー 3=アドレスエラー 4=不正命令(既定) 5=ゼロ除算
 *   PAD       トリガ命令の直前に挿入するNOPの個数(既定0)。0〜8。
 *             「例外を起こした箇所を変えるとPCの値が変わること」を
 *             確かめるための細工(docs/パニック画面_20260820.md参照)。
 *
 * x68_screen_open() の中で例外ベクタが自前のパニックハンドラへ差し替わる
 * (lib/src/x68_l1.c参照)。本プログラムはそれ以外に自前のハンドラを
 * 一切持たず、素直にx68_screen_open()を呼ぶだけで良い。
 */
#include "x68.h"

typedef volatile unsigned char vu8;
typedef volatile unsigned long vu32;

/* host側との受け渡しアドレス(HOSTVAR)。既存のHV_BASE(0xD0000)/
 * HV2_BASE(0xD8000)/HV3_BASE(0xDA000)と衝突しない0xDC000台を使う。 */
#define HV4_BASE 0x000DC000UL

/* トリガ直前にmain()が1を書く(ここまで正常に到達したことの確認。
 * MODE 0/1どちらでも書く)。 */
#define HV4_ALIVE (*(vu8 *)(HV4_BASE + 0x00))

/* トリガから制御が戻ってきてしまった場合(想定外。捕捉できていれば
 * ハンドラが無限ループで停止するため絶対に来ないはず)に1を書く。 */
#define HV4_RETURNED (*(vu8 *)(HV4_BASE + 0x04))

/* MODE==1(陰性対照)がクラッシュせず最後まで到達したことの目印。
 * MODE==0で捕捉に成功していれば、ここへは絶対に到達しない
 * (ハンドラが停止するため)。 */
#define HV4_DONE (*(vu32 *)(HV4_BASE + 0x08))
#define HV4_DONE_MAGIC 0xC3D4E5F6UL

#ifndef MODE
#error "MODE must be defined (0=trigger, 1=no-trigger negative control)"
#endif
#if MODE != 0 && MODE != 1
#error "MODE must be 0 or 1"
#endif

#ifndef EXC_TYPE
#define EXC_TYPE 4
#endif
#if EXC_TYPE != 2 && EXC_TYPE != 3 && EXC_TYPE != 4 && EXC_TYPE != 5
#error "EXC_TYPE must be 2, 3, 4, or 5"
#endif

#ifndef PAD
#define PAD 0
#endif

/* ---- トリガ(意図的に例外を起こす。Stage E-5(stage_e/src/e5_handlers.S)
 * と同じ3種の起こし方に、バスエラー用のダミーを加えた) ---- */

static void trigger_addr_error(void) {
    /* Cの `*(volatile unsigned short *)1 = 0;` は、番地が奇数だとgccが
     * word書き込み1命令ではなく安全なbyte書き込み2命令に分解してしまい、
     * アドレスエラーが一度も発生しないことを実測で発見した(objdumpで
     * `moveb`2命令になっているのを確認)。stage_e/src/e5_handlers.Sと同じ
     * インラインアセンブラで確実にword命令(move.w)を生成させる。 */
    __asm__ volatile ("move.w #0,1");
}

static void trigger_illegal(void) {
    __asm__ volatile ("illegal");
}

static void trigger_zerodiv(void) {
    volatile int z = 0;
    volatile int r = 100 / z;
    (void)r;
}

/* バスエラーはpx68kのMusashiコアが m68k_pulse_bus_error() を一度も呼ばず
 * 「エミュレートされていない」ため(docs/パニック画面_20260820.md参照)、
 * このトリガはpx68k上では発火しない。ハンドラ自体は実機向けに用意して
 * あるため、参考実装として残す(未使用領域への書き込みを試みる)。 */
static void trigger_buserr(void) {
    volatile unsigned short *p = (volatile unsigned short *)0x00EEFFFEUL;
    *p = 0xFFFF;
}

void main(void) {
    HV4_ALIVE = 0;
    HV4_RETURNED = 0;
    HV4_DONE = 0;

    x68_screen_open(); /* ここで例外ベクタが差し替わる */

    /* 【故障注入no_mode_restoreの検出用マーカー】パニックメッセージが出る
     * 領域(x:0-260,y:0-48相当)へ、背景ともメッセージのインク色とも違う
     * 色の矩形を描いておく。x68_panic_show()がVC R2($E82601)を復元すれば
     * グラフィックページ表示ビットが落ちてこの矩形はフレームバッファから
     * 消える。復元しなければ(故障注入)、この矩形はテキストと一緒に見え
     * 続ける。
     *
     * 【なぜこれが必要か(2026-08-20)】以前はここを「テキストが見えるか
     * どうか」だけで判定していた。当時のライブラリ既定値(VC_R2=0x01)は
     * グラフィックモード中テキストを一切表示しなかったため、
     * x68_panic_show()が復元(VC_R2=0x20)しなければテキストごと消えて
     * いた。ところがdocs/VC重畳実測_20260820.mdの実測でVC_R2=0x21
     * (グラフィックとテキストが同時に見える値)がライブラリ既定値になり、
     * 「復元しなくてもテキストは見える」状態になったため、この検出方法は
     * 意味を失った(空振りする)。復元処理そのものは今も
     * 「グラフィックページを消して停止画面をすっきりさせる」という役目を
     * 持ち続けているので、この矩形マーカーでその役目を直接確かめる。 */
    x68_box_fill(0, 0, 240, 40, x68_rgb(0, 255, 255));
    x68_screen_flip();

    HV4_ALIVE = 1;

#if MODE == 0
    /* PAD個のNOPでトリガ命令のアドレスをずらす(PCが場所に応じて
     * 変わることの検証用)。 */
#if PAD >= 1
    __asm__ volatile ("nop");
#endif
#if PAD >= 2
    __asm__ volatile ("nop");
#endif
#if PAD >= 3
    __asm__ volatile ("nop");
#endif
#if PAD >= 4
    __asm__ volatile ("nop");
#endif
#if PAD >= 5
    __asm__ volatile ("nop");
#endif
#if PAD >= 6
    __asm__ volatile ("nop");
#endif
#if PAD >= 7
    __asm__ volatile ("nop");
#endif
#if PAD >= 8
    __asm__ volatile ("nop");
#endif

#if EXC_TYPE == 2
    trigger_buserr();
#elif EXC_TYPE == 3
    trigger_addr_error();
#elif EXC_TYPE == 5
    trigger_zerodiv();
#else
    trigger_illegal();
#endif

    /* 捕捉できていれば絶対にここへは来ない。 */
    HV4_RETURNED = 1;
#endif /* MODE == 0 */

    HV4_DONE = HV4_DONE_MAGIC;
    for (;;) { }
}
