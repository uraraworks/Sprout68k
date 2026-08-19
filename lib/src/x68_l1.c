/* X68kDev L1(学習層): 65536色1ページ + 矩形追跡の部分転送(docs/API設計_20260819.md
 * 「画面モード」節、docs/L1実装_20260819.md)。
 *
 * 裏バッファ(512x512x2=512KBのメインメモリ)に描画し、x68_screen_flip() で
 * 「前フレーム∪今フレーム」の矩形だけをGVRAMへ転送する。
 *
 * ビルド時に以下のマクロを定義すると、検証用に意図的に壊した版を作れる
 * (故障注入。tools/build_l1_test.sh の fault 引数が渡す。通常ビルドでは
 * 一切定義されない。詳細はdocs/L1実装_20260819.mdの故障注入5件の節):
 *   X68_FAULT_L1_SKIP_PREV          flip()が前フレームの矩形を転送しない
 *   X68_FAULT_L1_SHRINK_RECT        矩形リストへ記録する矩形を1px小さくする
 *   X68_FAULT_L1_CLS_NO_FILL        clsが前フレーム矩形を裏バッファへ塗り戻さない
 *   X68_FAULT_L1_CLS_NO_FULL_REPAINT 背景色が変わっても全画面塗り直しをしない
 *   X68_FAULT_L1_NO_CLIP            クリップをしない(画面外書き込みが隣の行へ回り込む)
 */
#include "x68.h"

#define GVRAM_BASE ((x68_vu16 *)0x00C00000UL)

/* 裏バッファ: 512x512x2 = 524,288バイト(512KB)。.bss に置かれるため、
 * ビルド時にスタック(既定STACK_ADDR=$F0000)と衝突しないことを
 * tools/build_l1_test.sh がリンク後のELFシンボル(__bss_end)を見て検査する
 * (docs/L1実装_20260819.md「裏バッファの配置とビルド時検査」節)。 */
static unsigned short x68_backbuffer[X68_SCREEN_W * X68_SCREEN_H];

/* 直近の x68_screen_flip() で実際にGVRAMへ転送したバイト数。公開APIでは
 * ないが(x68.hには宣言しない。ポインタを露出しない設計原則2はポインタの話で
 * カウンタ整数は対象外)、検証プログラムがexternで直接参照して1フレームあたりの
 * 転送量を実測する(docs/API設計_20260819.md「API実装時の宿題」1)。 */
unsigned long x68_l1_last_flip_bytes = 0;

typedef struct {
    int x0, y0, x1, y1; /* 半開区間 [x0,x1) x [y0,y1)。screen_openedの間は常に
                            クリップ済み(X68_FAULT_L1_NO_CLIP時を除く)。 */
} X68Rect;

#define X68_L1_MAX_RECTS 64

typedef struct {
    int count;      /* rects[] の有効な個数(overflowedなら無視) */
    int overflowed; /* 1なら bbox だけが唯一の矩形として有効 */
    int has_bbox;   /* このフレームで一度でもaddされたか */
    X68Rect bbox;
    X68Rect rects[X68_L1_MAX_RECTS];
} X68RectList;

static int screen_opened = 0;
static int bg_valid = 0;   /* x68_clsを一度でも呼んだか */
static int bg_color = 0;   /* 直前にx68_clsへ渡した色 */
static int force_full = 0; /* 次のflip()で全画面転送が要るか */

/* curRects: 今フレームの描画プリミティブ(pset/box_fill/box/line/circle)が
 *   追加した矩形。x68_cls自身の塗り戻しはここへは追加しない
 *   (理由はdocs/L1実装_20260819.md「矩形リストがポイズニングする罠」節)。
 * prevRects: 直前のflip()の時点でのcurRects(=前フレームの描画矩形)。
 *   次のx68_clsが「塗り戻す範囲」として参照する。 */
static X68RectList curRects;
static X68RectList prevRects;

