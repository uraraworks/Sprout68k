import {
  EditorState, EditorView, HighlightStyle, bracketMatching, cpp, defaultKeymap,
  drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, history, historyKeymap, indentLess, indentOnInput,
  indentWithTab, keymap, lineNumbers, rectangularSelection, syntaxHighlighting, tags,
} from './vendor/codemirror/codemirror.js';
import { IndexedDbProjectFS, validatePath } from './project-fs.mjs';
import { SAMPLE_FILES, loadSample } from './sample-manifest.mjs';
import { basename, sourceLanguage } from './source-view.mjs';
import { createX68kAdapter } from './x68k-adapter.mjs';
import { createRecoveryController } from './recovery-controller.mjs';
import { renderRunToggle } from './run-toggle.mjs';
import { ScreenshotStore, captureCanvas } from './screenshot-store.mjs';
import { SHARE_KEYS, SHARE_TAGS, SHARE_URL_SAFE_LIMIT, encodeShareFragment, encodeSourceText } from '../tools/share_v1.mts';
import { offlineStartupMode, offlineStatusPresentation } from './offline-support.mjs';
import {
  MAX_SPLIT_RATIO, MIN_SPLIT_RATIO, clampSplitRatio, containedContentSize,
  desktopPaneSizes, mobileEditorHeight, readSplitRatio, writeSplitRatio,
} from './split-layout.mjs';
import gplLicenseUrl from '../COPYING?url';
import codeMirrorLicenseUrl from './vendor/codemirror/LICENSE.CodeMirror?url';
import iplLicenseUrl from './system/IPLROM-LICENSE.txt?url';
import cgromNoticeUrl from './system/CGROM-NOTICE.md?url';

const nodes = {
  fileTree: document.querySelector('#file-tree'),
  newFile: document.querySelector('#new-file'),
  newPath: document.querySelector('#new-path'),
  newFilePopup: document.querySelector('#new-file-popup'),
  newFileError: document.querySelector('#new-file-error'),
  save: document.querySelector('#save-file'),
  download: document.querySelector('#download-file'),
  tabStrip: document.querySelector('#tab-strip'),
  editor: document.querySelector('#editor'),
  workspace: document.querySelector('.workspace-grid'),
  splitter: document.querySelector('#workspace-splitter'),
  saveState: document.querySelector('#save-state'),
  currentPath: document.querySelector('#current-path'),
  build: document.querySelector('#build'),
  downloadXdf: document.querySelector('#download-xdf'),
  run: document.querySelector('#run'),
  buildStatus: document.querySelector('#build-status'),
  buildOutput: document.querySelector('#build-output'),
  machineStatus: document.querySelector('#machine-status'),
  keyboardStatus: document.querySelector('#keyboard-status'),
  machineCard: document.querySelector('.machine-card'),
  screen: document.querySelector('#x68k-screen'),
  screenShell: document.querySelector('#screen-shell'),
  buildId: document.querySelector('#build-id'),
  offlineStatus: document.querySelector('#offline-status'),
  shoot: document.querySelector('#shoot'),
  shotBar: document.querySelector('#shot-bar'),
  shotList: document.querySelector('#shot-list'),
  shotSave: document.querySelector('#shot-save'),
  shotCopy: document.querySelector('#shot-copy'),
  shotShare: document.querySelector('#shot-share'),
  shotDelete: document.querySelector('#shot-delete'),
  share: document.querySelector('#share'),
  shareDialog: document.querySelector('#share-dialog'),
  shareTags: document.querySelector('#share-tags'),
  shareStatus: document.querySelector('#share-status'),
  shareBuild: document.querySelector('#share-build'),
  shareBinary: document.querySelector('#share-binary'),
  shareBinaryUrl: document.querySelector('#share-binary-url'),
  shareBinaryCount: document.querySelector('#share-binary-count'),
  shareBinaryCopy: document.querySelector('#share-binary-copy'),
  shareSource: document.querySelector('#share-source'),
  shareSourceUrl: document.querySelector('#share-source-url'),
  shareSourceCount: document.querySelector('#share-source-count'),
  shareSourceCopy: document.querySelector('#share-source-copy'),
  shareShots: document.querySelector('#share-shots'),
  shareShotsEmpty: document.querySelector('#share-shots-empty'),
};

const LAST_PATH_KEY = 'sprout68k:last-path';
const SPROUT68K_SCOPE_PATH = '/Sprout68k/';
let splitRatio = readSplitRatio(localStorage);

function narrowWorkspace() {
  return window.matchMedia('(max-width: 1100px)').matches;
}

function resizeMachineScreen() {
  const fitted = containedContentSize(
    nodes.screen.width, nodes.screen.height,
    nodes.screenShell.clientWidth, nodes.screenShell.clientHeight,
  );
  if (fitted.width <= 0 || fitted.height <= 0) return;
  nodes.screen.style.width = `${Math.floor(fitted.width)}px`;
  nodes.screen.style.height = `${Math.floor(fitted.height)}px`;
}

