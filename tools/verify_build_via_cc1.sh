#!/usr/bin/env bash
# F-1: GCC driver ビルドと cc1/as/ld/objcopy 直接ビルドを md5 で検証する。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
RESULT_DIR="$ROOT/build/f1"
TRACE_DIR="$RESULT_DIR/driver_traces"
mkdir -p "$TRACE_DIR"

md5_value() {
  if command -v md5 >/dev/null 2>&1; then
    md5 -q "$1"
  else
    md5sum "$1" | awk '{print $1}'
  fi
}

expect_same() {
  local label="$1" left="$2" right="$3"
  local left_md5 right_md5
  left_md5="$(md5_value "$left")"
  right_md5="$(md5_value "$right")"
  if [ "$left_md5" != "$right_md5" ]; then
    echo "FAIL(不一致): $label $left_md5 != $right_md5" >&2
    return 1
  fi
  echo "PASS(一致): $label $left_md5"
}

expect_different() {
  local label="$1" left="$2" right="$3"
  local left_md5 right_md5
  left_md5="$(md5_value "$left")"
  right_md5="$(md5_value "$right")"
  if [ "$left_md5" = "$right_md5" ]; then
    echo "FAIL(陽性対照が一致): $label $left_md5" >&2
    return 1
  fi
  echo "PASS(陽性対照は不一致): $label $left_md5 != $right_md5"
}

echo "== GCC driver の実コマンド列を -### で採取 =="
m68k-elf-gcc -### -m68000 -Os -ffreestanding -nostdlib \
  -fomit-frame-pointer -fno-builtin -Wall -DFILL_COLOR=0xFFFF \
  -c "$ROOT/stage_c/src/main.c" -o "$RESULT_DIR/probe_main.o" \
  2> "$TRACE_DIR/c.trace"
m68k-elf-gcc -### -x assembler-with-cpp -m68000 -DSTACK_ADDR=0xF0000 \
  -c "$ROOT/stage_c/crt0/crt0.S" -o "$RESULT_DIR/probe_crt0.o" \
  2> "$TRACE_DIR/asm_68000.trace"
m68k-elf-gcc -### -x assembler-with-cpp -m68020 \
  -c "$ROOT/stage_c/boot/cache_flush.S" -o "$RESULT_DIR/probe_cache_flush.o" \
  2> "$TRACE_DIR/asm_68020.trace"

echo "== Stage C: driver と直接起動版 =="
"$HERE/build_stage_c.sh" 0xFFFF "$RESULT_DIR/stage_c_driver.xdf"
"$HERE/build_via_cc1.sh" stage_c "$RESULT_DIR/stage_c_cc1.xdf"
for file in main.o crt0.o iocs.o stage_c.elf stage_c.bin \
            boot.o cache_flush.o boot.elf boot.bin; do
  expect_same "stage_c/$file" \
    "$ROOT/build/stage_c_obj/$file" "$ROOT/build/via_cc1/stage_c/$file"
done
expect_same "stage_c.xdf" \
  "$RESULT_DIR/stage_c_driver.xdf" "$RESULT_DIR/stage_c_cc1.xdf"

echo "== breakout: driver と直接起動版 =="
"$HERE/build_breakout_plain.sh" "$RESULT_DIR/breakout_driver.xdf"
"$HERE/build_via_cc1.sh" breakout "$RESULT_DIR/breakout_cc1.xdf"
for file in x68_std.o x68_l0.o x68_l1.o x68_panic.o x68_input.o main.o \
            x68_iocs.o x68_gvram_copy.o x68_panic_asm.o crt0.o \
            breakout.elf breakout.bin boot.o cache_flush.o boot.elf boot.bin; do
  expect_same "breakout/$file" \
    "$ROOT/build/breakout_plain_obj/$file" "$ROOT/build/via_cc1/breakout/$file"
done
expect_same "breakout.xdf" \
  "$RESULT_DIR/breakout_driver.xdf" "$RESULT_DIR/breakout_cc1.xdf"

echo "== 陽性対照: Stage C の -Os を -O0 に変更 =="
CC1_OPT_LEVEL=-O0 CC1_BUILD_VARIANT=positive \
  "$HERE/build_via_cc1.sh" stage_c "$RESULT_DIR/stage_c_positive_o0.xdf"
expect_different "stage_c/main.o (-Os 対 -O0)" \
  "$ROOT/build/via_cc1/stage_c/main.o" \
  "$ROOT/build/via_cc1/stage_c_positive/main.o"
expect_different "stage_c.elf (-Os 対 -O0)" \
  "$ROOT/build/via_cc1/stage_c/stage_c.elf" \
  "$ROOT/build/via_cc1/stage_c_positive/stage_c.elf"
expect_different "stage_c.bin (-Os 対 -O0)" \
  "$ROOT/build/via_cc1/stage_c/stage_c.bin" \
  "$ROOT/build/via_cc1/stage_c_positive/stage_c.bin"
expect_different "stage_c.xdf (-Os 対 -O0)" \
  "$RESULT_DIR/stage_c_cc1.xdf" "$RESULT_DIR/stage_c_positive_o0.xdf"

echo "F-1 検証 PASS"
