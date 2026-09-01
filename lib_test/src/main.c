/* Sprout68k ライブラリ第一版(L0 + 標準名の層)の検証用テストプログラム。
 *
 * 各関数を自己検査し、結果を固定アドレス(HOSTVAR群)へ書く。host側
 * (verify/verify_lib.mts)がその値を実際に読んで判定する(自己申告を
 * そのまま信じない。特にmemcpy/memset/ディスク読み込みはhost側が
 * バッファの中身を直接ピークして独立に照合する)。
 *
 * printf/puts の出力はテキスト画面(IOCS $21)へ実際に出すので、host側は
 * readTextScreen() で文字列を突き合わせる(末端で測る)。
 *
 * GVRAM関連(65536色1ページモード設定・MOVEM高速コピー)は、host側が
 * フレームバッファ(canvas)を実際にレンダリングして読み、Stage E-1と同じ
 * 「非背景クラスタの位置」照合で確認する(値の自己申告に頼らない)。
 *
 * newlib は使わない。ヒープも使わない。フリースタンディング。
 */
#include "x68.h"

typedef volatile unsigned long vu32;
typedef volatile unsigned char vu8;
typedef volatile unsigned short vu16;

/* ============================================================
 * host側との受け渡しアドレス(HOSTVAR)。
 * Stage E系が使う 0x000E0000 台とは別の 0x000D0000 台を使う(衝突回避。
 * ただしそれぞれ別ディスクイメージで独立起動するため実害は無い。念のため
 * 分けてある)。
 * ============================================================ */
#define HV_BASE 0x000D0000UL

/* 進行カウンタ: 各テスト工程の直前に書く。ハング時にどこで止まったか
 * host側から分かるようにする(Stage E-5のHOSTVAR_ALIVEと同じ発想)。 */
#define HV_PROGRESS (*(vu32 *)(HV_BASE + 0x0000))

/* 自己検査の結果(1=PASS, 0=FAIL)。添字は下記 enum を参照。 */
#define HV_RESULTS ((vu8 *)(HV_BASE + 0x0010))
enum {
    R_MEMCPY = 0,
    R_MEMSET,
    R_STRLEN,
    R_ABS,
    R_RAND,
    R_DISKREAD,
    R_BITSNS,
    R_MEMCPY_BOUNDARY,
    R_MEMSET_BOUNDARY,
    R_COUNT
};

/* memcpy/memset: host側が直接バッファを覗いて独立照合するための固定アドレス。 */
#define BUF_MEMCPY_SRC ((unsigned char *)(HV_BASE + 0x1000)) /* 64バイト */
#define BUF_MEMCPY_DST ((unsigned char *)(HV_BASE + 0x1100)) /* 64バイト */
#define BUF_MEMSET_DST ((unsigned char *)(HV_BASE + 0x1200)) /* 64バイト */

#define HV_STRLEN_RESULT (*(vu32 *)(HV_BASE + 0x1300))
#define HV_ABS_RESULT(i) (*(vu32 *)(HV_BASE + 0x1310 + (i) * 4)) /* i=0..3 */

#define HV_RAND_SEQ_A(i) (*(vu32 *)(HV_BASE + 0x1400 + (i) * 4)) /* i=0..4 */
#define HV_RAND_SEQ_B(i) (*(vu32 *)(HV_BASE + 0x1420 + (i) * 4)) /* i=0..4 */

/* IOCS $46 のディスク読み込みテスト用バッファ(1024バイト = 1セクタ分)。 */
#define BUF_DISKREAD_DST ((unsigned char *)(HV_BASE + 0x1500))

/* 垂直同期待ちの実測(Stage E-2と同じ方式): 待った回数を書き続ける。 */
#define HV_VSYNC_COUNTER (*(vu32 *)(HV_BASE + 0x2000))

/* BITSNS(x68_iocs_bitsns)の実測: 毎回の生の戻り値を履歴配列へ書く。
 * host側が対応する回数だけrunFrame()+setKey()を呼びながら記録された内容を
 * 直接ピークして押下/解放の追従を確認する。 */
