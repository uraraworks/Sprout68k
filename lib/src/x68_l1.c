/* Sprout68k L1(学習層): 65536色1ページ + 描画命令の差分転送(docs/API設計_20260819.md
 * 「画面モード」節、docs/L1実装_20260819.md)。
 *
 * 裏バッファ(512x512x2=512KBのメインメモリ)に描画し、x68_screen_flip() で
 * GVRAMへ転送する。裏バッファの組み立て方(cls の塗り戻し→全描画)は変えて
 * いない。**転送対象の選び方だけを2026-08-20に変更した**:
 *
 *   旧方式(矩形追跡): 「描画命令が触った領域」を転送した。同じ場所に
 *     同じ内容を毎フレーム描き直すだけでも、触った以上は毎回転送されて
 *     いた。ブロック崩し作例(docs/作例breakout_20260819.md)で、毎フレーム
 *     全ブロックを再描画する実装が転送予算を大幅に超過したことでこの弱点が
 *     発覚した。
 *   新方式(差分転送): 「描画命令の一覧」をフレームごとに記録し、前フレームと
 *     今フレームで**添字ごとに命令を突き合わせる**。裏バッファは毎フレーム
 *     同じ手順で組み立て直されるので、命令が前フレームと同一なら内容も同一、
 *     という前提に立てる。異なる命令だけを転送すれば、静止した物を毎フレーム
 *     描き直しても転送は起きない。
 *
 * ビルド時に以下のマクロを定義すると、検証用に意図的に壊した版を作れる
 * (故障注入。tools/build_l1_test.sh の fault 引数が渡す。通常ビルドでは
 * 一切定義されない。詳細はdocs/L1実装_20260819.mdの故障注入の節):
 *   X68_FAULT_L1_SKIP_PREV              変わった命令の「前フレーム側」矩形を転送しない
 *   X68_FAULT_L1_SHRINK_RECT            矩形リストへ記録する矩形を1px小さくする
 *   X68_FAULT_L1_CLS_NO_FILL            clsが前フレーム矩形を裏バッファへ塗り戻さない
 *   X68_FAULT_L1_CLS_NO_FULL_REPAINT    背景色が変わっても全画面塗り直しをしない
 *   X68_FAULT_L1_NO_CLIP                クリップをしない(画面外書き込みが隣の行へ回り込む)
 *   X68_FAULT_L1_DIFF_IGNORE_SHRINK     命令数が減った場合(消えた命令)を差分に含めない
 *   X68_FAULT_L1_DIFF_COLOR_BLIND       色だけ違う命令を「同一」と誤判定する
 *   X68_FAULT_L1_DIFF_NO_OVERFLOW_FALLBACK 一覧が溢れても全画面フォールバックしない
 */
#include "x68.h"

/* void x68_panic_install(void); lib/asm/x68_panic.S + lib/src/x68_panic.c。
 * 設計原則3「暴走は静かに固まるのではなく、見える形で止まる」の入口。
 * 公開ヘッダには置かず、x68_screen_open()の内部実装としてだけ呼ぶ
 * (docs/パニック画面_20260820.md参照)。 */
extern void x68_panic_install(void);

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

/* 描画命令の種別。差分判定(前フレームと同一命令か)のための識別子。 */
#define X68_CMD_PSET   0
#define X68_CMD_RECT   1 /* box_fill、および box の4辺それぞれ */
#define X68_CMD_LINE   2
#define X68_CMD_CIRCLE 3

typedef struct {
    X68Rect rect; /* クリップ済みの外接矩形(GVRAM転送・裏バッファ塗り戻しに使う) */
    int type;
    int p0, p1, p2, p3; /* クリップ前の生の引数(座標・サイズ)。命令の同一性判定に使う。
                            pset: p0=x,p1=y / rect: p0=x,p1=y,p2=w,p3=h /
                            line: p0=x1,p1=y1,p2=x2,p3=y2 / circle: p0=x,p1=y,p2=r */
    int color;
} X68Cmd;

