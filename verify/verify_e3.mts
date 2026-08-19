/*
 * Stage E-3(再測定・第2版): メインメモリ上の領域から GVRAM(65536色1ページ)へ K バイト
 * 転送する間に経過した垂直同期の回数を実測し、1フレームあたりの転送スループット
 * (バイト/フレーム)を求める。垂直同期の検出手段は Stage E-2 で実測確定した MFP
 * GPIP($E88001) bit4 の立下りエッジ検出をそのまま使う(stage_e/src/e3_copy.S 参照)。
 *
 * 【この再測定を行った理由 その1(1回目の再測定)】最初の verify_e3.mts(main_e3.c
 * 単一実装、ワード単位コピーの内側ループで毎回 MFP をポーリング)は「転送速度」では
 * なく「転送+ワード毎ポーリング」の速度を測っていた。ポーリングという低速な I/O
 * バス読み出しが1コピー単位ごとに入っていたため支配的コストになっており、
 * K=64/128/256/512KB の4点が完全比例していたのもポーリングコストが一定だった
 * ことの裏返しでしかない(比例は変換式が丸ごと間違っていても成立する)。
 *
 * 【この再測定を行った理由 その2(2回目の再測定・今回)】ポーリングを内側ループから
 * 出し(POLL_INTERVAL個のコピー単位ごとに1回)、word/long/movemの3方式を1回ずつ
 * 実行して K=64〜512KB を測ったところ、今度は逆にポーリング負荷が無くなったぶん
 * 転送そのものが速すぎて、**1回の転送が1垂直同期(約16.7ms)未満で終わる**
 * ケースが大半になった。垂直同期の「回数」は整数(0,1,2...)でしか数えられない
 * ため、この状態で K/回数 を取ると量子化誤差が支配的になり、収束確認(N=256/1024/
 * 4096で値が収束するか)も線形性確認も成立しなかった(実測: movem版はK=512KB
 * でも1回の転送でguestVsyncEvents=0または1にしかならなかった)。
 * そこで今回は、同じK バイトの転送を N_REPEATS 回繰り返し(stage_e/src/main_e3.c
 * が積算)、累積した垂直同期回数で割ることで量子化誤差を薄める方式にした。
 *
 * 測定は4段階:
 *   1. K=512KB固定で、ポーリング間隔(POLL_INTERVAL)を256/1024/4096の3通りに
 *      振り、スループットが収束することを確認する(N_REPEATS=100で量子化誤差を
 *      あらかじめ抑えた上で確認する。収束しなければポーリング負荷がまだ支配的)。
 *   2. 収束したポーリング間隔を使い、word/long/movemの3方式でK=64/128/256/512KB
 *      のスループットを測る。各(方式,K)ごとに N_REPEATS を、累積垂直同期回数が
 *      目標値(TARGET_VSYNCS=300)に近づくよう概算で決める(量子化誤差を約
 *      0.3%程度に抑える狙い。あくまで目標であり、実際に達成できたかは実測値を
 *      そのまま報告する)。
 *   3. 同一方式内でK/累積回数が一定(比例)しているかを線形性の消極的チェックとして見る。
 *   4. K=0(陰性対照)で全方式とも垂直同期回数が0になることを確認する。
 *
 * 妥当性の相互確認として、各実測値を16MHz換算で「1ロングワードあたり何サイクルか」
 * に変換し、68000の素朴なメモリ間コピーとして妥当な桁(目安20〜40サイクル/ロング。
 * GVRAMのウェイト次第でもう少し)から外れていないかを記録する。
 *
 * 使い方: npx tsx verify/verify_e3.mts
 * 環境変数: WEBX68K_DIR(既定 ../WebX68k)、WARMUP(既定 150)、MAX_EXTRA_FRAMES(既定 20000)
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

const DONE_FLAG_ADDR = 0x000e0010;
const VSYNC_COUNT_ADDR = 0x000e0014;

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

/* avInfo.fps(retro_get_system_av_info が報告する値)を16MHz換算の基準に使う。
 * 65536色1ページモード設定後、host.fetchAvInfo() で実測した値(61.46Hz)。
 * この値自体は「px68kが自己申告するfps」であり実機の垂直同期周波数の実測では
 * ないため、結果の読み方に出所を明記する。 */
