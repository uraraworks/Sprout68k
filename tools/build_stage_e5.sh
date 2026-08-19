#!/usr/bin/env bash
# Stage E-5(例外ハンドラの差し替え・捕捉実測)用ビルド。crt0/IOCS スタブ・
# リンカスクリプト・ブートセクタは Stage C のものをそのまま流用する
# (本体は小さく7セクタに収まるので Stage D のブートセクタは不要)。
#
# 使い方: tools/build_stage_e5.sh <exc_type:0|1|2> <mode:0|1|2> <output.xdf>
#   exc_type  0=アドレスエラー(vector3) 1=不正命令(vector4) 2=ゼロ除算(vector5)
#   mode      0=ハンドラ差し替え+例外を起こす(陽性)
#             1=ハンドラ差し替えなし+例外を起こす(陰性対照)
#             2=ハンドラ差し替えのみ、例外は起こさない(正常実行確認)
#
# 前提: m68k-elf-gcc / m68k-elf-ld / m68k-elf-objcopy が PATH にあること。
set -euo pipefail

EXC_TYPE="${1:?exc_type(0|1|2)が必要}"
MODE="${2:?mode(0|1|2)が必要}"
OUT_XDF="${3:?output.xdf が必要}"

case "$EXC_TYPE" in
  0|1|2) ;;
  *) echo "ERROR: exc_type は 0(addr error)/1(illegal)/2(zerodiv) のいずれかであること(渡された値=${EXC_TYPE})" >&2; exit 1 ;;
esac
case "$MODE" in
  0|1|2) ;;
  *) echo "ERROR: mode は 0(install+trigger)/1(no-install+trigger)/2(install+no-trigger) のいずれかであること(渡された値=${MODE})" >&2; exit 1 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OBJDIR="$ROOT/build/stage_e5_obj_t${EXC_TYPE}_m${MODE}"
mkdir -p "$OBJDIR"

SECTOR_SIZE=1024
TOTAL_SECTORS=1232
LOAD_ADDR=$((0x3000))
# Stage C/D/E-1/E-3 と同じ既定(1MB機で確実に成立する位置)。本体が小さいので収まる。
STACK_ADDR="${STACK_ADDR:-0xF0000}"
STACK_ADDR_DEC=$((STACK_ADDR)) # bash 3.2(macOS既定)の `[` は0x接頭辞を認識しないため10進化
RAM_SIZE="${RAM_SIZE:-0x100000}"
RAM_SIZE_DEC=$((RAM_SIZE))
STACK_MARGIN=$((4096))

# main_e5.c / e5_handlers.S 内の固定アドレス(HOSTVAR)。E-2/E-3が使う
# 0xE0000/0xE0010/0xE0020と衝突しないことをビルド時にも確認する。
HOSTVAR_MARKER_ADDR=$((0xE0030))
HOSTVAR_ALIVE_ADDR=$((0xE0034))
if [ "$HOSTVAR_MARKER_ADDR" -lt "$((0xE0028))" ] || [ "$HOSTVAR_ALIVE_ADDR" -ge "$((0xE0040))" ]; then
  echo "ERROR: HOSTVARアドレスが想定範囲(0xE0028-0xE0040)から外れている(定数変更時の見直し漏れ)" >&2
  exit 1
fi
if [ "$((HOSTVAR_ALIVE_ADDR + 4 + STACK_MARGIN))" -gt "$STACK_ADDR_DEC" ]; then
  printf 'ERROR: HOSTVAR領域(0x%X)がスタック(STACK_ADDR=0x%X)に近すぎる\n' "$HOSTVAR_ALIVE_ADDR" "$STACK_ADDR_DEC" >&2
  exit 1
fi
if [ "$STACK_ADDR_DEC" -ge "$RAM_SIZE_DEC" ]; then
  printf 'ERROR: STACK_ADDR(0x%X)が設定RAMサイズ(RAM_SIZE=0x%X)を超えている\n' "$STACK_ADDR_DEC" "$RAM_SIZE_DEC" >&2
  exit 1
fi

CFLAGS=(-m68000 -Os -ffreestanding -nostdlib -fomit-frame-pointer -fno-builtin -Wall \
  -DEXC_TYPE="${EXC_TYPE}" -DMODE="${MODE}")

echo "== Stage E-5 本体(C+ASM, EXC_TYPE=${EXC_TYPE}, MODE=${MODE})のビルド =="
m68k-elf-gcc "${CFLAGS[@]}" -c "$ROOT/stage_e/src/main_e5.c" -o "$OBJDIR/main.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -c "$ROOT/stage_e/src/e5_handlers.S" -o "$OBJDIR/e5_handlers.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -DSTACK_ADDR="${STACK_ADDR}" -c "$ROOT/stage_c/crt0/crt0.S" -o "$OBJDIR/crt0.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -c "$ROOT/stage_c/crt0/iocs.S" -o "$OBJDIR/iocs.o"
m68k-elf-ld -T "$ROOT/stage_c/crt0/linker.ld" -o "$OBJDIR/stage_e5.elf" \
  "$OBJDIR/crt0.o" "$OBJDIR/iocs.o" "$OBJDIR/main.o" "$OBJDIR/e5_handlers.o"
m68k-elf-objcopy -O binary "$OBJDIR/stage_e5.elf" "$OBJDIR/stage_e5.bin"

BODY_SIZE=$(wc -c < "$OBJDIR/stage_e5.bin" | tr -d ' ')
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
python3 - "$OBJDIR/boot.bin" "$OBJDIR/stage_e5.bin" "$SECTOR_COUNT" "$OUT_XDF" <<'PYEOF'
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