function applySplitLayout({ persist = false } = {}) {
  splitRatio = clampSplitRatio(splitRatio);
  if (narrowWorkspace()) {
    document.documentElement.style.removeProperty('--editor-pane-width');
    document.documentElement.style.setProperty('--mobile-editor-height', `${Math.round(mobileEditorHeight(splitRatio))}px`);
    nodes.splitter.setAttribute('aria-orientation', 'horizontal');
  } else {
    const panes = desktopPaneSizes({ workspaceWidth: nodes.workspace.clientWidth, ratio: splitRatio });
    document.documentElement.style.setProperty('--editor-pane-width', `${Math.round(panes.editorWidth)}px`);
    nodes.splitter.setAttribute('aria-orientation', 'vertical');
  }
  nodes.splitter.setAttribute('aria-valuenow', String(Math.round(splitRatio * 100)));
  if (persist) {
    try { splitRatio = writeSplitRatio(localStorage, splitRatio); } catch {}
  }
  requestAnimationFrame(resizeMachineScreen);
}

let splitDrag;
nodes.splitter.addEventListener('pointerdown', (event) => {
  splitDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, ratio: splitRatio };
  nodes.splitter.setPointerCapture(event.pointerId);
  nodes.splitter.classList.add('dragging');
  event.preventDefault();
});
nodes.splitter.addEventListener('pointermove', (event) => {
  if (!splitDrag || splitDrag.pointerId !== event.pointerId) return;
  if (narrowWorkspace()) {
    const heightRange = 120;
    const ratioRange = MAX_SPLIT_RATIO - MIN_SPLIT_RATIO;
    splitRatio = splitDrag.ratio + ((event.clientY - splitDrag.y) / heightRange) * ratioRange;
  } else {
    const panes = desktopPaneSizes({ workspaceWidth: nodes.workspace.clientWidth, ratio: splitDrag.ratio });
    splitRatio = splitDrag.ratio + (event.clientX - splitDrag.x) / Math.max(1, panes.available);
  }
  applySplitLayout({ persist: true });
});
function finishSplitDrag(event) {
  if (!splitDrag || splitDrag.pointerId !== event.pointerId) return;
  splitDrag = undefined;
  nodes.splitter.classList.remove('dragging');
  applySplitLayout({ persist: true });
}
nodes.splitter.addEventListener('pointerup', finishSplitDrag);
nodes.splitter.addEventListener('pointercancel', finishSplitDrag);
nodes.splitter.addEventListener('keydown', (event) => {
  const decrease = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
  const increase = event.key === 'ArrowRight' || event.key === 'ArrowDown';
  if (!decrease && !increase && event.key !== 'Home' && event.key !== 'End') return;
  event.preventDefault();
  splitRatio = event.key === 'Home' ? MIN_SPLIT_RATIO
    : event.key === 'End' ? MAX_SPLIT_RATIO : splitRatio + (increase ? 0.03 : -0.03);
  applySplitLayout({ persist: true });
});

window.addEventListener('resize', () => applySplitLayout());
new ResizeObserver(resizeMachineScreen).observe(nodes.screenShell);
new MutationObserver(resizeMachineScreen).observe(nodes.screen, { attributes: true, attributeFilter: ['width', 'height'] });
applySplitLayout();

nodes.buildId.textContent = `build: ${__BUILD_STAMP__}`;
function showOfflineStatus(state, detail = '') {
  const presentation = offlineStatusPresentation(state);
  nodes.offlineStatus.textContent = presentation.text;
  nodes.offlineStatus.title = detail;
  nodes.offlineStatus.classList.toggle('error', presentation.error);
}

function checkOfflineCache(worker) {
  const channel = new MessageChannel();
  channel.port1.onmessage = ({ data }) => {
    if (data?.type === 'SPROUT68K_OFFLINE_STATUS') showOfflineStatus(data.state, data.detail);
  };
  worker.postMessage({ type: 'SPROUT68K_CHECK_CACHE' }, [channel.port2]);
}

function checkCurrentOfflineWorker() {
  const worker = navigator.serviceWorker.controller;
  if (worker) checkOfflineCache(worker);
}

