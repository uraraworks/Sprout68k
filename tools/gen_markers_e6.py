#!/usr/bin/env python3
"""Stage E-6 用: マーカー仕様(col, row, use_locate, text)から
stage_e/src/main_e6.c が参照する markers[]/marker_count の実体(.c ファイル)を生成する。

このスクリプト自身は座標・文字列の値を決めない(呼び出し元 = verify/verify_e6.mts が
実測方針に基づいて値を決める)。ここでは仕様(JSON)をそのまま C の配列に変換するだけ。

使い方:
  gen_markers_e6.py '<json>' <out.c>
    json: [[col, row, use_locate(0/1), "text"], ...]  空配列 [] も可(全マーカー無し)
    text は ASCII のみを想定(IOCS $21 はテキストVRAMへそのまま書く実測済みの経路)。
"""
import json
import sys
from pathlib import Path


def esc(s: str) -> str:
    out = []
    for ch in s:
        if ch in ('"', '\\'):
            out.append('\\' + ch)
        else:
            out.append(ch)
    return ''.join(out)


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    spec = sys.argv[1]
    out_path = Path(sys.argv[2])

    entries = json.loads(spec) if spec else []

    lines = []
    lines.append('/* tools/gen_markers_e6.py が自動生成。手編集しないこと。 */')
    lines.append('typedef struct { int col; int row; int use_locate; const char *text; } marker_t;')
    lines.append(f'const unsigned long marker_count = {len(entries)}UL;')
    if entries:
        lines.append('const marker_t markers[] = {')
        for col, row, use_locate, text in entries:
            lines.append(f'  {{ {int(col)}, {int(row)}, {int(use_locate)}, "{esc(text)}\\0" }},')
        lines.append('};')
    else:
        lines.append('const marker_t markers[1] = { { 0, 0, 0, "" } };')

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text('\n'.join(lines) + '\n')
    print(f'wrote {out_path} ({len(entries)} markers)')


if __name__ == '__main__':
    main()
