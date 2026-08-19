# X68kDev — 最小ブートセクタの自作と実測

X68000 用の最小ブートセクタ(Human68k 不使用・生の 2HD イメージ)を自作し、
px68k(WebX68k のコア)で実際に起動することを Node から直接コアを回して実測した。

## Stage C(ネイティブ m68k-elf-gcc でビルドした C プログラムの起動)

**起動した。** Homebrew の `m68k-elf-gcc`(16.2.0)/`m68k-elf-binutils`(2.47)の
prebuilt をそのまま使い、`-ffreestanding -nostdlib` の最小構成(自作 crt0 +
自作リンカスクリプト + 自作 IOCS スタブ)でビルドした C プログラムが、
複数セクタ対応のブートセクタ経由で `.xdf` から実際に起動することを確認した。

- 実測: `fill_color=0xFFFF` で `dominant_rgb=231,231,231 coverage=1.000`、
  `fill_color=0x001F` で `dominant_rgb=0,4,115 coverage=1.000`(2色で支配色が
  食い違うことを確認 = 「たまたま単色」ではなく指定通りに塗れている)
- テキスト画面に `"STAGE C OK"` が実際に表示されていることを確認(IOCS $21)
- 自己故障注入: Stage A(塗り処理を持たない画面)を Stage C の判定に通すと
  `ok=false`(`dominant_rgb が未描画状態の支配色と同一`)になることを確認済み

**IOCS $46(ディスク読み込み)のレジスタ規約を実測で確定した。** このリポジトリの
過去の背景資料は「A0=転送先」としていたが、これは**誤りだった**。実際に確定した
規約(`stage_c/boot/boot.S` のコメント、および実測用トライアルで検証済み):

| レジスタ | 意味 |
|---|---|
| `D1.L` 上位バイト | PDA(物理ドライブアドレス)。2HD-FD ドライブ0 = `$90` |
| `D1.L` 下位バイト | モード。bit6=MFM, bit5=リトライ, bit4=シーク(`$70`で成功を実測) |
| `D2.L` bit31-24 | セクタ長コード(3=1024バイト) |
| `D2.L` bit23-16 | トラック番号(0起点) |
| `D2.L` bit15-8 | サイド(0/1) |
| `D2.L` bit7-0 | セクタ番号(1起点) |
| `D3.L` | 読み込むバイト数(複数セクタをまたいでも1回のTRAPで読める) |
| **`A1.L`**(A0 ではない) | 転送先バッファアドレス |
| `D0.L`(戻り値) | `0`=成功、`$FFFFFFFF`=エラー |

この規約は `datacrystal.tcrf.net` の X68k/IOCS ページの構造記述(PDA/モードビット/
D2 のビットフィールド)と付き合わせて一致することを確認済み。**第三者のブート
可能ディスクのバイト列を直接コピーはしていない**(独自に組んだ値を実測で
確認し、公開ドキュメントの記述と突き合わせて裏を取った)。

- ブートセクタの複数セクタ対応: `stage_c/boot/boot.S` はビルド時に本体の
  セクタ数を `SECTOR_COUNT` として埋め込み、track0/side0/sector2 から連続
  読み込む。track0/side0 は8セクタ中7セクタ(sector2〜8=7168バイト)しか
  使えず、それを超える本体サイズは未対応(track/sideをまたぐ読み込みの
  レジスタ規約は未検証)
- 構成: `stage_c/crt0/crt0.S`(スタック設定+BSSクリア+main呼び出し)、
  `stage_c/crt0/iocs.S`(IOCS $21 の C スタブ)、
  `stage_c/crt0/linker.ld`(ロードアドレス `$3000` 固定)、
  `stage_c/src/main.c`(画面塗り+文字列表示)、
  `tools/build_stage_c.sh`(ビルド一式)

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
# 0. m68k-elf ツールチェーンが必要(Stage C のみ。Stage A/B は不要)
brew install m68k-elf-binutils m68k-elf-gcc

# 1. ブートセクタと陰性対照を生成(Stage C は verify.mts が内部でビルドする)
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

## Stage D(track/sideをまたぐ複数セクタ読み込み)

