#!/usr/bin/env bash
# 共有ランタイム方式で「検証版のブロック崩し」をビルドする。
#
# 使い方: tools/build_shared_breakout_verify.sh <output.xdf> [payload.bin]
#
# ねらいは、**通常ビルド用の検証台本(verify/verify_breakout.mts)を、そのまま
# 共有ランタイム方式のビルドに通すこと**。台本も判定も一切変えずに5項目が
# 通れば、共有経路が機能的に正しいことの証明になる。
#
# 通常ビルドとの違いは2つだけで、どちらも配置が変わることに由来する:
#   1. 自己申告の番地 HV3_BASE。$DA000 は通常ビルドの配置に固有の空き番地で、
#      共有配置では裏バッファ($6D000〜)の中に入ってしまう。利用者領域内の
#      空き($60000)へ移す。**パッチ本体は書き換えず、適用後に置換する**
#      （パッチは通常ビルドの正典なので触らない）。
#   2. 検証パッチが参照するランタイム内部の x68_l1_last_flip_bytes。共有方式では
#      利用者コードとランタイムが別々にリンクされるので、番地を明示的に渡す。
set -euo pipefail

OUT_XDF="${1:?output.xdf が必要}"
OUT_PAYLOAD="${2:-}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OBJDIR="$ROOT/build/shared_obj"
mkdir -p "$OBJDIR"

# 共有配置での自己申告の置き場。利用者領域($10000〜$5FFFF)の中の、
# 利用者コード本体(先頭から数KB)から十分離れた位置。
SHARED_HV3_BASE=0x00050000

echo "== 素のコードへ検証用パッチを適用 =="
cp "$ROOT/samples/breakout/block.c" "$OBJDIR/main_verify.c"
if ! patch "$OBJDIR/main_verify.c" "$ROOT/verify/patches/breakout_verify.patch"; then
  echo "ERROR: breakout_verify.patch が素のコードに当たらなかった" >&2
  exit 1
fi

echo "== 自己申告の番地を共有配置向けに置換 (0x000DA000UL -> ${SHARED_HV3_BASE}UL) =="
before="$(grep -c '0x000DA000UL' "$OBJDIR/main_verify.c" || true)"
if [ "$before" -ne 1 ]; then
  echo "ERROR: HV3_BASE の定義が1件見つからない(${before}件)。パッチが変わった可能性がある" >&2
  exit 1
fi
sed -i '' "s/0x000DA000UL/${SHARED_HV3_BASE}UL/" "$OBJDIR/main_verify.c"

USER_CFLAGS_EXTRA="" \
EXPORT_RUNTIME_SYMS="x68_l1_last_flip_bytes" \
  "$ROOT/tools/build_shared.sh" "$OBJDIR/main_verify.c" "$OUT_XDF" "$OUT_PAYLOAD"

echo "検証台本の HV3_BASE は ${SHARED_HV3_BASE} を指定して実行すること:"
echo "  HV3_BASE=${SHARED_HV3_BASE} BREAKOUT_IMG=${OUT_XDF} npx tsx verify/verify_breakout.mts"
