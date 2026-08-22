/*
 * Sprout68k 作例「ブロック崩し」の素のコード(samples/breakout/block.c、検証用の
 * パッチを一切当てていない版)がそれ単体でゲームとして成立することの実測。
 *
 * 背景: samples/breakout/block.c から検証用HOSTVARの書き出しと故障注入マクロを
 * 除去し、verify/patches/breakout_verify.patch を当てて検証用の版を組み立てる
 * 方式へ分離した(docs/作例breakout_20260819.md「作例と検証の分離」参照)。
 * 分離そのものが見本を壊していないかを確認するため、本スクリプトは
 * **HOSTVARを一切使わず**(素のコードには存在しないので当然)、
 * verify_panic.mts/verify_overlay.mtsと同じ「実際にレンダリングされた
 * canvas(putImageDataで捕まえたフレームバッファ)を直接読む」方式だけで、
 *   1. 起動してブロックが描画されること(ゲームが実際に開始したことの確認)
 *   2. ボールが移動していること(2時点のcanvas差分)
 *   3. ブロックが実際に消えること(ブロック領域のインク画素数が減ること)
 * を実測する。verify_breakout.mts(検証用パッチを当てた版)ほど厳密な項目
 * (パドル入力・反射・スコア突き合わせ・故障注入)は持たない。あくまで
 * 「分離した素のコードが最低限ゲームとして動くこと」の確認が目的。
 *
 * すべて同期実行。バックグラウンドに投げない。自前タイムアウト(makeDeadline)。
 *
 * 使い方: npx tsx verify/verify_breakout_plain.mts
 * 環境変数: WEBX68K_DIR(既定 ../WebX68k)、FRAME_BUDGET(既定 9000)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInThisContext } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_ROOT = resolve(HERE, '..');
const WEBX68K_DIR = resolve(DEV_ROOT, process.env.WEBX68K_DIR ?? '../WebX68k');
const CORE_JS = resolve(WEBX68K_DIR, 'public/core/px68k_libretro.js');
const IPL = resolve(WEBX68K_DIR, 'public/system/iplrom.dat');
const CGROM = resolve(WEBX68K_DIR, 'public/system/cgrom.dat');

const FRAME_BUDGET = Number(process.env.FRAME_BUDGET ?? 9000);
const CHECK_INTERVAL = 100;

const DEADLINE_BASE_MS = 60_000;
const DEADLINE_MS_PER_FRAME = 25;
function makeDeadline(label: string, frameBudget: number): () => void {
  const start = Date.now();
  const deadlineMs = Math.max(DEADLINE_BASE_MS, frameBudget * DEADLINE_MS_PER_FRAME);
  return () => {
    if (Date.now() - start > deadlineMs) throw new Error(`${label}: ${deadlineMs}ms タイムアウト(frameBudget=${frameBudget})`);
  };
}

function loadFactory(): any {
  (globalThis as any).__BUILD_ID__ = 'node-direct';
  const source = readFileSync(CORE_JS, 'utf8');
  const cjs: { exports: any } = { exports: {} };
  const wrapper = runInThisContext(
    `(function (module, exports, require, __filename, __dirname) { ${source}\n})`,
    { filename: CORE_JS },
  ) as Function;
  wrapper(cjs, cjs.exports, createRequire(CORE_JS), CORE_JS, dirname(CORE_JS));
  const factory = typeof cjs.exports === 'function' ? cjs.exports : cjs.exports.default;
  return (opts?: any) => factory({ ...(opts ?? {}), locateFile: (p: string, d: string) => d + p });
}

const CORE_OPTIONS_USED = {
  px68k_cpuspeed: '16Mhz',
  px68k_ramsize: '1MB',
  px68k_no_wait_mode: 'enabled',
};

/* --- samples/breakout/block.c と一致させること(ブロック領域の座標だけ、
 * canvas上の走査に必要) --- */
const BLOCK_ROWS = 4;
const BLOCK_COLS = 8;
const BLOCK_W = 56;
const BLOCK_H = 16;
const BLOCK_GAP_X = 4;
const BLOCK_GAP_Y = 4;
const BLOCK_X0 = 8;
const BLOCK_Y0 = 40;
const BLOCK_REGION = {
  x0: BLOCK_X0,
  y0: BLOCK_Y0,
  x1: BLOCK_X0 + (BLOCK_COLS - 1) * (BLOCK_W + BLOCK_GAP_X) + BLOCK_W,
  y1: BLOCK_Y0 + (BLOCK_ROWS - 1) * (BLOCK_H + BLOCK_GAP_Y) + BLOCK_H,
};
const BLOCK_REGION_MAX_PX = BLOCK_ROWS * BLOCK_COLS * BLOCK_W * BLOCK_H; // 28672

