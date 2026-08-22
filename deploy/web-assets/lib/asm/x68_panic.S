/* Sprout68k パニック画面: 例外ベクタの差し替え + 例外エントリスタブ + 日本語メッセージ。
 *
 * docs/API設計_20260819.md 設計原則3「暴走は静かに固まるのではなく、見える形で
 * 止まる」の実装。docs/StageE-5_実測_20260819.md で実測確定した手段(ベクタ番地
 * への直接書き込み)をそのまま使う。対象はバスエラー(vector2)・アドレスエラー
 * (vector3)・不正命令(vector4)・ゼロ除算(vector5)の4種(バスエラーは
 * docs/パニック画面_20260820.md に記録の通りpx68kでは発火させられないため
 * 未検証。ハンドラ自体は実機向けに用意する)。
 *
 * 【VBR対応(68020以降でVBRを明示的に0にする)】
 * stage_c/boot/cache_flush.S の「MOVECを試し、不正命令が起きたら
 * 68000相当とみなして諦める」手法をそのまま流用する。68000にはVBRが無く
 * MOVECは不正命令になるため、まず不正命令ベクタ(番地$10)を一時的な
 * 自前ハンドラへ差し替えてからMOVEC実行を試み、例外が起きたら安全に
 * スキップする。退避は cache_flush.S で実測発見した罠(絶対アドレス書き込みは
 * ロードアドレス前提が崩れると壊れる)を避けるため、メモリではなく
 * レジスタ(%a2/%a3)だけを使う。
 *
 * このコードが実行される段階でVBRが0でない状態になっている保証は無いが、
 * cache_flush.S が同じ前提(ベクタテーブルは番地0)で全Stageの起動時に
 * 使われ続けて壊れていない実績があるため、同じ前提を踏襲する。
 *
 * 【実機/実測状況(正直に記録する)】
 * px68k(このプロジェクトの検証環境)はMusashi CPUコアをCPU種別切り替え無しで
 * ビルドしており常に68000として初期化される(cache_flush.Sのコメント、
 * docs/StageE-5_実測_20260819.mdで確認済み)。つまり本プロジェクトの手段では
 * MOVECが常に不正命令として扱われる経路(68000相当、VBR設定をスキップして
 * 安全に続行する経路)しか実測できず、68020/68030側(MOVECが成功しVBRへ実際に
 * 書き込む経路)は一度も実行されておらず未検証(docs/パニック画面_20260820.md
 * に明記)。
 */
    .globl  x68_panic_install
    .text

/* void x68_panic_install(void);
 * 呼び出し規約: 引数無し、戻り値無し。callee-saved(d2-d7/a2-a6)のうち、この
 * ルーチンが使う a2/a3 を入口で退避し、出口で戻す。
 *
 * 【2026-08-23】ここは以前「自前で行う」とコメントだけ書いて**実際には退避して
 * いなかった**。呼び出し元が a2/a3 に載せた値が黙って壊れる。x68_screen_open()
 * がこの関数を呼ぶため、症状は「x68_screen_open() を跨いで保持した値が化ける」
 * という形で出る。作例が x68_screen_open() を先に呼ぶ書き方だったので長く
 * 表面化しなかった。コメントを信じず実装を読むこと。 */
x68_panic_install:
#ifdef X68_FAULT_PANIC_NO_INSTALL
    /* 故障注入: 例外ベクタの差し替えを一切行わない。パニック画面が
     * 出ないはず(検証: docs/パニック画面_20260820.md「故障注入」節)。 */
    rts
#else
    /* 呼び出し元の a2/a3 を壊さない。**この2行が無いと、呼び出し元が
     * a2/a3 に置いた変数が黙って化ける。** 下の x68_panic_vbr_illegal は
     * a2 に保存した SP へ戻すので、退避した後の SP を a2 に入れること
     * (順序を入れ替えるとスタックが合わなくなる)。 */
    movem.l %a2-%a3,-(%sp)

    /* ---- 1. VBR対応CPUなら明示的に0へ設定する ---- */
    movea.l %sp,%a2                /* 例外が起きた場合の復帰用に現在のSPを保存 */
    movea.l 0x10,%a3               /* 不正命令ベクタ(vector4, 番地$10)の元の値を保存 */
    lea     x68_panic_vbr_illegal,%a0
    move.l  %a0,0x10

    moveq   #0,%d0
    movec   %d0,%vbr                /* 68000ではここで不正命令例外→ハンドラへ */

