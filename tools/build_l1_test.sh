#!/usr/bin/env bash
# X68kDev L1(lib/src/x68_l1.c、65536色1ページ + 矩形追跡の部分転送)の
# テストプログラム(lib_test/src/main_l1.c)をビルドして .xdf にする。
#
# 使い方: tools/build_l1_test.sh <output.xdf> [fault] [script]
#   output.xdf: 出力ディスクイメージ
#   fault:      省略時は通常ビルド。以下のいずれかを指定すると、その挙動だけ
#               意図的に壊した版をビルドする(検証の故障注入用。壊した版は
#               成果物として残さないこと。docs/L1実装_20260819.md参照):
#                 skip_prev          flip()が前フレームの矩形を転送しない(消し残り)
#                 shrink_rect        矩形リストへ記録する矩形を1px小さくする(端が欠ける)
#                 cls_no_fill        clsが前フレーム矩形を裏バッファへ塗り戻さない
#                 cls_no_full_repaint 背景色が変わっても全画面塗り直しをしない
#                 no_clip            クリップをしない(画面外描画が隣の行へ回り込む)
#                 diff_ignore_shrink 命令数が減った場合(消えた命令)を差分に含めない
#                 diff_color_blind   色だけ違う命令を「同一」と誤判定する
#                 diff_no_overflow_fallback 一覧が溢れても全画面フォールバックしない
#   script:     省略時は通常の8フレーム台本。"empty" を指定すると陰性対照用の
#               「何も描かない」最小台本(1フレーム)に切り替わる。"diff" を指定すると
#               差分転送を狙った台本(静止物+動く物、色だけ変更、命令数減、一覧溢れ)に
#               切り替わる。
#
# ブートセクタは stage_d/boot/boot.S(track/sideをまたぐ複数セクタ読み込み
# 対応、実測済み)を流用する。crt0/リンカスクリプトは stage_c のものを
# そのまま使う。
#
# 裏バッファ(512x512x2=512KB)は lib/src/x68_l1.c の中で静的配列として
# .bss に置かれる。.bin のサイズ(本体末尾)にはbssの分は含まれないため、
# 本体末尾とスタックの衝突チェック(既存)とは別に、リンク後のELFシンボル
# __bss_end を実際に読んでスタックと衝突しないことを検査する
# (「借りた定数には見えない前提が付く」の教訓。tools/build_stage_c.sh /
# build_stage_d.sh の本体末尾チェックと同じ発想をbss側にも適用したもの)。
#
# 前提: m68k-elf-gcc / m68k-elf-ld / m68k-elf-objcopy / m68k-elf-nm が
# PATH にあること。
set -euo pipefail

OUT_XDF="${1:?output.xdf が必要}"
FAULT="${2:-}"
SCRIPT="${3:-}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OBJDIR="$ROOT/build/l1_test_obj"
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

FAULT_DEFINE=()
case "$FAULT" in
  "") ;;
  skip_prev) FAULT_DEFINE=(-DX68_FAULT_L1_SKIP_PREV) ;;
  shrink_rect) FAULT_DEFINE=(-DX68_FAULT_L1_SHRINK_RECT) ;;
  cls_no_fill) FAULT_DEFINE=(-DX68_FAULT_L1_CLS_NO_FILL) ;;
  cls_no_full_repaint) FAULT_DEFINE=(-DX68_FAULT_L1_CLS_NO_FULL_REPAINT) ;;
  no_clip) FAULT_DEFINE=(-DX68_FAULT_L1_NO_CLIP) ;;
  diff_ignore_shrink) FAULT_DEFINE=(-DX68_FAULT_L1_DIFF_IGNORE_SHRINK) ;;
  diff_color_blind) FAULT_DEFINE=(-DX68_FAULT_L1_DIFF_COLOR_BLIND) ;;
  diff_no_overflow_fallback) FAULT_DEFINE=(-DX68_FAULT_L1_DIFF_NO_OVERFLOW_FALLBACK) ;;
  *) echo "ERROR: 未知のfault指定: ${FAULT}" >&2; exit 1 ;;
esac
if [ -n "$FAULT" ]; then
  echo "== 故障注入ビルド: ${FAULT} =="
fi

SCRIPT_DEFINE=()
case "$SCRIPT" in
  "") ;;
  empty) SCRIPT_DEFINE=(-DX68_L1_EMPTY_SCRIPT) ;;
  diff) SCRIPT_DEFINE=(-DX68_L1_DIFF_SCRIPT) ;;
  *) echo "ERROR: 未知のscript指定: ${SCRIPT}" >&2; exit 1 ;;