**目標未達。track0→track1の1回のtrack境界またぎまでは成功するが、track2に
到達する構成(32KB程度・256KB以上)は原因未特定のバグで失敗する。**

- IOCS $46 のレジスタ規約は Stage C から変わらないが、境界またぎの実測実験で
  以下を確認した:
  - 1回の $46 呼び出しは track/side の境界をまたいで読める(実測: side0→side1
    をまたぐ12000バイトの読み込みが1回のTRAPで成功、チェックサム一致で確認)
  - 読み進め順序は「トラック内はside0→side1、トラックは番号順」。セクタ番号は
    1起点
  - D0(戻り値)は0/$FFFFFFFF以外の値(2、0x04000000等)を返すことがあるが、
    その場合もデータ自体は正しく転送されていることを実測で確認済み
- **未解決のバグ**: track0→track1→track2 と2回trackをまたぐと、read_error には
  ならないが読み込んだコードが壊れて起動が破綻する(px68kがIPLの汎用エラー
  画面を表示)。track0→track1(1回のまたぎ)までは確実に成功する(実測の安全な
  上限: 31セクタ=31,744バイト)。多数の切り分け実験(D2/D3/A1を即値にするか
  レジスタ演算にするか、1セクタずつ読むか1サイドまとめて読むか、最初の呼び出し
  をsector1起点にするワークアラウンド等)を行ったが、いずれも単独の再現実験
  では成功してしまい、本番のブートセクタに組み込んだ状態でのみ再現するため、
  原因を確定できなかった。詳細は `stage_d/boot/boot.S` 冒頭のコメント参照
- **チェックサム+番兵による判定の仕組みは正しく機能している**ことは実測で
  確認済み: 7168バイト以下(退行なし)・8192バイト超(side境界またぎ)は
  `LOAD OK <checksum> <sentinel>` で成功、32KB・256KB構成は起動が壊れて
  `LOAD OK/NG` すら出力されない(クラッシュ)。読み込むセクタ数を意図的に
  1つ少なく指定する自己故障注入では、安全な範囲(track境界を1回までしか
  またがない20000バイト構成)で `LOAD NG` になることを確認済み(検査は
  空振りしていない)
- 構成: `stage_d/boot/boot.S`(ローダ本体)、`stage_d/crt0/linker.ld`
  (`.pattern`セクションを本体の最後尾に強制配置。crt0/IOCSスタブはStage Cと共用)、
  `stage_d/src/main.c`(チェックサム+番兵の検査とIOCS $21での結果表示)、
  `stage_d/src/pattern_data.S`(`.incbin`でパターンを取り込む)、
  `tools/gen_pattern.py`(既知パターン+番兵の生成、期待チェックサムの算出)、
  `tools/build_stage_d.sh`(ビルド一式。第3引数で自己故障注入用の読み込み
  不足セクタ数を指定できる)

## 構成

- `tools/build_stage_a.py` — Stage A(文字列表示)のバイト列を生成。68000の
  生バイト列を1命令ずつ手組み(アセンブラ不使用)
- `tools/build_stage_b.py` — Stage B(画面を1色で塗る)のバイト列を生成
- `tools/build_zero_image.py` — 陰性対照(全バイト0)を生成
- `tools/build_stage_c.sh` — Stage C(ネイティブ m68k-elf-gcc でビルドしたC)を
  ビルドし .xdf に合成する
- `tools/build_stage_d.sh` / `tools/gen_pattern.py` — Stage D(複数トラック読み込み)
  のビルド一式
- `stage_c/` — Stage C のソース一式(`crt0/`, `boot/`, `src/`)
- `stage_d/` — Stage D のソース一式(`boot/`, `crt0/`, `src/`)。`crt0/`の
  `crt0.S`/`iocs.S`はStage Cのものを直接参照して共用する
- `docs/toolchain調査.md` — elf2x68k/xdev68k のビルド定義を読んで確定した
  gcc/binutilsのバージョンとconfigureオプションの調査結果
- `verify/verify.mts` — Node から px68k コアを直接回し、陽性/陰性対照とStage A/B/C/Dを実測する
- `build/` — 生成物置き場(gitignore対象。スクリプトで再生成できる)
