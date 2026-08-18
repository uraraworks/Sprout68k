/*
 * 自作ブートセクタが px68k(WebX68k のコア)で実際に起動するかを、
 * Node から直接コアを回して実測する。ブラウザは使わない。
 *
 * 参照する WebX68k のソース・IPL・CGROM は環境変数で上書き可能:
 *   WEBX68K_DIR   既定 ../WebX68k (このリポジトリの兄弟フォルダ)
 *   POSITIVE_CONTROL_IMG  陽性対照(起動するはずの第三者イメージ)のパス。必須。
 *
 * 使い方: npx tsx verify/verify.mts
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

const POSITIVE_CONTROL_IMG = process.env.POSITIVE_CONTROL_IMG;
if (!POSITIVE_CONTROL_IMG) {
  throw new Error('POSITIVE_CONTROL_IMG(陽性対照イメージのパス)を環境変数で指定してください');
}

const STAGE_A_IMG = process.env.STAGE_A_IMG ?? resolve(DEV_ROOT, 'build/stage_a.xdf');
const ZERO_IMG = process.env.ZERO_IMG ?? resolve(DEV_ROOT, 'build/zero.xdf');

/* 自前タイムアウト: JS側のフレームループが長時間ハングしたら例外で止める */
const DEADLINE_MS = 45_000;
function makeDeadline(label: string): () => void {
  const start = Date.now();
  return () => {
    if (Date.now() - start > DEADLINE_MS) throw new Error(`${label}: ${DEADLINE_MS}ms タイムアウト`);
  };
}

function loadFactory(): any {
  // 罠1: __BUILD_ID__ は vite/vitest の define なので tsx 直実行では未定義。先に置く。
  (globalThis as any).__BUILD_ID__ = 'node-direct';
  const source = readFileSync(CORE_JS, 'utf8');
  const cjs: { exports: any } = { exports: {} };
  const wrapper = runInThisContext(
    `(function (module, exports, require, __filename, __dirname) { ${source}\n})`,
    { filename: CORE_JS },
  ) as Function;
  wrapper(cjs, cjs.exports, createRequire(CORE_JS), CORE_JS, dirname(CORE_JS));
  const factory = typeof cjs.exports === 'function' ? cjs.exports : cjs.exports.default;
  // 罠2: locateFile が `.wasm?v=<id>` を返すため Node の fs が ENOENT になる。素の結合に戻す。
  return (opts?: any) => factory({ ...(opts ?? {}), locateFile: (p: string, d: string) => d + p });
}

interface BootResult {
  label: string;
  nonEmptyCells: number;
  fddReadFrames: number;
  textLines: string[];
  pixelChecksum: number;
  lastImage: { width: number; height: number; data: Uint8ClampedArray } | null;
}

/* フレームバッファのチェックサム(内容比較用。暗号強度は不要) */
function checksumPixels(data: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 7) sum = (sum * 31 + data[i]) >>> 0;
  return sum;
}

