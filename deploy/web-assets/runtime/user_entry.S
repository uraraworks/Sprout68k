/* 利用者コードの入口。共有ペイロードの本体先頭（USER_BASE+12）に必ずこれが来る
 * ようリンク順で最初に置く（.text.entry セクション）。ランタイムはこの番地を
 * JSR するだけで、利用者側の main の位置を知らなくてよい。
 */
    .section .text.entry,"ax"
    .globl  _user_entry
_user_entry:
    jsr     main
    rts
