#!/usr/bin/env node
// sprout68k-mcp — Sprout68k のプログラムを AI から書いて動かすための MCP サーバー。
//
// **ブラウザは使わない。** ビルドも実行も、この Node プロセスの中で完結する
// （px68k を直接回す）。そのため速く、結果が決定的で、タブの表示状態にも左右されない。
//
// できること:
//   api_reference  この環境で使える関数（29個）を引く
//   build          ソースをビルドして、日本語の注釈つき診断を返す
//   run            ビルドして実行し、テキスト画面・画面のPNG・描画量を返す
//   share_link     共有URLを作る（AIが作ったものと分かるよう ai タグを必ず付ける）
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// **stdout は MCP の通信路。** ビルド経路が console.log を使うので、
// ここで stderr へ逃がす（放っておくとプロトコルが壊れる）。
console.log = (...args) => console.error(...args);

const { buildSource, checkToolchain } = await import(resolve(ROOT, 'tools/build_for_mcp.mts'));
const { runXdf, RETROK } = await import(resolve(ROOT, 'tools/px68k_host.mts'));
const { encodePng } = await import(resolve(ROOT, 'tools/png.mts'));
const share = await import(resolve(ROOT, 'tools/share_v1.mts'));

const reference = JSON.parse(readFileSync(resolve(ROOT, 'ide/api/reference.json'), 'utf8'));
const deflate = (bytes) => new Uint8Array(deflateRawSync(bytes, { level: 9 }));

const textResult = (text) => ({ content: [{ type: 'text', text }] });
const jsonResult = (value) => textResult(JSON.stringify(value, null, 2));
const errorResult = (text) => ({ isError: true, content: [{ type: 'text', text }] });

/** 接続したときに読ませる型紙。ここを外すと、AI は必ず標準Cのつもりで書いて外す。 */
const INSTRUCTIONS = `Sprout68k は X68000 用の入門プログラミング環境です。ここで書く C は普通の C とは違う点があります。

## 決まった形
\`\`\`c
#include "x68.h"

void main(void) {
  /* ここに書く */
}
\`\`\`
- \`#include\` はこの1行だけ。他の標準ヘッダは使えません
- \`int main\` ではなく \`void main(void)\` です
- **小数（float / double）は使えません。** 整数だけで組み立ててください
- main から抜けると停止します。表示するだけなら \`for (;;)\` は不要です

## 絵を描く3段
1. \`x68_screen_open()\` を最初に1回
2. 描画関数で描く
3. \`x68_screen_flip()\` で画面に出す
これを飛ばすと何も出ません。座標は左上(0,0)、右下(511,511)。色は \`x68_rgb(r, g, b)\`（各0〜255）。

## 使える関数は ${reference.entries.filter((entry) => entry.kind === 'function').length} 個だけです
それ以外を呼ぶとリンクで落ちます。一覧と使い方は api_reference ツールで引いてください。
printf は使えますが %d %u %x %c %s %% だけで、**%f も %3d も使えません**（[BADFMT] と表示されます）。

## 進め方
build で診断を見て、run で実際の画面を確かめてください。推測せず、run の結果で判断できます。`;

const server = new McpServer({ name: 'sprout68k-mcp', version: '0.1.0' }, { instructions: INSTRUCTIONS });

server.tool(
  'api_reference',
  'Sprout68k で使える関数の一覧と使い方を引く。名前を指定すると、その関数の説明・引数・返り値・動く例・つまずきどころを返す。'
    + '省略すると全関数の一覧（名前と一行の要約）を返す。**推測で関数を呼ぶ前に必ずここを見ること。**',
  { name: z.string().optional().describe('関数名やマクロ名（例: x68_box_fill）。省略すると一覧') },
  async ({ name }) => {
    if (!name) {
      const byCategory = reference.categories.map((category) => ({
        分類: category.title,
        関数: reference.entries.filter((entry) => entry.category === category.id)
          .map((entry) => `${entry.signature} — ${entry.summary}`),
      }));
      return jsonResult({ 使える関数: byCategory, 補足: '詳しい説明・例・つまずきは name を指定して引く' });
    }
    const entry = reference.entries.find((item) => item.name === name);
    if (!entry) {
      const near = reference.entries.map((item) => item.name).filter((item) => item.includes(name)).slice(0, 5);
      return errorResult(`${name} という関数はありません。${near.length ? `近い名前: ${near.join(', ')}` : '一覧は name を省略して引いてください。'}`);
    }
    const wrapped = entry.example.full
      ? entry.example.code
      : `${reference.wrapper.head}${entry.example.code.split('\n').map((line) => (line ? reference.wrapper.indent + line : '')).join('\n')}\n${reference.wrapper.tail}`;
    return jsonResult({
      名前: entry.name, 書式: entry.signature, 要約: entry.summary, 説明: entry.description,
      引数: entry.params, 返り値: entry.returns, 表: entry.table ?? undefined,
      例: wrapped, 例の解説: entry.example.caption,
      つまずき: entry.pitfalls, 関連: entry.seealso,
    });
  },
);

