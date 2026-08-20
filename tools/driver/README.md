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
`wasm` は分岐と実行抽象だけを用意した未実装経路で、選ぶと明示的に失敗します。

`X68KDEV_TOOLCHAIN=/path/to/prefix` を指定すると、その配下の `bin`、`libexec/gcc`、
`lib/gcc` を使います。未指定時は従来どおり PATH 上の Homebrew ツールを使います。

全 native の基準比較と `-O0` 陽性対照は次で実行します。

```sh
node tools/driver/verify.mts
```
