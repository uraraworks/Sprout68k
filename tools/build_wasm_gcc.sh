#!/usr/bin/env bash
# GCC 13.4.0 の cc1 を host=wasm32-unknown-emscripten / target=m68k-elf でビルドする。
# このスクリプト自身はソースを取得・変更しない。F-0 で展開し prerequisites を配置した
# ソースと、F-0 のネイティブ m68k-elf クロスを使う Canadian cross 専用である。
#
# 使い方:
#   tools/build_wasm_gcc.sh [-j N] [--configure-only]
#   WASM_FS=noderawfs|memfs NATIVE_PREFIX="$HOME/x68kdev-toolchain" PREFIX="$HOME/sprout68k-wasm" \
#     tools/build_wasm_gcc.sh -j 8
#
# all-gcc は依存関係上 driver 等もビルドし得るが、インストールはせず cc1 のみを
# PREFIX/bin へ梱包する。libgcc/newlib/C++/target library はビルドしない。
set -euo pipefail

GCC_VERSION=13.4.0
HOST=wasm32-unknown-emscripten
TARGET=m68k-elf
PROGRAM_PREFIX=m68k-elf-
WASM_FS="${WASM_FS:-noderawfs}"

PREFIX="${PREFIX:-$HOME/sprout68k-wasm}"
# F-0 cc1に焼き込まれたprefixと一致させる。変更には基準器の再構築・再検証が必要。
NATIVE_PREFIX="${NATIVE_PREFIX:-$HOME/x68kdev-toolchain}"
EMSDK="${EMSDK:-$HOME/emsdk}"
GCC_SOURCE="${GCC_SOURCE:-$NATIVE_PREFIX/src/gcc-${GCC_VERSION}}"
BUILD_ROOT="$PREFIX/build"
BIN_DIR="$PREFIX/bin"
EM_CACHE="$PREFIX/emscripten-cache"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# cc1 はネイティブ版でも約 23.6 MB あり、コンパイル中の常駐データも大きい。
# 初期 256 MiB、必要時に成長、上限 2 GiB とする。値は実行前の見積もりであり、
# 適否は未検証。実測後に環境変数で調整できるようにする。
WASM_INITIAL_MEMORY="${WASM_INITIAL_MEMORY:-268435456}"
WASM_MAXIMUM_MEMORY="${WASM_MAXIMUM_MEMORY:-2147483648}"
WASM_STACK_SIZE="${WASM_STACK_SIZE:-16777216}"

# noderawfs は従来の Node 専用 CLI。memfs はブラウザ本番と Node 上のバイト一致検証で
# 同じ factory を使えるよう ENVIRONMENT=web,node とし、入力配置前の main 自動実行を止める。
# FS/callMain/ENV は tools/driver/runner.mts が入出力と GCC_EXEC_PREFIX を設定するため export する。
case "$WASM_FS" in
  noderawfs)
    WASM_RUNTIME_LDFLAGS='-sNODERAWFS=1 -sENVIRONMENT=node'
    ;;
  memfs)
    WASM_RUNTIME_LDFLAGS='-sMODULARIZE=1 -sINVOKE_RUN=0 -sENVIRONMENT=web,node -sEXPORTED_RUNTIME_METHODS=FS,callMain,ENV'
    ;;
  *)
    echo "ERROR: WASM_FS は noderawfs または memfs を指定してください: $WASM_FS" >&2
    exit 2
    ;;
esac
GCC_BUILD="$BUILD_ROOT/gcc-${GCC_VERSION}-cc1-${WASM_FS}"

detect_jobs() {
  if command -v nproc >/dev/null 2>&1; then
    nproc
  elif sysctl -n hw.logicalcpu >/dev/null 2>&1; then
    sysctl -n hw.logicalcpu
  elif getconf _NPROCESSORS_ONLN >/dev/null 2>&1; then
    getconf _NPROCESSORS_ONLN
  else
    printf '%s\n' 1
  fi
}

JOBS="$(detect_jobs)"
CONFIGURE_ONLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -j)
      [ "$#" -ge 2 ] || { echo 'ERROR: -j には並列度が必要です' >&2; exit 2; }
      JOBS="$2"
      shift 2
      ;;
    -j[0-9]*)
      JOBS="${1#-j}"
      shift
      ;;
    --configure-only)
      CONFIGURE_ONLY=1
      shift
      ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: 未知の引数: $1" >&2
      exit 2
      ;;
  esac
