/* px68k を Node から回して、画面とテキストを読む。ブラウザは使わない。
 *
 * verify/verify_*.mts が各々に持っていた起動手順を、MCP サーバーと共用する
 * ためにここへ1本化した（既存の verify は触っていない。あちらは実測の
 * 台本ごと固まっているので、動かす理由ができるまでそのままにする）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInThisContext } from 'node:vm';

/** RETROK 値（SDL retro_key enum 準拠。docs/StageE-4_実測_20260819.md）。 */
export const RETROK: Record<string, number> = {
  left: 276, right: 275, up: 273, down: 274,
  space: 32, enter: 13, escape: 27,
  a: 97, b: 98, c: 99, d: 100, e: 101, f: 102, g: 103, h: 104, i: 105, j: 106,
  k: 107, l: 108, m: 109, n: 110, o: 111, p: 112, q: 113, r: 114, s: 115, t: 116,
  u: 117, v: 118, w: 119, x: 120, y: 121, z: 122,
  '0': 48, '1': 49, '2': 50, '3': 51, '4': 52, '5': 53, '6': 54, '7': 55, '8': 56, '9': 57,
};

export interface KeyStep {
  /** RETROK のキー名（left / space / a / 1 など）。 */
  key: string;
  /** 押している間に進めるフレーム数。 */
  frames: number;
}

export interface RunResult {
  /** テキスト画面の行（IOCS $21 で出した文字はここに出る）。 */
  text: string[];
  width: number;
  height: number;
  /** 画面のRGBA（width×height×4）。描かれていなければ空。 */
  rgba: Uint8ClampedArray | null;
  /** 背景（黒）でない画素の数。0 なら何も描かれていない。 */
  drawnPixels: number;
  frames: number;
}

interface Image { width: number; height: number; data: Uint8ClampedArray }

function loadFactory(coreJs: string): any {
  (globalThis as any).__BUILD_ID__ = 'node-direct';
  const source = readFileSync(coreJs, 'utf8');
  const cjs: { exports: any } = { exports: {} };
  const wrapper = runInThisContext(
    `(function (module, exports, require, __filename, __dirname) { ${source}\n})`, { filename: coreJs },
  ) as Function;
  wrapper(cjs, cjs.exports, createRequire(coreJs), coreJs, dirname(coreJs));
  const factory = typeof cjs.exports === 'function' ? cjs.exports : cjs.exports.default;
  /* locateFile が `.wasm?v=<id>` を返すと Node の fs が ENOENT になる。素の結合に戻す。 */
  return (options?: any) => factory({ ...(options ?? {}), locateFile: (path: string, base: string) => base + path });
}

function countDrawn(image: Image | null): number {
  if (!image) return 0;
  let count = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index] > 32 || image.data[index + 1] > 32 || image.data[index + 2] > 32) count++;
  }
  return count;
}

/**
 * .xdf を起動して指定フレーム進め、画面を読む。
 *
 * keys を渡すと、順に「押す→frames 進める→離す」を繰り返す。
 * setKey() から実際に届くまで1フレームの遅延があるので、frames は 2 以上にする
 * （docs/StageE-4_実測_20260819.md）。
 */
export async function runXdf(options: {
  root: string; xdf: Uint8Array; frames?: number; keys?: KeyStep[]; timeoutMs?: number;
}): Promise<RunResult> {
  const { root, xdf } = options;
  const frames = Math.max(1, Math.min(options.frames ?? 1200, 20_000));
  const timeoutMs = options.timeoutMs ?? 120_000;
  const coreJs = resolve(root, 'ide/core/px68k_libretro.js');
  const { LibretroHost } = await import(resolve(root, 'ide/px68k/libretro-host.ts'));

  (globalThis as any).window = { PX68K: loadFactory(coreJs) };
  let lastImage: Image | null = null;
  const context = {
    createImageData(width: number, height: number) {
      const w = Math.max(0, width | 0); const h = Math.max(0, height | 0);
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(image: Image) {
      if (image && image.width > 0 && image.height > 0) lastImage = image;
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => context } as any;
  const host = new LibretroHost(canvas, () => {});
  host.setCoreOption('px68k_cpuspeed', '16Mhz');
  host.setCoreOption('px68k_ramsize', '1MB');
  host.setCoreOption('px68k_no_wait_mode', 'enabled');
  await host.init(
    new Uint8Array(readFileSync(resolve(root, 'ide/system/iplrom.dat'))),
    new Uint8Array(readFileSync(resolve(root, 'ide/system/cgrom.dat'))),
  );
  const diskPath = host.writeDiskImage('mcp.xdf', xdf);
  host.writeFile('/game/boot.cmd', new TextEncoder().encode(`px68k "${diskPath}" ""\n`));
  if (!host.loadGame('/game/boot.cmd')) throw new Error('px68k がディスクを読み込めませんでした');
  host.fetchAvInfo();

  const started = Date.now();
  const tick = () => {
    host.runFrame();
    if (Date.now() - started > timeoutMs) throw new Error(`${timeoutMs}ms を超えました`);
  };

  let total = 0;
  for (; total < frames; total++) tick();

  for (const step of options.keys ?? []) {
    const code = RETROK[step.key.toLowerCase()];
    if (code === undefined) throw new Error(`知らないキーです: ${step.key}`);
    const hold = Math.max(2, Math.min(step.frames, 3600));
    host.setKey(code, true);
    for (let index = 0; index < hold; index++) { tick(); total++; }
    host.setKey(code, false);
    /* 離したことがゲスト側のポーリングに届くまで2フレーム進める
     * （1フレームだと押し直しのときに離しが消える）。 */
    for (let index = 0; index < 2; index++) { tick(); total++; }
  }

  const dump = host.readTextScreen();
  const text: string[] = dump.available ? dump.lines.filter((line: string) => line.trim().length > 0) : [];
  const image = lastImage as Image | null;
  const result: RunResult = {
    text,
    width: image?.width ?? 0,
    height: image?.height ?? 0,
    rgba: image?.data ?? null,
    drawnPixels: countDrawn(image),
    frames: total,
  };
  host.dispose();
  return result;
}