async function bootRaw(label: string, diskBytes: Uint8Array, frameCount: number): Promise<BootResult> {
  const { LibretroHost } = await import(pathToFileURL(resolve(WEBX68K_DIR, 'src/libretro-host.ts')).href);

  (globalThis as any).window = { PX68K: loadFactory() };
  let lastImage: BootResult['lastImage'] = null;
  const context = {
    createImageData(width: number, height: number) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData(img: any) { lastImage = img; },
  };
  const canvas = { width: 0, height: 0, getContext: () => context } as any;

  const host = new LibretroHost(canvas, () => {});
  host.setCoreOption('px68k_cpuspeed', '16Mhz');
  host.setCoreOption('px68k_ramsize', '2MB');
  await host.init(new Uint8Array(readFileSync(IPL)), new Uint8Array(readFileSync(CGROM)));
  const diskPath = host.writeDiskImage(`fdd0_${label}.xdf`, diskBytes);
  // fd0 に検体を直接挿す。Human68k を経由しないので fd1 は空。
  host.writeFile('/game/boot.cmd', new TextEncoder().encode(`px68k "${diskPath}" ""\n`));
  if (!host.loadGame('/game/boot.cmd')) throw new Error(`${label}: loadGame失敗`);
  host.fetchAvInfo();

  const checkDeadline = makeDeadline(label);
  let fddReadFrames = 0;
  for (let i = 0; i < frameCount; i++) {
    host.runFrame();
    if (host.readDiskAccess().fddReading) fddReadFrames++;
    if (i % 50 === 0) checkDeadline();
    if (process.env.VERBOSE && i % 200 === 0) {
      const img = lastImage as BootResult['lastImage'];
      console.log(`  [${label}] frame=${i} checksum=${img ? checksumPixels(img.data) : -1} canvas=${canvas.width}x${canvas.height} disk=${JSON.stringify(host.readDiskAccess())}`);
    }
  }

  const dump = host.readTextScreen();
  const result: BootResult = {
    label,
    nonEmptyCells: dump.diagnostics.nonEmptyCells,
    fddReadFrames,
    textLines: dump.lines.filter((l: string) => l.trim()).map((l: string) => l.replaceAll('​', '')),
    pixelChecksum: lastImage ? checksumPixels(lastImage.data) : -1,
    lastImage,
  };
  host.dispose();
  return result;
}

function summarize(r: BootResult): string {
  return `${r.label}: nonEmptyCells=${r.nonEmptyCells} fddReadFrames=${r.fddReadFrames} pixelChecksum=${r.pixelChecksum} textLines=${JSON.stringify(r.textLines)}`;
}

interface DominantColor {
  rgb: string; // "r,g,b"
  count: number;
  total: number;
  coverage: number;
  top5: Array<[string, number, string]>;
}

/*
 * フレームバッファの支配色(出現頻度最上位)を求める。
 * 旧判定はここまでしか見ておらず、それが空振りの原因だった
 * (未描画=単色でも通ってしまう。下の checkUniformFillColor で条件を補う)。
 */
