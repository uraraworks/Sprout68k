/* Stage C 用の最小 crt0。
 *
 * ブートセクタ側で A7(スタック)を既に $B000 に設定した状態でここへ JMP してくる
 * 前提だが、保険としてここでも同じ値を入れ直す。
 * BSSセクタをゼロクリアしてから main() を呼ぶ。C ライブラリは使わない
 * (newlib 等は一切リンクしない。freestanding + nostdlib)。
 */
    .globl  _start
    .text
_start:
    lea     0xB000,%sp

    /* .bss をゼロクリア(リンカスクリプトで __bss_start/__bss_end を定義) */
    lea     __bss_start,%a0
    lea     __bss_end,%a1
1:
    cmp.l   %a1,%a0
    bge.s   2f
    clr.b   (%a0)+
    bra.s   1b
2:
    jsr     main

halt:
    bra.s   halt
