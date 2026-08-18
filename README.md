# X68kDev — 最小ブートセクタの自作と実測

X68000 用の最小ブートセクタ(Human68k 不使用・生の 2HD イメージ)を自作し、
px68k(WebX68k のコア)で実際に起動することを Node から直接コアを回して実測した。

## 結果

- **Stage A(文字列表示): 起動した。** テキスト VRAM を読み取ると `"BOOT OK"` が
  実際に表示されていることを確認した(`readTextScreen()` で `nonEmptyCells=6`)
- **Stage B(画面を1色で塗る): 起動した。** フレームバッファ(768x512、393,216px)を
  読み取り、**全ピクセルが単色**(RGB 231,231,231、`fill_color=0xFFFF` 指定)に
  なっていることを確認した。231 は px68k の描画上の最大値(白)であり、`0xFF`(255)
  ではない
- Stage A の実測画面: `0,0,0`(未描画の黒)が393,050px、`231,227,231`("BOOT OK"の
  文字)が166px。Stage B の実測画面: `231,231,231` が393,216px(coverage=100.0%)
- 陽性対照(第三者のブート可能ディスク)と陰性対照(全バイト0イメージ)は、
  同一フレーム数実行した後で `pixelChecksum` / `nonEmptyCells` / `fddReadFrames`
  のいずれも食い違った(観測系が機能していることの確認)。陰性対照は実際に
  IPL の「エラーが発生しました。リセットしてください。」を表示した

## 使った IOCS / メモリマップ

Stage A は事前調査(`../docs/ブートセクタ調査_20260819.md`)で実測済みの範囲のみ使用:

- `D0=$21, TRAP #15`: 文字列表示(A1=文字列ポインタ、PC相対で参照)
- ロードアドレス非依存。スタック設定だけ絶対アドレス($B000)、他は PC相対/自己相対

Stage B は IOCS ではなく、px68k のソースを実測して確認したメモリマップを使用
(`px68k-libretro/x68k/{crtc.c,gvram.c}`, `px68k-libretro/libretro/windraw.c`):

| アドレス | 意味 |
|---|---|
| `$E80028.B` | CRTC R20下位。bit3=1 で GVRAM の**アドレッシング**が65536色1ページになる |
| `$E82401.B` | Video Controller R0下位。下位2bit=3 で**画面合成**が65536色モードになる |
| `$E82601.B` | Video Controller R2下位。下位4bitのいずれか(bit0)が立っていないと65536色面が描画されない |
| `$C00000〜` | グラフィックVRAM。65536色1ページでは16bit色値をそのまま1ワード=1ドットに書く |

**アドレッシング側(CRTC R20)と合成側(VC R0)は別レジスタで、両方を65536色に
合わせないと映らない。** 最初の試行でこの片方だけ設定して失敗し、フレームバッファが
アイドル画面のままだった。

## 迷った点(記録として残す)

`px68k-libretro/libretro/windraw.c` の `WinDraw_DrawLine()` が、実際の画面合成の
入口。`grep -n` では最初「そんな関数は無い」という結果になったが、これは grep の
誤判定だった。このファイルは CP932 コメントを含み、grep が NEL(0x85)相当の
バイト列で行を無言でスキップしていた(既知の罠)。Node で `latin1` として
読み直すと存在が確認できた。

`px68k_grp_off` という libretro コアオプションが `Debug_Grp` フラグ(グラフィック
面合成の有効/無効)を制御している。デフォルト値は `"disabled"` → `Debug_Grp=1`
(=合成が有効)なので、今回は明示的に設定しなくても通った。

## 駆動経路

**Node で wasm コアを直接回した。ブラウザは使っていない。** 手順:

1. `WebX68k/public/core/px68k_libretro.js` を `node:vm` で読み込み、
   `LibretroHost`(`WebX68k/src/libretro-host.ts`)にそのまま渡す
