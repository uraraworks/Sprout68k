#!/usr/bin/env bash
# X68kDev ライブラリ第一版(lib/)のテストプログラム(lib_test/src/main.c)を
# ビルドして .xdf にする。
#
# 使い方: tools/build_lib_test.sh <output.xdf> [fault]
#   output.xdf: 出力ディスクイメージ
#   fault:      省略時は通常ビルド。以下のいずれかを指定すると、その関数だけ
#               意図的に壊した版をビルドする(検証の故障注入用。壊した版は
#               成果物として残さないこと):
#                 memcpy_skip_last     memcpyが最後の1バイトをコピーしない
#                 strlen_off_by_one    strlenが実際の長さ+1を返す
#                 printf_drop_sign     printfの%dが負号を出力しない
#                 vsync_no_wait        x68_vsync_waitが一切待たず即returnする
#                 gvram_copy_offset    x68_gvram_copy_movemの転送先を1ワードずらす
#                 bitsns_always_zero   x68_iocs_bitsnsが常に0(押下無し)を返す
#
# ブートセクタは stage_d/boot/boot.S(track/sideをまたぐ複数セクタ読み込み
# 対応、実測済み)を流用する。crt0/リンカスクリプトは stage_c のものを
# そのまま使う(パターン専用セクションが不要なため)。
#
# IOCS $46 のテスト用に、track30/side0/sector1(本体が絶対に届かない安全な
# 位置)へ既知パターン(先頭11バイト "X68DISKTEST"、以降 (i & 0xFF))を
# 焼き込む。パターン生成規則は lib_test/src/main.c の test_disk_read() と
# verify/verify_lib.mts の両方で同じ式を独立に実装している(この
# ビルドスクリプトはその「答え」をディスクへ書くだけ)。
#
# 前提: m68k-elf-gcc / m68k-elf-ld / m68k-elf-objcopy が PATH にあること。
set -euo pipefail

OUT_XDF="${1:?output.xdf が必要}"
FAULT="${2:-}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OBJDIR="$ROOT/build/lib_test_obj"
mkdir -p "$OBJDIR"

SECTOR_SIZE=1024
TOTAL_SECTORS=1232
LOAD_ADDR=$((0x3000))
STACK_ADDR="${STACK_ADDR:-0xF0000}"
STACK_ADDR_DEC=$((STACK_ADDR))
RAM_SIZE="${RAM_SIZE:-0x100000}"
RAM_SIZE_DEC=$((RAM_SIZE))
STACK_MARGIN=$((4096))

# ディスクテスト用パターンを置くセクタ(track30/side0/sector1)。
# px68k-libretro disk_xdf.c の物理配置式
#   pos = ((track*2+side)*8 + (sector-1)) * 1024
# より、track30/side0/sector1 の絶対バイトオフセットは
#   ((30*2+0)*8 + 0) * 1024 = 491520
DISKTEST_TRACK=30
DISKTEST_SIDE=0
DISKTEST_SECTOR=1
DISKTEST_OFFSET=$(( ((DISKTEST_TRACK*2+DISKTEST_SIDE)*8 + (DISKTEST_SECTOR-1)) * SECTOR_SIZE ))

CFLAGS=(-m68000 -Os -ffreestanding -nostdlib -fomit-frame-pointer -fno-builtin -Wall -I"$ROOT/lib/include")

FAULT_DEFINE=()
case "$FAULT" in
  "") ;;
  memcpy_skip_last) FAULT_DEFINE=(-DX68_FAULT_MEMCPY_SKIP_LAST) ;;
  strlen_off_by_one) FAULT_DEFINE=(-DX68_FAULT_STRLEN_OFF_BY_ONE) ;;
  printf_drop_sign) FAULT_DEFINE=(-DX68_FAULT_PRINTF_DROP_SIGN) ;;
  vsync_no_wait) FAULT_DEFINE=(-DX68_FAULT_VSYNC_NO_WAIT) ;;
  gvram_copy_offset) FAULT_DEFINE=(-DX68_FAULT_GVRAM_COPY_OFFSET) ;;
  bitsns_always_zero) FAULT_DEFINE=(-DX68_FAULT_BITSNS_ALWAYS_ZERO) ;;
  *) echo "ERROR: 未知のfault指定: ${FAULT}" >&2; exit 1 ;;
esac
if [ -n "$FAULT" ]; then
  echo "== 故障注入ビルド: ${FAULT} =="
fi

