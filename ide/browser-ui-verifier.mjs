import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function rgb(hex) {
  const match = hex.trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) throw new Error(`6桁HEX色ではありません: ${hex}`);
  return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
}

function luminance(hex) {
  const linear = rgb(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function variable(css, name) {
  const value = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  if (!value) throw new Error(`CSS色変数を取得できません: ${name}`);
  return value;
}

function colorResult(css) {
  const background = variable(css, '--vsc-editor-bg');
  const cursor = variable(css, '--vsc-cursor');
  const selection = variable(css, '--vsc-selection');
  const cursorRatio = contrast(cursor, background);
  const selectionRatio = contrast(selection, background);
  const cursorSelector = /\.cm-editor \.cm-cursor\s*\{[^}]*border-left-color:\s*var\(--vsc-cursor\)\s*!important/.test(css);
  const layerSelector = /\.cm-editor \.cm-selectionBackground/.test(css);
  const nativeSelector = /\.cm-content::selection/.test(css) && /\.cm-content ::selection/.test(css);
  return { background, cursor, selection, cursorRatio, selectionRatio, cursorSelector, layerSelector, nativeSelector };
}

function colorsPass(result) {
  return result.cursorRatio >= 3 && result.selectionRatio >= 3
    && result.cursorSelector && result.layerSelector && result.nativeSelector;
}

function pixel(css, name) {
  const value = Number(css.match(new RegExp(`${name}:\\s*(\\d+)px`))?.[1]);
  if (!Number.isFinite(value)) throw new Error(`CSS寸法を取得できません: ${name}`);
  return value;
}

function layout(css, innerHeight) {
  const header = pixel(css, '--app-header-padding') * 2 + pixel(css, '--app-title-height')
    + pixel(css, '--app-tagline-margin') + pixel(css, '--app-tagline-height');
  const footer = pixel(css, '--app-footer-height');
  const fixedWorkspace = Number(css.match(/\.workspace-grid\s*\{[^}]*height:\s*(\d+)px/)?.[1]);
  const viewportContract = /html, body\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/.test(css)
    && /\.workspace-grid\s*\{[^}]*flex:\s*1 1 0[^}]*grid-template-rows:\s*minmax\(0, 1fr\)[^}]*min-height:\s*0[^}]*overflow:\s*hidden/.test(css)
    && /\.app-footer\s*\{[^}]*flex-shrink:\s*0/.test(css);
  const workspaceHeight = Number.isFinite(fixedWorkspace) ? fixedWorkspace : Math.max(0, innerHeight - header - footer);
  const contentHeight = header + workspaceHeight + footer;
  const scrollHeight = viewportContract && !Number.isFinite(fixedWorkspace) ? innerHeight : Math.max(innerHeight, contentHeight);
  const footerTop = header + workspaceHeight;
  return { innerHeight, scrollHeight, footerTop, footerBottom: footerTop + footer, workspaceHeight, viewportContract };
}

function layoutPass(result) {
  return result.viewportContract && result.scrollHeight <= result.innerHeight
    && result.footerTop >= 0 && result.footerBottom <= result.innerHeight;
}

function iconDisplay(css, state, icon) {
  const hidingSelector = state === 'idle'
    ? '#run[data-state="idle"] [data-run-icon="stop"]'
    : '#run[data-state="running"] [data-run-icon="play"]';
  const hiddenIcon = state === 'idle' ? 'stop' : 'play';
  const hasRule = css.includes(hidingSelector)
    && new RegExp(`${hidingSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\{]*\\{\\s*display:\\s*none`).test(css);
  return icon === hiddenIcon && hasRule ? 'none' : 'inline';
}

function icons(css) {
  return {
    idle: { play: iconDisplay(css, 'idle', 'play'), stop: iconDisplay(css, 'idle', 'stop') },
    running: { play: iconDisplay(css, 'running', 'play'), stop: iconDisplay(css, 'running', 'stop') },
  };
}

function iconsPass(result) {
  return result.idle.play !== 'none' && result.idle.stop === 'none'
    && result.running.play === 'none' && result.running.stop !== 'none';
}

export async function verifyBrowserUi(root) {
  const css = await readFile(resolve(root, 'ide/workbench.css'), 'utf8');
  const html = await readFile(resolve(root, 'ide/index.html'), 'utf8');

  const colors = colorResult(css);
  if (!colorsPass(colors)) throw new Error(`カーソル／選択色のコントラスト不足: ${JSON.stringify(colors)}`);
  const blackFault = colorResult(css.replace('--vsc-cursor: #f8fafc', '--vsc-cursor: #000000')
    .replace('--vsc-selection: #3b82f6', '--vsc-selection: #000000'));
  if (colorsPass(blackFault)) throw new Error('黒カーソル／黒選択の故障注入を検出できません');
  console.log(`verify-ide: editor color cascade PASS cursor=${colors.cursor} ${colors.cursorRatio.toFixed(2)}:1, selection=${colors.selection} ${colors.selectionRatio.toFixed(2)}:1 (CM layer + native ::selection)`);
  console.log(`PASS(故障注入・編集表示): 黒カーソル／黒選択を拒否 (${blackFault.cursorRatio.toFixed(2)}:1/${blackFault.selectionRatio.toFixed(2)}:1)`);

  const layouts = [620, 900].map((height) => layout(css, height));
  if (layouts.some((result) => !layoutPass(result))) throw new Error(`高さ追従契約が不正です: ${JSON.stringify(layouts)}`);
  const fixedFault = layout(css.replace('.workspace-grid { flex: 1 1 0;', '.workspace-grid { height: 830px; flex: none;'), 620);
  if (layoutPass(fixedFault)) throw new Error('workspace高さ830px固定の故障注入を検出できません');
  console.log(`verify-ide: viewport height model PASS ${layouts.map((m) => `${m.innerHeight}:scroll=${m.scrollHeight},footer=${m.footerTop}..${m.footerBottom},workspace=${m.workspaceHeight}`).join(' / ')}`);
  console.log(`PASS(故障注入・高さ固定): 620pxでscroll=${fixedFault.scrollHeight}, footer=${fixedFault.footerTop}..${fixedFault.footerBottom}を拒否`);

  if (/data-run-icon="(?:play|stop)"[^>]*\shidden(?:\s|>|=)/.test(html)) {
    throw new Error('SVG子要素のhidden属性へ依存しています');
  }
  const displays = icons(css);
  if (!iconsPass(displays)) throw new Error(`アイコンが排他表示されません: ${JSON.stringify(displays)}`);
  const duplicateFault = icons(css.replace(/#run\[data-state="idle"\][^\n]+\{ display: none; \}/, ''));
  if (iconsPass(duplicateFault)) throw new Error('再生／停止アイコン重複の故障注入を検出できません');
  console.log(`verify-ide: icon display cascade PASS idle(play=${displays.idle.play},stop=${displays.idle.stop}) running(play=${displays.running.play},stop=${displays.running.stop})`);
  console.log(`PASS(故障注入・アイコン重複): display=${duplicateFault.idle.play}/${duplicateFault.idle.stop}の同時描画を拒否`);

  return { colors, layouts, displays };
}