async function initializeOfflineSupport() {
  const startupMode = offlineStartupMode({
    development: import.meta.env.DEV,
    serviceWorkerSupported: 'serviceWorker' in navigator,
    inScope: location.pathname.startsWith(SPROUT68K_SCOPE_PATH),
  });
  if (startupMode === 'development-disabled') {
    showOfflineStatus('development-disabled', 'Vite開発モードではService Workerを生成しません');
    return;
  }
  if (startupMode === 'error') {
    showOfflineStatus('error', 'この環境ではService Workerを利用できません');
    return;
  }
  navigator.serviceWorker.addEventListener('message', ({ data }) => {
    if (data?.type === 'SPROUT68K_OFFLINE_STATUS') showOfflineStatus(data.state, data.detail);
  });
  try {
    const serviceWorkerUrl = new URL('sprout68k-sw.js', `${location.origin}${SPROUT68K_SCOPE_PATH}`);
    const registration = await navigator.serviceWorker.register(serviceWorkerUrl, {
      scope: SPROUT68K_SCOPE_PATH,
      updateViaCache: 'none',
    });
    const active = navigator.serviceWorker.controller || registration.active;
    if (active) checkOfflineCache(active);
    const candidate = registration.installing || registration.waiting;
    const inspectCandidate = () => {
      if (candidate.state === 'activated') checkOfflineCache(candidate);
      if (candidate.state === 'redundant') showOfflineStatus('error', 'Service Workerのinstallに失敗しました。開発者コンソールを確認してください');
    };
    if (candidate) {
      inspectCandidate();
      candidate.addEventListener('statechange', inspectCandidate);
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (navigator.serviceWorker.controller) checkOfflineCache(navigator.serviceWorker.controller);
    });
    window.addEventListener('online', checkCurrentOfflineWorker);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('Sprout68k Service Worker の登録に失敗しました', error);
    showOfflineStatus('error', detail);
  }
}
void initializeOfflineSupport();

// 開発サーバーだけでなく production build にもライセンス本文を資産として含める。
document.querySelector('#license-gpl').href = gplLicenseUrl;
document.querySelector('#license-codemirror').href = codeMirrorLicenseUrl;
document.querySelector('#license-ipl').href = iplLicenseUrl;
document.querySelector('#license-cgrom').href = cgromNoticeUrl;
const projectFS = new IndexedDbProjectFS({ databaseName: 'Sprout68kProjectFS' });
let tabs = [];
let activeTabId;
let nextTabId = 1;
let loadingDocument = false;
let popupOpen = false;
let confirmAction = (message) => window.confirm(message);
let emulatorRunning = false;

function captureSourceState() {
  return JSON.stringify({
    activeTabId,
    editor: editor.state.doc.toString(),
    tabs: tabs.map(({ id, origin, path, text, savedText, cursor }) => (
      { id, origin, path, text, savedText, cursor }
    )),
  });
}

function setEmulatorRunning(running) {
  nodes.shoot.disabled = !running;
  emulatorRunning = Boolean(running);
  renderRunToggle(nodes.run, emulatorRunning ? 'running' : 'idle');
}

function reportMachine(message, error = false) {
  nodes.machineStatus.textContent = message;
  nodes.machineStatus.classList.toggle('error', error);
}

const adapter = createX68kAdapter({ report: reportMachine, canvas: nodes.screen });

const darkHighlightStyle = HighlightStyle.define([
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#6a9955', fontStyle: 'italic' },
  { tag: [tags.string, tags.character], color: '#ce9178' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null], color: '#b5cea8' },
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword], color: '#569cd6' },
  { tag: [tags.function(tags.variableName), tags.macroName], color: '#dcdcaa' },
  { tag: [tags.typeName, tags.className], color: '#4ec9b0' },
  { tag: [tags.variableName, tags.propertyName], color: '#9cdcfe' },
  { tag: tags.invalid, color: '#f14c4c' },
]);

const editor = new EditorView({
  state: EditorState.create({
    doc: '',
    extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(),
      drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true),
      indentOnInput(), bracketMatching(), rectangularSelection(), highlightActiveLine(),
      syntaxHighlighting(darkHighlightStyle), cpp(), EditorView.lineWrapping,
      EditorState.tabSize.of(4),
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, { key: 'Shift-Tab', run: indentLess }]),
      EditorView.updateListener.of((update) => {
        const tab = activeTab();
        if (!loadingDocument && tab && (update.docChanged || update.selectionSet)) {
          tab.text = update.state.doc.toString();
          tab.cursor = update.state.selection.main.head;
        }
        if (!loadingDocument && update.docChanged) {
          if (tab) tab.build = undefined;
          renderBuildResult();
          updateSaveState();
        }
      }),
    ],
  }),
  parent: nodes.editor,
});

const recoveryController = createRecoveryController({
  adapter,
  captureSource: captureSourceState,
  buildFallback: async () => {
    const sample = SAMPLE_FILES[0];
    return adapter.build({ path: sample.path, text: await loadSample(sample) });
  },
});

function activeTab() {
  return tabs.find((tab) => tab.id === activeTabId);
}

function isDirty(tab) {
  return Boolean(tab && tab.text !== tab.savedText);
}

function updateSaveState() {
  const dirty = isDirty(activeTab());
  nodes.saveState.textContent = dirty ? '未保存の変更あり' : '保存済み';
  nodes.saveState.classList.toggle('dirty', dirty);
  renderTabs();
}

