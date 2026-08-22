#!/usr/bin/env node
/* 共有リンクの受け取り側が持つランタイム配布物を作る。
 *
 *   deploy/runtime/v1/runtime.bin   ランタイム本体（ライブラリ全部入り）
 *   deploy/runtime/v1/boot.bin      ブートセクタ
 *   deploy/runtime/v1/share_v1.mts  URLの復号と .xdf の組み立て（送受信で共用する正典の写し）
 *   deploy/runtime/v1/manifest.json 大きさ・SHA-256・配置
 *
 * **受け取る側にコンパイラは要らない。** この2つのファイルと、URLから復元した
 * 利用者コードを tools/share_v1.mts で組み立てれば .xdf になる。
 *
 * **過去の版は消さないこと。** 共有リンクは永久に動く必要があり、URLに載った
 * 利用者コードはその版のジャンプテーブルの番地を直接呼んでいる。ABIを増やす
 * ときは v2 を作り、v1 はそのまま残す。
 *
 * ランタイムは利用者コードに依存しないので、ここでは中身の無い最小のソースで
 * ビルドして runtime.bin と boot.bin だけを取り出す。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder } from './driver/builder.mts';
import { NodeHostFs } from './driver/node_hostfs.mts';
import { createNodeToolExecutors } from './driver/node_runner.mts';
import { resolveNativeToolchain } from './driver/toolchain.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** ランタイムだけを取り出すための、何もしない最小のソース。 */
const PLACEHOLDER_SOURCE = '#include "x68.h"\n\nvoid main(void) {\n}\n';

export async function buildRuntimeRelease(root = ROOT): Promise<{
  runtime: Uint8Array; boot: Uint8Array; layout: Record<string, number>;
}> {
  const hostFs = new NodeHostFs();
  const layout = JSON.parse(readFileSync(resolve(root, 'runtime/generated/layout_v1.json'), 'utf8')) as Record<string, number>;
  const builder = new Builder({
    target: 'shared', output: resolve(root, 'build/runtime_release/out.xdf'), root, hostFs,
    tools: resolveNativeToolchain(),
    executors: createNodeToolExecutors({
      modes: { cc1: 'native', as: 'native', ld: 'native', objcopy: 'native' },
      hostFs, root, wasmModules: {}, memfsModules: {},
    }),
    userSource: { path: 'placeholder.c', content: PLACEHOLDER_SOURCE },
    sharedLayout: layout,
    buildRoot: resolve(root, 'build/runtime_release'),
  });
  const { runtime, boot } = await builder.buildShared();
  return { runtime, boot, layout };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { runtime, boot, layout } = await buildRuntimeRelease();
  const directory = resolve(ROOT, `deploy/runtime/v${layout.ABI_VERSION}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'runtime.bin'), runtime);
  writeFileSync(resolve(directory, 'boot.bin'), boot);
  /* 受け取り側は復号と組み立てにこれが要る。**送信側とまったく同じ正典を配る**
   * （受け取り側が自前で書くと、送信側と静かに食い違う）。 */
  const shareSource = readFileSync(resolve(ROOT, 'tools/share_v1.mts'));
  writeFileSync(resolve(directory, 'share_v1.mts'), shareSource);
  const manifest = {
    abiVersion: layout.ABI_VERSION,
    note: '共有リンクの受け取り側が持つランタイム。過去の版は消さないこと（古い共有リンクが動かなくなる）。',
    runtime: { size: runtime.length, sha256: sha256(runtime) },
    boot: { size: boot.length, sha256: sha256(boot) },
    share: { name: 'share_v1.mts', size: shareSource.length, sha256: sha256(shareSource) },
    layout,
  };
  writeFileSync(resolve(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`deploy/runtime/v${layout.ABI_VERSION}: runtime=${runtime.length}B boot=${boot.length}B`);
  console.log(`  runtime sha256=${manifest.runtime.sha256}`);
}
