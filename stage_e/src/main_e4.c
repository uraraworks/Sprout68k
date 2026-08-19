/* Stage E-4 テストプログラム(C)。
 *
 * 目的: 学習用 API の key_down(key)(押されている間ずっと真になる判定)を実装する
 * ための下地として、ゲスト側からキーの「押しっぱなし」状態(レベル)を読む手段を
 * 実測で確定する。
 *
 * 【読み取り手段の候補(解読、実測前)】
 * IOCS $04 = BITSNS。D1.W にキーコードグループ(0〜$f)を渡し TRAP #15、
 * D0.B にそのグループ8キー分の押下ビットパターン(1=押されている)が返る、という
 * 規約が datacrystal.tcrf.net(X68k/IOCS)・retropc.net(IOCSコール一覧)の記述として
 * 見つかった。グループとスキャンコードの対応は「group = scancode/8、
 * bit = scancode%8」(retropc.netの解説記事にある実例: Aキー scancode=0x1E は
 * group3・bit6 = 3*8+6=30=0x1E、と整合)。この規約に基づく直接メモリ参照
 * ($800+group、16バイトのワークエリア)の存在も文献にはあるが、本プログラムは
 * まず IOCS コール経由(レジスタ規約が明確)の方だけを使う。
 *
 * これらは全て「解読で得た候補」であり、このプログラムの実行結果(host側が
 * verify/verify_e4.mts で観測する)によって実測されるまでは未確定として扱う。
 *
 * 使うキーのスキャンコード(px68k-libretro libretro.c のキーマップ表で確認できる
 * 実装済みの定数。これはソースコードそのものであり解読ではないが、実際に
 * 押した結果がBITSNSへ反映されるかは別途実測が要る):
 *   LEFT=0x3b(group7 bit3) UP=0x3c(group7 bit4) RIGHT=0x3d(group7 bit5)
 *   DOWN=0x3e(group7 bit6) SPACE=0x35(group6 bit5)
 *
 * 動作: 無限ループで group7・group6 の BITSNS 結果を毎回読み、固定アドレスへ
 * 書き続ける。host側は runFrame() を1回呼ぶごとにこれらのバイトを peekByte() で
 * 読み、押下/離鍵/弁別/押し直しを判定する。
 *
 * newlib は使わない。ヒープも使わない。フリースタンディング。
 */
typedef volatile unsigned char vu8;
typedef volatile unsigned long vu32;

/* host側が peekByte()/peekWord() で監視する固定アドレス。他ステージ(E-1〜E-3)の
 * HOSTVAR($E0000/$E0010/$E0020)と重ならない範囲を新規に割り当てる
 * (同一セッションで同居させることは無いが、混乱防止のため別範囲にする)。 */
#define HOSTVAR_GROUP7 (*(vu8 *)0x000E0040) /* BITSNS group7 の生の戻り値 */
#define HOSTVAR_GROUP6 (*(vu8 *)0x000E0041) /* BITSNS group6 の生の戻り値 */
#define HOSTVAR_POLLS  (*(vu32 *)0x000E0044) /* ループが実際に回っていることの生存確認カウンタ */

extern unsigned char iocs_bitsns(unsigned long group);

void main(void) {
    unsigned long n;

    /* IPLからここへ到達した時点のSR割り込みマスクは boot.S/crt0.S のどちらでも
     * 変更していないため不明。キーのmake/breakはMFP割り込み(MFP_Int(3)、
     * px68k-libretro libretro.c で1フレームあたり4回 Keyboard_Int() が呼ばれる
     * 経路)経由でIOCSのキー状態テーブルへ反映される想定のため、割り込みマスクが
     * 塞がっていると BITSNS が更新されない恐れがある。明示的にマスクレベル0へ
     * 下げ、全レベルの割り込みを受け付ける状態にしてから計測する。 */
    __asm__ volatile ("move.w #0x2000,%%sr" ::: "cc");

    HOSTVAR_GROUP7 = 0;
    HOSTVAR_GROUP6 = 0;
    n = 0;
    HOSTVAR_POLLS = n;

    for (;;) {
        HOSTVAR_GROUP7 = iocs_bitsns(7);
        HOSTVAR_GROUP6 = iocs_bitsns(6);
        n++;
        HOSTVAR_POLLS = n;
    }
}
