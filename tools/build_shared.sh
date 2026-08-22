#!/usr/bin/env bash
# 共有ランタイム方式で 利用者の .c から .xdf を作る。
#
# 使い方: tools/build_shared.sh <main.c> <output.xdf> [payload.bin]
#   main.c      : 利用者のソース1本
#   output.xdf  : 出力ディスクイメージ
#   payload.bin : 省略可。URLに載せる利用者ペイロード（ヘッダ込み）も書き出す
#
# 通常ビルド(tools/build_breakout.sh 等)との違いは、ライブラリを利用者コードに
# リンクせず、ランタイム側のジャンプテーブルの絶対番地へ解決すること。
# 番地表は runtime/generated/abi_v1.ld（tools/build_abi.mts が生成）。
#
# 前提: m68k-elf-gcc / ld / objcopy が PATH にあること。
set -euo pipefail

USER_SRC="${1:?利用者の main.c が必要}"
OUT_XDF="${2:?output.xdf が必要}"
OUT_PAYLOAD="${3:-}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OBJDIR="$ROOT/build/shared_obj"
GEN="$ROOT/runtime/generated"
mkdir -p "$OBJDIR"

# メモリ配置は runtime/layout_v1.txt が正典。ここでは値を持たない。
eval "$(grep -E '^[A-Z_]+=' "$ROOT/runtime/layout_v1.txt")"

node "$ROOT/tools/build_abi.mts" >/dev/null

CFLAGS=(-m68000 -Os -ffreestanding -nostdlib -fomit-frame-pointer -fno-builtin -Wall -I"$ROOT/lib/include")
# 配置の値はすべて runtime/layout_v1.txt 由来。アセンブラ側でも同じ値を使う。
ASDEFS=("-DSTACK_ADDR=${STACK_ADDR}" "-DUSER_BASE=${USER_BASE}" "-DUSER_LIMIT=${USER_LIMIT}"
  "-DABI_VERSION=${ABI_VERSION}")
ASFLAGS=(-x assembler-with-cpp -m68000 "${ASDEFS[@]}")

echo "== ランタイム本体のビルド =="
m68k-elf-gcc "${ASFLAGS[@]}" -c "$GEN/jumptable_v1.S" -o "$OBJDIR/jumptable.o"
m68k-elf-gcc "${ASFLAGS[@]}" -c "$ROOT/runtime/crt0_runtime.S" -o "$OBJDIR/crt0_runtime.o"
m68k-elf-gcc "${ASFLAGS[@]}" -c "$ROOT/lib/asm/x68_iocs.S" -o "$OBJDIR/x68_iocs.o"
m68k-elf-gcc "${ASFLAGS[@]}" -c "$ROOT/lib/asm/x68_gvram_copy.S" -o "$OBJDIR/x68_gvram_copy.o"
# パニック画面は MOVEC を使うので 68010 以降のアセンブラ指定が要る（既存の
# ビルドスクリプトと同じく -m68020。実行時は 68000 を素通りする作りになっている）。
m68k-elf-gcc -x assembler-with-cpp -m68020 "${ASDEFS[@]}" -c "$ROOT/lib/asm/x68_panic.S" -o "$OBJDIR/x68_panic_asm.o"
for unit in x68_std x68_l0 x68_l1 x68_input x68_panic; do
  m68k-elf-gcc "${CFLAGS[@]}" -c "$ROOT/lib/src/${unit}.c" -o "$OBJDIR/${unit}.o"
done

LIBGCC="$(m68k-elf-gcc -m68000 -print-libgcc-file-name)"
# --gc-sections は使わない。ジャンプテーブルから参照される関数は「今回の利用者が
# 呼んでいない」だけで、次に共有される利用者コードが呼ぶ。ランタイムは常に全部入り。
m68k-elf-ld -T "$GEN/runtime_v1.ld" -o "$OBJDIR/runtime.elf" \
  "$OBJDIR/jumptable.o" "$OBJDIR/crt0_runtime.o" \
  "$OBJDIR/x68_std.o" "$OBJDIR/x68_l0.o" "$OBJDIR/x68_l1.o" "$OBJDIR/x68_input.o" \
  "$OBJDIR/x68_panic.o" "$OBJDIR/x68_iocs.o" "$OBJDIR/x68_gvram_copy.o" "$OBJDIR/x68_panic_asm.o" \
  "$LIBGCC"
m68k-elf-objcopy -O binary "$OBJDIR/runtime.elf" "$OBJDIR/runtime.bin"

