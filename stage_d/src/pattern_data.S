/* 既知パターン配列(+末尾4バイトの番兵)を .pattern セクションへ丸ごと取り込む。
 * 実体は tools/gen_pattern.py がビルド時に生成する pattern.bin(カレントディレクトリ、
 * ビルドスクリプトが cd してから assemble する)。
 */
    .section .pattern, "a", @progbits
    .globl pattern_data
pattern_data:
    .incbin "pattern.bin"
    .globl pattern_data_end
pattern_data_end:
