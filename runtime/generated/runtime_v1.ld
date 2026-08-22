/* 自動生成（tools/build_abi.mts）。手で編集しない。元は runtime/layout_v1.txt。
 * 共有ランタイム本体のリンカスクリプト。.bss(512KBの裏バッファ)は
 * 利用者領域の後ろ(RUNTIME_BSS_BASE)に置く。
 */
ENTRY(_abi_header)

SECTIONS
{
    . = 0x003000;

    .text : {
        *(.abi_header)
        *(.text*)
        *(.rodata*)
    }

    .data : {
        *(.data*)
    }

    __runtime_end = .;

    . = 0x060000;
    __bss_start = .;
    .bss (NOLOAD) : {
        *(.bss*)
        *(COMMON)
    }
    __bss_end = .;
}
