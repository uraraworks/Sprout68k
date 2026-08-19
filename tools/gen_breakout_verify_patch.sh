#!/usr/bin/env bash
# X68kDev: samples/breakout/main.c(素のコード)と検証用の版(HOSTVAR書き出し+
# 故障注入マクロ入り)との差分を verify/patches/breakout_verify.patch として
# 保存し直す。
#
# 通常は使わない。samples/breakout/main.c を編集した結果、
# tools/build_breakout.sh(patchコマンドでbreakout_verify.patchを当てて検証用の
# 版を生成している)が「パッチが当たらない」で失敗するようになったときだけ、
# このスクリプトで検証用の版を作り直し、patchを再生成すること
# (docs/作例breakout_20260819.md「作例と検証の分離」参照)。
#
# 使い方:
#   1. samples/breakout/main.c をエディタで直接書き換え、
#      「検証用HOSTVARの書き出し」と「X68_FAULT_BREAKOUT_*のifndefガード」を
#      追加した一時ファイルを作る(下記VERIFY_TMPへ)。
#   2. このスクリプトを実行するとdiffを取ってverify/patches/breakout_verify.patch
#      を更新する。
#
# 環境変数 VERIFY_TMP で「検証用に手直しした一時ファイル」のパスを指定する
# (必須)。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CLEAN="$ROOT/samples/breakout/main.c"
PATCH="$ROOT/verify/patches/breakout_verify.patch"

VERIFY_TMP="${VERIFY_TMP:?VERIFY_TMP(検証用に手直しした一時ファイルのパス)が必要}"

diff -u --label a/samples/breakout/main.c --label b/samples/breakout/main.c \
  "$CLEAN" "$VERIFY_TMP" > "$PATCH" || true

echo "wrote $PATCH"
echo "確認: tools/build_breakout.sh <out.xdf> で実際にパッチが当たることを確認すること"
