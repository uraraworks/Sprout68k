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

/* 自前タイムアウト: JS側のフレームループが長時間ハングしたら例外で止める。
 * Stage D の大サイズ本体(977/1231セクタ)は1セクタずつのループで数万フレーム
 * かかる(実測: 1フレームあたり約10ms)。frameCount に応じて予算を伸ばし、
 * それでも実行時間に対して十分小さい下限(45秒)は確保する(=真にハングした場合は
 * 検出できる)。 */
const DEADLINE_BASE_MS = 45_000;
const DEADLINE_MS_PER_FRAME = 20; // 実測(10ms/frame)の2倍を安全マージンとして確保
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

  const checkDeadline = makeDeadline(label, frameCount);
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

/* tools/build_stage_c.sh に fill_color を渡してイメージを生成する(ネイティブ m68k-elf-gcc でビルド) */
function buildStageCImage(outPath: string, fillColor: number): void {
  execFileSync('bash', [
    resolve(DEV_ROOT, 'tools/build_stage_c.sh'),
    `0x${fillColor.toString(16).toUpperCase().padStart(4, '0')}`,
    outPath,
  ], { cwd: DEV_ROOT });
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

  // --- 手順6: 検査自身の自己故障注入(Stage B) — Stage A(塗り処理を持たない画面)を Stage B 判定に通し、false になることを確認する ---
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

  // === Stage C: ネイティブ m68k-elf-gcc でビルドした C プログラムが .xdf で起動するか ===
  // ビルド定義: stage_c/crt0/{crt0.S,iocs.S,linker.ld}, stage_c/boot/boot.S, stage_c/src/main.c
  // ブートセクタが IOCS $46 で本体(複数セクタ)を $3000 へ読み込み JMP する。
  console.log('--- Stage C ---');
  const STAGE_C_COLOR_1 = Number(process.env.STAGE_C_COLOR_1 ?? 0xffff);
  const STAGE_C_COLOR_2 = Number(process.env.STAGE_C_COLOR_2 ?? 0x001f);
  const stageCImg1 = resolve(DEV_ROOT, 'build/stage_c_color1.xdf');
  const stageCImg2 = resolve(DEV_ROOT, 'build/stage_c_color2.xdf');
  buildStageCImage(stageCImg1, STAGE_C_COLOR_1);
  buildStageCImage(stageCImg2, STAGE_C_COLOR_2);

  const stageC1 = await bootRaw('stage_c_color1', new Uint8Array(readFileSync(stageCImg1)), FRAMES);
  const stageC2 = await bootRaw('stage_c_color2', new Uint8Array(readFileSync(stageCImg2)), FRAMES);
  console.log(summarize(stageC1));
  console.log(summarize(stageC2));

  const stageCTextOk1 = stageC1.textLines.some((l) => l.includes('STAGE C OK'));
  const stageCTextOk2 = stageC2.textLines.some((l) => l.includes('STAGE C OK'));
  console.log(`RESULT: STAGE_C_TEXT_OK color1=${stageCTextOk1} color2=${stageCTextOk2}`);

  let stageCColorOk = false;
  let cdom1: DominantColor | null = null;
  let cdom2: DominantColor | null = null;
  const stageCFailReasons: string[] = [];
  if (stageC1.lastImage && stageC2.lastImage) {
    cdom1 = dominantColor(stageC1.lastImage);
    cdom2 = dominantColor(stageC2.lastImage);
    const c1check = checkUniformFillColor(cdom1, stageADominant.rgb);
    const c2check = checkUniformFillColor(cdom2, stageADominant.rgb);
    if (!c1check.ok) stageCFailReasons.push(`fill_color=0x${STAGE_C_COLOR_1.toString(16)}: ${c1check.failedConditions.join(',')}`);
    if (!c2check.ok) stageCFailReasons.push(`fill_color=0x${STAGE_C_COLOR_2.toString(16)}: ${c2check.failedConditions.join(',')}`);
    if (cdom1.rgb === cdom2.rgb) stageCFailReasons.push(`2色の支配色が同一(${cdom1.rgb})`);
    stageCColorOk = c1check.ok && c2check.ok && cdom1.rgb !== cdom2.rgb;
  } else {
    stageCFailReasons.push('フレームバッファ未取得');
  }
  console.log(
    `RESULT: STAGE_C_COLOR_TRACKS_DIFFER=${stageCColorOk} ` +
      `color1(0x${STAGE_C_COLOR_1.toString(16)})=${cdom1?.rgb ?? 'n/a'} coverage=${cdom1?.coverage.toFixed(3) ?? 'n/a'} ` +
      `color2(0x${STAGE_C_COLOR_2.toString(16)})=${cdom2?.rgb ?? 'n/a'} coverage=${cdom2?.coverage.toFixed(3) ?? 'n/a'}` +
      (stageCColorOk ? '' : ` failed=${JSON.stringify(stageCFailReasons)}`),
  );

  const stageCFinal = stageCTextOk1 && stageCTextOk2 && stageCColorOk;
  console.log(`RESULT: STAGE_C_PASS=${stageCFinal}`);

  // --- Stage C 自己故障注入: Stage A の画面を Stage C の色判定に通して false になることを確認する ---
  const stageCSelfInjectionCheck = checkUniformFillColor(stageADominant, stageADominant.rgb);
  const stageCSelfInjectionDetected = !stageCSelfInjectionCheck.ok;
  console.log(
    `RESULT: STAGE_C_SELF_FAULT_INJECTION_DETECTED=${stageCSelfInjectionDetected} ` +
      `(Stage A の画面をStage C色判定に通した結果: ok=${stageCSelfInjectionCheck.ok} failed=${JSON.stringify(stageCSelfInjectionCheck.failedConditions)})`,
  );
  if (!stageCSelfInjectionDetected) {
    console.log('RESULT: STAGE_C_CHECKER_BROKEN — 自己故障注入で false にならなかった。検査が壊れている疑いがあるためここで異常終了する。');
    process.exitCode = 1;
    return;
  }

  // === Stage D: track/sideをまたぐ複数セクタ読み込み(既知パターン配列のチェックサム+番兵検査) ===
  // ビルド定義: stage_d/boot/boot.S, stage_d/crt0/linker.ld(stage_c/crt0/{crt0.S,iocs.S}を共用),
  // stage_d/src/{main.c,pattern_data.S}, tools/gen_pattern.py, tools/build_stage_d.sh
  console.log('--- Stage D ---');

  function buildStageDImage(outPath: string, patternBytes: number, deficit = 0): void {
    execFileSync('bash', [
      resolve(DEV_ROOT, 'tools/build_stage_d.sh'),
      String(patternBytes),
      outPath,
      String(deficit),
    ], { cwd: DEV_ROOT });
  }

  interface LoadResult {
    matched: boolean;
    ok: boolean;
    checksum: string;
    sentinel: string;
  }

  function parseLoadResult(textLines: string[]): LoadResult {
    for (const line of textLines) {
      const m = line.match(/LOAD (OK|NG) ([0-9A-Fa-f]{8}) ([0-9A-Fa-f]{8})/);
      if (m) {
        return { matched: true, ok: m[1] === 'OK', checksum: m[2], sentinel: m[3] };
      }
    }
    return { matched: false, ok: false, checksum: 'n/a', sentinel: 'n/a' };
  }

  async function runStageDCase(
    label: string,
    patternBytes: number,
    deficit: number,
    frames: number,
  ): Promise<LoadResult & { label: string }> {
    const img = resolve(DEV_ROOT, `build/stage_d_${label}.xdf`);
    buildStageDImage(img, patternBytes, deficit);
    const result = await bootRaw(`stage_d_${label}`, new Uint8Array(readFileSync(img)), frames);
    const parsed = parseLoadResult(result.textLines);
    console.log(
      `RESULT: STAGE_D_${label.toUpperCase()}=${parsed.matched ? (parsed.ok ? 'OK' : 'NG') : 'CRASH_OR_NO_OUTPUT'} ` +
        `checksum=${parsed.checksum} sentinel=${parsed.sentinel} textLines=${JSON.stringify(result.textLines)}`,
    );
    return { ...parsed, label };
  }

  const STAGE_D_FRAMES = Number(process.env.STAGE_D_FRAMES ?? FRAMES);
  // 977セクタ(約1MB)・1231セクタ(ディスク全体、本体が取り得る最大)は1セクタずつ
  // ループで読むため大量のTRAP呼び出しが必要になり、既定のSTAGE_D_FRAMESでは
  // ロード完了前にフレーム数が尽きる。実測(2026-08-19)で977セクタ=約30000フレーム、
  // 1231セクタ=約38000フレームで完了することを確認した上でこの既定値にしている。
  const STAGE_D_LARGE_FRAMES = Number(process.env.STAGE_D_LARGE_FRAMES ?? 40000);
  // 256KB(257セクタ)は既定のSTAGE_D_FRAMES(=FRAMESの既定3000)では足りない
  // (実測: 8000フレームで完了)。977/1231セクタほどではないので中間の予算を用意する。
  const STAGE_D_MEDIUM_FRAMES = Number(process.env.STAGE_D_MEDIUM_FRAMES ?? 12000);

  // 2026-08-19: 「32KB/256KB以上で失敗する」は交絡だったと判明(詳細は
  // stage_d/boot/boot.S 冒頭コメントの訂正、および docs/toolchain調査.md 参照)。
  // 真因は本体ロードアドレス($3000)と旧スタックアドレス($B000)の衝突で、
  // 本体が使える領域(32,768バイト)をちょうど使い切るサイズで壊れていた。
  // スタックを STACK_ADDR($1F0000)へ移すことで解消したため、ここではディスク全体
  // (1231セクタ)まで含めて実測する。判定条件は緩めない: LOAD OK が実際に
  // 出力された場合のみ ok=true とする。
  const dSmall = await runStageDCase('small_7168', 6000, 0, STAGE_D_FRAMES); // 7168バイト以下(退行チェック)
  const dSide = await runStageDCase('side_cross', 10000, 0, STAGE_D_FRAMES); // 8192バイト超(side境界またぎ)
  const d32k = await runStageDCase('32k', 32000, 0, STAGE_D_FRAMES); // 約32KB(旧スタック衝突点。修正の直接確認)
  const d256k = await runStageDCase('256k', 262144, 0, STAGE_D_MEDIUM_FRAMES); // 256KB以上
  const d1mb = await runStageDCase('near_1mb', 1000000, 0, STAGE_D_LARGE_FRAMES); // 約1MB(977セクタ)
  const dMax = await runStageDCase('disk_max', 1260000, 0, STAGE_D_LARGE_FRAMES); // 1231セクタ = 本体が取り得る最大(ディスク全体)

  const stageDAllSizesOk = dSmall.matched && dSmall.ok && dSide.matched && dSide.ok
    && d32k.matched && d32k.ok && d256k.matched && d256k.ok
    && d1mb.matched && d1mb.ok && dMax.matched && dMax.ok;
  console.log(
    `RESULT: STAGE_D_SIZES_SUMMARY small=${dSmall.matched && dSmall.ok} side_cross=${dSide.matched && dSide.ok} ` +
      `32k=${d32k.matched && d32k.ok} 256k=${d256k.matched && d256k.ok} near_1mb=${d1mb.matched && d1mb.ok} disk_max=${dMax.matched && dMax.ok}`,
  );

  // --- 自己故障注入(中規模): track境界をまたがない安全な範囲(20000バイトパターン=25セクタ)で、
  // ローダに読ませるセクタ数を実際より1つ少なく指定し、チェックサム判定がNGになることを確認する ---
  const dFaultInjection = await runStageDCase('fault_injection', 20000, 1, STAGE_D_FRAMES);
  const faultInjectionDetected = dFaultInjection.matched && !dFaultInjection.ok;
  console.log(
    `RESULT: STAGE_D_SELF_FAULT_INJECTION_DETECTED=${faultInjectionDetected} ` +
      `(1セクタ少なく読ませた結果: matched=${dFaultInjection.matched} ok=${dFaultInjection.ok})`,
  );
  if (!faultInjectionDetected) {
    console.log('RESULT: STAGE_D_CHECKER_BROKEN — 1セクタ少なく読ませてもNGにならなかった(またはクラッシュした)。検査が壊れている疑いがあるためここで異常終了する。');
    process.exitCode = 1;
    return;
  }

  // 25セクタ(20000バイトパターン)自体が正しいSECTOR_COUNTなら通ることも確認しておく(陽性対照)
  const dFaultControl = await runStageDCase('fault_control', 20000, 0, STAGE_D_FRAMES);
  console.log(`RESULT: STAGE_D_FAULT_CONTROL_OK=${dFaultControl.matched && dFaultControl.ok}`);

  // --- 自己故障注入(新しい最大サイズ付近): 小サイズだけで検出できても大サイズで検査が
  // 効いている証明にはならないため、1231セクタ(ディスク全体)付近でも同じ検査をする ---
  const dFaultInjectionMax = await runStageDCase('fault_injection_max', 1260000, 1, STAGE_D_LARGE_FRAMES);
  const faultInjectionMaxDetected = dFaultInjectionMax.matched && !dFaultInjectionMax.ok;
  console.log(
    `RESULT: STAGE_D_SELF_FAULT_INJECTION_MAX_DETECTED=${faultInjectionMaxDetected} ` +
      `(最大サイズ付近で1セクタ少なく読ませた結果: matched=${dFaultInjectionMax.matched} ok=${dFaultInjectionMax.ok})`,
  );
  if (!faultInjectionMaxDetected) {
    console.log('RESULT: STAGE_D_CHECKER_BROKEN_AT_MAX — 最大サイズ付近で1セクタ少なく読ませてもNGにならなかった(またはクラッシュした)。検査が壊れている疑いがあるためここで異常終了する。');
    process.exitCode = 1;
    return;
  }

  // メカニズム自体(小サイズ読み込み・side境界またぎ・故障注入検出)が機能しているかと、
  // 6サイズ要件を満たしたかは別々に報告する。
  const stageDMechanismOk = dSmall.matched && dSmall.ok && dSide.matched && dSide.ok
    && faultInjectionDetected && dFaultControl.matched && dFaultControl.ok && faultInjectionMaxDetected;
  console.log(`RESULT: STAGE_D_MECHANISM_OK=${stageDMechanismOk} (小サイズ読み込み・side境界またぎ・故障注入検出(中規模+最大サイズ付近)のみの判定)`);
  const stageDPass = stageDAllSizesOk && faultInjectionDetected && dFaultControl.matched && dFaultControl.ok && faultInjectionMaxDetected;
  console.log(`RESULT: STAGE_D_PASS=${stageDPass} (6サイズ要件+最大サイズ付近の故障注入検出を含む全体判定)`);

  if (!stageBFinal || !stageCFinal || !stageDPass) {
    process.exitCode = 1;
  }
}

await main();
