#!/usr/bin/env bash
# Stage C(ネイティブ m68k-elf gcc でビルドした C プログラムを .xdf として起動可能にする)の
# ビルドスクリプト。
#
# 使い方: tools/build_stage_c.sh <fill_color_hex> <output.xdf>
#   例:   tools/build_stage_c.sh 0xFFFF build/stage_c.xdf
#
# 前提: m68k-elf-gcc / m68k-elf-ld / m68k-elf-objcopy が PATH にあること
# (Homebrew の m68k-elf-gcc / m68k-elf-binutils で確認済み)。
set -euo pipefail

FILL_COLOR="${1:-0xFFFF}"
OUT_XDF="${2:-build/stage_c.xdf}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OBJDIR="$ROOT/build/stage_c_obj"
mkdir -p "$OBJDIR"

SECTOR_SIZE=1024
TOTAL_SECTORS=1232
LOAD_ADDR=$((0x3000))
# スタックは本体ロードアドレス($3000)から十分離れた固定アドレス。
# 検証ハーネス(verify/verify.mts)が px68k に設定する px68k_ramsize=2MB(=0x200000バイト)の
# 範囲内に収める(2026-08-19: 旧 $B000 は本体が32KB以上になるとロード先と衝突していた不具合の修正。
# 環境変数 STACK_ADDR で上書き可能。切り分け実験用)。
STACK_ADDR="${STACK_ADDR:-0x1F0000}"
STACK_ADDR_DEC=$((STACK_ADDR)) # bash 3.2(macOS既定)の `[` は0x接頭辞を認識しないため10進化しておく
RAM_SIZE=$((0x200000))
STACK_MARGIN=$((4096)) # ロード末尾とスタックの間に最低限空ける余白

CFLAGS=(-m68000 -Os -ffreestanding -nostdlib -fomit-frame-pointer -fno-builtin -Wall)

echo "== Stage C 本体(C)のビルド(fill_color=${FILL_COLOR}) =="
m68k-elf-gcc "${CFLAGS[@]}" -DFILL_COLOR="${FILL_COLOR}" -c "$ROOT/stage_c/src/main.c" -o "$OBJDIR/main.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -DSTACK_ADDR="${STACK_ADDR}" -c "$ROOT/stage_c/crt0/crt0.S" -o "$OBJDIR/crt0.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -c "$ROOT/stage_c/crt0/iocs.S" -o "$OBJDIR/iocs.o"
m68k-elf-ld -T "$ROOT/stage_c/crt0/linker.ld" -o "$OBJDIR/stage_c.elf" "$OBJDIR/crt0.o" "$OBJDIR/iocs.o" "$OBJDIR/main.o"
m68k-elf-objcopy -O binary "$OBJDIR/stage_c.elf" "$OBJDIR/stage_c.bin"

BODY_SIZE=$(wc -c < "$OBJDIR/stage_c.bin" | tr -d ' ')
SECTOR_COUNT=$(( (BODY_SIZE + SECTOR_SIZE - 1) / SECTOR_SIZE ))
if [ "$SECTOR_COUNT" -lt 1 ]; then SECTOR_COUNT=1; fi
echo "body size=${BODY_SIZE} bytes -> ${SECTOR_COUNT} セクタ"

# track0/side0 は sector2〜8 の7セクタしか使えない(sector1はブートセクタ自身)。
# それを超える本体サイズは今回未対応(track/side をまたぐIOCS呼び出しの実測が未検証のため)。
if [ "$SECTOR_COUNT" -gt 7 ]; then
  echo "ERROR: 本体が7セクタ(7168バイト)を超えている。track0/side0内に収まらない(未検証領域)。" >&2
  exit 1
fi

# 本体末尾($3000+BODY_SIZE)とスタック(STACK_ADDR)が衝突しないことをビルド時に検査する。
BODY_END=$((LOAD_ADDR + BODY_SIZE))
if [ "$((BODY_END + STACK_MARGIN))" -gt "$STACK_ADDR_DEC" ]; then
  printf 'ERROR: 本体末尾(0x%X)がスタック(STACK_ADDR=0x%X, margin=%dバイト)と衝突する\n' "$BODY_END" "$STACK_ADDR_DEC" "$STACK_MARGIN" >&2
  exit 1
fi
if [ "$STACK_ADDR_DEC" -ge "$RAM_SIZE" ]; then
  printf 'ERROR: STACK_ADDR(0x%X)が設定RAMサイズ(0x%X)を超えている\n' "$STACK_ADDR" "$RAM_SIZE" >&2
  exit 1
fi

echo "== ブートセクタのビルド(SECTOR_COUNT=${SECTOR_COUNT}, STACK_ADDR=${STACK_ADDR}) =="
m68k-elf-gcc -x assembler-with-cpp -m68000 -DSECTOR_COUNT="${SECTOR_COUNT}" -DSTACK_ADDR="${STACK_ADDR}" -c "$ROOT/stage_c/boot/boot.S" -o "$OBJDIR/boot.o"
cat > "$OBJDIR/boot_link.ld" <<'EOF'
SECTIONS { . = 0x0; .text : { *(.text) *(.rodata) *(.data) } }
EOF
m68k-elf-ld -T "$OBJDIR/boot_link.ld" -o "$OBJDIR/boot.elf" "$OBJDIR/boot.o"
m68k-elf-objcopy -O binary "$OBJDIR/boot.elf" "$OBJDIR/boot.bin"
BOOT_SIZE=$(wc -c < "$OBJDIR/boot.bin" | tr -d ' ')
if [ "$BOOT_SIZE" -gt "$SECTOR_SIZE" ]; then
  echo "ERROR: ブートセクタが1024バイトを超えている(${BOOT_SIZE})" >&2
  exit 1
fi

echo "== .xdf の合成 =="
python3 - "$OBJDIR/boot.bin" "$OBJDIR/stage_c.bin" "$SECTOR_COUNT" "$OUT_XDF" <<'PYEOF'
import sys
from pathlib import Path

SECTOR_SIZE = 1024
TOTAL_SECTORS = 1232
IMAGE_SIZE = SECTOR_SIZE * TOTAL_SECTORS

boot_path, body_path, sector_count, out_path = sys.argv[1:5]
sector_count = int(sector_count)

boot = Path(boot_path).read_bytes()
assert len(boot) <= SECTOR_SIZE
boot_sector = boot + bytes(SECTOR_SIZE - len(boot))

body = Path(body_path).read_bytes()
body_area = body + bytes(SECTOR_SIZE * sector_count - len(body))
assert len(body_area) == SECTOR_SIZE * sector_count

image = boot_sector + body_area
image += bytes(IMAGE_SIZE - len(image))
assert len(image) == IMAGE_SIZE

Path(out_path).parent.mkdir(parents=True, exist_ok=True)
Path(out_path).write_bytes(image)
print(f"wrote {out_path} ({len(image)} bytes, body={sector_count} sectors)")
PYEOF
