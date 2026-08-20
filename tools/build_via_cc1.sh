#!/usr/bin/env bash
# GCC driver にコンパイルを駆動させず、cc1/as/ld/objcopy を個別に起動する。
#
# 使い方: tools/build_via_cc1.sh <stage_c|breakout> <output.xdf>
#   breakout は tools/build_breakout_plain.sh と同じ「素の作例」をビルドする。
#
# CC1_OPT_LEVEL は陽性対照専用。通常は既存ビルドと同じ -Os であり、例えば
# CC1_OPT_LEVEL=-O0 とすると最適化条件を意図的に変えられる。
set -euo pipefail

TARGET="${1:?対象(stage_c または breakout)が必要}"
OUT_XDF="${2:?output.xdf が必要}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CC1="$(m68k-elf-gcc -print-prog-name=cc1)"
AS="$(command -v m68k-elf-as)"
LD="$(command -v m68k-elf-ld)"
OBJCOPY="$(command -v m68k-elf-objcopy)"
NM="$(command -v m68k-elf-nm)"
OPT_LEVEL="${CC1_OPT_LEVEL:--Os}"
BUILD_VARIANT="${CC1_BUILD_VARIANT:-}"

if [ ! -x "$CC1" ]; then
  echo "ERROR: cc1 が実行できない: $CC1" >&2
  exit 1
fi
case "$OPT_LEVEL" in
  -O0|-O1|-O2|-O3|-Os|-Oz|-Og|-Ofast) ;;
  *) echo "ERROR: CC1_OPT_LEVEL に指定できない値: $OPT_LEVEL" >&2; exit 1 ;;
esac
case "$BUILD_VARIANT" in
  ""|positive) ;;
  *) echo "ERROR: CC1_BUILD_VARIANT に指定できない値: $BUILD_VARIANT" >&2; exit 1 ;;
esac

SECTOR_SIZE=1024
TOTAL_SECTORS=1232
LOAD_ADDR=$((0x3000))
STACK_ADDR="${STACK_ADDR:-0xF0000}"
STACK_ADDR_DEC=$((STACK_ADDR))
RAM_SIZE="${RAM_SIZE:-0x100000}"
RAM_SIZE_DEC=$((RAM_SIZE))
STACK_MARGIN=4096

compile_c() {
  local src="$1"
  local out="$2"
  shift 2
  local asm_out="${out%.o}.s"
  local dumpbase
  dumpbase="$(basename "$src")"

  "$CC1" -quiet -imultilib m68000 "$@" "$src" -quiet \
    -dumpdir "$(dirname "$out")/" -dumpbase "$dumpbase" -dumpbase-ext .c \
    -mcpu=68000 "$OPT_LEVEL" -Wall -ffreestanding -fomit-frame-pointer \
    -fno-builtin -o "$asm_out"
  "$AS" -mcpu=68000 -o "$out" "$asm_out"
}

assemble_cpp() {
  local cpu="$1"
  local src="$2"
  local out="$3"
  shift 3
  local asm_out="${out%.o}.s"
  if [ "$cpu" = 68000 ]; then
    "$CC1" -E -lang-asm -quiet -imultilib m68000 "$@" "$src" \
      -mcpu="$cpu" -fno-directives-only -o "$asm_out"
  else
    "$CC1" -E -lang-asm -quiet "$@" "$src" \
      -mcpu="$cpu" -fno-directives-only -o "$asm_out"
  fi
  "$AS" -mcpu="$cpu" -o "$out" "$asm_out"
}

make_xdf() {
  local boot="$1"
  local body="$2"
  local sectors="$3"
  local output="$4"
  python3 - "$boot" "$body" "$sectors" "$output" <<'PYEOF'
import sys
from pathlib import Path

SECTOR_SIZE = 1024
IMAGE_SIZE = SECTOR_SIZE * 1232
boot_path, body_path, sector_count, out_path = sys.argv[1:5]
sector_count = int(sector_count)

boot = Path(boot_path).read_bytes()
assert len(boot) <= SECTOR_SIZE
body = Path(body_path).read_bytes()
image = boot + bytes(SECTOR_SIZE - len(boot))
image += body + bytes(SECTOR_SIZE * sector_count - len(body))
image += bytes(IMAGE_SIZE - len(image))
assert len(image) == IMAGE_SIZE
Path(out_path).parent.mkdir(parents=True, exist_ok=True)
Path(out_path).write_bytes(image)
print(f"wrote {out_path} ({len(image)} bytes, body={sector_count} sectors)")
PYEOF
}