function renderBuildResult({ revealDiagnostics = false } = {}) {
  const result = activeTab()?.build;
  nodes.downloadXdf.disabled = !result?.ok;
  const firstAnnotation = renderDiagnosticOutput(result);
  nodes.buildStatus.classList.toggle('error', result?.ok === false);
  if (result?.ok) nodes.buildStatus.textContent = `ビルド完了: ${result.filename} (${result.xdf.length} bytes)`;
  else if (result?.ok === false) nodes.buildStatus.textContent = `ビルド失敗: ${result.message}`;
  else nodes.buildStatus.textContent = '未ビルド';

  if (revealDiagnostics && result?.ok === false) {
    // まず内側のスクロール領域で注釈を見せ、次に診断パネル全体を
    // ビューポートへ入れる。ソースは直前に残り、成功時には移動しない。
    (firstAnnotation ?? nodes.buildOutput.firstElementChild)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    nodes.buildOutput.scrollIntoView({ block: 'end', inline: 'nearest' });
  }
}

function renderDiagnosticOutput(result) {
  nodes.buildOutput.replaceChildren();
  const original = result?.diagnostics?.join('\n') ?? '';
  if (!original) return null;

  const originalGroup = document.createElement('section');
  originalGroup.className = 'diagnostic-original-group';
  const originalLabel = document.createElement('div');
  originalLabel.className = 'diagnostic-group-label';
  originalLabel.textContent = 'GCC / ld 原文';
  const originalText = document.createElement('pre');
  originalText.className = 'diagnostic-original';
  originalText.textContent = original;
  originalGroup.append(originalLabel, originalText);
  nodes.buildOutput.append(originalGroup);

  let firstAnnotation = null;
  for (const annotation of result.annotations ?? []) {
    const note = document.createElement('section');
    note.className = `diagnostic-annotation ${annotation.severity}`;
    const heading = document.createElement('div');
    heading.className = 'diagnostic-annotation-heading';
    const kind = annotation.severity === 'warning' ? '警告' : 'エラー';
    const location = annotation.file
      ? ` · ${annotation.file}${annotation.line ? `:${annotation.line}:${annotation.column}` : ''}`
      : '';
    heading.textContent = `日本語の説明（${kind}）${location}`;
    const what = document.createElement('p');
    what.textContent = `何が起きたか: ${annotation.what}`;
    const next = document.createElement('p');
    next.textContent = `次にすること: ${annotation.next}`;
    note.append(heading, what, next);
    nodes.buildOutput.append(note);
    firstAnnotation ??= note;
  }
  return firstAnnotation;
}

function renderTabs() {
  nodes.tabStrip.replaceChildren(...tabs.map((tab) => {
    const item = document.createElement('div');
    item.className = `tab-item${tab.id === activeTabId ? ' active' : ''}`;

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'tab';
    select.setAttribute('role', 'tab');
    select.setAttribute('aria-selected', String(tab.id === activeTabId));
    select.title = tab.path;
    select.textContent = basename(tab.path);
    if (isDirty(tab)) {
      const dirty = document.createElement('span');
      dirty.className = 'tab-dirty';
      dirty.textContent = '●';
      dirty.setAttribute('aria-hidden', 'true');
      select.append(dirty);
    }
    select.addEventListener('click', () => activateTab(tab.id));

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.textContent = '×';
    close.setAttribute('aria-label', `${basename(tab.path)} を閉じる`);
    close.addEventListener('click', () => closeTab(tab.id));
    item.append(select, close);
    return item;
  }));
  syncFileTreeState();
}

function stashActiveTab() {
  const tab = activeTab();
  if (!tab) return;
  tab.text = editor.state.doc.toString();
  tab.cursor = editor.state.selection.main.head;
}

function activateTab(id) {
  const tab = tabs.find((candidate) => candidate.id === Number(id));
  if (!tab) return false;
  stashActiveTab();
  activeTabId = tab.id;
  loadingDocument = true;
  try {
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: tab.text },
      selection: { anchor: Math.min(tab.cursor || 0, tab.text.length) },
    });
  } finally {
    loadingDocument = false;
  }
  nodes.currentPath.textContent = `${tab.origin === 'sample' ? 'サンプル' : 'このブラウザ'} / ${tab.path}`;
  try { localStorage.setItem(LAST_PATH_KEY, `${tab.origin}:${tab.path}`); } catch {}
  renderTabs();
  renderBuildResult();
  updateSaveState();
  editor.focus();
  return true;
}

function closeTab(id) {
  const index = tabs.findIndex((tab) => tab.id === Number(id));
  if (index < 0) return false;
  if (tabs[index].id === activeTabId) stashActiveTab();
  if (isDirty(tabs[index]) && !confirmAction(`${basename(tabs[index].path)} の未保存の変更を破棄しますか？`)) return false;
  const wasActive = tabs[index].id === activeTabId;
  tabs.splice(index, 1);
  if (wasActive) {
    activeTabId = undefined;
    if (tabs.length) activateTab(tabs[Math.min(index, tabs.length - 1)].id);
    else {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '' } });
      nodes.currentPath.textContent = '';
      renderTabs();
    }
  } else renderTabs();
  return true;
}

