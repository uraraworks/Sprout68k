/* 自動生成（tools/build_abi.mts）。手で編集しない。
 * 利用者コードのリンク時に INCLUDE する。ライブラリ関数の呼び出しを
 * ランタイムのジャンプテーブルの絶対番地へ解決するためのもの。
 * これがあるので利用者コードにライブラリ本体が入らない（＝URLに載る）。
 */
PROVIDE(x68_screen_open = 0x003008);
PROVIDE(x68_screen_flip = 0x00300e);
PROVIDE(x68_cls = 0x003014);
PROVIDE(x68_frame_begin = 0x00301a);
PROVIDE(x68_pset = 0x003020);
PROVIDE(x68_pget = 0x003026);
PROVIDE(x68_box_fill = 0x00302c);
PROVIDE(x68_box = 0x003032);
PROVIDE(x68_line = 0x003038);
PROVIDE(x68_circle = 0x00303e);
PROVIDE(x68_rgb = 0x003044);
PROVIDE(x68_key_down = 0x00304a);
PROVIDE(x68_locate = 0x003050);
PROVIDE(puts = 0x003056);
PROVIDE(printf = 0x00305c);
PROVIDE(memcpy = 0x003062);
PROVIDE(memset = 0x003068);
PROVIDE(strlen = 0x00306e);
PROVIDE(abs = 0x003074);
PROVIDE(srand = 0x00307a);
PROVIDE(rand = 0x003080);
PROVIDE(x68_rand_int = 0x003086);
PROVIDE(x68_iocs_print = 0x00308c);
PROVIDE(x68_iocs_locate = 0x003092);
PROVIDE(x68_iocs_bitsns = 0x003098);
PROVIDE(x68_iocs_disk_read = 0x00309e);
PROVIDE(x68_vsync_wait = 0x0030a4);
PROVIDE(x68_gvram_mode_65536_1page = 0x0030aa);
PROVIDE(x68_gvram_copy_movem = 0x0030b0);
