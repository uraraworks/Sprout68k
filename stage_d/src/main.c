/* Stage D テストプログラム(C)。
 *
 * 本体の最後尾に配置された既知パターン配列(pattern_data〜pattern_data_end-4)の
 * チェックサムと、末尾4バイトの番兵(pattern_data_end-4〜pattern_data_end)を検査し、
 * 結果を IOCS $21 で "LOAD OK <checksum> <sentinel>" / "LOAD NG <checksum> <sentinel>"
 * として表示する。読み込みが1セクタでも欠けると、必ずパターン配列の末尾(番兵を含む)
 * が欠けるため、チェックサムと番兵のどちらか(通常は両方)が不一致になる。
 *
 * newlib は使わない。ヒープも使わない。フリースタンディング。乗算命令が無い
 * m68000 でリンクできるよう、チェックサムはシフト+加算のみで構成する
 * (csum = csum*131 + byte を (csum<<7)+(csum<<1)+csum+byte として計算)。
 */
typedef unsigned long u32;

extern const unsigned char pattern_data[];
extern const unsigned char pattern_data_end[];
extern void iocs_print(const char *msg);

#ifndef EXPECTED_CSUM
#define EXPECTED_CSUM 0
#endif

#define SENTINEL_MAGIC 0x5A5AA5A5UL

static void put_hex32(char *buf, u32 v) {
    static const char digits[] = "0123456789ABCDEF";
    int i;
    for (i = 7; i >= 0; i--) {
        buf[i] = digits[v & 0xF];
        v >>= 4;
    }
}

void main(void) {
    const unsigned char *p = pattern_data;
    const unsigned char *tail = pattern_data_end - 4; /* 末尾4バイトは番兵 */
    u32 csum = 0;

    while (p < tail) {
        csum = (csum << 7) + (csum << 1) + csum + *p; /* csum = csum*131 + byte */
        p++;
    }

    u32 sentinel = ((u32)tail[0] << 24) | ((u32)tail[1] << 16) | ((u32)tail[2] << 8) | (u32)tail[3];

    int csum_ok = (csum == (u32)EXPECTED_CSUM);
    int sentinel_ok = (sentinel == SENTINEL_MAGIC);
    int ok = csum_ok && sentinel_ok;

    char msg[48];
    const char *prefix = ok ? "LOAD OK " : "LOAD NG ";
    int i = 0;
    while (prefix[i]) { msg[i] = prefix[i]; i++; }
    put_hex32(&msg[i], csum); i += 8;
    msg[i++] = ' ';
    put_hex32(&msg[i], sentinel); i += 8;
    msg[i] = 0;

    iocs_print(msg);

    for (;;) {
    }
}
