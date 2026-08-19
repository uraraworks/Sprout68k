#!/usr/bin/env python3
"""宿題3(テキスト/グラフィック重なり実測)用: マーカー仕様(JSON)から
stage_e/src/main_overlay.c が参照する boxes[]/box_count, texts[]/text_count の
実体(.c ファイル)を生成する。

このスクリプト自身は座標・色・文字列の値を決めない(呼び出し元 =
verify/verify_overlay.mts が実測方針に基づいて値を決める)。ここでは
仕様(JSON)をそのまま C の配列に変換するだけ(tools/gen_markers_e1.py,
tools/gen_markers_e6.py と同じ役割分担)。

使い方:
  gen_markers_overlay.py '<json>' <out.c>
    json: {
      "boxes": [[x, y, w, h, colorhex], ...],   // GVRAM 矩形塗りつぶし(65536色, 16bit値)
      "texts": [[col, row, "text"], ...]         // IOCS $23+$21 での文字列表示
    }
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

    data = json.loads(spec) if spec else {}
    boxes = data.get('boxes', [])
    texts = data.get('texts', [])

    lines = []
    lines.append('/* tools/gen_markers_overlay.py が自動生成。手編集しないこと。 */')
    lines.append('typedef struct { long x; long y; long w; long h; unsigned short color; } box_t;')
    lines.append('typedef struct { int col; int row; const char *text; } text_marker_t;')

    lines.append(f'const unsigned long box_count = {len(boxes)}UL;')
    if boxes:
        lines.append('const box_t boxes[] = {')
        for x, y, w, h, color in boxes:
            lines.append(f'  {{ {int(x)}L, {int(y)}L, {int(w)}L, {int(h)}L, 0x{int(color, 0) & 0xFFFF:04X} }},')
        lines.append('};')
    else:
        lines.append('const box_t boxes[1] = { { 0L, 0L, 0L, 0L, 0x0000 } };')

    lines.append(f'const unsigned long text_count = {len(texts)}UL;')
    if texts:
        lines.append('const text_marker_t texts[] = {')
        for col, row, text in texts:
            lines.append(f'  {{ {int(col)}, {int(row)}, "{esc(text)}\\0" }},')
        lines.append('};')
    else:
        lines.append('const text_marker_t texts[1] = { { 0, 0, "" } };')

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text('\n'.join(lines) + '\n')
    print(f'wrote {out_path} (boxes={len(boxes)}, texts={len(texts)})')


if __name__ == '__main__':
    main()
