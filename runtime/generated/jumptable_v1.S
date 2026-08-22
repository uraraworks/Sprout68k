/* 自動生成（tools/build_abi.mts）。手で編集しない。
 * 元は runtime/abi_v1.txt と runtime/layout_v1.txt。
 *
 * ランタイム本体の先頭に置く。並びがそのまま公開ABIなので、
 * 既存の行を動かすと過去に共有されたリンクが全部壊れる。
 */
    .section .abi_header,"ax"
    .globl  _abi_header
_abi_header:
    bra.w   runtime_start           /* 0x003000 起動時にブートセクタが飛んでくる */
    .word   1                       /* 0x003004 ABI版 */
    .word   0                       /* 0x003006 予約 */
                                    /* 0x003008 ここからジャンプテーブル */
    jmp     x68_screen_open         /* 0x003008 [0] */
    jmp     x68_screen_flip         /* 0x00300e [1] */
    jmp     x68_cls                 /* 0x003014 [2] */
    jmp     x68_frame_begin         /* 0x00301a [3] */
    jmp     x68_pset                /* 0x003020 [4] */
    jmp     x68_pget                /* 0x003026 [5] */
    jmp     x68_box_fill            /* 0x00302c [6] */
    jmp     x68_box                 /* 0x003032 [7] */
    jmp     x68_line                /* 0x003038 [8] */
    jmp     x68_circle              /* 0x00303e [9] */
    jmp     x68_rgb                 /* 0x003044 [10] */
    jmp     x68_key_down            /* 0x00304a [11] */
    jmp     x68_locate              /* 0x003050 [12] */
    jmp     puts                    /* 0x003056 [13] */
    jmp     printf                  /* 0x00305c [14] */
    jmp     memcpy                  /* 0x003062 [15] */
    jmp     memset                  /* 0x003068 [16] */
    jmp     strlen                  /* 0x00306e [17] */
    jmp     abs                     /* 0x003074 [18] */
    jmp     srand                   /* 0x00307a [19] */
    jmp     rand                    /* 0x003080 [20] */
    jmp     x68_rand_int            /* 0x003086 [21] */
    jmp     x68_iocs_print          /* 0x00308c [22] */
    jmp     x68_iocs_locate         /* 0x003092 [23] */
    jmp     x68_iocs_bitsns         /* 0x003098 [24] */
    jmp     x68_iocs_disk_read      /* 0x00309e [25] */
    jmp     x68_vsync_wait          /* 0x0030a4 [26] */
    jmp     x68_gvram_mode_65536_1page /* 0x0030aa [27] */
    jmp     x68_gvram_copy_movem    /* 0x0030b0 [28] */
