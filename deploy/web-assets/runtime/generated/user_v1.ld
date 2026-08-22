/* 自動生成（tools/build_abi.mts）。手で編集しない。元は runtime/layout_v1.txt。
 * 利用者コードのリンカスクリプト。ライブラリ関数は abi_v1.ld によって
 * ランタイムのジャンプテーブルの絶対番地に解決されるので、利用者側の
 * 成果物にはライブラリ本体が入らない（これが共有URLに載る理由）。
 * 先頭は必ず .text.entry（runtime/user_entry.S）。
 */
INCLUDE abi_v1.ld

ENTRY(_user_entry)

SECTIONS
{
    . = 0x01000c;

    .text : {
        *(.text.entry)
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
