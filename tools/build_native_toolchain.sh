#!/usr/bin/env bash
# binutils 2.44 + GCC 13.4.0 の m68k-elf ネイティブ基準器を自前ビルドする。
# ソース・ビルド木・インストール先はすべて PREFIX 配下に置き、プロジェクトを汚さない。
#
# 使い方:
#   tools/build_native_toolchain.sh [-j N]
#   PREFIX=/任意の絶対パス tools/build_native_toolchain.sh -j 8
#
# 所要時間の目安（Apple Silicon/Intel Mac、回線・CPU により大きく変動）:
#   取得・展開 5～15分 / binutils 5～15分 / GCC本体 20～60分 /
#   libgcc（全multilib）5～20分、合計およそ35～110分。
set -euo pipefail

BINUTILS_VERSION=2.44
GCC_VERSION=13.4.0
TARGET=m68k-elf
PROGRAM_PREFIX=m68k-elf-

# GNU 公式配布物の SHA-256。値が一致しないアーカイブは絶対に展開しない。
BINUTILS_SHA256=ce2017e059d63e67ddb9240e9d4ec49c2893605035cd60e92ad53177f4377237
GCC_SHA256=9c4ce6dbb040568fdc545588ac03c5cbc95a8dbf0c7aa490170843afb59ca8f5
BINUTILS_URL="https://ftp.gnu.org/gnu/binutils/binutils-${BINUTILS_VERSION}.tar.xz"
GCC_URL="https://ftp.gnu.org/gnu/gcc/gcc-${GCC_VERSION}/gcc-${GCC_VERSION}.tar.xz"

