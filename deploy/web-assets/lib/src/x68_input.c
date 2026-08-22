/* X68kDev L1(入力の学習層): x68_key_down。
 *
 * L0の x68_iocs_bitsns(実装済み、lib/src/x68_l0.c + lib/asm/x68_iocs.S)の上に
 * 乗る薄いラッパ。docs/API設計_20260819.md「入力(すべて Stage E-4 で確定)」節、
 * docs/StageE-4_実測_20260819.md 参照。
 */
#include "x68.h"

/* 押されている間ずっと真。範囲外のキー番号(定義済み定数以外の値、負値含む)を
 * 渡しても落ちない(設計原則1)。
 *
 * group = key>>3 & 0xf、bit = key&7(Stage E-4実測の対応式)。keyをいったん
 * unsigned intへキャストしてから演算するため、負値や巨大な値を渡してもgroupは
 * 必ず0〜15の範囲に収まり、x68_iocs_bitsns(0〜15はIOCS側が受理する既存の
 * グループ範囲)の呼び出し自体が異常な引数で落ちることは無い。 */
int x68_key_down(int key) {
    unsigned long ukey = (unsigned long)(unsigned int)key;
    unsigned long group = (ukey >> 3) & 0xfUL;
    unsigned int bit = (unsigned int)(ukey & 7UL);
    unsigned char pattern = x68_iocs_bitsns(group);
    return (pattern & (unsigned char)(1U << bit)) != 0;
}