2. 自作イメージを `writeDiskImage()` で fd0 として挿し、`px68k "<path>" ""` を
   `/game/boot.cmd` に書いて `loadGame()`(Human68k を経由しないので fd1 は空)
3. `runFrame()` を固定回数呼び、`readTextScreen()` / `putImageData` で
   捕まえたフレームバッファを読む

ハマった罠(先行する検証スクリプトの記憶どおり):

- `__BUILD_ID__` は vite の define なので Node 直実行では未定義 →
  `globalThis.__BUILD_ID__` を先に置く
- `locateFile` が `.wasm?v=<id>` を返し Node の fs が ENOENT になる →
  ファクトリを包んで `locateFile: (p,d) => d+p` に戻す

## 再現方法

```sh
# 1. ブートセクタと陰性対照を生成
python3 tools/build_stage_a.py build/stage_a.xdf
python3 tools/build_stage_b.py build/stage_b.xdf
python3 tools/build_zero_image.py build/zero.xdf

# 2. 検証(陽性対照イメージのパスは環境変数で渡す。第三者の著作物なので同梱しない)
POSITIVE_CONTROL_IMG=/path/to/known-bootable.xdf npx --no-install tsx verify/verify.mts
```

`WEBX68K_DIR` で `../WebX68k` 以外の場所の WebX68k を参照できる。
`VERBOSE=1` でフレームごとの途中経過(canvas解像度・ディスクアクセス状況)を出す。

## Stage B 判定が空振りしていた事実(再発防止)

旧判定は「出現頻度最上位の色が全体の95%超を占めるか」だけを見ていた。これは
**意図した色と突き合わせていない**判定で、故障注入で空振りが実測された:

- `STAGE_B_IMG` に**塗り処理を持たない Stage A のイメージ**を食わせると、
  `STAGE_B_UNIFORM_FILL=true dominant_rgb=0,0,0 coverage=1.000` と出て
  **通ってしまう**(真っ黒な未描画画面を「単色塗り成功」と誤判定していた)
- 「全ピクセルが同一色」という条件は、**描画が起きていない画面が最も強く
  満たす**。判定条件が失敗状態のほうを強く満たす形になっていたのが原因

**検出のしかた**: 塗り処理を持たないイメージ(Stage A)を Stage B の判定に
そのまま通し、`true` になるかどうかを見る。通ってしまえば判定が空振りしている
証拠になる。

**修正後の判定は3条件すべてを要求する**(`verify/verify.mts` の
`checkUniformFillColor` / `STAGE_B_COLOR_TRACKS_DIFFER`):

1. 被覆率が実質100%(`>= 0.999`。旧値の0.95は緩すぎた)
2. 支配色が Stage A(未描画状態)の支配色と異なること — Stage A の実測結果を
   組み込みの陰性対照として使う
3. `fill_color` を変えた2枚(既定 `0xFFFF` と `0x001F`)を生成して両方起動し、
   観測される支配色が2つで異なること(実測: `231,231,231` と `0,4,115`)。
   これで「たまたま単色だった」と「指定通りに塗れた」を分離する

`verify.mts` の実行末尾では、Stage A の画面を Stage B 判定にそのまま通す
**自己故障注入**を行い、`false` になることを確認してから正常終了する
(`false` にならない場合は検査自体が壊れているとみなし異常終了する)。

## 構成

- `tools/build_stage_a.py` — Stage A(文字列表示)のバイト列を生成。68000の
  生バイト列を1命令ずつ手組み(アセンブラ不使用)
- `tools/build_stage_b.py` — Stage B(画面を1色で塗る)のバイト列を生成
- `tools/build_zero_image.py` — 陰性対照(全バイト0)を生成
- `verify/verify.mts` — Node から px68k コアを直接回し、陽性/陰性対照とStage A/Bを実測する
- `build/` — 生成物置き場(gitignore対象。スクリプトで再生成できる)
