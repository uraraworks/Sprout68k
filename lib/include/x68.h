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
 * L1(学習層): 入門者が触るのはここだけ。docs/API設計_20260819.md の
 * 「画面モード: 65536色1ページ固定 + 矩形追跡の部分転送」節で決定した方式
 * (裏バッファはメインメモリ、GVRAMへは「前フレーム∪今フレーム」の矩形だけ
 * 転送する)を実装したもの(lib/src/x68_l1.c)。座標・色はすべてクリップし、
 * エラーコードは返さない(設計原則1)。
 * ============================================================ */

/* GVRAM論理サイズ(Stage E-1で実測確定)。 */
#define X68_SCREEN_W 512
#define X68_SCREEN_H 512

/* 65536色1ページモードを設定し、メインメモリ上に裏バッファ(512x512x2=512KB)を
 * 用意する。裏バッファの内容は0クリアする。この呼び出しの後、最初の
 * x68_screen_flip() は(x68_clsを呼んでいなくても)裏バッファ全体を転送する
 * (GVRAMの初期内容は不定なため)。 */
void x68_screen_open(void);

/* 垂直同期を待ち、「前フレームに描画された矩形」と「今フレームに描画された
 * 矩形」の和集合だけを裏バッファからGVRAMへ転送する(全画面転送はしない。
 * ただしx68_clsが全画面塗り直しを必要とした場合はこの回だけ全画面を転送する)。
 * 転送後、今フレームの矩形リストは次回のx68_clsが参照する「前フレームの
 * 矩形リスト」になる。 */
void x68_screen_flip(void);

/* 裏バッファ全体を塗る……のではなく、**前フレームに描画された矩形の範囲だけを
 * colorで塗り戻す**(docs/API設計_20260819.md「採る方式」節、
 * docs/L1実装_20260819.md参照。全画面を塗ると入門者の定番ループ
 * cls→描画→flip で全画面転送が復活するため)。ただし次のいずれかに該当する
 * 場合だけ、裏バッファ全体をcolorで塗る(全画面転送になる。稀な事象):
 *   - x68_screen_open() 後、一度も x68_cls を呼んでいない(初回)
 *   - 直前に x68_cls へ渡した color と異なる(背景色が変わった) */
void x68_cls(int color);

/* 範囲外(x<0/x>=X68_SCREEN_W/y<0/y>=X68_SCREEN_H)は何もしない。 */
void x68_pset(int x, int y, int color);

/* 範囲外は0を返す。裏バッファの値をそのまま返す(GVRAM実体ではなく、
 * まだ転送されていない今フレームの描画結果も見える)。 */
int x68_pget(int x, int y);

/* 画面外にはみ出す分はクリップする。w<=0 または h<=0 なら何もしない。 */
void x68_box_fill(int x, int y, int w, int h, int color);

/* 枠(太さ1ドット)のみ。クリップ・w/hの扱いはx68_box_fillと同じ。 */
void x68_box(int x, int y, int w, int h, int color);

/* 両端とも画面外でも落ちない(画面内に一切かからない場合は何も描かない)。 */
void x68_line(int x1, int y1, int x2, int y2, int color);

/* 中心(x,y)・半径rの円の輪郭(塗りつぶさない)。r<=0なら何もしない。
 * X68_API設計_20260819.md の表には無いが、検証台本(点・線・円を描く)の
 * ために本実装で追加した(docs/L1実装_20260819.md に明記)。 */
void x68_circle(int x, int y, int r, int color);

/* 0〜255を受け、範囲外は丸めて(クランプして)16bit色値を返す。
 * 65536色1ページの語形式(G5 R5 B5 I1。docs/lib実装_20260819.mdの
 * decode16to24コメント参照)に合わせ、上位5bitずつを使う。Iビットは常に1
 * (最大輝度)。 */
int x68_rgb(int r, int g, int b);

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