function syncFileTreeState() {
  const current = activeTab();
  for (const entry of nodes.fileTree.querySelectorAll('.file-entry')) {
    const active = current?.origin === entry.dataset.origin && current?.path === entry.dataset.path;
    entry.classList.toggle('active', active);
    entry.setAttribute('aria-selected', String(active));
  }
}

function makeFileGroup(label, files, origin, deletable = false) {
  const group = document.createElement('div');
  group.className = 'file-group';
  group.setAttribute('role', 'group');
  const heading = document.createElement('div');
  heading.className = 'file-group-heading';
  heading.textContent = label;
  group.append(heading);
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'file-group-empty';
    empty.textContent = '＋ で C ファイルを作成できます';
    group.append(empty);
  }
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'file-entry';
    entry.dataset.origin = origin;
    entry.dataset.path = file.path;
    entry.setAttribute('role', 'treeitem');
    entry.textContent = basename(file.path);
    entry.title = file.path;
    entry.addEventListener('click', () => openFile(origin, file.path).catch(showError));
    row.append(entry);
    if (deletable) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'file-delete';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `${basename(file.path)} を削除`);
      remove.addEventListener('click', () => deleteFile(file.path).catch(showError));
      row.append(remove);
    }
    group.append(row);
  }
  return group;
}

async function refreshFileTree() {
  const projects = await projectFS.list();
  nodes.fileTree.replaceChildren(
    makeFileGroup('作業ファイル — このブラウザに保存', projects, 'project', true),
    makeFileGroup('サンプル — 読み取り専用', SAMPLE_FILES, 'sample'),
  );
  syncFileTreeState();
}

async function openFile(origin, path) {
  const existing = tabs.find((tab) => tab.origin === origin && tab.path === path);
  if (existing) return activateTab(existing.id);
  let content;
  if (origin === 'sample') {
    const sample = SAMPLE_FILES.find((entry) => entry.path === path);
    if (!sample) throw new Error(`${path} は同梱サンプルではありません`);
    content = await loadSample(sample);
  } else if (origin === 'project') {
    const record = await projectFS.read(path);
    if (!record) throw new Error(`${path} が見つかりません`);
    content = record.content;
  } else throw new Error(`不明な保存先です: ${origin}`);
  const tab = { id: nextTabId++, origin, path, text: content, savedText: content, cursor: 0 };
  tabs.push(tab);
  activateTab(tab.id);
  return tab;
}

async function saveFile() {
  const tab = activeTab();
  if (!tab) throw new Error('保存対象がありません');
  tab.text = editor.state.doc.toString();
  if (tab.origin === 'sample') {
    tab.origin = 'project';
    tab.path = basename(tab.path);
  }
  await projectFS.write(tab.path, tab.text);
  tab.savedText = tab.text;
  await refreshFileTree();
  nodes.currentPath.textContent = `このブラウザ / ${tab.path}`;
  updateSaveState();
  nodes.buildStatus.textContent = `${tab.path} を保存しました`;
  return tab;
}

async function createFile(path) {
  const normalized = validatePath(path);
  if (sourceLanguage(normalized) !== 'c') throw new Error('新規ファイルは .c または .h にしてください');
  const existing = await projectFS.read(normalized);
  if (existing && !confirmAction(`${normalized} を上書きしますか？`)) return null;
  const content = 'void main(void)\n{\n    for (;;) {\n    }\n}\n';
  await projectFS.write(normalized, content);
  await refreshFileTree();
  return openFile('project', normalized);
}

async function deleteFile(path) {
  if (!confirmAction(`${basename(path)} を削除しますか？`)) return false;
  await projectFS.delete(path);
  const tab = tabs.find((candidate) => candidate.origin === 'project' && candidate.path === path);
  if (tab) {
    tab.savedText = tab.text;
    closeTab(tab.id);
  }
  await refreshFileTree();
  return true;
}

function downloadActiveFile() {
  const tab = activeTab();
  if (!tab) return;
  stashActiveTab();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([tab.text], { type: 'text/plain;charset=utf-8' }));
  link.download = basename(tab.path);
  link.click();
  URL.revokeObjectURL(link.href);
}

async function buildCurrent() {
  const tab = activeTab();
  if (!tab) throw new Error('ビルド対象がありません');
  nodes.build.disabled = true;
  nodes.downloadXdf.disabled = true;
  nodes.buildOutput.textContent = '';
  nodes.buildStatus.classList.remove('error');
  try {
    await saveFile();
    tab.build = undefined;
    nodes.buildStatus.textContent = `${tab.path}: ビルド中…`;
    const result = await adapter.build({ path: tab.path, text: tab.text });
    tab.build = result;
    recoveryController.rememberSuccessfulBuild(result);
    renderBuildResult({ revealDiagnostics: true });
    return result;
  } finally {
    nodes.build.disabled = false;
  }
}