/* ============================================================
 * 矩形クリップ・裏バッファへの読み書き
 * ============================================================ */

static int clip_to_screen(int x0, int y0, int x1, int y1, X68Rect *out) {
#ifdef X68_FAULT_L1_NO_CLIP
    /* 故障注入: 範囲チェックをしない。呼び出し側が画面内に収まる番地を
     * 選ぶ限りは(y*W+xの符号付き演算で)配列の範囲内に留まるが、意図した
     * 位置とは別の場所(隣の行等)を指す。 */
    out->x0 = x0; out->y0 = y0; out->x1 = x1; out->y1 = y1;
    return (x1 > x0 && y1 > y0);
#else
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > X68_SCREEN_W) x1 = X68_SCREEN_W;
    if (y1 > X68_SCREEN_H) y1 = X68_SCREEN_H;
    if (x1 <= x0 || y1 <= y0) return 0;
    out->x0 = x0; out->y0 = y0; out->x1 = x1; out->y1 = y1;
    return 1;
#endif
}

/* 裏バッファへのアクセス。符号付きlongでオフセットを計算する
 * (X68_FAULT_L1_NO_CLIP時、x<0がy-1行の末尾へ「回り込む」ようにするため。
 * unsignedにキャストすると巨大な値になり範囲外アクセスになってしまう)。 */
static void bb_set(int x, int y, unsigned short c) {
    long idx = (long)y * X68_SCREEN_W + (long)x;
    x68_backbuffer[idx] = c;
}
static unsigned short bb_get(int x, int y) {
    long idx = (long)y * X68_SCREEN_W + (long)x;
    return x68_backbuffer[idx];
}

static void fill_rect(const X68Rect *r, unsigned short c) {
    for (int y = r->y0; y < r->y1; y++) {
        for (int x = r->x0; x < r->x1; x++) {
            bb_set(x, y, c);
        }
    }
}

/* ============================================================
 * 矩形リスト
 * ============================================================ */

static void rectlist_reset(X68RectList *l) {
    l->count = 0;
    l->overflowed = 0;
    l->has_bbox = 0;
}

static void rectlist_add(X68RectList *l, int x0, int y0, int x1, int y1) {
#ifdef X68_FAULT_L1_SHRINK_RECT
    /* 故障注入: 記録する矩形を1px小さくする(右端・下端が転送されず欠ける) */
    x1 -= 1;
    y1 -= 1;
#endif
    X68Rect r;
    if (!clip_to_screen(x0, y0, x1, y1, &r)) return;

    if (!l->has_bbox) {
        l->bbox = r;
        l->has_bbox = 1;
    } else {
        if (r.x0 < l->bbox.x0) l->bbox.x0 = r.x0;
        if (r.y0 < l->bbox.y0) l->bbox.y0 = r.y0;
        if (r.x1 > l->bbox.x1) l->bbox.x1 = r.x1;
        if (r.y1 > l->bbox.y1) l->bbox.y1 = r.y1;
    }

    if (!l->overflowed) {
        if (l->count < X68_L1_MAX_RECTS) {
            l->rects[l->count++] = r;
        } else {
            /* 溢れた: 個別リストは諦め、既に更新済みのbboxだけを唯一の矩形とする
             * (安全側に倒す。docs/L1実装_20260819.md参照)。 */
            l->overflowed = 1;
        }
    }
}

/* ============================================================
 * GVRAM転送
 * ============================================================ */

