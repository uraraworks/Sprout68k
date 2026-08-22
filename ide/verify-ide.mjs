#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createServer } from '../../WebX68k/node_modules/vite/dist/node/index.js';
import { APP_PATH } from '../tools/distribution.mts';
import { verifyHtmlUrls } from '../tools/html_url_verifier.mts';
import {
  DEFAULT_SPLIT_RATIO, SPLIT_RATIO_KEY, containedContentSize, desktopPaneSizes,
  mobileEditorHeight, readSplitRatio, writeSplitRatio,
} from './split-layout.mjs';
import { renderRunToggle, runToggleView } from './run-toggle.mjs';
import { verifyBrowserUi } from './browser-ui-verifier.mjs';
import { offlineStartupMode, offlineStatusPresentation } from './offline-support.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const forbidden = ['pc' + '98', 'n' + 'p2', 'pc' + '-98', 'free' + 'dos', 'na' + 'sm', 'smaller' + 'c', '98' + '01', '98' + '21'];
const required = [
  'index.html', 'help.html', 'workbench.css', 'workbench.js', 'project-fs.mjs', 'source-view.mjs',
  'sample-manifest.mjs', 'split-layout.mjs', 'run-toggle.mjs', 'offline-support.mjs', 'browser-ui-verifier.mjs', 'x68k-adapter.mjs', 'samples/hello.c', 'samples/keyboard-input.c',
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
  '../docs/IDEキーボード入力_20260822.md', '../lib/include/x68.h', '../COPYING', '../CONTRIBUTING.md', '../README.md',
  '../tools/distribution.mts', '../tools/html_url_verifier.mts',
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
const help = await readFile(resolve(root, 'help.html'), 'utf8');
const css = await readFile(resolve(root, 'workbench.css'), 'utf8');
for (const match of help.matchAll(/(?:src|href)="((?:\.\.\/|\.\/)[^"?#]+)"/g)) {
  await stat(resolve(root, match[1]));
}

// Vite開発サーバと同じHTML変換をmiddleware modeで実行し、ブラウザが解決するURLを
// APP_PATH込みで公開ルートへ戻す。単なる相対ファイルの存在確認では済ませない。
const vite = await createServer({
  configFile: resolve(root, '../vite.config.ts'), appType: 'custom', logLevel: 'silent',
  cacheDir: resolve(root, '../build/vite-url-check'),
  server: { middlewareMode: true, hmr: false },
});
let devHtml;
try {
  devHtml = await vite.transformIndexHtml(`${APP_PATH}ide/`, html);
} finally {
  await vite.close();
}
const devHtmlWithoutViteClient = devHtml.replace(/<script type="module" src="[^"]*\/@vite\/client"><\/script>\s*/g, '');
const devReferences = verifyHtmlUrls(
  devHtmlWithoutViteClient, `https://example.test${APP_PATH}ide/`, resolve(root, '..'), APP_PATH,
);
const devBrandUrls = [...new Set(devReferences.map((entry) => entry.url.pathname)
  .filter((pathname) => /\/(?:icons\/sprout68k(?:-16|-32)?\.(?:svg|png)|manifest\.webmanifest)$/.test(pathname)))];
if (devBrandUrls.length !== 4) throw new Error(`devのロゴ/favicon/manifest URLが4件ではありません: ${devBrandUrls.join(', ')}`);
console.log(`verify-ide: dev HTML URL resolution PASS (${devReferences.length} local references; brand=${devBrandUrls.join(',')})`);

const duplicatedBaseSource = html.replace(
  'href="./icons/sprout68k.svg"', `href="${APP_PATH}ide/icons/sprout68k.svg"`,
);
if (duplicatedBaseSource === html) throw new Error('base二重化の故障注入対象がありません');
const faultVite = await createServer({
  configFile: resolve(root, '../vite.config.ts'), appType: 'custom', logLevel: 'silent',
  cacheDir: resolve(root, '../build/vite-url-check'),
  server: { middlewareMode: true, hmr: false },
});
let duplicatedBaseRejected = false;
let duplicatedBaseError = '';
try {
  const faultHtml = (await faultVite.transformIndexHtml(`${APP_PATH}ide/`, duplicatedBaseSource))
    .replace(/<script type="module" src="[^"]*\/@vite\/client"><\/script>\s*/g, '');
  try {
    verifyHtmlUrls(faultHtml, `https://example.test${APP_PATH}ide/`, resolve(root, '..'), APP_PATH);
  } catch (error) {
    duplicatedBaseError = error instanceof Error ? error.message : String(error);
    duplicatedBaseRejected = duplicatedBaseError.includes(`${APP_PATH}${APP_PATH.slice(1)}`);
  }
} finally {
  await faultVite.close();
}
if (!duplicatedBaseRejected) throw new Error(`base二重化を検出できません: ${duplicatedBaseError}`);
console.log(`PASS(故障注入・dev base二重): ${duplicatedBaseError}`);

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
if (!fsSource.includes("databaseName = 'Sprout68kProjectFS'")) throw new Error('専用 DB 名がありません');
const workbench = await readFile(resolve(root, 'workbench.js'), 'utf8');
const runToggleSource = await readFile(resolve(root, 'run-toggle.mjs'), 'utf8');
const offlineSupportSource = await readFile(resolve(root, 'offline-support.mjs'), 'utf8');
if (!workbench.includes('window.sprout68kWorkbench')) throw new Error('公開 API 名がありません');
if (!workbench.includes('cpp()')) throw new Error('C 言語ハイライトがありません');

function htmlAttribute(tag, name) {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]?.trim() ?? '';
}

// HTMLに実在する全buttonをツールバーの正典として抽出する。個別IDの検査表は持たない。
const toolbarButtonTags = [...html.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
if (toolbarButtonTags.length === 0) throw new Error('ツールバーボタンを抽出できません');
for (const tag of toolbarButtonTags) {
  const id = htmlAttribute(tag, 'id') || '(idなし)';
  const accessibleName = htmlAttribute(tag, 'aria-label');
  const tooltip = htmlAttribute(tag, 'title');
  if (!accessibleName) throw new Error(`ツールバーボタンにアクセシブル名がありません: ${id}`);
  if (!tooltip) throw new Error(`ツールバーボタンにツールチップがありません: ${id}`);
  if (accessibleName !== tooltip) throw new Error(`アクセシブル名とツールチップが不一致です: ${id}`);
}
console.log(`verify-ide: toolbar accessible names PASS (${toolbarButtonTags.length} buttons)`);

// ヘルプ本文で data-ui-label を付けた実表記を抽出し、ボタンはaria-label、
// その他は実際の可視文字・生成文字列へ直接突き合わせる。検査専用のラベル一覧は持たない。
const helpUiLabels = [...new Set([...help.matchAll(/<strong\s+data-ui-label>([^<]+)<\/strong>/g)]
  .map((match) => match[1].trim()))];
if (helpUiLabels.length < 8) throw new Error(`ヘルプのUIラベル抽出数が不足しています: ${helpUiLabels.length}`);
const htmlWithoutButtons = html.replace(/<button\b[^>]*>[\s\S]*?<\/button>/g, '');
const staticUiLabels = htmlWithoutButtons.replace(/<[^>]+>/g, '\n').split('\n').map((text) => text.trim()).filter(Boolean);
const accessibleUiLabels = toolbarButtonTags.map((tag) => htmlAttribute(tag, 'aria-label'));
const dynamicUiLabels = [...`${workbench}\n${runToggleSource}\n${offlineSupportSource}`.matchAll(/'([^'\n]+)'/g)].map((match) => match[1]);
const actualUiLabels = new Set([...accessibleUiLabels, ...staticUiLabels, ...dynamicUiLabels]);
for (const label of helpUiLabels) {
  if (!actualUiLabels.has(label)) {
    throw new Error(`ヘルプのUIラベルが実装にありません: ${label}`);
  }
}
console.log(`verify-ide: help labels PASS (${helpUiLabels.length} labels extracted from help body)`);
const labelFaultHtml = html.replace('aria-label="ビルド" title="ビルド"', 'aria-label="構築" title="構築"');
if (labelFaultHtml === html) throw new Error('ヘルプラベル故障注入の対象がありません');
const faultButtonTags = [...labelFaultHtml.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
const faultStaticLabels = labelFaultHtml.replace(/<button\b[^>]*>[\s\S]*?<\/button>/g, '')
  .replace(/<[^>]+>/g, '\n').split('\n').map((text) => text.trim()).filter(Boolean);
const faultActualLabels = new Set([
  ...faultButtonTags.map((tag) => htmlAttribute(tag, 'aria-label')),
  ...faultStaticLabels,
  ...dynamicUiLabels,
]);
if ([...helpUiLabels].every((label) => faultActualLabels.has(label))) {
  throw new Error('UI側のビルドラベル変更をヘルプ照合が検出できません');
}
console.log('PASS(故障注入・ヘルプ照合): UI側のビルドラベル変更を拒否');

const helpScripts = [...help.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
if (helpScripts.length !== 1) throw new Error(`ヘルプのinline scriptが1件ではありません: ${helpScripts.length}`);
for (const languageContract of [
  '.lang-en { display: none; }', 'body[data-lang="en"] .lang-ja { display: none; }',
  'body[data-lang="en"] .lang-en { display: block; }',
]) {
  if (!help.includes(languageContract)) throw new Error(`ヘルプの言語表示契約がありません: ${languageContract}`);
}
function executeHelp(search) {
  const bodyAttributes = {};
  const htmlAttributes = {};
  const appLinks = [{ hidden: false }, { hidden: false }];
  const listeners = {};
  const langButton = {
    textContent: '',
    addEventListener(type, listener) { listeners[type] = listener; },
  };
  const documentMock = {
    title: '',
    body: { setAttribute(name, value) { bodyAttributes[name] = value; } },
    documentElement: { setAttribute(name, value) { htmlAttributes[name] = value; } },
    querySelectorAll(selector) { return selector === '.open-app' ? appLinks : []; },
    getElementById(id) { return id === 'lang-toggle' ? langButton : null; },
  };
  const stored = new Map();
  runInNewContext(helpScripts[0], {
    document: documentMock, location: { search }, navigator: { language: 'en-US' }, URLSearchParams,
    localStorage: { getItem(key) { return stored.get(key) ?? null; }, setItem(key, value) { stored.set(key, value); } },
  });
  return { bodyAttributes, htmlAttributes, appLinks, title: documentMock.title, langButton, listeners };
}
const helpJa = executeHelp('?lang=ja');
const helpEn = executeHelp('?lang=en');
const helpFromApp = executeHelp('?lang=ja&from=app');
if (helpJa.bodyAttributes['data-lang'] !== 'ja' || helpJa.htmlAttributes.lang !== 'ja' || helpJa.title !== 'Sprout68k 使い方') {
  throw new Error('?lang=ja で日本語表示になりません');
}
if (helpEn.bodyAttributes['data-lang'] !== 'en' || helpEn.htmlAttributes.lang !== 'en' || helpEn.title !== 'Sprout68k Help') {
  throw new Error('?lang=en で英語表示になりません');
}
if (helpJa.appLinks.some((link) => link.hidden) || helpFromApp.appLinks.some((link) => !link.hidden)) {
  throw new Error('from=app によるアプリ導線の表示切替が不正です');
}
console.log('verify-ide: help query PASS (lang=ja/en, from=app hides 2 app links)');
for (const id of ['build-output', 'download-xdf', 'run', 'machine-status', 'keyboard-status', 'x68k-screen', 'build-id', 'offline-status']) {
  if (!html.includes(`id="${id}"`)) throw new Error(`必要な DOM 要素がありません: ${id}`);
  if (!workbench.includes(`#${id}`)) throw new Error(`DOM 要素の参照がありません: ${id}`);
}
for (const contract of [
  "const SPROUT68K_SCOPE_PATH = '/Sprout68k/'",
  'scope: SPROUT68K_SCOPE_PATH',
  "updateViaCache: 'none'",
  'build: ${__BUILD_ID__}',
  "'オフラインでも使えます'",
  "'オフライン準備に失敗しました'",
  "type: 'SPROUT68K_CHECK_CACHE'",
]) {
  if (!`${workbench}\n${offlineSupportSource}`.includes(contract)) throw new Error(`配布UI契約がありません: ${contract}`);
}
const devOfflineMode = offlineStartupMode({ development: true, serviceWorkerSupported: true, inScope: true });
const productionOfflineMode = offlineStartupMode({ development: false, serviceWorkerSupported: true, inScope: true });
const devOfflinePresentation = offlineStatusPresentation(devOfflineMode);
const readyOfflinePresentation = offlineStatusPresentation('ready');
const failedOfflinePresentation = offlineStatusPresentation('error');
if (devOfflineMode !== 'development-disabled' || devOfflinePresentation.error
    || devOfflinePresentation.text !== 'オフライン: 開発サーバでは無効'
    || productionOfflineMode !== 'register'
    || readyOfflinePresentation.error || readyOfflinePresentation.text !== 'オフラインでも使えます') {
  throw new Error('dev/本番のオフライン表示分類が不正です');
}
if (!failedOfflinePresentation.error || failedOfflinePresentation.text !== 'オフライン準備に失敗しました') {
  throw new Error('precache失敗の赤色表示が失われています');
}
if (!workbench.includes('development: import.meta.env.DEV')) throw new Error('Vite開発モードの実状態を判定に使っていません');
console.log('verify-ide: offline mode PASS dev=development-disabled(非赤), production=register->ready');
console.log('PASS(故障注入・オフライン表示): errorは「オフライン準備に失敗しました」+赤表示');
const recoverySource = await readFile(resolve(root, 'recovery-controller.mjs'), 'utf8');
for (const contract of ['rememberSuccessfulBuild', 'buildFallback', 'captureSource', '復帰中に編集中のソースが変化しました']) {
  if (!recoverySource.includes(contract)) throw new Error(`復帰のソース保持契約がありません: ${contract}`);
}
for (const forbiddenMutation of ['editor.dispatch', 'projectFS.write', '.savedText =']) {
  if (recoverySource.includes(forbiddenMutation)) throw new Error(`復帰境界にソース変更処理があります: ${forbiddenMutation}`);
}
if (!workbench.includes('recoveryController.rememberSuccessfulBuild(result)')
    || !workbench.includes('recoveryController.runFresh(') || !workbench.includes('toggleEmulator')) {
  throw new Error('成功XDFの保持または実行時復帰結線がありません');
}
for (const removedControl of ['id="stop-emulator"', 'id="recover-emulator"', '停止して前回成功XDFを再起動', '実行を停止']) {
  if (html.includes(removedControl) || help.includes(removedControl)) {
    throw new Error(`表示から外した操作が残っています: ${removedControl}`);
  }
}

const editorToolbarGap = Number(css.match(/\.editor-toolbar \{[^}]*gap:\s*(\d+)px/)?.[1]);
if (!Number.isFinite(editorToolbarGap)) throw new Error('ツールバーのgapを取得できません');

// 同一ボタンの可視文字・アイコン・アクセシブル名を、状態正典から一括更新する。
function mockRunButton() {
  const attributes = new Map();
  const label = { textContent: '' };
  const play = {};
  const stop = {};
  return {
    title: '', dataset: {}, attributes, label, play, stop,
    setAttribute(name, value) { attributes.set(name, value); },
    querySelector(selector) {
      return selector === '.toolbar-label' ? label
        : selector === '[data-run-icon="play"]' ? play
          : selector === '[data-run-icon="stop"]' ? stop : null;
    },
  };
}
function assertToggle(button, state) {
  const expected = runToggleView(state);
  return button.label.textContent === expected.label
    && button.attributes.get('aria-label') === expected.label
    && button.title === expected.label && button.dataset.state === state;
}
const toggle = mockRunButton();
for (const state of ['idle', 'running', 'idle']) {
  renderRunToggle(toggle, state);
  if (!assertToggle(toggle, state)) throw new Error(`実行トグルが${state}表示に遷移しません`);
}
renderRunToggle(toggle, 'running');
toggle.title = '実行'; // titleだけ更新されない故障
if (assertToggle(toggle, 'running')) throw new Error('トグルの部分更新故障を検出できません');
if (!html.includes('data-run-icon="play"') || !html.includes('data-run-icon="stop"')
    || !workbench.includes("renderRunToggle(nodes.run, emulatorRunning ? 'running' : 'idle')")) {
  throw new Error('実行トグルのDOM結線がありません');
}
console.log('verify-ide: run/stop toggle PASS idle(実行/play) -> running(停止/stop) -> idle(実行/play), aria-label/title synchronized');
console.log('PASS(故障注入・実行トグル): titleだけ未更新の状態を拒否');

const tagline = html.match(/<p class="app-tagline">([^<]+)<\/p>/)?.[1] ?? '';
if (tagline !== 'A browser-based C learning environment for X68000' || /[ぁ-んァ-ヶ一-龠]/.test(tagline)) {
  throw new Error(`英語タグラインが不正です: ${tagline}`);
}

// スプリットでmachine paneが広がったとき、実際に描画するcanvasのCSS寸法が
// 縦横とも増え、canvas固有のアスペクト比を保つことを純粋関数で検査する。
for (const contract of [
  'containedContentSize(', 'nodes.screen.style.width', 'nodes.screen.style.height',
  'new ResizeObserver(resizeMachineScreen)', "attributeFilter: ['width', 'height']",
]) {
  if (!workbench.includes(contract)) throw new Error(`実行画面の追随拡大契約がありません: ${contract}`);
}
for (const contract of ['max-width: 100%', 'max-height: 100%', 'object-fit: contain', 'aspect-ratio: 3 / 2']) {
  if (!css.includes(contract)) throw new Error(`実行画面の比率維持CSSがありません: ${contract}`);
}
const initialPanes = desktopPaneSizes({ workspaceWidth: 1280, ratio: DEFAULT_SPLIT_RATIO });
const expandedPanes = desktopPaneSizes({ workspaceWidth: 1280, ratio: 0.28 });
function fittedMode(machineWidth, intrinsicWidth, intrinsicHeight) {
  const shellWidth = machineWidth - 26;
  const shellHeight = Math.max(240, shellWidth * 2 / 3);
  return containedContentSize(intrinsicWidth, intrinsicHeight, shellWidth, shellHeight);
}
const initialCanvasTag = html.match(/<canvas id="x68k-screen"[^>]*>/)?.[0] ?? '';
const initialCanvasWidth = Number(htmlAttribute(initialCanvasTag, 'width'));
const initialCanvasHeight = Number(htmlAttribute(initialCanvasTag, 'height'));
let reportedGrowth;
for (const [intrinsicWidth, intrinsicHeight] of [[initialCanvasWidth, initialCanvasHeight], [512, 512]]) {
  const initialContent = fittedMode(initialPanes.machineWidth, intrinsicWidth, intrinsicHeight);
  const expandedContent = fittedMode(expandedPanes.machineWidth, intrinsicWidth, intrinsicHeight);
  const sourceAspect = intrinsicWidth / intrinsicHeight;
  const expandedAspect = expandedContent.width / expandedContent.height;
  if (expandedContent.width <= initialContent.width || expandedContent.height <= initialContent.height
      || Math.abs(expandedAspect - sourceAspect) > 1e-9) {
    throw new Error(`実行画面の中身が比率を保って拡大しません: mode=${intrinsicWidth}x${intrinsicHeight} initial=${initialContent.width}x${initialContent.height} expanded=${expandedContent.width}x${expandedContent.height}`);
  }
  if (intrinsicWidth === initialCanvasWidth && intrinsicHeight === initialCanvasHeight) {
    reportedGrowth = { initialContent, expandedContent, expandedAspect };
  }
}
const stretchedFault = { width: expandedPanes.machineWidth - 26, height: (expandedPanes.machineWidth - 26) * 2 / 3 };
if (Math.abs(stretchedFault.width / stretchedFault.height - 1) <= 1e-9) {
  throw new Error('枠いっぱいに引き伸ばす故障注入を検出できません');
}
console.log(`verify-ide: split content growth PASS ${reportedGrowth.initialContent.width.toFixed(1)}x${reportedGrowth.initialContent.height.toFixed(1)} -> ${reportedGrowth.expandedContent.width.toFixed(1)}x${reportedGrowth.expandedContent.height.toFixed(1)}, aspect=${reportedGrowth.expandedAspect.toFixed(3)}; 512x512 mode also PASS`);
console.log('PASS(故障注入・画面比率): 枠いっぱいの引き伸ばしを拒否');

// 同じlocalStorageを次のページ読込に見立て、保存値を新しい状態から読み直す。
const splitStore = new Map();
const storage = { getItem: (key) => splitStore.get(key) ?? null, setItem: (key, value) => splitStore.set(key, value) };
const persistedRatio = writeSplitRatio(storage, 0.34);
const reloadedRatio = readSplitRatio(storage);
if (splitStore.get(SPLIT_RATIO_KEY) === undefined || reloadedRatio !== persistedRatio) {
  throw new Error(`分割位置を再読込後に復元できません: saved=${persistedRatio} loaded=${reloadedRatio}`);
}
const droppingStorage = { getItem: () => null, setItem: () => {} };
writeSplitRatio(droppingStorage, 0.34);
if (readSplitRatio(droppingStorage) === persistedRatio) {
  throw new Error('localStorage書込みを落とす故障注入を検出できません');
}
for (const contract of ['readSplitRatio(localStorage)', 'writeSplitRatio(localStorage, splitRatio)']) {
  if (!workbench.includes(contract)) throw new Error(`分割位置の永続化結線がありません: ${contract}`);
}
console.log(`verify-ide: split persistence PASS key=${SPLIT_RATIO_KEY} saved/reloaded=${reloadedRatio}`);
console.log('PASS(故障注入・分割保存): localStorage書込み欠落を拒否');

// ヘッダーの「?」とフッターの「使い方」は、固定寸法と通常フロー上の位置から
// 初期ビューポート内にあることを検査する。
for (const linkContract of [
  'class="header-help-btn" href="./help.html?lang=ja&amp;from=app" target="_blank" rel="noopener noreferrer"',
  'class="footer-help-link" href="./help.html?lang=ja&amp;from=app" target="_blank" rel="noopener noreferrer"',
]) {
  if (!html.includes(linkContract)) throw new Error(`ヘルプ導線契約がありません: ${linkContract}`);
}
if (html.indexOf('class="header-help-btn"') > html.indexOf('<main')
    || html.indexOf('class="footer-help-link"') < html.indexOf('</main>')) {
  throw new Error('ヘルプ導線がヘッダー／フッターにありません');
}
for (const cssContract of [
  '.app-header { position: relative', '.header-help-btn { position: absolute',
  '.workspace-grid { flex: 1', '.app-footer { min-height: var(--app-footer-height)',
]) {
  if (!css.includes(cssContract)) throw new Error(`ヘルプ到達性のCSS契約がありません: ${cssContract}`);
}
const helpGeometryVariables = ['--help-header-offset', '--help-header-right', '--help-control-size', '--app-footer-height'];
const helpGeometry = Object.fromEntries(helpGeometryVariables.map((variable) => {
  const values = pixelValues(variable);
  if (values.length !== 1) throw new Error(`ヘルプ導線のCSS数値を一意に取得できません: ${variable}`);
  return [variable, values[0]];
}));
for (const viewport of ['1280x900', '800x600']) {
  const [viewportWidth, viewportHeight] = viewport.split('x').map(Number);
  const headerLeft = viewportWidth - helpGeometry['--help-header-right'] - helpGeometry['--help-control-size'];
  const headerRight = headerLeft + helpGeometry['--help-control-size'];
  const headerTop = helpGeometry['--help-header-offset'];
  const headerBottom = headerTop + helpGeometry['--help-control-size'];
  const footerTop = viewportHeight - helpGeometry['--app-footer-height'];
  if (headerLeft < 0 || headerRight > viewportWidth || headerTop < 0 || headerBottom > viewportHeight
      || footerTop < 0 || footerTop >= viewportHeight) {
    throw new Error(`${viewport}: ヘルプ導線が初期ビューポート外です`);
  }
  console.log(`verify-ide: help reachability ${viewport} header=${headerLeft}..${headerRight}x${headerTop}..${headerBottom}px footer=${footerTop}..${viewportHeight}px`);
}

// 初期表示のツールバー矩形を固定CSS寸法から算出する。800pxではsidebarを88px、
// editorをその直後へ1カラム配置するため、両ツールバーを600px内に収められる。
const headerGeometryVariables = ['--app-header-padding', '--app-title-height', '--app-tagline-margin', '--app-tagline-height'];
const headerGeometry = Object.fromEntries(headerGeometryVariables.map((variable) => {
  const values = pixelValues(variable);
  if (values.length !== 1) throw new Error(`ヘッダーCSS数値を一意に取得できません: ${variable}`);
  return [variable, values[0]];
}));
const appHeaderHeight = headerGeometry['--app-header-padding'] * 2 + headerGeometry['--app-title-height']
  + headerGeometry['--app-tagline-margin'] + headerGeometry['--app-tagline-height'];
const toolbarReachCases = [
  { name: '1280x900', width: 1280, height: 900, mobile: false },
  { name: '800x600', width: 800, height: 600, mobile: true },
];
for (const testCase of toolbarReachCases) {
  const workspaceTop = appHeaderHeight + 8;
  const sidebarButtonTop = workspaceTop + 35;
  const editorTop = testCase.mobile ? workspaceTop + 88 + 8 : workspaceTop;
  const editorHeight = testCase.mobile ? mobileEditorHeight(DEFAULT_SPLIT_RATIO) : Math.min(testCase.height * 0.66, 650);
  const editorButtonTop = editorTop + 48 + 36 + editorHeight + 8;
  const editorButtonBottom = editorButtonTop + 38;
  const editorLeft = testCase.mobile ? 8 + 12 : 8 + 240 + 8 + 12;
  const editorRight = editorLeft + 220;
  if (sidebarButtonTop < 0 || sidebarButtonTop + 38 > testCase.height
      || editorButtonTop < 0 || editorButtonBottom > testCase.height
      || editorLeft < 0 || editorRight > testCase.width) {
    throw new Error(`${testCase.name}: ツールバーボタンが初期ビューポート外です`);
  }
  console.log(`verify-ide: toolbar reachability ${testCase.name} sidebarY=${sidebarButtonTop}..${sidebarButtonTop + 38}px editor=${editorLeft}..${editorRight}x${editorButtonTop}..${editorButtonBottom}px`);
}

// inline SVGの表示寸法をbuttonのclient寸法と突き合わせる。button一覧は上でHTMLから
// 抽出したものを再利用し、アイコンごとの検査表は持たない。
const buttonBorder = pixelValues('--button-border-width');
const toolbarControl = pixelValues('--toolbar-control-size');
const toolbarIcon = pixelValues('--toolbar-icon-size');
const toolbarBuildWidth = pixelValues('--toolbar-build-width');
const toolbarRunWidth = pixelValues('--toolbar-run-width');
const toolbarLabelGap = pixelValues('--toolbar-label-gap');
if (buttonBorder.length !== 1 || toolbarControl.length !== 1 || toolbarIcon.length !== 1
    || toolbarBuildWidth.length !== 1 || toolbarRunWidth.length !== 1 || toolbarLabelGap.length !== 1) {
  throw new Error('ツールバー寸法のCSS数値を一意に取得できません');
}
for (const cssContract of ['white-space: nowrap', 'flex-shrink: 0']) {
  if (!css.match(new RegExp(`button \\{[^}]*${cssContract}`))) {
    throw new Error(`ボタン内容の枠内保持契約がありません: ${cssContract}`);
  }
}
if (!css.includes('.toolbar-icon { width: var(--toolbar-icon-size); height: var(--toolbar-icon-size); display: block;')) {
  throw new Error('ツールバーアイコンの固定表示寸法がありません');
}
const buttonBodies = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
if (buttonBodies.length !== toolbarButtonTags.length) throw new Error('ツールバーボタン本体を全件抽出できません');
for (const [, attributes, body] of buttonBodies) {
  const id = htmlAttribute(`<button ${attributes}>`, 'id');
  const icons = [...body.matchAll(/<svg\b[^>]*class="toolbar-icon"[^>]*viewBox="0 0 24 24"[^>]*>/g)];
  if (icons.length !== 1) throw new Error(`24x24のツールバーアイコンが1件ではありません: ${id}`);
  const controlWidth = id === 'build' ? toolbarBuildWidth[0]
    : id === 'run' ? toolbarRunWidth[0] : toolbarControl[0];
  const controlHeight = toolbarControl[0];
  const clientWidth = controlWidth - buttonBorder[0] * 2;
  const clientHeight = controlHeight - buttonBorder[0] * 2;
  if (toolbarIcon[0] > clientWidth || toolbarIcon[0] > clientHeight) {
    throw new Error(`${id} のアイコンが枠から溢れます: icon=${toolbarIcon[0]}px client=${clientWidth}x${clientHeight}px`);
  }
  console.log(`verify-ide: icon fit ${id} ${toolbarIcon[0]}px in ${clientWidth}x${clientHeight}px`);
}
const sidebarRowWidth = toolbarControl[0] * 3 + 2 * 2;
const editorRowWidth = toolbarBuildWidth[0] + toolbarRunWidth[0] + toolbarControl[0] + editorToolbarGap * 2;
if (sidebarRowWidth > 240 - 2 - 16 || editorRowWidth > 420 - 2 - 24) {
  throw new Error('ツールバーボタン列が最小幅に収まりません');
}
console.log(`verify-ide: icon rows fit sidebar=${sidebarRowWidth}/222px editor=${editorRowWidth}/394px`);
const buildContentWidth = toolbarIcon[0] + toolbarLabelGap[0] + 3 * 14;
const runContentWidth = toolbarIcon[0] + toolbarLabelGap[0] + 2 * 14;
if (buildContentWidth > toolbarBuildWidth[0] - buttonBorder[0] * 2 - 20
    || runContentWidth > toolbarRunWidth[0] - buttonBorder[0] * 2 - 20) {
  throw new Error(`文字付きボタンが枠から溢れます: build=${buildContentWidth}px run=${runContentWidth}px`);
}
console.log(`verify-ide: labeled actions fit build=${buildContentWidth}px run=${runContentWidth}px`);
for (const containment of [
  '.file-entry { flex: 1; min-width: 0; border-radius: 0; overflow: hidden; text-align: left; text-overflow: ellipsis; white-space: nowrap',
  '.tab { max-width: 200px; height: 35px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap',
]) {
  if (!css.includes(containment)) throw new Error(`可変ファイル名の枠内省略契約がありません: ${containment.split(' {')[0]}`);
}
if (16 + 0 > 27 - buttonBorder[0] * 2
    || 16 + 12 > 30 - buttonBorder[0] * 2) {
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
for (const member of ['window.sprout68kEmulatorProbe', 'readTextScreen', 'getFrameCount', 'getState', 'runFrames', 'runBlankImage', 'stop()']) {
  if (!runtimeSource.includes(member)) throw new Error(`ブラウザプローブがありません: ${member}`);
}
const runXdfBody = runtimeSource.match(/async runXdf\([^)]*\)[\s\S]*?\n  }\n\n  stop\(\)/)?.[0] ?? '';
const discardIndex = runXdfBody.indexOf('this.stopCurrent()');
const newHostIndex = runXdfBody.indexOf('new LibretroHost(');
if (discardIndex < 0 || newHostIndex < 0 || discardIndex >= newHostIndex) {
  throw new Error('実行ごとに旧ホストを破棄してLibretroHostを作り直す契約がありません');
}
console.log('verify-ide: fresh emulator PASS stopCurrent() precedes new LibretroHost() on every runXdf()');
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
if (!sampleManifest.includes('../samples/breakout/block.c?raw')) throw new Error('ブロック崩しサンプル参照がありません');
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

await verifyBrowserUi(resolve(root, '..'));
console.log(`verify-ide: PASS (${required.length} required files, ${allFiles.length} files scanned)`);
