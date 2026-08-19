#!/usr/bin/env python3
"""Stage E-1 用: マーカー仕様(GVRAM ワードオフセット, 16bit色値)から
stage_e/src/main_e1.c が参照する markers[]/marker_count の実体(.c ファイル)を生成する。

このスクリプト自身はマーカーの値を決めない(呼び出し元 = verify/verify_e1.mts が
実測方針に基づいて値を決める)。ここでは仕様文字列をそのまま C の配列に変換するだけ。

使い方:
  gen_markers_e1.py "<spec>" <out.c>
    spec: "" (マーカー無し=陰性対照) か "off:colorhex,off:colorhex,..."
      off       GVRAM 先頭からのワードオフセット(10進 or 0x接頭辞可)
      colorhex  16bit色値(0x接頭辞、例: 0x8421)
"""
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    spec = sys.argv[1]
    out_path = Path(sys.argv[2])

    entries = []
    if spec:
        for pair in spec.split(','):
            off_s, color_s = pair.split(':')
            off = int(off_s, 0)
            color = int(color_s, 0) & 0xFFFF
            entries.append((off, color))

    lines = []
    lines.append('/* tools/gen_markers_e1.py が自動生成。手編集しないこと。 */')
    lines.append('typedef struct { unsigned long offset_words; unsigned short color; } marker_t;')
    lines.append(f'const unsigned long marker_count = {len(entries)}UL;')
    if entries:
        lines.append('const marker_t markers[] = {')
        for off, color in entries:
            lines.append(f'  {{ {off}UL, 0x{color:04X} }},')
        lines.append('};')
    else:
        # marker_count=0 なのでこの配列は参照されないが、サイズ0配列を避けるためダミーを1個置く
        lines.append('const marker_t markers[1] = { { 0UL, 0x0000 } };')

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text('\n'.join(lines) + '\n')
    print(f'wrote {out_path} ({len(entries)} markers)')


if __name__ == '__main__':
    main()
