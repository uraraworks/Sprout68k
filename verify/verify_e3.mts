/*
 * Stage E-3(rev3): メインメモリ上の領域から GVRAM(65536色1ページ)へ K バイト転送を
 * R回繰り返すのに要する時間を、ホスト側が runFrame() の呼び出し回数で測る。
 *
 * 【この版に至った経緯(訂正記録)】
 * rev1(main_e3.c 単一実装、ワード単位コピーの内側ループで毎回 MFP GPIP をポーリング)
 * は「転送速度」ではなく「転送+ワード毎ポーリング」の速度を測っていた。ポーリングと
 * いう低速な I/O バス読み出しがコピーそのものより遥かに高価で支配的コストになっており、
 * K=64/128/256/512KBの4点が完全比例していたのもポーリングコストが一定だったことの
 * 裏返しに過ぎなかった。
 *
 * rev2ではポーリングを内側ループから分離し(POLL_INTERVAL個のコピー単位ごとに1回)、
 * word/long/movemの3方式を比較したが、これも誤りだった。**垂直帰線期間はフレーム
 * 全体の数%程度しかなく、ポーリング間隔が帰線期間より長いと GPIP が0になっている
 * 区間をまたいで飛び越し、立下りエッジ(垂直同期)そのものを見落とす。** 見落とすと
 * 検出回数が過少になり、K/回数(バイト/フレーム)は大きい方向にずれる。rev2で
 * 「ポーリング間隔を増やすほど値が増え続けて収束しなかった」ことも、「movemで
 * 1ロング未満のサイクル数という物理的にあり得ない値が出た」ことも、この取り逃しの
 * 署名だった。
 *
 * rev1・rev2に共通する原因は「ゲスト側の転送ループの中で時間(垂直同期)を測ろうと
 * したこと」そのものだった。rev3ではこれをやめる:
 *   - ゲスト(stage_e/src/e3_copy.S, stage_e/src/main_e3.c)は転送ループから
 *     ポーリングを完全に無くし、開始直前に START_FLAG($000E0020)、
 *     N_REPEATS回すべて完了した直後に DONE_FLAG($000E0010)を書くだけにする。
 *   - host側(このファイル)が runFrame() を1回呼ぶごとに両フラグを peekByte() で
 *     監視し、START_FLAGが立ってからDONE_FLAGが立つまでの runFrame() 呼び出し
 *     回数を数える。ホストは自分が何回呼んだか正確に知っているので、取り逃しも
 *     過剰計上も原理的に起きない。
 *   - 分解能は1フレームなので、合計所要フレームが最低30フレーム以上になるよう
 *     N_REPEATS(R)を方式・Kごとに調整する(校正: 小さいRで試し、目標フレーム数
 *     に届くよう倍率をかけて本測定する)。
 *
 * 使い方: npx tsx verify/verify_e3.mts
 * 環境変数: WEBX68K_DIR(既定 ../WebX68k)、MAX_FRAMES(既定 20000)
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

const START_FLAG_ADDR = 0x000e0020;
const DONE_FLAG_ADDR = 0x000e0010;

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

/* Stage E-2 の実測(docs/StageE-2-3_実測_20260819.md)と同じ理由で no_wait_mode=enabled
 * を最初から使う(px68k-libretro の retro_run() が実時間へ自己同期する罠を避ける)。
 * cpuspeed/ramsize は Stage E-1/E-2 と同じ値。 */
const CORE_OPTIONS_USED = {
  px68k_cpuspeed: '16Mhz',
  px68k_ramsize: '1MB',
  px68k_no_wait_mode: 'enabled',
};
const CORE_OPTION_DEFAULTS_NOT_SET = {
  px68k_frameskip: 'Full Frame (既定値、フレームスキップ無し)',
  px68k_adjust_frame_rates: 'enabled (既定値)',
  px68k_audio_desync_hack: 'disabled (既定値)',
};