#define BUF_BITSNS_HISTORY ((unsigned char *)(HV_BASE + 0x2100)) /* 220バイト */
#define HV_BITSNS_COUNT (*(vu32 *)(HV_BASE + 0x2200))
#define BITSNS_HISTORY_LEN 200

/* 32bit化したmemcpy/memsetの境界/整列テスト用バッファ。
 * 空き領域(BUF_BITSNS_HISTORY末尾0x21DC 〜 HV_DONEの0x3000の間)に置く。
 * host側(verify/verify_lib.mts)が直接ピークして独立照合する
 * (このプログラム側の自己判定だけに頼らない、既存memcpy/memsetテストと同じ方針)。 */
#define BND_SLOT 32UL /* 1ケースあたりの確保幅(番兵の前後に余裕を持たせる) */
#define BND_CASE_COUNT 11
#define BUF_BND_SRC ((unsigned char *)(HV_BASE + 0x2300)) /* BND_CASE_COUNT*BND_SLOT */
#define BUF_BND_DST ((unsigned char *)(HV_BASE + 0x2500)) /* BND_CASE_COUNT*BND_SLOT */

#define BND_SET_CASE_COUNT 8
#define BUF_BND_SET_DST ((unsigned char *)(HV_BASE + 0x2700)) /* BND_SET_CASE_COUNT*BND_SLOT */

/* 全工程完了の目印。 */
#define HV_DONE (*(vu32 *)(HV_BASE + 0x3000))
#define HV_DONE_MAGIC 0xC0DEBEEFUL

/* ============================================================
 * 個別テスト
 * ============================================================ */

static void test_memcpy(void) {
    HV_PROGRESS = 1;
    for (unsigned long i = 0; i < 64; i++) {
        BUF_MEMCPY_SRC[i] = (unsigned char)(i * 3 + 7);
        BUF_MEMCPY_DST[i] = 0xEE; /* 番兵(コピー漏れを検出できる値) */
    }
    memcpy((void *)BUF_MEMCPY_DST, (const void *)BUF_MEMCPY_SRC, 64);
    int ok = 1;
    for (unsigned long i = 0; i < 64; i++) {
        if (BUF_MEMCPY_DST[i] != BUF_MEMCPY_SRC[i]) ok = 0;
    }
    HV_RESULTS[R_MEMCPY] = (unsigned char)ok;
}

static void test_memset(void) {
    HV_PROGRESS = 2;
    for (unsigned long i = 0; i < 64; i++) BUF_MEMSET_DST[i] = 0x00;
    memset((void *)BUF_MEMSET_DST, 0xA5, 64);
    int ok = 1;
    for (unsigned long i = 0; i < 64; i++) {
        if (BUF_MEMSET_DST[i] != 0xA5) ok = 0;
    }
    HV_RESULTS[R_MEMSET] = (unsigned char)ok;
}

/* --- memcpy境界/整列テスト ---
 * ケース一覧(dstオフセット, srcオフセット, n): 32bit化で最も壊れやすいのは
 * (1)送り元/送り先の偶奇が食い違う場合、(2)n=0,1,2,3(4バイト未満)、
 * n=7,8,9(4バイト境界の前後)なので、この組み合わせを網羅する。
 * offset=1のケースは奇数番地からの読み書きを作る。n=10,11は「4バイト境界を
 * 越えた後の余りマスクの取り違え」(例: n&=3UL を誤って n&=1UL にする)を
 * n=8,9だけでは検出できない(8,9はmod4とmod2の結果が偶然一致する)ため追加した。 */
static const unsigned char bnd_dst_off[BND_CASE_COUNT] = { 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0 };
static const unsigned char bnd_src_off[BND_CASE_COUNT] = { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 };
static const unsigned char bnd_n[BND_CASE_COUNT]       = { 0, 1, 2, 3, 7, 8, 9, 10, 11, 8, 9 };