echo "== ライブラリ本体のビルド =="
# FAULT_DEFINEはlib/配下の4ファイル全部に一律で渡す(該当するfaultマクロを
# 見ないファイルでは単に無視されるだけなので害が無く、fault名→対象ファイルの
# 対応表をここで管理しなくて済む)。
m68k-elf-gcc "${CFLAGS[@]}" ${FAULT_DEFINE[@]+"${FAULT_DEFINE[@]}"} -c "$ROOT/lib/src/x68_std.c" -o "$OBJDIR/x68_std.o"
m68k-elf-gcc "${CFLAGS[@]}" ${FAULT_DEFINE[@]+"${FAULT_DEFINE[@]}"} -c "$ROOT/lib/src/x68_l0.c" -o "$OBJDIR/x68_l0.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 ${FAULT_DEFINE[@]+"${FAULT_DEFINE[@]}"} -c "$ROOT/lib/asm/x68_iocs.S" -o "$OBJDIR/x68_iocs.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 ${FAULT_DEFINE[@]+"${FAULT_DEFINE[@]}"} -c "$ROOT/lib/asm/x68_gvram_copy.S" -o "$OBJDIR/x68_gvram_copy.o"

echo "== テストプログラム(C)のビルド =="
m68k-elf-gcc "${CFLAGS[@]}" -c "$ROOT/lib_test/src/main.c" -o "$OBJDIR/main.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -DSTACK_ADDR="${STACK_ADDR}" -c "$ROOT/stage_c/crt0/crt0.S" -o "$OBJDIR/crt0.o"

# 32bit同士の乗除算(rand()の乗算、printfの10進/16進変換の除算)はm68000の
# ハードウェア命令(16bit同士のMULU/DIVU)では足りず、gccがlibgccのソフト
# ウェア実装(__mulsi3/__udivsi3/__umodsi3等)を暗黙に呼ぶ。-nostdlibは
# 標準ライブラリだけでなくlibgccも道連れに除外してしまう(-nodefaultlibs
# 相当を含むため)ので、ここだけ明示的にlibgcc.aをリンクに加える。
LIBGCC="$(m68k-elf-gcc -m68000 -print-libgcc-file-name)"
m68k-elf-ld -T "$ROOT/stage_c/crt0/linker.ld" -o "$OBJDIR/lib_test.elf" \
  "$OBJDIR/crt0.o" "$OBJDIR/main.o" \
  "$OBJDIR/x68_std.o" "$OBJDIR/x68_l0.o" "$OBJDIR/x68_iocs.o" "$OBJDIR/x68_gvram_copy.o" \
  "$LIBGCC"
m68k-elf-objcopy -O binary "$OBJDIR/lib_test.elf" "$OBJDIR/lib_test.bin"

BODY_SIZE=$(wc -c < "$OBJDIR/lib_test.bin" | tr -d ' ')
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
if [ "$((LOAD_ADDR + BODY_SIZE))" -gt "$DISKTEST_OFFSET" ]; then
  printf 'ERROR: 本体末尾(0x%X)がディスクテストパターンの位置(offset=%d)を超えている\n' "$((LOAD_ADDR + BODY_SIZE))" "$DISKTEST_OFFSET" >&2
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

echo "== .xdf の合成(ディスクテストパターンをoffset=${DISKTEST_OFFSET}へ焼き込み) =="
python3 - "$OBJDIR/boot.bin" "$OBJDIR/lib_test.bin" "$SECTOR_COUNT" "$DISKTEST_OFFSET" "$OUT_XDF" <<'PYEOF'
import sys
from pathlib import Path

SECTOR_SIZE = 1024
TOTAL_SECTORS = 1232
IMAGE_SIZE = SECTOR_SIZE * TOTAL_SECTORS

boot_path, body_path, sector_count, disktest_offset, out_path = sys.argv[1:6]
sector_count = int(sector_count)
disktest_offset = int(disktest_offset)

boot = Path(boot_path).read_bytes()
assert len(boot) <= SECTOR_SIZE
boot_sector = boot + bytes(SECTOR_SIZE - len(boot))

body = Path(body_path).read_bytes()
body_area = body + bytes(SECTOR_SIZE * sector_count - len(body))
assert len(body_area) == SECTOR_SIZE * sector_count

image = bytearray(boot_sector + body_area)
image += bytes(IMAGE_SIZE - len(image))
assert len(image) == IMAGE_SIZE

# ディスクテストパターン: 先頭11バイト "X68DISKTEST"、以降 (i & 0xFF)。
# lib_test/src/main.c の test_disk_read() / verify/verify_lib.mts と
# 同じ生成規則(3箇所で独立に実装している)。
sig = b"X68DISKTEST"
pattern = bytearray(SECTOR_SIZE)
pattern[0:len(sig)] = sig
for i in range(len(sig), SECTOR_SIZE):
    pattern[i] = i & 0xFF

assert disktest_offset + SECTOR_SIZE <= IMAGE_SIZE
# 本体と重ならないことの確認(ビルドスクリプト側でも確認済みだが二重チェック)
assert disktest_offset >= SECTOR_SIZE + len(body), "diskテストパターンが本体と重なっている"
image[disktest_offset:disktest_offset + SECTOR_SIZE] = pattern

Path(out_path).parent.mkdir(parents=True, exist_ok=True)
Path(out_path).write_bytes(bytes(image))
print(f"wrote {out_path} ({len(image)} bytes, body={sector_count} sectors, disktest_offset={disktest_offset})")
PYEOF
