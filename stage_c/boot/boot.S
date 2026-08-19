/* Stage C ブートセクタ(複数セクタ対応)。
 *
 * IOCS $46(ディスク読み込み)のレジスタ規約は、本プロジェクトの過去の背景資料が
 * 「A0=転送先」としていたが、これは実測(px68k上での動作確認)で誤りと判明した。
 * 実際に確定した規約は以下(実測: verify/verify_iocs46.mts、および
 * ../docs/toolchain調査.md の隣接ドキュメント参照。datacrystal.tcrf.net の
 * X68k/IOCS ページの構造記述と付き合わせて一致を確認済み):
 *
 *   D1.L: 上位バイト(bit31-24)= PDA(物理ドライブアドレス)。2HD-FD ドライブ0 = $90。
 *         下位バイト(bit7-0) = モード。bit6=MFM, bit5=リトライ, bit4=シーク
 *         (実測で $70 = MFM+リトライ+シークの組み合わせが成功することを確認)
 *   D2.L: bit31-24 = セクタ長コード(3=1024バイト)
 *         bit23-16 = トラック番号(0起点)
 *         bit15-8  = サイド(0/1)
 *         bit7-0   = セクタ番号(1起点)
 *   D3.L: 読み込むバイト数(単純なバイト数。複数セクタをまたいでもOKと実測で確認)
 *   A1.L: 転送先バッファアドレス(A0 ではなく A1)
 *   戻り値 D0.L: 0=成功、$FFFFFFFF=エラー(実測)
 *
 * このブートセクタは、ボディ本体のセクタ数(SECTOR_COUNT)をビルド時にアセンブラの
 * -D で埋め込み、track0/side0/sector2 から連続 SECTOR_COUNT セクタぶんを $3000 へ
 * 読み込んでから JMP する。エラー時は文字列を表示して停止する。
 */
    .globl  _start
    .text
_start:
    bra.s   1f
    .ascii  "X68DEVC0"
1:
    lea     0xB000,%a7

    move.l  #0x00009070,%d1        /* PDA=$90(FDD0), mode=$70(MFM+retry+seek) */
    move.l  #0x03000002,%d2        /* セクタ長コード3, track0,side0,sector2 */
    move.l  #(SECTOR_COUNT * 1024),%d3       /* 読み込みバイト数 */
    lea     0x3000,%a1
    moveq   #0x46,%d0
    trap    #15

    cmpi.l  #-1,%d0
    beq.s   read_error

    jmp     0x3000

read_error:
    lea     err_msg,%a1
    moveq   #0x21,%d0
    trap    #15
halt:
    bra.s   halt

    .align 2
err_msg:
    .ascii  "STAGE C: DISK READ ERROR"
    .byte   0