esac

echo "== ライブラリ本体のビルド =="
m68k-elf-gcc "${CFLAGS[@]}" ${FAULT_DEFINE[@]+"${FAULT_DEFINE[@]}"} -c "$ROOT/lib/src/x68_std.c" -o "$OBJDIR/x68_std.o"
m68k-elf-gcc "${CFLAGS[@]}" ${FAULT_DEFINE[@]+"${FAULT_DEFINE[@]}"} -c "$ROOT/lib/src/x68_l0.c" -o "$OBJDIR/x68_l0.o"
m68k-elf-gcc "${CFLAGS[@]}" ${FAULT_DEFINE[@]+"${FAULT_DEFINE[@]}"} -c "$ROOT/lib/src/x68_l1.c" -o "$OBJDIR/x68_l1.o"
m68k-elf-gcc "${CFLAGS[@]}" ${FAULT_DEFINE[@]+"${FAULT_DEFINE[@]}"} -c "$ROOT/lib/src/x68_panic.c" -o "$OBJDIR/x68_panic.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 ${FAULT_DEFINE[@]+"${FAULT_DEFINE[@]}"} -c "$ROOT/lib/asm/x68_iocs.S" -o "$OBJDIR/x68_iocs.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 ${FAULT_DEFINE[@]+"${FAULT_DEFINE[@]}"} -c "$ROOT/lib/asm/x68_gvram_copy.S" -o "$OBJDIR/x68_gvram_copy.o"
# MOVEC(VBR設定の試行)を含むため-m68020でアセンブルする(tools/build_panic_test.shと同じ理由)。
m68k-elf-gcc -x assembler-with-cpp -m68020 ${FAULT_DEFINE[@]+"${FAULT_DEFINE[@]}"} -c "$ROOT/lib/asm/x68_panic.S" -o "$OBJDIR/x68_panic_asm.o"

echo "== テストプログラム(C)のビルド =="
m68k-elf-gcc "${CFLAGS[@]}" ${SCRIPT_DEFINE[@]+"${SCRIPT_DEFINE[@]}"} -c "$ROOT/lib_test/src/main_l1.c" -o "$OBJDIR/main_l1.o"
m68k-elf-gcc -x assembler-with-cpp -m68000 -DSTACK_ADDR="${STACK_ADDR}" -c "$ROOT/stage_c/crt0/crt0.S" -o "$OBJDIR/crt0.o"

# rand()/printfはこのテストプログラムからは使わないが、x68_l0.c/x68_std.cを
# まとめてリンクする都合上、乗除算のソフトウェア実装(libgcc)が要る場合に備えて
# tools/build_lib_test.sh と同じくlibgcc.aを明示的にリンクへ加える。
LIBGCC="$(m68k-elf-gcc -m68000 -print-libgcc-file-name)"
m68k-elf-ld -T "$ROOT/stage_c/crt0/linker.ld" -o "$OBJDIR/l1_test.elf" \
  "$OBJDIR/crt0.o" "$OBJDIR/main_l1.o" \
  "$OBJDIR/x68_std.o" "$OBJDIR/x68_l0.o" "$OBJDIR/x68_l1.o" "$OBJDIR/x68_panic.o" \
  "$OBJDIR/x68_iocs.o" "$OBJDIR/x68_gvram_copy.o" "$OBJDIR/x68_panic_asm.o" \
  "$LIBGCC"
m68k-elf-objcopy -O binary "$OBJDIR/l1_test.elf" "$OBJDIR/l1_test.bin"

BODY_SIZE=$(wc -c < "$OBJDIR/l1_test.bin" | tr -d ' ')
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

# --- ここからbss(裏バッファ512KBを含む)とスタックの衝突チェック ---
# .binのBODY_SIZEには.bss(NOLOAD)の分は含まれないため、上のBODY_ENDチェック
# だけでは裏バッファがスタックへ食い込んでいても検出できない。リンク後の
# ELFシンボル __bss_end (stage_c/crt0/linker.ld で定義)を実際に読んで
# 検査する。
BSS_END_HEX="$(m68k-elf-nm "$OBJDIR/l1_test.elf" | awk '$3 == "__bss_end" { print $1 }')"
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
python3 - "$OBJDIR/boot.bin" "$OBJDIR/l1_test.bin" "$SECTOR_COUNT" "$OUT_XDF" <<'PYEOF'
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
