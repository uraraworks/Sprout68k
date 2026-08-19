/* Stage D 用リンカスクリプト。ロードアドレスは Stage C と同じ $3000。
 * .pattern セクションを明示的に最後尾に配置する(自己故障注入で「1セクタ
 * 少なく読む」テストをしたとき、欠けるのが必ずパターン配列の末尾になるように
 * するため)。crt0(スタック設定+BSSクリア)/IOCSスタブは stage_c のものを共用する。
 */
ENTRY(_start)

SECTIONS
{
    . = 0x3000;

    .text : {
        *(.text*)
        *(.rodata*)
    }

    .data : {
        *(.data*)
    }

    /* パターン配列(既知のバイト列+末尾4バイトの番兵)。必ず最後尾。 */
    .pattern : {
        *(.pattern)
    }

    __bss_start = .;
    .bss (NOLOAD) : {
        *(.bss*)
        *(COMMON)
    }
    __bss_end = .;
}
