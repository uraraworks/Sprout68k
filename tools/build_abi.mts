#!/usr/bin/env node
/* ABI表(runtime/abi_v1.txt)とメモリ配置(runtime/layout_v1.txt)から、
 *   runtime/generated/jumptable_v1.S … ランタイムに埋めるジャンプテーブル
 *   runtime/generated/abi_v1.ld      … 利用者コードのリンクに渡す番地表
 * を作る。番地を手で数えると必ず間違えるので、両方を1つの表から出す。
 *
 * 生成物はコミットする（利用者コードの番地が版ごとに固定であることを
 * 差分で見えるようにするため）。最新かどうかは tools/verify_runtime.mts が
 * 再生成してバイト比較で確かめる。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 1エントリぶんの JMP xxx.L の長さ。 */
export const ABI_SLOT_SIZE = 6;

/** 利用者ペイロードのヘッダ長（マジック4＋版2＋予約2＋サイズ4）。 */
export const USER_HEADER_SIZE = 12;

export function readLayout(root = ROOT): Map<string, number> {
  const text = readFileSync(resolve(root, 'runtime/layout_v1.txt'), 'utf8');
  const layout = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(0x[0-9a-fA-F]+|\d+)$/.exec(line.trim());
    if (match) layout.set(match[1], Number(match[2]));
  }
  return layout;
}

export function readAbi(root = ROOT): string[] {
  const text = readFileSync(resolve(root, 'runtime/abi_v1.txt'), 'utf8');
  return text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function abiAddress(layout: Map<string, number>, index: number): number {
  return layout.get('ABI_TABLE_BASE')! + ABI_SLOT_SIZE * index;
}

function hex(value: number): string {
  return `0x${value.toString(16).padStart(6, '0')}`;
}

export function renderJumpTable(names: string[], layout: Map<string, number>): string {
  const lines = [
    '/* 自動生成（tools/build_abi.mts）。手で編集しない。',
    ' * 元は runtime/abi_v1.txt と runtime/layout_v1.txt。',
    ' *',
    ' * ランタイム本体の先頭に置く。並びがそのまま公開ABIなので、',
    ' * 既存の行を動かすと過去に共有されたリンクが全部壊れる。',
    ' */',
    '    .section .abi_header,"ax"',
    '    .globl  _abi_header',
    '_abi_header:',
    `    bra.w   runtime_start           /* ${hex(layout.get('RUNTIME_BASE')!)} 起動時にブートセクタが飛んでくる */`,
    `    .word   ${layout.get('ABI_VERSION')}                       /* ${hex(layout.get('RUNTIME_BASE')! + 4)} ABI版 */`,
    `    .word   0                       /* ${hex(layout.get('RUNTIME_BASE')! + 6)} 予約 */`,
    `                                    /* ${hex(layout.get('ABI_TABLE_BASE')!)} ここからジャンプテーブル */`,
  ];
  names.forEach((name, index) => {
    lines.push(`    jmp     ${name}${' '.repeat(Math.max(1, 24 - name.length))}/* ${hex(abiAddress(layout, index))} [${index}] */`);
  });
  return `${lines.join('\n')}\n`;
}

export function renderAbiLinkerScript(names: string[], layout: Map<string, number>): string {
  const lines = [
    '/* 自動生成（tools/build_abi.mts）。手で編集しない。',
    ' * 利用者コードのリンク時に INCLUDE する。ライブラリ関数の呼び出しを',
    ' * ランタイムのジャンプテーブルの絶対番地へ解決するためのもの。',
    ' * これがあるので利用者コードにライブラリ本体が入らない（＝URLに載る）。',
    ' */',
  ];
  names.forEach((name, index) => {
    lines.push(`PROVIDE(${name} = ${hex(abiAddress(layout, index))});`);
  });
  return `${lines.join('\n')}\n`;
}


export function renderRuntimeLinkerScript(layout: Map<string, number>): string {
  return `/* 自動生成（tools/build_abi.mts）。手で編集しない。元は runtime/layout_v1.txt。
 * 共有ランタイム本体のリンカスクリプト。.bss(512KBの裏バッファ)は
 * 利用者領域の後ろ(RUNTIME_BSS_BASE)に置く。
 */
ENTRY(_abi_header)

SECTIONS
{
    . = ${hex(layout.get('RUNTIME_BASE')!)};

    .text : {
        *(.abi_header)
        *(.text*)
        *(.rodata*)
    }

    .data : {
        *(.data*)
    }

    __runtime_end = .;

    . = ${hex(layout.get('RUNTIME_BSS_BASE')!)};
    __bss_start = .;
    .bss (NOLOAD) : {
        *(.bss*)
        *(COMMON)
    }
    __bss_end = .;
}
`;
}

export function renderUserLinkerScript(layout: Map<string, number>): string {
  const bodyBase = layout.get('USER_BASE')! + USER_HEADER_SIZE;
  return `/* 自動生成（tools/build_abi.mts）。手で編集しない。元は runtime/layout_v1.txt。
 * 利用者コードのリンカスクリプト。ライブラリ関数は abi_v1.ld によって
 * ランタイムのジャンプテーブルの絶対番地に解決されるので、利用者側の
 * 成果物にはライブラリ本体が入らない（これが共有URLに載る理由）。
 * 先頭は必ず .text.entry（runtime/user_entry.S）。
 */
INCLUDE abi_v1.ld

ENTRY(_user_entry)

SECTIONS
{
    . = ${hex(bodyBase)};

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
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const layout = readLayout();
  const names = readAbi();
  mkdirSync(resolve(ROOT, 'runtime/generated'), { recursive: true });
  writeFileSync(resolve(ROOT, 'runtime/generated/jumptable_v1.S'), renderJumpTable(names, layout));
  writeFileSync(resolve(ROOT, 'runtime/generated/abi_v1.ld'), renderAbiLinkerScript(names, layout));
  writeFileSync(resolve(ROOT, 'runtime/generated/runtime_v1.ld'), renderRuntimeLinkerScript(layout));
  writeFileSync(resolve(ROOT, 'runtime/generated/user_v1.ld'), renderUserLinkerScript(layout));
  /* ブラウザ側のビルド経路も同じ配置を使う。layout_v1.txt を二重に書き写さず、
   * import できる形にして配る（値を持つ場所は layout_v1.txt ひとつだけにする）。 */
  writeFileSync(resolve(ROOT, 'runtime/generated/layout_v1.json'),
    `${JSON.stringify(Object.fromEntries(layout), null, 2)}\n`);
  const last = abiAddress(layout, names.length - 1);
  console.log(`ABI v${layout.get('ABI_VERSION')}: ${names.length} 関数, ${hex(layout.get('ABI_TABLE_BASE')!)}〜${hex(last)} (末尾+6=${hex(last + ABI_SLOT_SIZE)})`);
}
