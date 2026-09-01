/* Sprout68k L1(学習層): 65536色1ページ + 描画命令の差分「描画」(docs/API設計_20260819.md
 * 「画面モード」節、docs/L1実装_20260819.md、docs/L1差分描画_20260901.md)。
 *
 * 2026-09-01: 描画コスト構造を「描画関数が即座に裏バッファへ画素を書く」方式から
 * 「描画関数は命令を記録するだけ、実際の画素は x68_screen_flip() まで遅らせる」
 * 方式へ作り替えた(docs/L1差分描画_20260901.md参照。以下、設計要点)。
 *
 *   x68_cls()      … 背景色を覚えるだけ。画素を触らない。
 *   pset/box_fill/box/line/circle … curCmds に命令を積むだけ。画素を触らない。
 *   x68_screen_flip():
 *     1. 突き合わせ: curCmds と prevCmds の各命令が同一かを判定する。
 *        添字で先に照合(速い道) → 残った未確定のものだけ総当たり(内容一致)。
 *        未確定数 m が64を超えたら突き合わせを諦める(2へ)。
 *     2. dirty矩形の決定: 「消えた」「増えた」「変わった」命令の前後両方の
 *        矩形をdirtyに積む。背景色が変わった・初回・一覧が溢れた場合は
 *        本当に全画面1枚が要るので全画面にする。それ以外の理由で突き合わせが
 *        まとまらなかった場合(未確定数超過、またはdirty矩形が32枚を超えた)は、
 *        全画面ではなく**旧実装と同じ再塗り**に畳む(2026-09-01実測: 動く物が
 *        多い場面で全画面に畳むと畳む前より高くつくため。
 *        docs/L1差分描画_20260901.md「追記2」節)。
 *     3. 再生:
 *        - 通常(dirty矩形が少数確定した場合): 各dirty矩形を背景色で塗り、
 *          そのあと curCmds を**順番どおり**に**そのdirty矩形へクリップして**
 *          描き直す(クリップせず再生すると重なりの前後関係が壊れる)。
 *          exec_cmd_clipped を呼ぶ前に、dirty全体の外接矩形との交差を
 *          インラインの整数比較で先に見て大半の命令を捨てる(関数呼び出しを
 *          伴わない。docs/L1差分描画_20260901.md「追記2」節)。
 *        - 旧実装と同じ再塗りに畳んだ場合: prevCmds の各命令の矩形を背景色で
 *          塗り戻し、そのあと curCmds を順番どおり・クリップせず描き直す。
 *          突き合わせで不一致だった命令についてだけ、前後の矩形を転送する。
 *        - 全画面: 画面全体を背景色で塗り、curCmds を全画面へ描き直す。
 *     4. 転送: dirty矩形(または再塗りで不一致だった矩形)をGVRAMへ送る。
 *     5. prevCmds = curCmds。
 *
 * 静止している物は突き合わせで確定し、dirtyに入らないので画素も転送も
 * 発生しない(旧方式は「触った命令」を毎フレーム塗り戻し→描き直ししていたため、
 * 静止物でも画素コストがかかっていた)。
 *
 * x68_pget は裏バッファが flip まで最新でないため、backbuffer_valid フラグを
 * 持ち、無効なら(背景色 + curCmds を画面全体に再生する形で)その場で
 * 一度だけ作り直してから読む。次の描画呼び出しで無効に戻る。
 *
 * ビルド時に以下のマクロを定義すると、検証用に意図的に壊した版を作れる
 * (故障注入。tools/build_l1_test.sh の fault 引数が渡す。通常ビルドでは
 * 一切定義されない。詳細はdocs/L1差分描画_20260901.mdの検証の節):
 *   X68_FAULT_L1_SKIP_PREV              未確定と判定された前フレーム側の矩形をdirtyに積まない
 *   X68_FAULT_L1_SHRINK_RECT            矩形リストへ記録する矩形を1px小さくする
 *   X68_FAULT_L1_CLS_NO_FILL            dirty矩形を背景色で塗らずに再生する
 *   X68_FAULT_L1_CLS_NO_FULL_REPAINT    背景色が変わっても全画面塗り直しをしない
 *   X68_FAULT_L1_NO_CLIP                クリップを一切しない(記録時の画面クリップ・
 *                                        再生時のdirty矩形クリップの両方が消える。
 *                                        画面外書き込みが隣の行へ回り込む/
 *                                        クリップせず再生して重なりが壊れる)
 *   X68_FAULT_L1_DIFF_IGNORE_SHRINK     未確定と判定された前フレーム側の矩形をdirtyに積まない
 *                                        (SKIP_PREVと新方式では同じ効果になる。
 *                                        docs/L1差分描画_20260901.md参照)
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
    int x0, y0, x1, y1; /* 半開区間 [x0,x1) x [y0,y1)。 */
} X68Rect;

/* 描画命令の種別。差分判定(前フレームと同一命令か)のための識別子。 */
#define X68_CMD_PSET   0
#define X68_CMD_RECT   1 /* box_fill、および box の4辺それぞれ */
#define X68_CMD_LINE   2
#define X68_CMD_CIRCLE 3

