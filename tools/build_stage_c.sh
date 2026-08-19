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
if [ "$STACK_ADDR_DEC" -ge "$RAM_SIZE_DEC" ]; then
  printf 'ERROR: STACK_ADDR(0x%X)が設定RAMサイズ(RAM_SIZE=0x%X)を超えている\n' "$STACK_ADDR_DEC" "$RAM_SIZE_DEC" >&2
  exit 1
fi

echo "== ブートセクタのビルド(SECTOR_COUNT=${SECTOR_COUNT}, STACK_ADDR=${STACK_ADDR}, RAM_SIZE=${RAM_SIZE}) =="
m68k-elf-gcc -x assembler-with-cpp -m68000 -DSECTOR_COUNT="${SECTOR_COUNT}" -DSTACK_ADDR="${STACK_ADDR}" -c "$ROOT/stage_c/boot/boot.S" -o "$OBJDIR/boot.o"
# cache_flush.S は MOVEC 命令(68010以降)を使うため -m68000 では assemble できない。
# -m68020 で assemble するのは「アセンブラに mnemonic を受理させる」ためだけで、
# 生成される命令バイト列自体は 68000 上でも(不正命令として安全に検出できる形で)
# そのまま実行できる。詳細は stage_c/boot/cache_flush.S のコメント参照。
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
