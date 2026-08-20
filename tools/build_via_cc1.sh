#!/usr/bin/env bash
# cc1/as/ld/objcopy のコマンド列は tools/driver/build.mts を唯一の正典とする。
# 使い方: tools/build_via_cc1.sh <stage_c|breakout> <output.xdf>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$HERE/driver/build.mts" "$@"
