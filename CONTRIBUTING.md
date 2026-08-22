# Sprout68k への情報提供・寄稿について

Issue、Pull Request、レビューコメント、SNS の返信などで Sprout68k に情報を寄せる前に、この方針を確認してください。

## 判定基準

> **エミュレータや実機で自分で測れば同じ結果が得られる種類の情報か。**

この基準を満たし、測定方法と再現手順から第三者が裏を取れる事実は歓迎します。測定ではなく、他人の解析結果や非公開情報を読むことでしか得られない情報は受け取りません。

## 受け取らないもの

- 逆アセンブルリスト、逆コンパイル結果、それらから引き写した番地・定数・処理手順。独立した測定ではなく、第三者の解析物に由来するためです。
- 実機 ROM、Human68k、市販ソフトのバイト列そのもの、およびそれらの内部構造の解析結果。著作物そのものや、その解析によってのみ得られる情報を受け取らないためです。
- 非公開の内部資料、当事者から個人的に得た未公開情報。公開された出典や再現可能な測定で第三者が確認できないためです。
- 第三者の著作物を含むディスクイメージ、サンプルプログラム、データ。権利関係を確認できず、リポジトリへ安全に取り込めないためです。

上記に該当する投稿は、**本文を読まずにクローズします**。読んだ時点で情報経路を分離できなくなり、手遅れになるためです。これは、送った方の善意を疑ったり、落ち度があると判断したりする措置ではありません。プロジェクトを独立した実測と公開資料だけで開発できる状態に保つための手続きです。

## 歓迎するもの

- 再現手順つきの不具合報告。何をしたら何が起きたかに加え、エミュレータの名前とバージョン、ブラウザとバージョン、OS も書いてください。
- 自分で測った実測データ。使用した実機またはエミュレータ、測定条件、手順、観測結果を書いてください。
- 公開されている資料に基づく指摘。資料名、URL、版、該当箇所など、確認できる出典を書いてください。
- 自分で書いたコード。次の Pull Request の条件を満たしてください。

## Pull Request の条件

- 提案するコードとデータは自分で作成したものであり、受け取らない情報や第三者の著作物を含めないでください。
- Sprout68k 全体は、px68k-libretro を含むため GNU GPL version 2（GPLv2）です。寄稿も GPLv2 の条件で受け取り、GPLv2 と両立する必要があります。
- 変更理由、確認方法、実行した検証を書いてください。
- 取り込み時は squash や rebase を行いません。PR の各コミットを同じハッシュのまま履歴に残す形で取り込み、貢献の記録を保持します。

## English summary

**One-line test: Could another person obtain the same kind of information by measuring it on an emulator or real hardware?** Reproducible observations, documented measurements, and corrections based on public sources are welcome. Please include methods, conditions, results, and citations.

We cannot accept disassembly or decompilation output; addresses, constants, or procedures copied from such output; ROM, Human68k, or commercial-software bytes or internal-structure analysis; non-public insider material; or disk images, samples, and data containing third-party copyrighted works. A submission containing such material will be closed **without reading its body**, because reading it would already compromise the separation of information sources. This is a project-safety procedure, not a judgment that the sender acted in bad faith or did something wrong.

PRs must contain code and data created by the contributor and compatible with GNU GPL version 2. Contributions are accepted under GPLv2. Accepted PRs will be integrated without squash or rebase so that every contributed commit remains in history with the same hash.
