/* X68kDev L0: レジスタ直書きだけで済む部分(TRAP不要)。
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
    while (!(MFP_GPIP & 0x10)) { }
    while (MFP_GPIP & 0x10) { }
}

#define CRTC_R20 (*(x68_vu8 *)0x00E80028)
#define VC_R0    (*(x68_vu8 *)0x00E82401)
#define VC_R2    (*(x68_vu8 *)0x00E82601)

/* Stage B/E-1 で実測確定した65536色1ページモードの設定
 * (docs/StageE-1_実測_20260819.md、docs/API設計_20260819.md)。 */
void x68_gvram_mode_65536_1page(void) {
    CRTC_R20 = 0x08;
    VC_R0 = 0x03;
    VC_R2 = 0x01;
}