check_memory_layout() {
  local body_size="$1"
  local body_end=$((LOAD_ADDR + body_size))
  if [ "$((body_end + STACK_MARGIN))" -gt "$STACK_ADDR_DEC" ]; then
    printf 'ERROR: 本体末尾(0x%X)がスタック(STACK_ADDR=0x%X, margin=%dバイト)と衝突する\n' \
      "$body_end" "$STACK_ADDR_DEC" "$STACK_MARGIN" >&2
    exit 1
  fi
  if [ "$STACK_ADDR_DEC" -ge "$RAM_SIZE_DEC" ]; then
    printf 'ERROR: STACK_ADDR(0x%X)が設定RAMサイズ(RAM_SIZE=0x%X)を超えている\n' \
      "$STACK_ADDR_DEC" "$RAM_SIZE_DEC" >&2
    exit 1
  fi
}

link_boot() {
  local objdir="$1"
  local boot_src="$2"
  local sectors="$3"
  assemble_cpp 68000 "$boot_src" "$objdir/boot.o" \
    -D "SECTOR_COUNT=$sectors" -D "STACK_ADDR=$STACK_ADDR"
  assemble_cpp 68020 "$ROOT/stage_c/boot/cache_flush.S" "$objdir/cache_flush.o"
  printf '%s\n' 'SECTIONS { . = 0x0; .text : { *(.text) *(.rodata) *(.data) } }' \
    > "$objdir/boot_link.ld"
  "$LD" -T "$objdir/boot_link.ld" -o "$objdir/boot.elf" \
    "$objdir/boot.o" "$objdir/cache_flush.o"
  "$OBJCOPY" -O binary "$objdir/boot.elf" "$objdir/boot.bin"
  local boot_size
  boot_size=$(wc -c < "$objdir/boot.bin" | tr -d ' ')
  if [ "$boot_size" -gt "$SECTOR_SIZE" ]; then
    echo "ERROR: ブートセクタが1024バイトを超えている($boot_size)" >&2
    exit 1
  fi
}

build_stage_c() {
  local objdir="$ROOT/build/via_cc1/stage_c${BUILD_VARIANT:+_$BUILD_VARIANT}"
  mkdir -p "$objdir"
  echo "== Stage C を cc1/as でビルド(opt=$OPT_LEVEL) =="
  compile_c "$ROOT/stage_c/src/main.c" "$objdir/main.o" -D "FILL_COLOR=0xFFFF"
  assemble_cpp 68000 "$ROOT/stage_c/crt0/crt0.S" "$objdir/crt0.o" \
    -D "STACK_ADDR=$STACK_ADDR"
  assemble_cpp 68000 "$ROOT/stage_c/crt0/iocs.S" "$objdir/iocs.o"
  "$LD" -T "$ROOT/stage_c/crt0/linker.ld" -o "$objdir/stage_c.elf" \
    "$objdir/crt0.o" "$objdir/iocs.o" "$objdir/main.o"
  "$OBJCOPY" -O binary "$objdir/stage_c.elf" "$objdir/stage_c.bin"

  local body_size sectors
  body_size=$(wc -c < "$objdir/stage_c.bin" | tr -d ' ')
  sectors=$(( (body_size + SECTOR_SIZE - 1) / SECTOR_SIZE ))
  if [ "$sectors" -lt 1 ]; then sectors=1; fi
  if [ "$sectors" -gt 7 ]; then
    echo "ERROR: 本体が7セクタ(7168バイト)を超えている。" >&2
    exit 1
  fi
  check_memory_layout "$body_size"
  link_boot "$objdir" "$ROOT/stage_c/boot/boot.S" "$sectors"
  make_xdf "$objdir/boot.bin" "$objdir/stage_c.bin" "$sectors" "$OUT_XDF"
}

