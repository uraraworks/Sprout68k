#!/usr/bin/env bash
# Stage E-2(垂直同期検出手段の実測)用ビルド。crt0/IOCS スタブ・リンカスクリプト・
# ブートセクタは Stage C のものをそのまま流用する(本体はごく小さい)。
#
# 使い方: tools/build_stage_e2.sh <use_vsync_wait: 0|1> <output.xdf>
#   use_vsync_wait=1  MFP GPIP($E88001) bit4 の立下りエッジ待ちを行う版
#   use_vsync_wait=0  同期待ちをしない版(陰性対照)
#
# 前提: m68k-elf-gcc / m68k-elf-ld / m68k-elf-objcopy が PATH にあること。
set -euo pipefail

USE_VSYNC_WAIT="${1:?use_vsync_wait(0|1)が必要}"
OUT_XDF="${2:?output.xdf が必要}"

case "$USE_VSYNC_WAIT" in
  0|1) ;;
  *) echo "ERROR: use_vsync_wait は 0 か 1 を指定すること(渡された値=${USE_VSYNC_WAIT})" >&2; exit 1 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OBJDIR="$ROOT/build/stage_e2_obj_v${USE_VSYNC_WAIT}"
mkdir -p "$OBJDIR"

SECTOR_SIZE=1024
TOTAL_SECTORS=1232
LOAD_ADDR=$((0x3000))
STACK_ADDR="${STACK_ADDR:-0xF0000}"
STACK_ADDR_DEC=$((STACK_ADDR))
RAM_SIZE="${RAM_SIZE:-0x100000}"
RAM_SIZE_DEC=$((RAM_SIZE))
STACK_MARGIN=$((4096))

CFLAGS=(-m68000 -Os -ffreestanding -nostdlib -fomit-frame-pointer -fno-builtin -Wall -DUSE_VSYNC_WAIT="${USE_VSYNC_WAIT}")

echo "== Stage E-2 本体(C, USE_VSYNC_WAIT=${USE_VSYNC_WAIT})のビルド =="
m68k-elf-gcc "${CFLAGS[@]}" -c "$ROOT/stage_e/src/main_e2.c" -o "$OBJDIR/main.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -DSTACK_ADDR="${STACK_ADDR}" -c "$ROOT/stage_c/crt0/crt0.S" -o "$OBJDIR/crt0.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -c "$ROOT/stage_c/crt0/iocs.S" -o "$OBJDIR/iocs.o"
m68k-elf-ld -T "$ROOT/stage_c/crt0/linker.ld" -o "$OBJDIR/stage_e2.elf" \
  "$OBJDIR/crt0.o" "$OBJDIR/iocs.o" "$OBJDIR/main.o"
m68k-elf-objcopy -O binary "$OBJDIR/stage_e2.elf" "$OBJDIR/stage_e2.bin"

BODY_SIZE=$(wc -c < "$OBJDIR/stage_e2.bin" | tr -d ' ')
SECTOR_COUNT=$(( (BODY_SIZE + SECTOR_SIZE - 1) / SECTOR_SIZE ))
if [ "$SECTOR_COUNT" -lt 1 ]; then SECTOR_COUNT=1; fi
echo "body size=${BODY_SIZE} bytes -> ${SECTOR_COUNT} セクタ"

if [ "$SECTOR_COUNT" -gt 7 ]; then
  echo "ERROR: 本体が7セクタ(7168バイト)を超えている。stage_c/boot/boot.S はtrack0/side0内(7セクタ)しか読めない。" >&2
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
# HOSTVAR_COUNTER($000E0000, main_e2.c参照)がロード領域・スタックと重ならないことの
# 確認(固定アドレスなのでリンク後バイナリサイズには現れない。ここで別途検査する)。
HOSTVAR_ADDR=$((0xE0000))
if [ "$HOSTVAR_ADDR" -lt "$BODY_END" ] || [ "$((HOSTVAR_ADDR + 4))" -gt "$((STACK_ADDR_DEC - STACK_MARGIN))" ]; then
  printf 'ERROR: HOSTVAR_COUNTER(0x%X)が本体末尾(0x%X)〜スタック手前(0x%X)の安全域に収まっていない\n' "$HOSTVAR_ADDR" "$BODY_END" "$((STACK_ADDR_DEC - STACK_MARGIN))" >&2
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
python3 - "$OBJDIR/boot.bin" "$OBJDIR/stage_e2.bin" "$SECTOR_COUNT" "$OUT_XDF" <<'PYEOF'
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
