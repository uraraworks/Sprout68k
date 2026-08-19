/* C から叩ける最小の IOCS スタブ。TRAP #15 を叩くだけ。
 * void iocs_print(const char *msg);  // IOCS $21: 文字列表示(A1=文字列ポインタ)
 */
    .globl  iocs_print
    .text
iocs_print:
    move.l  4(%sp),%a1
    moveq   #0x21,%d0
    trap    #15
    rts
