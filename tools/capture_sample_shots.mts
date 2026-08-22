#!/usr/bin/env node
/* 作例のスクリーンショットを撮る。
 *
 * 紹介ページ(ide/samples.html)の誌面に載せるため、**実際にエミュレータを
 * 走らせて撮る**。手で撮った画像を置くと、作例を直したときに古い画面が
 * 残り続ける（画像だけが嘘をつく状態になる）。
 *
 * 撮る場面（何フレーム進めるか、どのキーを押すか）は ide/api/samples.json に
 * 書く。動きのある作例は、いちばん見栄えのする瞬間を選べる。
 *
 * 生成物 ide/samples/shots/*.png はコミットする（配布物に含めるため）。
 * 最新かどうかは tools/verify_samples_page.mts が撮り直して比べる。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSource, checkToolchain } from './build_for_mcp.mts';
import { runXdf } from './px68k_host.mts';
import { encodePng } from './png.mts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SHOT_DIR = resolve(ROOT, 'ide/samples/shots');

export interface SampleShot {
  /** 何フレーム進めてから撮るか。 */
  frames: number;
  /** 撮る前に押すキー（キーを押さないと動かない作例のため）。 */
  keys?: { key: string; frames: number }[];
}

export interface SampleEntry {
  id: string;
  path: string;
  title: string;
  summary: string;
  shot: SampleShot;
  [key: string]: unknown;
}

export function loadSamples(root = ROOT): { samples: SampleEntry[] } {
  return JSON.parse(readFileSync(resolve(root, 'ide/api/samples.json'), 'utf8'));
}

/** 1本ぶん撮る。PNG のバイト列と、画面から読めた情報を返す。 */
export async function captureSample(entry: SampleEntry, root = ROOT): Promise<{
  png: Uint8Array; drawnPixels: number; text: string[]; width: number; height: number;
}> {
  const source = readFileSync(resolve(root, entry.path), 'utf8');
  const built = await buildSource(source, { root, path: `${entry.id}.c` });
  if (!built.ok) throw new Error(`${entry.id}: ビルドに失敗しました\n${built.diagnostics.join('\n')}`);
  const result = await runXdf({
    root, xdf: built.xdf!, frames: entry.shot.frames, keys: entry.shot.keys,
  });
  if (!result.rgba || result.width === 0) throw new Error(`${entry.id}: 画面を取得できませんでした`);
  return {
    png: encodePng(result.width, result.height, result.rgba),
    drawnPixels: result.drawnPixels, text: result.text,
    width: result.width, height: result.height,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`ツールチェーン: gcc ${checkToolchain()}`);
  mkdirSync(SHOT_DIR, { recursive: true });
  const { samples } = loadSamples();
  for (const entry of samples) {
    const shot = await captureSample(entry);
    writeFileSync(resolve(SHOT_DIR, `${entry.id}.png`), shot.png);
    console.log(`  ${entry.id}.png ${shot.width}x${shot.height} ${shot.png.length}B `
      + `描画${shot.drawnPixels}${shot.text.length ? ` 文字[${shot.text.join(' ')}]` : ''}`);
  }
  console.log(`${samples.length} 本を撮影した`);
}
