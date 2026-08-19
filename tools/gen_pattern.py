#!/usr/bin/env python3
"""Stage D 用の既知パターン(+末尾4バイトの番兵)を生成する。

使い方: gen_pattern.py <pattern_bytes> <out.bin>
標準出力に期待チェックサム(0x起点の16進)を1行だけ出す(ビルドスクリプトが -D で拾う)。

パターンは位置依存(pattern[i] = (i*167+13) & 0xFF)。チェックサムは
csum = csum*131 + byte を全バイトに対して行う(乗算命令が無い m68000 でも
シフト+加算だけで同じ計算ができるよう、C/asm側もこの式に合わせている)。
番兵は固定値 0x5A,0x5A,0xA5,0xA5(=読み込み時に 0x5A5AA5A5 として検査)。
"""
import sys
from pathlib import Path

SENTINEL = bytes([0x5A, 0x5A, 0xA5, 0xA5])
MASK32 = 0xFFFFFFFF


def main() -> None:
    size = int(sys.argv[1])
    out_path = sys.argv[2]
    data = bytes([(i * 167 + 13) & 0xFF for i in range(size)])
    Path(out_path).write_bytes(data + SENTINEL)

    csum = 0
    for b in data:
        csum = ((csum << 7) + (csum << 1) + csum + b) & MASK32
    print(f"0x{csum:08X}")


if __name__ == "__main__":
    main()