function dominantColor(image: NonNullable<BootResult['lastImage']>): DominantColor {
  const { width, height, data } = image;
  const counts = new Map<string, number>();
  for (let i = 0; i < data.length; i += 4) {
    const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = width * height;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [rgb, count] = sorted[0] ?? ['n/a', 0];
  return {
    rgb,
    count,
    total,
    coverage: total ? count / total : 0,
    top5: sorted.slice(0, 5).map(([k, c]) => [k, c, (c / total).toFixed(3)]),
  };
}

interface UniformFillCheck {
  ok: boolean;
  coverage: number;
  dominantRgb: string;
  failedConditions: string[];
}

/*
 * Stage B(単色塗り)の判定。旧実装は「支配色が全体の95%超か」だけを見ており、
 * これは「未描画(真っ黒)画面」が最も強く満たしてしまう条件だった
 * (故障注入で実測済み: Stage A の画面を渡すと dominant_rgb=0,0,0 coverage=1.000 で通ってしまう)。
 *
 * 3条件すべてを満たさないと ok=true にならない:
 *   1. coverage が実質100%であること(閾値0.999。0.95は緩すぎた)
 *   2. 支配色が「未描画状態(陰性対照として渡す negativeDominantRgb)」と異なること
 *   3. (呼び出し側で)異なる fill_color を指定した2枚の支配色が互いに異なること
 * この関数は 1・2 を見る。3 は checkColorTracks() で見る。
 */
function checkUniformFillColor(dom: DominantColor, negativeDominantRgb: string): UniformFillCheck {
  const failedConditions: string[] = [];
  if (!(dom.coverage >= 0.999)) failedConditions.push(`coverage(${dom.coverage.toFixed(4)}) < 0.999`);
  if (dom.rgb === negativeDominantRgb) failedConditions.push(`dominant_rgb(${dom.rgb}) が未描画状態の支配色と同一`);
  return { ok: failedConditions.length === 0, coverage: dom.coverage, dominantRgb: dom.rgb, failedConditions };
}

/* build_stage_b.py に fill_color を渡してイメージを生成する */
function buildStageBImage(outPath: string, fillColor: number): void {
  execFileSync('python3', [
    resolve(DEV_ROOT, 'tools/build_stage_b.py'),
    outPath,
    `0x${fillColor.toString(16).toUpperCase().padStart(4, '0')}`,
  ]);
}

async function main(): Promise<void> {
  console.log(`WEBX68K_DIR=${WEBX68K_DIR}`);
  console.log(`POSITIVE_CONTROL_IMG=${POSITIVE_CONTROL_IMG}`);

  // --- 手順2: 陽性対照・陰性対照が食い違うことを先に確認する ---
  const FRAMES = Number(process.env.FRAMES ?? 3000); // 実測: 1200フレーム付近まで disk activity が始まらない
  const positive = await bootRaw('positive_control', new Uint8Array(readFileSync(POSITIVE_CONTROL_IMG)), FRAMES);
  const negative = await bootRaw('negative_control_zero', new Uint8Array(readFileSync(ZERO_IMG)), FRAMES);
  console.log(summarize(positive));
  console.log(summarize(negative));

  const identical =
    positive.pixelChecksum === negative.pixelChecksum &&
    positive.nonEmptyCells === negative.nonEmptyCells &&
    positive.fddReadFrames === negative.fddReadFrames;

  if (identical) {
    console.log('RESULT: CONTROLS_IDENTICAL — 観測系が機能していない疑い。ここで停止。');
    process.exitCode = 1;
    return;
  }
  console.log('RESULT: CONTROLS_DIFFER — 観測系は機能している。');

  // --- 手順3: Stage A ---
  const stageA = await bootRaw('stage_a', new Uint8Array(readFileSync(STAGE_A_IMG)), FRAMES);
  console.log(summarize(stageA));
  const gotMessage = stageA.textLines.some((l) => l.includes('BOOT OK'));
  console.log(`RESULT: STAGE_A_BOOT_OK=${gotMessage}`);

  if (!stageA.lastImage) {
    console.log('RESULT: STAGE_B_UNIFORM_FILL=false (Stage A のフレームバッファ未取得のため陰性対照色を決定できない)');
    process.exitCode = 1;
    return;
  }
  const stageADominant = dominantColor(stageA.lastImage);
  console.log(`stage_a: 出現頻度上位色(RGB,count,比率)=${JSON.stringify(stageADominant.top5)}`);

  // --- 手順4: Stage B(画面を1色で塗る) ---
  const STAGE_B_IMG = process.env.STAGE_B_IMG ?? resolve(DEV_ROOT, 'build/stage_b.xdf');
  const stageB = await bootRaw('stage_b', new Uint8Array(readFileSync(STAGE_B_IMG)), FRAMES);
  console.log(summarize(stageB));

  let stageBOk = false;
  if (stageB.lastImage) {
    const { width, height } = stageB.lastImage;
    const dom = dominantColor(stageB.lastImage);
    console.log(`stage_b: framebuffer=${width}x${height} total_px=${dom.total}`);
    console.log(`stage_b: 出現頻度上位色(RGB,count,比率)=${JSON.stringify(dom.top5)}`);
    const check = checkUniformFillColor(dom, stageADominant.rgb);
    stageBOk = check.ok;
    console.log(
      `RESULT: STAGE_B_UNIFORM_FILL=${check.ok} dominant_rgb=${check.dominantRgb} coverage=${check.coverage.toFixed(3)}` +
        (check.ok ? '' : ` failed=${JSON.stringify(check.failedConditions)}`),
    );
  } else {
    console.log('RESULT: STAGE_B_UNIFORM_FILL=false (フレームバッファ未取得)');
  }

  // --- 手順5: 条件3(指定色への追従) — fill_color を変えた2枚を生成して両方起動し、支配色が食い違うことを要求する ---
  const COLOR_TRACK_1 = Number(process.env.STAGE_B_COLOR_1 ?? 0xffff);
  const COLOR_TRACK_2 = Number(process.env.STAGE_B_COLOR_2 ?? 0x001f);
  const colorImg1 = resolve(DEV_ROOT, 'build/stage_b_color1.xdf');
  const colorImg2 = resolve(DEV_ROOT, 'build/stage_b_color2.xdf');
  buildStageBImage(colorImg1, COLOR_TRACK_1);
  buildStageBImage(colorImg2, COLOR_TRACK_2);
  const colorTrack1 = await bootRaw('stage_b_color1', new Uint8Array(readFileSync(colorImg1)), FRAMES);
  const colorTrack2 = await bootRaw('stage_b_color2', new Uint8Array(readFileSync(colorImg2)), FRAMES);

  let colorTrackOk = false;
  let dom1: DominantColor | null = null;
  let dom2: DominantColor | null = null;
  const colorTrackFailReasons: string[] = [];
  if (colorTrack1.lastImage && colorTrack2.lastImage) {
    dom1 = dominantColor(colorTrack1.lastImage);
    dom2 = dominantColor(colorTrack2.lastImage);
    const check1 = checkUniformFillColor(dom1, stageADominant.rgb);
    const check2 = checkUniformFillColor(dom2, stageADominant.rgb);
    if (!check1.ok) colorTrackFailReasons.push(`fill_color=0x${COLOR_TRACK_1.toString(16)}: ${check1.failedConditions.join(',')}`);
    if (!check2.ok) colorTrackFailReasons.push(`fill_color=0x${COLOR_TRACK_2.toString(16)}: ${check2.failedConditions.join(',')}`);
    if (dom1.rgb === dom2.rgb) colorTrackFailReasons.push(`2色の支配色が同一(${dom1.rgb})`);
    colorTrackOk = check1.ok && check2.ok && dom1.rgb !== dom2.rgb;
  } else {
    colorTrackFailReasons.push('フレームバッファ未取得');
  }
  console.log(
    `RESULT: STAGE_B_COLOR_TRACKS_DIFFER=${colorTrackOk} ` +
      `color1(0x${COLOR_TRACK_1.toString(16)})=${dom1?.rgb ?? 'n/a'} ` +
      `color2(0x${COLOR_TRACK_2.toString(16)})=${dom2?.rgb ?? 'n/a'}` +
      (colorTrackOk ? '' : ` failed=${JSON.stringify(colorTrackFailReasons)}`),
  );

  const stageBFinal = stageBOk && colorTrackOk;
  console.log(`RESULT: STAGE_B_PASS=${stageBFinal}`);

  // --- 手順6: 検査自身の自己故障注入 — Stage A(塗り処理を持たない画面)を Stage B 判定に通し、false になることを確認する ---
  // これは陽性対照ではない。「常に成功/失敗する検出器」で過去に空振りした実績があるため、
  // 検査が実際に失敗を検出できることをここで確認する。
  const selfInjectionCheck = checkUniformFillColor(stageADominant, stageADominant.rgb);
  const selfInjectionDetected = !selfInjectionCheck.ok;
  console.log(
    `RESULT: SELF_FAULT_INJECTION_DETECTED=${selfInjectionDetected} ` +
      `(Stage A の画面をStage B判定に通した結果: ok=${selfInjectionCheck.ok} failed=${JSON.stringify(selfInjectionCheck.failedConditions)})`,
  );
  if (!selfInjectionDetected) {
    console.log('RESULT: CHECKER_BROKEN — 自己故障注入で false にならなかった。検査が壊れている疑いがあるためここで異常終了する。');
    process.exitCode = 1;
    return;
  }

  if (!stageBFinal) {
    process.exitCode = 1;
  }
}

await main();
