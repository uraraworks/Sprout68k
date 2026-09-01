/* Sprout68k 標準名の層: memcpy/memset/strlen/abs/srand/rand/puts/printf。
 *
 * -ffreestanding -nostdlib のため C 標準ライブラリは存在せず、すべて自前実装。
 * <stdarg.h> はコンパイラ(gcc)自身が提供するフリースタンディング対応ヘッダ
 * なので使ってよい(libc の一部ではない。m68k-elf-gcc -print-file-name=include
 * 配下にある)。
 *
 * ビルド時に以下のマクロを定義すると、検証用に意図的に壊した版を作れる
 * (故障注入。tools/build_lib_test.sh の fault 引数が渡す。通常ビルドでは
 * 一切定義されない):
 *   X68_FAULT_MEMCPY_SKIP_LAST   memcpy が最後の1バイトをコピーしない
 *   X68_FAULT_STRLEN_OFF_BY_ONE  strlen が実際の長さ+1を返す
 *   X68_FAULT_PRINTF_DROP_SIGN   printf の %d が負号を出力しない
 */
#include "x68.h"
#include <stdarg.h>

void *memcpy(void *dst, const void *src, unsigned long n) {
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;
#ifdef X68_FAULT_MEMCPY_SKIP_LAST
    if (n > 0) n -= 1; /* 故障注入: 最後の1バイトをコピーしない */
#endif
    /* 68000はワード/ロングのアクセスに偶数番地を要求する(4の倍数である必要はない)。
     * 送り元と送り先の偶奇が同じときだけ、先頭1バイトで揃えてから32bitでまとめて写す。
     * 偶奇が違う場合は揃えようがないので、従来どおり1バイトずつ写す。 */
    if (n >= 8 && ((((unsigned long)d) ^ ((unsigned long)s)) & 1UL) == 0UL) {
        if (((unsigned long)d & 1UL) != 0UL) { *d++ = *s++; n--; }
        unsigned long *dl = (unsigned long *)d;
        const unsigned long *sl = (const unsigned long *)s;
        unsigned long m = n >> 2;
        while (m >= 8) {
            dl[0]=sl[0]; dl[1]=sl[1]; dl[2]=sl[2]; dl[3]=sl[3];
            dl[4]=sl[4]; dl[5]=sl[5]; dl[6]=sl[6]; dl[7]=sl[7];
            dl += 8; sl += 8; m -= 8;
        }
        while (m-- > 0) *dl++ = *sl++;
        d = (unsigned char *)dl; s = (const unsigned char *)sl;
        n &= 3UL;
    }
    while (n--) {
        *d++ = *s++;
    }
    return dst;
}

void *memset(void *dst, int c, unsigned long n) {
    unsigned char *d = (unsigned char *)dst;
    unsigned char v = (unsigned char)c;
    /* memcpyと同じ考え方。ただし送り元が無いので偶奇の制約は
     * 送り先(d)が偶数番地かどうかだけで決まる。 */
    if (n >= 8) {
        if (((unsigned long)d & 1UL) != 0UL) { *d++ = v; n--; }
        unsigned long vl = (unsigned long)v;
        vl |= vl << 8;
        vl |= vl << 16;
        unsigned long *dl = (unsigned long *)d;
        unsigned long m = n >> 2;
        while (m >= 8) {
            dl[0]=vl; dl[1]=vl; dl[2]=vl; dl[3]=vl;
            dl[4]=vl; dl[5]=vl; dl[6]=vl; dl[7]=vl;
            dl += 8; m -= 8;
        }
        while (m-- > 0) *dl++ = vl;
        d = (unsigned char *)dl;
        n &= 3UL;
    }
    while (n--) {
        *d++ = v;
    }
    return dst;
}

unsigned long strlen(const char *s) {
    const char *p = s;
    while (*p) p++;
    unsigned long len = (unsigned long)(p - s);
#ifdef X68_FAULT_STRLEN_OFF_BY_ONE
    len += 1; /* 故障注入: 実際の長さ+1を返す */
#endif
    return len;
}

int abs(int n) {
    return n < 0 ? -n : n;
}

/* 単純な線形合同法(暗号用途には使わない)。 */
static unsigned long x68_rand_state = 1;

void srand(unsigned int seed) {
    x68_rand_state = seed ? (unsigned long)seed : 1UL;
}

int rand(void) {
    x68_rand_state = x68_rand_state * 1103515245UL + 12345UL;
    return (int)((x68_rand_state >> 16) & (unsigned long)X68_RAND_MAX);
}

/* Sprout68k L1(乱数の学習層): 0〜n-1を返す。n<=0ならゼロ除算(rand()%n)で
 * 落とさず0を返す(設計原則1)。rand()の上に載せるだけの薄い実装。 */
int x68_rand_int(int n) {
    if (n <= 0) return 0;
    return rand() % n;
}

/* --- puts/printf 共通: 改行を IOCS $21 が理解する CR+LF に変換して出力する ---
 * IOCS $21 のコンソールが \n 単体で行送りする保証は無いため(MS-DOS/CP/M系
 * コンソールの慣例に合わせ)、出力直前に '\n' の手前へ '\r' を補うことで
 * 確実に改行させる。printf/puts のどちらも最終的にこの関数を通す。
 * bufは呼び出し側が用意した作業領域(書き換えて構わない)。 */
