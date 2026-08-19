#!/usr/bin/env bash
# Stage D(track/sideをまたぐ複数セクタ読み込み対応のブートセクタ + 既知パターンの
# チェックサム/番兵検査)をビルドする。
#
# 使い方: tools/build_stage_d.sh <pattern_bytes> <output.xdf> [deficit_sectors]
#   pattern_bytes:     パターン配列のバイト数(番兵4バイトは別途自動付加)
#   output.xdf:        出力ディスクイメージ
#   deficit_sectors:   省略時0。>0にするとブートセクタに埋め込む SECTOR_COUNT を
#                       実際の本体セクタ数より意図的に少なくする(自己故障注入用)。
#                       ディスク上の本体は完全なまま(正しいセクタ数ぶん)配置する。
#
# 前提: m68k-elf-gcc / m68k-elf-ld / m68k-elf-objcopy が PATH にあること。
set -euo pipefail

PATTERN_BYTES="${1:?pattern_bytes が必要}"
OUT_XDF="${2:?output.xdf が必要}"
DEFICIT="${3:-0}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OBJDIR="$ROOT/build/stage_d_obj"
mkdir -p "$OBJDIR"

SECTOR_SIZE=1024
TOTAL_SECTORS=1232
MAX_BODY_SECTORS=$((TOTAL_SECTORS - 1)) # sector1はブートセクタ自身
LOAD_ADDR=$((0x3000))
# スタックの既定値は「1MB機(ACE/EXPERT等、X68000の標準構成)で確実に成立する
# 位置」を主軸にする(2026-08-19: 実機互換の要件を追加)。$F0000 付近を採用し、
# 本体が使える既定の予算は $F0000 - $3000 - マージン ≒ 943KB になる
# (docs/実機互換_要件追加_20260819.md の表を参照)。
# 977/1231セクタ級の大サイズ試験はこの既定では収まらないため、その場合は
# 呼び出し側(verify/verify.mts)が STACK_ADDR と RAM_SIZE を明示的に大きい値
# (旧既定 $1F0000 / 2MB)へ上書きして呼ぶ。番地を記憶や伝聞で決めない方針の
# 一環として、動的なRAM量検出は行わず、既定値+明示パラメータのみで運用する。
STACK_ADDR="${STACK_ADDR:-0xF0000}"
STACK_ADDR_DEC=$((STACK_ADDR)) # bash 3.2(macOS既定)の `[` は0x接頭辞を認識しないため10進化しておく
# RAM_SIZE は「このビルドが対象とする機械の実RAM量」。検証ハーネス側で設定する
# px68k_ramsize core option と一致させること(既定は1MB機を想定)。
RAM_SIZE="${RAM_SIZE:-0x100000}"
RAM_SIZE_DEC=$((RAM_SIZE))
STACK_MARGIN=$((4096)) # ロード末尾とスタックの間に最低限空ける余白

CFLAGS=(-m68000 -Os -ffreestanding -nostdlib -fomit-frame-pointer -fno-builtin -Wall -Wno-array-bounds)

echo "== パターン生成(pattern_bytes=${PATTERN_BYTES}) =="
EXPECTED_CSUM=$(python3 "$ROOT/tools/gen_pattern.py" "$PATTERN_BYTES" "$OBJDIR/pattern.bin")
echo "expected_csum=${EXPECTED_CSUM}"

echo "== Stage D 本体(C)のビルド =="
m68k-elf-gcc "${CFLAGS[@]}" -DEXPECTED_CSUM="${EXPECTED_CSUM}" -c "$ROOT/stage_d/src/main.c" -o "$OBJDIR/main.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -DSTACK_ADDR="${STACK_ADDR}" -c "$ROOT/stage_c/crt0/crt0.S" -o "$OBJDIR/crt0.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -c "$ROOT/stage_c/crt0/iocs.S" -o "$OBJDIR/iocs.o"
# pattern_data.S は .incbin "pattern.bin" を相対パスで参照するため OBJDIR 内で assemble する
( cd "$OBJDIR" && m68k-elf-gcc -x assembler-with-cpp -m68000 -c "$ROOT/stage_d/src/pattern_data.S" -o pattern_data.o )
m68k-elf-ld -T "$ROOT/stage_d/crt0/linker.ld" -o "$OBJDIR/stage_d.elf" \
  "$OBJDIR/crt0.o" "$OBJDIR/iocs.o" "$OBJDIR/main.o" "$OBJDIR/pattern_data.o"
m68k-elf-objcopy -O binary "$OBJDIR/stage_d.elf" "$OBJDIR/stage_d.bin"

BODY_SIZE=$(wc -c < "$OBJDIR/stage_d.bin" | tr -d ' ')
REAL_SECTOR_COUNT=$(( (BODY_SIZE + SECTOR_SIZE - 1) / SECTOR_SIZE ))
if [ "$REAL_SECTOR_COUNT" -lt 1 ]; then REAL_SECTOR_COUNT=1; fi
if [ "$REAL_SECTOR_COUNT" -gt "$MAX_BODY_SECTORS" ]; then
  echo "ERROR: 本体が ${MAX_BODY_SECTORS} セクタ(ディスク全体)を超えている(${REAL_SECTOR_COUNT})" >&2
  exit 1
