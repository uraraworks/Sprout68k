/* Stage E-3 テストプログラム(C)。
 *
 * 目的: メインメモリ上の領域から GVRAM へ K バイト転送する間に経過した垂直同期の
 * 回数を実測し、1フレームあたりの転送スループット(バイト/フレーム)を求める。
 *
 * 垂直同期の検出方法は Stage E-2 で実測確定した MFP GPIP($00E88001) bit4 の
 * 立下りエッジ検出をそのまま使う(候補の出所は main_e2.c と同じ)。転送ループの
 * 中でエッジ検出を一緒に行うことで、転送中に何回帰線期間へ入ったかを数える
 * (転送とポーリングを同時に行える単一CPUでの素直なやり方。ポーリングの
 * オーバーヘッド自体が測定対象に含まれる点は「結果の読み方」に明記する)。
 *
 * 転送語数(TRANSFER_WORDS = K バイト / 2)はビルド時に -D で指定する
 * (build_stage_e3.sh が K=64/128/256/512 KB それぞれでビルドする)。
 *
 * 転送元(SRC)は $00020000 から最大 512KB($000A0000 まで)の固定アドレス。
 * ロードアドレス($3000 付近、本体は7セクタ以内)ともスタック($F0000, RAM_SIZE
 * =1MBの既定値)とも重ならない未使用RAM領域として選んだ(コンパイラの.bss
 * 配置に依存しないよう、通常の配列ではなく固定アドレスへの volatile ポインタで
 * 直接アクセスする)。転送元の中身(初期値)はスループット測定には無関係
 * (ワード単位のコピーは値に依存しない)なので初期化しない。
 *
 * 完了は DONE_FLAG(1バイト)で通知し、経過した垂直同期回数は VSYNC_COUNT
 * (32bit、host側は peekWord を2回読んで合成する)に書く。
 *
 * newlib は使わない。ヒープも使わない。フリースタンディング。
 */
typedef volatile unsigned char vu8;
typedef volatile unsigned short vu16;
typedef volatile unsigned long vu32;

#define CRTC_R20 (*(vu8 *)0x00E80028)
#define VC_R0    (*(vu8 *)0x00E82401)
#define VC_R2    (*(vu8 *)0x00E82601)
#define GVRAM    ((vu16 *)0x00C00000)
#define MFP_GPIP (*(vu8 *)0x00E88001)

#define SRC ((vu16 *)0x00020000)

#define DONE_FLAG    (*(vu8 *)0x000E0010)
#define VSYNC_COUNT  (*(vu32 *)0x000E0014)

#ifndef TRANSFER_WORDS
#error "TRANSFER_WORDS must be defined by the build script (K bytes / 2)"
#endif

void main(void) {
    unsigned long i;
    unsigned long vsync_events = 0;
    unsigned char prev;
    unsigned char g;

    /* Stage B/C/E-1 と同じレジスタ設定(実測済み): 65536色1ページモード */
    CRTC_R20 = 0x08;
    VC_R0 = 0x03;
    VC_R2 = 0x01;

    DONE_FLAG = 0;
    VSYNC_COUNT = 0;

    prev = (unsigned char)(MFP_GPIP & 0x10);
    for (i = 0; i < TRANSFER_WORDS; i++) {
        GVRAM[i] = SRC[i];
        g = (unsigned char)(MFP_GPIP & 0x10);
        if (prev && !g) {
            vsync_events++;
        }
        prev = g;
    }

    VSYNC_COUNT = vsync_events;
    DONE_FLAG = 1;

    for (;;) { }
}