function downloadBuiltXdf() {
  const result = activeTab()?.build;
  if (!result?.ok) return false;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([result.xdf], { type: 'application/octet-stream' }));
  link.download = result.filename;
  link.click();
  URL.revokeObjectURL(link.href);
  return true;
}

async function runCurrent() {
  const tab = activeTab();
  if (!tab) throw new Error('実行対象がありません');
  nodes.run.disabled = true;
  try {
    const built = tab.build?.ok ? tab.build : await buildCurrent();
    // ビルド失敗時も、前回成功XDF（未保持なら同梱サンプル）で新規起動する。
    const result = await recoveryController.runFresh(built?.ok ? built : undefined);
    const label = result.source === 'last-successful' ? '成功済みXDF' : '同梱サンプル';
    reportMachine(`新しいX68000で${label}を実行中`, false);
    setEmulatorRunning(true);
    nodes.screen.focus();
    return { ...result, build: built };
  } catch (error) {
    setEmulatorRunning(false);
    throw error;
  } finally {
    nodes.run.disabled = false;
  }
}

async function stopEmulator() {
  nodes.run.disabled = true;
  try {
    await recoveryController.stop();
    setEmulatorRunning(false);
  } finally {
    nodes.run.disabled = false;
  }
}

async function toggleEmulator() {
  return emulatorRunning ? stopEmulator() : runCurrent();
}

function showError(error) {
  nodes.buildStatus.textContent = error.message;
  nodes.buildStatus.classList.add('error');
}

function openNewFilePopup() {
  popupOpen = true;
  nodes.newFilePopup.hidden = false;
  nodes.newFileError.textContent = '';
  nodes.newPath.value = 'main.c';
  nodes.newPath.select();
}

function closeNewFilePopup() {
  popupOpen = false;
  nodes.newFilePopup.hidden = true;
  nodes.newFileError.textContent = '';
}

async function confirmNewFile() {
  try {
    const created = await createFile(nodes.newPath.value);
    if (created) closeNewFilePopup();
  } catch (error) {
    nodes.newFileError.textContent = error.message;
  }
}

/* ============================================================
 * スクリーンショット
 *
 * 画像の受け渡しは環境差が大きい。クリップボードへの画像書き込みは
 * ブラウザによって使えないことがあり、共有シートはスマホにしかない。
 * **確実に動くのはダウンロード**なので保存を主にして、コピーと共有は
 * 使える環境でだけボタンを出す（押しても何も起きないボタンは置かない）。
 * ============================================================ */
const screenshotStore = new ScreenshotStore();
let selectedShot = null;

function canCopyImage() {
  return typeof ClipboardItem === 'function' && Boolean(navigator.clipboard?.write);
}

function canShareImage() {
  return Boolean(navigator.canShare) && Boolean(navigator.share);
}

async function renderShots() {
  let records = [];
  try {
    records = await screenshotStore.list();
  } catch (error) {
    reportMachine(`スクリーンショットを読み出せません: ${error.message}`, true);
  }
  nodes.shotBar.hidden = records.length === 0;
  if (!records.some((record) => record.name === selectedShot)) {
    selectedShot = records[0]?.name ?? null;
  }
  /* 既存のサムネイルは作り直さず、必要なものだけ足し引きする。毎回まるごと
   * 差し替えると、押している最中に要素が入れ替わってクリックが消える。 */
  const wanted = new Map(records.map((record) => [record.name, record]));
  for (const element of [...nodes.shotList.children]) {
    if (!wanted.has(element.dataset.name)) {
      URL.revokeObjectURL(element.querySelector('img').src);
      element.remove();
    }
  }
  const existing = new Set([...nodes.shotList.children].map((element) => element.dataset.name));
  for (const record of records) {
    let button = nodes.shotList.querySelector(`[data-name="${CSS.escape(record.name)}"]`);
    if (!existing.has(record.name)) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'shot-thumb';
      button.dataset.name = record.name;
      button.setAttribute('role', 'option');
      const image = document.createElement('img');
      image.src = URL.createObjectURL(record.blob);
      image.alt = `${record.name}（${record.width}×${record.height}）`;
      button.append(image);
      button.addEventListener('click', () => {
        selectedShot = record.name;
        renderShots();
      });
      nodes.shotList.append(button);
    }
    button.setAttribute('aria-selected', String(record.name === selectedShot));
  }
  /* 新しい順に並べ直す（DOMの順序を records に合わせる） */
  for (const record of records) {
    const button = nodes.shotList.querySelector(`[data-name="${CSS.escape(record.name)}"]`);
    if (button) nodes.shotList.append(button);
  }
  nodes.shotCopy.hidden = !canCopyImage();
  nodes.shotShare.hidden = !canShareImage();
}

async function selectedRecord() {
  if (!selectedShot) return null;
  const records = await screenshotStore.list();
  return records.find((record) => record.name === selectedShot) ?? null;
}

