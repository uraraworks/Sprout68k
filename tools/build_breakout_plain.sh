#!/usr/bin/env bash
# X68kDev 作例「ブロック崩し」の素のコード(samples/breakout/main.c)を、
# 検証用パッチを一切当てずにそのままビルドする。
#
# tools/build_breakout.sh は verify/patches/breakout_verify.patch を当てた
# 版(HOSTVAR書き出し+故障注入マクロ入り)をビルドするが、こちらは入門者が
# 実際に読む main.c をそのままビルドし、「分離したせいで見本が壊れていないか」
# を確認するためのもの(docs/作例breakout_20260819.md「作例と検証の分離」参照)。
# verify/verify_breakout_plain.mts から呼ばれる。
#
# 使い方: tools/build_breakout_plain.sh <output.xdf>
#
# 前提: m68k-elf-gcc / m68k-elf-ld / m68k-elf-objcopy / m68k-elf-nm が
# PATH にあること。
set -euo pipefail

OUT_XDF="${1:?output.xdf が必要}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OBJDIR="$ROOT/build/breakout_plain_obj"
mkdir -p "$OBJDIR"

SECTOR_SIZE=1024
TOTAL_SECTORS=1232
LOAD_ADDR=$((0x3000))
STACK_ADDR="${STACK_ADDR:-0xF0000}"
STACK_ADDR_DEC=$((STACK_ADDR))
RAM_SIZE="${RAM_SIZE:-0x100000}"
RAM_SIZE_DEC=$((RAM_SIZE))
STACK_MARGIN=$((4096))

CFLAGS=(-m68000 -Os -ffreestanding -nostdlib -fomit-frame-pointer -fno-builtin -Wall -I"$ROOT/lib/include")

echo "== ライブラリ本体のビルド =="
m68k-elf-gcc "${CFLAGS[@]}" -c "$ROOT/lib/src/x68_std.c" -o "$OBJDIR/x68_std.o"
m68k-elf-gcc "${CFLAGS[@]}" -c "$ROOT/lib/src/x68_l0.c" -o "$OBJDIR/x68_l0.o"
m68k-elf-gcc "${CFLAGS[@]}" -c "$ROOT/lib/src/x68_l1.c" -o "$OBJDIR/x68_l1.o"
m68k-elf-gcc "${CFLAGS[@]}" -c "$ROOT/lib/src/x68_panic.c" -o "$OBJDIR/x68_panic.o"
m68k-elf-gcc "${CFLAGS[@]}" -c "$ROOT/lib/src/x68_input.c" -o "$OBJDIR/x68_input.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -c "$ROOT/lib/asm/x68_iocs.S" -o "$OBJDIR/x68_iocs.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -c "$ROOT/lib/asm/x68_gvram_copy.S" -o "$OBJDIR/x68_gvram_copy.o"
m68k-elf-gcc -x assembler-with-cpp -m68020 -c "$ROOT/lib/asm/x68_panic.S" -o "$OBJDIR/x68_panic_asm.o"

echo "== ブロック崩し本体(素のコード、C)のビルド =="
m68k-elf-gcc "${CFLAGS[@]}" -c "$ROOT/samples/breakout/main.c" -o "$OBJDIR/main.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -DSTACK_ADDR="${STACK_ADDR}" -c "$ROOT/stage_c/crt0/crt0.S" -o "$OBJDIR/crt0.o"

LIBGCC="$(m68k-elf-gcc -m68000 -print-libgcc-file-name)"
m68k-elf-ld -T "$ROOT/stage_c/crt0/linker.ld" -o "$OBJDIR/breakout.elf" \
  "$OBJDIR/crt0.o" "$OBJDIR/main.o" \
  "$OBJDIR/x68_std.o" "$OBJDIR/x68_l0.o" "$OBJDIR/x68_l1.o" "$OBJDIR/x68_panic.o" "$OBJDIR/x68_input.o" \
  "$OBJDIR/x68_iocs.o" "$OBJDIR/x68_gvram_copy.o" "$OBJDIR/x68_panic_asm.o" \
  "$LIBGCC"
