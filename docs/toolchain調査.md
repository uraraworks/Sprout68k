# m68k クロス開発環境の正典調査

対象: elf2x68k(yunkya2)、xdev68k(yosshin4004)。両方とも GitHub 上のビルド定義
(シェルスクリプト・Makefile)を実際に読んで確定した。**推測は含まない。読めなかった
項目は「未確認」と明記する。**

## 参照したファイル(2026-08-19 時点、GitHub API 経由で取得)

- elf2x68k (branch: master)
  - `scripts/common.sh`(バージョン定義)
  - `scripts/download.sh`
  - `scripts/binutils.sh`
  - `scripts/gcc-stage1.sh`
  - `scripts/gcc-stage2.sh`
  - `scripts/newlib.sh`
  - `Makefile`
- xdev68k (branch: main)
  - `build_m68k-toolchain.sh`
  - `example/hello/makefile`
  - `example/mini_exe/makefile`

## gcc / binutils のバージョン

両プロジェクトとも**完全に同一**:

| 項目 | バージョン |
|---|---|
| binutils | **2.44** |
| gcc | **13.4.0** |
| newlib | 4.5.0.20241231 |
| gdb(elf2x68kのみ) | 16.3 |

xdev68k のコメントには「debian Trixie が使っているバージョンに合わせたいが、
msys 対応の都合で gcc を 14.2 → 13.4 に下げている」との記述がある(引用は要約)。
elf2x68k 側にも同様の「debian 系 stable に倣う」という記述がある。

**手元にインストールした Homebrew の m68k-elf-gcc は 16.2.0 / binutils 2.47** で、
両正典より新しい。段階2ではこの新しいバージョンを使っている(理由は後述)。

## configure オプション

### binutils(共通点)

両者とも:
```
--prefix=<install> --program-prefix=<prefix> --target=m68k-elf
--enable-lto --enable-multilib
```
elf2x68k はさらに `--with-system-zlib` を追加。`--program-prefix` は
elf2x68k が `m68k-xelf-`、xdev68k が `m68k-elf-`。

### gcc stage1(Cのみ、ライブラリなしブートストラップ、両者ほぼ同一)

```
--prefix=<install> --program-prefix=<prefix> --target=m68k-elf
--enable-lto --enable-languages=c
--without-headers
--with-arch=m68k --with-cpu=m68000
--with-newlib
--enable-multilib
--disable-nls --disable-shared --disable-threads
```
(elf2x68k はさらに `--with-system-zlib` を追加。xdev68k に `--disable-nls` は
明示、elf2x68k も同じ)

### newlib

xdev68k: `--prefix --target=m68k-elf` のみ(CFLAGS_FOR_TARGET="-O2" を環境変数で指定)。
elf2x68k: 通常版に加え `newlib-nano` 版を別途ビルドし、
`--enable-newlib-io-long-long --enable-newlib-io-c99-formats` を全体に指定、
nano 版はさらに `--enable-newlib-nano-malloc --enable-newlib-reent-small
--disable-newlib-wide-orient --enable-target-optspace
--disable-newlib-multithread --enable-newlib-nano-formatted-io` を追加。
elf2x68k は newlib に3本の独自パッチを当てている(`newlib-tz-jst.patch`
`newlib-memcpy-fix.patch` `newlib-mputype.patch`)。**68000でのmemcpyの不具合
修正パッチがある点は要注意**(コメントより。パッチ本体の内容までは未確認)。

### gcc stage2(本体、両者ほぼ同一)

```
--prefix --program-prefix --target=m68k-elf
--enable-lto --enable-languages=c,c++
--with-arch=m68k --with-cpu=m68000 --with-newlib
--enable-multilib
--disable-nls --disable-shared --disable-threads
```
コメントで明記されている理由: `--with-arch=m68k` を指定するのは
「ColdFire 用の libgcc バリエーションが大量に生成されることを回避するため」。

elf2x68k はさらに libstdc++ を縮小版(`-fno-rtti -fno-exceptions`、
`libstdc++small.a` として別名保存)と通常版の2種ビルドし、
`--with-pkgversion` `--with-bugurl` を付与。gcc 本体にも独自パッチ
(`gcc-x68k.patch`)を適用しているが内容は未確認。

## CPU / ABI 関連フラグ

- `-m68000`(CPU指定)は configure ではなく **コンパイル時オプション**として、
  両プロジェクトの `Makefile`(利用者側の example)で指定されている:
  `COMMON_FLAGS = -m$(CPU) -Os ...`