#define X68_L1_MAX_RECTS 64

typedef struct {
    int count;      /* cmds[] の有効な個数(overflowedなら差分判定には使えない) */
    int overflowed; /* 1なら cmds[] は不完全(bboxだけが唯一の矩形として有効) */
    int has_bbox;   /* このフレームで一度でもaddされたか */
    X68Rect bbox;
    X68Cmd cmds[X68_L1_MAX_RECTS];
} X68CmdList;

static int screen_opened = 0;
static int bg_valid = 0;   /* x68_clsを一度でも呼んだか */
static int bg_color = 0;   /* 直前にx68_clsへ渡した色 */
static int force_full = 0; /* 次のflip()で全画面転送が要るか */

/* curCmds: 今フレームの描画プリミティブ(pset/box_fill/box/line/circle)が
 *   追加した命令の一覧(座標・種別・色を含む)。x68_cls自身の塗り戻しは
 *   ここへは追加しない(理由はdocs/L1実装_20260819.md「矩形リストが
 *   ポイズニングする罠」節、差分転送でも同じ理由でそのまま維持している)。
 * prevCmds: 直前のflip()の時点でのcurCmds(=前フレームの描画命令)。
 *   次のx68_clsが「塗り戻す範囲」として、x68_screen_flip()が「差分判定の
 *   比較相手」として、それぞれ参照する。 */
static X68CmdList curCmds;
static X68CmdList prevCmds;

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
 * 描画命令リスト
 * ============================================================ */

static void cmdlist_reset(X68CmdList *l) {
    l->count = 0;
    l->overflowed = 0;
    l->has_bbox = 0;
}

/* 描画命令を1件記録する。x0,y0,x1,y1はクリップ前の生の矩形
 * (pset/box_fillはそのまま、line/circleは外接矩形)。 */
