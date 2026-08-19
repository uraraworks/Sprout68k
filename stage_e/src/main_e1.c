/* Stage E-1 テストプログラム(C)。
 *
 * 目的: 65536色1ページモードの GVRAM 線形オフセット→画面座標の対応を実測する。
 * Stage B/C と同じ3レジスタ設定(CRTC R20 / VC R0 / VC R2)で65536色1ページモードを
 * 有効にした後、ビルド時に指定したオフセット・色の組(markers[])だけを GVRAM に
 * 1ワードずつ書く(全面塗りはしない。「画面全体を単色で塗る検査は使わない」という
 * 実測方針に合わせ、疎なマーカーで線形オフセット→座標の対応を取るための構成)。
 *
 * markers[] / marker_count は tools/gen_markers_e1.py が生成する
 * build/stage_e1_obj/markers_data.c で定義される(呼び出し元がマーカー仕様を
 * 決める。この .c 自体は静的な仕様を書かない)。
 *
 * newlib は使わない。ヒープも使わない。フリースタンディング。
 */
typedef volatile unsigned char vu8;
typedef volatile unsigned short vu16;

#define CRTC_R20 (*(vu8 *)0x00E80028)
#define VC_R0    (*(vu8 *)0x00E82401)
#define VC_R2    (*(vu8 *)0x00E82601)
#define GVRAM    ((vu16 *)0x00C00000)

typedef struct {
    unsigned long offset_words; /* GVRAM 先頭からのワードオフセット */
    unsigned short color;       /* 書き込む16bit色値 */
} marker_t;

extern const marker_t markers[];
extern const unsigned long marker_count;

extern void iocs_print(const char *msg);

void main(void) {
    /* Stage B/C と同じレジスタ設定(実測済み): CRTC R20 / VC R0 / VC R2 の
     * 3つを揃えないと65536色グラフィック面が映らない */
    CRTC_R20 = 0x08;
    VC_R0 = 0x03;
    VC_R2 = 0x01;

    for (unsigned long i = 0; i < marker_count; i++) {
        GVRAM[markers[i].offset_words] = markers[i].color;
    }

    iocs_print("MARKERS DONE\0");

    for (;;) {
    }
}
