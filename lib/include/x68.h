/* X68kDev 学習用ライブラリ 第一版 単一ヘッダ (2026-08-19)
 *
 * 位置づけ: docs/API設計_20260819.md の2層構成のうち、本ヘッダは
 *   - L0(生層): 実測済みの事実の薄いラッパ(x68_ 接頭辞、整形はしない)
 *   - 標準名の層: C 標準に同じ意味のものがある関数は標準の名前とシグネチャに
 *     合わせる(memcpy/memset/strlen/abs/srand/rand/puts/printf)
 * の2つだけを提供する。**L1(x68_cls/x68_screen_flip/描画プリミティブ等の
 * 入門者向けAPI)はこのヘッダにはまだ無い。次回作業で追加する。**
 *
 * この環境は -ffreestanding -nostdlib(C標準ライブラリ・newlib 一切無し)の
 * ため、ここで宣言する標準名の関数はすべて自前実装(lib/src/x68_std.c)。
 * 名前とシグネチャだけ本物の C 標準ライブラリに合わせてあり、本物とリンクは
 * できない(挙動もこのヘッダ末尾に明記した制約の範囲に絞ってある)。
 *
 * レジスタ規約・アドレス等はすべて docs/StageE-*.md で実測済みの値を使う。
 * このヘッダ自身が新たに書き下ろした未実測の値は無い(すべて既存資料からの
 * 転記)。
 */
#ifndef X68_H
#define X68_H

typedef volatile unsigned char  x68_vu8;
typedef volatile unsigned short x68_vu16;
typedef volatile unsigned long  x68_vu32;

/* ============================================================
 * L0(生層): 実測済みの事実そのままの薄いラッパ。
 * L1 とテストプログラムが使う内部層で、入門者向けの整形はしていない
 * (範囲外チェック・クリップは一切しない。呼び出し側の責任)。
 * ============================================================ */

/* IOCS $21(文字列表示)。docs/API設計_20260819.md より、Stage A/C で実測済みの
 * 呼び出し規約(A1=文字列ポインタ)をそのまま使う。ヌル終端文字列を渡す。 */
void x68_iocs_print(const char *msg);

/* IOCS $23(位置指定。B_LOCATE)。D1.L=桁(col)、D2.L=行(row)。
 * Stage E-6 で実測確定(docs/StageE-6_実測_20260819.md)。座標系は96桁x32行。
 * 範囲外座標はハードウェア側が無視する(実測済み。追加のクリップ不要)。 */
void x68_iocs_locate(int col, int row);

/* IOCS $04(BITSNS)。D1.W=キーコードグループ(0〜$f)、戻り値(D0.B)=そのグループ
 * 8キー分の押下ビットパターン(1=押されている)。Stage E-4 で実測確定
 * (docs/StageE-4_実測_20260819.md)。 */
unsigned char x68_iocs_bitsns(unsigned long group);

/* IOCS $46(ディスク読み込み)。stage_c/boot/boot.S・stage_d/boot/boot.S で
 * ブートセクタが使っているのと同じレジスタ規約をそのままCから叩けるように
 * したもの。
 *   d1       = D1(PDA<<8 | mode。例: 0x00009070 = PDA=$90(FDD0), mode=$70)
 *   d2       = D2(seclen<<24 | track<<16 | side<<8 | sector。seclen=3が1024バイト
 *              セクタ。track/sideは0起点、sectorは1起点)
 *   byte_count = D3(転送バイト数)
 *   dst      = A1(転送先)
 * 戻り値はD0そのまま。stage_d/boot/boot.S のコメントに実測記録がある通り、
 * D0は成功時でも0以外の値を返すことがある(原因未確認)。**エラー判定は
 * 「D0 == -1(0xFFFFFFFF)のときだけエラー」とすること**(ブートセクタと同じ
 * 判定基準)。 */
long x68_iocs_disk_read(unsigned long d1, unsigned long d2,
                         unsigned long byte_count, void *dst);

