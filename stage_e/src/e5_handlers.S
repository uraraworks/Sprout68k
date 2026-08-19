/* Stage E-5: 例外ハンドラ本体 + 例外の意図的な発生(トリガ)。
 *
 * 【設計方針】
 * どのハンドラも「HOSTVAR_MARKERへ捕捉した例外種別ごとの印を書く」
 * →「GVRAM先頭ワードへ種別ごとに異なる色を書く(画面表示)」→「IOCS $21で
 * 文字列を表示する」→「無限ループで停止する」という共通の形にした。
 * RTEで元の実行へは戻さない(学習用APIの設計原則3「暴走は静かに固まるのでは
 * なく、見える形で止まる」を素直に実装すると、例外発生地点へ復帰する必要は
 * なく、そこで安全に停止して知らせることが目的そのものになるため)。
 *
 * RTEで戻らない設計にしたことで、68000のスタックフレーム形式の違いを
 * 一切気にしなくてよくなる: アドレスエラー(vector3)は68000では
 * SR/PC に加えて命令レジスタ・アクセスアドレス・詳細ワードが付く可変長寄りの
 * フレーム(合計7ワード)、不正命令(vector4)・ゼロ除算(vector5)はSR/PCのみの
 * 固定3ワードフレームで、両者は異なる。RTEしないのでこの違いを解析する
 * 必要が無い(cache_flush.S で確立した「フレームを解析しない」設計をここでも
 * 踏襲した)。
 *
 * HOSTVAR_MARKER(0x000E0030, word)に書く値は種別ごとに異なる固定値にして
 * ある。host側はこの値を見て「そもそも捕捉されたか」「どの種別が捕捉された
 * とhost自身が判定できるか(3種の弁別)」を確認する。
 *
 * GVRAM先頭ワード(0x00C00000)に書く色も種別ごとに異ならせてある(赤/緑/青)。
 * host側はCRTC R20=$08 / VC R0=$03 / VC R2=$01(main_e5.cが起動時に設定する、
 * Stage B/C/E-1と同じ65536色1ページモード)の下でこのアドレスをpeekWordし、
 * 「ハンドラから画面表示ができるか」を実測する(GVRAM直書きの経路。
 * IOCS $21 経由の文字列表示も同時に行うが、そちらはビットマップフォント
 * 描画でhost側から値として検証するのが煩雑なため、判定の主経路にはしない)。
 */
    .globl  e5_addr_error_handler
    .globl  e5_illegal_handler
    .globl  e5_zerodiv_handler
    .globl  e5_trigger_addr_error
    .globl  e5_trigger_illegal
    .globl  e5_trigger_zerodiv

    .text

/* ---- ハンドラ ---- */

e5_addr_error_handler:
    move.w  #0xE501,0x000E0030     /* HOSTVAR_MARKER: アドレスエラー捕捉の印 */
    move.w  #0xF800,0x00C00000     /* GVRAM先頭ワードを赤に */
    lea     e5_msg_addr_err,%a1
    moveq   #0x21,%d0
    trap    #15
e5_addr_error_halt:
    bra.s   e5_addr_error_halt

e5_illegal_handler:
    move.w  #0xE502,0x000E0030     /* HOSTVAR_MARKER: 不正命令捕捉の印 */
    move.w  #0x07E0,0x00C00000     /* GVRAM先頭ワードを緑に */
    lea     e5_msg_illegal,%a1
    moveq   #0x21,%d0
    trap    #15
e5_illegal_halt:
    bra.s   e5_illegal_halt

e5_zerodiv_handler:
    move.w  #0xE503,0x000E0030     /* HOSTVAR_MARKER: ゼロ除算捕捉の印 */
    move.w  #0x001F,0x00C00000     /* GVRAM先頭ワードを青に */
    lea     e5_msg_zerodiv,%a1
    moveq   #0x21,%d0
    trap    #15
e5_zerodiv_halt:
    bra.s   e5_zerodiv_halt

/* ---- 例外を意図的に起こすトリガ ---- */
/* 捕捉できれば rts には到達しない(ハンドラ側が無限ループで止まるため)。
 * 捕捉できなかった場合(ハンドラ未差し替え、または想定外の復帰)にだけ
 * rts が実行され、main() 側のループへ戻る。 */

e5_trigger_addr_error:
    move.w  #0,1                    /* 奇数アドレス(1番地)へワードアクセス→アドレスエラー(vector3) */
    rts

e5_trigger_illegal:
    illegal                          /* 68000/68030双方で不正命令(vector4)と規定される専用命令 */
    rts

e5_trigger_zerodiv:
    moveq   #0,%d1
    divu    %d1,%d0                  /* ゼロ除算(vector5)。D0の内容は不問(ゼロ除算自体が例外条件) */
    rts

    .align 2
e5_msg_addr_err:
    .ascii "STAGE E5: ADDRESS ERROR CAUGHT"
    .byte  0
    .align 2
e5_msg_illegal:
    .ascii "STAGE E5: ILLEGAL INSTRUCTION CAUGHT"
    .byte  0
    .align 2
e5_msg_zerodiv:
    .ascii "STAGE E5: ZERO DIVIDE CAUGHT"
    .byte  0
