/* X68kDev L0: メインメモリ→GVRAM の高速コピー(MOVEM.L 8本/バッチ)。
 *
 * stage_e/src/e3_copy.S の e3_copy_movem(rev3、確定版)をそのまま流用し、
 * シンボル名だけ x68_gvram_copy_movem に変えたもの。挙動・callee-saved
 * レジスタ(d5-d7/a2-a6)の退避/復帰はすべて維持している。**この退避を
 * 忘れると呼び出し元のループ変数を破壊して無限ループになるバグを
 * Stage E-3 で実際に踏んでいる**(e3_copy.S 冒頭コメント参照)。
 *
 * 68000 の MOVEM はレジスタ→メモリ方向でポストインクリメント((An)+)を
 * 使えないため、ストア側は制御アドレッシング(a0)のまま書き、その後
 * adda.l で32バイト進める。
 *
 * 呼び出し規約: m68k-elf-gcc の既定(スタック渡し)。
 *   4(%sp)  = dst          (GVRAM側)
 *   8(%sp)  = src           (メインメモリ側)
 *  12(%sp)  = batch_count    (8ロング=32バイトのバッチ数)
 * 戻り値なし。
 */
    .globl  x68_gvram_copy_movem
    .text
x68_gvram_copy_movem:
    movea.l 4(%sp),%a0
#ifdef X68_FAULT_GVRAM_COPY_OFFSET
    adda.l  #2,%a0           /* 故障注入: 転送先を1ワード(2バイト)ずらす */
#endif
    movea.l 8(%sp),%a1
    move.l  12(%sp),%d0     /* count (8ロング=32バイトのバッチ数) */
    movem.l %d5-%d7/%a2-%a6,-(%sp)
gc_loop:
    tst.l   %d0
    beq.s   gc_ret
    movem.l (%a1)+,%d5-%d7/%a2-%a6
    movem.l %d5-%d7/%a2-%a6,(%a0)
    adda.l  #32,%a0
    subq.l  #1,%d0
    bra.s   gc_loop
gc_ret:
    movem.l (%sp)+,%d5-%d7/%a2-%a6
    rts