static unsigned long transfer_rect(const X68Rect *r) {
    int x0 = r->x0, y0 = r->y0, x1 = r->x1, y1 = r->y1;
    int w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return 0;
    unsigned long bytes = 0;

    if (x0 == 0 && x1 == X68_SCREEN_W) {
        /* 幅いっぱいの矩形(複数行含む場合)は、裏バッファ・GVRAM双方で
         * 連続領域になるので1回の転送にまとめられる(全画面転送はこの経路)。 */
        unsigned long words = (unsigned long)w * (unsigned long)h;
        unsigned long batch = words / 16UL;
        unsigned short *src = &x68_backbuffer[(long)y0 * X68_SCREEN_W + x0];
        x68_vu16 *dst = GVRAM_BASE + (long)y0 * X68_SCREEN_W + x0;
        if (batch) x68_gvram_copy_movem((void *)dst, (const void *)src, batch);
        /* 端数(32バイト=16ワードに満たない分)を落とさず個別にコピーする
         * (docs/API設計_20260819.md「矩形の幅は32バイトの倍数とは限らない」)。 */
        for (unsigned long i = batch * 16UL; i < words; i++) dst[i] = src[i];
        bytes = words * 2UL;
    } else {
        for (int y = y0; y < y1; y++) {
            unsigned short *src = &x68_backbuffer[(long)y * X68_SCREEN_W + x0];
            x68_vu16 *dst = GVRAM_BASE + (long)y * X68_SCREEN_W + x0;
            unsigned long batch = (unsigned long)w / 16UL;
            if (batch) x68_gvram_copy_movem((void *)dst, (const void *)src, batch);
            for (unsigned long i = batch * 16UL; i < (unsigned long)w; i++) dst[i] = src[i];
            bytes += (unsigned long)w * 2UL;
        }
    }
    return bytes;
}

/* X68_FAULT_L1_SKIP_PREV はこの関数自体は変えず、x68_screen_flip() 側で
 * prevRects に対する呼び出しをまるごと省くことで再現する(下記参照)。 */
static unsigned long transfer_list(const X68RectList *l) {
    if (!l->has_bbox) return 0;
    unsigned long bytes = 0;
    if (l->overflowed) {
        bytes += transfer_rect(&l->bbox);
    } else {
        for (int i = 0; i < l->count; i++) bytes += transfer_rect(&l->rects[i]);
    }
    return bytes;
}

static void fill_rectlist(const X68RectList *l, unsigned short c) {
    if (!l->has_bbox) return;
    if (l->overflowed) {
        fill_rect(&l->bbox, c);
    } else {
        for (int i = 0; i < l->count; i++) fill_rect(&l->rects[i], c);
    }
}

/* ============================================================
 * 公開API
 * ============================================================ */

void x68_screen_open(void) {
    x68_gvram_mode_65536_1page();
    for (unsigned long i = 0; i < (unsigned long)X68_SCREEN_W * X68_SCREEN_H; i++) {
        x68_backbuffer[i] = 0;
    }
    rectlist_reset(&curRects);
    rectlist_reset(&prevRects);
    bg_valid = 0;
    bg_color = 0;
    /* GVRAMの初期内容は不定なので、x68_clsを呼んでいなくても最初の
     * flip()は裏バッファ全体を転送する。 */
    force_full = 1;
    screen_opened = 1;
}

void x68_cls(int color) {
    if (!screen_opened) return;
    unsigned short c16 = (unsigned short)color;

#ifdef X68_FAULT_L1_CLS_NO_FULL_REPAINT
    int need_full = 0; /* 故障注入: 背景色が変わっても検知しない */
#else
    int need_full = (!bg_valid) || (color != bg_color);
#endif

    if (need_full) {
        fill_rect(&(X68Rect){0, 0, X68_SCREEN_W, X68_SCREEN_H}, c16);
        force_full = 1;
        /* 全画面が背景色になった以上、前フレームの矩形リストが指していた
         * 「消すべき前景」はもう無い。次のx68_clsが誤って古い場所を
         * もう一度塗り戻さないよう空にしておく(この後の描画呼び出しが
         * curRectsへ積み直す)。 */
        rectlist_reset(&curRects);
        rectlist_reset(&prevRects);
    } else {
#ifndef X68_FAULT_L1_CLS_NO_FILL
        fill_rectlist(&prevRects, c16);
#endif
        /* 塗り戻した範囲はcurRectsへは足さない。flip()がprevRectsを
         * 転送対象にunionする(下記x68_screen_flip参照)ので、それだけで
         * GVRAM側も正しく塗り戻される。ここでcurRectsへ足すと、次回flip後の
         * prevRectsが「今フレームの前景矩形」ではなく「前フレームの矩形+
         * 今フレームの前景矩形」に膨らみ続け、cls()を毎フレーム呼ぶだけで
         * 全画面相当の矩形がフレームを跨いで肥大化していく
         * (実装中に見つけた罠。docs/L1実装_20260819.md参照)。 */
    }
    bg_color = color;
    bg_valid = 1;
}