fi

LOAD_SECTOR_COUNT=$(( REAL_SECTOR_COUNT - DEFICIT ))
if [ "$LOAD_SECTOR_COUNT" -lt 1 ]; then
  echo "ERROR: deficit(${DEFICIT})が本体セクタ数(${REAL_SECTOR_COUNT})以上" >&2
  exit 1
fi

echo "body size=${BODY_SIZE} bytes -> real=${REAL_SECTOR_COUNT}セクタ, boot読込=${LOAD_SECTOR_COUNT}セクタ(deficit=${DEFICIT})"

# 本体末尾($3000+読み込むバイト数)とスタック(STACK_ADDR)が衝突しないことをビルド時に検査する。
# LOAD_SECTOR_COUNT(ブートセクタが実際に読むセクタ数)基準で見る。deficit注入時は
# 実際に読む量が減るだけなので、この検査は REAL_SECTOR_COUNT(ディスク上の本体の
# 本来のサイズ)側で行う(deficitで小さく見せても本当の衝突判定を骨抜きにしないため)。
BODY_END=$((LOAD_ADDR + REAL_SECTOR_COUNT * SECTOR_SIZE))
if [ "$((BODY_END + STACK_MARGIN))" -gt "$STACK_ADDR_DEC" ]; then
  printf 'ERROR: 本体末尾(0x%X)がスタック(STACK_ADDR=0x%X, margin=%dバイト)と衝突する\n' "$BODY_END" "$STACK_ADDR_DEC" "$STACK_MARGIN" >&2
  exit 1
fi
if [ "$STACK_ADDR_DEC" -ge "$RAM_SIZE_DEC" ]; then
  printf 'ERROR: STACK_ADDR(0x%X)が設定RAMサイズ(RAM_SIZE=0x%X)を超えている\n' "$STACK_ADDR_DEC" "$RAM_SIZE_DEC" >&2
  exit 1
fi

echo "== ブートセクタのビルド(SECTOR_COUNT=${LOAD_SECTOR_COUNT}, STACK_ADDR=${STACK_ADDR}, RAM_SIZE=${RAM_SIZE}) =="
m68k-elf-gcc -x assembler-with-cpp -m68000 -DSECTOR_COUNT="${LOAD_SECTOR_COUNT}" -DSTACK_ADDR="${STACK_ADDR}" -c "$ROOT/stage_d/boot/boot.S" -o "$OBJDIR/boot.o"
# cache_flush.S は stage_c/boot/ のものを共用する(MOVEC使用のため -m68020 で assemble。
# 詳細は tools/build_stage_c.sh 側のコメントおよび stage_c/boot/cache_flush.S 参照)。
m68k-elf-gcc -x assembler-with-cpp -m68020 -c "$ROOT/stage_c/boot/cache_flush.S" -o "$OBJDIR/cache_flush.o"
cat > "$OBJDIR/boot_link.ld" <<'EOF'
SECTIONS { . = 0x0; .text : { *(.text) *(.rodata) *(.data) } }
EOF
m68k-elf-ld -T "$OBJDIR/boot_link.ld" -o "$OBJDIR/boot.elf" "$OBJDIR/boot.o" "$OBJDIR/cache_flush.o"
m68k-elf-objcopy -O binary "$OBJDIR/boot.elf" "$OBJDIR/boot.bin"
BOOT_SIZE=$(wc -c < "$OBJDIR/boot.bin" | tr -d ' ')
if [ "$BOOT_SIZE" -gt "$SECTOR_SIZE" ]; then
  echo "ERROR: ブートセクタが1024バイトを超えている(${BOOT_SIZE})" >&2
  exit 1
fi

echo "== .xdf の合成(本体はディスク上には REAL_SECTOR_COUNT ぶん、欠損なしで置く) =="
python3 - "$OBJDIR/boot.bin" "$OBJDIR/stage_d.bin" "$REAL_SECTOR_COUNT" "$OUT_XDF" <<'PYEOF'
import sys
from pathlib import Path

SECTOR_SIZE = 1024
TOTAL_SECTORS = 1232
IMAGE_SIZE = SECTOR_SIZE * TOTAL_SECTORS

boot_path, body_path, real_sector_count, out_path = sys.argv[1:5]
real_sector_count = int(real_sector_count)

boot = Path(boot_path).read_bytes()
assert len(boot) <= SECTOR_SIZE
boot_sector = boot + bytes(SECTOR_SIZE - len(boot))

body = Path(body_path).read_bytes()
body_area = body + bytes(SECTOR_SIZE * real_sector_count - len(body))
assert len(body_area) == SECTOR_SIZE * real_sector_count

image = boot_sector + body_area
if len(image) > IMAGE_SIZE:
    raise SystemExit(f"image too large: {len(image)} > {IMAGE_SIZE}")
image += bytes(IMAGE_SIZE - len(image))
assert len(image) == IMAGE_SIZE

Path(out_path).parent.mkdir(parents=True, exist_ok=True)
Path(out_path).write_bytes(image)
print(f"wrote {out_path} ({len(image)} bytes, body_on_disk={real_sector_count} sectors)")
PYEOF