static void test_memcpy_boundary(void) {
    HV_PROGRESS = 11;
    int ok = 1;
    for (int c = 0; c < BND_CASE_COUNT; c++) {
        unsigned char *slot_src = BUF_BND_SRC + (unsigned long)c * BND_SLOT;
        unsigned char *slot_dst = BUF_BND_DST + (unsigned long)c * BND_SLOT;
        unsigned long dst_off = bnd_dst_off[c];
        unsigned long src_off = bnd_src_off[c];
        unsigned long n = bnd_n[c];

        /* スロット全体を既知パターン(src)/番兵0xEE(dst)で初期化する。 */
        for (unsigned long i = 0; i < BND_SLOT; i++) {
            slot_src[i] = (unsigned char)(c * 13 + i * 3 + 11);
            slot_dst[i] = 0xEE;
        }

        memcpy((void *)(slot_dst + dst_off), (const void *)(slot_src + src_off), n);

        /* コピー範囲がsrcと一致していること。 */
        for (unsigned long i = 0; i < n; i++) {
            if (slot_dst[dst_off + i] != slot_src[src_off + i]) ok = 0;
        }
        /* コピー範囲の外(dst_offより前、dst_off+nより後)は番兵0xEEのまま
         * 変わっていないこと(書き過ぎ・書き足りなさの両方を検出する)。 */
        for (unsigned long i = 0; i < dst_off; i++) {
            if (slot_dst[i] != 0xEE) ok = 0;
        }
        for (unsigned long i = dst_off + n; i < BND_SLOT; i++) {
            if (slot_dst[i] != 0xEE) ok = 0;
        }
    }
    HV_RESULTS[R_MEMCPY_BOUNDARY] = (unsigned char)ok;
}

/* --- memset境界/整列テスト ---
 * memcpyと同じ考え方だが、送り元が無いのでdstの偶奇だけを振る。 */
static const unsigned char bnd_set_dst_off[BND_SET_CASE_COUNT] = { 0, 0, 0, 0, 0, 0, 0, 1 };
static const unsigned char bnd_set_n[BND_SET_CASE_COUNT]       = { 0, 1, 2, 3, 7, 8, 9, 9 };
#define BND_SET_VALUE 0x3C

static void test_memset_boundary(void) {
    HV_PROGRESS = 12;
    int ok = 1;
    for (int c = 0; c < BND_SET_CASE_COUNT; c++) {
        unsigned char *slot = BUF_BND_SET_DST + (unsigned long)c * BND_SLOT;
        unsigned long dst_off = bnd_set_dst_off[c];
        unsigned long n = bnd_set_n[c];

        for (unsigned long i = 0; i < BND_SLOT; i++) slot[i] = 0xEE;

        memset((void *)(slot + dst_off), BND_SET_VALUE, n);

        for (unsigned long i = 0; i < n; i++) {
            if (slot[dst_off + i] != (unsigned char)BND_SET_VALUE) ok = 0;
        }
        for (unsigned long i = 0; i < dst_off; i++) {
            if (slot[i] != 0xEE) ok = 0;
        }
        for (unsigned long i = dst_off + n; i < BND_SLOT; i++) {
            if (slot[i] != 0xEE) ok = 0;
        }
    }
    HV_RESULTS[R_MEMSET_BOUNDARY] = (unsigned char)ok;
}

static void test_strlen(void) {
    HV_PROGRESS = 3;
    unsigned long len = strlen("HELLO,X68000");
    HV_STRLEN_RESULT = len;
    HV_RESULTS[R_STRLEN] = (unsigned char)(len == 12UL ? 1 : 0);
}

static void test_abs(void) {
    HV_PROGRESS = 4;
    int inputs[4] = { 5, -5, 0, -2147483647 };
    int expected[4] = { 5, 5, 0, 2147483647 };
    int ok = 1;
    for (int i = 0; i < 4; i++) {
        int r = abs(inputs[i]);
        HV_ABS_RESULT(i) = (unsigned long)r;
        if (r != expected[i]) ok = 0;
    }
    HV_RESULTS[R_ABS] = (unsigned char)ok;
}