x68_panic_vbr_restore:
    move.l  %a3,0x10                /* 不正命令ベクタを元に戻す(直後に本物へ差し替える) */

    /* ---- 2. 4種の例外ベクタへ自前ハンドラを設定する ---- */
    lea     x68_panic_entry_buserr,%a0
    move.l  %a0,0x08                /* vector2: バスエラー */
    lea     x68_panic_entry_addrerr,%a0
    move.l  %a0,0x0C                /* vector3: アドレスエラー */
    lea     x68_panic_entry_illegal,%a0
    move.l  %a0,0x10                /* vector4: 不正命令 */
    lea     x68_panic_entry_zerodiv,%a0
    move.l  %a0,0x14                /* vector5: ゼロ除算 */
    movem.l (%sp)+,%a2-%a3          /* 呼び出し元の a2/a3 を戻す */
    rts

x68_panic_vbr_illegal:
    /* MOVECが不正命令だった(=68000相当、VBRを持たないCPU)。フレーム長を
     * 解析せず、例外前に保存しておいたSPをそのまま復元して安全に続行する
     * (cache_flush.S のcf_illegal_handlerと同じ設計)。 */
    movea.l %a2,%sp
    bra     x68_panic_vbr_restore
#endif /* X68_FAULT_PANIC_NO_INSTALL */

/* ---- 例外エントリスタブ ----
 * どれもRTEで元の実行へは戻さない(Stage E-5のe5_handlers.Sと同じ設計。
 * 「見える形で止まる」ことが目的そのものであり、68000の例外スタックフレーム
 * 形式の違い(アドレスエラーは可変長寄りの7ワード、不正命令/ゼロ除算は
 * 固定3ワード)を解析せずに済む)。
 *
 * PCをスタックフレームから読み出してから x68_panic_show(int type, unsigned
 * long pc) をCの呼び出し規約(引数は右から順にpush、最初の引数が最後に
 * pushされてspに一番近くなる。lib/asm/x68_iocs.Sのx68_iocs_disk_readと
 * 同じ規約)で呼ぶ。呼び出し前にPCを読むので、pushによるspのずれを
 * 気にする必要が無い。
 *
 * バスエラー・アドレスエラーは7ワード(14バイト)フレームで、PCは
 * SP+10(SSW 2バイト+アクセスアドレス4バイト+命令レジスタ2バイト+SR2バイト
 * =10バイトの後)にある(docs/StageE-5_実測_20260819.mdの解読、Motorola一般
 * 文書化仕様に基づく。**このオフセット自体はStage E-5・本パニック画面の
 * どちらでも実機上でPCの値そのものをMotorola資料外の手段で裏取りしては
 * いない**。実測しているのは「表示されたPCが例外発生位置に応じて変化する
 * こと」であって、オフセット計算式の絶対的な正しさそのものではない。
 * docs/パニック画面_20260820.md に明記)。
 * 不正命令・ゼロ除算は3ワード(6バイト)フレームで、PCはSP+2。 */

x68_panic_entry_buserr:
    move.l  10(%sp),%d1
    move.l  %d1,-(%sp)
    move.l  #2,-(%sp)               /* type=2(バスエラー、vector番号と揃える) */
    jsr     x68_panic_show
x68_panic_entry_buserr_halt:
    bra.s   x68_panic_entry_buserr_halt

x68_panic_entry_addrerr:
    move.l  10(%sp),%d1
    move.l  %d1,-(%sp)
    move.l  #3,-(%sp)               /* type=3(アドレスエラー) */
    jsr     x68_panic_show
x68_panic_entry_addrerr_halt:
    bra.s   x68_panic_entry_addrerr_halt