/* ボールがありうる範囲(ブロック領域より下、パドルより上を含む全幅)。
 * ここに限定して差分を見ることで、ブロック消滅による差分と混同しない。 */
const BALL_REGION = { x0: 0, y0: BLOCK_REGION.y1, x1: 512, y1: 512 };

/* --- GVRAM 16bit色値 <-> RGB8(verify_breakout.mtsと同じ変換式) --- */
function encode16(r: number, g: number, b: number): number {
  const g5 = (g >> 3) & 0x1f, r5 = (r >> 3) & 0x1f, b5 = (b >> 3) & 0x1f;
  return ((g5 << 11) | (r5 << 6) | (b5 << 1) | 1) >>> 0;
}
function decode16to24(color: number): [number, number, number] {
  const g5 = (color >> 11) & 0x1f;
  const r5 = (color >> 6) & 0x1f;
  const b5 = (color >> 1) & 0x1f;
  const iBit = color & 1;
  const g6 = (g5 << 1) | iBit;
  const r8 = (r5 << 3) | (r5 >> 2);
  const g8 = (g6 << 2) | (g6 >> 4);
  const b8 = (b5 << 3) | (b5 >> 2);
  return [r8, g8, b8];
}
function rgbOf(r: number, g: number, b: number): [number, number, number] {
  return decode16to24(encode16(r, g, b));
}
const COLOR_BG = rgbOf(0, 0, 0);
const PIXEL_DIST_THRESHOLD = 90;
function distRgb(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

interface Image { width: number; height: number; data: Uint8ClampedArray; }
/* 【重要】LibretroHostのputImageData()は同一のUint8ClampedArrayバッファを
 * 使い回す(毎フレーム同じオブジェクトへ上書きする)。lastImg参照をそのまま
 * 後で比較用に保持すると、後続フレームの内容で上書きされて「常に同じ画像」
 * を比較することになり、差分が常に0になる(実際にこの罠を踏んで検出した。
 * ボールが動いているのにdiff=0が続いた)。時間を跨いで比較する画像は
 * 必ずこの関数でコピーしてから保持すること。 */
function cloneImage(img: Image): Image {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}
function samplePixel(img: Image, x: number, y: number): [number, number, number] {
  const idx = (y * img.width + x) * 4;
  return [img.data[idx], img.data[idx + 1], img.data[idx + 2]];
}

/* ブロック領域内で背景色でない画素数を数える(ブロックのインク量の代理指標)。 */
function countBlockInk(img: Image): number {
  let n = 0;
  for (let y = BLOCK_REGION.y0; y < BLOCK_REGION.y1 && y < img.height; y++) {
    for (let x = BLOCK_REGION.x0; x < BLOCK_REGION.x1 && x < img.width; x++) {
      if (distRgb(samplePixel(img, x, y), COLOR_BG) > PIXEL_DIST_THRESHOLD) n++;
    }
  }
  return n;
}

function analyzeFullBlockBand(img: Image): { ink: number; rightInk: number; columnRuns: string; runCount: number } {
  const columns: number[] = [];
  let ink = 0;
  let rightInk = 0;
  for (let x = 0; x < img.width; x++) {
    let columnInk = 0;
    for (let y = BLOCK_REGION.y0; y < BLOCK_REGION.y1 && y < img.height; y++) {
      if (distRgb(samplePixel(img, x, y), COLOR_BG) > PIXEL_DIST_THRESHOLD) columnInk++;
    }
    if (columnInk > 0) {
      columns.push(x);
      ink += columnInk;
      if (x >= 512) rightInk += columnInk;
    }
  }
  const runs: string[] = [];
  for (let i = 0; i < columns.length;) {
    let j = i;
    while (j + 1 < columns.length && columns[j + 1] === columns[j] + 1) j++;
    runs.push(`${columns[i]}-${columns[j]}`);
    i = j + 1;
  }
  return { ink, rightInk, columnRuns: runs.join(','), runCount: runs.length };
}

/* BALL_REGION内で2枚のcanvasが異なる画素数を数える(ボールの移動を検出する
 * ための差分指標。パドルは入力していないので動かない前提)。 */
function countDiffInBallRegion(a: Image, b: Image): number {
  let n = 0;
  const y1 = Math.min(BALL_REGION.y1, a.height, b.height);
  const x1 = Math.min(BALL_REGION.x1, a.width, b.width);
  for (let y = BALL_REGION.y0; y < y1; y++) {
    for (let x = BALL_REGION.x0; x < x1; x++) {
      const pa = samplePixel(a, x, y);
      const pb = samplePixel(b, x, y);
      if (distRgb(pa, pb) > PIXEL_DIST_THRESHOLD) n++;
    }
  }
  return n;
}

async function main(): Promise<void> {
  const log = (s: string) => console.log(s);
  log(`WEBX68K_DIR=${WEBX68K_DIR}`);

  const imgPath = resolve(DEV_ROOT, 'build/breakout_plain.xdf');
  execFileSync('bash', [resolve(DEV_ROOT, 'tools/build_breakout_plain.sh'), imgPath, process.env.BREAKOUT_PLAIN_FAULT ?? ''], { cwd: DEV_ROOT });
  const diskBytes = new Uint8Array(readFileSync(imgPath));

  const { LibretroHost } = await import(pathToFileURL(resolve(DEV_ROOT, 'ide/px68k/libretro-host.ts')).href);
  let videoMeta = { width: 0, height: 0, pitch: 0 };
  const hostPrototype = LibretroHost.prototype as any;
  const originalVideoRefresh = hostPrototype.handleVideoRefresh;
  hostPrototype.handleVideoRefresh = function (data: number, width: number, height: number, pitch: number) {
    if (data && width && height) videoMeta = { width, height, pitch };
    return originalVideoRefresh.call(this, data, width, height, pitch);
  };
  (globalThis as any).window = { PX68K: loadFactory() };
  let lastImg: Image | null = null;
  const context = {
    createImageData(width: number, height: number) {
      const w = Math.max(0, width | 0), h = Math.max(0, height | 0);
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(img: any) {
      if (img && img.width > 0 && img.height > 0) lastImg = img;
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => context } as any;

  const host = new LibretroHost(canvas, () => {});
  host.setCoreOption('px68k_cpuspeed', CORE_OPTIONS_USED.px68k_cpuspeed);
  host.setCoreOption('px68k_ramsize', CORE_OPTIONS_USED.px68k_ramsize);
  host.setCoreOption('px68k_no_wait_mode', CORE_OPTIONS_USED.px68k_no_wait_mode);
  await host.init(new Uint8Array(readFileSync(IPL)), new Uint8Array(readFileSync(CGROM)));
  const diskPath = host.writeDiskImage('fdd0_breakout_plain.xdf', diskBytes);
  host.writeFile('/game/boot.cmd', new TextEncoder().encode(`px68k "${diskPath}" ""\n`));
  if (!host.loadGame('/game/boot.cmd')) throw new Error('loadGame失敗');
  host.fetchAvInfo();

  const checkDeadline = makeDeadline('breakout_plain', FRAME_BUDGET);

  let overallOk = true;
  const fail = (msg: string) => { log(`RESULT: BREAKOUT_PLAIN_FAIL ${msg}`); overallOk = false; };

  let started = false;
  let startFrame = -1;
  let startImg: Image | null = null;
  let startInk = 0;
  let minInkAfterStart = Infinity;
  let minInkFrame = -1;
  let ballMoved = false;
  let ballMovedFrame = -1;
  let ballMovedDiff = 0;
  let fullBandAtStart: ReturnType<typeof analyzeFullBlockBand> | null = null;
  let framebufferWidthAtStart = 0;

  // ゲーム開始(ブロック32個がフル描画された状態)を検出できるだけの十分な
  // インク量の閾値。満杯時の理論値28672に対し、アンチエイリアシング等の
  // 実測ずれを見込んで70%(約20000)をしきい値にする。
  const FULL_BLOCKS_THRESHOLD = Math.floor(BLOCK_REGION_MAX_PX * 0.7);
  // 1ブロック分(56x16=896px)の半分以上インクが減れば「少なくとも1個消えた」
  // と判定する。
  const BLOCK_LOST_THRESHOLD = Math.floor((BLOCK_W * BLOCK_H) * 0.5);

  for (let i = 0; i < FRAME_BUDGET; i++) {
    host.runFrame();
    if (i % 50 === 0) checkDeadline();
    if (i % CHECK_INTERVAL !== 0) continue;
    if (!lastImg) continue;
    const img = lastImg;

    if (!started) {
      const ink = countBlockInk(img);
      if (ink >= FULL_BLOCKS_THRESHOLD) {
        started = true;
        startFrame = i;
        startImg = cloneImage(img);
        startInk = ink;
        minInkAfterStart = ink;
        minInkFrame = i;
        const fullBand = analyzeFullBlockBand(img);
        fullBandAtStart = fullBand;
        framebufferWidthAtStart = img.width;
        log(`  game started: frame=${i} blockInk=${ink}(threshold=${FULL_BLOCKS_THRESHOLD}) fullBandInk=${fullBand.ink} rightInk=${fullBand.rightInk} columns=${fullBand.columnRuns} framebuffer=${img.width}x${img.height} pitch=${videoMeta.pitch}`);
        log(`  AV fps=${host.avInfo?.fps}`);
      }
      continue;
    }

    // ボール移動: ゲーム開始時点のcanvasと、その後の各サンプルをBALL_REGION内で
    // 比較する。閾値(20画素、ボール8x8=64画素の一部が動くだけでも十分越える)。
    if (!ballMoved && startImg) {
      const diff = countDiffInBallRegion(startImg, img);
      if (diff >= 20) {
        ballMoved = true;
        ballMovedFrame = i;
        ballMovedDiff = diff;
        log(`  ball moved: frame=${i} diffPixels=${diff}`);
      }
    }

    // ブロック消滅: ブロック領域のインク量が開始時より一定以上減っていないか。
    const ink = countBlockInk(img);
    if (ink < minInkAfterStart) {
      minInkAfterStart = ink;
      minInkFrame = i;
    }

    if (ballMoved && (startInk - minInkAfterStart) >= BLOCK_LOST_THRESHOLD) {
      log(`  both confirmed at frame=${i}, stop early`);
      break;
    }
  }

  host.dispose();

  if (!started) {
    fail(`ゲーム開始(ブロックのフル描画)を検出できなかった(FRAME_BUDGET=${FRAME_BUDGET}以内)`);
  } else {
    log(`RESULT: BREAKOUT_PLAIN_STARTED=true startFrame=${startFrame} startInk=${startInk}`);
  }

  if (started && (framebufferWidthAtStart !== 512 || fullBandAtStart?.rightInk !== 0 || fullBandAtStart?.ink !== BLOCK_REGION_MAX_PX || fullBandAtStart?.runCount !== BLOCK_COLS)) {
    fail(`ブロック帯の重複/欠落を検出(framebufferWidth=${framebufferWidthAtStart} fullBandInk=${fullBandAtStart?.ink} expected=${BLOCK_REGION_MAX_PX} rightInk=${fullBandAtStart?.rightInk} columnRuns=${fullBandAtStart?.runCount})`);
  } else if (started) {
    log(`RESULT: BREAKOUT_BLOCK_LAYOUT_UNIQUE=true count=${BLOCK_ROWS * BLOCK_COLS} ink=${fullBandAtStart?.ink} rightInk=${fullBandAtStart?.rightInk}`);
  }

  if (started && !ballMoved) {
    fail('ボールが移動したことを検出できなかった');
  } else if (started) {
    log(`RESULT: BREAKOUT_PLAIN_BALL_MOVES=true atFrame=${ballMovedFrame} diffPixels=${ballMovedDiff}`);
  }

  const inkDrop = started ? (startInk - minInkAfterStart) : 0;
  if (started && inkDrop < BLOCK_LOST_THRESHOLD) {
    fail(`ブロックが消えたことを検出できなかった(startInk=${startInk} minInk=${minInkAfterStart}(frame=${minInkFrame}) drop=${inkDrop} 必要=${BLOCK_LOST_THRESHOLD})`);
  } else if (started) {
    log(`RESULT: BREAKOUT_PLAIN_BLOCK_DESTROYED=true startInk=${startInk} minInk=${minInkAfterStart}(atFrame=${minInkFrame}) drop=${inkDrop}`);
  }

  log(`RESULT: BREAKOUT_PLAIN_OVERALL_PASS=${overallOk}`);
  if (!overallOk) process.exitCode = 1;
}

await main();