- **`-fcall-used-d2 -fcall-used-a2`** が両プロジェクトで共通して使われている。
  - elf2x68k: `scripts/common.sh` の `CFLAGS_FOR_TARGET` に指定(newlib/libgcc
    などライブラリ全体のビルド時)
  - xdev68k: `example/*/makefile` の `CFLAGS` に指定(ユーザーコードのビルド時)
  - **これは X68k のネイティブCコンパイラ「XC」との ABI 互換のためのフラグ**
    (d2, a2 レジスタを呼び出し元保存対象から外す)。**XC 由来のライブラリ
    (DOSLIB.L 等)や XC ABI のコードとリンクしない今回のベアメタル用途では、
    このフラグ自体は不要**と判断できる(自作 crt0 + 自作 IOCS スタブのみで
    完結するため、他の ABI と揃える理由がない)。
- `-fno-rtti -fno-exceptions` は libstdc++ の縮小ビルド固有(C++ を使わない
  今回は無関係)。
- newlib の `-mpu_type`/`-fpu_type` パッチや `newlib-memcpy-fix.patch` は
  **newlib(Cライブラリ)を使う場合の話**。今回は newlib を使わずベアメタル
  で completion するため無関係。

## ベアメタル向けに不要と判断した部分

1. **X68000 形式(.X)への変換一式** — 目的通り、ELF → `objcopy` で生バイナリ
   化すれば足りるため、elf2x68k の `elf2x68k.py`、xdev68k の HAS/HLK(X68k
   ネイティブのアセンブラ・リンカを `run68` エミュレータ経由で実行する仕組み)
   は不要。
2. **newlib 全体** — Cライブラリ関数(`malloc`, `printf` 等)は今回のテスト
   プログラムでは使わない。フリースタンディング(`-ffreestanding -nostdlib`)
   で完結させる。
3. **libstdc++ / C++ 関連ビルド** — C++ は使わない。
4. **gdb** — 実機デバッグ用。今回は px68k コアでの実測のみなので不要。
5. **XC ABI 互換フラグ(`-fcall-used-d2/a2`)** — 上記の通り、XC 由来のコード
   とリンクしないため不要。
6. **elf2x68k の `libx68k`(DOS/IOCS ラッパー郡)** — Human68k 経由の起動を
   前提にした一式(`_dosinit.c` 等)。今回はブートセクタから直接起動する
   ベアメタルなので不要。IOCS の TRAP #15 呼び出しは自前の小さなスタブで足りる。

## xdev68k で判明した重要な構造上の事実

xdev68k の Makefile を読むと、**gcc は `-S` でアセンブリ生成にのみ使われ、
実際のアセンブル・リンクは X68k ネイティブの `HAS060.X`(アセンブラ)/
`hlk301.x`(リンカ)を `run68`(Human68k バイナリを動かすためのエミュレータ)
経由で実行している**(`x68k_gas2has.pl` で GNU as 構文を HAS 構文に変換)。
つまり xdev68k は「gcc の ELF リンカ・objcopy」を使う構成ではない。
**今回のベアメタル実装(段階2)は elf2x68k 型(GNU binutils の ld/objcopy を
最後まで使う構成)を踏襲する方が単純で、xdev68k のような HAS/HLK/run68 経由の
変換は不要**と判断した。

## 未確認の項目

- elf2x68k の独自パッチ本体(`binutils-x68k.patch`, `gcc-x68k.patch`,
  `newlib-*.patch`)の**中身**(存在とファイル名・コメントの要約は確認したが、
  diff 本体までは読んでいない)
- newlib-memcpy-fix.patch が 68000 のどの不具合を修正しているかの技術的詳細
  (今回 newlib を使わないため実害はないが、将来 libc を足す場合は要確認)
- xdev68k の `install_xdev68k-utils.sh` の中身(未取得)
- gdb 16.3 の configure オプション(elf2x68k のみ対象。今回のスコープ外のため
  スクリプトの中身を取得していない)

## 段階2で採用した実際の構成(参考)

Homebrew の `m68k-elf-gcc`(16.2.0)/`m68k-elf-binutils`(2.47)の prebuilt を
使用。理由: 上記正典より新しいバージョンだが、`-m68000` マルチライブラリ
(`m68000;@mcpu=68000`)を prebuilt が保持していることを実機コマンド
(`m68k-elf-gcc -print-multi-lib`)で確認済みであり、ベアメタルの ELF 生成
(`-ffreestanding -nostdlib` + 自作 crt0/リンカスクリプト)には newlib や
XC ABI 互換フラグを必要としないため、正典と同一バージョンを自前ビルドする
コストを払う理由がないと判断した。configure 内容は
`m68k-elf-gcc -v` の `Configured with:` 出力で確認済み(Homebrew 側のビルド
定義そのものは未取得。バージョン差分があるためこの調査の「正典」には含めない)。
