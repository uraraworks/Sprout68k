/* Stage C テストプログラム(C)。
 * 1. 画面をビルド時に指定した色(FILL_COLOR、既定 0xFFFF)で塗る
 * 2. IOCS $21 で文字列を表示する
 *
 * newlib は使わない。ヒープも使わない。フリースタンディング。
 */
typedef volatile unsigned char vu8;
typedef volatile unsigned short vu16;

#define CRTC_R20 (*(vu8 *)0x00E80028)
#define VC_R0    (*(vu8 *)0x00E82401)
#define VC_R2    (*(vu8 *)0x00E82601)
#define GVRAM    ((vu16 *)0x00C00000)
#define GVRAM_WORDS 0x00040000UL /* 512x512dot 分 = 0x80000バイト / 2 */

#ifndef FILL_COLOR
#define FILL_COLOR 0xFFFF
#endif

extern void iocs_print(const char *msg);

void main(void) {
    /* Stage B と同じレジスタ設定(実測済み): CRTC R20 / VC R0 / VC R2 の
     * 3つを揃えないと65536色グラフィック面が映らない */
    CRTC_R20 = 0x08;
    VC_R0 = 0x03;
    VC_R2 = 0x01;

    for (unsigned long i = 0; i < GVRAM_WORDS; i++) {
        GVRAM[i] = FILL_COLOR;
    }

    iocs_print("STAGE C OK\0");

    for (;;) {
    }
}
