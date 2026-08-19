#!/usr/bin/env bash
# 宿題3追加実測(VCレジスタ総当たり)用ビルド。crt0/リンカスクリプト/ブートセクタは
# Stage C/Overlay と同じ構成をそのまま流用する。
#
# 使い方: tools/build_stage_vc_sweep.sh <regs_csv> <output.xdf>
#   regs_csv: "crtc_r20,vc_r0_hi,vc_r0_lo,vc_r1_hi,vc_r1_lo,vc_r2_hi,vc_r2_lo"
#
# 前提: m68k-elf-gcc / m68k-elf-ld / m68k-elf-objcopy が PATH にあること。
set -euo pipefail

REGS_CSV="${1:?regs_csv が必要}"
OUT_XDF="${2:?output.xdf が必要}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OBJDIR="$ROOT/build/stage_vc_sweep_obj"
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

python3 "$ROOT/tools/gen_regs_vc_sweep.py" "$REGS_CSV" "$OBJDIR/regs_data.c" > /dev/null

m68k-elf-gcc "${CFLAGS[@]}" -c "$ROOT/stage_e/src/main_vc_sweep.c" -o "$OBJDIR/main.o"
m68k-elf-gcc "${CFLAGS[@]}" -c "$OBJDIR/regs_data.c" -o "$OBJDIR/regs_data.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -DSTACK_ADDR="${STACK_ADDR}" -c "$ROOT/stage_c/crt0/crt0.S" -o "$OBJDIR/crt0.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -c "$ROOT/stage_c/crt0/iocs.S" -o "$OBJDIR/iocs.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -c "$ROOT/stage_e/src/iocs_e6.S" -o "$OBJDIR/iocs_e6.o"
m68k-elf-ld -T "$ROOT/stage_c/crt0/linker.ld" -o "$OBJDIR/stage_vc_sweep.elf" \
  "$OBJDIR/crt0.o" "$OBJDIR/iocs.o" "$OBJDIR/iocs_e6.o" "$OBJDIR/main.o" "$OBJDIR/regs_data.o"
m68k-elf-objcopy -O binary "$OBJDIR/stage_vc_sweep.elf" "$OBJDIR/stage_vc_sweep.bin"

BODY_SIZE=$(wc -c < "$OBJDIR/stage_vc_sweep.bin" | tr -d ' ')
SECTOR_COUNT=$(( (BODY_SIZE + SECTOR_SIZE - 1) / SECTOR_SIZE ))
if [ "$SECTOR_COUNT" -lt 1 ]; then SECTOR_COUNT=1; fi

if [ "$SECTOR_COUNT" -gt 7 ]; then
  echo "ERROR: 本体が7セクタ(7168バイト)を超えている" >&2
  exit 1
fi

BODY_END=$((LOAD_ADDR + BODY_SIZE))
if [ "$((BODY_END + STACK_MARGIN))" -gt "$STACK_ADDR_DEC" ]; then
  printf 'ERROR: 本体末尾(0x%X)がスタック(STACK_ADDR=0x%X)と衝突する\n' "$BODY_END" "$STACK_ADDR_DEC" >&2
  exit 1
fi

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

python3 - "$OBJDIR/boot.bin" "$OBJDIR/stage_vc_sweep.bin" "$SECTOR_COUNT" "$OUT_XDF" <<'PYEOF'
import sys
from pathlib import Path

SECTOR_SIZE = 1024
TOTAL_SECTORS = 1232
IMAGE_SIZE = SECTOR_SIZE * TOTAL_SECTORS

boot_path, body_path, sector_count, out_path = sys.argv[1:5]
sector_count = int(sector_count)

boot = Path(boot_path).read_bytes()
boot_sector = boot + bytes(SECTOR_SIZE - len(boot))

body = Path(body_path).read_bytes()
body_area = body + bytes(SECTOR_SIZE * sector_count - len(body))

image = boot_sector + body_area
image += bytes(IMAGE_SIZE - len(image))

Path(out_path).parent.mkdir(parents=True, exist_ok=True)
Path(out_path).write_bytes(image)
PYEOF
