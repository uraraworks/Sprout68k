/* Sprout68k パニック画面: x68_panic_show() の本体(Cで実装)。
 *
 * lib/asm/x68_panic.S の例外エントリスタブから呼ばれる(戻らない)。
 * docs/API設計_20260819.md 設計原則3「暴走は静かに固まるのではなく、
 * 見える形で止まる」の実装。表示は IOCS $21(Stage E-5でハンドラから
 * 使えることを実測確認済み)経由の puts/printf を使う。
 *
 * 呼び出し元(x68_panic.Sの各エントリスタブ)は例外ハンドラの中で
 * 停止する前提のため、この関数は絶対に戻らない(呼び出し元もRTEしない)。
 *
 * ビルド時に以下のマクロを定義すると、検証用に意図的に壊した版を作れる
 * (故障注入。tools/build_panic_test.sh の fault 引数が渡す。通常ビルドでは
 * 一切定義されない):
 *   X68_FAULT_PANIC_NO_INSTALL       (x68_panic.S側で処理。ここでは無関係)
 *   X68_FAULT_PANIC_SAME_MESSAGE     3種すべて同じメッセージを表示する
 *   X68_FAULT_PANIC_PC_ZERO          PCの値を常に0で表示する
 *   X68_FAULT_PANIC_NO_MODE_RESTORE  65536色グラフィックモードを解除しない
 *                                    (下記「グラフィック面がテキストを隠す」節参照)
 *
 * 【重要な罠(2026-08-20、並行実測`docs/重なり実測_20260820.md`により発覚)】
 * x68_screen_open() が有効化する65536色グラフィックモードは、有効な間
 * その512ドット幅の範囲(x=0〜511、テキストの桁0〜63)でテキスト表示を
 * 完全に隠す(Text VRAMへは正しく書き込まれるが、フレームバッファには
 * 一切現れない。ピクセル単位の合成ではなくモードレベルの排他)。
 * パニックハンドラはIOCS $21でテキストを表示する設計のため、**このまま
 * では例外発生時にグラフィックモードが有効なままだと、画面には何も
 * 出ないまま停止する**(設計原則3「見える形で止まる」が満たせない)。
 *
 * 対策: x68_panic_show() の先頭でVCレジスタ2($E82601)のbit5(0x20)を
 * 立てる。実測(px68k-libretro/libretro/windraw.cの読解+本ファイルの
 * verify/verify_panic.mtsでの実測)により、この1ビットが
 * Text_DrawLine()呼び出しの唯一のゲートであり、グラフィックページ表示
 * 有効ビット(bit0-3)とは独立であることを確認した。`VC_R2 = 0x20`と
 * 書くことで、グラフィックページ表示ビット(bit0-3)を同時にクリアしつつ
 * テキスト表示ビットを立てられる(グラフィック面自体も止まるが、
 * 停止画面を出す以上ゲームの続行は無いため問題ない)。CRTC R20・VC R0は
 * Text_DrawLine()の呼び出し条件に関与しないため触れていない
 * (px68k-libretro/x68k/gvram.c・libretro/windraw.cの読解による。
 * 詳細はdocs/パニック画面_20260820.md参照)。
 */
#include "x68.h"

/* VC R2($E82601)。x68_gvram_mode_65536_1page()がbit0(グラフィックページ0
 * 表示)を立てる。パニック時はbit5(0x20、テキスト表示)を立て直す。 */
#define X68_PANIC_VC_R2 (*(x68_vu8 *)0x00E82601UL)

/* lib/asm/x68_panic.S で定義したCP932バイト列(ヌル終端)。 */
extern const char x68_panic_msg_buserr[];
extern const char x68_panic_msg_addrerr[];
extern const char x68_panic_msg_illegal[];
extern const char x68_panic_msg_zerodiv[];
extern const char x68_panic_msg_stop[];

/* void x68_panic_install(void); lib/asm/x68_panic.S。x68_screen_open()から
 * だけ呼ばれる内部実装のため、公開ヘッダ(x68.h)には宣言を置かない。 */
extern void x68_panic_install(void);

static const char *panic_message_for(int type) {
#ifdef X68_FAULT_PANIC_SAME_MESSAGE
    /* 故障注入: 種別によらず常に同じメッセージ(不正命令のもの)を返す。
     * 検証は「3種の弁別」がFAILすることを期待する
     * (docs/パニック画面_20260820.md「故障注入」節)。 */
    (void)type;
    return x68_panic_msg_illegal;
#else
    switch (type) {
        case 2: return x68_panic_msg_buserr;
        case 3: return x68_panic_msg_addrerr;
        case 5: return x68_panic_msg_zerodiv;
        case 4:
        default: return x68_panic_msg_illegal;
    }
#endif
}

/* void x68_panic_show(int type, unsigned long pc);
 * lib/asm/x68_panic.S の例外エントリスタブから呼ばれる。type はベクタ番号
 * (2=バスエラー, 3=アドレスエラー, 4=不正命令, 5=ゼロ除算)。
 * 画面左上へ移動してから「何が起きたか」「PCの値」「停止する旨」を
 * 表示し、無限ループで停止する(要件(a)の1クリック復帰はホスト側の
 * 仕事のため、本関数は復帰しない)。 */
void x68_panic_show(int type, unsigned long pc) {
    unsigned long shown_pc = pc;

#ifndef X68_FAULT_PANIC_NO_MODE_RESTORE
    /* 65536色グラフィックモードが隠しているテキスト表示を復帰させる
     * (上記コメント参照)。ゲームは既に停止しているのでグラフィック面が
     * 消えても問題ない。 */
    X68_PANIC_VC_R2 = 0x20;
#endif

#ifdef X68_FAULT_PANIC_PC_ZERO
    /* 故障注入: PCの値を常に0にする。検証は「PC表示の検査」がFAILする
     * ことを期待する(docs/パニック画面_20260820.md「故障注入」節)。 */
    shown_pc = 0;
#endif

    x68_locate(0, 0);
    puts(panic_message_for(type));
    printf("PC = $%x\n", shown_pc);
    puts(x68_panic_msg_stop);

    for (;;) { }
}