const REPORTED_FPS_FOR_CYCLE_ESTIMATE = 61.46;
const CPU_HZ_FOR_CYCLE_ESTIMATE = 16_000_000;

interface Session {
  runFramesUntilDone(warmup: number, maxExtraFrames: number, label: string): { hostFramesAfterWarmup: number; done: boolean };
  peekVsyncCount(): number;
  dispose(): void;
}

async function bootSession(label: string, diskBytes: Uint8Array): Promise<Session> {
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
  host.fetchAvInfo();

  return {
    runFramesUntilDone(warmup: number, maxExtraFrames: number, lbl: string) {
      const checkDeadlineWarmup = makeDeadline(`${lbl}:warmup`, warmup);
      for (let i = 0; i < warmup; i++) {
        host.runFrame();
        if (i % 50 === 0) checkDeadlineWarmup();
      }
      const checkDeadline = makeDeadline(`${lbl}:transfer`, maxExtraFrames);
      let hostFramesAfterWarmup = 0;
      let done = host.peekByte(DONE_FLAG_ADDR) === 1;
      while (!done && hostFramesAfterWarmup < maxExtraFrames) {
        host.runFrame();
        hostFramesAfterWarmup++;
        if (hostFramesAfterWarmup % 50 === 0) checkDeadline();
        done = host.peekByte(DONE_FLAG_ADDR) === 1;
      }
      return { hostFramesAfterWarmup, done };
    },
    peekVsyncCount(): number {
      const hi = host.peekWord(VSYNC_COUNT_ADDR) >>> 0;
      const lo = host.peekWord(VSYNC_COUNT_ADDR + 2) >>> 0;
      return (hi * 0x10000 + lo) >>> 0;
    },
    dispose() {
      host.dispose();
    },
  };
}

function buildStageE3Image(kBytes: number, method: 0 | 1 | 2, pollInterval: number, nRepeats: number, outPath: string): void {
  execFileSync('bash', [
    resolve(DEV_ROOT, 'tools/build_stage_e3.sh'),
    String(kBytes),
    String(method),
    String(pollInterval),
    String(nRepeats),
    outPath,
  ], { cwd: DEV_ROOT });
}

interface Measurement {
  kBytes: number;
  method: 0 | 1 | 2;
  pollInterval: number;
  nRepeats: number;
  done: boolean;
  hostFramesAfterWarmup: number;
  guestVsyncEvents: number; // N_REPEATS回ぶんの累積
  totalBytes: number; // kBytes * nRepeats
  bytesPerFrame: number | null;
}

async function measure(kBytes: number, method: 0 | 1 | 2, pollInterval: number, nRepeats: number, warmup: number, maxExtraFrames: number): Promise<Measurement> {
  const label = `e3_k${kBytes}_m${method}_p${pollInterval}_r${nRepeats}`;
  const imgPath = resolve(DEV_ROOT, `build/stage_e3_${label}.xdf`);
  buildStageE3Image(kBytes, method, pollInterval, nRepeats, imgPath);
  const session = await bootSession(label, new Uint8Array(readFileSync(imgPath)));
  const { hostFramesAfterWarmup, done } = session.runFramesUntilDone(warmup, maxExtraFrames, label);
  const guestVsyncEvents = session.peekVsyncCount();
  session.dispose();
  const totalBytes = kBytes * nRepeats;
  return {
    kBytes,
    method,
    pollInterval,
    nRepeats,
    done,
    hostFramesAfterWarmup,
    guestVsyncEvents,
    totalBytes,
    bytesPerFrame: guestVsyncEvents > 0 ? totalBytes / guestVsyncEvents : (kBytes === 0 ? 0 : null),
  };
}

