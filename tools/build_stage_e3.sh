#!/usr/bin/env bash
# Stage E-3(裏バッファ→GVRAM 転送速度の実測、再測定版)用ビルド。crt0/IOCS スタブ・
# リンカスクリプト・ブートセクタは Stage C のものをそのまま流用する。
#
# 使い方: tools/build_stage_e3.sh <K_bytes> <method:0|1|2> <poll_interval> <n_repeats> <output.xdf>
#   K_bytes        転送するバイト数
#   method         0=word版(MOVE.W単位) 1=long版(MOVE.L単位) 2=movem版(8ロング=32バイト単位)
#   poll_interval  何コピー単位ごとに1回 MFP GPIP を読むか(単位は方式依存)
#   n_repeats      同じK_bytesの転送を何回繰り返すか(垂直同期回数を積算して
#                   量子化誤差を薄めるため。詳細はstage_e/src/main_e3.cのコメント参照)
#
# K_bytes は方式に応じた単位の倍数であること: word=2の倍数、long=4の倍数、
# movem=32の倍数(8ロング分)。
#
# 前提: m68k-elf-gcc / m68k-elf-ld / m68k-elf-objcopy が PATH にあること。
set -euo pipefail

K_BYTES="${1:?K_bytes(転送バイト数)が必要}"
METHOD="${2:?method(0|1|2)が必要}"
POLL_INTERVAL="${3:?poll_intervalが必要}"
N_REPEATS="${4:?n_repeatsが必要}"
OUT_XDF="${5:?output.xdf が必要}"

case "$METHOD" in
  0|1|2) ;;
  *) echo "ERROR: method は 0(word)/1(long)/2(movem) のいずれかであること(渡された値=${METHOD})" >&2; exit 1 ;;
esac

case "$METHOD" in
  0) UNIT=2 ;;   # word: 2バイト/コピー単位
  1) UNIT=4 ;;   # long: 4バイト/コピー単位
  2) UNIT=32 ;;  # movem: 8ロング=32バイト/コピー単位(バッチ)
esac

if [ "$((K_BYTES % UNIT))" -ne 0 ]; then
  echo "ERROR: K_bytes(${K_BYTES}) は method=${METHOD} のコピー単位(${UNIT}バイト)の倍数であること" >&2
  exit 1
fi
if [ "$((K_BYTES % 2))" -ne 0 ]; then
  echo "ERROR: K_bytes は2の倍数であること(渡された値=${K_BYTES})" >&2
  exit 1
fi
TRANSFER_WORDS=$((K_BYTES / 2))

if [ "$POLL_INTERVAL" -lt 1 ]; then
  echo "ERROR: poll_interval は1以上であること" >&2
  exit 1
fi
if [ "$N_REPEATS" -lt 1 ]; then
  echo "ERROR: n_repeats は1以上であること" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OBJDIR="$ROOT/build/stage_e3_obj_k${K_BYTES}_m${METHOD}_p${POLL_INTERVAL}_r${N_REPEATS}"
mkdir -p "$OBJDIR"

SECTOR_SIZE=1024
TOTAL_SECTORS=1232
LOAD_ADDR=$((0x3000))
STACK_ADDR="${STACK_ADDR:-0xF0000}"
STACK_ADDR_DEC=$((STACK_ADDR))
RAM_SIZE="${RAM_SIZE:-0x100000}"
RAM_SIZE_DEC=$((RAM_SIZE))
STACK_MARGIN=$((4096))

# main_e3.c / e3_copy.S 内の固定アドレス(SRC/HOSTVAR)。ビルドスクリプト側でも整合を検査する。
SRC_ADDR=$((0x20000))
HOSTVAR_DONE_ADDR=$((0xE0010))
HOSTVAR_VSYNC_ADDR=$((0xE0014))
SRC_END=$((SRC_ADDR + K_BYTES))

if [ "$SRC_END" -gt "$STACK_ADDR_DEC" ]; then
  printf 'ERROR: 転送元領域末尾(0x%X, K_BYTES=%d)がスタック(STACK_ADDR=0x%X)と衝突する\n' "$SRC_END" "$K_BYTES" "$STACK_ADDR_DEC" >&2
  exit 1
