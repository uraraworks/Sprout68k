/* Sprout68k 共有ランタイムの起動コード（第1版）。
 *
 * ブートセクタは通常ビルドと同じく RUNTIME_BASE($3000) へ JMP してくる。
 * そこには生成物 runtime/generated/jumptable_v1.S の BRA.W があり、ここへ来る。
 *
 * やること:
 *   1. スタックを設定する
 *   2. ランタイムの .bss（512KBの裏バッファを含む）をゼロクリアする
 *   3. USER_BASE に置かれた利用者ペイロードのヘッダを検査する
 *   4. 利用者コードの後ろ〜USER_LIMIT をゼロクリアする（利用者の .bss になる）
 *   5. 利用者コードのエントリを呼ぶ
 *
 * 利用者ペイロードのヘッダ（12バイト、tools/pack_user.py が付ける）:
 *   +0  'S68K'  マジック
 *   +4  u16     ABI版
 *   +6  u16     予約(0)
 *   +8  u32     本体のバイト数（ヘッダを含まない）
 *   +12 本体（先頭が利用者コードのエントリ）
 *
 * ヘッダを検査するのは、版の取り違えや壊れたURLで**もっともらしく動いて
 * しまう**ことを防ぐため。合わなければ黙って進まず、画面に理由を出して止まる。
 */
#if !defined(STACK_ADDR) || !defined(USER_BASE) || !defined(USER_LIMIT) || !defined(ABI_VERSION)
#error "STACK_ADDR / USER_BASE / USER_LIMIT / ABI_VERSION must be defined by the build script"
#endif

#define USER_MAGIC 0x5336384B          /* 'S' '6' '8' 'K' */
#define USER_HEADER_SIZE 12

    .globl  runtime_start
    .text
runtime_start:
    lea     STACK_ADDR,%sp

    /* 2. ランタイムの .bss をゼロクリア */
    lea     __bss_start,%a0
    lea     __bss_end,%a1
1:
    cmp.l   %a1,%a0
    bge.s   2f
    clr.b   (%a0)+
    bra.s   1b
2:

    /* 3. 利用者ペイロードのヘッダ検査 */
    lea     USER_BASE,%a0
    move.l  (%a0)+,%d0
    cmp.l   #USER_MAGIC,%d0
    bne     bad_magic
    move.w  (%a0)+,%d0
    cmp.w   #ABI_VERSION,%d0
    bne     bad_version
    addq.l  #2,%a0                     /* 予約 */
    move.l  (%a0)+,%d1                 /* 本体のバイト数。ここで %a0 は本体の先頭 */
    /* 本体が利用者領域に収まっているか（壊れたURLで巨大な値が入る場合がある） */
    move.l  %a0,%d2
    add.l   %d1,%d2
    cmp.l   #USER_LIMIT,%d2
    bhi     bad_size
    tst.l   %d1
    beq     bad_size

    /* 4. 本体の後ろ〜USER_LIMIT をゼロクリア（利用者の .bss になる） */
    move.l  %d2,%a1
    lea     USER_LIMIT,%a2
3:
    cmp.l   %a2,%a1
    bge.s   4f
    clr.b   (%a1)+
    bra.s   3b
4:

    /* 5. 利用者コードへ */
    jsr     (%a0)

halt:
    bra.s   halt

bad_magic:
    pea     msg_bad_magic(%pc)
    bra.s   report
bad_version:
    pea     msg_bad_version(%pc)
    bra.s   report
bad_size:
    pea     msg_bad_size(%pc)
report:
    jsr     x68_iocs_print
    addq.l  #4,%sp
    bra.s   halt

    .section .rodata
msg_bad_magic:
    .asciz  "SPROUT68K: PAYLOAD NOT FOUND"
msg_bad_version:
    .asciz  "SPROUT68K: RUNTIME VERSION MISMATCH"
msg_bad_size:
    .asciz  "SPROUT68K: PAYLOAD SIZE OUT OF RANGE"
    .even
