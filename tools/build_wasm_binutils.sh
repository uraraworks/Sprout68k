#!/usr/bin/env bash
# binutils 2.44 を host=wasm32-unknown-emscripten / target=m68k-elf でビルドする。
# ソース、ビルド木、生成物はすべて PREFIX 配下に隔離する。
#
# 使い方:
#   tools/build_wasm_binutils.sh [-j N] [--configure-only]
#   WASM_FS=noderawfs|memfs PREFIX=/任意の絶対パス tools/build_wasm_binutils.sh -j 8
#
# 既定の noderawfs は従来どおり Node から実ファイルを直接扱う。memfs は factory を
# export し、自動実行せず、呼び出し側が FS.writeFile() -> callMain() -> FS.readFile() の
# 順で駆動する。memfs の ENVIRONMENT=web,node はブラウザ本番と Node 上のバイト一致検証を
# 同じ生成物で行うためであり、NODERAWFS を使う noderawfs は Node 専用のままとする。
set -euo pipefail

BINUTILS_VERSION=2.44
BINUTILS_SHA256=ce2017e059d63e67ddb9240e9d4ec49c2893605035cd60e92ad53177f4377237
BINUTILS_URL="https://ftp.gnu.org/gnu/binutils/binutils-${BINUTILS_VERSION}.tar.xz"
HOST=wasm32-unknown-emscripten
TARGET=m68k-elf
PROGRAM_PREFIX=m68k-elf-
WASM_FS="${WASM_FS:-noderawfs}"

