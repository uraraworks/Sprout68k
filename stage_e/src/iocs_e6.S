/* Stage E-6 用の IOCS スタブ追加分。TRAP #15 を叩くだけ。
 *
 * void iocs_locate(int col, int row);
 *   D0=0x23, D1.L=col(呼び出し規約はD1.Wと手読みしているが、Cのintは32bitで
 *   符号拡張済みのためD1.Lをそのまま渡しても下位ワードの符号は一致する),
 *   D2.L=row
 *
 * D0=0x23(候補、B_LOCATE)は docs/StageE-6_実測_20260819.md に記載の通り、
 * datacrystal.tcrf.net の X68k/IOCS ページの記述を手読みした「候補」であり、
 * このファイルを書いた時点では実測未確認。実測結果は同ドキュメントに別途記録する。
 */
    .globl  iocs_locate
    .text
iocs_locate:
    /* D2 は m68k SVR4 ABI(gccの前提)で callee-saved。ここで D2 を退避せずに
     * 破壊すると呼び出し元のループ変数等を無言で壊す(実測で発見: 3件目以降の
     * マーカーが理由もなく消える症状として現れた)。 */
    move.l  %d2,-(%sp)
    move.l  8(%sp),%d1   /* col(第1引数。push でspが4進んだ分オフセットがずれる) */
    move.l  12(%sp),%d2  /* row(第2引数) */
    moveq   #0x23,%d0
    trap    #15
    move.l  (%sp)+,%d2
    rts
