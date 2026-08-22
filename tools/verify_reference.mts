#!/usr/bin/env node
/* 関数リファレンス(ide/reference.html)の検証。
 *
 * 見るのは4点:
 *   1. ide/api/reference.json の項目が lib/include/x68.h の公開宣言と過不足なく一致する
 *   2. 各項目の signature が x68.h の宣言そのものと一致する
 *   3. すべての例(図鑑の example と 読み物の <pre class="listing">)が本物の
 *      m68k-elf-gcc でコンパイルできる
 *   4. コミットしてある ide/reference.html が、いまの入力から生成したものと一致する
 * どれも故障注入つきで、検査自身が動いていることを確かめてから合格を出す。
 *
 * ツールチェーンが無い場合は SKIP せず失敗させる(飛ばした検査は合格と
 * 見分けが付かないため)。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ROOT, exampleProgram, loadReference, renderReference } from './build_reference.mts';
import type { ReferenceDocument, ReferenceEntry } from './build_reference.mts';

const CC = process.env.M68K_GCC ?? `${process.env.HOME}/x68kdev-toolchain/bin/m68k-elf-gcc`;
const CFLAGS = [
  '-m68000', '-Os', '-ffreestanding', '-nostdlib', '-fomit-frame-pointer', '-fno-builtin',
  '-Wall', '-Werror', '-I', resolve(ROOT, 'lib/include'), '-c',
];

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (condition) console.log(`PASS: ${message}`);
  else { console.log(`FAIL: ${message}`); failures.push(message); }
}

/* ---- 1/2. x68.h の公開宣言を読む ---------------------------------- */

interface Declaration { name: string; signature: string }

function parseHeader(): { functions: Map<string, Declaration>; macros: Set<string> } {
  const header = readFileSync(resolve(ROOT, 'lib/include/x68.h'), 'utf8');
  /* コメントを外してから宣言だけを見る(コメント中の関数名に釣られないため) */
  const code = header.replace(/\/\*[\s\S]*?\*\//g, '');
  const functions = new Map<string, Declaration>();
  for (const match of code.matchAll(/^((?:const\s+)?(?:unsigned\s+|signed\s+)?[a-z_][a-z0-9_]*\s+\*?)([a-z_][a-z0-9_]*)\s*\(([^;]*)\)\s*;/gmi)) {
    const [, returnType, name, parameters] = match;
    const signature = `${returnType.trim()}${returnType.trimEnd().endsWith('*') ? '' : ' '}${name}(${parameters.replace(/\s+/g, ' ').trim()})`;
    functions.set(name, { name, signature: signature.replace(/\s*\*\s*/g, ' *').replace(/ +/g, ' ') });
  }
  const macros = new Set<string>();
  /* X68_H はインクルードガードで API ではない。 */
  for (const match of code.matchAll(/^#define\s+(X68_[A-Z0-9_]+)/gm)) {
    if (match[1] !== 'X68_H') macros.add(match[1]);
  }
  return { functions, macros };
}

function normalizeSignature(signature: string): string {
  return signature.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*\*\s*/g, ' *').replace(/\s+/g, ' ').trim();
}

function matchesGlob(name: string, pattern: string): boolean {
  return new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name);
}

function verifyCoverage(document_: ReferenceDocument, header: ReturnType<typeof parseHeader>): void {
  const entryNames = new Set(document_.entries.map((entry) => entry.name));
  const covers = document_.entries.flatMap((entry) => (entry as ReferenceEntry & { covers?: string[] }).covers ?? []);

  const missingFunctions = [...header.functions.keys()].filter((name) => !entryNames.has(name));
  check(missingFunctions.length === 0, `x68.h の全関数が図鑑にある (不足: ${missingFunctions.join(', ') || 'なし'})`);

  const missingMacros = [...header.macros].filter((name) => (
    !entryNames.has(name) && !covers.some((pattern) => matchesGlob(name, pattern))
  ));
  check(missingMacros.length === 0, `x68.h の全マクロが図鑑にある (不足: ${missingMacros.join(', ') || 'なし'})`);

  const strays = document_.entries.filter((entry) => (
    !header.functions.has(entry.name) && !header.macros.has(entry.name)
  ));
  check(strays.length === 0, `x68.h に無い項目が figure に紛れていない (余分: ${strays.map((entry) => entry.name).join(', ') || 'なし'})`);

  const mismatched = document_.entries.filter((entry) => {
    const declaration = header.functions.get(entry.name);
    if (!declaration) return false;
    return normalizeSignature(declaration.signature) !== normalizeSignature(entry.signature);
  });
  for (const entry of mismatched) {
    console.log(`  ${entry.name}: json="${normalizeSignature(entry.signature)}" header="${normalizeSignature(header.functions.get(entry.name)!.signature)}"`);
  }
  check(mismatched.length === 0, `signature が x68.h の宣言と一致する (不一致: ${mismatched.length}件)`);
}

/* ---- 3. 例のコンパイル -------------------------------------------- */

interface Sample { label: string; source: string }

function guideSamples(document_: ReferenceDocument): Sample[] {
  const guide = readFileSync(resolve(ROOT, 'tools/reference/guide.html'), 'utf8');
  const samples: Sample[] = [];
  let index = 0;
  for (const match of guide.matchAll(/<pre class="listing"([^>]*)>([\s\S]*?)<\/pre>/g)) {
    const full = match[1].includes('data-full="true"');
    const code = match[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    const { head, tail, indent } = document_.wrapper;
    const body = code.split('\n').map((line) => (line.length === 0 ? '' : indent + line)).join('\n');
    samples.push({ label: `guide#${++index}`, source: full ? `${code}\n` : `${head}${body}\n${tail}` });
  }
  return samples;
}

function compile(sample: Sample, directory: string): string | null {
  const source = resolve(directory, 'sample.c');
  writeFileSync(source, sample.source);
  try {
    execFileSync(CC, [...CFLAGS, source, '-o', resolve(directory, 'sample.o')], { stdio: 'pipe' });
    return null;
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
    return stderr.trim().split('\n').slice(0, 4).join('\n');
  }
}

function verifyExamples(document_: ReferenceDocument): Sample[] {
  const samples: Sample[] = [
    ...document_.entries.map((entry) => ({ label: entry.name, source: exampleProgram(document_, entry) })),
    ...guideSamples(document_),
  ];
  try {
    execFileSync(CC, ['--version'], { stdio: 'pipe' });
  } catch {
    check(false, `m68k-elf-gcc が見つからない (${CC})。例のコンパイル検査を実行できないため不合格とする`);
    return samples;
  }
  const directory = mkdtempSync(resolve(tmpdir(), 'sprout68k-ref-'));
  try {
    const broken: string[] = [];
    for (const sample of samples) {
      const error = compile(sample, directory);
      if (error) { broken.push(sample.label); console.log(`  ${sample.label}:\n${error}`); }
    }
    check(broken.length === 0, `例 ${samples.length} 本すべてがコンパイルできる (失敗: ${broken.join(', ') || 'なし'})`);

    /* 故障注入: 存在しない関数を呼ぶ例を1本混ぜると検出できるか */
    const injected = compile({ label: 'fault', source: '#include "x68.h"\n\nvoid main(void) {\n  x68_no_such_function(1);\n}\n' }, directory);
    check(injected !== null, '故障注入: 存在しない関数を呼ぶ例はコンパイル検査で落ちる');

    /* 故障注入: 引数の数を間違えた例も落ちるか(宣言が効いていることの確認) */
    const wrongArity = compile({ label: 'fault2', source: '#include "x68.h"\n\nvoid main(void) {\n  x68_pset(1, 2);\n}\n' }, directory);
    check(wrongArity !== null, '故障注入: 引数の数を間違えた例はコンパイル検査で落ちる');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return samples;
}

/* ---- 4. 生成物が最新か -------------------------------------------- */

function verifyGenerated(): void {
  const committed = readFileSync(resolve(ROOT, 'ide/reference.html'), 'utf8');
  check(committed === renderReference(), 'ide/reference.html が入力から生成したものと一致する');
}

/* ---- 実行 ---------------------------------------------------------- */

const document_ = loadReference();
const header = parseHeader();
console.log(`x68.h: 関数 ${header.functions.size} 件 / マクロ ${header.macros.size} 件、図鑑: ${document_.entries.length} 件`);

verifyCoverage(document_, header);
verifyExamples(document_);
verifyGenerated();

/* 故障注入: 検査自身が動いていることを確かめる ---------------------- */
const injectedDocument = JSON.parse(JSON.stringify(document_)) as ReferenceDocument;
injectedDocument.entries = injectedDocument.entries.filter((entry) => entry.name !== 'x68_pset');
const before = failures.length;
verifyCoverage(injectedDocument, header);
check(failures.length > before, '故障注入: 図鑑から1項目消すと不足として検出される');
failures.length = before;

const shifted = JSON.parse(JSON.stringify(document_)) as ReferenceDocument;
shifted.entries.find((entry) => entry.name === 'x68_line')!.signature = 'void x68_line(int x1, int y1, int x2, int y2)';
const before2 = failures.length;
verifyCoverage(shifted, header);
check(failures.length > before2, '故障注入: signature をずらすと不一致として検出される');
failures.length = before2;

if (failures.length > 0) {
  console.log(`\n不合格 ${failures.length} 件`);
  process.exit(1);
}
console.log('\nすべて合格');