PREFIX="${PREFIX:-$HOME/sprout68k-wasm}"
# wasm出力を、cc1へ焼き込まれたネイティブ基準器prefixへ混在させない。
NATIVE_REFERENCE_PREFIX="$HOME/x68kdev-toolchain"
EMSDK="${EMSDK:-$HOME/emsdk}"
SRC_DIR="$PREFIX/src"
DOWNLOAD_DIR="$SRC_DIR/downloads"
BUILD_ROOT="$PREFIX/build"
BIN_DIR="$PREFIX/bin"
EM_CACHE="$PREFIX/emscripten-cache"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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
      sed -n '2,8p' "$0"
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
case "$PREFIX" in
  /*) ;;
  *) echo "ERROR: PREFIX は絶対パスで指定してください: $PREFIX" >&2; exit 2 ;;
esac
case "$PREFIX" in
  "$NATIVE_REFERENCE_PREFIX"|"$NATIVE_REFERENCE_PREFIX"/*)
    echo 'ERROR: F-0 の PREFIX は使用できません' >&2
    exit 2
    ;;
  "$PROJECT_ROOT"|"$PROJECT_ROOT"/*)
    echo "ERROR: PREFIX をプロジェクト内には置けません: $PREFIX" >&2
    exit 2
    ;;
esac

[ -r "$EMSDK/emsdk_env.sh" ] || {
  echo "ERROR: emsdk_env.sh がありません: $EMSDK/emsdk_env.sh" >&2
  exit 1
}
# emsdk_env.sh が表示する環境設定一覧は通常ログには不要。
EMSDK_QUIET=1 source "$EMSDK/emsdk_env.sh"

for command_name in curl tar make awk sed emcc emconfigure emmake; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "ERROR: 必要なコマンドがありません: $command_name" >&2
    exit 1
  }
done

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo 'ERROR: sha256sum または shasum が必要です' >&2
    exit 1
  fi
}

download_and_verify() {
  local output="$1"
  local actual
  if [ ! -f "$output" ]; then
    echo "== ダウンロード: $BINUTILS_URL =="
    curl --fail --location --retry 3 --output "$output.part" "$BINUTILS_URL"
    mv "$output.part" "$output"
  else
    echo "== 既存アーカイブを検証: $output =="
  fi
  actual="$(sha256_file "$output")"
  if [ "$actual" != "$BINUTILS_SHA256" ]; then
    echo "ERROR: SHA-256 が一致しません: $output" >&2
    echo "  expected: $BINUTILS_SHA256" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
  echo "SHA-256 OK: $actual"
}

mkdir -p "$DOWNLOAD_DIR" "$BUILD_ROOT"
export EM_CACHE
BINUTILS_ARCHIVE="$DOWNLOAD_DIR/binutils-${BINUTILS_VERSION}.tar.xz"
BINUTILS_SOURCE="$SRC_DIR/binutils-${BINUTILS_VERSION}"
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
BINUTILS_BUILD="$BUILD_ROOT/binutils-${BINUTILS_VERSION}-${WASM_FS}"

download_and_verify "$BINUTILS_ARCHIVE"
if [ ! -d "$BINUTILS_SOURCE" ]; then
  echo "== 展開: $BINUTILS_ARCHIVE =="
  tar -C "$SRC_DIR" -xf "$BINUTILS_ARCHIVE"
else
  echo "== 展開済みソースを再利用: $BINUTILS_SOURCE =="
fi

# 注意: この cache 変数は configure のコマンド前置きにすると**サブディレクトリの
# configure に渡らない**(libiberty は自前の configure を持つため、そこで再び
# 「psignal は無い」と判定されて同じ衝突で落ちる。実際に1回落ちた)。環境変数
# として export し、すべての configure に効かせる。
export ac_cv_func_psignal=yes

# emscripten の libc は psignal を signal.h で宣言するが実体を持たない。configure は
# 「関数が無い」と判定して libiberty の代替定義を有効にするが、その代替定義の引数型
# (char *)がヘッダの宣言(const char *)と衝突してビルドが落ちる。psignal は binutils
# 本体が呼ばない補助関数なので、代替定義そのものを無効化する(ac_cv_func_psignal=yes)。
# 万一どこかが psignal を呼んでいれば未定義シンボルとしてリンク時に必ず表面化する。
BUILD="$($BINUTILS_SOURCE/config.guess)"
WASM_LDFLAGS="${LDFLAGS:+$LDFLAGS }$WASM_RUNTIME_LDFLAGS"
mkdir -p "$BINUTILS_BUILD"
if [ ! -f "$BINUTILS_BUILD/Makefile" ]; then
  echo "== binutils configure (build=$BUILD host=$HOST target=$TARGET) =="
  (
    cd "$BINUTILS_BUILD"
    CC_FOR_BUILD="${CC_FOR_BUILD:-cc}" \
    CXX_FOR_BUILD="${CXX_FOR_BUILD:-c++}" \
    CFLAGS="${CFLAGS:--O2}" \
    CXXFLAGS="${CXXFLAGS:--O2}" \
    LDFLAGS="$WASM_LDFLAGS" \
      emconfigure "$BINUTILS_SOURCE/configure" \
        --build="$BUILD" \
        --host="$HOST" \
        --target="$TARGET" \
        --prefix="$PREFIX" \
        --program-prefix="$PROGRAM_PREFIX" \
        --disable-nls \
        --disable-werror \
        --disable-shared \
        --enable-static \
        --disable-gdb \
        --disable-gdbserver \
        --disable-gprofng \
        --disable-libdecnumber \
        --disable-readline \
        --disable-sim \
        --disable-plugins \
        --disable-lto
  )
fi

if [ "$CONFIGURE_ONLY" -eq 1 ]; then
  echo "== configure-only 完了: $BINUTILS_BUILD =="
  exit 0
fi

echo "== binutils ${BINUTILS_VERSION} build (-j${JOBS}) =="
emmake make -C "$BINUTILS_BUILD" -j"$JOBS" all-binutils all-gas all-ld

# make install は .wasm 側ファイルを追随して配置しないため、必要な3ツールをペアで
# 明示的にパッケージする。JS 内の wasm ファイル名も配置後の名前に合わせる。
mkdir -p "$BIN_DIR"
package_tool() {
  local source_stem="$1"
  local output_stem="$2"
  local js_source wasm_source source_wasm_name output_wasm_name

  if [ -f "$source_stem.js" ]; then
    js_source="$source_stem.js"
  elif [ -f "$source_stem" ]; then
    js_source="$source_stem"
  else
    echo "ERROR: JS 生成物がありません: $source_stem[.js]" >&2
    exit 1
  fi
  wasm_source="$source_stem.wasm"
  [ -f "$wasm_source" ] || {
    echo "ERROR: wasm 生成物がありません: $wasm_source" >&2
    exit 1
  }

  source_wasm_name="$(basename "$wasm_source")"
  output_wasm_name="$(basename "$output_stem").wasm"
  sed "s/${source_wasm_name}/${output_wasm_name}/g" "$js_source" > "$output_stem.js"
  chmod 755 "$output_stem.js"
  cp "$wasm_source" "$output_stem.wasm"
  chmod 644 "$output_stem.wasm"
  echo "生成: $output_stem.js + $output_stem.wasm"
}

package_tool "$BINUTILS_BUILD/gas/as-new" "$BIN_DIR/${PROGRAM_PREFIX}as.${WASM_FS}"
package_tool "$BINUTILS_BUILD/ld/ld-new" "$BIN_DIR/${PROGRAM_PREFIX}ld.${WASM_FS}"
package_tool "$BINUTILS_BUILD/binutils/objcopy" "$BIN_DIR/${PROGRAM_PREFIX}objcopy.${WASM_FS}"

echo '== 完了 =='
if [ "$WASM_FS" = noderawfs ]; then
  "$EMSDK_NODE" "$BIN_DIR/${PROGRAM_PREFIX}as.noderawfs.js" --version
  "$EMSDK_NODE" "$BIN_DIR/${PROGRAM_PREFIX}ld.noderawfs.js" --version
  "$EMSDK_NODE" "$BIN_DIR/${PROGRAM_PREFIX}objcopy.noderawfs.js" --version
else
  echo 'memfs 版は自動実行しないため、動作確認は tools/driver/verify_wasm.mts で行う'
fi
