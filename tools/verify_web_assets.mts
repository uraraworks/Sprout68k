#!/usr/bin/env node
/* 配信用資産が本体と一致しているかを見る。
 *
 * 【なぜ要るか(2026-08-23)】lib/asm/x68_panic.S の不具合を直したのに
 * build/web-assets を再生成し忘れ、**ブラウザ側だけが修正前のライブラリで
 * ビルドし続けていた**。Node の検証はすべて通る（あちらは本体を直接読む）ので、
 * 実機で作例を動かすまで誰も気づけなかった。deploy スナップショットに至っては
 * runtime/ 一式が丸ごと欠けていた。
 *
 * 「生成し忘れ」は必ず起きる。**気づける形にするのが対策**なので、
 * 本体と写しをバイト単位で突き合わせる。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** tools/build_web_assets.mts がコピーする対象。増やしたらここも増やす。 */
const COPIED_DIRECTORIES = ['stage_c', 'stage_d', 'lib', 'samples/breakout', 'runtime'] as const;
/** macOS が勝手に作るもの。本体にもコピーにも要らない。 */
const IGNORED = /(?:^|\/)\.DS_Store$/;

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (condition) console.log(`PASS: ${message}`);
  else { console.log(`FAIL: ${message}`); failures.push(message); }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function filesBelow(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) out.push(...filesBelow(path));
    else out.push(path);
  }
  return out;
}

export function compareAssets(base: string, root = ROOT): { same: number; stale: string[]; missing: string[] } {
  const assetRoot = resolve(root, base);
  const stale: string[] = [];
  const missing: string[] = [];
  let same = 0;
  for (const directory of COPIED_DIRECTORIES) {
    const source = resolve(root, directory);
    if (!existsSync(source)) continue;
    for (const file of filesBelow(source)) {
      const rel = relative(root, file).split(sep).join('/');
      if (IGNORED.test(rel)) continue;
      const copy = resolve(assetRoot, rel);
      if (!existsSync(copy)) { missing.push(rel); continue; }
      if (sha256(file) === sha256(copy)) same++;
      else stale.push(rel);
    }
  }
  return { same, stale, missing };
}

for (const base of ['build/web-assets', 'deploy/web-assets']) {
  if (!existsSync(resolve(ROOT, base))) {
    check(false, `${base} がありません（tools/build_web_assets.mts を通すこと）`);
    continue;
  }
  const { same, stale, missing } = compareAssets(base);
  for (const path of stale) console.log(`  古い: ${base}/${path}`);
  for (const path of missing) console.log(`  無い: ${base}/${path}`);
  check(stale.length === 0 && missing.length === 0,
    `${base} が本体と一致する (一致${same} / 古い${stale.length} / 欠け${missing.length})`);
}

/* 故障注入: 写しを1バイト変えたら検出できること。
 * 「一致した」だけを見て安心しないため、検査が実際に中身を見ていることを確かめる。 */
{
  const target = resolve(ROOT, 'build/web-assets/lib/asm/x68_panic.S');
  if (existsSync(target)) {
    const original = readFileSync(target);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(target, Buffer.concat([original, Buffer.from('\n')]));
    const injected = compareAssets('build/web-assets');
    writeFileSync(target, original);
    check(injected.stale.length === 1, `故障注入: 写しを1バイト変えると古いと分かる (検出${injected.stale.length}件)`);
    check(compareAssets('build/web-assets').stale.length === 0, '故障注入のあと元に戻っている');
  }
}

if (failures.length > 0) {
  console.log(`\n不合格 ${failures.length} 件`);
  process.exit(1);
}
console.log('\nすべて合格');
