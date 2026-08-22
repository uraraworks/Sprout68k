#!/usr/bin/env node
/*
 * 関数リファレンスに載せた例を、**実際に X68000 で走らせる**検証。
 *
 * 【なぜ要るか(2026-08-23)】これまでの検査は「例がコンパイルできること」
 * だけを見ていた。ところが x68_panic_install が呼び出し元の a2/a3 を壊す
 * 不具合があり、**コンパイルは通るのに実行すると画面が壊れる例**が
 * リファレンスに載っていた（x68_rgb / x68_pget の例、guide の2箇所）。
 * 「コンパイルできる」は「読者が写して動く」の証明にならない。
 *
 * 見るもの:
 *   1. どの例もパニック画面(「プログラムを停止します」)を出さない
 *   2. **絵を描く例は、実際に画素が描かれている**
 *      （「落ちない」だけだと、何も描かない例が完璧に満たしてしまう）
 * 陽性対照として、わざと落ちる例と何も描かない例を混ぜ、どちらも
 * 検出できることを確かめる。
 *
 * 使い方: npx tsx verify/verify_reference_run.mts
 * 前提: 正典のツールチェーン(gcc 13.4.0)が PATH にあること。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSource, checkToolchain } from '../tools/build_for_mcp.mts';
import { runXdf } from '../tools/px68k_host.mts';
import { exampleProgram, loadReference } from '../tools/build_reference.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PANIC_TEXT = 'プログラムを停止します';
/* 例は短く、無限ループのものも含む。描画が1周するのに十分なだけ回す。 */
const FRAMES = 600;

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (condition) console.log(`PASS: ${message}`);
  else { console.log(`FAIL: ${message}`); failures.push(message); }
}

interface Sample { label: string; source: string; expectsDrawing: boolean }

/** 絵を描く例か（描画関数を呼び、画面へ出しているか）。 */
function expectsDrawing(code: string): boolean {
  const draws = /x68_(pset|line|box|box_fill|circle|cls)\s*\(/.test(code);
  return draws && /x68_screen_flip\s*\(/.test(code);
}

function collect(): Sample[] {
  const document_ = loadReference(ROOT);
  const samples: Sample[] = document_.entries.map((entry) => ({
    label: entry.name,
    source: exampleProgram(document_, entry),
    expectsDrawing: expectsDrawing(entry.example.code),
  }));
  const guide = readFileSync(resolve(ROOT, 'tools/reference/guide.html'), 'utf8');
  let index = 0;
  for (const match of guide.matchAll(/<pre class="listing"([^>]*)>([\s\S]*?)<\/pre>/g)) {
    const full = match[1].includes('data-full="true"');
    const code = match[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    const { head, tail, indent } = document_.wrapper;
    const body = code.split('\n').map((line) => (line.length === 0 ? '' : indent + line)).join('\n');
    samples.push({
      label: `guide#${++index}`,
      source: full ? `${code}\n` : `${head}${body}\n${tail}`,
      expectsDrawing: expectsDrawing(code),
    });
  }
  return samples;
}

async function runOne(sample: Sample): Promise<{ panicked: boolean; drawn: number; text: string[]; built: boolean }> {
  const built = await buildSource(sample.source, { path: 'example.c' });
  if (!built.ok) return { panicked: false, drawn: 0, text: built.diagnostics, built: false };
  const result = await runXdf({ root: ROOT, xdf: built.xdf!, frames: FRAMES });
  return {
    panicked: result.text.some((line) => line.includes(PANIC_TEXT)),
    drawn: result.drawnPixels, text: result.text, built: true,
  };
}

console.log(`ツールチェーン: gcc ${checkToolchain()}`);
const samples = collect();
console.log(`例 ${samples.length} 本を実行する（うち絵を描く例 ${samples.filter((s) => s.expectsDrawing).length} 本）`);

const broken: string[] = [];
const blank: string[] = [];
for (const sample of samples) {
  const outcome = await runOne(sample);
  if (!outcome.built) { broken.push(`${sample.label}(ビルド失敗)`); continue; }
  if (outcome.panicked) { broken.push(`${sample.label}(${outcome.text.join(' / ')})`); continue; }
  if (sample.expectsDrawing && outcome.drawn === 0) blank.push(sample.label);
}
check(broken.length === 0, `どの例もパニックせずに動く (問題: ${broken.join(', ') || 'なし'})`);
check(blank.length === 0, `絵を描く例が実際に描いている (描いていない: ${blank.join(', ') || 'なし'})`);

/* 陽性対照。これが検出できなければ、上の合格は何も見ていない。 */
const panicSample = await runOne({
  label: 'fault:panic', expectsDrawing: false,
  source: '#include "x68.h"\n\nvoid main(void) {\n  x68_screen_open();\n  ((void (*)(void))1)();\n}\n',
});
check(panicSample.panicked, `故障注入: わざと落ちる例をパニックとして検出する (${panicSample.text.join(' / ') || '検出できず'})`);

const blankSample = await runOne({
  label: 'fault:blank', expectsDrawing: true,
  source: '#include "x68.h"\n\nvoid main(void) {\n  x68_screen_open();\n  x68_cls(x68_rgb(0, 0, 0));\n  x68_screen_flip();\n}\n',
});
check(blankSample.drawn === 0, '故障注入: 何も描かない例は描画0として見分けられる');

if (failures.length > 0) {
  console.log(`\n不合格 ${failures.length} 件`);
  process.exit(1);
}
console.log('\nすべて合格');
