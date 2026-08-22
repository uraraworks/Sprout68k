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
  saveState: document.querySelector('#save-state'),
  currentPath: document.querySelector('#current-path'),
  build: document.querySelector('#build'),
  downloadXdf: document.querySelector('#download-xdf'),
  run: document.querySelector('#run'),
  stopEmulator: document.querySelector('#stop-emulator'),
  recoverEmulator: document.querySelector('#recover-emulator'),
  buildStatus: document.querySelector('#build-status'),
  buildOutput: document.querySelector('#build-output'),
  machineStatus: document.querySelector('#machine-status'),
  keyboardStatus: document.querySelector('#keyboard-status'),
  machineCard: document.querySelector('.machine-card'),
  screen: document.querySelector('#x68k-screen'),
  buildId: document.querySelector('#build-id'),
  offlineStatus: document.querySelector('#offline-status'),
};

const LAST_PATH_KEY = 'x68kdev:last-path';
const X68KDEV_SCOPE_PATH = '/X68kDev/';

nodes.buildId.textContent = `build: ${__BUILD_ID__}`;
function showOfflineStatus(state, detail = '') {
  nodes.offlineStatus.textContent = state === 'ready'
    ? 'オフラインでも使えます'
    : state === 'error' ? 'オフライン準備に失敗しました' : 'オフライン: 準備中';
  nodes.offlineStatus.title = detail;
  nodes.offlineStatus.classList.toggle('error', state === 'error');
}

function checkOfflineCache(worker) {
  const channel = new MessageChannel();
  channel.port1.onmessage = ({ data }) => {
    if (data?.type === 'X68KDEV_OFFLINE_STATUS') showOfflineStatus(data.state, data.detail);
  };
  worker.postMessage({ type: 'X68KDEV_CHECK_CACHE' }, [channel.port2]);
}

function checkCurrentOfflineWorker() {
  const worker = navigator.serviceWorker.controller;
  if (worker) checkOfflineCache(worker);
}

async function initializeOfflineSupport() {
  if (!('serviceWorker' in navigator) || !location.pathname.startsWith(X68KDEV_SCOPE_PATH)) {
    showOfflineStatus('error', 'この環境ではService Workerを利用できません');
    return;
  }
  navigator.serviceWorker.addEventListener('message', ({ data }) => {
    if (data?.type === 'X68KDEV_OFFLINE_STATUS') showOfflineStatus(data.state, data.detail);
  });
  try {
    const serviceWorkerUrl = new URL('x68kdev-sw.js', `${location.origin}${X68KDEV_SCOPE_PATH}`);
    const registration = await navigator.serviceWorker.register(serviceWorkerUrl, {
      scope: X68KDEV_SCOPE_PATH,
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
    console.error('X68kDev Service Worker の登録に失敗しました', error);
    showOfflineStatus('error', detail);
  }
}
void initializeOfflineSupport();

// 開発サーバーだけでなく production build にもライセンス本文を資産として含める。
document.querySelector('#license-gpl').href = gplLicenseUrl;
document.querySelector('#license-codemirror').href = codeMirrorLicenseUrl;
document.querySelector('#license-ipl').href = iplLicenseUrl;
document.querySelector('#license-cgrom').href = cgromNoticeUrl;
const projectFS = new IndexedDbProjectFS({ databaseName: 'X68kDevProjectFS' });
let tabs = [];
let activeTabId;
let nextTabId = 1;
let loadingDocument = false;
let popupOpen = false;
let confirmAction = (message) => window.confirm(message);

function captureSourceState() {
  return JSON.stringify({
    activeTabId,
    editor: editor.state.doc.toString(),
    tabs: tabs.map(({ id, origin, path, text, savedText, cursor }) => (
      { id, origin, path, text, savedText, cursor }
    )),
  });
}

function updateRecoveryLabel() {
  nodes.recoverEmulator.textContent = recoveryController.hasSuccessfulBuild()
    ? '停止して前回成功XDFを再起動'
    : '停止して同梱サンプルを起動';
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
    if (recoveryController.rememberSuccessfulBuild(result)) updateRecoveryLabel();
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
    if (!built?.ok) return built;
    const result = await adapter.run({ xdf: built.xdf, filename: built.filename });
    nodes.screen.focus();
    return result;
  } finally {
    nodes.run.disabled = false;
  }
}

async function stopEmulator() {
  nodes.stopEmulator.disabled = true;
  try {
    await recoveryController.stop();
  } finally {
    nodes.stopEmulator.disabled = false;
  }
}

async function recoverEmulator() {
  nodes.stopEmulator.disabled = true;
  nodes.recoverEmulator.disabled = true;
  nodes.run.disabled = true;
  try {
    const result = await recoveryController.recover();
    updateRecoveryLabel();
    const label = result.source === 'last-successful' ? '前回成功XDF' : '同梱サンプル';
    reportMachine(`復帰完了: ${label}を新しいX68000で実行中`, false);
    nodes.screen.focus();
    return result;
  } finally {
    nodes.stopEmulator.disabled = false;
    nodes.recoverEmulator.disabled = false;
    nodes.run.disabled = false;
  }
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
nodes.run.addEventListener('click', () => runCurrent().catch(showError));
nodes.stopEmulator.addEventListener('click', () => stopEmulator().catch(showError));
nodes.recoverEmulator.addEventListener('click', () => recoverEmulator().catch(showError));
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

window.x68kdevWorkbench = {
  ready, openFile, createFile, saveFile, closeTab, activateTab,
  buildCurrent, runCurrent, stopEmulator, recoverEmulator,
  getTabs: () => tabs.map((tab) => ({
    id: tab.id, origin: tab.origin, path: tab.path, active: tab.id === activeTabId, dirty: isDirty(tab),
  })),
  setConfirm: (callback) => { confirmAction = callback; },
  getStatus: () => ({ build: nodes.buildStatus.textContent, machine: nodes.machineStatus.textContent }),
  getBuiltSize: () => activeTab()?.build?.xdf?.length ?? null,
};