static void cmd_add(X68CmdList *l, int type, int p0, int p1, int p2, int p3, int color,
                     int x0, int y0, int x1, int y1) {
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
            X68Cmd *c = &l->cmds[l->count++];
            c->rect = r;
            c->type = type;
            c->p0 = p0; c->p1 = p1; c->p2 = p2; c->p3 = p3;
            c->color = color;
        } else {
            /* 溢れた: 個別の命令一覧は諦め、既に更新済みのbboxだけを
             * 唯一の矩形とする(安全側に倒す)。差分判定はできなくなるため、
             * x68_screen_flip()側がこのフレームは全画面転送にフォール
             * バックする(下記「一覧が溢れた場合のフォールバック」参照)。 */
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

static void fill_cmdlist(const X68CmdList *l, unsigned short c) {
    if (!l->has_bbox) return;
    if (l->overflowed) {
        fill_rect(&l->bbox, c);
    } else {
        for (int i = 0; i < l->count; i++) fill_rect(&l->cmds[i].rect, c);
    }
}

/* 2件の命令が「同一」(=描く内容が変わっていない)かどうか。type・生の引数
 * (p0..p3)・クリップ後矩形が一致するかで見る。
 * X68_FAULT_L1_DIFF_COLOR_BLIND: 故障注入で色の比較を外す(色だけ変わった
 * 命令を誤って「同一」と判定させる)。 */
static int cmd_equal(const X68Cmd *a, const X68Cmd *b) {
    if (a->type != b->type) return 0;
    if (a->p0 != b->p0 || a->p1 != b->p1 || a->p2 != b->p2 || a->p3 != b->p3) return 0;
    if (a->rect.x0 != b->rect.x0 || a->rect.y0 != b->rect.y0 ||
        a->rect.x1 != b->rect.x1 || a->rect.y1 != b->rect.y1) return 0;
#ifndef X68_FAULT_L1_DIFF_COLOR_BLIND
    if (a->color != b->color) return 0;
#endif
    return 1;
}

/* ============================================================
 * 公開API
 * ============================================================ */

void x68_screen_open(void) {
    /* キーのmake/breakはMFP割り込み経由でIOCS内部状態(BITSNS)へ反映される。
     * 起動直後の割り込みマスクは不明(boot.S/crt0.Sのどちらも変更していない)
     * ため、ここで明示的に解除しておく(Stage E-4実測で必須と判明した手順。
     * docs/StageE-4_実測_20260819.md、stage_e/src/main_e4.cと同じ)。これが
     * 無いとx68_key_down()が常に偽を返す。x68_screen_open()は入門者が最初に
     * 必ず呼ぶ関数なので、ここに置けばサンプルコード側でアセンブラを書かずに
     * 済む(ブロック崩し作例実装中に発見。docs/作例breakout_20260819.md参照)。 */
    __asm__ volatile ("move.w #0x2000,%%sr" ::: "cc");

    /* 設計原則3: 例外ベクタを自前のパニック画面ハンドラへ差し替える
     * (docs/パニック画面_20260820.md)。入門者が最初に必ず呼ぶこの関数の
     * 中で行うことで、作例側でこれを呼ぶことを忘れられない。 */
    x68_panic_install();

    x68_gvram_mode_65536_1page();
    for (unsigned long i = 0; i < (unsigned long)X68_SCREEN_W * X68_SCREEN_H; i++) {
        x68_backbuffer[i] = 0;
    }
    cmdlist_reset(&curCmds);
    cmdlist_reset(&prevCmds);
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
        /* 全画面が背景色になった以上、前フレームの命令一覧が指していた
         * 「消すべき前景」はもう無い。次のx68_clsが誤って古い場所を
         * もう一度塗り戻さないよう空にしておく(この後の描画呼び出しが
         * curCmdsへ積み直す)。 */
        cmdlist_reset(&curCmds);
        cmdlist_reset(&prevCmds);
    } else {
#ifndef X68_FAULT_L1_CLS_NO_FILL
        fill_cmdlist(&prevCmds, c16);
#endif
        /* 塗り戻した範囲はcurCmdsへは足さない(旧実装と同じ理由。
         * docs/L1実装_20260819.md「矩形リストがポイズニングする罠」節)。 */
    }
    bg_color = color;
    bg_valid = 1;
}

void x68_pset(int x, int y, int color) {
    if (!screen_opened) return;
    X68Rect r;
    if (!clip_to_screen(x, y, x + 1, y + 1, &r)) return;
    fill_rect(&r, (unsigned short)color);
    cmd_add(&curCmds, X68_CMD_PSET, x, y, 0, 0, color, x, y, x + 1, y + 1);
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
    cmd_add(&curCmds, X68_CMD_RECT, x, y, w, h, color, x, y, x + w, y + h);
}

