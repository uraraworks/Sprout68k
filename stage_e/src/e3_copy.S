/* Stage E-3(再測定): メインメモリ→GVRAM 転送の3方式(word/long/movem)。
 *
 * 【旧実装の欠陥】以前の main_e3.c は「1ワードコピーするごとに毎回 MFP GPIP
 * ($E88001)を読む」実装だった。MFP は低速な I/O バスにあり、この読み出しは
 * 2バイトのコピーそのものより遥かに高価。つまり測っていたのは「転送速度」ではなく
 * 「転送+ワード毎のMFPポーリング」の速度で、結果はポーリング側に支配されて
 * いた(詳細: docs/StageE-2-3_実測_20260819.mdの訂正箇所)。
 *
 * 【今回の設計】ポーリングを内側ループから出し、poll_interval(引数)個の
 * コピー単位ごとに1回だけ MFP GPIP を読む形にする。
 *
 * 【呼び出し規約の罠(実測で発見)】m68k の GCC ABI では d2-d7/a2-a6 は
 * **呼び出され側が保存する(callee-saved)**レジスタである。最初の実装ではこれを
 * 保存せずに d2-d5(word/long版)や d5-d7/a2-a6(movem版)を作業用に使っていたため、
 * main_e3.c 側が for ループの変数(r, total_vsync_events)をこれらのレジスタに
 * 割り付けていた場合、2回目の呼び出しでそれが破壊され、ループ変数が意図しない
 * 値になって無限ループに陥っていた(実測: N_REPEATS=1では正常終了するが
 * N_REPEATS=2以上で3000フレーム経っても終了しなくなる、という形で発覚した。
 * host側のフレーム数上限に引っかかって気づいた)。呼び出し直後に引数を
 * a0/a1/d0/d1(すべて caller-saved)へ読み込み終えてから、作業用に使う
 * callee-saved レジスタだけをスタックへ push/pop することで解決した。
 *
 * 呼び出し規約: m68k-elf-gcc の既定(スタック渡し、cdecl相当)。
 *   4(%sp)  = dst  (GVRAM 側、vu16*)
 *   8(%sp)  = src  (メインメモリ側、vu16*)
 *  12(%sp)  = count(コピー単位の個数。word版=ワード数、long版=ロング数、
 *                    movem版=8ロング(32バイト)バッチ数)
 *  16(%sp)  = poll_interval(何コピー単位ごとに1回 MFP を読むか)
 * 戻り値(%d0) = 転送中に検出した垂直同期(GPIP bit4 立下りエッジ)の回数
 *
 * MFP GPIP のビット4の意味・立下りエッジ=垂直同期という判定基準は
 * Stage E-2 の実測(docs/StageE-2-3_実測_20260819.md)で確定した内容をそのまま使う。
 */

    .globl  e3_copy_word
    .globl  e3_copy_long
    .globl  e3_copy_movem
    .text

/* ---------- word版: MOVE.W (a1)+,(a0)+ を1コピー単位とする ---------- */
e3_copy_word:
    movea.l 4(%sp),%a0
    movea.l 8(%sp),%a1
    move.l  12(%sp),%d0     /* count (words)。引数読み終わるまでpushしない */
    move.l  16(%sp),%d1     /* poll_interval */
    movem.l %d2-%d5,-(%sp)  /* d2-d5 は callee-saved。作業用に使うので退避する */
    moveq   #0,%d2          /* vsync_events */
    move.b  0xE88001,%d3
    and.b   #0x10,%d3       /* prev level */
    move.l  %d1,%d4         /* countdown to next poll */
wl_loop:
    tst.l   %d0
    beq.s   wl_done
    move.w  (%a1)+,(%a0)+
    subq.l  #1,%d0
    subq.l  #1,%d4
    bne.s   wl_loop
    move.b  0xE88001,%d5
    and.b   #0x10,%d5
    cmp.b   %d3,%d5
    beq.s   wl_nopulse
    tst.b   %d3
    beq.s   wl_nopulse      /* 直前が0(帰線期間)からの立上りは数えない */
    addq.l  #1,%d2          /* 直前が1から0への立下り = 垂直同期1回 */
wl_nopulse:
    move.b  %d5,%d3
    move.l  %d1,%d4
    bra.s   wl_loop