void x68_pset(int x, int y, int color) {
    if (!screen_opened) return;
    X68Rect r;
    if (!clip_to_screen(x, y, x + 1, y + 1, &r)) return;
    fill_rect(&r, (unsigned short)color);
    rectlist_add(&curRects, r.x0, r.y0, r.x1, r.y1);
}

int x68_pget(int x, int y) {
    if (!screen_opened) return 0;
    if (x < 0 || x >= X68_SCREEN_W || y < 0 || y >= X68_SCREEN_H) return 0;
    return (int)bb_get(x, y);
}

void x68_box_fill(int x, int y, int w, int h, int color) {
    if (!screen_opened) return;
    if (w <= 0 || h <= 0) return;
    X68Rect r;
    if (!clip_to_screen(x, y, x + w, y + h, &r)) return;
    fill_rect(&r, (unsigned short)color);
    rectlist_add(&curRects, r.x0, r.y0, r.x1, r.y1);
}

void x68_box(int x, int y, int w, int h, int color) {
    if (!screen_opened) return;
    if (w <= 0 || h <= 0) return;
    /* 太さ1ドットの4辺。それぞれx68_box_fillと同じ経路(クリップ・追跡)で描く。
     * w/hが1の場合は上下(または左右)の辺が重なるが、同じ内容を2回塗るだけで
     * 実害は無い。 */
    x68_box_fill(x, y, w, 1, color);              /* 上辺 */
    x68_box_fill(x, y + h - 1, w, 1, color);       /* 下辺 */
    x68_box_fill(x, y, 1, h, color);               /* 左辺 */
    x68_box_fill(x + w - 1, y, 1, h, color);        /* 右辺 */
}

void x68_line(int x1, int y1, int x2, int y2, int color) {
    if (!screen_opened) return;
    unsigned short c = (unsigned short)color;

    int dx = x2 - x1; if (dx < 0) dx = -dx;
    int sx = (x1 < x2) ? 1 : -1;
    int dy = y2 - y1; if (dy > 0) dy = -dy; /* dyは<=0で保持(標準的なBresenham) */
    int sy = (y1 < y2) ? 1 : -1;
    int err = dx + dy;

    int cx = x1, cy = y1;
    for (;;) {
        if (cx >= 0 && cx < X68_SCREEN_W && cy >= 0 && cy < X68_SCREEN_H) {
            bb_set(cx, cy, c);
        }
        if (cx == x2 && cy == y2) break;
        int e2 = 2 * err;
        if (e2 >= dy) { err += dy; cx += sx; }
        if (e2 <= dx) { err += dx; cy += sy; }
    }

    /* 実際に塗った画素の外接矩形(=両端点の外接矩形)をまとめて1回で追跡する
     * (画素ごとにrectlist_addすると溢れやすくなるため)。両端とも画面外なら
     * rectlist_add自身が空とみなして何もしない。 */
    int bx0 = (x1 < x2) ? x1 : x2;
    int bx1 = ((x1 > x2) ? x1 : x2) + 1;
    int by0 = (y1 < y2) ? y1 : y2;
    int by1 = ((y1 > y2) ? y1 : y2) + 1;
    rectlist_add(&curRects, bx0, by0, bx1, by1);
}