/* X68Cmd用の小さい矩形型。記録時点でクリップ済み(画面0〜512の範囲に収まる)
 * ので short で足りる。X68Rect(dirty矩形・clip_to_rect等の汎用矩形)は他の
 * 場所でも使うため int のまま変えず、X68Cmd の中だけこの型にする
 * (2026-09-01: X68Cmd 1件あたりのサイズを削って複写・受け渡しの固定費を
 * 減らすため。docs/L1差分描画_20260901.md参照)。 */
typedef struct {
    short x0, y0, x1, y1;
} X68CmdRect;

static X68Rect cmdrect_to_rect(const X68CmdRect *r) {
    X68Rect out;
    out.x0 = r->x0; out.y0 = r->y0; out.x1 = r->x1; out.y1 = r->y1;
    return out;
}

static void rect_to_cmdrect(X68CmdRect *dst, const X68Rect *src) {
    dst->x0 = (short)src->x0; dst->y0 = (short)src->y0;
    dst->x1 = (short)src->x1; dst->y1 = (short)src->y1;
}

typedef struct {
    X68CmdRect rect; /* 記録時点でクリップ済みの外接矩形(dirty判定・転送に使う) */
    short type;
    int p0, p1, p2, p3; /* クリップ前の生の引数(座標・サイズ)。命令の同一性判定、
                            および再生時のline/circleの実描画に使う。値域は画面外の
                            大きな座標も含みうるため int のまま変えない(short に
                            詰めると別々のline/circleが「同じ命令」に化けて差分
                            判定を誤る)。
                            pset: p0=x,p1=y / rect: p0=x,p1=y,p2=w,p3=h /
                            line: p0=x1,p1=y1,p2=x2,p3=y2 / circle: p0=x,p1=y,p2=r */
    unsigned short color;
} X68Cmd;

/* 上限は512(元は64)。同梱作例ide/samples/stars.c(星220個)・life.c(生きたマス数百個)は
 * 64件では毎フレーム溢れてoverflowed=1に落ち、全画面転送(512KB)にフォールバックして
 * いた。上限はbss(裏バッファ512KB他)とスタック(STACK_ADDR)の間の空きで決まる。
 * この空きは tools/build_l1_test.sh の __bss_end 検査がビルド時に守っている。 */
#define X68_L1_MAX_RECTS 512

typedef struct {
    int count;      /* cmds[] の有効な個数(overflowedなら差分判定には使えない) */
    int overflowed; /* 1なら cmds[] は不完全(bboxだけが唯一の矩形として有効) */
    int has_bbox;   /* このフレームで一度でもaddされたか */
    X68Rect bbox;
    X68Cmd cmds[X68_L1_MAX_RECTS];
} X68CmdList;

/* dirty矩形の上限。超えたら突き合わせを諦める(matchGaveUp。
 * docs/L1差分描画_20260901.md「dirty矩形の数の上限」「追記2」節)。 */
#define X68_L1_MAX_DIRTY 32

/* 突き合わせの総当たり段(フェーズ2)を諦める(matchGaveUp)未確定数の上限
 * (docs/L1差分描画_20260901.md「突き合わせは『添字』ではなく『内容』で」節)。 */
#define X68_L1_MAX_UNMATCHED 64

static int screen_opened = 0;
static int bg_valid = 0;   /* x68_clsを一度でも呼んだか */
static int bg_color = 0;   /* 直前にx68_clsへ渡した色 */
static int force_full = 0; /* 次のflip()で全画面dirtyが要るか */

/* フレームの流儀(docs/L1差分描画_20260901.md「追記(2026-09-01)」節)。
 * そのフレームで x68_cls() を呼んだかどうかだけで判定する:
 *   X68_STYLE_CLS    … x68_cls()を呼んだ。再構築フレーム(本体の設計どおり)。
 *   X68_STYLE_APPEND … 呼んでいない(x68_frame_begin()を使う、または何も
 *                       呼ばない)。追記フレーム。裏バッファが画面の正で、
 *                       描画命令はその場で裏バッファへ描き、矩形をそのまま
 *                       dirtyへ積む(突き合わせ・「消えた命令の消去」は無い)。
 * 前フレームと流儀が変わった場合、および同一フレーム内で両方呼ばれた場合は
 * 安全側に倒して全画面dirtyにする。 */
#define X68_STYLE_NONE   0
#define X68_STYLE_CLS    1
#define X68_STYLE_APPEND 2
static int frame_style = X68_STYLE_NONE;      /* 今フレームで確定した流儀 */
static int prev_frame_style = X68_STYLE_NONE; /* 前フレームの流儀 */
static int style_conflict = 0;                /* 同一フレーム内でcls/frame_beginの両方が呼ばれた */
static int append_overflow = 0;               /* 追記フレームでdirty矩形が32枚を超えた */

/* 裏バッファがflip()時点(またはpget用の作り直し)から見て最新かどうか。
 * 描画呼び出し(cmd_addを通るもの)で無効になり、flip()または
 * rebuild_backbuffer_now()で作り直された時点で有効に戻る。 */
static int backbuffer_valid = 1;

/* curCmds: 今フレームの描画プリミティブ(pset/box_fill/box/line/circle)が
 *   追加した命令の一覧(座標・種別・色を含む)。x68_cls自身はここへは
 *   何も追加しない(画素を触らないのと同じ理由。x68_cls は背景色を
 *   覚えるだけ)。
 * prevCmds: 直前のflip()の時点でのcurCmds(=前フレームの描画命令)。
 *   x68_screen_flip()が突き合わせの相手として参照する。
 *
 * 実体は2本(cmdListStorage[0], [1])を静的に持ち、curCmds/prevCmdsは
 * そのどちらかを指すポインタにする。毎フレームの入れ替えは
 * x68_screen_flip()末尾でポインタを交換するだけにし、内容の複写(旧
 * cmdlist_copy)を無くす(2026-09-01: 描画命令1件あたり約3,250サイクルの
 * 固定費の主因が複写だったため。docs/L1差分描画_20260901.md参照)。 */
