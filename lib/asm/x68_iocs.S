/* X68kDev L0: IOCS 呼び出しの薄いラッパ(TRAP #15 を叩くだけ)。
 *
 * レジスタ規約は docs/StageE-*.md で実測済みの値をそのまま使う。既存の
 * stage_c/crt0/iocs.S(iocs_print)・stage_e/src/e4_bitsns.S(iocs_bitsns)・
 * stage_e/src/iocs_e6.S(iocs_locate)と同じ実装を x68_ 接頭辞の名前で
 * 焼き直したもの(挙動は変えていない。既存の stage_c/stage_e 側の実装・
 * 検証は壊さないためファイルは複製し、シンボル名だけ変える)。
 * IOCS $46(ディスク読み込み)は stage_c/boot/boot.S・stage_d/boot/boot.S の
 * ブートセクタが使っているレジスタ規約(D1/D2/D3/A1)をCから呼べるように
 * 新規に追加した。
 *
 * 呼び出し規約: m68k-elf-gcc の既定(スタック渡し、cdecl相当)。
 */
    .globl  x68_iocs_print
    .globl  x68_iocs_locate
    .globl  x68_iocs_bitsns
    .globl  x68_iocs_disk_read
    .text

/* void x68_iocs_print(const char *msg);  IOCS $21(A1=文字列ポインタ) */
x68_iocs_print:
    move.l  4(%sp),%a1
    moveq   #0x21,%d0
    trap    #15
    rts

/* void x68_iocs_locate(int col, int row);  IOCS $23(D1.L=col, D2.L=row)
 * D2 は callee-saved(m68k SVR4 ABI)なので退避してから使う
 * (stage_e/src/iocs_e6.S で実測発見した罠。退避を忘れると呼び出し元の
 * ループ変数等を無言で壊す)。 */
x68_iocs_locate:
    move.l  %d2,-(%sp)
    move.l  8(%sp),%d1   /* col(pushでspが4進んだ分オフセットがずれる) */
    move.l  12(%sp),%d2  /* row */
    moveq   #0x23,%d0
    trap    #15
    move.l  (%sp)+,%d2
    rts

/* unsigned char x68_iocs_bitsns(unsigned long group);
 * IOCS $04(D1.W=グループ、戻り値D0.B=8キー分の押下ビットパターン) */
x68_iocs_bitsns:
#ifdef X68_FAULT_BITSNS_ALWAYS_ZERO
    moveq   #0,%d0            /* 故障注入: 常に0(押下無し)を返す */
    rts
#endif
    move.l  4(%sp),%d1
    moveq   #4,%d0
    trap    #15
    and.l   #0xff,%d0
    rts

/* long x68_iocs_disk_read(unsigned long d1, unsigned long d2,
 *                          unsigned long byte_count, void *dst);
 * IOCS $46(D1/D2/D3/A1。stage_c/boot/boot.S・stage_d/boot/boot.S と同じ規約)。
 * 戻り値はD0そのまま(呼び出し元が -1 判定を行う)。 */
x68_iocs_disk_read:
    movea.l 16(%sp),%a1
    move.l  4(%sp),%d1
    move.l  8(%sp),%d2
    move.l  12(%sp),%d3
    moveq   #0x46,%d0
    trap    #15
    rts
