/*
 * Stage E-1: 65536色1ページモードにおける GVRAM の線形オフセット→画面座標の対応を
 * px68k(WebX68k のコア)上で実測する。ブラウザは使わず Node から直接コアを回す
 * (verify/verify.mts のコア駆動部分を踏襲。__BUILD_ID__/locateFile の2つの罠、
 * makeDeadline の自前タイムアウトは同じ実装を使う)。
 *
 * Stage E-1 は起動可否ではなく GVRAM→画面座標の対応そのものが主題なので、
 * verify.mts と違って POSITIVE_CONTROL_IMG は要求しない。
 *
 * 測定方式(推測で幅を決め打たない):
 *   1. GVRAM 先頭から N=0,1,2,255,256,257,511,512,513,767,768,769,1023,1024,1025
 *      へ、マーカーごとに異なる16bit色を1ワードずつ書いた検体を起動し、
 *      観測されたフレームバッファ上の非背景ピクセルの座標を全数で読む。
 *   2. 観測された非背景色の集合がマーカー数と過不足なく一致すること(色の潰れが
 *      無いこと)を実行時に検査する。潰れていたらその場で異常終了する。
 *   3. N の昇順とラスタ順(y→x昇順)が一致する前提で N→観測座標を対応付け、
 *      x が 0 に戻る境界(255→256 等)から候補 stride を求める。
 *   4. 候補 stride で N=0..1025 全点の座標を予測し、実測と矛盾しないか検証する
 *      (矛盾があれば「説明できなかった」と結果に出す。後から都合の良い値を選ばない)。
 *   5. 陰性対照(マーカー無し)・入力追従(オフセットをずらした2本目)をそれぞれ実測する。
 *   6. 候補 stride の倍数で縦方向のマーカーを追加投入し、下端(高さ)を実測する。
 *
 * 使い方: npx tsx verify/verify_e1.mts
 * 環境変数: WEBX68K_DIR(既定 ../WebX68k)、FRAMES(既定 3000)
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

/* 自前タイムアウト(verify.mts を踏襲)。Stage E-1 の本体は1セクタ程度で
 * Stage D のような数万フレームは要らないが、ハングに備えて同じ仕組みを入れる。 */