x68_panic_entry_illegal:
    move.l  2(%sp),%d1
    move.l  %d1,-(%sp)
    move.l  #4,-(%sp)               /* type=4(不正命令) */
    jsr     x68_panic_show
x68_panic_entry_illegal_halt:
    bra.s   x68_panic_entry_illegal_halt

x68_panic_entry_zerodiv:
    move.l  2(%sp),%d1
    move.l  %d1,-(%sp)
    move.l  #5,-(%sp)               /* type=5(ゼロ除算) */
    jsr     x68_panic_show
x68_panic_entry_zerodiv_halt:
    bra.s   x68_panic_entry_zerodiv_halt

/* ============================================================
 * 日本語メッセージ(CP932バイト列を直接 .byte で埋め込む)
 *
 * 【既知の罠(必ず踏まないこと)】ソースをUTF-8からエンコードするとき
 * "SHIFT_JIS" コーデックではなく "CP932" を使うこと(0x5Cが¥になりCの
 * エスケープが全壊する既知の失敗)。本ファイルはさらに一歩踏み込み、
 * C/アセンブラの文字列リテラル(.ascii、バックスラッシュエスケープを
 * 解釈する)を一切使わず、Python3(cp932コーデック)で事前に計算した
 * バイト値をそのまま.byteへ列挙している。これにより、CP932の2バイト目が
 * たまたま0x5C(バックスラッシュ)と一致するようなグリフがあっても
 * エスケープ解釈に巻き込まれる余地が無い(生成に使ったコマンドは
 * docs/パニック画面_20260820.md に記録)。
 * ============================================================ */
    .align 2
    .globl  x68_panic_msg_buserr
x68_panic_msg_buserr: /* "バスエラーが発生しました" */
    .byte 0x83, 0x6f, 0x83, 0x58, 0x83, 0x47, 0x83, 0x89, 0x81, 0x5b, 0x82, 0xaa, 0x94, 0xad, 0x90, 0xb6, 0x82, 0xb5, 0x82, 0xdc, 0x82, 0xb5, 0x82, 0xbd, 0x00

    .align 2
    .globl  x68_panic_msg_addrerr
x68_panic_msg_addrerr: /* "アドレスエラーが発生しました" */
    .byte 0x83, 0x41, 0x83, 0x68, 0x83, 0x8c, 0x83, 0x58, 0x83, 0x47, 0x83, 0x89, 0x81, 0x5b, 0x82, 0xaa, 0x94, 0xad, 0x90, 0xb6, 0x82, 0xb5, 0x82, 0xdc, 0x82, 0xb5, 0x82, 0xbd, 0x00

    .align 2
    .globl  x68_panic_msg_illegal
x68_panic_msg_illegal: /* "不正な命令を実行しました" */
    .byte 0x95, 0x73, 0x90, 0xb3, 0x82, 0xc8, 0x96, 0xbd, 0x97, 0xdf, 0x82, 0xf0, 0x8e, 0xc0, 0x8d, 0x73, 0x82, 0xb5, 0x82, 0xdc, 0x82, 0xb5, 0x82, 0xbd, 0x00

    .align 2
    .globl  x68_panic_msg_zerodiv
x68_panic_msg_zerodiv: /* "ゼロで割り算をしました" */
    .byte 0x83, 0x5b, 0x83, 0x8d, 0x82, 0xc5, 0x8a, 0x84, 0x82, 0xe8, 0x8e, 0x5a, 0x82, 0xf0, 0x82, 0xb5, 0x82, 0xdc, 0x82, 0xb5, 0x82, 0xbd, 0x00

    .align 2
    .globl  x68_panic_msg_stop
x68_panic_msg_stop: /* "プログラムを停止します" */
    .byte 0x83, 0x76, 0x83, 0x8d, 0x83, 0x4f, 0x83, 0x89, 0x83, 0x80, 0x82, 0xf0, 0x92, 0xe2, 0x8e, 0x7e, 0x82, 0xb5, 0x82, 0xdc, 0x82, 0xb7, 0x00
