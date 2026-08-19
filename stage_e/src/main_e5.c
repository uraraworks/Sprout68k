/* Stage E-5 テストプログラム(C、ハンドラ本体は stage_e/src/e5_handlers.S)。
 *
 * 目的: 例外ベクタを自前ハンドラへ差し替え、意図的に例外を起こしたときに
 * 実際に制御が移るか、ハンドラから画面表示ができるかを実測する
 * (学習用API設計原則3「暴走は静かに固まるのではなく、見える形で止まる」の
 * 土台の実測)。
 *
 * ビルド時に -D で指定するマクロ:
 *   EXC_TYPE  0=アドレスエラー(vector3) 1=不正命令(vector4) 2=ゼロ除算(vector5)
 *   MODE      0=ハンドラ差し替え+例外を起こす(陽性: 捕捉できるはず)
 *             1=ハンドラ差し替えなし+例外を起こす(陰性対照: 捕捉されないはず)
 *             2=ハンドラ差し替えのみ、例外は起こさない
 *               (正常実行ではハンドラが動かないことの確認)
 *
 * 68000にはVBR(ベクタベースレジスタ)が無く、例外ベクタテーブルは常に物理
 * アドレス0固定(ベクタ番号Nはアドレス N*4)。68010以降はVBRで再配置できるが、
 * 本ステージはVBRを一切操作せず「テーブルは番地0固定」という68000の前提の
 * まま書く。68030機でこの前提が成立するかどうかは docs/StageE-5_実測_20260819.md
 * に出所を明記して記録する(実測できない場合はできないと書く)。
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

/* host側が peekWord()/peekByte() で監視するホスト変数。E-2/E-3が使う
 * 0x000E0000/0x000E0010/0x000E0020 と衝突しないよう別アドレスに置く。 */
#define HOSTVAR_MARKER (*(vu16 *)0x000E0030) /* ハンドラが書く捕捉印(種別ごとに異なる) */
#define HOSTVAR_ALIVE  (*(vu8  *)0x000E0034) /* 例外トリガ直前にmain()が1を書く(到達確認用) */

/* 68000のベクタテーブル(番地0固定)。vector N のベクタは N*4 番地。 */
#define VEC_ADDR_ERROR (*(vu32 *)0x0000000C) /* vector3 */
#define VEC_ILLEGAL    (*(vu32 *)0x00000010) /* vector4 */
#define VEC_ZERODIV    (*(vu32 *)0x00000014) /* vector5 */

#ifndef EXC_TYPE
#error "EXC_TYPE must be defined (0=addr error,1=illegal,2=zerodiv)"
#endif
#ifndef MODE
#error "MODE must be defined (0=install+trigger,1=no-install+trigger,2=install+no-trigger)"
#endif
#if EXC_TYPE != 0 && EXC_TYPE != 1 && EXC_TYPE != 2
#error "EXC_TYPE must be 0, 1, or 2"
#endif
#if MODE != 0 && MODE != 1 && MODE != 2
#error "MODE must be 0, 1, or 2"
#endif

extern void e5_addr_error_handler(void);
extern void e5_illegal_handler(void);
extern void e5_zerodiv_handler(void);
extern void e5_trigger_addr_error(void);
extern void e5_trigger_illegal(void);
extern void e5_trigger_zerodiv(void);

void main(void) {
    /* Stage B/C/E-1/E-3 と同じレジスタ設定(実測済み): 65536色1ページモード。
     * ハンドラがGVRAM先頭ワードへ色を書いて画面表示することを確認するために
     * トリガ前に有効化しておく。 */
    CRTC_R20 = 0x08;
    VC_R0 = 0x03;
    VC_R2 = 0x01;
    GVRAM[0] = 0x0000; /* 背景色(黒)でクリア。ハンドラが動けばここが上書きされる */

    HOSTVAR_MARKER = 0;
    HOSTVAR_ALIVE = 0;

#if MODE == 0 || MODE == 2
    /* ハンドラを差し替える */
#if EXC_TYPE == 0
    VEC_ADDR_ERROR = (unsigned long)e5_addr_error_handler;
#elif EXC_TYPE == 1
    VEC_ILLEGAL = (unsigned long)e5_illegal_handler;
#elif EXC_TYPE == 2
    VEC_ZERODIV = (unsigned long)e5_zerodiv_handler;
#endif
#endif

    HOSTVAR_ALIVE = 1; /* ここまで正常に到達したことをhost側に示す */

#if MODE == 0 || MODE == 1
    /* 例外を意図的に起こす。捕捉できればここから先には戻らない
     * (ハンドラ側が無限ループで停止するため)。 */
#if EXC_TYPE == 0
    e5_trigger_addr_error();
#elif EXC_TYPE == 1
    e5_trigger_illegal();
#elif EXC_TYPE == 2
    e5_trigger_zerodiv();
#endif
#endif

    /* MODE==2(例外を起こさない)、または例外が捕捉されずここへ制御が戻って
     * しまった場合(想定外)はここに来る。HOSTVAR_MARKERが0のままであることが
     * host側の判定材料になる。 */
    for (;;) { }
}