static X68CmdList cmdListStorage[2];
static X68CmdList *curCmds = &cmdListStorage[0];
static X68CmdList *prevCmds = &cmdListStorage[1];

/* dirty矩形の一覧(x68_screen_flip()の中だけで使う作業領域)。 */
static X68Rect dirtyRects[X68_L1_MAX_DIRTY];
static int dirtyCount;

/* 突き合わせの作業領域(x68_screen_flip()の中だけで使う)。 */
static unsigned char curMatched[X68_L1_MAX_RECTS];
static unsigned char prevMatched[X68_L1_MAX_RECTS];

/* ============================================================
 * 矩形クリップ・裏バッファへの読み書き
 * ============================================================ */

/* boundの範囲へクリップする(半開区間)。X68_FAULT_L1_NO_CLIP を定義すると
 * 範囲チェックを一切しない。記録時の画面クリップ(bound=画面全体)にも、
 * 再生時のdirty矩形クリップ(bound=dirty矩形)にも同じ関数を使うため、
 * この1つのフォールト定義で両方が同時に壊れる(docs/L1差分描画_20260901.md
 * 「クリップして再生する理由」節が要求する故障注入と一致させるため)。 */
static int clip_to_rect(int x0, int y0, int x1, int y1, const X68Rect *bound, X68Rect *out) {
#ifdef X68_FAULT_L1_NO_CLIP
    out->x0 = x0; out->y0 = y0; out->x1 = x1; out->y1 = y1;
    return (x1 > x0 && y1 > y0);
#else
    if (x0 < bound->x0) x0 = bound->x0;
    if (y0 < bound->y0) y0 = bound->y0;
    if (x1 > bound->x1) x1 = bound->x1;
    if (y1 > bound->y1) y1 = bound->y1;
    if (x1 <= x0 || y1 <= y0) return 0;
    out->x0 = x0; out->y0 = y0; out->x1 = x1; out->y1 = y1;
    return 1;
#endif
}

