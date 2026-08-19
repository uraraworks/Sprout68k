/* Stage C 用リンカスクリプト。ロードアドレスは既存 Stage B と揃えて $3000 固定。
 * newlib 等は使わないのでヒープ管理セクションは無い。
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

    __bss_start = .;
    .bss (NOLOAD) : {
        *(.bss*)
        *(COMMON)
    }
    __bss_end = .;
}