static void test_rand(void) {
    HV_PROGRESS = 5;
    srand(1234u);
    int ok = 1;
    for (int i = 0; i < 5; i++) {
        int r = rand();
        HV_RAND_SEQ_A(i) = (unsigned long)r;
        if (r < 0 || r > X68_RAND_MAX) ok = 0;
    }
    srand(1234u);
    for (int i = 0; i < 5; i++) {
        int r = rand();
        HV_RAND_SEQ_B(i) = (unsigned long)r;
    }
    /* 自己検査(hostも独立にA==Bを確認する) */
    for (int i = 0; i < 5; i++) {
        if (HV_RAND_SEQ_A(i) != HV_RAND_SEQ_B(i)) ok = 0;
    }
    HV_RESULTS[R_RAND] = (unsigned char)ok;
}

/* IOCS $46: track=30/side=0/sector=1 に build_lib_test.sh が焼き込む既知パターン
 * (先頭11バイトが "X68DISKTEST"、以降は (i & 0xFF))を読み込んで照合する。 */
static void test_disk_read(void) {
    HV_PROGRESS = 6;
    for (unsigned long i = 0; i < 1024; i++) BUF_DISKREAD_DST[i] = 0;

    unsigned long d1 = 0x00009070UL;                     /* PDA=$90(FDD0), mode=$70 */
    unsigned long d2 = 0x03000000UL | (30UL << 16) | (0UL << 8) | 1UL; /* track30/side0/sector1 */
    long ret = x68_iocs_disk_read(d1, d2, 1024, (void *)BUF_DISKREAD_DST);

    int ok = (ret != -1L);
    const char sig[11] = "X68DISKTEST";
    for (int i = 0; i < 11; i++) {
        if (BUF_DISKREAD_DST[i] != (unsigned char)sig[i]) ok = 0;
    }
    for (unsigned long i = 11; i < 1024; i++) {
        if (BUF_DISKREAD_DST[i] != (unsigned char)(i & 0xFF)) ok = 0;
    }
    HV_RESULTS[R_DISKREAD] = (unsigned char)ok;
}

/* 垂直同期待ち: Stage E-2と同じ方式(待った回数を書き続ける)。
 * hostはrunFrame()呼び出し回数との比を見る。 */
static void run_vsync_test(void) {
    HV_PROGRESS = 7;
    unsigned long c = 0;
    HV_VSYNC_COUNTER = 0;
    for (int i = 0; i < 300; i++) {
        x68_vsync_wait();
        c++;
        HV_VSYNC_COUNTER = c;
    }
}

/* BITSNS: 垂直同期に合わせて group6(SPACEを含む)を毎回読み、履歴配列へ書く。
 * hostは対応する回数だけsetKey()+runFrame()を行いながら押下/解放を追従できるか
 * 確認する。 */
static void run_bitsns_test(void) {
    HV_PROGRESS = 8;
    for (int i = 0; i < BITSNS_HISTORY_LEN; i++) {
        x68_vsync_wait();
        unsigned char b = x68_iocs_bitsns(6);
        BUF_BITSNS_HISTORY[i] = b;
        HV_BITSNS_COUNT = (unsigned long)(i + 1);
    }
    /* 履歴を読めば追従できているかどうかは分かるので、ここでは常にPASS扱いに
     * せず「一度でも値0以外を観測した(SPACEが押された区間があった)」ことだけ
     * を最低条件にする。真の判定はhost側が履歴を直接読んで行う。 */
    int sawNonZero = 0;
    for (int i = 0; i < BITSNS_HISTORY_LEN; i++) {
        if (BUF_BITSNS_HISTORY[i] != 0) sawNonZero = 1;
    }
    HV_RESULTS[R_BITSNS] = (unsigned char)sawNonZero;
}