wl_done:
    /* ループ末尾で poll_interval に届かなかった端数ぶんの最終ポーリング */
    move.b  0xE88001,%d5
    and.b   #0x10,%d5
    cmp.b   %d3,%d5
    beq.s   wl_ret
    tst.b   %d3
    beq.s   wl_ret
    addq.l  #1,%d2
wl_ret:
    move.l  %d2,%d0          /* 戻り値をd0へ(d0はcaller-savedなのでpop前でよい) */
    movem.l (%sp)+,%d2-%d5   /* 呼び出し元のd2-d5を復元 */
    rts

/* ---------- long版: MOVE.L (a1)+,(a0)+ を1コピー単位とする ---------- */
e3_copy_long:
    movea.l 4(%sp),%a0
    movea.l 8(%sp),%a1
    move.l  12(%sp),%d0     /* count (longs) */
    move.l  16(%sp),%d1
    movem.l %d2-%d5,-(%sp)
    moveq   #0,%d2
    move.b  0xE88001,%d3
    and.b   #0x10,%d3
    move.l  %d1,%d4
ll_loop:
    tst.l   %d0
    beq.s   ll_done
    move.l  (%a1)+,(%a0)+
    subq.l  #1,%d0
    subq.l  #1,%d4
    bne.s   ll_loop
    move.b  0xE88001,%d5
    and.b   #0x10,%d5
    cmp.b   %d3,%d5
    beq.s   ll_nopulse
    tst.b   %d3
    beq.s   ll_nopulse
    addq.l  #1,%d2
ll_nopulse:
    move.b  %d5,%d3
    move.l  %d1,%d4
    bra.s   ll_loop
ll_done:
    move.b  0xE88001,%d5
    and.b   #0x10,%d5
    cmp.b   %d3,%d5
    beq.s   ll_ret
    tst.b   %d3
    beq.s   ll_ret
    addq.l  #1,%d2
ll_ret:
    move.l  %d2,%d0
    movem.l (%sp)+,%d2-%d5
    rts

/* ---------- movem版: MOVEM.L で8ロング(32バイト)を1バッチとして読み書きする ----------
 * ループ状態(a0=dst, a1=src, d0=count, d1=poll_interval, d2=events, d3=prev,
 * d4=countdown)を破壊しないよう、コピーのペイロードには d5-d7/a2-a6 の8本だけを
 * 使う(8本 x 4バイト = 32バイト = ちょうど movem 1回ぶん)。
 * d2-d7/a2-a6 はすべて callee-saved なので、まとめて退避・復元する。
 * 68000 の MOVEM はレジスタ→メモリ方向でポストインクリメント((An)+)を使えない
 * ため、ストア側は制御アドレッシング(a0)のまま書き、その後 adda.l で32バイト
 * 進める。
 */
e3_copy_movem:
    movea.l 4(%sp),%a0
    movea.l 8(%sp),%a1
    move.l  12(%sp),%d0     /* count (8ロング=32バイトのバッチ数) */
    move.l  16(%sp),%d1
    movem.l %d2-%d7/%a2-%a6,-(%sp)
    moveq   #0,%d2
    move.b  0xE88001,%d3
    and.b   #0x10,%d3
    move.l  %d1,%d4
ml_loop:
    tst.l   %d0
    beq.s   ml_done
    movem.l (%a1)+,%d5-%d7/%a2-%a6
    movem.l %d5-%d7/%a2-%a6,(%a0)
    adda.l  #32,%a0
    subq.l  #1,%d0
    subq.l  #1,%d4
    bne.s   ml_loop
    move.b  0xE88001,%d5
    and.b   #0x10,%d5
    cmp.b   %d3,%d5
    beq.s   ml_nopulse
    tst.b   %d3
    beq.s   ml_nopulse
    addq.l  #1,%d2
ml_nopulse:
    move.b  %d5,%d3
    move.l  %d1,%d4
    bra.s   ml_loop
ml_done:
    move.b  0xE88001,%d5
    and.b   #0x10,%d5
    cmp.b   %d3,%d5
    beq.s   ml_ret
    tst.b   %d3
    beq.s   ml_ret
    addq.l  #1,%d2
ml_ret:
    move.l  %d2,%d0
    movem.l (%sp)+,%d2-%d7/%a2-%a6
    rts