const DEADLINE_BASE_MS = 45_000;
const DEADLINE_MS_PER_FRAME = 20;
function makeDeadline(label: string, frameCount: number): () => void {
  const start = Date.now();
  const deadlineMs = Math.max(DEADLINE_BASE_MS, frameCount * DEADLINE_MS_PER_FRAME);
  return () => {
    if (Date.now() - start > deadlineMs) throw new Error(`${label}: ${deadlineMs}ms タイムアウト(frameCount=${frameCount})`);
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

interface Image {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

interface BootResult {
  label: string;
  textLines: string[];
  lastImage: Image | null;
}

async function bootRaw(label: string, diskBytes: Uint8Array, frameCount: number): Promise<BootResult> {
  const { LibretroHost } = await import(pathToFileURL(resolve(WEBX68K_DIR, 'src/libretro-host.ts')).href);

  (globalThis as any).window = { PX68K: loadFactory() };
  let lastImage: Image | null = null;
  const context = {
    createImageData(width: number, height: number) {
      // px68k は不正命令例外処理中に一時的に負値を含む不正なジオメトリを
      // 報告することがある(verify.mts の同名コメント参照。実測で確認済み)。
      const w = Math.max(0, width | 0);
      const h = Math.max(0, height | 0);
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(img: any) {
      if (img && img.width > 0 && img.height > 0) lastImage = img;
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => context } as any;

  const host = new LibretroHost(canvas, () => {});
  host.setCoreOption('px68k_cpuspeed', '16Mhz');
  // Stage E-1 の本体は Stage C 相当(7セクタ以内、STACK_ADDR既定$F0000)なので
  // 1MB機相当(px68k_ramsize='1MB')で実測する。
  host.setCoreOption('px68k_ramsize', '1MB');
  await host.init(new Uint8Array(readFileSync(IPL)), new Uint8Array(readFileSync(CGROM)));
  const diskPath = host.writeDiskImage(`fdd0_${label}.xdf`, diskBytes);
  host.writeFile('/game/boot.cmd', new TextEncoder().encode(`px68k "${diskPath}" ""\n`));
  if (!host.loadGame('/game/boot.cmd')) throw new Error(`${label}: loadGame失敗`);
  host.fetchAvInfo();

  const checkDeadline = makeDeadline(label, frameCount);
  for (let i = 0; i < frameCount; i++) {
    host.runFrame();
    if (i % 50 === 0) checkDeadline();
  }

  const dump = host.readTextScreen();
  const result: BootResult = {
    label,
    textLines: dump.lines.filter((l: string) => l.trim()).map((l: string) => l.replaceAll('​', '')),
    lastImage,
  };
  host.dispose();
  return result;
}

/* --- マーカー仕様・色パレット --- */

interface MarkerSpec {
  n: number; // GVRAM ワードオフセット
  color: number; // 16bit色値
}

/* 5-5-5-1(GRB555+Intensity。X68000の実機フォーマット)を仮定し、G/R/Bの5bitフィールドを
 * インデックスごとに異なる値にすることで、量子化後のRGBが潰れにくい(=区別できる)
 * ようにする。ただし「潰れないはず」という期待は検証ではない。実際に潰れていないかは
 * 起動後のフレームバッファを走査して実測で確認する(checkColorCollision)。 */
function genColor(i: number): number {
  const g = (i * 7) % 32;
  const r = (i * 11) % 32;
  const b = (i * 17) % 32;
  return ((g & 0x1f) << 11) | ((r & 0x1f) << 6) | ((b & 0x1f) << 1) | 1;
}

function specToString(markers: MarkerSpec[]): string {
  return markers.map((m) => `${m.n}:0x${m.color.toString(16).padStart(4, '0')}`).join(',');
}

function buildStageE1Image(outPath: string, markers: MarkerSpec[]): void {
  execFileSync('bash', [
    resolve(DEV_ROOT, 'tools/build_stage_e1.sh'),
    specToString(markers),
    outPath,
  ], { cwd: DEV_ROOT });
}

/* --- フレームバッファ解析 --- */

function rgbAt(img: Image, x: number, y: number): [number, number, number] {
  const idx = (y * img.width + x) * 4;
  return [img.data[idx], img.data[idx + 1], img.data[idx + 2]];
}

function rgbKey(rgb: [number, number, number]): string {
  return `${rgb[0]},${rgb[1]},${rgb[2]}`;
}

/* 背景色(negativeRgb)以外のピクセルをラスタ順(y→x昇順)に全走査して集める。
 * 同じ色が複数ピクセルに渡る場合(拡大描画・キャンバスの非整数倍スケーリング等)は
 * 色ごとに最初に出現した座標(左上優先=ラスタ順で最初)を代表点とする。 */
interface Cluster {
  rgb: string;
  firstX: number;
  firstY: number;
  pixelCount: number;
}

function scanNonBackground(img: Image, negativeRgb: string): Cluster[] {
  const clusters = new Map<string, Cluster>();
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const key = rgbKey(rgbAt(img, x, y));
      if (key === negativeRgb) continue;
      let c = clusters.get(key);
      if (!c) {
        c = { rgb: key, firstX: x, firstY: y, pixelCount: 0 };
        clusters.set(key, c);
      }
      c.pixelCount++;
    }
  }
  return [...clusters.values()].sort((a, b) => (a.firstY - b.firstY) || (a.firstX - b.firstX));
}

/* 背景色を「フレーム全体で最多の色」として決める(陰性対照画像で使う) */
function dominantRgb(img: Image): string {
  const counts = new Map<string, number>();
  for (let i = 0; i < img.data.length; i += 4) {
    const key = `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = '';
  let bestCount = -1;
  for (const [k, c] of counts) {
    if (c > bestCount) { best = k; bestCount = c; }
  }
  return best;
}

interface ObservedPoint {
  n: number;
  x: number | null; // null = 観測されなかった(画面外 or 未描画)
  y: number | null;
  rgb: string | null;
}

/* N昇順の marker 配列と、ラスタ順(y→x昇順)にソート済みの非背景クラスタを対応付ける。
 * 前提: GVRAM線形オフセットの昇順とラスタ走査順が一致する(=順序が逆転しない)。
 * クラスタ数がマーカー数と一致しない場合は対応付けをせず、全マーカーを「観測されなかった」
 * 扱いにして呼び出し側に不一致を報告させる(勝手に部分対応させない)。 */
function matchMarkersToClusters(markers: MarkerSpec[], clusters: Cluster[]): { points: ObservedPoint[]; countMismatch: boolean } {
  if (clusters.length !== markers.length) {
    return {
      points: markers.map((m) => ({ n: m.n, x: null, y: null, rgb: null })),
      countMismatch: true,
    };
  }
  const points: ObservedPoint[] = markers.map((m, i) => ({
    n: m.n,
    x: clusters[i].firstX,
    y: clusters[i].firstY,
    rgb: clusters[i].rgb,
  }));
  return { points, countMismatch: false };
}

/* 候補stride Wと基準点(x0,y0。N=0の観測座標)から、Nの予測座標を計算する */
function predict(n: number, stride: number, x0: number, y0: number): { x: number; y: number } {
  return { x: (n % stride) + x0, y: Math.floor(n / stride) + y0 };
}

async function main(): Promise<void> {
  console.log(`WEBX68K_DIR=${WEBX68K_DIR}`);
  const FRAMES = Number(process.env.FRAMES ?? 3000);

  const results: string[] = [];
  const log = (s: string) => { console.log(s); results.push(s); };

  // === 手順1: 陰性対照(マーカー無し) ===
  log('--- 陰性対照(マーカー無し) ---');
  const negImg = resolve(DEV_ROOT, 'build/stage_e1_negative.xdf');
  buildStageE1Image(negImg, []);
  const neg = await bootRaw('e1_negative', new Uint8Array(readFileSync(negImg)), FRAMES);
  log(`negative: textLines=${JSON.stringify(neg.textLines)}`);
  if (!neg.lastImage) {
    log('RESULT: E1_FATAL=フレームバッファ未取得(陰性対照)');
    process.exitCode = 1;
    return;
  }
  const backgroundRgb = dominantRgb(neg.lastImage);
  log(`negative: background_rgb=${backgroundRgb} canvas=${neg.lastImage.width}x${neg.lastImage.height}`);
  // 陰性対照そのものの検査: マーカーを1つも書いていないので、背景色以外のピクセルは
  // 1つも観測されないはず。観測されたら測定系(またはVRAM初期化)が壊れている。
  const negNonBackground = scanNonBackground(neg.lastImage, backgroundRgb);
  const negativeControlOk = negNonBackground.length === 0;
  log(`RESULT: E1_NEGATIVE_CONTROL_OK=${negativeControlOk} 非背景クラスタ数=${negNonBackground.length}` + (negativeControlOk ? '' : ` clusters=${JSON.stringify(negNonBackground)}`));
  if (!negativeControlOk) {
    log('RESULT: E1_FATAL=陰性対照でマーカー色相当の非背景ピクセルが観測された。測定系が壊れている疑いがあるためここで異常終了する。');
    process.exitCode = 1;
    return;
  }

  // === 手順2: 一次マーカー集合(候補stride/座標対応の推定用) ===
  const PRIMARY_N = [0, 1, 2, 255, 256, 257, 511, 512, 513, 767, 768, 769, 1023, 1024, 1025];
  const primaryMarkers: MarkerSpec[] = PRIMARY_N.map((n, i) => ({ n, color: genColor(i) }));
  log('--- 一次マーカー集合 ---');
  log(`primary spec: ${specToString(primaryMarkers)}`);
  const primaryImg = resolve(DEV_ROOT, 'build/stage_e1_primary.xdf');
  buildStageE1Image(primaryImg, primaryMarkers);
  const primary = await bootRaw('e1_primary', new Uint8Array(readFileSync(primaryImg)), FRAMES);
  log(`primary: textLines=${JSON.stringify(primary.textLines)}`);
  if (!primary.lastImage) {
    log('RESULT: E1_FATAL=フレームバッファ未取得(一次マーカー)');
    process.exitCode = 1;
    return;
  }

  const primaryClusters = scanNonBackground(primary.lastImage, backgroundRgb);
  log(`primary: 観測された非背景クラスタ数=${primaryClusters.length}(マーカー数=${primaryMarkers.length})`);
  log(`primary: clusters=${JSON.stringify(primaryClusters)}`);

  // --- 色の潰れ検査(必須): 観測された非背景色がすべて相異なること ---
  // scanNonBackground は Map のキー(色そのもの)でグルーピングしているため、
  // clusters.length はそのまま「観測された相異なる色の数」に等しい。
  // これがマーカー数と一致しない場合、色が潰れた(2つ以上のマーカーが同じ出力色になった)
  // か、一部マーカーが画面外で描画されなかった(または重複座標に書かれた)ことを意味する。
  const colorCollision = primaryClusters.length !== primaryMarkers.length;
  log(`RESULT: E1_COLOR_COLLISION_CHECK ok=${!colorCollision} observed_colors=${primaryClusters.length} expected=${primaryMarkers.length}`);
  if (colorCollision) {
    log('RESULT: E1_FATAL=色の潰れ、または一部マーカー未描画を検出したためここで異常終了する(対応表を作らない)。');
    process.exitCode = 1;
    return;
  }

  const { points: primaryPoints } = matchMarkersToClusters(primaryMarkers, primaryClusters);
  log('primary: N -> 観測座標 対応表');
  for (const p of primaryPoints) log(`  N=${p.n} -> (x=${p.x}, y=${p.y}) rgb=${p.rgb}`);

  // --- 色の潰れ検査そのものへの自己故障注入 ---
  // 上の primary 実測では潰れが起きなかった(検査が一度も「潰れた」を返す機会が
  // 無かった)ため、検出器自身が実際に機能するかは別途確認する。2つのマーカーに
  // わざと同一の16bit色を与え、E1_COLOR_COLLISION_CHECK が ok=false を返すことを
  // 実測する(過去に「常に成功する検出器」で空振りした実績があるため)。
  {
    const dupColor = genColor(0);
    const collisionMarkers: MarkerSpec[] = [
      { n: 0, color: dupColor },
      { n: 300, color: dupColor }, // 別の位置に同じ色を書く
      { n: 600, color: genColor(1) },
    ];
    const collisionImg = resolve(DEV_ROOT, 'build/stage_e1_collision_check.xdf');
    buildStageE1Image(collisionImg, collisionMarkers);
    const collisionBoot = await bootRaw('e1_collision_check', new Uint8Array(readFileSync(collisionImg)), FRAMES);
    let detected = false;
    let observedColors = -1;
    if (collisionBoot.lastImage) {
      const clusters = scanNonBackground(collisionBoot.lastImage, backgroundRgb);
      observedColors = clusters.length;
      // 3マーカー投入だが2つが同色なので、観測される非背景色は2種類のはず。
      detected = clusters.length !== collisionMarkers.length;
    }
    log(`RESULT: E1_COLOR_COLLISION_SELF_FAULT_INJECTION_DETECTED=${detected} (同一色2件を投入: observed_colors=${observedColors}, expected(投入数)=${collisionMarkers.length})`);
    if (!detected) {
      log('RESULT: E1_CHECKER_BROKEN=色潰れ検出器が同一色を与えても異常を検出しなかった。検査が壊れている疑いがあるためここで異常終了する。');
      process.exitCode = 1;
      return;
    }
  }

  // === 手順3: 候補strideの推定 ===
  // N,N+1 のペアで x が 0 に戻り y が+1されている境界を探す(255/256, 511/512, 767/768, 1023/1024)
  const byN = new Map(primaryPoints.map((p) => [p.n, p]));
  const boundaryCandidates = [256, 512, 768, 1024];
  const strideEvidence: { candidate: number; matched: boolean; detail: string }[] = [];
  for (const cand of boundaryCandidates) {
    const lo = byN.get(cand - 1)!;
    const hi = byN.get(cand)!;
    const matched = hi.y === (lo.y as number) + 1 && hi.x === 0;
    strideEvidence.push({ candidate: cand, matched, detail: `N=${cand - 1}->(${lo.x},${lo.y}) N=${cand}->(${hi.x},${hi.y})` });
  }
  log(`stride候補の実測: ${JSON.stringify(strideEvidence)}`);
  const matchedCandidates = strideEvidence.filter((e) => e.matched);

  // 候補のうち「他の候補の倍数になっているもの」は、真のstrideの倍数でも折り返しが
  // 起きるため一致して当然(例: stride=512なら1024=2*512でも折り返す)。これは矛盾ではなく
  // 裏付けとして扱い、matched集合の最小値を真のstride候補とする。
  let stride: number | null = null;
  if (matchedCandidates.length >= 1) {
    stride = Math.min(...matchedCandidates.map((e) => e.candidate));
    const corroborating = matchedCandidates.filter((e) => e.candidate !== stride);
    const inconsistentMultiples = corroborating.filter((e) => e.candidate % (stride as number) !== 0);
    if (inconsistentMultiples.length > 0) {
      log(`RESULT: E1_STRIDE_AMBIGUOUS=true stride候補=${stride}だが倍数関係にない一致がある: ${JSON.stringify(inconsistentMultiples)}`);
      stride = null;
    } else if (corroborating.length > 0) {
      log(`stride候補=${stride}の倍数でも折り返しを確認(裏付け): ${JSON.stringify(corroborating)}`);
    }
  } else {
    log('RESULT: E1_STRIDE_NOT_FOUND=true (255/256,511/512,767/768,1023/1024のいずれの境界でも折り返しを確認できなかった)');
  }
  log(`RESULT: E1_STRIDE_CANDIDATE=${stride ?? 'null'}`);

  // === 手順4: 原点(N=0の観測座標)と全点の自己整合性チェック ===
  const origin = byN.get(0)!;
  log(`RESULT: E1_ORIGIN x=${origin.x} y=${origin.y} (GVRAMオフセット0がフレームバッファ上で出た座標)`);

  let allConsistent = false;
  const mismatches: string[] = [];
  if (stride !== null && origin.x !== null && origin.y !== null) {
    for (const p of primaryPoints) {
      const pred = predict(p.n, stride, origin.x as number, origin.y as number);
      if (pred.x !== p.x || pred.y !== p.y) {
        mismatches.push(`N=${p.n}: predicted=(${pred.x},${pred.y}) observed=(${p.x},${p.y})`);
      }
    }
    allConsistent = mismatches.length === 0;
  }
  log(`RESULT: E1_STRIDE_SELF_CONSISTENT=${allConsistent}` + (mismatches.length ? ` mismatches=${JSON.stringify(mismatches)}` : ''));

  // === 手順5: 入力追従(オフセットをずらした2本目) ===
  log('--- 入力追従(オフセットシフト) ---');
  const SHIFT = 50;
  const shiftedMarkers: MarkerSpec[] = PRIMARY_N.map((n, i) => ({ n: n + SHIFT, color: genColor(i) }));
  const shiftedImg = resolve(DEV_ROOT, 'build/stage_e1_shifted.xdf');
  buildStageE1Image(shiftedImg, shiftedMarkers);
  const shifted = await bootRaw('e1_shifted', new Uint8Array(readFileSync(shiftedImg)), FRAMES);
  let shiftedOk = false;
  const shiftedDetails: string[] = [];
  if (shifted.lastImage && stride !== null && origin.x !== null && origin.y !== null) {
    const shiftedClusters = scanNonBackground(shifted.lastImage, backgroundRgb);
    log(`shifted: 観測された非背景クラスタ数=${shiftedClusters.length}(マーカー数=${shiftedMarkers.length})`);
    const shiftedColorCollision = shiftedClusters.length !== shiftedMarkers.length;
    if (shiftedColorCollision) {
      shiftedDetails.push(`色の潰れ、または未描画を検出(observed=${shiftedClusters.length} expected=${shiftedMarkers.length})`);
    } else {
      const { points: shiftedPoints } = matchMarkersToClusters(shiftedMarkers, shiftedClusters);
      let allMatch = true;
      for (const p of shiftedPoints) {
        const pred = predict(p.n, stride, origin.x as number, origin.y as number);
        const ok = pred.x === p.x && pred.y === p.y;
        if (!ok) allMatch = false;
        shiftedDetails.push(`N=${p.n}: predicted=(${pred.x},${pred.y}) observed=(${p.x},${p.y}) ok=${ok}`);
      }
      shiftedOk = allMatch;
    }
  } else {
    shiftedDetails.push('stride未確定、またはフレームバッファ未取得のため判定できない');
  }
  log(`RESULT: E1_INPUT_FOLLOWS=${shiftedOk} detail=${JSON.stringify(shiftedDetails)}`);

  // === 手順6: 高さ(下端)の実測。候補strideが確定していれば、その倍数でy方向を探る ===
  log('--- 高さ(下端)実測 ---');
  let heightDetails: string[] = [];
  let maxVisibleY: number | null = null;
  let heightBoundaryN: number | null = null;
  if (stride !== null) {
    const heightN = [stride * 100, stride * 511, stride * 512];
    const heightMarkers: MarkerSpec[] = heightN.map((n, i) => ({ n, color: genColor(i) }));
    const heightImg = resolve(DEV_ROOT, 'build/stage_e1_height.xdf');
    buildStageE1Image(heightImg, heightMarkers);
    const height = await bootRaw('e1_height', new Uint8Array(readFileSync(heightImg)), FRAMES);
    if (height.lastImage) {
      const heightClusters = scanNonBackground(height.lastImage, backgroundRgb);
      heightDetails.push(`観測された非背景クラスタ数=${heightClusters.length}(投入=${heightMarkers.length}) canvas=${height.lastImage.width}x${height.lastImage.height}`);
      // 高さ測定は「見えたか見えなかったか」を見るので、クラスタ数が投入数より少なくても
      // (=一部が画面外で見えなくても)想定内であり、これ自体を異常終了にはしない。
      // 見えたクラスタをラスタ順のまま報告し、どのNまで可視だったかを記録する。
      for (let i = 0; i < heightN.length; i++) {
        const predY = Math.floor(heightN[i] / stride) + (origin.y ?? 0);
        const visible = heightClusters.some((c) => c.firstY === predY);
        heightDetails.push(`N=${heightN[i]} (predicted y=${predY}): visible=${visible}`);
        if (visible) {
          if (maxVisibleY === null || predY > maxVisibleY) maxVisibleY = predY;
          if (heightBoundaryN === null || heightN[i] > heightBoundaryN) heightBoundaryN = heightN[i];
        }
      }
    } else {
      heightDetails.push('フレームバッファ未取得');
    }
  } else {
    heightDetails.push('stride未確定のため高さ測定はスキップ');
  }
  log(`RESULT: E1_HEIGHT_PROBE detail=${JSON.stringify(heightDetails)}`);
  log(`RESULT: E1_MAX_VISIBLE_Y=${maxVisibleY ?? 'null'}`);

  // === 総合判定 ===
  const overallOk = negativeControlOk && !colorCollision && stride !== null && allConsistent && shiftedOk;
  log(`RESULT: E1_PASS=${overallOk}`);
  if (!overallOk) process.exitCode = 1;

  // 機械可読な結果一式(ドキュメント生成に使う)
  console.log('---JSON---');
  console.log(JSON.stringify({
    backgroundRgb,
    negativeControlOk,
    canvas: { width: primary.lastImage.width, height: primary.lastImage.height },
    primaryPoints,
    strideEvidence,
    stride,
    origin: { x: origin.x, y: origin.y },
    allConsistent,
    mismatches,
    shiftedOk,
    shiftedDetails,
    heightDetails,
    maxVisibleY,
    colorCollision,
    overallOk,
  }, null, 2));
}

await main();