static int clip_to_screen(int x0, int y0, int x1, int y1, X68Rect *out) {
    X68Rect screen = {0, 0, X68_SCREEN_W, X68_SCREEN_H};
    return clip_to_rect(x0, y0, x1, y1, &screen, out);
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

/* 矩形を塗る。1画素ずつ書くと1画素あたり約66サイクルかかる(実測)ため、
 * 32bit単位でまとめて書き、8個ずつ展開する。裏バッファの行頭は必ず偶数番地
 * (x68_backbufferがワード配列で、1行=512ワード=1024バイト)なので、long
 * アクセスのアラインメントは常に満たされる。 */
static void fill_rect(const X68Rect *r, unsigned short c) {
    int w = r->x1 - r->x0;
    unsigned long cc = ((unsigned long)c << 16) | (unsigned long)c;
    for (int y = r->y0; y < r->y1; y++) {
        unsigned short *p = &x68_backbuffer[(long)y * X68_SCREEN_W + r->x0];
        unsigned long *q = (unsigned long *)p;
        int m = w >> 1;
        while (m >= 8) { q[0]=cc; q[1]=cc; q[2]=cc; q[3]=cc; q[4]=cc; q[5]=cc; q[6]=cc; q[7]=cc; q += 8; m -= 8; }
        while (m-- > 0) *q++ = cc;
        if (w & 1) *(unsigned short *)q = c;
    }
}

/* boundの範囲内かどうか。X68_FAULT_L1_NO_CLIP時は常に真を返す(line/circleの
 * 再生時クリップを無効化する。画面自体のはみ出しチェックは下のline/circle側で
 * 別途常に行う。旧実装がline/circleの画面外書き込みをX68_FAULT_L1_NO_CLIPとは
 * 無関係に常時ガードしていたのと同じにする)。 */
static int in_rect(int x, int y, const X68Rect *bound) {
#ifdef X68_FAULT_L1_NO_CLIP
    (void)bound;
    return 1;
#else
    return x >= bound->x0 && x < bound->x1 && y >= bound->y0 && y < bound->y1;
#endif
}

/* ============================================================
 * 描画命令リスト
 * ============================================================ */

static void cmdlist_reset(X68CmdList *l) {
    l->count = 0;
    l->overflowed = 0;
    l->has_bbox = 0;
}

/* cmd_add()より後ろで定義されているが、追記フレームの経路で必要になる
 * ため前方宣言しておく。 */
static void exec_cmd_clipped(const X68Cmd *c, const X68Rect *bound);
static int dirty_add(const X68Rect *r);

/* 描画命令を1件処理する。x0,y0,x1,y1はクリップ前の生の矩形
 * (pset/box_fillはそのまま、line/circleは外接矩形)。
 *
 * CLS方式(frame_style==X68_STYLE_CLS)では画素は一切触らず、curCmdsへ記録
 * するだけ(実際の描画はx68_screen_flip()まで遅延する)。
 * 追記方式(frame_style==X68_STYLE_APPEND)では、その場で裏バッファへ描き、
 * 矩形をそのままdirtyへ積む(docs/L1差分描画_20260901.md「追記(2026-09-01)」節)。 */
static void cmd_add(X68CmdList *l, int type, int p0, int p1, int p2, int p3, int color,
                     int x0, int y0, int x1, int y1) {
    if (frame_style == X68_STYLE_NONE) frame_style = X68_STYLE_APPEND; /* 何も呼ばずいきなり描いた場合は追記フレーム扱い */

#ifdef X68_FAULT_L1_SHRINK_RECT
    /* 故障注入: 記録する矩形を1px小さくする(右端・下端が転送・再生されず欠ける) */
    x1 -= 1;
    y1 -= 1;
#endif
    X68Rect r;
    if (!clip_to_screen(x0, y0, x1, y1, &r)) return;

    if (frame_style == X68_STYLE_APPEND) {
        /* 追記フレーム: 突き合わせも「消えた命令の消去」も行わない。裏バッファは
         * 常に最新なので backbuffer_valid は立てたままにする(x68_pgetがその場での
         * 作り直しを不要にできる)。 */
        X68Cmd tmp;
        rect_to_cmdrect(&tmp.rect, &r); tmp.type = (short)type;
        tmp.p0 = p0; tmp.p1 = p1; tmp.p2 = p2; tmp.p3 = p3;
        tmp.color = (unsigned short)color;
        exec_cmd_clipped(&tmp, &r);
        if (!dirty_add(&r)) append_overflow = 1;
        backbuffer_valid = 1;
        return;
    }

    backbuffer_valid = 0; /* CLS方式: 次のx68_pgetでその場での作り直しが要る */

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
            rect_to_cmdrect(&c->rect, &r);
            c->type = (short)type;
            c->p0 = p0; c->p1 = p1; c->p2 = p2; c->p3 = p3;
            c->color = (unsigned short)color;
        } else {
            /* 溢れた: 個別の命令一覧は諦め、既に更新済みのbboxだけを
             * 唯一の矩形とする(安全側に倒す)。差分判定はできなくなるため、
             * x68_screen_flip()側がこのフレームは全画面dirtyにフォール
             * バックする。 */
            l->overflowed = 1;
        }
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
 * 命令の実描画(x68_screen_flip()の再生段、およびx68_pget用の作り直しで使う)
 * ============================================================ */

static void draw_line_clipped(int x1i, int y1i, int x2i, int y2i, unsigned short c, const X68Rect *bound) {
    int dx = x2i - x1i; if (dx < 0) dx = -dx;
    int sx = (x1i < x2i) ? 1 : -1;
    int dy = y2i - y1i; if (dy > 0) dy = -dy; /* dyは<=0で保持(標準的なBresenham) */
    int sy = (y1i < y2i) ? 1 : -1;
    int err = dx + dy;

    int cx = x1i, cy = y1i;
    for (;;) {
        if (cx >= 0 && cx < X68_SCREEN_W && cy >= 0 && cy < X68_SCREEN_H && in_rect(cx, cy, bound)) {
            bb_set(cx, cy, c);
        }
        if (cx == x2i && cy == y2i) break;
        int e2 = 2 * err;
        if (e2 >= dy) { err += dy; cx += sx; }
        if (e2 <= dx) { err += dx; cy += sy; }
    }
}

static void circle_plot8_clipped(int cx, int cy, int x, int y, unsigned short c, const X68Rect *bound) {
    if (cx + x >= 0 && cx + x < X68_SCREEN_W && cy + y >= 0 && cy + y < X68_SCREEN_H && in_rect(cx + x, cy + y, bound)) bb_set(cx + x, cy + y, c);
    if (cx - x >= 0 && cx - x < X68_SCREEN_W && cy + y >= 0 && cy + y < X68_SCREEN_H && in_rect(cx - x, cy + y, bound)) bb_set(cx - x, cy + y, c);
    if (cx + x >= 0 && cx + x < X68_SCREEN_W && cy - y >= 0 && cy - y < X68_SCREEN_H && in_rect(cx + x, cy - y, bound)) bb_set(cx + x, cy - y, c);
    if (cx - x >= 0 && cx - x < X68_SCREEN_W && cy - y >= 0 && cy - y < X68_SCREEN_H && in_rect(cx - x, cy - y, bound)) bb_set(cx - x, cy - y, c);
    if (cx + y >= 0 && cx + y < X68_SCREEN_W && cy + x >= 0 && cy + x < X68_SCREEN_H && in_rect(cx + y, cy + x, bound)) bb_set(cx + y, cy + x, c);
    if (cx - y >= 0 && cx - y < X68_SCREEN_W && cy + x >= 0 && cy + x < X68_SCREEN_H && in_rect(cx - y, cy + x, bound)) bb_set(cx - y, cy + x, c);
    if (cx + y >= 0 && cx + y < X68_SCREEN_W && cy - x >= 0 && cy - x < X68_SCREEN_H && in_rect(cx + y, cy - x, bound)) bb_set(cx + y, cy - x, c);
    if (cx - y >= 0 && cx - y < X68_SCREEN_W && cy - x >= 0 && cy - x < X68_SCREEN_H && in_rect(cx - y, cy - x, bound)) bb_set(cx - y, cy - x, c);
}

/* 命令1件を、boundへクリップして裏バッファへ実際に描く。pset/box_fill(box)は
 * 矩形塗り、line/circleは教科書的な整数演算のみの式(verify/verify_l1.mtsの
 * host側モデルと1画素単位で一致させるため、記録時と同じ式をそのまま使う)。 */
static void exec_cmd_clipped(const X68Cmd *c, const X68Rect *bound) {
    unsigned short col = (unsigned short)c->color;
    switch (c->type) {
        case X68_CMD_PSET:
        case X68_CMD_RECT: {
            X68Rect r;
            if (!clip_to_rect(c->rect.x0, c->rect.y0, c->rect.x1, c->rect.y1, bound, &r)) return;
            fill_rect(&r, col);
            break;
        }
        case X68_CMD_LINE:
            draw_line_clipped(c->p0, c->p1, c->p2, c->p3, col, bound);
            break;
        case X68_CMD_CIRCLE: {
            int cx = 0, cy = c->p2, d = 3 - 2 * c->p2;
            while (cx <= cy) {
                circle_plot8_clipped(c->p0, c->p1, cx, cy, col, bound);
                if (d < 0) {
                    d += 4 * cx + 6;
                } else {
                    d += 4 * (cx - cy) + 10;
                    cy--;
                }
                cx++;
            }
            break;
        }
        default:
            break;
    }
}

/* x68_pget用: 裏バッファ全体を「背景色 → curCmds を順番どおりに全画面へ再生」
 * で作り直す(dirty矩形の最適化はしない。pgetは頻繁な呼び出しを想定しない
 * 経路のため。docs/L1差分描画_20260901.md「x68_pgetの扱い」節)。 */
static void rebuild_backbuffer_now(void) {
    X68Rect full = {0, 0, X68_SCREEN_W, X68_SCREEN_H};
    fill_rect(&full, (unsigned short)bg_color);
    for (int i = 0; i < curCmds->count; i++) exec_cmd_clipped(&curCmds->cmds[i], &full);
    backbuffer_valid = 1;
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

/* ============================================================
 * dirty矩形の一覧
 * ============================================================ */

static void dirty_reset(void) { dirtyCount = 0; }

/* dirty矩形を1件積む。空矩形は無視(常に成功扱い)。上限(32)を超えたら
 * 失敗を返す(呼び出し側build_dirty_rects()がmatchGaveUpとして扱い、
 * 旧実装と同じ再塗りに畳む。docs/L1差分描画_20260901.md「追記2」節)。 */
static int dirty_add(const X68Rect *r) {
    if (r->x1 <= r->x0 || r->y1 <= r->y0) return 1;
    if (dirtyCount >= X68_L1_MAX_DIRTY) return 0;
    dirtyRects[dirtyCount++] = *r;
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
    cmdlist_reset(curCmds);
    cmdlist_reset(prevCmds);
    bg_valid = 0;
    bg_color = 0;
    backbuffer_valid = 1; /* 0クリア直後の裏バッファは(空のcurCmdsに対して)正しい */
    /* GVRAMの初期内容は不定なので、x68_clsを呼んでいなくても最初の
     * flip()は裏バッファ全体を転送する。 */
    force_full = 1;
    frame_style = X68_STYLE_NONE;
    prev_frame_style = X68_STYLE_NONE;
    style_conflict = 0;
    append_overflow = 0;
    dirty_reset();
    screen_opened = 1;
}

void x68_cls(int color) {
    if (!screen_opened) return;

    /* 流儀の判定: このフレームで既に追記方式が確定していたら衝突
     * (docs/L1差分描画_20260901.md「追記(2026-09-01)」節)。cls方式に
     * 確定させる(以後このフレームの描画命令はcurCmdsへ記録するだけになる)。 */
    if (frame_style == X68_STYLE_APPEND) style_conflict = 1;
    frame_style = X68_STYLE_CLS;

    /* 画素は一切触らない。背景色を覚え、必要なら次のflip()を全画面dirtyに
     * するフラグを立てるだけ(docs/L1差分描画_20260901.md「変更後の流れ」節)。 */
#ifdef X68_FAULT_L1_CLS_NO_FULL_REPAINT
    int need_full = 0; /* 故障注入: 背景色が変わっても検知しない */
#else
    int need_full = (!bg_valid) || (color != bg_color);
#endif
    if (need_full) force_full = 1;

    bg_color = color;
    bg_valid = 1;
}

void x68_frame_begin(void) {
    if (!screen_opened) return;
    /* 流儀の判定: このフレームで既にcls方式が確定していたら衝突。
     * 追記方式に確定させる。 */
    if (frame_style == X68_STYLE_CLS) style_conflict = 1;
    frame_style = X68_STYLE_APPEND;
    cmdlist_reset(curCmds);
}

void x68_pset(int x, int y, int color) {
    if (!screen_opened) return;
    cmd_add(curCmds, X68_CMD_PSET, x, y, 0, 0, color, x, y, x + 1, y + 1);
}

int x68_pget(int x, int y) {
    if (!screen_opened) return 0;
    if (x < 0 || x >= X68_SCREEN_W || y < 0 || y >= X68_SCREEN_H) return 0;
    if (!backbuffer_valid) rebuild_backbuffer_now();
    return (int)bb_get(x, y);
}

void x68_box_fill(int x, int y, int w, int h, int color) {
    if (!screen_opened) return;
    if (w <= 0 || h <= 0) return;
    cmd_add(curCmds, X68_CMD_RECT, x, y, w, h, color, x, y, x + w, y + h);
}

void x68_box(int x, int y, int w, int h, int color) {
    if (!screen_opened) return;
    if (w <= 0 || h <= 0) return;
    /* 太さ1ドットの4辺。それぞれx68_box_fillと同じ経路(クリップ・記録)で描く。
     * w/hが1の場合は上下(または左右)の辺が重なるが、同じ内容を2回記録するだけで
     * 実害は無い(再生時に同じ場所を同じ色で2回塗るだけ)。 */
    x68_box_fill(x, y, w, 1, color);              /* 上辺 */
    x68_box_fill(x, y + h - 1, w, 1, color);       /* 下辺 */
    x68_box_fill(x, y, 1, h, color);               /* 左辺 */
    x68_box_fill(x + w - 1, y, 1, h, color);        /* 右辺 */
}

void x68_line(int x1, int y1, int x2, int y2, int color) {
    if (!screen_opened) return;

    /* 実際に塗った画素の外接矩形(=両端点の外接矩形)を命令の矩形として記録する。
     * 生の端点(x1,y1,x2,y2)は命令の同一性判定・再生時の実描画の両方に使う。
     * 画素は一切ここでは触らない(再生はx68_screen_flip()まで遅延する)。 */
    int bx0 = (x1 < x2) ? x1 : x2;
    int bx1 = ((x1 > x2) ? x1 : x2) + 1;
    int by0 = (y1 < y2) ? y1 : y2;
    int by1 = ((y1 > y2) ? y1 : y2) + 1;
    cmd_add(curCmds, X68_CMD_LINE, x1, y1, x2, y2, color, bx0, by0, bx1, by1);
}

void x68_circle(int x, int y, int r, int color) {
    if (!screen_opened) return;
    if (r <= 0) return;

    int bx0 = x - r, bx1 = x + r + 1;
    int by0 = y - r, by1 = y + r + 1;
    cmd_add(curCmds, X68_CMD_CIRCLE, x, y, r, 0, color, bx0, by0, bx1, by1);
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

/* curCmds と prevCmds を突き合わせ、dirty矩形の一覧(dirtyRects/dirtyCount)を
 * 組み立てる。突き合わせを諦めるべき(matchGaveUp)と判断したら1を返す。
 * 呼び出し側(x68_screen_flip)はこれを「全画面」ではなく「旧実装と同じ
 * 再塗り」として扱う(誤り1の修正。docs/L1差分描画_20260901.md「追記2」節)。
 * 戻り値が0でも1でも、curMatched/prevMatchedはこの時点までの突き合わせ
 * 結果を保持している(1で返る場合はフェーズ1のみ、または本文の再塗りの
 * 転送段が使う完全な結果)。docs/L1差分描画_20260901.md
 * 「突き合わせは『添字』ではなく『内容』で」節のとおり2段構成。 */
static int build_dirty_rects(void) {
    int nCur = curCmds->count, nPrev = prevCmds->count;
    for (int i = 0; i < nCur; i++) curMatched[i] = 0;
    for (int j = 0; j < nPrev; j++) prevMatched[j] = 0;

    /* フェーズ1: 添字で先に照合(速い道)。挿入・削除の無いフレーム
     * (大多数)はここで終わる。 */
    int nMin = (nPrev < nCur) ? nPrev : nCur;
    for (int i = 0; i < nMin; i++) {
        if (cmd_equal(&prevCmds->cmds[i], &curCmds->cmds[i])) {
            curMatched[i] = 1;
            prevMatched[i] = 1;
        }
    }

    int nUCur = 0, nUPrev = 0;
    for (int i = 0; i < nCur; i++) if (!curMatched[i]) nUCur++;
    for (int j = 0; j < nPrev; j++) if (!prevMatched[j]) nUPrev++;

    if (nUCur + nUPrev > X68_L1_MAX_UNMATCHED) {
        /* 未確定数mが上限を超えた: 総当たりを諦める(matchGaveUp。
         * 費用を必ず有界にするため)。 */
        return 1;
    }

    /* フェーズ2: 残った未確定のものだけ総当たりで相手を探す(O(m^2))。
     * 内容が完全一致する相手が見つかれば、位置がずれていても(添字が
     * ずれていても)同一命令として確定する。 */
    for (int i = 0; i < nCur; i++) {
        if (curMatched[i]) continue;
        for (int j = 0; j < nPrev; j++) {
            if (prevMatched[j]) continue;
            if (cmd_equal(&prevCmds->cmds[j], &curCmds->cmds[i])) {
                curMatched[i] = 1;
                prevMatched[j] = 1;
                break;
            }
        }
    }

    /* 最後まで未確定だったものが「増えた/変わった」(cur側)・「消えた/変わった」
     * (prev側)命令。前後両方の矩形をdirtyに積む(過剰に送る方に倒す。
     * 足りない方に倒すと消し残りになる)。 */
    for (int i = 0; i < nCur; i++) {
        if (curMatched[i]) continue;
        X68Rect rr = cmdrect_to_rect(&curCmds->cmds[i].rect);
        if (!dirty_add(&rr)) return 1;
    }
    for (int j = 0; j < nPrev; j++) {
        if (prevMatched[j]) continue;
        /* X68_FAULT_L1_SKIP_PREV / X68_FAULT_L1_DIFF_IGNORE_SHRINK: 故障注入で
         * 前フレーム側(消えた/変わった命令の「消す」側)をdirtyへ積まない。
         * 新方式では「変わった」と「消えた」の区別が無くなった(内容突き合わせ
         * では両方とも「未確定のprev」でしかない)ため、この2つのマクロは同じ
         * 効果になる(docs/L1差分描画_20260901.md参照)。 */
#if !defined(X68_FAULT_L1_SKIP_PREV) && !defined(X68_FAULT_L1_DIFF_IGNORE_SHRINK)
        X68Rect rr = cmdrect_to_rect(&prevCmds->cmds[j].rect);
        if (!dirty_add(&rr)) return 1;
#endif
    }
    return 0;
}

void x68_screen_flip(void) {
    if (!screen_opened) return;

    /* 表の挙動欄(docs/API設計_20260819.md)の記述順どおり、まず垂直同期を
     * 待ってから転送する。 */
    x68_vsync_wait();

    unsigned short bgc = (unsigned short)bg_color;
    (void)bgc; /* X68_FAULT_L1_CLS_NO_FILL 版では未使用になる */
    unsigned long bytes = 0;

    /* このフレームの流儀。何も呼ばれなかった(描画も無かった)場合は追記方式
     * 扱いにする(x68_frame_begin()を呼んでいない場合と同じ既定。
     * docs/L1差分描画_20260901.md「追記(2026-09-01)」節)。 */
    int style = (frame_style == X68_STYLE_NONE) ? X68_STYLE_APPEND : frame_style;
    /* 初回フレーム(prev_frame_style==NONE)は「変わった」扱いにしない。 */
    int styleChanged = (prev_frame_style != X68_STYLE_NONE) && (style != prev_frame_style);
    int conflict = style_conflict;

    if (style == X68_STYLE_CLS) {
        int overflowed = curCmds->overflowed || prevCmds->overflowed;
        /* trueFull: 本当に全画面が要る場合(背景色変更・初回・流儀の衝突/変化)。
         * matchGaveUp: 突き合わせがまとまらなかった場合(未確定数超過、または
         * dirty矩形が32枚を超えた)。誤り1の修正により、この場合はもう
         * 「全画面」ではなく「旧実装と同じ再塗り」に畳む
         * (docs/L1差分描画_20260901.md「追記2」節)。 */
        int trueFull = force_full || conflict || styleChanged;
        int matchGaveUp = 0;
        int noop = 0;
        dirty_reset();

        if (!trueFull && overflowed) {
            /* 一覧が溢れた場合: cmds[]自体が不完全(bboxしか記録されていない)
             * ため、prevCmds側の個々の矩形を辿る「旧実装と同じ再塗り」は
             * できない。本当に全画面が要る。
             * X68_FAULT_L1_DIFF_NO_OVERFLOW_FALLBACK: 故障注入でこのフォール
             * バックを無効化する(何もしない。溢れた命令の消し残りが起きる)。 */
#ifdef X68_FAULT_L1_DIFF_NO_OVERFLOW_FALLBACK
            noop = 1;
#else
            trueFull = 1;
#endif
        } else if (!trueFull) {
            if (build_dirty_rects()) matchGaveUp = 1;
        }

        if (!noop) {
            if (trueFull) {
                dirty_reset();
                X68Rect full = {0, 0, X68_SCREEN_W, X68_SCREEN_H};
                dirty_add(&full);
            }

            if (matchGaveUp) {
                /* 誤り1の修正(docs/L1差分描画_20260901.md「追記2」節):
                 * dirty矩形が32枚を超える(または未確定数が64を超える)場合の
                 * 畳み先を、全画面ではなく旧実装(b7a6e13時点)と同じ再塗りに
                 * する。全画面へ畳むと、動く物が多いが1個1個は小さい場面
                 * (stars.c等)で畳む前より高くつく(実測)ため。
                 *   1. prevCmds の各命令の矩形を背景色で塗り戻す(旧x68_clsの
                 *      塗り戻しと同じ。全件。curMatched/prevMatchedでは絞らない)。
                 *   2. curCmds を順番どおり・クリップせず(画面全体へ)描き直す。
                 *   3. 突き合わせ(build_dirty_rects)で不一致だった命令に
                 *      ついてだけ、前後の矩形を転送する。 */
                X68Rect screen = {0, 0, X68_SCREEN_W, X68_SCREEN_H};

                /* X68_FAULT_L1_CLS_NO_FILL: 故障注入で前フレーム矩形を背景色で
                 * 塗り戻さない(前の絵が残る)。 */
#ifndef X68_FAULT_L1_CLS_NO_FILL
                for (int j = 0; j < prevCmds->count; j++) {
                    X68Rect rr = cmdrect_to_rect(&prevCmds->cmds[j].rect);
                    fill_rect(&rr, bgc);
                }
#endif
                for (int j = 0; j < curCmds->count; j++) {
                    exec_cmd_clipped(&curCmds->cmds[j], &screen);
                }

                for (int j = 0; j < curCmds->count; j++) {
                    if (curMatched[j]) continue;
                    X68Rect rr = cmdrect_to_rect(&curCmds->cmds[j].rect);
                    bytes += transfer_rect(&rr);
                }
                for (int j = 0; j < prevCmds->count; j++) {
                    if (prevMatched[j]) continue;
                    /* X68_FAULT_L1_SKIP_PREV / X68_FAULT_L1_DIFF_IGNORE_SHRINK:
                     * 故障注入で前フレーム側(消えた/変わった命令の「消す」側)
                     * を転送しない(消し残り)。build_dirty_rects()内の同名の
                     * 分岐と同じ意味(docs/L1差分描画_20260901.md参照)。 */
#if !defined(X68_FAULT_L1_SKIP_PREV) && !defined(X68_FAULT_L1_DIFF_IGNORE_SHRINK)
                    X68Rect rr = cmdrect_to_rect(&prevCmds->cmds[j].rect);
                    bytes += transfer_rect(&rr);
#endif
                }
            } else {
                /* 通常経路(trueFullの全画面1枚、またはdirty矩形が数枚に
                 * 確定した場合の両方をこの1本の経路でまかなう)。
                 * 誤り2の修正(docs/L1差分描画_20260901.md「追記2」節):
                 * exec_cmd_clippedを呼ぶ前に、まずdirty全体の外接矩形との
                 * 交差をインラインの整数比較で見て大半の命令を捨て、残った
                 * ものだけ個々のdirty矩形と交差判定する。関数呼び出しを
                 * 伴わない(rect_overlap()のような関数呼び出しは使わない)。 */
#ifndef X68_FAULT_L1_CLS_NO_FILL
                for (int i = 0; i < dirtyCount; i++) fill_rect(&dirtyRects[i], bgc);
#endif
                if (dirtyCount > 0) {
                    X68Rect dbb = dirtyRects[0];
                    for (int i = 1; i < dirtyCount; i++) {
                        if (dirtyRects[i].x0 < dbb.x0) dbb.x0 = dirtyRects[i].x0;
                        if (dirtyRects[i].y0 < dbb.y0) dbb.y0 = dirtyRects[i].y0;
                        if (dirtyRects[i].x1 > dbb.x1) dbb.x1 = dirtyRects[i].x1;
                        if (dirtyRects[i].y1 > dbb.y1) dbb.y1 = dirtyRects[i].y1;
                    }
                    for (int j = 0; j < curCmds->count; j++) {
                        const X68Cmd *c = &curCmds->cmds[j];
                        X68Rect crVal = cmdrect_to_rect(&c->rect);
                        const X68Rect *cr = &crVal;
                        /* dirty全体の外接矩形と交差しなければ、個々のdirty矩形
                         * とも絶対に交差しない(外接矩形の定義上)ので即座に捨てる。 */
                        if (cr->x0 >= dbb.x1 || dbb.x0 >= cr->x1 || cr->y0 >= dbb.y1 || dbb.y0 >= cr->y1) continue;
                        for (int i = 0; i < dirtyCount; i++) {
                            const X68Rect *r = &dirtyRects[i];
                            if (cr->x0 >= r->x1 || r->x0 >= cr->x1 || cr->y0 >= r->y1 || r->y0 >= cr->y1) continue;
                            exec_cmd_clipped(c, r);
                        }
                    }
                }
                for (int i = 0; i < dirtyCount; i++) bytes += transfer_rect(&dirtyRects[i]);
            }
        }

        /* 複写(cmdlist_copy)ではなく、cur/prevの実体を指すポインタを入れ替える
         * だけにする(2026-09-01: 描画命令1件あたり約3,250サイクルの固定費の
         * 主因が複写だったため。docs/L1差分描画_20260901.md参照)。入れ替え後、
         * 関数末尾の cmdlist_reset(curCmds) が(新しいcurCmds = 元のprevCmds
         * の実体を)次フレーム用に空にする。 */
        {
            X68CmdList *tmp = prevCmds;
            prevCmds = curCmds;
            curCmds = tmp;
        }
    } else {
        /* 追記フレーム: 裏バッファは既に正しい(cmd_addがその場で描いている)。
         * 突き合わせも、背景で塗って消す処理も行わない。dirtyRects/dirtyCount
         * は今フレームのcmd_add呼び出しのたびに積んである(このフレームで何も
         * 描かなければ空のまま)。流儀が変わった・衝突した・dirtyが32枚を
         * 超えた場合は安全側に倒して全画面を1回だけ転送する(裏バッファ自体は
         * 既に正しいので塗り直し・再生は不要。
         * docs/L1差分描画_20260901.md「追記(2026-09-01)」節)。 */
        int useFull = force_full || conflict || styleChanged || append_overflow;
        if (useFull) {
            dirty_reset();
            X68Rect full = {0, 0, X68_SCREEN_W, X68_SCREEN_H};
            dirty_add(&full);
        }
        for (int i = 0; i < dirtyCount; i++) {
            bytes += transfer_rect(&dirtyRects[i]);
        }
        /* prevCmds/curCmdsはCLS方式の突き合わせ専用。追記フレームでは使って
         * いないので、次にCLS方式へ戻ったときに古い一覧と誤って突き合わせない
         * よう空にしておく。 */
        cmdlist_reset(prevCmds);
    }

    x68_l1_last_flip_bytes = bytes;
    force_full = 0;
    style_conflict = 0;
    append_overflow = 0;
    prev_frame_style = style;
    frame_style = X68_STYLE_NONE;

    cmdlist_reset(curCmds);
    dirty_reset();
    backbuffer_valid = 1; /* dirty矩形はすべて再生・転送済み。非dirty領域は
                              前フレームと同一内容であることが保証されている。 */
}
