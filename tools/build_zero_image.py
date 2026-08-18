#!/usr/bin/env python3
"""陰性対照: 起動不可能なはずの全バイト0イメージ(1,261,568バイト)を生成する。"""
import sys
from pathlib import Path

SECTOR_SIZE = 1024
TOTAL_SECTORS = 1232
IMAGE_SIZE = SECTOR_SIZE * TOTAL_SECTORS


def main() -> None:
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "build" / "zero.xdf"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(bytes(IMAGE_SIZE))
    print(f"wrote {out_path} ({IMAGE_SIZE} bytes)")


if __name__ == "__main__":
    main()