# 検証専用の抜け道。既定では何も渡さない。
#   USER_CFLAGS_EXTRA    利用者コンパイルへの追加フラグ（例: -DHV3_BASE=...）
#   EXPORT_RUNTIME_SYMS  ランタイム内部シンボルの番地を利用者リンクへ渡す（空白区切り）
# **これは公開ABIではない。** 公開ABIは runtime/abi_v1.txt の29関数だけで、
# ここで渡した番地は版が変われば動く。検証台本のような、ランタイムと同時に
# ビルドされるものにしか使わないこと。
USER_LD_EXTRA=()
for sym in ${EXPORT_RUNTIME_SYMS:-}; do
  addr="$(m68k-elf-nm "$OBJDIR/runtime.elf" | awk -v s="$sym" '$3 == s { print $1 }')"
  if [ -z "$addr" ]; then
    echo "ERROR: ランタイムにシンボル ${sym} が見つからない" >&2
    exit 1
  fi
  echo "   検証用: ${sym} = 0x${addr}"
  USER_LD_EXTRA+=(--defsym "${sym}=0x${addr}")
done

echo "== 利用者コードのビルド（ライブラリはリンクしない） =="
m68k-elf-gcc "${ASFLAGS[@]}" -c "$ROOT/runtime/user_entry.S" -o "$OBJDIR/user_entry.o"
m68k-elf-gcc "${CFLAGS[@]}" ${USER_CFLAGS_EXTRA:-} -c "$USER_SRC" -o "$OBJDIR/user_main.o"
# -L は -T より前に置く（INCLUDE abi_v1.ld の探索に使われるため）。
m68k-elf-ld -L "$GEN" -T "$GEN/user_v1.ld" ${USER_LD_EXTRA[@]+"${USER_LD_EXTRA[@]}"} -o "$OBJDIR/user.elf" \
  "$OBJDIR/user_entry.o" "$OBJDIR/user_main.o" "$LIBGCC"
m68k-elf-objcopy -O binary "$OBJDIR/user.elf" "$OBJDIR/user.bin"

echo "== ブートセクタのビルド =="
# 本体は「ランタイム + 0詰め + 利用者ペイロード」の1本の連続した塊。
# セクタ数は node 側が数えるので、いったん仮の値でアセンブルはせず、
# 先に塊の大きさを求めてからブートセクタを作る。
BODY_SIZE=$(node -e '
import("'"$ROOT"'/tools/share_v1.mts").then(async (share) => {
  const { readFileSync } = await import("node:fs");
  const layout = { ABI_VERSION: '"$ABI_VERSION"', RUNTIME_BASE: '"$RUNTIME_BASE"', USER_BASE: '"$USER_BASE"',
                   USER_LIMIT: '"$USER_LIMIT"', ...share.DEFAULT_DISK };
  const user = share.packUserPayload(new Uint8Array(readFileSync("'"$OBJDIR"'/user.bin")), layout);
  process.stdout.write(String(layout.USER_BASE - layout.RUNTIME_BASE + user.length));
});
')
SECTOR_COUNT=$(( (BODY_SIZE + 1023) / 1024 ))
echo "body=${BODY_SIZE} バイト -> ${SECTOR_COUNT} セクタ"

m68k-elf-gcc "${ASFLAGS[@]}" -DSECTOR_COUNT="${SECTOR_COUNT}" -c "$ROOT/stage_d/boot/boot.S" -o "$OBJDIR/boot.o"
m68k-elf-gcc -x assembler-with-cpp -m68020 -c "$ROOT/stage_c/boot/cache_flush.S" -o "$OBJDIR/cache_flush.o"
cat > "$OBJDIR/boot_link.ld" <<'LDEOF'
SECTIONS { . = 0x0; .text : { *(.text) *(.rodata) *(.data) } }
LDEOF
m68k-elf-ld -T "$OBJDIR/boot_link.ld" -o "$OBJDIR/boot.elf" "$OBJDIR/boot.o" "$OBJDIR/cache_flush.o"
m68k-elf-objcopy -O binary "$OBJDIR/boot.elf" "$OBJDIR/boot.bin"

echo "== .xdf の組み立て（受信側と同じ tools/share_v1.mts を通す） =="
node -e '
import("'"$ROOT"'/tools/share_v1.mts").then(async (share) => {
  const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const layout = { ABI_VERSION: '"$ABI_VERSION"', RUNTIME_BASE: '"$RUNTIME_BASE"', USER_BASE: '"$USER_BASE"',
                   USER_LIMIT: '"$USER_LIMIT"', ...share.DEFAULT_DISK };
  const boot = new Uint8Array(readFileSync("'"$OBJDIR"'/boot.bin"));
  const runtime = new Uint8Array(readFileSync("'"$OBJDIR"'/runtime.bin"));
  const payload = share.packUserPayload(new Uint8Array(readFileSync("'"$OBJDIR"'/user.bin")), layout);
  const { image, sectorCount, bodySize } = share.assembleXdf(boot, runtime, payload, layout);
  mkdirSync(dirname("'"$OUT_XDF"'"), { recursive: true });
  writeFileSync("'"$OUT_XDF"'", image);
  const out = "'"$OUT_PAYLOAD"'";
  if (out) writeFileSync(out, payload);
  console.log(`wrote '"$OUT_XDF"' (${image.length} バイト, body=${bodySize}, ${sectorCount} セクタ)`);
  console.log(`ランタイム ${runtime.length} バイト / 利用者ペイロード ${payload.length} バイト`);
});
'