async function takeScreenshot() {
  try {
    const shot = await captureCanvas(nodes.screen);
    const record = await screenshotStore.add(shot);
    selectedShot = record.name;
    await renderShots();
    reportMachine(`スクリーンショットを撮りました（${shot.width}×${shot.height}）`);
  } catch (error) {
    reportMachine(`スクリーンショットを撮れません: ${error.message}`, true);
  }
}

async function saveScreenshot() {
  const record = await selectedRecord();
  if (!record) return;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(record.blob);
  link.download = record.name;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function copyScreenshot() {
  const record = await selectedRecord();
  if (!record) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': record.blob })]);
    reportMachine('スクリーンショットをコピーしました');
  } catch (error) {
    reportMachine(`コピーできません: ${error.message}。「画像を保存」を使ってください`, true);
  }
}

async function shareScreenshot() {
  const record = await selectedRecord();
  if (!record) return;
  const file = new File([record.blob], record.name, { type: 'image/png' });
  if (!navigator.canShare({ files: [file] })) {
    reportMachine('この環境では画像の共有を使えません。「画像を保存」を使ってください', true);
    return;
  }
  try {
    await navigator.share({ files: [file] });
  } catch (error) {
    if (error.name !== 'AbortError') reportMachine(`共有できません: ${error.message}`, true);
  }
}

async function deleteScreenshot() {
  const record = await selectedRecord();
  if (!record) return;
  await screenshotStore.delete(record.name);
  selectedShot = null;
  await renderShots();
}

nodes.shoot.addEventListener('click', takeScreenshot);
nodes.shotSave.addEventListener('click', saveScreenshot);
nodes.shotCopy.addEventListener('click', copyScreenshot);
nodes.shotShare.addEventListener('click', shareScreenshot);
nodes.shotDelete.addEventListener('click', deleteScreenshot);

/* ============================================================
 * 共有リンク
 *
 * 2種類ある。**開く先も、寿命の性質も違う**。
 *   #p1= 利用者コードのバイナリ → WebX68k で遊ぶ。受け手は px68k だけでよいが、
 *        ランタイムのABI版に縛られる
 *   #s1= ソースそのもの        → Sprout68k で読む・直す。コンパイラが要るかわりに、
 *        受け取った側でコンパイルし直すので**ABI版に縛られない**
 *
 * どちらも `#` より後ろなので**サーバへは送られない**。そのぶん投稿ごとの
 * OGP画像は原理的に作れないので、画像は作者が自分で添える（スクショ機能）。
 * ============================================================ */
const WEBX68K_URL = 'https://uraraworks.github.io/WebX68k/';

async function deflateRawBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function sprout68kUrl() {
  // 受け取ったソースは、この環境自身で開く。開発サーバでも公開先でも同じ形になる。
  return `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
}

function selectedTags() {
  return [...nodes.shareTags.querySelectorAll('input:checked')].map((input) => input.value);
}

function renderShareTags() {
  if (nodes.shareTags.children.length > 0) return;
  for (const tag of SHARE_TAGS) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = tag.code;
    label.append(input, document.createTextNode(tag.label));
    nodes.shareTags.append(label);
  }
}

/** リンクを1本ぶん描く。安全圏を超えていたら、それが分かるようにする。 */
function renderShareLink(box, urlField, countField, url) {
  urlField.value = url;
  const over = url.length > SHARE_URL_SAFE_LIMIT;
  box.hidden = false;
  box.classList.toggle('over-limit', over);
  countField.textContent = over
    ? `${url.length} 文字（X では ${SHARE_URL_SAFE_LIMIT} 文字を超えるとリンクとして扱われません）`
    : `${url.length} 文字（X の目安 ${SHARE_URL_SAFE_LIMIT} 文字に収まります）`;
}

async function buildShareLinks() {
  const tab = activeTab();
  if (!tab) return;
  nodes.shareBuild.disabled = true;
  nodes.shareStatus.textContent = 'いまのソースをビルドしています…';
  try {
    await saveFile();
    const tags = selectedTags();
    const result = await adapter.buildShared({ path: tab.path, text: tab.text }, tags);
    if (!result.ok) {
      nodes.shareStatus.textContent = `ビルドに失敗しました: ${result.message}`;
      return;
    }
    renderShareLink(nodes.shareBinary, nodes.shareBinaryUrl, nodes.shareBinaryCount,
      `${WEBX68K_URL}#${result.fragment}`);

    const sourceFragment = await encodeShareFragment(
      'source', encodeSourceText(tab.text), deflateRawBytes, tags);
    renderShareLink(nodes.shareSource, nodes.shareSourceUrl, nodes.shareSourceCount,
      `${sprout68kUrl()}#${sourceFragment}`);

    nodes.shareStatus.textContent = `利用者コード ${result.userSize} バイト（ランタイムは受け取る側が持っています）`;
  } catch (error) {
    nodes.shareStatus.textContent = `ビルドに失敗しました: ${error.message}`;
  } finally {
    nodes.shareBuild.disabled = false;
  }
}

