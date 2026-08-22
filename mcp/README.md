# sprout68k-mcp — Sprout68k のプログラムを AI から書いて動かす MCP サーバー

X68000 用の入門プログラミング環境 Sprout68k のプログラムを、AI エージェントから
**書いて・ビルドして・実際に動かして・画面を見る**ための MCP サーバーです。

**ブラウザは使いません。** ビルドも実行も Node のプロセス内で完結します
（px68k を直接回します）。そのため速く、結果が決定的で、タブの表示状態にも
左右されません。

> このページは**エージェントに読ませればそのままセットアップできる**ように書いてあります。
> 下の「セットアップ」を上から順に実行してください。

## できること

| ツール | 返すもの |
| --- | --- |
| `api_reference` | この環境で使える関数（29個）の一覧と、名前を指定したときの説明・引数・返り値・**動く例**・つまずきどころ |
| `build` | ビルドが通ったかと、**日本語の注釈つき診断** |
| `run` | 実際に動かして、テキスト画面の文字・**画面のPNG**・描かれた画素数 |
| `share_link` | 共有URL2種類（遊んでもらう／読んでもらう）と、それぞれの文字数 |

接続すると、この環境の書き方（`void main(void)`、小数が使えない、絵を描く3段など）が
最初に渡ります。**推測で書かせないことがいちばん効きます。** Sprout68k の関数は
学習データに無く、`printf` のように名前を知っている関数ほど「知っているつもり」で
外すためです。

`share_link` は **`ai` タグを必ず付けます**。人間の付け忘れをなくすのがこのツールの
役目のひとつです。

## セットアップ

WebX68k の MCP と違い、こちらは**リポジトリそのものが必要**です（ビルドと実行を
自分で行うため、コンパイラ・ライブラリ・ROM・エミュレータのコアを参照します）。
単一ファイルでは配れません。

### 1. Node.js 22 以上があることを確認する

```bash
node -v
```

`v22` 未満なら Node.js を更新してください。

### 2. m68k のツールチェーン（gcc 13.4.0）があることを確認する

```bash
PATH="$HOME/x68kdev-toolchain/bin:$PATH" m68k-elf-gcc -dumpversion
```

`13.4.0` と出れば準備できています。

- **コマンドが見つからない場合**: ツールチェーンが未構築です。
  リポジトリ直下の `tools/build_native_toolchain.sh` で作れます（時間がかかります）。
- **13.4.0 以外が出る場合**: 別の GCC を拾っています。この環境の正典は 13.4.0 で、
  版が違うと出るバイナリが変わります。`$HOME/x68kdev-toolchain/bin` を PATH の
  先頭に置いてください（Homebrew の m68k-elf-gcc より前に）。

### 3. 依存を入れる

```bash
npm install --prefix mcp
```

### 4. MCP サーバーとして登録する

`<絶対パス>` はこのリポジトリのルートに置き換えてください（`pwd` で確認できます）。

```bash
claude mcp add sprout68k --env PATH="$HOME/x68kdev-toolchain/bin:$PATH" -- node <絶対パス>/mcp/server.mjs
```

Claude Code 以外のクライアントでは、stdio transport で
`node <絶対パス>/mcp/server.mjs` を起動する設定を追加し、`PATH` に
`$HOME/x68kdev-toolchain/bin` を含めてください。

### 5. 疎通を確かめる

登録したクライアントから `api_reference` を引数なしで呼び、関数の一覧が返れば成功です。
次に `run` へ下のソースを渡すと、`テキスト画面` に `HELLO` が入り、
`描かれた画素数` が 0 より大きくなります。

```c
#include "x68.h"

void main(void) {
  x68_screen_open();
  x68_cls(x68_rgb(0, 0, 0));
  x68_box_fill(100, 100, 200, 150, x68_rgb(255, 128, 0));
  printf("HELLO");
  x68_screen_flip();
}
```

## 使い方

```
api_reference                       使える関数を見る
api_reference name=x68_box_fill     四角の塗り方を引く
run source="..."                    動かして画面を見る
run source="..." keys=[{key:"left",frames:30}]   左キーを30フレーム押す
share_link source="..."             共有URLを作る
```

`run` の `描かれた画素数` が 0 なら、グラフィック画面に何も描かれていません
（`x68_screen_open()` と `x68_screen_flip()` の呼び忘れがほとんどです）。

## うまくいかないとき

| 症状 | 原因と対処 |
| --- | --- |
| 起動時に「ツールチェーンの版が違います」と出る | 手順2を確認。PATH の順序が原因のことが多い |
| `build` が `undefined reference` で失敗する | この環境に無い関数を呼んでいる。`api_reference` で使える29関数を確認する |
| `run` の `描かれた画素数` が 0 | `x68_screen_open()` / `x68_screen_flip()` の呼び忘れ |
| `printf` に `[BADFMT]` と表示される | `%f` や `%3d` は使えない。使えるのは `%d %u %x %c %s %%` だけ |

## 作りについて

- `tools/build_for_mcp.mts` — 共有ランタイム方式でビルドし、診断に日本語注釈を付ける
- `tools/px68k_host.mts` — px68k を Node から回して、テキスト画面と画素を読む
- `tools/png.mts` — RGBA から PNG を作る最小の実装（Node に PNG エンコーダが無いため）

**stdout は MCP の通信路**なので、`server.mjs` の冒頭で `console.log` を stderr へ
逃がしています。ビルド経路が進捗を `console.log` で出すため、そのままだと
プロトコルが壊れます。
