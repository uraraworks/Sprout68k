/* 宿題3: テキスト面とグラフィック面の重なり方の実測用プログラム(C)。
 *
 * 目的: 65536色グラフィック面(GVRAM)へ矩形塗りつぶしを行いつつ、同じ実行内で
 * IOCS $23(候補、B_LOCATE)+ IOCS $21(文字列表示)でテキストを重ねて出す。
 * 同一フレーム上で「グラフィックの既知座標」と「テキストの既知桁・行」を
 * 直接重ねることで、対応関係と前後関係を実測するための検体。
 *
 * boxes[]/texts[] は tools/gen_markers_overlay.py が生成する
 * build/stage_overlay_obj/markers_data.c で定義される(呼び出し元=
 * verify/verify_overlay.mts が値を決める。この main 自体は値を決めない)。
 *
 * newlib は使わない。ヒープも使わない。フリースタンディング。
 * iocs_print/iocs_locate は stage_c/crt0/iocs.S・stage_e/src/iocs_e6.S
 * (Stage E-6 で実測済み、変更しない)をそのまま流用する。
 */
typedef volatile unsigned char vu8;
typedef volatile unsigned short vu16;

#define CRTC_R20 (*(vu8 *)0x00E80028)
#define VC_R0    (*(vu8 *)0x00E82401)
#define VC_R2    (*(vu8 *)0x00E82601)
#define GVRAM    ((vu16 *)0x00C00000)
#define GVRAM_STRIDE 512UL /* Stage E-1 実測: 1ライン512ワード */

typedef struct {
    long x;
    long y;
    long w;
    long h;
    unsigned short color;
} box_t;

typedef struct {
    int col;
    int row;
    const char *text;
} text_marker_t;

extern const box_t boxes[];
extern const unsigned long box_count;
extern const text_marker_t texts[];
extern const unsigned long text_count;

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

void main(void) {
    unsigned long i;

    /* Stage B/C/E-1 と同じレジスタ設定(実測済み) */
    CRTC_R20 = 0x08;
    VC_R0 = 0x03;
    VC_R2 = 0x01;

    for (i = 0; i < box_count; i++) {
        fill_box(boxes[i].x, boxes[i].y, boxes[i].w, boxes[i].h, boxes[i].color);
    }

    for (i = 0; i < text_count; i++) {
        iocs_locate(texts[i].col, texts[i].row);
        iocs_print(texts[i].text);
    }

    for (;;) {
    }
}