/* 垂直同期待ち。MFP GPIP($00E88001) bit4 の立下りエッジを検出する
 * (Stage E-2 で実測確定。docs/StageE-2-3_実測_20260819.md)。呼び出すたびに
 * 表示期間→帰線期間の遷移を1回待つ。 */
void x68_vsync_wait(void);

/* 65536色1ページモード(512x512、GVRAM $00C00000起点、1ライン=512ワード)を
 * 設定する。CRTC R20=$08 / VC R0=$03 / VC R2=$01 の3レジスタを実測済みの
 * 順序・値のまま設定する(Stage B/E-1 で実測確定。docs/StageE-1_実測_20260819.md)。
 * 裏バッファの確保・転送量の管理はしない(L1の仕事)。 */
void x68_gvram_mode_65536_1page(void);

/* メインメモリ→GVRAM の高速コピー(MOVEM.L 8本を1バッチ=32バイトとする)。
 * stage_e/src/e3_copy.S の e3_copy_movem をそのまま流用した実装
 * (lib/asm/x68_gvram_copy.S)。**callee-saved レジスタ(d5-d7/a2-a6)の退避を
 * 維持している。これを忘れると無限ループになるバグを Stage E-3 で踏んでいる**
 * (このファイルの実装では退避済み。改変する場合は要注意)。
 *   dst          = 転送先(GVRAM等、volatile unsigned short* 相当)
 *   src          = 転送元(メインメモリ)
 *   batch_count  = 8ロング(32バイト)単位のバッチ数(バイト数ではない) */
void x68_gvram_copy_movem(void *dst, const void *src, unsigned long batch_count);

/* ============================================================
 * 標準名の層: C 標準に同じ意味のものがあるものは、標準の名前と
 * シグネチャに合わせる(docs/API設計_20260819.md「命名規則」節)。
 * -nostdlib のフリースタンディング環境のため実装はすべて自前
 * (lib/src/x68_std.c)。挙動は下記「対応/非対応」の範囲に絞ってある。
 * ============================================================ */

void *memcpy(void *dst, const void *src, unsigned long n);
void *memset(void *dst, int c, unsigned long n);
unsigned long strlen(const char *s);
int abs(int n);

/* 疑似乱数(単純な線形合同法。暗号用途には使わない)。 */
#define X68_RAND_MAX 0x7fff
void srand(unsigned int seed);
int rand(void);

/* puts: 標準と同じく、s の内容を出力した後に必ず改行を1つ追加する
 * (s 自身が改行で終わっていなくても追加する。標準Cのputsと同じ挙動)。
 * 出力先はテキスト画面(IOCS $21経由)。 */
int puts(const char *s);

/* printf 第一版の対応/非対応(これが全て。ここに無いものは非対応):
 *
 *   対応する変換指定子: %d %u %x %c %s %%
 *     %d  int を符号付き10進数で出力
 *     %u  unsigned int を符号無し10進数で出力
 *     %x  unsigned int を符号無し16進数で出力(小文字a-f、先頭ゼロ埋め無し)
 *     %c  int を1文字として出力
 *     %s  const char* を文字列として出力
 *     %%  '%' 1文字を出力
 *
 *   非対応(下記のいずれかに出会ったら、その場に目に見えるマーカー文字列
 *   "[BADFMT]" を出力して処理を続ける。黙って無視したり誤動作したりはしない):
 *     - 浮動小数点(%f %e %g 等)
 *     - 幅指定・0埋め・精度指定(%3d %02x %.2s 等、%の直後に数字や'.'がある形)
 *     - 長さ修飾子(%ld %lu %lld 等、%の直後に'l'/'h'等がある形)
 *     - 上記以外の未知の変換指定子(%q 等)
 *     - フォーマット文字列が '%' で終わっている(直後に指定子が無い)
 *
 *   出力先はテキスト画面(IOCS $21経由、puts と同じ)。出力バッファは内部で
 *   固定長(256バイト)。バッファを超える出力は切り詰める(切り詰めても
 *   落ちない。ブロック崩し程度のメッセージ長を想定した第一版の割り切り)。
 */
int printf(const char *fmt, ...);

#endif /* X68_H */