const METHOD_NAMES: Record<number, string> = { 0: 'word(MOVE.W)', 1: 'long(MOVE.L)', 2: 'movem(MOVEM.L x8)' };

function cyclesPerLong(bytesPerFrame: number): number {
  const cyclesPerFrame = CPU_HZ_FOR_CYCLE_ESTIMATE / REPORTED_FPS_FOR_CYCLE_ESTIMATE;
  const longsPerFrame = bytesPerFrame / 4;
  return cyclesPerFrame / longsPerFrame;
}

/* 目標とする累積垂直同期回数(量子化誤差をおよそ 1/TARGET_VSYNCS に抑える狙い)。 */
const TARGET_VSYNCS = 300;
const MIN_N_REPEATS = 10;
const MAX_N_REPEATS = 200_000;

/* 大まかなスループット概算(N_REPEATSの罠を修正した後にK=512KBで軽く予備測定した
 * 実測値を初期シードとして使う。この値そのものは結論に使わない。N_REPEATSの
 * サイズを決めるためだけの概算であり、exact bytesPerFrame は最終的に本測定の
 * 実測値からそのまま算出する)。 */
const ROUGH_BYTES_PER_FRAME_SEED: Record<number, number> = {
  0: 82_000,    // word (予備測定: reps=50でevents=319 -> 524288*50/319≈82,182)
  1: 160_000,   // long (予備測定: reps=30でevents=98  -> 524288*30/98≈160,517)
  2: 1_390_000, // movem(予備測定: reps=300でevents=113 -> 524288*300/113≈1,392,268)
};

function pickNRepeats(kBytes: number, method: 0 | 1 | 2): number {
  if (kBytes === 0) return 1;
  const seed = ROUGH_BYTES_PER_FRAME_SEED[method];
  const n = Math.ceil((seed * TARGET_VSYNCS) / kBytes);
  return Math.min(MAX_N_REPEATS, Math.max(MIN_N_REPEATS, n));
}