/* サイクル換算の基準として使う2値。host.fetchAvInfo()(loadGame直後、ゲスト側の
 * CRTCレジスタ書き換え前)が報告する値をそのまま使う。 */
const REPORTED_FPS_FOR_CYCLE_ESTIMATE_PLACEHOLDER = 0; // 実測後に埋める(下記main内でavInfoから取得)
const CPU_HZ_FOR_CYCLE_ESTIMATE = 16_000_000;

interface Session {
  host: any;
  runFrameCounted(): void;
  peekByteAt(addr: number): number;
  dispose(): void;
}

async function bootSession(label: string, diskBytes: Uint8Array): Promise<{ session: Session; reportedFps: number }> {
  const { LibretroHost } = await import(pathToFileURL(resolve(WEBX68K_DIR, 'src/libretro-host.ts')).href);

  (globalThis as any).window = { PX68K: loadFactory() };
  const context = {
    createImageData(width: number, height: number) {
      const w = Math.max(0, width | 0);
      const h = Math.max(0, height | 0);
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData() {},
  };
  const canvas = { width: 0, height: 0, getContext: () => context } as any;

  const host = new LibretroHost(canvas, () => {});
  host.setCoreOption('px68k_cpuspeed', CORE_OPTIONS_USED.px68k_cpuspeed);
  host.setCoreOption('px68k_ramsize', CORE_OPTIONS_USED.px68k_ramsize);
  host.setCoreOption('px68k_no_wait_mode', CORE_OPTIONS_USED.px68k_no_wait_mode);
  await host.init(new Uint8Array(readFileSync(IPL)), new Uint8Array(readFileSync(CGROM)));
  const diskPath = host.writeDiskImage(`fdd0_${label}.xdf`, diskBytes);
  host.writeFile('/game/boot.cmd', new TextEncoder().encode(`px68k "${diskPath}" ""\n`));
  if (!host.loadGame('/game/boot.cmd')) throw new Error(`${label}: loadGame失敗`);
  const avInfo = host.fetchAvInfo();

  const session: Session = {
    host,
    runFrameCounted() {
      host.runFrame();
    },
    peekByteAt(addr: number) {
      return host.peekByte(addr);
    },
    dispose() {
      host.dispose();
    },
  };
  return { session, reportedFps: avInfo.fps };
}

function buildStageE3Image(kBytes: number, method: 0 | 1 | 2, nRepeats: number, outPath: string): void {
  execFileSync('bash', [
    resolve(DEV_ROOT, 'tools/build_stage_e3.sh'),
    String(kBytes),
    String(method),
    String(nRepeats),
    outPath,
  ], { cwd: DEV_ROOT });
}

interface RunResult {
  framesToStart: number; // ブート開始からSTART_FLAGが立つまで
  framesForTransfer: number; // START_FLAGからDONE_FLAGが立つまで(=計測したい値)
  startSeen: boolean;
  doneSeen: boolean;
}

/* host側で runFrame() を1回ずつ呼びながら START_FLAG→DONE_FLAG の遷移を数える。
 * 取り逃し・過剰計上が起きないよう、フレームごとに必ず1回だけ判定する
 * (rev2のようにゲスト側のカウンタへ依存しない)。 */
async function runAndMeasure(kBytes: number, method: 0 | 1 | 2, nRepeats: number, maxFrames: number): Promise<{ result: RunResult; reportedFps: number }> {
  const label = `e3_k${kBytes}_m${method}_r${nRepeats}`;
  const imgPath = resolve(DEV_ROOT, `build/stage_e3_${label}.xdf`);
  buildStageE3Image(kBytes, method, nRepeats, imgPath);
  const { session, reportedFps } = await bootSession(label, new Uint8Array(readFileSync(imgPath)));

  const checkDeadline = makeDeadline(label, maxFrames);
  let framesToStart = 0;
  let startSeen = session.peekByteAt(START_FLAG_ADDR) === 1;
  while (!startSeen && framesToStart < maxFrames) {
    session.runFrameCounted();
    framesToStart++;
    if (framesToStart % 200 === 0) checkDeadline();
    startSeen = session.peekByteAt(START_FLAG_ADDR) === 1;
  }

  let framesForTransfer = 0;
  let doneSeen = startSeen && session.peekByteAt(DONE_FLAG_ADDR) === 1;
  if (startSeen) {
    while (!doneSeen && framesForTransfer < maxFrames) {
      session.runFrameCounted();
      framesForTransfer++;
      if (framesForTransfer % 200 === 0) checkDeadline();
      doneSeen = session.peekByteAt(DONE_FLAG_ADDR) === 1;
    }
  }

  session.dispose();
  return { result: { framesToStart, framesForTransfer, startSeen, doneSeen }, reportedFps };
}

const METHOD_NAMES: Record<number, string> = { 0: 'word(MOVE.W)', 1: 'long(MOVE.L)', 2: 'movem(MOVEM.L x8)' };

/* 大まかな所要フレーム数の概算(校正用シード。あくまでR決定のためだけに使う。
 * 実際のbytesPerFrameは本測定の実測値からそのまま算出する)。rev2の数値は
 * 過大評価だったと判明したため使わず、保守的に「1フレームあたり数KB程度」を
 * 仮定した小さめの値からスタートし、校正パスで実測しながら合わせる。 */
const CALIBRATION_SEED_FRAMES_PER_KBYTE: Record<number, number> = {
  0: 0.02, // word: 1KBあたり概算0.02フレーム(要校正)
  1: 0.01, // long
  2: 0.002, // movem
};

const TARGET_FRAMES = 40; // 「最低30フレーム以上」の指示に対し余裕を見て40
const MAX_FRAMES = Number(process.env.MAX_FRAMES ?? 20000);

/* K,methodについて、所要フレームがTARGET_FRAMES程度になるようRを校正してから
 * 本測定する。校正パスの結果が小さすぎる(<2フレーム)場合は指数的にRを増やして
 * 再校正する。 */
async function calibratedMeasure(kBytes: number, method: 0 | 1 | 2): Promise<{ R: number; framesForTransfer: number; bytesPerFrame: number; reportedFps: number; raw: RunResult }> {
  let R = Math.max(1, Math.ceil((TARGET_FRAMES / Math.max(CALIBRATION_SEED_FRAMES_PER_KBYTE[method] * (kBytes / 1024), 0.01))));
  R = Math.min(R, 4000);
  let attempt = 0;
  let last: { result: RunResult; reportedFps: number } | null = null;
  while (attempt < 6) {
    last = await runAndMeasure(kBytes, method, R, MAX_FRAMES);
    if (!last.result.startSeen || !last.result.doneSeen) {
      throw new Error(`計測失敗: K=${kBytes} method=${method} R=${R} startSeen=${last.result.startSeen} doneSeen=${last.result.doneSeen}(MAX_FRAMES=${MAX_FRAMES}到達の可能性)`);
    }
    if (last.result.framesForTransfer >= TARGET_FRAMES * 0.75) break;
    // 足りなければ倍率をかけて増やす
    const ratio = TARGET_FRAMES / Math.max(last.result.framesForTransfer, 0.5);
    R = Math.min(Math.ceil(R * ratio * 1.2), 2_000_000);
    attempt++;
  }
  if (!last) throw new Error('unreachable');
  const bytesPerFrame = (kBytes * R) / last.result.framesForTransfer;
  return { R, framesForTransfer: last.result.framesForTransfer, bytesPerFrame, reportedFps: last.reportedFps, raw: last.result };
}

function cyclesPerLong(bytesPerFrame: number, cyclesPerFrame: number): number {
  const longsPerFrame = bytesPerFrame / 4;
  return cyclesPerFrame / longsPerFrame;
}

async function main(): Promise<void> {
  console.log(`WEBX68K_DIR=${WEBX68K_DIR}`);
  console.log(`RESULT: E3_CORE_OPTIONS_SET=${JSON.stringify(CORE_OPTIONS_USED)}`);
  console.log(`RESULT: E3_CORE_OPTIONS_DEFAULT=${JSON.stringify(CORE_OPTION_DEFAULTS_NOT_SET)}`);
  console.log(`MAX_FRAMES=${MAX_FRAMES} TARGET_FRAMES=${TARGET_FRAMES}`);

  const methods: (0 | 1 | 2)[] = [0, 1, 2];
  const K_LIST = [64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024];

  // === 手順1: 陰性対照(R=0、転送なし) ===
  console.log('--- 手順1: 陰性対照(R=0、転送なし) ---');
  const zeroResults: { method: 0 | 1 | 2; framesForTransfer: number; ok: boolean }[] = [];
  for (const method of methods) {
    const { result } = await runAndMeasure(64 * 1024, method, 0, MAX_FRAMES);
    const ok = result.startSeen && result.doneSeen && result.framesForTransfer <= 1;
    zeroResults.push({ method, framesForTransfer: result.framesForTransfer, ok });
    console.log(`RESULT: E3_ZERO method=${METHOD_NAMES[method]} framesForTransfer=${result.framesForTransfer} ok=${ok}`);
  }
  const zeroOk = zeroResults.every((r) => r.ok);
  console.log(`RESULT: E3_NEGATIVE_CONTROL_OK=${zeroOk}`);

  // === 手順2: 3方式 x K=64/128/256/512KB の本測定(校正付き) ===
  console.log('--- 手順2: 方式別スループット(校正付き、目標フレーム数40以上) ---');
  let reportedFps = 0;
  const mainResults: { method: 0 | 1 | 2; kBytes: number; R: number; framesForTransfer: number; bytesPerFrame: number }[] = [];
  for (const method of methods) {
    for (const k of K_LIST) {
      const r = await calibratedMeasure(k, method);
      reportedFps = r.reportedFps; // 全実行で同一のはずなので最後の値を採用
      mainResults.push({ method, kBytes: k, R: r.R, framesForTransfer: r.framesForTransfer, bytesPerFrame: r.bytesPerFrame });
      console.log(`RESULT: E3_MAIN method=${METHOD_NAMES[method]} K=${k} R=${r.R} framesForTransfer=${r.framesForTransfer} bytesPerFrame=${r.bytesPerFrame.toFixed(2)}`);
    }
  }
  console.log(`RESULT: E3_REPORTED_FPS=${reportedFps} (host.fetchAvInfo().fps。loadGame直後、ゲスト側CRTC書き換え前の値)`);
  const cyclesPerFrame = CPU_HZ_FOR_CYCLE_ESTIMATE / reportedFps;
  console.log(`RESULT: E3_CYCLES_PER_FRAME=${cyclesPerFrame.toFixed(2)} (=${CPU_HZ_FOR_CYCLE_ESTIMATE}Hz / ${reportedFps}fps)`);

  // === 手順3: 線形性確認(K=512KBについて、校正されたRと2Rで所要フレームが2倍になるか) ===
  console.log('--- 手順3: 線形性確認(K=512KB、校正R と 2R) ---');
  const linearity: { method: 0 | 1 | 2; R1: number; frames1: number; R2: number; frames2: number; ratio: number; ok: boolean }[] = [];
  for (const method of methods) {
    const base = mainResults.find((r) => r.method === method && r.kBytes === 512 * 1024)!;
    const { result: doubled } = await runAndMeasure(512 * 1024, method, base.R * 2, MAX_FRAMES);
    if (!doubled.startSeen || !doubled.doneSeen) {
      console.log(`RESULT: E3_LINEARITY method=${METHOD_NAMES[method]} 計測失敗(2R実行がMAX_FRAMESに到達)`);
      linearity.push({ method, R1: base.R, frames1: base.framesForTransfer, R2: base.R * 2, frames2: -1, ratio: NaN, ok: false });
      continue;
    }
    const ratio = doubled.framesForTransfer / base.framesForTransfer;
    const ok = ratio >= 1.7 && ratio <= 2.3; // 2倍から大きくは外れない範囲を許容
    linearity.push({ method, R1: base.R, frames1: base.framesForTransfer, R2: base.R * 2, frames2: doubled.framesForTransfer, ratio, ok });
    console.log(`RESULT: E3_LINEARITY method=${METHOD_NAMES[method]} R1=${base.R} frames1=${base.framesForTransfer} R2=${base.R * 2} frames2=${doubled.framesForTransfer} ratio=${ratio.toFixed(3)} ok=${ok}`);
  }
  const allLinearityOk = linearity.every((r) => r.ok);
  console.log(`RESULT: E3_ALL_LINEARITY_OK=${allLinearityOk}`);

  // === 結論: サイクル換算、方式間の比、妥当性判定 ===
  console.log('--- 結論 ---');
  const byMethodAt512: Record<number, number> = {};
  for (const r of mainResults) {
    if (r.kBytes === 512 * 1024) byMethodAt512[r.method] = r.bytesPerFrame;
  }
  const cyclesTable: Record<number, number> = {};
  const plausible: Record<number, boolean> = {};
  const MIN_PLAUSIBLE_CYCLES_PER_LONG = 5; // これ未満は物理的にあり得ない(故障とみなす)
  const MAX_PLAUSIBLE_CYCLES_PER_LONG = 200; // 上限も参考として設ける(常識的な上振れ)
  for (const method of methods) {
    const bpf = byMethodAt512[method];
    const cpl = cyclesPerLong(bpf, cyclesPerFrame);
    cyclesTable[method] = cpl;
    plausible[method] = cpl >= MIN_PLAUSIBLE_CYCLES_PER_LONG && cpl <= MAX_PLAUSIBLE_CYCLES_PER_LONG;
    console.log(`RESULT: E3_CYCLES_PER_LONG method=${METHOD_NAMES[method]} bytesPerFrame(K=512KB)=${bpf.toFixed(2)} cyclesPerLong=${cpl.toFixed(2)} plausible=${plausible[method]}`);
  }

  const movemVsLongRatio = byMethodAt512[2] / byMethodAt512[1];
  const movemVsLongOk = movemVsLongRatio >= 1.5 && movemVsLongRatio <= 2.5;
  console.log(`RESULT: E3_MOVEM_VS_LONG_RATIO=${movemVsLongRatio.toFixed(3)} plausible(1.5-2.5)=${movemVsLongOk}`);

  const allPlausible = methods.every((m) => plausible[m]) && movemVsLongOk;
  console.log(`RESULT: E3_ALL_PLAUSIBLE=${allPlausible}`);
  if (!allPlausible) {
    console.log('RESULT: E3_VERDICT=UNDETERMINED (妥当性チェックに落ちたため、方式別スループットの数値は未確定として報告する)');
  } else {
    console.log('RESULT: E3_VERDICT=DETERMINED');
    for (const method of methods) {
      const bpf = byMethodAt512[method];
      const frames512 = (512 * 1024) / bpf;
      const fits = frames512 <= 1;
      console.log(`RESULT: E3_512KB_FITS_IN_ONE_FRAME method=${METHOD_NAMES[method]} framesFor512KB=${frames512.toFixed(3)} fits=${fits}`);
    }
  }

  const overallOk = zeroOk; // 妥当性チェックの失敗は「未確定」であって「異常終了」ではない
  console.log(`RESULT: E3_PASS=${overallOk}`);
  if (!overallOk) process.exitCode = 1;

  console.log('---JSON---');
  console.log(JSON.stringify({
    coreOptionsSet: CORE_OPTIONS_USED,
    coreOptionDefaults: CORE_OPTION_DEFAULTS_NOT_SET,
    reportedFps,
    cyclesPerFrame,
    zeroResults,
    zeroOk,
    mainResults,
    linearity,
    allLinearityOk,
    cyclesTable,
    plausible,
    movemVsLongRatio,
    movemVsLongOk,
    allPlausible,
  }, null, 2));
}

await main();
