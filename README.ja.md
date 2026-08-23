[English](README.md)

# Sprout68k

Sprout68k は、ブラウザだけで X68000 のプログラムを C で書いて動かせる入門環境。
インストールもアカウントも要らず、C のコンパイラそのものがブラウザの中で動く。
同じページに同梱した px68k で書く・ビルドする・実行するまでを完結できる。
作ったものは共有URLで配れる（受け取り側にコンパイラは要らない）。

設計・実装・実測の記録は [docs/DESIGN.md](docs/DESIGN.md) を参照(日本語)。

## 今すぐ試す

- **アプリ**: <https://uraraworks.github.io/Sprout68k/ide/>
- **Sprout68k とは（紹介）**: <https://uraraworks.github.io/Sprout68k/ide/about.html>
- **作例集**: <https://uraraworks.github.io/Sprout68k/ide/samples.html>
- **関数リファレンス**: <https://uraraworks.github.io/Sprout68k/ide/reference.html>
- **使い方**: <https://uraraworks.github.io/Sprout68k/ide/help.html>

## 使い方

IDE はファイルツリー、CodeMirror ベースの C エディタ、px68k の実行画面の
3ペイン構成。

- **編集・保存**: ソースは作業のたびにブラウザの IndexedDB
  (`Sprout68kProjectFS`) へ保存される。どこにもアップロードされない。
- **ビルド**: ツールバーの「ビルド」ボタンで、ブラウザ内で wasm 版
  GCC / binutils を動かし、利用者ソースを同梱の学習用ライブラリ・ブートセクタと
  リンクする。コンパイラ・リンカの診断には、原文(GCC/ld のメッセージ)を
  消さずに残したまま「何が起きたか」「次にすること」を重ねる日本語注釈層が付く。
- **実行**: 実行／停止は1つのトグルボタン。実行のたびに既存のエミュレータを
  止めて新しく作り直す(`runFresh()`)ため、暴走した前回の実行状態を引き継がない。
  編集中のソースは実行によって変更されない。
- **ダウンロード**: ビルドしたディスクイメージは `.xdf` ファイルとして
  ダウンロードできる。
- **共有リンク**: ツールバーの共有ダイアログから2種類のリンクを作れる。
  ビルド済みバイナリを WebX68k で開く「遊んでもらう」リンク(ソースは含まない)と、
  ソースそのものを含み Sprout68k のエディタで開いて直せる「読んでもらう・
  直してもらう」リンク。MCP サーバー経由で作ったリンクには必ず AI 作成タグが付く。
- **オフライン**: Service Worker が IDE、px68k コア、wasm ツールチェーンを
  事前キャッシュするため、一度オンラインで読み込めば、サーバー(やネットワーク)が
  止まった後も 書く→ビルド→実行 が動き続ける。

## MCP 対応（AI エージェントから書いて動かす）

`mcp/` に MCP サーバーがある。**ブラウザを使わず** Node の中でビルドと実行を完結させ、
AI エージェントから次のことができる。

- `api_reference` — この環境で使える 29 関数の一覧と、説明・引数・動く例・つまずき
- `build` — ビルドして、日本語の注釈つき診断を返す
- `run` — 実際に動かして、テキスト画面・**画面の PNG**・描かれた画素数を返す
- `share_link` — 共有 URL を作る（**`ai` タグが必ず付く**）

```bash
npm install --prefix mcp
claude mcp add sprout68k --env PATH="$HOME/x68kdev-toolchain/bin:$PATH" -- node "$PWD/mcp/server.mjs"
```

前提（Node 22 以上、gcc 13.4.0 のツールチェーン）と疎通の確かめ方、うまくいかない
ときの対処は [`mcp/README.md`](mcp/README.md) にまとめてある。**そのページを
エージェントに読ませれば、そのままセットアップできる。**

## 同梱している ROM / ディスクイメージ

同梱の IPL ROM と文字 ROM データにはそれぞれ別の許諾・帰属が適用されるため、
[`IPLROM-LICENSE.txt`](ide/system/IPLROM-LICENSE.txt)と
[`CGROM-NOTICE.md`](ide/system/CGROM-NOTICE.md)を参照。

## ライセンスと由来

Sprout68k のソフトウェア全体は GNU GPL version 2 で公開する。ライセンス本文は
[`COPYING`](COPYING)を参照。IDE に同梱する px68k-libretro コアとホスト層も GPLv2
である。コアのビルド元は URARA-works の
[`px68k-libretro` emscripten ブランチ](https://github.com/uraraworks/px68k-libretro/tree/emscripten)、
上流は [`libretro/px68k-libretro`](https://github.com/libretro/px68k-libretro)であり、
対応するソースはこれらのリポジトリから入手できる。同梱バイナリとホスト層は
[`WebX68k`](https://github.com/uraraworks/WebX68k)から取り込んだ。コアの再ビルド
手順は同リポジトリの
[`scripts/build-core.sh`](https://github.com/uraraworks/WebX68k/blob/main/scripts/build-core.sh)にある。

IDE シェルは同じ作者 URARA-works の MIT ライセンス作品
[`WorkbenchNP2`](https://github.com/uraraworks/WorkbenchNP2)を基にしている。
CodeMirror も MIT ライセンスで、本文は
[`ide/vendor/codemirror/LICENSE.CodeMirror`](ide/vendor/codemirror/LICENSE.CodeMirror)にある。

## Issue・Pull Request・情報提供の前に

**判定基準は「エミュレータや実機で自分で測れば同じ結果が得られる種類の情報か」です。**
逆アセンブル結果や ROM の内部情報など、独立した実測では得られない情報は受け取らない。
該当する投稿は本文を読まずにクローズする。Issue、Pull Request、レビューコメント、
SNS の返信を送る前に、理由と受け入れ可能な情報をまとめた
[`CONTRIBUTING.md`](CONTRIBUTING.md)を必ず確認すること。

## 実装済みの主な機能

- ブート可能な `.xdf` 一式: 手組みのブートセクタ、C の crt0/IOCS スタブ、
  ネイティブ `m68k-elf-gcc` によるビルド経路。Stage A(文字列表示)、
  Stage B(単色塗り)、Stage C(ネイティブCプログラムの起動)、Stage D(ディスク
  全体までの複数トラック/サイド読み込み)を段階ごとに実測済み。
- 学習用ライブラリ第一版(L0、標準名の層、L1画面関数)と作例ブロック崩し。
- 同じ GCC/binutils ツールチェーンをブラウザ内 wasm 化したもの。Stage C /
  ブロック崩し双方でネイティブ版の生成物とバイト一致することを確認済み。
- WorkbenchNP2 を土台にした3ペインのブラウザ IDE(エディタ・ファイルツリー・
  px68k 実行画面): CodeMirror での C 編集、IndexedDB へのプロジェクト保存、
  利用者ソース1本のワンクリックビルド、日本語注釈付きコンパイラ/リンカ診断、
  `.xdf` ダウンロード、同一ページ内での px68k 実行。
- 遊んでもらう用・ソース共有用の2種類の共有リンク、整合性検証つき事前キャッシュに
  よるオフライン対応 Service Worker、AI エージェント向けの Node 単体 MCP サーバー。

## 未対応・既知の注意点

- m68kアセンブラのシンタックスハイライトと68kソース行デバッグは未実装。
- 実ブラウザでの確認は Chromium 系1種のみ。Safari / Firefox では未実測で、
  ブラウザ互換性を確認済みとはしていない。
