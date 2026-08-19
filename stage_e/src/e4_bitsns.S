/* Stage E-4: IOCS $04 (BITSNS) 呼び出し規約(解読候補)。
 *
 * 文献(datacrystal.tcrf.net の X68k/IOCS、retropc.net の IOCS コール一覧)による
 * 規約:
 *   D0.L = 4 (関数番号)
 *   D1.W = キーコードグループ(0〜$f)
 *   TRAP #15
 *   戻り値: D0.B = そのグループ8キー分の押下ビットパターン(1=押されている)
 *
 * これは解読で得た候補であり、実測(verify/verify_e4.mts)で確認するまでは
 * 未確定として扱う(main_e4.c 冒頭コメント参照)。
 *
 * 呼び出し規約: m68k-elf-gcc の既定(スタック渡し)。
 *   4(%sp) = group(unsigned long として渡す。IOCSが見るのはD1の下位ワードのみの
 *            はずだが、上位ワードも未定義動作を避けるため呼び出し側でゼロクリア
 *            して渡す)
 * 戻り値: D0(下位バイトのみ有効。呼び出し元でunsigned charとして扱う)
 */
    .globl  iocs_bitsns
    .text
iocs_bitsns:
    move.l  4(%sp),%d1
    moveq   #4,%d0
    trap    #15
    and.l   #0xff,%d0
    rts
