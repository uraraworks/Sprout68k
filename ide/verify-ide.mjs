#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const forbidden = ['pc' + '98', 'n' + 'p2', 'pc' + '-98', 'free' + 'dos', 'na' + 'sm', 'smaller' + 'c', '98' + '01', '98' + '21'];
const required = [
  'index.html', 'workbench.css', 'workbench.js', 'project-fs.mjs', 'source-view.mjs',
  'sample-manifest.mjs', 'x68k-adapter.mjs', 'samples/hello.c',
  'px68k-runtime.ts', 'px68k/libretro-host.ts', 'px68k/text-screen.ts',
  'core/px68k_libretro.js', 'core/px68k_libretro.wasm',
  'system/iplrom.dat', 'system/cgrom.dat',
  'system/IPLROM-LICENSE.txt', 'system/CGROM-NOTICE.md',
  '../web/browser-toolchain.ts', '../tools/driver/builder.mts',
  '../verify/verify_ide_boot.mts', '../COPYING', '../README.md',
  'vendor/codemirror/codemirror.js', 'vendor/codemirror/LICENSE.CodeMirror',
];

const coreFiles = [
  ['core/px68k_libretro.js', 73_762, '3fe2b9108361c2d28a8ca70b21313cad863a4db561bf3b2e857d4de01a58f7c2'],
  ['core/px68k_libretro.wasm', 638_990, '6ea7ea24f83ec19be69d16d19126b3a62c4e7a0d343395234506a6dbc03d4bb7'],
];

async function filesBelow(directory, relative = '') {
  const results = [];
  for (const name of await readdir(directory)) {
    const child = resolve(directory, name);
    const childRelative = relative ? `${relative}/${name}` : name;
    if ((await stat(child)).isDirectory()) results.push(...await filesBelow(child, childRelative));
    else results.push(childRelative);
  }
  return results;
}

for (const file of required) await stat(resolve(root, file));

for (const [file, expectedSize, expectedSha256] of coreFiles) {
  const bytes = await readFile(resolve(root, file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== expectedSize || sha256 !== expectedSha256) {
    throw new Error(`同梱コアが正典と一致しません: ${file}`);
  }
}

const html = await readFile(resolve(root, 'index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="(\.\/[^"?#]+)"/g)) {
  await stat(resolve(root, match[1]));
}

const allFiles = await filesBelow(root);
for (const file of allFiles) {
  const text = await readFile(resolve(root, file), 'utf8').catch(() => null);
  if (text === null) continue;
  const lower = text.toLowerCase();
  for (const token of forbidden) {
    if (lower.includes(token)) throw new Error(`禁止識別子を検出: ${file}`);
  }
}

const fsSource = await readFile(resolve(root, 'project-fs.mjs'), 'utf8');
if (!fsSource.includes("databaseName = 'X68kDevProjectFS'")) throw new Error('専用 DB 名がありません');
const workbench = await readFile(resolve(root, 'workbench.js'), 'utf8');
if (!workbench.includes('window.x68kdevWorkbench')) throw new Error('公開 API 名がありません');
if (!workbench.includes('cpp()')) throw new Error('C 言語ハイライトがありません');
for (const id of ['build-output', 'download-xdf', 'run', 'machine-status', 'x68k-screen']) {
  if (!html.includes(`id="${id}"`)) throw new Error(`必要な DOM 要素がありません: ${id}`);
  if (!workbench.includes(`#${id}`)) throw new Error(`DOM 要素の参照がありません: ${id}`);
}
const adapterSource = await readFile(resolve(root, 'x68k-adapter.mjs'), 'utf8');
if (!adapterSource.includes('../web/browser-toolchain.ts')) throw new Error('共有ブラウザツールチェーン参照がありません');
if (!adapterSource.includes("./px68k-runtime.ts") || !adapterSource.includes('runtime.runXdf(xdf)')) {
  throw new Error('px68k 実行アダプタ参照がありません');
}
const runtimeSource = await readFile(resolve(root, 'px68k-runtime.ts'), 'utf8');
for (const member of ['window.x68kdevEmulatorProbe', 'readTextScreen', 'getFrameCount', 'getState']) {
  if (!runtimeSource.includes(member)) throw new Error(`ブラウザプローブがありません: ${member}`);
}
for (const reference of ['../COPYING', './system/IPLROM-LICENSE.txt', './system/CGROM-NOTICE.md']) {
  if (!html.includes(`href="${reference}"`)) throw new Error(`ライセンス参照がありません: ${reference}`);
}
for (const reference of ['../COPYING?url', './vendor/codemirror/LICENSE.CodeMirror?url', './system/IPLROM-LICENSE.txt?url', './system/CGROM-NOTICE.md?url']) {
  if (!workbench.includes(reference)) throw new Error(`配布物のライセンス資産参照がありません: ${reference}`);
}
const copying = await readFile(resolve(root, '../COPYING'), 'utf8');
if (!copying.includes('GNU GENERAL PUBLIC LICENSE') || !copying.includes('Version 2, June 1991')) {
  throw new Error('COPYING が GPLv2 本文ではありません');
}
const readme = await readFile(resolve(root, '../README.md'), 'utf8');
for (const attribution of ['px68k-libretro', 'Workbench' + 'N' + 'P2', 'CodeMirror', 'GPL version 2']) {
  if (!readme.includes(attribution)) throw new Error(`README の帰属がありません: ${attribution}`);
}
if (!html.includes('./samples/hello.c') && !(await readFile(resolve(root, 'sample-manifest.mjs'), 'utf8')).includes('./samples/hello.c')) {
  throw new Error('C サンプル参照がありません');
}

console.log(`verify-ide: PASS (${required.length} required files, ${allFiles.length} files scanned)`);