void x68_box(int x, int y, int w, int h, int color) {
    if (!screen_opened) return;
    if (w <= 0 || h <= 0) return;
    /* 太さ1ドットの4辺。それぞれx68_box_fillと同じ経路(クリップ・追跡)で描く。
     * w/hが1の場合は上下(または左右)の辺が重なるが、同じ内容を2回塗るだけで
     * 実害は無い。差分転送でも各辺は独立した命令として記録される。 */
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
     * (画素ごとにcmd_addすると溢れやすくなるため)。両端とも画面外なら
     * cmd_add自身が空とみなして何もしない。生の端点(x1,y1,x2,y2)を命令の
     * 同一性判定の引数として保持する。 */
    int bx0 = (x1 < x2) ? x1 : x2;
    int bx1 = ((x1 > x2) ? x1 : x2) + 1;
    int by0 = (y1 < y2) ? y1 : y2;
    int by1 = ((y1 > y2) ? y1 : y2) + 1;
    cmd_add(&curCmds, X68_CMD_LINE, x1, y1, x2, y2, color, bx0, by0, bx1, by1);
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
    cmd_add(&curCmds, X68_CMD_CIRCLE, x, y, r, 0, color, bx0, by0, bx1, by1);
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

/* docs/API設計_20260819.md「文字」節の公開名。x68_iocs_locate(L0、実測済み。
 * lib実装_20260819.mdで実装済み)の薄いラッパ。範囲外座標はハードウェア側が
 * 無視するため追加のクリップはしない(Stage E-6実測)。 */
void x68_locate(int col, int row) {
    x68_iocs_locate(col, row);
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
    } else if (curCmds.overflowed || prevCmds.overflowed) {
        /* 一覧が溢れた場合のフォールバック: 前後どちらかの命令一覧が不完全
         * だと添字ごとの突き合わせができない(安全に「消えた」「変わった」を
         * 判定できない)。安全側(全画面転送)に倒す。
         * X68_FAULT_L1_DIFF_NO_OVERFLOW_FALLBACK: 故障注入でこの
         * フォールバックを無効化する(溢れても差分すら取らず何も送らない
         * ため、必ず消し残りが起きる)。 */
#ifdef X68_FAULT_L1_DIFF_NO_OVERFLOW_FALLBACK
        bytes = 0;
#else
        X68Rect full = {0, 0, X68_SCREEN_W, X68_SCREEN_H};
        bytes = transfer_rect(&full);
#endif
    } else {
        /* 差分転送: 前フレームと今フレームの描画命令一覧を添字ごとに
         * 突き合わせる。裏バッファは毎フレーム同じ手順(cls塗り戻し→
         * 全描画)で組み立て直されるため、命令が同一なら内容も同一である
         * (docs/L1実装_20260819.md参照)。 */
        int nPrev = prevCmds.count, nCur = curCmds.count;
        int n = (nPrev > nCur) ? nPrev : nCur;
        for (int i = 0; i < n; i++) {
            int hasPrev = i < nPrev, hasCur = i < nCur;
            if (hasPrev && hasCur) {
                const X68Cmd *p = &prevCmds.cmds[i];
                const X68Cmd *c = &curCmds.cmds[i];
                if (!cmd_equal(p, c)) {
                    /* 命令が変わった: 前フレーム側(消す)・今フレーム側(描く)
                     * 両方の矩形を送る。重なっていても、両方送れば内容は
                     * 必ず正しくなる(過剰に送る方に倒す。足りない方に倒すと
                     * 消し残りになる)。
                     * X68_FAULT_L1_SKIP_PREV: 故障注入で前フレーム側を
                     * 省く(旧「矩形追跡」時代のskip_prevと同じ観測結果=
                     * 移動前の位置が消し残る、を再現する)。 */
#ifndef X68_FAULT_L1_SKIP_PREV
                    bytes += transfer_rect(&p->rect);
#endif
                    bytes += transfer_rect(&c->rect);
                }
                /* 同一なら何も送らない(=差分転送の核心)。 */
            } else if (hasCur) {
                /* 今フレームで新たに増えた命令。 */
                bytes += transfer_rect(&curCmds.cmds[i].rect);
            } else {
                /* 前フレームにはあったが今フレームで消えた命令。塗り戻しは
                 * x68_cls()がprevCmdsを参照して既に裏バッファへ反映済み
                 * だが、GVRAM側はまだ古い内容のままなので転送が要る。
                 * X68_FAULT_L1_DIFF_IGNORE_SHRINK: 故障注入でこの転送を
                 * 省く(消えたはずの物がGVRAM上に残り続ける)。 */
#ifndef X68_FAULT_L1_DIFF_IGNORE_SHRINK
                bytes += transfer_rect(&prevCmds.cmds[i].rect);
#endif
            }
        }
    }
    x68_l1_last_flip_bytes = bytes;

    prevCmds = curCmds;
    cmdlist_reset(&curCmds);
}
