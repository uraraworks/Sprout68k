/* Stage E-6 テストプログラム(C)。
 *
 * 目的: 文字表示の座標指定(print_at相当)の手段を実測する。IOCS $23(候補、
 * B_LOCATEと手読みしたもの。docs/StageE-6_実測_20260819.md参照)でカーソル位置を
 * 指定した後、IOCS $21(Stage A/Cで実測済みの文字列表示)で文字列を出す。
 *
 * markers[]/marker_count は tools/gen_markers_e6.py が生成する
 * build/stage_e6_obj/markers_data.c で定義される(呼び出し元がマーカー仕様を
 * 決める。この .c 自体は静的な仕様を書かない)。use_locate=0 のエントリは
 * iocs_locate を呼ばずに iocs_print だけ行う(陰性対照用)。
 *
 * newlib は使わない。ヒープも使わない。フリースタンディング。
 */
typedef struct {
    int col;
    int row;
    int use_locate; /* 0 = iocs_locate を呼ばない(陰性対照用) */
    const char *text;
} marker_t;

extern const marker_t markers[];
extern const unsigned long marker_count;

extern void iocs_print(const char *msg);
extern void iocs_locate(int col, int row);

void main(void) {
    for (unsigned long i = 0; i < marker_count; i++) {
        if (markers[i].use_locate) {
            iocs_locate(markers[i].col, markers[i].row);
        }
        iocs_print(markers[i].text);
    }

    /* 全マーカー処理後もCPUが生きて実行を続けていることの証跡(範囲外座標を
     * 与えた後の暴走・ハング検出に使う)。位置指定はしない。 */
    iocs_print("E6 DONE\0");

    for (;;) {
    }
}