m68k-elf-objcopy -O binary "$OBJDIR/breakout.elf" "$OBJDIR/breakout.bin"

BODY_SIZE=$(wc -c < "$OBJDIR/breakout.bin" | tr -d ' ')
SECTOR_COUNT=$(( (BODY_SIZE + SECTOR_SIZE - 1) / SECTOR_SIZE ))
if [ "$SECTOR_COUNT" -lt 1 ]; then SECTOR_COUNT=1; fi
echo "body size=${BODY_SIZE} bytes -> ${SECTOR_COUNT} セクタ"

BODY_END=$((LOAD_ADDR + BODY_SIZE))
if [ "$((BODY_END + STACK_MARGIN))" -gt "$STACK_ADDR_DEC" ]; then
  printf 'ERROR: 本体末尾(0x%X)がスタック(STACK_ADDR=0x%X, margin=%dバイト)と衝突する\n' "$BODY_END" "$STACK_ADDR_DEC" "$STACK_MARGIN" >&2
  exit 1
fi
if [ "$STACK_ADDR_DEC" -ge "$RAM_SIZE_DEC" ]; then
  printf 'ERROR: STACK_ADDR(0x%X)が設定RAMサイズ(RAM_SIZE=0x%X)を超えている\n' "$STACK_ADDR_DEC" "$RAM_SIZE_DEC" >&2
  exit 1
fi

BSS_END_HEX="$(m68k-elf-nm "$OBJDIR/breakout.elf" | awk '$3 == "__bss_end" { print $1 }')"
if [ -z "$BSS_END_HEX" ]; then
  echo "ERROR: __bss_end シンボルがELFに見つからない(リンカスクリプトの変更?)" >&2
  exit 1
fi
BSS_END_DEC=$((16#${BSS_END_HEX}))
echo "bss末尾(裏バッファ512KB含む)=0x${BSS_END_HEX}"
if [ "$((BSS_END_DEC + STACK_MARGIN))" -gt "$STACK_ADDR_DEC" ]; then
  printf 'ERROR: bss末尾(0x%X。裏バッファ512KBを含む)がスタック(STACK_ADDR=0x%X, margin=%dバイト)と衝突する\n' "$BSS_END_DEC" "$STACK_ADDR_DEC" "$STACK_MARGIN" >&2
  exit 1
fi
if [ "$((BSS_END_DEC + STACK_MARGIN))" -gt "$RAM_SIZE_DEC" ]; then
  printf 'ERROR: bss末尾(0x%X)が設定RAMサイズ(RAM_SIZE=0x%X)を超えている\n' "$BSS_END_DEC" "$RAM_SIZE_DEC" >&2
  exit 1
fi

echo "== ブートセクタのビルド(stage_d、SECTOR_COUNT=${SECTOR_COUNT}, STACK_ADDR=${STACK_ADDR}) =="
m68k-elf-gcc -x assembler-with-cpp -m68000 -DSECTOR_COUNT="${SECTOR_COUNT}" -DSTACK_ADDR="${STACK_ADDR}" -c "$ROOT/stage_d/boot/boot.S" -o "$OBJDIR/boot.o"
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
python3 - "$OBJDIR/boot.bin" "$OBJDIR/breakout.bin" "$SECTOR_COUNT" "$OUT_XDF" <<'PYEOF'
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

image = bytearray(boot_sector + body_area)
image += bytes(IMAGE_SIZE - len(image))
assert len(image) == IMAGE_SIZE

Path(out_path).parent.mkdir(parents=True, exist_ok=True)
Path(out_path).write_bytes(bytes(image))
print(f"wrote {out_path} ({len(image)} bytes, body={sector_count} sectors)")
PYEOF
