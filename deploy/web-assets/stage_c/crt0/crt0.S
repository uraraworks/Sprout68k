/* Stage C 用の最小 crt0。
 *
 * ブートセクタ側で A7(スタック)を既に STACK_ADDR に設定した状態でここへ JMP してくる
 * 前提だが、保険としてここでも同じ値を入れ直す。STACK_ADDR はビルドスクリプトが
 * -D で埋め込む(本体ロードアドレス $3000 と衝突しない、RAM内の固定アドレス。
 * 2026-08-19: 旧 $B000 は本体サイズが32KB以上になるとロード先($3000〜)と衝突する
 * ことが判明したため、本体サイズに依存しない高位アドレスへ変更した。
 * 詳細は docs/toolchain調査.md および tools/build_stage_c.sh のチェックを参照)。
 * BSSセクタをゼロクリアしてから main() を呼ぶ。C ライブラリは使わない
 * (newlib 等は一切リンクしない。freestanding + nostdlib)。
 */
#ifndef STACK_ADDR
#error "STACK_ADDR must be defined by the build script (-DSTACK_ADDR=...)"
#endif
    .globl  _start
    .text
_start:
    lea     STACK_ADDR,%sp

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
