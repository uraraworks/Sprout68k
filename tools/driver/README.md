# X68kDev 混成ビルド駆動層

`build.mts` が cc1 → as → ld → objcopy のコマンド列の正典です。
従来の `tools/build_via_cc1.sh` もこのモジュールを呼ぶため、二重管理しません。

```sh
node tools/driver/build.mts stage_c build/stage_c_driver.xdf
node tools/driver/build.mts breakout build/breakout_driver.xdf \
  --mode cc1=native,as=wasm,ld=native,objcopy=native
```

モードは `X68KDEV_CC1_MODE`、`X68KDEV_AS_MODE`、`X68KDEV_LD_MODE`、
`X68KDEV_OBJCOPY_MODE` でもツールごとに指定できます。既定はすべて `native` です。
binutils の `wasm` 実行時は、NODERAWFS 付き Emscripten JS を独立した Node
子プロセスで起動します。JS は次の環境変数で指定します。

```sh
X68KDEV_AS_WASM_JS=build/wasm-tools/m68k-elf-as.js
X68KDEV_LD_WASM_JS=build/wasm-tools/m68k-elf-ld.js
X68KDEV_OBJCOPY_WASM_JS=build/wasm-tools/m68k-elf-objcopy.js
```

インストール前の `cc1` wasm を使う場合は、その組み込みprefixに存在しないGCC内部
ヘッダ（`stdarg.h` 等）を基準器から探せるよう、`X68KDEV_CC1_GCC_EXEC_PREFIX` に
基準器の `lib/gcc/` を指定します。この値は `cc1=wasm` の子プロセスだけで
`GCC_EXEC_PREFIX` へ渡され、native ツールの探索には影響しません。

未指定または存在しないモジュールを `wasm` にすると明示的に失敗します。
`cc1` も同じ実行形式で、`X68KDEV_CC1_WASM_JS` にランチャーを指定します。

`X68KDEV_TOOLCHAIN=/path/to/prefix` を指定すると、その配下の `bin`、`libexec/gcc`、
`lib/gcc` を使います。未指定時は従来どおり PATH 上の Homebrew ツールを使います。

全 native の基準比較と `-O0` 陽性対照は次で実行します。

```sh
node tools/driver/verify.mts
```

binutils 3本をツール単位で差し替え、全 native とバイト比較する F-2 検証は次です。

```sh
node tools/driver/verify_wasm.mts
```
