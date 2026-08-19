/* 宿題3 追加実測: 65536色グラフィックとテキストの同時表示可否を、
 * Video Controller の各種レジスタを振って確定するための検体(C)。
 *
 * docs/VC重畳実測_20260820.md 参照。main_overlay.c(重なり実測)と同じ
 * 構造(GVRAM矩形塗り + IOCS $23/$21 でのテキスト表示)だが、レジスタ値を
 * ビルド時に埋め込んだ regs[] から読む点が異なる(呼び出し元=
 * verify/verify_vc_sweep.mts が1設定ごとに再ビルドしてブートする)。
 *
 * セル配置は docs/重なり実測_20260820.md で実測済みのピッチ(8x16)・原点(0,0)を
 * そのまま使う(このスクリプト自身では再計測しない。既知の実測事実の再利用)。
 *
 * newlib は使わない。ヒープも使わない。フリースタンディング。
 * lib/ は変更していない(iocs_print/iocs_locateは stage_c/crt0/iocs.S・
 * stage_e/src/iocs_e6.S をそのまま流用)。
 */
typedef volatile unsigned char vu8;
typedef volatile unsigned short vu16;

#define CRTC_R20   (*(vu8 *)0x00E80028)
#define VC_R0_HI   (*(vu8 *)0x00E82400)
#define VC_R0_LO   (*(vu8 *)0x00E82401)
#define VC_R1_HI   (*(vu8 *)0x00E82500)
#define VC_R1_LO   (*(vu8 *)0x00E82501)
#define VC_R2_HI   (*(vu8 *)0x00E82600)
#define VC_R2_LO   (*(vu8 *)0x00E82601)
#define GVRAM      ((vu16 *)0x00C00000)
#define GVRAM_STRIDE 512UL /* Stage E-1 実測: 1ライン512ワード */

/* regs[] = { CRTC_R20, VC_R0_HI, VC_R0_LO, VC_R1_HI, VC_R1_LO, VC_R2_HI, VC_R2_LO } */
extern const unsigned char regs[7];

/* 実測済み(docs/重なり実測_20260820.md)のピッチ・原点。桁->x=col*8、行->y=row*16。 */
#define PITCH_X 8
#define PITCH_Y 16

extern void iocs_print(const char *msg);
extern void iocs_locate(int col, int row);

static void fill_box(long x, long y, long w, long h, unsigned short color) {
    long yy, xx;
    for (yy = y; yy < y + h; yy++) {
        if (yy < 0 || yy >= 512) continue;
        for (xx = x; xx < x + w; xx++) {
            if (xx < 0 || xx >= 512) continue; /* GVRAM 実測幅512(Stage E-1)の外へは書かない */
            GVRAM[(unsigned long)yy * GVRAM_STRIDE + (unsigned long)xx] = color;
        }
    }
}

/* 明るい単色(G=31基調)。テキスト前景色(白系)との混同を避けるための強い単色。 */
#define FILL_COLOR 0xF803

void main(void) {
    /* box+text: col=5,row=3 / box-only: col=8,row=3 / text-only: col=11,row=3 /
     * negative: col=20,row=3 / far(グラフィック外側想定): col=70,row=3 /
     * ALIVE(生存確認、セルから離れた安全な位置): col=0,row=31 */

    /* まずレジスタを設定する(グラフィックモードの有効化を含む)。 */
    CRTC_R20 = regs[0];
    VC_R0_HI = regs[1];
    VC_R0_LO = regs[2];
    VC_R1_HI = regs[3];
    VC_R1_LO = regs[4];
    VC_R2_HI = regs[5];
    VC_R2_LO = regs[6];

    fill_box(5 * PITCH_X, 3 * PITCH_Y, PITCH_X, PITCH_Y, FILL_COLOR);  /* box+text */
    fill_box(8 * PITCH_X, 3 * PITCH_Y, PITCH_X, PITCH_Y, FILL_COLOR);  /* box-only */
    fill_box(511, 3 * PITCH_Y, 1, 1, FILL_COLOR); /* far行の基準ドット(x=511, 実測済み最大可視x) */

    iocs_locate(5, 3);
    iocs_print("Z");
    iocs_locate(11, 3);
    iocs_print("Z");
    iocs_locate(70, 3);
    iocs_print("FAR");
    iocs_locate(0, 31);
    iocs_print("ALIVE");

    for (;;) {
    }
}