server.tool(
  'build',
  'C のソースをビルドする。通ったかどうかと、日本語の注釈つき診断（コンパイルエラー・警告）を返す。'
    + '画面を確かめたいときは run を使うこと（build は動かさない）。',
  { source: z.string().describe('C のソース全体') },
  async ({ source }) => {
    try {
      const built = await buildSource(source);
      return jsonResult({
        成功: built.ok,
        利用者コードの大きさ: built.userSize ? `${built.userSize} バイト` : undefined,
        診断: built.diagnostics,
        注釈: built.annotations,
      });
    } catch (error) {
      return errorResult(String(error.message));
    }
  },
);

server.tool(
  'run',
  'C のソースをビルドして X68000 で実際に動かし、テキスト画面の文字・画面のPNG・描かれた画素数を返す。'
    + '**画面に何か出ているかは drawnPixels で分かる（0 なら一切描かれていない）。**'
    + 'キーを押しながら動かしたいときは keys を渡す。',
  {
    source: z.string().describe('C のソース全体'),
    frames: z.number().int().min(1).max(20000).optional().describe('キーを押す前に進めるフレーム数（既定1200。約60フレーム=1秒）'),
    keys: z.array(z.object({
      key: z.string().describe(`キー名（${Object.keys(RETROK).slice(0, 8).join(' / ')} など）`),
      frames: z.number().int().min(2).max(3600).describe('押している間に進めるフレーム数'),
    })).optional().describe('順に押して離すキー'),
    image: z.boolean().optional().describe('画面のPNGを返すか（既定 true）'),
  },
  async ({ source, frames, keys, image }) => {
    try {
      const built = await buildSource(source);
      if (!built.ok) {
        return jsonResult({ 成功: false, 診断: built.diagnostics, 注釈: built.annotations });
      }
      const result = await runXdf({ root: ROOT, xdf: built.xdf, frames, keys });
      const content = [{
        type: 'text',
        text: JSON.stringify({
          成功: true,
          利用者コードの大きさ: `${built.userSize} バイト`,
          進めたフレーム数: result.frames,
          テキスト画面: result.text,
          画面の大きさ: `${result.width}x${result.height}`,
          描かれた画素数: result.drawnPixels,
          注意: result.drawnPixels === 0
            ? 'グラフィック画面に何も描かれていません。x68_screen_open() と x68_screen_flip() を呼んでいるか確認してください'
            : undefined,
          診断: built.diagnostics.length ? built.diagnostics : undefined,
        }, null, 2),
      }];
      if (image !== false && result.rgba && result.width > 0) {
        const png = encodePng(result.width, result.height, result.rgba);
        content.push({ type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' });
      }
      return { content };
    } catch (error) {
      return errorResult(String(error.message));
    }
  },
);

server.tool(
  'share_link',
  'ソースから共有URLを作る。2種類返す: バイナリ（WebX68k で遊べる。受け手にコンパイラ不要）と'
    + 'ソース（Sprout68k で読んで直せる）。それぞれの文字数も返す（X の安全圏は4000文字）。'
    + '**AI が作ったものと分かるよう ai タグを必ず付ける。**',
  {
    source: z.string().describe('C のソース全体'),
    tags: z.array(z.enum(share.SHARE_TAGS.map((tag) => tag.code))).optional()
      .describe('追加のタグ（ai は常に付く）'),
    webx68kUrl: z.string().optional().describe('バイナリ側の開き先（既定 https://uraraworks.github.io/WebX68k/）'),
    sprout68kUrl: z.string().optional().describe('ソース側の開き先（既定 https://uraraworks.github.io/Sprout68k/ide/）'),
  },
  async ({ source, tags, webx68kUrl, sprout68kUrl }) => {
    try {
      const built = await buildSource(source);
      if (!built.ok) return jsonResult({ 成功: false, 診断: built.diagnostics });
      // ai は外せない。人間の付け忘れをなくすのがこのツールの役目。
      const allTags = share.normalizeTags(['ai', ...(tags ?? [])]);
      const binary = await share.encodeShareFragment('binary', built.payload, deflate, allTags);
      const sourceFragment = await share.encodeShareFragment('source', share.encodeSourceText(source), deflate, allTags);
      const binaryUrl = `${webx68kUrl ?? 'https://uraraworks.github.io/WebX68k/'}#${binary}`;
      const sourceUrl = `${sprout68kUrl ?? 'https://uraraworks.github.io/Sprout68k/ide/'}#${sourceFragment}`;
      const limit = share.SHARE_URL_SAFE_LIMIT;
      return jsonResult({
        遊んでもらう: { url: binaryUrl, 文字数: binaryUrl.length, 安全圏に収まる: binaryUrl.length <= limit },
        読んでもらう: { url: sourceUrl, 文字数: sourceUrl.length, 安全圏に収まる: sourceUrl.length <= limit },
        タグ: allTags,
        利用者コードの大きさ: `${built.userSize} バイト`,
        安全圏: `${limit} 文字（X ではこれを超えるとリンクとして扱われない）`,
      });
    } catch (error) {
      return errorResult(String(error.message));
    }
  },
);

try {
  checkToolchain();
} catch (error) {
  console.error(`[sprout68k-mcp] ${error.message}`);
}

await server.connect(new StdioServerTransport());
