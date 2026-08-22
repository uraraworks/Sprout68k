#!/usr/bin/env node
/* 作例の紹介ページ ide/samples.html を組み立てる。
 *
 * 誌面の並びは、昔のパソコン雑誌の投稿プログラム紹介に倣った:
 *   画面写真 / プログラムリスト / 変数の意味 / 番号付きの解説 / 遊び方 / ひとこと
 * 構成だけを借りている（書体・配色・図版・誌名は真似していない）。
 *
 * Web なので、紙にできなかったことを2つ足してある:
 *   - リストは打ち込まなくてよい（「エディタで開く」ボタン）
 *   - 解説の番号とリストの行が対応している
 *
 * 中身の出どころ:
 *   ide/api/samples.json    解説・変数の意味・遊び方・ひとこと（手で書く）
 *   各作例の .c              プログラムリスト（**ここから読む。二重管理しない**）
 *   ide/samples/shots/*.png  画面写真（tools/capture_sample_shots.mts が実際に撮る）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Walk { title: string; points: string[] }
interface Variable { name: string; desc: string }
interface Sample {
  id: string; group: string; path: string; title: string; summary: string; learn: string;
  variables?: Variable[]; walkthrough: Walk[]; howToPlay: string; note: string;
}
interface Group { id: string; title: string; lead: string }

export function loadSamplesPageData(root = ROOT): { groups: Group[]; samples: Sample[] } {
  return JSON.parse(readFileSync(resolve(root, 'ide/api/samples.json'), 'utf8'));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** **強調** を <strong> にするだけの最小の装飾。 */