async function main(): Promise<void> {
  console.log(`WEBX68K_DIR=${WEBX68K_DIR}`);
  console.log(`RESULT: E3_CORE_OPTIONS_SET=${JSON.stringify(CORE_OPTIONS_USED)}`);
  console.log(`RESULT: E3_CORE_OPTIONS_DEFAULT=${JSON.stringify(CORE_OPTION_DEFAULTS_NOT_SET)}`);
  console.log(`RESULT: E3_REPORTED_FPS_FOR_CYCLE_ESTIMATE=${REPORTED_FPS_FOR_CYCLE_ESTIMATE} (host.fetchAvInfo()の自己申告値。実機の垂直同期周波数の実測ではない)`);

  const WARMUP = Number(process.env.WARMUP ?? 150);
  const MAX_EXTRA_FRAMES = Number(process.env.MAX_EXTRA_FRAMES ?? 20000);
  console.log(`WARMUP=${WARMUP} MAX_EXTRA_FRAMES=${MAX_EXTRA_FRAMES} TARGET_VSYNCS=${TARGET_VSYNCS}`);

  const methods: (0 | 1 | 2)[] = [0, 1, 2];

  // === 手順1: ポーリング間隔の収束確認(K=512KB固定、3方式 x N=256/1024/4096) ===
  // N_REPEATS=100固定で量子化誤差をあらかじめ抑えた上で、ポーリング間隔だけを振る。
  console.log('--- 手順1: ポーリング間隔(POLL_INTERVAL)の収束確認(K=512KB, N_REPEATS=100) ---');
  const CONVERGENCE_K = 512 * 1024;
  const CONVERGENCE_N_REPEATS = 100;
  const POLL_INTERVALS: number[] = [256, 1024, 4096];
  const convergence: Measurement[] = [];
  for (const method of methods) {
    for (const n of POLL_INTERVALS) {
      const r = await measure(CONVERGENCE_K, method, n, CONVERGENCE_N_REPEATS, WARMUP, MAX_EXTRA_FRAMES);
      convergence.push(r);
      console.log(`RESULT: E3_CONVERGENCE method=${METHOD_NAMES[method]} pollInterval=${n} guestVsyncEvents=${r.guestVsyncEvents} bytesPerFrame=${r.bytesPerFrame?.toFixed(2)} done=${r.done}`);
    }
  }
  // 収束判定: 同一方式内でN=1024とN=4096のbytesPerFrameの差が5%以内なら収束とみなす
  const convergenceOk: Record<number, boolean> = {};
  for (const method of methods) {
    const rows = convergence.filter((r) => r.method === method);
    const at1024 = rows.find((r) => r.pollInterval === 1024)!;
    const at4096 = rows.find((r) => r.pollInterval === 4096)!;
    const b1024 = at1024.bytesPerFrame ?? 0;
    const b4096 = at4096.bytesPerFrame ?? 0;
    const diffRatio = b1024 > 0 ? Math.abs(b4096 - b1024) / b1024 : Infinity;
    convergenceOk[method] = diffRatio <= 0.05;
    console.log(`RESULT: E3_CONVERGENCE_CHECK method=${METHOD_NAMES[method]} N=1024:${b1024.toFixed(2)} N=4096:${b4096.toFixed(2)} diffRatio=${(diffRatio * 100).toFixed(2)}% converged=${convergenceOk[method]}`);
  }
  const allConverged = methods.every((m) => convergenceOk[m]);
  console.log(`RESULT: E3_ALL_CONVERGED=${allConverged}`);

  const CHOSEN_POLL_INTERVAL = 4096;
  console.log(`RESULT: E3_CHOSEN_POLL_INTERVAL=${CHOSEN_POLL_INTERVAL}`);

  // === 手順2: 3方式 x K=64/128/256/512KB のスループット・線形性確認 ===
  console.log('--- 手順2: 方式別スループットと線形性(K=64/128/256/512KB、N_REPEATSは目標300回に合わせて算出) ---');
  const K_LIST = [64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024];
  const mainResults: Measurement[] = [];
  for (const method of methods) {
    for (const k of K_LIST) {
      const nRepeats = pickNRepeats(k, method);
      const r = await measure(k, method, CHOSEN_POLL_INTERVAL, nRepeats, WARMUP, MAX_EXTRA_FRAMES);
      mainResults.push(r);
      const cpl = r.bytesPerFrame ? cyclesPerLong(r.bytesPerFrame) : null;
      const resolutionOk = r.guestVsyncEvents >= TARGET_VSYNCS * 0.3;
      console.log(`RESULT: E3_MAIN method=${METHOD_NAMES[method]} K=${r.kBytes} nRepeats=${r.nRepeats} totalBytes=${r.totalBytes} guestVsyncEvents=${r.guestVsyncEvents} bytesPerFrame=${r.bytesPerFrame?.toFixed(2)} cyclesPerLong=${cpl?.toFixed(2)} resolutionOk=${resolutionOk} done=${r.done}`);
    }
  }
  const allMainDone = mainResults.every((r) => r.done);

  // 線形性: 同一方式内でK/累積回数(bytesPerFrame)が一定(比例)しているかを確認する。
  // 比例そのものは正しさの十分条件ではない(1回目の再測定で踏んだ教訓)ため、
  // ここでは「破綻していないか」の消極的なチェックとしてのみ扱う。
  const linearityByMethod: Record<number, { ok: boolean; values: number[] }> = {};
  for (const method of methods) {
    const rows = mainResults.filter((r) => r.method === method && r.bytesPerFrame !== null);
    const values = rows.map((r) => r.bytesPerFrame as number);
    const maxV = Math.max(...values);
    const minV = Math.min(...values);
    const ok = minV > 0 && (maxV - minV) / minV <= 0.1;
    linearityByMethod[method] = { ok, values };
    console.log(`RESULT: E3_LINEARITY method=${METHOD_NAMES[method]} values=${JSON.stringify(values.map((v) => v.toFixed(2)))} ok=${ok}`);
  }

  // === 手順3: 陰性対照(K=0) ===
  console.log('--- 手順3: 陰性対照(K=0バイト転送) ---');
  const zeroResults: Measurement[] = [];
  for (const method of methods) {
    const r = await measure(0, method, CHOSEN_POLL_INTERVAL, 1, WARMUP, MAX_EXTRA_FRAMES);
    zeroResults.push(r);
    console.log(`RESULT: E3_ZERO method=${METHOD_NAMES[method]} guestVsyncEvents=${r.guestVsyncEvents} done=${r.done}`);
  }
  const zeroOk = zeroResults.every((r) => r.done && r.guestVsyncEvents === 0);
  console.log(`RESULT: E3_NEGATIVE_CONTROL_ZERO_OK=${zeroOk}`);

  // === 総合結論 ===
  const full = mainResults.filter((r) => r.kBytes === 512 * 1024);
  console.log('--- 結論 ---');
  for (const r of full) {
    // 1回ぶんの転送が1フレームに収まるかは、累積値を1回あたりに換算して判定する
    // (N_REPEATS回ぶん束ねて測っているため、素の回数ではなく平均で見る)。
    const eventsPerRep = r.guestVsyncEvents / r.nRepeats;
    const fits = eventsPerRep <= 1;
    console.log(`RESULT: E3_512KB_FITS_IN_ONE_FRAME method=${METHOD_NAMES[r.method]} eventsPerRep=${eventsPerRep.toFixed(4)} fits=${fits}`);
  }

  // 最速方式(bytesPerFrameが最大)を「1フレームに収まる最大バイト数」の代表値として採用
  let best: Measurement | null = null;
  for (const r of mainResults) {
    if (r.kBytes !== 512 * 1024) continue;
    if (!best || (r.bytesPerFrame ?? 0) > (best.bytesPerFrame ?? 0)) best = r;
  }
  const FULL_SCREEN_BYTES = 512 * 1024;
  const fraction = best?.bytesPerFrame !== null && best?.bytesPerFrame !== undefined ? best.bytesPerFrame / FULL_SCREEN_BYTES : null;
  console.log(`RESULT: E3_BEST_METHOD=${best ? METHOD_NAMES[best.method] : 'null'}`);
  console.log(`RESULT: E3_BEST_BYTES_PER_FRAME=${best?.bytesPerFrame?.toFixed(2)}`);
  console.log(`RESULT: E3_BEST_AS_FRACTION_OF_FULLSCREEN=${fraction !== null ? (fraction * 100).toFixed(2) + '%' : 'null'}`);

  const overallOk = allMainDone && zeroOk;
  console.log(`RESULT: E3_PASS=${overallOk}`);
  console.log(`RESULT: E3_ALL_CONVERGED=${allConverged} (収束しなかった場合はポーリング負荷がまだ支配的である可能性を報告に含めること)`);
  if (!overallOk) process.exitCode = 1;

  console.log('---JSON---');
  console.log(JSON.stringify({
    coreOptionsSet: CORE_OPTIONS_USED,
    coreOptionDefaults: CORE_OPTION_DEFAULTS_NOT_SET,
    reportedFpsForCycleEstimate: REPORTED_FPS_FOR_CYCLE_ESTIMATE,
    warmup: WARMUP,
    maxExtraFrames: MAX_EXTRA_FRAMES,
    targetVsyncs: TARGET_VSYNCS,
    convergence,
    convergenceOk,
    allConverged,
    chosenPollInterval: CHOSEN_POLL_INTERVAL,
    mainResults,
    linearityByMethod,
    zeroResults,
    zeroOk,
    overallOk,
    bestMethod: best ? METHOD_NAMES[best.method] : null,
    bestBytesPerFrame: best?.bytesPerFrame ?? null,
    fractionOfFullScreen: fraction,
  }, null, 2));
}

await main();
