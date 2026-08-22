#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const forbidden = ['pc' + '98', 'n' + 'p2', 'pc' + '-98', 'free' + 'dos', 'na' + 'sm', 'smaller' + 'c', '98' + '01', '98' + '21'];
const required = [
  'index.html', 'workbench.css', 'workbench.js', 'project-fs.mjs', 'source-view.mjs',
  'sample-manifest.mjs', 'x68k-adapter.mjs', 'samples/hello.c', 'samples/keyboard-input.c',
  'recovery-controller.mjs',
  'px68k-runtime.ts', 'px68k/libretro-host.ts', 'px68k/text-screen.ts',
  'px68k/keyboard.ts', 'px68k/key-repeat.ts', 'px68k/keyboard-input.ts',
  'core/px68k_libretro.js', 'core/px68k_libretro.wasm',
  'system/iplrom.dat', 'system/cgrom.dat',
  'system/IPLROM-LICENSE.txt', 'system/CGROM-NOTICE.md',
  '../web/browser-toolchain.ts', '../tools/driver/builder.mts', '../tools/driver/diagnostics.mts',
  '../tools/driver/diagnostic_annotations.mts', '../tools/driver/verify_diagnostic_annotations.mts',
  '../verify/verify_ide_boot.mts', '../verify/verify_ide_recovery.mts',
  '../verify/verify_ide_keyboard.mts',
  '../docs/IDEキーボード入力_20260822.md', '../lib/include/x68.h', '../COPYING', '../README.md',
  '../tools/distribution.mts',
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
const css = await readFile(resolve(root, 'workbench.css'), 'utf8');
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
for (const id of ['build-output', 'download-xdf', 'run', 'stop-emulator', 'recover-emulator', 'machine-status', 'keyboard-status', 'x68k-screen', 'build-id', 'offline-status']) {
  if (!html.includes(`id="${id}"`)) throw new Error(`必要な DOM 要素がありません: ${id}`);
  if (!workbench.includes(`#${id}`)) throw new Error(`DOM 要素の参照がありません: ${id}`);
}
for (const contract of [
  "const X68KDEV_SCOPE_PATH = '/X68kDev/'",
  'scope: X68KDEV_SCOPE_PATH',
  "updateViaCache: 'none'",
  'build: ${__BUILD_ID__}',
  "'オフラインでも使えます'",
  "'オフライン準備に失敗しました'",
  "type: 'X68KDEV_CHECK_CACHE'",
]) {
  if (!workbench.includes(contract)) throw new Error(`配布UI契約がありません: ${contract}`);
}
const recoverySource = await readFile(resolve(root, 'recovery-controller.mjs'), 'utf8');
for (const contract of ['rememberSuccessfulBuild', 'buildFallback', 'captureSource', '復帰中に編集中のソースが変化しました']) {
  if (!recoverySource.includes(contract)) throw new Error(`復帰のソース保持契約がありません: ${contract}`);
}
for (const forbiddenMutation of ['editor.dispatch', 'projectFS.write', '.savedText =']) {
  if (recoverySource.includes(forbiddenMutation)) throw new Error(`復帰境界にソース変更処理があります: ${forbiddenMutation}`);
}
if (!workbench.includes('recoveryController.rememberSuccessfulBuild(result)')
    || !workbench.includes('recoverEmulator') || !workbench.includes('stopEmulator')) {
  throw new Error('成功XDFの保持または復帰UI結線がありません');
}

// ヘッダーは文書先頭にあり、復帰ボタンの縦位置は通常フローの固定寸法から算出できる。
// padding 10 + title 28 + tagline margin 2 + line 14 + actions margin 6 = top 60px。
for (const cssRule of [
  '.app-header { padding: var(--recovery-header-padding) 16px',
  '.app-tagline { margin: var(--recovery-tagline-margin) 0 0',
  'line-height: var(--recovery-tagline-height)',
  '.app-recovery-actions { height: var(--recovery-control-height); margin-top: var(--recovery-actions-margin)',
]) {
  if (!css.includes(cssRule)) throw new Error(`復帰導線の幾何契約がありません: ${cssRule}`);
}
const recoveryVariables = [
  '--recovery-header-padding', '--recovery-title-height', '--recovery-tagline-margin',
  '--recovery-tagline-height', '--recovery-actions-margin', '--recovery-control-height',
  '--recovery-stop-width', '--recovery-action-width', '--recovery-actions-gap',
];
const recoveryValues = Object.fromEntries(recoveryVariables.map((variable) => {
  const values = pixelValues(variable);
  if (values.length !== 1) throw new Error(`復帰導線の CSS 数値を一意に取得できません: ${variable}`);
  return [variable, values[0]];
}));
if (html.indexOf('id="recover-emulator"') > html.indexOf('<main')) {
  throw new Error('復帰導線が初期表示のヘッダー内にありません');
}
const recoveryTop = recoveryValues['--recovery-header-padding'] + recoveryValues['--recovery-title-height']
  + recoveryValues['--recovery-tagline-margin'] + recoveryValues['--recovery-tagline-height']
  + recoveryValues['--recovery-actions-margin'];
const recoveryBottom = recoveryTop + recoveryValues['--recovery-control-height'];
for (const viewport of ['1280x900', '800x600']) {
  const [viewportWidth, viewportHeight] = viewport.split('x').map(Number);
  const recoveryWidth = recoveryValues['--recovery-stop-width']
    + recoveryValues['--recovery-action-width'] + recoveryValues['--recovery-actions-gap'];
  const recoveryLeft = (viewportWidth - recoveryWidth) / 2;
  const recoveryRight = recoveryLeft + recoveryWidth;
  if (recoveryTop < 0 || recoveryBottom > viewportHeight) {
    throw new Error(`${viewport}: 復帰導線が初期ビューポート外です (${recoveryTop}..${recoveryBottom}px)`);
  }
  if (recoveryLeft < 0 || recoveryRight > viewportWidth) {
    throw new Error(`${viewport}: 復帰導線が初期ビューポートの横幅外です (${recoveryLeft}..${recoveryRight}px)`);
  }
  console.log(`verify-ide: recovery reachability ${viewport} x=${recoveryLeft}..${recoveryRight}px y=${recoveryTop}..${recoveryBottom}px`);
}

// ボタン内容の収まりを client/scroll 寸法に対応させた静的検査。
// 日本語等を16px、ASCIIを9pxと保守的に見積もり、paddingを加えたscroll寸法を求める。
const buttonVariables = [
  '--button-line-height', '--button-block-padding', '--button-inline-padding', '--button-border-width',
];
const buttonValues = Object.fromEntries(buttonVariables.map((variable) => {
  const values = pixelValues(variable);
  if (values.length !== 1) throw new Error(`ボタンの CSS 数値を一意に取得できません: ${variable}`);
  return [variable, values[0]];
}));
for (const cssContract of ['white-space: nowrap', 'flex-shrink: 0']) {
  if (!css.match(new RegExp(`button \\{[^}]*${cssContract}`))) {
    throw new Error(`ボタン内容の枠内保持契約がありません: ${cssContract}`);
  }
}
function buttonLabel(id) {
  const match = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>([^<]+)</button>`));
  if (!match) throw new Error(`ボタン文言を取得できません: ${id}`);
  return match[1].trim();
}
function labelScrollWidth(label) {
  const glyphWidth = [...label].reduce((width, character) => width + (/^[\\x00-\\x7f]$/.test(character) ? 9 : 16), 0);
  return glyphWidth + buttonValues['--button-inline-padding'] * 2;
}
const clientHeight = recoveryValues['--recovery-control-height'] - buttonValues['--button-border-width'] * 2;
const labelScrollHeight = buttonValues['--button-line-height'] + buttonValues['--button-block-padding'] * 2;
if (labelScrollHeight > clientHeight) {
  throw new Error(`ヘッダーボタンが縦に溢れます: scroll=${labelScrollHeight}px client=${clientHeight}px`);
}
const recoveryLabels = [
  buttonLabel('recover-emulator'),
  ...[...workbench.matchAll(/'(停止して[^'\n]+)'/g)].map((match) => match[1]),
];
const fixedButtons = [
  { id: 'stop-emulator', labels: [buttonLabel('stop-emulator')], width: recoveryValues['--recovery-stop-width'] },
  { id: 'recover-emulator', labels: recoveryLabels, width: recoveryValues['--recovery-action-width'] },
];
for (const button of fixedButtons) {
  const scrollWidth = Math.max(...button.labels.map(labelScrollWidth));
  const clientWidth = button.width - buttonValues['--button-border-width'] * 2;
  if (scrollWidth > clientWidth) {
    throw new Error(`${button.id} の文言が横に溢れます: scroll=${scrollWidth}px client=${clientWidth}px`);
  }
  console.log(`verify-ide: label fit ${button.id} scroll<=${scrollWidth}px client=${clientWidth}px height=${labelScrollHeight}/${clientHeight}px`);
}
const buttonRows = [
  { name: 'sidebar', ids: ['new-file', 'save-file', 'download-file'], available: 240 - 2 - 16, gap: 2 },
  { name: 'editor', ids: ['build', 'download-xdf', 'run'], available: 420 - 2 - 24, gap: 6, minimum: 72 },
];
for (const row of buttonRows) {
  const required = row.ids.reduce((width, id) => width + Math.max(row.minimum ?? 0, labelScrollWidth(buttonLabel(id)) + 2), 0)
    + row.gap * (row.ids.length - 1);
  if (required > row.available) throw new Error(`${row.name} のボタン列が横に溢れます: ${required}/${row.available}px`);
  console.log(`verify-ide: label fit ${row.name} row=${required}/${row.available}px`);
}
for (const containment of [
  '.file-entry { flex: 1; min-width: 0; border-radius: 0; overflow: hidden; text-align: left; text-overflow: ellipsis; white-space: nowrap',
  '.tab { max-width: 200px; height: 35px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap',
]) {
  if (!css.includes(containment)) throw new Error(`可変ファイル名の枠内省略契約がありません: ${containment.split(' {')[0]}`);
}
if (16 + 0 > 27 - buttonValues['--button-border-width'] * 2
    || 16 + 12 > 30 - buttonValues['--button-border-width'] * 2) {
  throw new Error('タブ閉じる／ファイル削除ボタンの文言が枠に収まりません');
}
console.log('verify-ide: label fit dynamic paths=ellipsis, close/delete=contained');
const adapterSource = await readFile(resolve(root, 'x68k-adapter.mjs'), 'utf8');
if (!adapterSource.includes('../web/browser-toolchain.ts')) throw new Error('共有ブラウザツールチェーン参照がありません');
if (!adapterSource.includes("./px68k-runtime.ts") || !adapterSource.includes('runtime.runXdf(xdf)')) {
  throw new Error('px68k 実行アダプタ参照がありません');
}
for (const boundary of ['rewriteBuildDiagnostic', 'コンパイルでエラーが出ました', 'console.error']) {
  if (!adapterSource.includes(boundary)) throw new Error(`診断境界がありません: ${boundary}`);
}
for (const annotationUi of ['annotateBuildDiagnostics', '日本語の説明', '何が起きたか', '次にすること']) {
  if (!adapterSource.includes(annotationUi) && !workbench.includes(annotationUi)) {
    throw new Error(`日本語注釈UIがありません: ${annotationUi}`);
  }
}

// 診断到達性の静的な幾何検査。失敗時の scrollIntoView で固定高パネル全体を
// 画面下端へ入れ、注釈はパネル内へ入る最大高に制限される、という契約を測る。
for (const revealStep of [
  "firstAnnotation ?? nodes.buildOutput.firstElementChild)?.scrollIntoView({ block: 'nearest'",
  "nodes.buildOutput.scrollIntoView({ block: 'end'",
]) {
  if (!workbench.includes(revealStep)) throw new Error(`診断の自動表示がありません: ${revealStep}`);
}
if (html.indexOf('id="editor"') >= html.indexOf('id="build-output"')) {
  throw new Error('診断パネルがエディタより前にあり、同時表示を保証できません');
}
for (const cssContract of [
  'height: var(--diagnostic-panel-height)',
  'max-height: var(--diagnostic-annotation-max-height)',
  'scroll-margin-block: var(--diagnostic-scroll-margin)',
]) {
  if (!css.includes(cssContract)) throw new Error(`診断到達性の CSS 契約がありません: ${cssContract}`);
}
function pixelValues(variable) {
  return [...css.matchAll(new RegExp(`${variable}:\\s*(\\d+)px`, 'g'))].map((match) => Number(match[1]));
}
const panelHeights = pixelValues('--diagnostic-panel-height');
const annotationHeights = pixelValues('--diagnostic-annotation-max-height');
const [scrollMargin] = pixelValues('--diagnostic-scroll-margin');
if (panelHeights.length !== 2 || annotationHeights.length !== 2 || !scrollMargin) {
  throw new Error('診断到達性の CSS 数値を一意に取得できません');
}
const reachabilityCases = [
  { name: '1280x900', viewportHeight: 900, panelHeight: panelHeights[0], annotationHeight: annotationHeights[0] },
  { name: '800x600', viewportHeight: 600, panelHeight: panelHeights[1], annotationHeight: annotationHeights[1] },
];
for (const testCase of reachabilityCases) {
  const panelTop = testCase.viewportHeight - testCase.panelHeight;
  const annotationTop = testCase.viewportHeight - 8 - testCase.annotationHeight;
  const annotationBottom = testCase.viewportHeight - 8;
  // ツールバー＋状態行を実寸より大きい 120px と見積もった残りを、ソース可視域とする。
  const sourceVisibleHeight = panelTop - 120;
  if (panelTop < 0 || annotationTop < panelTop + scrollMargin || annotationBottom > testCase.viewportHeight) {
    throw new Error(`${testCase.name}: 注釈が初期ビューポート内に収まりません`);
  }
  if (sourceVisibleHeight < 160) {
    throw new Error(`${testCase.name}: 診断表示時のソース可視域が不足します (${sourceVisibleHeight}px)`);
  }
  console.log(`verify-ide: reachability ${testCase.name} annotation=${annotationTop}..${annotationBottom}px source>=${sourceVisibleHeight}px`);
}
const runtimeSource = await readFile(resolve(root, 'px68k-runtime.ts'), 'utf8');
for (const member of ['window.x68kdevEmulatorProbe', 'readTextScreen', 'getFrameCount', 'getState', 'runFrames', 'runBlankImage', 'stop()']) {
  if (!runtimeSource.includes(member)) throw new Error(`ブラウザプローブがありません: ${member}`);
}
const keyboardSource = await readFile(resolve(root, 'px68k/keyboard.ts'), 'utf8');
const keyboardInputSource = await readFile(resolve(root, 'px68k/keyboard-input.ts'), 'utf8');
for (const contract of ['keyboardEventToRetrok', 'keyToRetrok(event.key)', "event.code ? `code:${event.code}`", 'releaseAll']) {
  if (!keyboardSource.includes(contract) && !keyboardInputSource.includes(contract)) {
    throw new Error(`キーボード入力契約がありません: ${contract}`);
  }
}
if (!html.includes('id="x68k-screen" width="768" height="512" tabindex="0"')) {
  throw new Error('実行画面がキーボードフォーカス可能ではありません');
}
for (const focusContract of ['keyboard-active', 'キーボード入力: X68000へ送信中', "nodes.screen.addEventListener('focus'"]) {
  if (!css.includes(focusContract) && !workbench.includes(focusContract)) {
    throw new Error(`キーボードフォーカス表示がありません: ${focusContract}`);
  }
}
const sampleManifest = await readFile(resolve(root, 'sample-manifest.mjs'), 'utf8');
if (!sampleManifest.includes('../samples/breakout/main.c?raw')) throw new Error('ブロック崩しサンプル参照がありません');
const x68Header = await readFile(resolve(root, '../lib/include/x68.h'), 'utf8');
for (const learnerKey of ['ENTER', 'ESC', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'0123456789']) {
  if (!x68Header.includes(`#define X68_KEY_${learnerKey} `)) {
    throw new Error(`学習者向けキー定数がありません: X68_KEY_${learnerKey}`);
  }
}
const keyboardSample = await readFile(resolve(root, 'samples/keyboard-input.c'), 'utf8');
for (const demonstratedKey of ['SPACE', 'ENTER', 'ESC', 'A', '1']) {
  if (!keyboardSample.includes(`X68_KEY_${demonstratedKey}`) || !keyboardSample.includes(`[${demonstratedKey}]`)) {
    throw new Error(`入力サンプルでキーを確認できません: ${demonstratedKey}`);
  }
}
for (const id of ['license-gpl', 'license-codemirror', 'license-ipl', 'license-cgrom']) {
  if (!html.includes(`id="${id}"`) || !workbench.includes(`#${id}`)) throw new Error(`ライセンス参照がありません: ${id}`);
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