async function copyShareUrl(field) {
  const text = field.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    nodes.shareStatus.textContent = 'リンクをコピーしました';
  } catch {
    // クリップボードが使えない環境でも、選択してあれば手でコピーできる。
    field.select();
    nodes.shareStatus.textContent = 'コピーできませんでした。選択してあるので手でコピーしてください';
  }
}

async function renderShareShots() {
  let records = [];
  try {
    records = await screenshotStore.list();
  } catch { /* 画像が読めなくてもリンク作成は続けられる。 */ }
  nodes.shareShotsEmpty.hidden = records.length > 0;
  for (const element of [...nodes.shareShots.children]) {
    URL.revokeObjectURL(element.querySelector('img').src);
    element.remove();
  }
  for (const record of records) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'share-shot';
    button.dataset.buttonKind = 'text';
    button.title = record.name;
    button.setAttribute('aria-label', `${record.name} を選ぶ`);
    button.setAttribute('aria-selected', String(record.name === selectedShot));
    const image = document.createElement('img');
    image.src = URL.createObjectURL(record.blob);
    image.alt = record.name;
    button.append(image);
    button.addEventListener('click', () => { selectedShot = record.name; renderShareShots(); renderShots(); });
    nodes.shareShots.append(button);
  }
}

async function openShareDialog() {
  renderShareTags();
  nodes.shareBinary.hidden = true;
  nodes.shareSource.hidden = true;
  nodes.shareStatus.textContent = '「リンクを作る」を押すと、いまのソースをビルドします。';
  await renderShareShots();
  nodes.shareDialog.showModal();
}

nodes.share.addEventListener('click', openShareDialog);
nodes.shareBuild.addEventListener('click', buildShareLinks);
nodes.shareBinaryCopy.addEventListener('click', () => copyShareUrl(nodes.shareBinaryUrl));
nodes.shareSourceCopy.addEventListener('click', () => copyShareUrl(nodes.shareSourceUrl));

async function initialize() {
  await projectFS.open();
  await refreshFileTree();
  let restored = false;
  try {
    const value = localStorage.getItem(LAST_PATH_KEY);
    const separator = value?.indexOf(':') ?? -1;
    if (separator > 0) {
      const origin = value.slice(0, separator);
      const path = value.slice(separator + 1);
      if (origin === 'sample' || (origin === 'project' && await projectFS.read(path))) {
        await openFile(origin, path);
        restored = true;
      }
    }
  } catch {}
  if (!restored) await openFile('sample', SAMPLE_FILES[0].path);
  await adapter.initialize();
  /* 前に撮ったスクリーンショットはブラウザ内に残っているので起動時に出す。 */
  await renderShots();
  nodes.buildStatus.textContent = '編集とブラウザ内保存を利用できます';
  return true;
}

nodes.newFile.addEventListener('click', openNewFilePopup);
nodes.newPath.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); confirmNewFile(); }
  if (event.key === 'Escape') { event.preventDefault(); closeNewFilePopup(); }
});
document.addEventListener('click', (event) => {
  if (popupOpen && !nodes.newFilePopup.contains(event.target) && event.target !== nodes.newFile) closeNewFilePopup();
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveFile().catch(showError);
  }
});
nodes.save.addEventListener('click', () => saveFile().catch(showError));
nodes.download.addEventListener('click', downloadActiveFile);
nodes.downloadXdf.addEventListener('click', downloadBuiltXdf);
nodes.build.addEventListener('click', () => buildCurrent().catch(showError));
nodes.run.addEventListener('click', () => toggleEmulator().catch(showError));
nodes.screen.addEventListener('focus', () => {
  nodes.machineCard.classList.add('keyboard-active');
  nodes.keyboardStatus.textContent = 'キーボード入力: X68000へ送信中';
});
nodes.screen.addEventListener('blur', () => {
  nodes.machineCard.classList.remove('keyboard-active');
  nodes.keyboardStatus.textContent = 'キーボード入力: 実行画面をクリックすると有効';
});

const ready = initialize();
ready.catch(showError);
setEmulatorRunning(false);

window.sprout68kWorkbench = {
  ready, openFile, createFile, saveFile, closeTab, activateTab,
  buildCurrent, runCurrent, stopEmulator, toggleEmulator,
  getSplitRatio: () => splitRatio,
  setSplitRatio: (ratio) => { splitRatio = clampSplitRatio(ratio); applySplitLayout({ persist: true }); },
  getTabs: () => tabs.map((tab) => ({
    id: tab.id, origin: tab.origin, path: tab.path, active: tab.id === activeTabId, dirty: isDirty(tab),
  })),
  setConfirm: (callback) => { confirmAction = callback; },
  getStatus: () => ({ build: nodes.buildStatus.textContent, machine: nodes.machineStatus.textContent }),
  getBuiltSize: () => activeTab()?.build?.xdf?.length ?? null,
};
