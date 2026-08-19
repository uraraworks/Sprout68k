#!/usr/bin/env bash
# 宿題3(テキスト面とグラフィック面の重なり方の実測)用ビルド。crt0/リンカスクリプト/
# ブートセクタは Stage C のものをそのまま流用する(本体は7セクタ以内に収まる小さい
# プログラムのため)。IOCS $21 スタブは stage_c/crt0/iocs.S、IOCS $23(候補、
# カーソル位置指定)のスタブは Stage E-6 で実測済みの stage_e/src/iocs_e6.S を
# そのまま流用する(いずれも変更しない)。
#
# 使い方: tools/build_stage_overlay.sh <marker_spec_json> <output.xdf>
#   marker_spec_json: '{"boxes":[[x,y,w,h,"0xRRGG"],...],"texts":[[col,row,"text"],...]}'
#
# 前提: m68k-elf-gcc / m68k-elf-ld / m68k-elf-objcopy が PATH にあること。
set -euo pipefail

MARKER_SPEC="${1-}"
OUT_XDF="${2:?output.xdf が必要}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OBJDIR="$ROOT/build/stage_overlay_obj"
mkdir -p "$OBJDIR"

SECTOR_SIZE=1024
TOTAL_SECTORS=1232
LOAD_ADDR=$((0x3000))
STACK_ADDR="${STACK_ADDR:-0xF0000}"
STACK_ADDR_DEC=$((STACK_ADDR))
RAM_SIZE="${RAM_SIZE:-0x100000}"
RAM_SIZE_DEC=$((RAM_SIZE))
STACK_MARGIN=$((4096))

CFLAGS=(-m68000 -Os -ffreestanding -nostdlib -fomit-frame-pointer -fno-builtin -Wall)

echo "== マーカーデータ生成(spec=${MARKER_SPEC}) =="
python3 "$ROOT/tools/gen_markers_overlay.py" "$MARKER_SPEC" "$OBJDIR/markers_data.c"

echo "== 宿題3 本体(C)のビルド =="
m68k-elf-gcc "${CFLAGS[@]}" -c "$ROOT/stage_e/src/main_overlay.c" -o "$OBJDIR/main.o"
m68k-elf-gcc "${CFLAGS[@]}" -c "$OBJDIR/markers_data.c" -o "$OBJDIR/markers_data.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -DSTACK_ADDR="${STACK_ADDR}" -c "$ROOT/stage_c/crt0/crt0.S" -o "$OBJDIR/crt0.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -c "$ROOT/stage_c/crt0/iocs.S" -o "$OBJDIR/iocs.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -c "$ROOT/stage_e/src/iocs_e6.S" -o "$OBJDIR/iocs_e6.o"
m68k-elf-ld -T "$ROOT/stage_c/crt0/linker.ld" -o "$OBJDIR/stage_overlay.elf" \
  "$OBJDIR/crt0.o" "$OBJDIR/iocs.o" "$OBJDIR/iocs_e6.o" "$OBJDIR/main.o" "$OBJDIR/markers_data.o"
m68k-elf-objcopy -O binary "$OBJDIR/stage_overlay.elf" "$OBJDIR/stage_overlay.bin"

BODY_SIZE=$(wc -c < "$OBJDIR/stage_overlay.bin" | tr -d ' ')
SECTOR_COUNT=$(( (BODY_SIZE + SECTOR_SIZE - 1) / SECTOR_SIZE ))
if [ "$SECTOR_COUNT" -lt 1 ]; then SECTOR_COUNT=1; fi
echo "body size=${BODY_SIZE} bytes -> ${SECTOR_COUNT} セクタ"

if [ "$SECTOR_COUNT" -gt 7 ]; then
  echo "ERROR: 本体が7セクタ(7168バイト)を超えている。stage_c/boot/boot.S はtrack0/side0内(7セクタ)しか読めない(マーカー数を減らすか、必要ならStage Dのブートセクタへ切り替える)。" >&2
  exit 1
fi

BODY_END=$((LOAD_ADDR + BODY_SIZE))
if [ "$((BODY_END + STACK_MARGIN))" -gt "$STACK_ADDR_DEC" ]; then
  printf 'ERROR: 本体末尾(0x%X)がスタック(STACK_ADDR=0x%X, margin=%dバイト)と衝突する\n' "$BODY_END" "$STACK_ADDR_DEC" "$STACK_MARGIN" >&2
  exit 1
fi
if [ "$STACK_ADDR_DEC" -ge "$RAM_SIZE_DEC" ]; then
  printf 'ERROR: STACK_ADDR(0x%X)が設定RAMサイズ(RAM_SIZE=0x%X)を超えている\n' "$STACK_ADDR_DEC" "$RAM_SIZE_DEC" >&2
  exit 1
fi

echo "== ブートセクタのビルド(SECTOR_COUNT=${SECTOR_COUNT}, STACK_ADDR=${STACK_ADDR}, RAM_SIZE=${RAM_SIZE}) =="
m68k-elf-gcc -x assembler-with-cpp -m68000 -DSECTOR_COUNT="${SECTOR_COUNT}" -DSTACK_ADDR="${STACK_ADDR}" -c "$ROOT/stage_c/boot/boot.S" -o "$OBJDIR/boot.o"
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

echo "== .xdf の合成 =="
python3 - "$OBJDIR/boot.bin" "$OBJDIR/stage_overlay.bin" "$SECTOR_COUNT" "$OUT_XDF" <<'PYEOF'
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
