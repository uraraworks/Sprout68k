/* ide/reference.html を組み立てる。
 *
 * 中身は2箇所に手で書く:
 *   - tools/reference/guide.html … 読み物（やりたいことから引く表・最初の1本・ゲームの形）
 *   - ide/api/reference.json     … 関数図鑑1件ぶんの説明・例・つまずき
 * このファイルは体裁を付けて1枚に合成するだけで、文章は書かない。
 * ide/api/reference.json は将来のエディタ入力補完も同じものを読む(signature /
 * summary / params)ので、図鑑の都合で機械可読性を崩さないこと。
 *
 * 生成物 ide/reference.html はコミットする(配布経路が静的ファイルを前提に
 * しているため)。最新かどうかは tools/verify_reference.mts が再生成して
 * バイト比較で確かめる。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..');

export interface ReferenceEntry {
  name: string;
  kind: string;
  category: string;
  signature: string;
  summary: string;
  description: string[];
  params: { name: string; desc: string }[];
  returns: string | null;
  example: { caption: string; code: string; full?: boolean };
  pitfalls: string[];
  seealso: string[];
  table?: { columns: string[]; groups: { title: string; rows: string[][] }[] };
}

export interface ReferenceDocument {
  version: number;
  title: string;
  source: string;
  wrapper: { head: string; tail: string; indent: string };
  categories: { id: string; title: string; lead: string }[];
  entries: ReferenceEntry[];
}

export function loadReference(root = ROOT): ReferenceDocument {
  return JSON.parse(readFileSync(resolve(root, 'ide/api/reference.json'), 'utf8')) as ReferenceDocument;
}

/** example.code を、そのままコンパイルできる1本のCソースにする。 */
export function exampleProgram(document: ReferenceDocument, entry: ReferenceEntry): string {
  if (entry.example.full) return `${entry.example.code}\n`;
  const { head, tail, indent } = document.wrapper;
  const body = entry.example.code.split('\n')
    .map((line) => (line.length === 0 ? '' : indent + line))
    .join('\n');
  return `${head}${body}\n${tail}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 説明文中の x68_foo() / X68_FOO を図鑑の該当項目へのリンクにする。 */
function linkNames(text: string, names: Set<string>): string {
  return escapeHtml(text).replace(/\b(x68_[a-z0-9_]+|X68_[A-Z0-9_]+)\b(\(\))?/g, (match, name: string, call: string | undefined) => {
    if (!names.has(name)) return match;
    return `<a href="#${name}"><code>${name}${call ?? ''}</code></a>`;
  });
}

function renderTable(table: NonNullable<ReferenceEntry['table']>): string {
  const head = `<thead><tr>${table.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>`;
  const body = table.groups.map((group) => {
    const caption = `<tr class="group"><td colspan="${table.columns.length}">${escapeHtml(group.title)}</td></tr>`;
    const rows = group.rows.map((row) => `<tr>${row.map((cell, index) => (
      index === 0 ? `<td><code>${escapeHtml(cell)}</code></td>` : `<td>${escapeHtml(cell)}</td>`
    )).join('')}</tr>`).join('\n        ');
    return `${caption}\n        ${rows}`;
  }).join('\n        ');
  return `<table class="ref-table">${head}<tbody>\n        ${body}\n      </tbody></table>`;
}

function renderEntry(document: ReferenceDocument, entry: ReferenceEntry, names: Set<string>): string {
  const parts: string[] = [];
  parts.push(`<article class="entry" id="${entry.name}">`);
  parts.push(`  <h3><code>${escapeHtml(entry.name)}</code><span class="entry-summary">${escapeHtml(entry.summary)}</span></h3>`);
  parts.push(`  <pre class="signature">${escapeHtml(entry.signature)}</pre>`);
  for (const paragraph of entry.description) parts.push(`  <p>${linkNames(paragraph, names)}</p>`);
  if (entry.params.length > 0) {
    parts.push('  <dl class="params">');
    for (const parameter of entry.params) {
      parts.push(`    <dt><code>${escapeHtml(parameter.name)}</code></dt><dd>${linkNames(parameter.desc, names)}</dd>`);
    }
    parts.push('  </dl>');
  }
  if (entry.returns) parts.push(`  <p class="returns"><span class="label">返り値</span>${linkNames(entry.returns, names)}</p>`);
  if (entry.table) parts.push(`  ${renderTable(entry.table)}`);
  parts.push('  <div class="example">');
  parts.push('    <div class="example-head">例</div>');
  parts.push(`    <pre class="listing">${escapeHtml(exampleProgram(document, entry).trimEnd())}</pre>`);
  parts.push(`    <p class="example-caption">${linkNames(entry.example.caption, names)}</p>`);
  parts.push('  </div>');
  if (entry.pitfalls.length > 0) {
    parts.push('  <ul class="pitfalls">');
    for (const pitfall of entry.pitfalls) parts.push(`    <li>${linkNames(pitfall, names)}</li>`);
    parts.push('  </ul>');
  }
  if (entry.seealso.length > 0) {
    const links = entry.seealso.map((name) => `<a href="#${name}"><code>${escapeHtml(name)}</code></a>`).join('・');
    parts.push(`  <p class="seealso"><span class="label">関連</span>${links}</p>`);
  }
  parts.push('</article>');
  return parts.join('\n');
}

const STYLE = `
    :root {
      color-scheme: dark;
      --header: #111827; --background: #1f1f1f; --panel: #181818; --border: #334155;
      --text: #d1d5db; --dim: #9ca3af; --accent: #38bdf8; --note: #172033; --code: #273244;
    }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: flex; flex-direction: column; color: var(--text); background: var(--background); font: 14px/1.8 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic", sans-serif; }
    .help-header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; background: var(--header); border-bottom: 1px solid var(--border); }
    .help-title { display: flex; align-items: center; gap: 9px; }
    .help-title img { width: 28px; height: 28px; }
    .help-title h1 { margin: 0; color: #f8fafc; font-size: 16px; }
    .help-actions { display: flex; align-items: center; gap: 8px; }
    .help-actions a { padding: 5px 10px; border: 1px solid #475569; border-radius: 4px; color: var(--text); background: #253044; font: inherit; font-size: 12px; text-decoration: none; }
    main { flex: 1; width: min(900px, 100%); margin: 0 auto; padding: 20px 16px 60px; }
    section { margin: 0 0 34px; }
    h2 { margin: 0 0 12px; padding-bottom: 6px; border-bottom: 2px solid var(--border); color: #f8fafc; font-size: 18px; }
    h3 { margin: 20px 0 6px; color: #f8fafc; font-size: 15px; }
    p, ul, ol { margin: 8px 0; }
    ul, ol { padding-left: 24px; }
    a { color: #7dd3fc; }
    code { padding: 1px 5px; border: 1px solid #475569; border-radius: 4px; background: var(--code); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    pre { margin: 10px 0; padding: 12px 14px; overflow-x: auto; border: 1px solid var(--border); border-radius: 6px; background: #16202e; font: 12px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; }
    pre.signature { margin: 6px 0 10px; padding: 8px 12px; border-left: 4px solid var(--accent); background: #101a26; color: #e2e8f0; }
    .note { margin: 12px 0; padding: 10px 14px; border-left: 4px solid var(--accent); background: var(--note); }
    table { width: 100%; margin: 10px 0; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 6px 10px; border: 1px solid var(--border); text-align: left; vertical-align: top; }
    th { background: #202b3c; color: #f8fafc; }
    tr.group td { background: #1a2330; color: var(--dim); font-weight: bold; }
    .toc { padding: 12px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); }
    .toc ul { margin: 4px 0; padding-left: 20px; }
    .entry { margin: 0 0 26px; padding: 14px 16px 4px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); }
    .entry h3 { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
    .entry h3 code { font-size: 14px; }
    .entry-summary { color: var(--dim); font-size: 13px; font-weight: normal; }
    .params { margin: 10px 0; padding: 0; }
    .params dt { margin-top: 6px; }
    .params dd { margin: 2px 0 0 20px; }
    .label { display: inline-block; margin-right: 8px; padding: 1px 7px; border-radius: 3px; background: #253044; color: var(--dim); font-size: 11px; }
    .example { margin: 12px 0 4px; }
    .example-head { color: var(--dim); font-size: 12px; }
    .example-caption { margin: 4px 0 0; color: var(--dim); font-size: 13px; }
    .pitfalls { margin: 10px 0; padding-left: 20px; list-style: none; }
    .pitfalls li { position: relative; margin: 4px 0; padding-left: 4px; }
    .pitfalls li::before { position: absolute; left: -18px; content: "\\26A0"; color: #fbbf24; }
    .walk { padding-left: 20px; }
    .walk li { margin: 6px 0; }
    .cat-lead { color: var(--dim); }
    .help-footer { padding: 9px 16px; border-top: 1px solid var(--border); background: var(--panel); text-align: center; font-size: 12px; }
    @media (max-width: 520px) { .help-header { align-items: flex-start; } .help-actions { flex-direction: column; align-items: stretch; } }
`;

export function renderReference(root = ROOT): string {
  const document_ = loadReference(root);
  const guide = readFileSync(resolve(root, 'tools/reference/guide.html'), 'utf8').trimEnd();
  const names = new Set(document_.entries.map((entry) => entry.name));

  const catalogue = document_.categories.map((category) => {
    const entries = document_.entries.filter((entry) => entry.category === category.id);
    const rendered = entries.map((entry) => renderEntry(document_, entry, names)).join('\n\n');
    return [
      `<section id="cat-${category.id}">`,
      `  <h2>${escapeHtml(category.title)}</h2>`,
      `  <p class="cat-lead">${escapeHtml(category.lead)}</p>`,
      rendered,
      '</section>',
    ].join('\n');
  }).join('\n\n');

  const toc = [
    '<nav class="toc">',
    '  <strong>もくじ</strong>',
    '  <ul>',
    '    <li><a href="#about">この本の使い方</a></li>',
    '    <li><a href="#index-by-goal">やりたいことから引く</a></li>',
    '    <li><a href="#first-program">いちばん短いプログラム</a></li>',
    '    <li><a href="#drawing">絵を描く — 3 つの決まりごと</a></li>',
    '    <li><a href="#game-loop">ゲームの形</a></li>',
    ...document_.categories.map((category) => `    <li><a href="#cat-${category.id}">${escapeHtml(category.title)}</a></li>`),
    '  </ul>',
    '</nav>',
  ].join('\n');

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#111827">
  <link rel="icon" href="./icons/sprout68k.svg" type="image/svg+xml">
  <title>${escapeHtml(document_.title)}</title>
  <style>${STYLE}  </style>
</head>
<body>
  <header class="help-header">
    <div class="help-title">
      <img src="./icons/sprout68k.svg" alt="">
      <h1>${escapeHtml(document_.title)}</h1>
    </div>
    <div class="help-actions">
      <a href="./help.html">使い方</a>
      <a class="open-app" href="./index.html">アプリを開く</a>
    </div>
  </header>

  <main>
${toc}

${guide}

${catalogue}
  </main>

  <footer class="help-footer">
    このページは ${escapeHtml(document_.source)} から作られています。
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
  const html = renderReference();
  writeFileSync(resolve(ROOT, 'ide/reference.html'), html);
  console.log(`ide/reference.html を生成しました (${html.length} バイト)`);
}