static void x68_emit(const char *s) {
    /* 変換後の長さは最大で元の2倍(すべて'\n'の場合)。256バイトの
     * printf バッファを想定した固定長ワークバッファで足りるよう512にする。 */
    static char out[512];
    unsigned long i = 0;
    while (*s && i + 2 < sizeof(out)) {
        if (*s == '\n') {
            out[i++] = '\r';
            out[i++] = '\n';
        } else {
            out[i++] = *s;
        }
        s++;
    }
    out[i] = '\0';
    x68_iocs_print(out);
}

int puts(const char *s) {
    /* 標準のputsと同じく、sの内容の後に必ず改行を1つ追加する
     * (sが改行で終わっていなくても追加する)。sそのものと"\n"を別々に
     * x68_emitへ渡すと2回のIOCS呼び出しになるが、puts単体の用途では
     * 問題にならない。 */
    x68_emit(s);
    x68_iocs_print("\r\n");
    return 0;
}

/* --- printf 第一版 ---
 * 対応: %d %u %x %c %s %%  (詳細は lib/include/x68.h のコメント表を参照)
 * 非対応に出会ったら "[BADFMT]" をその場に出力して処理を続ける
 * (黙って誤動作させない)。
 */
static void pf_putc(char *buf, unsigned long *idx, unsigned long cap, char c) {
    if (*idx + 1 < cap) {
        buf[*idx] = c;
        (*idx)++;
    }
}

static void pf_puts(char *buf, unsigned long *idx, unsigned long cap, const char *s) {
    while (*s) {
        pf_putc(buf, idx, cap, *s);
        s++;
    }
}

/* 符号無し10進数(base=10)/16進数(base=16、小文字)を出力する共通処理。 */
static void pf_putuint(char *buf, unsigned long *idx, unsigned long cap,
                        unsigned long v, unsigned int base) {
    char digits[32];
    int n = 0;
    if (v == 0) {
        digits[n++] = '0';
    } else {
        while (v > 0) {
            unsigned int d = (unsigned int)(v % base);
            digits[n++] = (char)(d < 10 ? ('0' + d) : ('a' + (d - 10)));
            v /= base;
        }
    }
    while (n > 0) {
        pf_putc(buf, idx, cap, digits[--n]);
    }
}

static void pf_putint(char *buf, unsigned long *idx, unsigned long cap, int v) {
    unsigned long uv = (unsigned long)v;
    if (v < 0) {
#ifndef X68_FAULT_PRINTF_DROP_SIGN
        pf_putc(buf, idx, cap, '-');
#endif
        /* -v をintの符号付き演算で計算するとINT_MINでオーバーフローするため、
         * 符号無しの2の補数演算で絶対値相当を得る。 */
        uv = (~uv) + 1UL;
    }
    pf_putuint(buf, idx, cap, uv, 10);
}

int printf(const char *fmt, ...) {
    static char out[256];
    unsigned long idx = 0;
    va_list ap;
    va_start(ap, fmt);

    while (*fmt) {
        if (*fmt != '%') {
            pf_putc(out, &idx, sizeof(out), *fmt);
            fmt++;
            continue;
        }
        /* '%' に遭遇 */
        fmt++;
        char spec = *fmt;
        switch (spec) {
            case 'd': {
                int v = va_arg(ap, int);
                pf_putint(out, &idx, sizeof(out), v);
                fmt++;
                break;
            }
            case 'u': {
                unsigned int v = va_arg(ap, unsigned int);
                pf_putuint(out, &idx, sizeof(out), (unsigned long)v, 10);
                fmt++;
                break;
            }
            case 'x': {
                unsigned int v = va_arg(ap, unsigned int);
                pf_putuint(out, &idx, sizeof(out), (unsigned long)v, 16);
                fmt++;
                break;
            }
            case 'c': {
                int v = va_arg(ap, int);
                pf_putc(out, &idx, sizeof(out), (char)v);
                fmt++;
                break;
            }
            case 's': {
                const char *v = va_arg(ap, const char *);
                pf_puts(out, &idx, sizeof(out), v);
                fmt++;
                break;
            }
            case '%': {
                pf_putc(out, &idx, sizeof(out), '%');
                fmt++;
                break;
            }
            case '\0': {
                /* フォーマット文字列が'%'で終わっている: 非対応 */
                pf_puts(out, &idx, sizeof(out), "[BADFMT]");
                break;
            }
            default: {
                /* 幅指定・0埋め・精度指定・長さ修飾子・未知の指定子はすべて
                 * ここに落ちる(浮動小数点の書式指定子含む)。黙って誤動作
                 * させず、目に見えるマーカーを出す。 */
                pf_puts(out, &idx, sizeof(out), "[BADFMT]");
                fmt++;
                break;
            }
        }
    }
    out[idx] = '\0';
    va_end(ap);

    x68_emit(out);
    return (int)idx;
}