# 既定prefixはcc1へ絶対パスとして焼き込まれる。名称だけ変更すると内部ヘッダを
# 発見できず、再ビルドするとバイト一致の基準器も変わるため、この場所を維持する。
PREFIX="${PREFIX:-$HOME/x68kdev-toolchain}"
SRC_DIR="$PREFIX/src"
BUILD_DIR="$PREFIX/build"
DOWNLOAD_DIR="$SRC_DIR/downloads"
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
    -h|--help)
      sed -n '2,9p' "$0"
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
  "$PROJECT_ROOT"|"$PROJECT_ROOT"/*)
    echo "ERROR: PREFIX をプロジェクト内には置けません: $PREFIX" >&2
    exit 2
    ;;
esac

for command_name in curl tar make awk sed; do
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
  local url="$1"
  local expected="$2"
  local output="$3"
  local actual

  if [ ! -f "$output" ]; then
    echo "== ダウンロード: $url =="
    curl --fail --location --retry 3 --output "$output.part" "$url"
    mv "$output.part" "$output"
  else
    echo "== 既存アーカイブを検証: $output =="
  fi

  actual="$(sha256_file "$output")"
  if [ "$actual" != "$expected" ]; then
    echo "ERROR: SHA-256 が一致しません: $output" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
  echo "SHA-256 OK: $actual"
}

extract_once() {
  local archive="$1"
  local destination="$2"
  if [ ! -d "$destination" ]; then
    echo "== 展開: $archive =="
    tar -C "$SRC_DIR" -xf "$archive"
  else
    echo "== 展開済みソースを再利用: $destination =="
  fi
}

mkdir -p "$DOWNLOAD_DIR" "$BUILD_DIR"

BINUTILS_ARCHIVE="$DOWNLOAD_DIR/binutils-${BINUTILS_VERSION}.tar.xz"
GCC_ARCHIVE="$DOWNLOAD_DIR/gcc-${GCC_VERSION}.tar.xz"
BINUTILS_SOURCE="$SRC_DIR/binutils-${BINUTILS_VERSION}"
GCC_SOURCE="$SRC_DIR/gcc-${GCC_VERSION}"
BINUTILS_BUILD="$BUILD_DIR/binutils-${BINUTILS_VERSION}"
GCC_BUILD="$BUILD_DIR/gcc-${GCC_VERSION}"

download_and_verify "$BINUTILS_URL" "$BINUTILS_SHA256" "$BINUTILS_ARCHIVE"
download_and_verify "$GCC_URL" "$GCC_SHA256" "$GCC_ARCHIVE"
extract_once "$BINUTILS_ARCHIVE" "$BINUTILS_SOURCE"
extract_once "$GCC_ARCHIVE" "$GCC_SOURCE"

# GCC 同梱の公式スクリプトは gcc.gnu.org/pub/gcc/infrastructure から GMP・MPFR・
# MPC・ISL を取得し、同梱チェックサムで検証してからソース木へ配置する。
echo '== GCC prerequisites を取得・検証 =='
(cd "$GCC_SOURCE" && ./contrib/download_prerequisites)

mkdir -p "$BINUTILS_BUILD"
if [ ! -f "$BINUTILS_BUILD/Makefile" ]; then
  echo '== binutils configure =='
  (cd "$BINUTILS_BUILD" && "$BINUTILS_SOURCE/configure" \
    --prefix="$PREFIX" \
    --program-prefix="$PROGRAM_PREFIX" \
    --target="$TARGET" \
    --enable-lto \
    --with-system-zlib \
    --enable-multilib)
fi
echo "== binutils ${BINUTILS_VERSION} build/install (-j${JOBS}) =="
make -C "$BINUTILS_BUILD" -j"$JOBS"
make -C "$BINUTILS_BUILD" install

# GCC configure が今ビルドした m68k-elf binutils を必ず見つけるようにする。
export PATH="$PREFIX/bin:$PATH"
mkdir -p "$GCC_BUILD"
if [ ! -f "$GCC_BUILD/Makefile" ]; then
  echo '== GCC stage1 configure =='
  (cd "$GCC_BUILD" && "$GCC_SOURCE/configure" \
    --prefix="$PREFIX" \
    --program-prefix="$PROGRAM_PREFIX" \
    --target="$TARGET" \
    --enable-lto \
    --with-system-zlib \
    --enable-languages=c \
    --without-headers \
    --with-arch=m68k \
    --with-cpu=m68000 \
    --with-newlib \
    --enable-multilib \
    --disable-nls \
    --disable-shared \
    --disable-threads)
fi

echo "== GCC ${GCC_VERSION} stage1本体 build/install (-j${JOBS}) =="
make -C "$GCC_BUILD" -j"$JOBS" all-gcc
make -C "$GCC_BUILD" install-gcc

# nm 実測で現行コードが __mulsi3/__modsi3/__udivsi3/__umodsi3 を参照したため必須。
echo "== target libgcc（全multilib）build/install (-j${JOBS}) =="
make -C "$GCC_BUILD" -j"$JOBS" all-target-libgcc
make -C "$GCC_BUILD" install-target-libgcc

echo '== 完了確認 =='
"$PREFIX/bin/m68k-elf-gcc" --version
MULTILIB_OUTPUT="$("$PREFIX/bin/m68k-elf-gcc" -print-multi-lib)"
echo "$MULTILIB_OUTPUT"
# --with-cpu=m68000 でビルドしているため、-m68000 は既定 multilib(".")が選ばれる。
# 「m68000 という名前のディレクトリがあるか」で判定すると常に落ちる(実際に落ちた)。
# 名前ではなく「-m68000 が実際に選ぶ multilib」を gcc 自身に答えさせる。
MULTI_DIR="$("$PREFIX/bin/m68k-elf-gcc" -m68000 -print-multi-directory)"
echo "-m68000 が選ぶ multilib: $MULTI_DIR"
LIBGCC_PATH="$("$PREFIX/bin/m68k-elf-gcc" -m68000 -print-libgcc-file-name)"
[ -f "$LIBGCC_PATH" ] || { echo "ERROR: -m68000 用 libgcc がありません: $LIBGCC_PATH" >&2; exit 1; }
echo "-m68000 libgcc: $LIBGCC_PATH"

# 完了後に手動で再確認する場合:
#   "$PREFIX/bin/m68k-elf-gcc" --version
#   "$PREFIX/bin/m68k-elf-gcc" -print-multi-lib