/* GVRAM: 65536色1ページモード設定 + MOVEM高速コピー。
 * hostはフレームバッファを実際にレンダリングして読み、Stage E-1と同じ
 * 「非背景クラスタの位置」照合で確認する(このプログラム側は書くだけ)。
 *
 * 色生成式は verify/verify_lib.mts の genColor() と同じ式を使う
 * (5-5-5-1、Stage E-1のgenColor()を踏襲)。 */
#define GVRAM ((vu16 *)0x00C00000UL)

static unsigned short gen_color(unsigned long i) {
    unsigned long g = (i * 7UL) % 32UL;
    unsigned long r = (i * 11UL) % 32UL;
    unsigned long b = (i * 17UL) % 32UL;
    return (unsigned short)(((g & 0x1FUL) << 11) | ((r & 0x1FUL) << 6) | ((b & 0x1FUL) << 1) | 1UL);
}

#define GVRAM_DIRECT_OFF_A 100UL
#define GVRAM_DIRECT_OFF_B 300UL
#define GVRAM_COPY_BASE_OFF 20000UL /* MOVEMコピー先(16ワード=1バッチ) */

static unsigned short gvram_copy_src[16];

static void run_gvram_test(void) {
    HV_PROGRESS = 9;
    x68_gvram_mode_65536_1page();

    /* 直接書き込みマーカー(モード設定そのものの確認) */
    GVRAM[GVRAM_DIRECT_OFF_A] = gen_color(200);
    GVRAM[GVRAM_DIRECT_OFF_B] = gen_color(201);

    /* MOVEMコピーの確認: 16ワード(=1バッチ=8ロング=32バイト)をメインメモリから
     * GVRAMへコピーする。 */
    for (unsigned long i = 0; i < 16; i++) {
        gvram_copy_src[i] = gen_color(i);
    }
    x68_gvram_copy_movem((void *)&GVRAM[GVRAM_COPY_BASE_OFF],
                          (const void *)gvram_copy_src, 1UL);
}

/* ============================================================
 * printf/puts: テキスト画面へ実際に出す(host側がreadTextScreen()で照合)。
 * 行ごとにx68_iocs_locateで位置を固定してから出す(照合しやすくするため)。
 * ============================================================ */
static void run_text_tests(void) {
    HV_PROGRESS = 10;

    x68_iocs_locate(0, 1);
    puts("PUTSLINE1");
    /* puts()は改行を追加するので、次のputs()は自動的に次の行(row2)から
     * 始まるはず(host側が確認する)。 */
    puts("PUTSLINE2");

    x68_iocs_locate(0, 4);
    printf("FMT D=%d U=%u X=%x C=%c S=%s PCT=%%\n", -42, 42u, 0x2au, 'A', "hi");

    x68_iocs_locate(0, 6);
    /* 非対応の書式(幅指定)。黙って誤動作せず[BADFMT]が見える形で出ること。 */
    printf("BAD %3d END\n", 7);

    x68_iocs_locate(0, 8);
    /* 非対応の書式(浮動小数点)。 */
    printf("FLT %f END\n", 0);

    x68_iocs_locate(0, 10);
    /* フォーマット文字列が'%'で終わる場合。 */
    printf("TAIL %");
    printf("\n");
}

void main(void) {
    HV_PROGRESS = 0;
    for (int i = 0; i < R_COUNT; i++) HV_RESULTS[i] = 0;
    HV_DONE = 0;

    x68_iocs_locate(0, 0);
    puts("X68LIB TEST START");

    test_memcpy();
    test_memset();
    test_strlen();
    test_abs();
    test_rand();
    test_disk_read();
    run_vsync_test();
    run_bitsns_test();
    run_gvram_test();
    run_text_tests();
    /* 境界/整列テストは末尾に置く(HV_PROGRESSがrun_vsync_test()の7より前に
     * 11/12へ達すると、host側のvsync計測窓開始判定(progress>=7)が誤って
     * この時点で始まってしまうため)。 */
    test_memcpy_boundary();
    test_memset_boundary();

    HV_PROGRESS = 999;
    HV_DONE = HV_DONE_MAGIC;

    for (;;) { }
}