build_breakout() {
  local objdir="$ROOT/build/via_cc1/breakout${BUILD_VARIANT:+_$BUILD_VARIANT}"
  mkdir -p "$objdir"
  echo "== breakout を cc1/as でビルド(opt=$OPT_LEVEL) =="
  local cflags=(-I "$ROOT/lib/include")
  compile_c "$ROOT/lib/src/x68_std.c" "$objdir/x68_std.o" "${cflags[@]}"
  compile_c "$ROOT/lib/src/x68_l0.c" "$objdir/x68_l0.o" "${cflags[@]}"
  compile_c "$ROOT/lib/src/x68_l1.c" "$objdir/x68_l1.o" "${cflags[@]}"
  compile_c "$ROOT/lib/src/x68_panic.c" "$objdir/x68_panic.o" "${cflags[@]}"
  compile_c "$ROOT/lib/src/x68_input.c" "$objdir/x68_input.o" "${cflags[@]}"
  compile_c "$ROOT/samples/breakout/main.c" "$objdir/main.o" "${cflags[@]}"
  assemble_cpp 68000 "$ROOT/lib/asm/x68_iocs.S" "$objdir/x68_iocs.o"
  assemble_cpp 68000 "$ROOT/lib/asm/x68_gvram_copy.S" "$objdir/x68_gvram_copy.o"
  assemble_cpp 68020 "$ROOT/lib/asm/x68_panic.S" "$objdir/x68_panic_asm.o"
  assemble_cpp 68000 "$ROOT/stage_c/crt0/crt0.S" "$objdir/crt0.o" \
    -D "STACK_ADDR=$STACK_ADDR"

  # cc1 の配置から同一 GCC の multilib を特定し、driver には問い合わせない。
  local gcc_version gcc_prefix libgcc
  gcc_version="$(basename "$(dirname "$CC1")")"
  gcc_prefix="${CC1%%/libexec/gcc/*}"
  libgcc="$gcc_prefix/lib/gcc/m68k-elf/$gcc_version/m68000/libgcc.a"
  if [ ! -f "$libgcc" ]; then
    echo "ERROR: libgcc が見つからない: $libgcc" >&2
    exit 1
  fi
  "$LD" -T "$ROOT/stage_c/crt0/linker.ld" -o "$objdir/breakout.elf" \
    "$objdir/crt0.o" "$objdir/main.o" \
    "$objdir/x68_std.o" "$objdir/x68_l0.o" "$objdir/x68_l1.o" \
    "$objdir/x68_panic.o" "$objdir/x68_input.o" \
    "$objdir/x68_iocs.o" "$objdir/x68_gvram_copy.o" "$objdir/x68_panic_asm.o" \
    "$libgcc"
  "$OBJCOPY" -O binary "$objdir/breakout.elf" "$objdir/breakout.bin"

  local body_size sectors bss_end_hex bss_end_dec
  body_size=$(wc -c < "$objdir/breakout.bin" | tr -d ' ')
  sectors=$(( (body_size + SECTOR_SIZE - 1) / SECTOR_SIZE ))
  if [ "$sectors" -lt 1 ]; then sectors=1; fi
  check_memory_layout "$body_size"
  bss_end_hex="$($NM "$objdir/breakout.elf" | awk '$3 == "__bss_end" { print $1 }')"
  if [ -z "$bss_end_hex" ]; then
    echo "ERROR: __bss_end シンボルがELFに見つからない" >&2
    exit 1
  fi
  bss_end_dec=$((16#$bss_end_hex))
  if [ "$((bss_end_dec + STACK_MARGIN))" -gt "$STACK_ADDR_DEC" ] || \
     [ "$((bss_end_dec + STACK_MARGIN))" -gt "$RAM_SIZE_DEC" ]; then
    echo "ERROR: bss末尾がスタックまたは設定RAMサイズと衝突する" >&2
    exit 1
  fi
  link_boot "$objdir" "$ROOT/stage_d/boot/boot.S" "$sectors"
  make_xdf "$objdir/boot.bin" "$objdir/breakout.bin" "$sectors" "$OUT_XDF"
}

case "$TARGET" in
  stage_c) build_stage_c ;;
  breakout) build_breakout ;;
  *) echo "ERROR: 未知の対象: $TARGET" >&2; exit 1 ;;
esac