static void circle_plot8(int cx, int cy, int x, int y, unsigned short c) {
    if (cx + x >= 0 && cx + x < X68_SCREEN_W && cy + y >= 0 && cy + y < X68_SCREEN_H) bb_set(cx + x, cy + y, c);
    if (cx - x >= 0 && cx - x < X68_SCREEN_W && cy + y >= 0 && cy + y < X68_SCREEN_H) bb_set(cx - x, cy + y, c);
    if (cx + x >= 0 && cx + x < X68_SCREEN_W && cy - y >= 0 && cy - y < X68_SCREEN_H) bb_set(cx + x, cy - y, c);
    if (cx - x >= 0 && cx - x < X68_SCREEN_W && cy - y >= 0 && cy - y < X68_SCREEN_H) bb_set(cx - x, cy - y, c);
    if (cx + y >= 0 && cx + y < X68_SCREEN_W && cy + x >= 0 && cy + x < X68_SCREEN_H) bb_set(cx + y, cy + x, c);
    if (cx - y >= 0 && cx - y < X68_SCREEN_W && cy + x >= 0 && cy + x < X68_SCREEN_H) bb_set(cx - y, cy + x, c);
    if (cx + y >= 0 && cx + y < X68_SCREEN_W && cy - x >= 0 && cy - x < X68_SCREEN_H) bb_set(cx + y, cy - x, c);
    if (cx - y >= 0 && cx - y < X68_SCREEN_W && cy - x >= 0 && cy - x < X68_SCREEN_H) bb_set(cx - y, cy - x, c);
}

void x68_circle(int x, int y, int r, int color) {
    if (!screen_opened) return;
    if (r <= 0) return;
    unsigned short c = (unsigned short)color;

    /* 教科書的な整数演算のみのミッドポイント円描画(Bresenham circle)。
     * verify/verify_l1.mts のTS側実装と1画素単位で一致させるため、変数の
     * 更新順まで完全に同じ式にしてある(host側モデルとの照合が全画素一致に
     * なる必要があるため)。 */
    int cx = 0, cy = r, d = 3 - 2 * r;
    while (cx <= cy) {
        circle_plot8(x, y, cx, cy, c);
        if (d < 0) {
            d += 4 * cx + 6;
        } else {
            d += 4 * (cx - cy) + 10;
            cy--;
        }
        cx++;
    }

    int bx0 = x - r, bx1 = x + r + 1;
    int by0 = y - r, by1 = y + r + 1;
    rectlist_add(&curRects, bx0, by0, bx1, by1);
}

static int clampi(int v, int lo, int hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

int x68_rgb(int r, int g, int b) {
    r = clampi(r, 0, 255);
    g = clampi(g, 0, 255);
    b = clampi(b, 0, 255);
    unsigned int r5 = ((unsigned int)r >> 3) & 0x1fU;
    unsigned int g5 = ((unsigned int)g >> 3) & 0x1fU;
    unsigned int b5 = ((unsigned int)b >> 3) & 0x1fU;
    /* G5 R5 B5 I1(docs/lib実装_20260819.md decode16to24コメント参照)。
     * Iビットは常に1(最大輝度)。 */
    return (int)((g5 << 11) | (r5 << 6) | (b5 << 1) | 1U);
}

void x68_screen_flip(void) {
    if (!screen_opened) return;

    /* 表の挙動欄(docs/API設計_20260819.md)の記述順どおり、まず垂直同期を
     * 待ってから転送する。 */
    x68_vsync_wait();

    unsigned long bytes = 0;
    if (force_full) {
        X68Rect full = {0, 0, X68_SCREEN_W, X68_SCREEN_H};
        bytes = transfer_rect(&full);
        force_full = 0;
    } else {
#ifndef X68_FAULT_L1_SKIP_PREV
        bytes += transfer_list(&prevRects);
#endif
        bytes += transfer_list(&curRects);
    }
    x68_l1_last_flip_bytes = bytes;

    prevRects = curRects;
    rectlist_reset(&curRects);
}
