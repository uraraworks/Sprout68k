/* Sprout68k L0: レジスタ直書きだけで済む部分(TRAP不要)。
 * IOCS 経由のもの(iocs_print等)は lib/asm/x68_iocs.S、MOVEM コピーは
 * lib/asm/x68_gvram_copy.S にある。
 */
#include "x68.h"

#define MFP_GPIP (*(x68_vu8 *)0x00E88001)

/* Stage E-2 で実測確定した垂直同期待ち(docs/StageE-2-3_実測_20260819.md)。
 * 既に帰線期間の途中かもしれないので、まず表示期間に入るのを待ってから
 * 帰線期間に入る立下りエッジを待つ(エッジを1回だけ確実に検出するため。
 * stage_e/src/main_e2.c の wait_vsync() と同じロジック)。 */
void x68_vsync_wait(void) {
#ifdef X68_FAULT_VSYNC_NO_WAIT
    return; /* 故障注入: 一切待たずに即returnする */
#endif
    while (!(MFP_GPIP & 0x10)) { }
    while (MFP_GPIP & 0x10) { }
}

#define CRTC_R02 (*(x68_vu16 *)0x00E80004)
#define CRTC_R03 (*(x68_vu16 *)0x00E80006)
#define CRTC_R20 (*(x68_vu8 *)0x00E80028)
#define VC_R0    (*(x68_vu8 *)0x00E82401)
#define VC_R2    (*(x68_vu8 *)0x00E82601)

/* Stage B/E-1 で実測確定した65536色1ページモードの設定
 * (docs/StageE-1_実測_20260819.md、docs/API設計_20260819.md)。
 *
 * VC_R2 は当初 0x01(グラフィックページ0表示ビットのみ)だったが、これだと
 * テキスト表示ビット(bit5, 0x20)が立たず、グラフィックモードが有効な間
 * テキストが一切フレームバッファに現れない(Text VRAMへは書けるが見えない。
 * `docs/作例breakout_20260819.md`のスコア表示が見えていなかった原因)。
 * `docs/VC重畳実測_20260820.md`の実測で、0x21(=0x01|0x20)ならグラフィックと
 * テキストが同時に見え、重なった位置ではテキストが手前になることが確定した
 * ため、この値を採用する(推測ではなく実測値)。 */
void x68_gvram_mode_65536_1page(void) {
#ifndef X68_FAULT_CRTC_768_WIDE
    /* IPL のテキスト画面は表示区間が 96文字=768dot のままなので、512dot幅の
     * GVRAM は px68k の走査時に x=512 で折り返され、右側へ再表示される。
     * 左端(R02=28)を保ち、右端を 28+64=92 として表示幅を512dotに揃える。 */
    CRTC_R02 = 28;
    CRTC_R03 = 92;
#endif
    CRTC_R20 = 0x08;
    VC_R0 = 0x03;
#ifdef X68_FAULT_VC_TEXT_HIDDEN
    /* 故障注入: テキストが隠れる旧値(0x01)に戻す(verify/verify_breakout.mts
     * の故障注入。スコア表示のフレームバッファ可視性検査が実際にFAILする
     * ことを確認するためのもの。tools/build_breakout.sh の fault=vc_text_hidden
     * が渡す。通常ビルドでは一切定義されない)。 */
    VC_R2 = 0x01;
#else
    VC_R2 = 0x21;
#endif
}