function inline(text: string): string {
  return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderSample(sample: Sample, index: number, root: string): string {
  const source = readFileSync(resolve(root, sample.path), 'utf8').trimEnd();
  const parts: string[] = [];
  parts.push(`<article class="sample" id="${sample.id}">`);
  parts.push('  <header class="sample-head">');
  parts.push(`    <div class="sample-no">${index}</div>`);
  parts.push('    <div class="sample-title">');
  parts.push(`      <h3>${escapeHtml(sample.title)}</h3>`);
  parts.push(`      <p class="sample-summary">${escapeHtml(sample.summary)}</p>`);
  parts.push('    </div>');
  parts.push(`    <div class="sample-learn"><span>おぼえること</span>${escapeHtml(sample.learn)}</div>`);
  parts.push('  </header>');

  parts.push('  <div class="sample-body">');
  parts.push('    <div class="sample-left">');
  parts.push(`      <img class="sample-shot" src="./samples/shots/${sample.id}.png" width="512" height="512"`
    + ` alt="${escapeHtml(sample.title)}の実行画面" loading="lazy">`);
  parts.push(`      <p class="sample-play"><span class="tag">遊び方</span>${inline(sample.howToPlay)}</p>`);
  if (sample.variables && sample.variables.length > 0) {
    parts.push('      <div class="sample-vars"><h4>変数の意味</h4><dl>');
    for (const variable of sample.variables) {
      parts.push(`        <dt><code>${escapeHtml(variable.name)}</code></dt><dd>${inline(variable.desc)}</dd>`);
    }
    parts.push('      </dl></div>');
  }
  parts.push('    </div>');

  parts.push('    <div class="sample-right">');
  parts.push('      <div class="sample-listing-head">');
  parts.push(`        <h4>プログラム</h4><span class="sample-path">${escapeHtml(sample.path)}</span>`);
  parts.push(`        <a class="sample-open" href="./index.html?sample=${encodeURIComponent(sample.id)}">`
    + 'エディタで開く</a>');
  parts.push('      </div>');
  parts.push(`      <pre class="sample-listing"><code>${escapeHtml(source)}</code></pre>`);
  parts.push('      <div class="sample-walk"><h4>プログラム解説</h4><ol>');
  for (const step of sample.walkthrough) {
    parts.push(`        <li><strong>${escapeHtml(step.title)}</strong><ul>`);
    for (const point of step.points) parts.push(`          <li>${inline(point)}</li>`);
    parts.push('        </ul></li>');
  }
  parts.push('      </ol></div>');
  parts.push('    </div>');
  parts.push('  </div>');
  parts.push(`  <p class="sample-note"><span class="tag">ひとこと</span>${inline(sample.note)}</p>`);
  parts.push('</article>');
  return parts.join('\n');
}

const STYLE = `
    :root {
      color-scheme: dark;
      --header: #111827; --background: #1f1f1f; --panel: #181818; --border: #334155;
      --text: #d1d5db; --dim: #9ca3af; --accent: #38bdf8; --note: #172033; --code: #16202e;
    }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: flex; flex-direction: column; color: var(--text); background: var(--background); font: 14px/1.8 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic", sans-serif; }
    .help-header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; background: var(--header); border-bottom: 1px solid var(--border); }
    .help-title { display: flex; align-items: center; gap: 9px; }
    .help-title img { width: 28px; height: 28px; }
    .help-title h1 { margin: 0; color: #f8fafc; font-size: 16px; }
    .help-actions { display: flex; align-items: center; gap: 8px; }
    .help-actions a { padding: 5px 10px; border: 1px solid #475569; border-radius: 4px; color: var(--text); background: #253044; font: inherit; font-size: 12px; text-decoration: none; }
    main { flex: 1; width: min(1080px, 100%); margin: 0 auto; padding: 20px 16px 60px; }
    h2 { margin: 34px 0 6px; padding-bottom: 6px; border-bottom: 2px solid var(--border); color: #f8fafc; font-size: 18px; }
    h4 { margin: 0 0 6px; color: #cbd5e1; font-size: 13px; }
    a { color: #7dd3fc; }
    code { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .group-lead { margin: 4px 0 18px; color: var(--dim); }
    .toc { padding: 12px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); }
    .toc ol { margin: 6px 0; padding-left: 22px; }
    .sample { margin: 0 0 26px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
    .sample-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
    .sample-no { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: #253044; color: #f8fafc; font-weight: 700; }
    .sample-title { flex: 1 1 200px; min-width: 0; }
    .sample-title h3 { margin: 0; color: #f8fafc; font-size: 16px; }
    .sample-summary { margin: 2px 0 0; color: var(--dim); font-size: 13px; }
    .sample-learn { padding: 4px 10px; border: 1px solid var(--accent); border-radius: 999px; color: #7dd3fc; font-size: 12px; }
    .sample-learn span { margin-right: 6px; color: var(--dim); }
    .sample-body { display: grid; grid-template-columns: minmax(0, 320px) minmax(0, 1fr); gap: 18px; margin-top: 14px; }
    .sample-shot { display: block; width: 100%; height: auto; border: 1px solid var(--border); border-radius: 5px; background: #000; image-rendering: pixelated; }
    .sample-play { margin: 10px 0; font-size: 13px; }
    .tag { display: inline-block; margin-right: 8px; padding: 1px 8px; border-radius: 3px; background: #253044; color: var(--dim); font-size: 11px; }
    .sample-vars dl { margin: 4px 0 0; }
    .sample-vars dt { margin-top: 6px; }
    .sample-vars dd { margin: 2px 0 0 16px; color: var(--dim); font-size: 13px; }
    .sample-listing-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
    .sample-path { flex: 1 1 auto; color: var(--dim); font-size: 12px; }
    .sample-open { padding: 3px 10px; border: 1px solid #475569; border-radius: 4px; background: #253044; font-size: 12px; text-decoration: none; }
    .sample-listing { max-height: 460px; margin: 6px 0 12px; padding: 10px 12px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--code); }
    .sample-listing code { color: #cbd5e1; white-space: pre; }
    .sample-walk ol { margin: 4px 0; padding-left: 20px; }
    .sample-walk > ol > li { margin: 10px 0; }
    .sample-walk > ol > li > strong { color: #f8fafc; }
    .sample-walk ul { margin: 4px 0; padding-left: 18px; color: var(--dim); font-size: 13px; }
    .sample-note { margin: 12px 0 0; padding: 8px 12px; border-left: 4px solid var(--accent); background: var(--note); font-size: 13px; }
    .help-footer { padding: 9px 16px; border-top: 1px solid var(--border); background: var(--panel); text-align: center; font-size: 12px; }
    @media (max-width: 760px) { .sample-body { grid-template-columns: minmax(0, 1fr); } }
    @media (max-width: 520px) { .help-header { align-items: flex-start; } .help-actions { flex-direction: column; align-items: stretch; } }
`;

export function renderSamplesPage(root = ROOT): string {
  const data = loadSamplesPageData(root);
  let counter = 0;
  const numbers = new Map<string, number>();
  for (const sample of data.samples) numbers.set(sample.id, ++counter);

  const sections = data.groups.map((group) => {
    const list = data.samples.filter((sample) => sample.group === group.id);
    return [
      `<section id="group-${group.id}">`,
      `  <h2>${escapeHtml(group.title)}</h2>`,
      `  <p class="group-lead">${escapeHtml(group.lead)}</p>`,
      ...list.map((sample) => renderSample(sample, numbers.get(sample.id)!, root)),
      '</section>',
    ].join('\n');
  }).join('\n\n');

  const toc = [
    '<nav class="toc">',
    '  <strong>もくじ</strong>',
    '  <ol>',
    ...data.samples.map((sample) => `    <li><a href="#${sample.id}">${escapeHtml(sample.title)}</a>`
      + ` — <span class="sample-summary">${escapeHtml(sample.summary)}</span></li>`),
    '  </ol>',
    '</nav>',
  ].join('\n');

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#111827">
  <link rel="icon" href="./icons/sprout68k.svg" type="image/svg+xml">
  <title>Sprout68k 作例集</title>
  <style>${STYLE}  </style>
</head>
<body>
  <header class="help-header">
    <div class="help-title">
      <img src="./icons/sprout68k.svg" alt="">
      <h1>Sprout68k 作例集</h1>
    </div>
    <div class="help-actions">
      <a href="./about.html">Sprout68kとは</a>
      <a href="./reference.html">関数リファレンス</a>
      <a href="./help.html">使い方</a>
      <a class="open-app" href="./index.html">アプリを開く</a>
    </div>
  </header>

  <main>
${toc}

${sections}
  </main>

  <footer class="help-footer">
    画面写真はどれも実際に動かして撮ったものです。
    <a class="open-app" href="./index.html">アプリを開く</a>
  </footer>

  <script>
    (function () {
      if (new URLSearchParams(location.search).get('from') === 'app') {
        var links = document.querySelectorAll('.open-app');
        for (var i = 0; i < links.length; i++) links[i].hidden = true;
      }
    })();
  </script>
</body>
</html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const html = renderSamplesPage();
  writeFileSync(resolve(ROOT, 'ide/samples.html'), html);
  console.log(`ide/samples.html を生成しました (${html.length} バイト)`);
}