done

case "$JOBS" in
  ''|*[!0-9]*|0) echo "ERROR: 並列度は1以上の整数で指定してください: $JOBS" >&2; exit 2 ;;
esac
for memory_value in "$WASM_INITIAL_MEMORY" "$WASM_MAXIMUM_MEMORY" "$WASM_STACK_SIZE"; do
  case "$memory_value" in
    ''|*[!0-9]*) echo "ERROR: メモリ量はバイト単位の整数で指定してください: $memory_value" >&2; exit 2 ;;
  esac
done
if [ "$WASM_INITIAL_MEMORY" -gt "$WASM_MAXIMUM_MEMORY" ]; then
  echo 'ERROR: WASM_INITIAL_MEMORY は WASM_MAXIMUM_MEMORY 以下にしてください' >&2
  exit 2
fi
case "$PREFIX" in
  /*) ;;
  *) echo "ERROR: PREFIX は絶対パスで指定してください: $PREFIX" >&2; exit 2 ;;
esac
case "$NATIVE_PREFIX" in
  /*) ;;
  *) echo "ERROR: NATIVE_PREFIX は絶対パスで指定してください: $NATIVE_PREFIX" >&2; exit 2 ;;
esac
case "$PREFIX" in
  "$NATIVE_PREFIX"|"$NATIVE_PREFIX"/*)
    echo 'ERROR: wasm の PREFIX を F-0 の NATIVE_PREFIX 内には置けません' >&2
    exit 2
    ;;
  "$PROJECT_ROOT"|"$PROJECT_ROOT"/*)
    echo "ERROR: PREFIX をプロジェクト内には置けません: $PREFIX" >&2
    exit 2
    ;;
esac

[ -x "$GCC_SOURCE/configure" ] || {
  echo "ERROR: GCC ${GCC_VERSION} のソースがありません: $GCC_SOURCE" >&2
  exit 1
}
[ -r "$EMSDK/emsdk_env.sh" ] || {
  echo "ERROR: emsdk_env.sh がありません: $EMSDK/emsdk_env.sh" >&2
  exit 1
}
for native_tool in gcc as ld objcopy; do
  [ -x "$NATIVE_PREFIX/bin/${PROGRAM_PREFIX}${native_tool}" ] || {
    echo "ERROR: F-0 のネイティブクロスがありません: $NATIVE_PREFIX/bin/${PROGRAM_PREFIX}${native_tool}" >&2
    exit 1
  }
done

# contrib/download_prerequisites は gmp/mpfr/mpc（および通常 isl）を GCC ソース直下へ
# 展開または symlink する。GCC 13系トップレベル Makefile.def では gmp/mpfr/mpc は
# host_modules であり、トップレベル configure/make から --host=$HOST と host compiler
# (emcc/em++)を渡される。そのため in-tree 方式なら Darwin 用ライブラリを誤リンクせず、
# cc1 と同じ wasm host 向けにビルドされる、という判断で別 PREFIX は用意しない。
# ただし GMP/MPFR/MPC 各 configure と Emscripten の組合せ、および configure 中に
# wasm のテストプログラムを誤実行しないことは未確認で、実ビルドで確かめる必要がある。
for prerequisite in gmp mpfr mpc; do
  [ -d "$GCC_SOURCE/$prerequisite" ] || {
    echo "ERROR: in-tree prerequisite がありません: $GCC_SOURCE/$prerequisite" >&2
    echo '  F-0 ソースで contrib/download_prerequisites を完了してから再実行してください' >&2
    exit 1
  }
done

EMSDK_QUIET=1 source "$EMSDK/emsdk_env.sh"
for command_name in make awk sed wc emcc em++ emconfigure emmake; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "ERROR: 必要なコマンドがありません: $command_name" >&2
    exit 1
  }
done

mkdir -p "$BUILD_ROOT"
export EM_CACHE
export PATH="$NATIVE_PREFIX/bin:$PATH"

# build_wasm_binutils.sh で判明した libiberty/psignal の衝突を GCC 側でも避ける。
# make 中に起動されるサブ configure にも届くよう、コマンド前置きでなく export する。
# Emscripten libc は宣言だけを持ち、実体が無い可能性があるため、実際に参照されれば
# cc1 のリンク時に未定義シンボルとして失敗する。この回避の完走可否は未確認。
export ac_cv_func_psignal=yes

# in-tree の gmp/mpfr/isl が同梱する config.sub は古く、wasm32-unknown-emscripten を
# 「system `emscripten' not recognized」で弾く(実測: mpfr と isl が該当。gmp と gcc 本体の
# config.sub は認識する)。gcc 本体の config.sub/config.guess を各サブディレクトリへ配って
# 揃える。新しい config.sub を配るだけなので、同じソース木を使うネイティブ側のビルドにも
# 影響しない(ホスト種別の認識範囲が広がるだけ)。
for sub_dir in gmp mpfr mpc isl; do
  [ -d "$GCC_SOURCE/$sub_dir" ] || continue
  # config.guess は引数を取らない(ホストを自分で判定する)ので、判定に使えるのは
  # config.sub だけ。config.guess は触らない。
  [ -f "$GCC_SOURCE/$sub_dir/config.sub" ] || continue
  if ! sh "$GCC_SOURCE/$sub_dir/config.sub" "$HOST" >/dev/null 2>&1; then
    cp "$GCC_SOURCE/config.sub" "$GCC_SOURCE/$sub_dir/config.sub"
    echo "config.sub を更新(${HOST} を認識しないため): $sub_dir"
  fi
done

# zlib について: ネイティブ基準器(F-0)は --with-system-zlib を使うが、host=wasm では
# emscripten 側に zlib.h が無く lto-compress.cc がビルドできない(実測: fatal error:
# 'zlib.h' file not found)。wasm 側は in-tree zlib を使う。zlib は LTO セクションの
# 圧縮にしか使われず m68k のコード生成には効かないので、出力のバイト一致という
# 判定条件は保たれる(そのバイト一致自体が、この判断の答え合わせになる)。
# 逆にネイティブ側で in-tree zlib が使えないのは、同梱 zlib が最近の macOS SDK の
# ヘッダと衝突するため(F-0 で実測済み)。同じ理由で両者の指定が逆になっている。
BUILD="$($GCC_SOURCE/config.guess)"
WASM_LDFLAGS="${LDFLAGS:+$LDFLAGS }$WASM_RUNTIME_LDFLAGS -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=$WASM_INITIAL_MEMORY -sMAXIMUM_MEMORY=$WASM_MAXIMUM_MEMORY -sSTACK_SIZE=$WASM_STACK_SIZE"

mkdir -p "$GCC_BUILD"
if [ ! -f "$GCC_BUILD/Makefile" ]; then
  echo "== GCC configure (build=$BUILD host=$HOST target=$TARGET) =="
  (
    cd "$GCC_BUILD"
    CC_FOR_BUILD="${CC_FOR_BUILD:-cc}" \
    CXX_FOR_BUILD="${CXX_FOR_BUILD:-c++}" \
    CC_FOR_TARGET="$NATIVE_PREFIX/bin/${PROGRAM_PREFIX}gcc" \
    AS_FOR_TARGET="$NATIVE_PREFIX/bin/${PROGRAM_PREFIX}as" \
    LD_FOR_TARGET="$NATIVE_PREFIX/bin/${PROGRAM_PREFIX}ld" \
    CFLAGS="${CFLAGS:--O2}" \
    CXXFLAGS="${CXXFLAGS:--O2}" \
    LDFLAGS="$WASM_LDFLAGS" \
      emconfigure "$GCC_SOURCE/configure" \
        --build="$BUILD" \
        --host="$HOST" \
        --target="$TARGET" \
        --prefix="$PREFIX" \
        --program-prefix="$PROGRAM_PREFIX" \
        --with-build-time-tools="$NATIVE_PREFIX/bin" \
        --with-arch=m68k \
        --with-cpu=m68000 \
        --enable-multilib \
        --disable-nls \
        --disable-shared \
        --disable-threads \
        --without-headers \
        --with-newlib \
        --enable-languages=c \
        --without-system-zlib
  )
fi

if [ "$CONFIGURE_ONLY" -eq 1 ]; then
  echo "== configure-only 完了: $GCC_BUILD =="
  exit 0
fi

# ネイティブ基準器とコード生成条件を揃えるため、F-0 と同じ arch/cpu/multilib、
# C 言語、headers/newlib、thread/shared/NLS、system-zlib の設定を上で明記した。
# wasm 版では target libgcc を作らない。最終リンクは F-0 の既存 libgcc.a を使う。
# ここは「どの make を回すか」で2回失敗した箇所なので、経緯ごと残す。
#
# 1) all-gcc をそのまま回すと gcov-tool のリンクで止まる(libgcov-util.o が emscripten に
#    無い ftw を要求する)。欲しいのは cc1 だけなので当初は
#    「依存ライブラリを名指し → make -C gcc cc1」に切り替えた。
# 2) ところがそれは**クリーンな木では通らない**。gcc/build/ 以下のジェネレータ
#    (genmodes/genmatch/genhooks/genchecksum 等)は **build 側(ネイティブ)のコンパイラで
#    ビルドしなければならない**が、gcc サブディレクトリを emmake で直接叩くと em++ で
#    リンクしようとし、ネイティブの libiberty.a を掴んで undefined symbol で落ちる。
#    noderawfs 版がこの形で通っていたのは、先に all-gcc を試した失敗ビルドの残骸として
#    ジェネレータが既に出来ていたからで、スクリプトの正しさではなかった。
#
# build 側と host 側の区別を知っているのは top-level の make なので、そちらに任せる。
# gcov-tool で止まる件は -k(keep going)で越え、**cc1 が実際に出来たかを後で必ず検査する**
# (-k で失敗を握り潰したまま先へ進まないための歯止め)。
echo "== GCC ${GCC_VERSION} all-gcc build (-k, -j${JOBS}) =="
emmake make -C "$GCC_BUILD" -j"$JOBS" -k all-gcc || true

if [ ! -f "$GCC_BUILD/gcc/cc1" ] && [ ! -f "$GCC_BUILD/gcc/cc1.js" ]; then
  echo 'ERROR: cc1 が生成されていません(all-gcc の失敗は gcov-tool 以外の原因です)' >&2
  exit 1
fi

# GCC の host executable は Emscripten では拡張子なしの JS launcher + .wasm になる
# 場合と .js + .wasm になる場合があるため両方を扱う。この命名規則も実ビルド未確認。
CC1_STEM="$GCC_BUILD/gcc/cc1"
if [ -f "$CC1_STEM.js" ]; then
  CC1_JS="$CC1_STEM.js"
elif [ -f "$CC1_STEM" ]; then
  CC1_JS="$CC1_STEM"
else
  echo "ERROR: cc1 の JS 生成物がありません: $CC1_STEM[.js]" >&2
  exit 1
fi
CC1_WASM="$CC1_STEM.wasm"
[ -f "$CC1_WASM" ] || {
  echo "ERROR: cc1 の wasm 生成物がありません: $CC1_WASM" >&2
  exit 1
}

mkdir -p "$BIN_DIR"
OUTPUT_STEM="$BIN_DIR/${PROGRAM_PREFIX}cc1.${WASM_FS}"
SOURCE_WASM_NAME="$(basename "$CC1_WASM")"
OUTPUT_WASM_NAME="$(basename "$OUTPUT_STEM").wasm"
sed "s/${SOURCE_WASM_NAME}/${OUTPUT_WASM_NAME}/g" "$CC1_JS" > "$OUTPUT_STEM.js"
chmod 755 "$OUTPUT_STEM.js"
cp "$CC1_WASM" "$OUTPUT_STEM.wasm"
chmod 644 "$OUTPUT_STEM.wasm"

echo '== 生成物サイズ（バイト） =='
wc -c "$OUTPUT_STEM.js" "$OUTPUT_STEM.wasm"
echo '== 完了（この生成物の動作・バイト一致は verify_wasm.mts で別途検証する） =='
echo "生成: $OUTPUT_STEM.js + $OUTPUT_STEM.wasm"
