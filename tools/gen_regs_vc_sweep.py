#!/usr/bin/env python3
"""VCレジスタ総当たり実測(main_vc_sweep.c)用: レジスタ値7個(CSV, 10進数または
0x接頭辞の16進数)から regs[7] の実体(.c)を生成する。

使い方:
  gen_regs_vc_sweep.py "<crtc_r20>,<vc_r0_hi>,<vc_r0_lo>,<vc_r1_hi>,<vc_r1_lo>,<vc_r2_hi>,<vc_r2_lo>" <out.c>
"""
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    spec = sys.argv[1]
    out_path = Path(sys.argv[2])
    vals = [int(x, 0) & 0xFF for x in spec.split(',')]
    if len(vals) != 7:
        print(f'ERROR: レジスタ値は7個必要(受け取った数={len(vals)})', file=sys.stderr)
        sys.exit(1)
    lines = []
    lines.append('/* tools/gen_regs_vc_sweep.py が自動生成。手編集しないこと。 */')
    lines.append('const unsigned char regs[7] = {' + ', '.join(f'0x{v:02X}' for v in vals) + '};')
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text('\n'.join(lines) + '\n')
    print(f'wrote {out_path} regs={vals}')


if __name__ == '__main__':
    main()