fi
if [ "$SRC_ADDR" -lt "$LOAD_ADDR" ]; then
  echo "ERROR: SRC_ADDR がロードアドレスより手前にある(想定外の定数変更)" >&2
  exit 1
fi
if [ "$HOSTVAR_VSYNC_ADDR" -lt "$SRC_END" ] && [ "$((HOSTVAR_VSYNC_ADDR + 4))" -gt "$SRC_ADDR" ]; then
  echo "ERROR: HOSTVAR領域がSRC領域と重なる可能性がある(K_BYTESが大きすぎる)" >&2
  exit 1
fi
if [ "$((HOSTVAR_VSYNC_ADDR + 4 + STACK_MARGIN))" -gt "$STACK_ADDR_DEC" ]; then
  printf 'ERROR: HOSTVAR_VSYNC(0x%X)がスタック(STACK_ADDR=0x%X)に近すぎる\n' "$HOSTVAR_VSYNC_ADDR" "$STACK_ADDR_DEC" >&2
  exit 1
fi
if [ "$STACK_ADDR_DEC" -ge "$RAM_SIZE_DEC" ]; then
  printf 'ERROR: STACK_ADDR(0x%X)が設定RAMサイズ(RAM_SIZE=0x%X)を超えている\n' "$STACK_ADDR_DEC" "$RAM_SIZE_DEC" >&2
  exit 1
fi
if [ "$SRC_END" -gt "$RAM_SIZE_DEC" ]; then
  printf 'ERROR: 転送元領域末尾(0x%X)が設定RAMサイズ(RAM_SIZE=0x%X)を超えている\n' "$SRC_END" "$RAM_SIZE_DEC" >&2
  exit 1
fi

CFLAGS=(-m68000 -Os -ffreestanding -nostdlib -fomit-frame-pointer -fno-builtin -Wall \
  -DTRANSFER_WORDS="${TRANSFER_WORDS}" -DTRANSFER_METHOD="${METHOD}" -DPOLL_INTERVAL="${POLL_INTERVAL}" -DN_REPEATS="${N_REPEATS}")

echo "== Stage E-3 本体(C+ASM, K_BYTES=${K_BYTES}, METHOD=${METHOD}, POLL_INTERVAL=${POLL_INTERVAL}, N_REPEATS=${N_REPEATS}, TRANSFER_WORDS=${TRANSFER_WORDS})のビルド =="
m68k-elf-gcc "${CFLAGS[@]}" -c "$ROOT/stage_e/src/main_e3.c" -o "$OBJDIR/main.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -c "$ROOT/stage_e/src/e3_copy.S" -o "$OBJDIR/e3_copy.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -DSTACK_ADDR="${STACK_ADDR}" -c "$ROOT/stage_c/crt0/crt0.S" -o "$OBJDIR/crt0.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -c "$ROOT/stage_c/crt0/iocs.S" -o "$OBJDIR/iocs.o"
m68k-elf-ld -T "$ROOT/stage_c/crt0/linker.ld" -o "$OBJDIR/stage_e3.elf" \
  "$OBJDIR/crt0.o" "$OBJDIR/iocs.o" "$OBJDIR/main.o" "$OBJDIR/e3_copy.o"
m68k-elf-objcopy -O binary "$OBJDIR/stage_e3.elf" "$OBJDIR/stage_e3.bin"

BODY_SIZE=$(wc -c < "$OBJDIR/stage_e3.bin" | tr -d ' ')
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
if [ "$SRC_ADDR" -lt "$((BODY_END + STACK_MARGIN))" ]; then
  printf 'ERROR: SRC_ADDR(0x%X)が本体末尾(0x%X)+マージンと重なる\n' "$SRC_ADDR" "$BODY_END" >&2
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
python3 - "$OBJDIR/boot.bin" "$OBJDIR/stage_e3.bin" "$SECTOR_COUNT" "$OUT_XDF" <<'PYEOF'
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
