/*
 * Stage E-2: 垂直同期(垂直帰線期間)検出手段を px68k(WebX68k のコア)上で実測する。
 * ブラウザは使わず Node から直接コアを回す(verify/verify_e1.mts のコア駆動部分を踏襲。
 * __BUILD_ID__/locateFile の2つの罠、makeDeadline の自前タイムアウトは同じ実装を使う)。
 *
 * 候補(解読による): stage_e/src/main_e2.c のコメント参照。px68k-libretro
 * x68k/mfp.c の GetGPIP() を読んで見つけた MFP GPIP($E88001) bit4 のエッジ検出。
 * このスクリプトはその候補を実行して host 側から実測する(解読そのものは
 * 「実測済み」として扱わない。出所を分けて記録する)。
 *
 * 測定方式:
 *   1. USE_VSYNC_WAIT=1(同期待ちあり)版をビルドし起動する。ウォームアップとして
 *      WARMUP フレーム実行した後、ゲスト内カウンタ(HOSTVAR_COUNTER、
 *      $000E0000)を host.peekWord() 2回で読む(counter_a)。
 *   2. さらに MEASURE フレーム実行し、再度カウンタを読む(counter_b)。
 *   3. delta_counter = counter_b - counter_a、delta_frames = MEASURE。
 *      「同期待ちをN回行うプログラムがホスト側から見て概ねNフレームぶんの時間を
 *      消費する」を、この delta_counter と delta_frames の比(rate)で判定する。
 *      rate が 1 に近ければ、待ち1回 ≈ host側フレーム1回に対応している。
 *   4. USE_VSYNC_WAIT=0(陰性対照。同期待ちをしない)版でも同じ測定を行う。
 *      同期待ちを外すとゲストCPUは実時間を待たずに回り続けるため、
 *      delta_counter は delta_frames よりはるかに大きくなるはず(rateが1から
 *      大きく外れる)。この関係が崩れなければ「待てている」ことの証拠にならない。
 *
 * 使い方: npx tsx verify/verify_e2.mts
 * 環境変数: WEBX68K_DIR(既定 ../WebX68k)、WARMUP(既定 60)、MEASURE(既定 180)
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

const HOSTVAR_COUNTER_ADDR = 0x000e0000;

/* 自前タイムアウト(verify.mts / verify_e1.mts を踏襲) */
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

/* 検証ハーネスが px68k に設定しているコアオプション。
 *
 * px68k_no_wait_mode は Stage E-1 と異なり **明示的に enabled にする**。理由:
 * 過去の実測(feedback_core_self_paces_to_wall_clock.md、2026-08-12)により、
 * px68k-libretro の retro_run() は Config.NoWaitMode が無効だと
 * Timer_GetCount()(実時間の経過)でゲートされ、「コアが実時間に自己同期する」
 * (host側が runFrame() を何回呼んでも実時間が経過するまでゲストが進まない)。
 * E-2/E-3 はまさに「host側のフレーム呼び出し回数とゲスト内の同期待ち回数の対応」
 * を測る実験であり、この自己同期が有効なままだと measure=300 のような短い
 * ループでは実時間が足りずゲストがほとんど進まない(実際に no_wait_mode 未設定
 * (既定 disabled)で最初に測定したところ、同期待ちあり版で 300 host フレーム中
 * わずか 31 回しか同期待ちが進まなかった。これは検出手段の誤りではなく
 * ペーシングの問題だったため、no_wait_mode=enabled に変更して測定し直した)。
 * px68k_cpuspeed / px68k_ramsize は Stage E-1 と同じ値(16Mhz / 1MB)を使う。 */
const CORE_OPTIONS_USED = {
  px68k_cpuspeed: '16Mhz',
  px68k_ramsize: '1MB',
  px68k_no_wait_mode: 'enabled',
};
const CORE_OPTION_DEFAULTS_NOT_SET = {
  px68k_frameskip: 'Full Frame (既定値、フレームスキップ無し)',
  px68k_adjust_frame_rates: 'enabled (既定値。no_wait_modeでゲート短絡後も報告fpsの調整自体は残る)',
  px68k_audio_desync_hack: 'disabled (既定値。使わない。リサンプラと衝突するため)',
};

interface Session {
  host: any;
  runFrames(n: number): void;
  peekCounter(): number;
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

  let totalFrames = 0;
  return {
    host,
    runFrames(n: number) {
      const checkDeadline = makeDeadline(label, totalFrames + n);
      for (let i = 0; i < n; i++) {
        host.runFrame();
        totalFrames++;
        if (i % 50 === 0) checkDeadline();
      }
    },
    peekCounter(): number {
      // HOSTVAR_COUNTER は32bitのunsigned long(m68kはビッグエンディアン)。
      // 上位ワード・下位ワードをそれぞれ peekWord() で読んで合成する。
      const hi = host.peekWord(HOSTVAR_COUNTER_ADDR) >>> 0;
      const lo = host.peekWord(HOSTVAR_COUNTER_ADDR + 2) >>> 0;
      return (hi * 0x10000 + lo) >>> 0;
    },
    dispose() {
      host.dispose();
    },
  };
}

function buildStageE2Image(useVsyncWait: 0 | 1, outPath: string): void {
  execFileSync('bash', [
    resolve(DEV_ROOT, 'tools/build_stage_e2.sh'),
    String(useVsyncWait),
    outPath,
  ], { cwd: DEV_ROOT });
}

interface VariantResult {
  label: string;
  counterA: number;
  counterB: number;
  deltaCounter: number;
  deltaFrames: number;
  rate: number; // deltaCounter / deltaFrames (1に近いほど「1回の同期待ち≈1ホストフレーム」)
}

async function measureVariant(label: string, useVsyncWait: 0 | 1, warmup: number, measure: number): Promise<VariantResult> {
  const imgPath = resolve(DEV_ROOT, `build/stage_e2_${label}.xdf`);
  buildStageE2Image(useVsyncWait, imgPath);
  const session = await bootSession(label, new Uint8Array(readFileSync(imgPath)));
  session.runFrames(warmup);
  const counterA = session.peekCounter();
  session.runFrames(measure);
  const counterB = session.peekCounter();
  session.dispose();
  const deltaCounter = counterB - counterA;
  const deltaFrames = measure;
  const rate = deltaFrames === 0 ? NaN : deltaCounter / deltaFrames;
  return { label, counterA, counterB, deltaCounter, deltaFrames, rate };
}

async function main(): Promise<void> {
  console.log(`WEBX68K_DIR=${WEBX68K_DIR}`);
  console.log(`RESULT: E2_CORE_OPTIONS_SET=${JSON.stringify(CORE_OPTIONS_USED)}`);
  console.log(`RESULT: E2_CORE_OPTIONS_DEFAULT=${JSON.stringify(CORE_OPTION_DEFAULTS_NOT_SET)}`);

  // WARMUP は「ブート完了(IPL/FDD読み込みが終わりゲスト本体の main() に到達する)まで」
  // を確実に超える値が必要(実測: 60フレームでは未起動、1200フレームでは起動済みを
  // デバッグ用の直接書き込みプログラムで確認した。安全マージンを見て既定1500)。
  const WARMUP = Number(process.env.WARMUP ?? 1500);
  const MEASURE = Number(process.env.MEASURE ?? 300);
  console.log(`WARMUP=${WARMUP} MEASURE=${MEASURE}`);

  console.log('--- 候補(解読): MFP GPIP($E88001) bit4 の立下りエッジ待ち ---');

  console.log('--- 同期待ちあり(USE_VSYNC_WAIT=1) ---');
  const withWait = await measureVariant('with_wait', 1, WARMUP, MEASURE);
  console.log(`RESULT: E2_WITH_WAIT counterA=${withWait.counterA} counterB=${withWait.counterB} deltaCounter=${withWait.deltaCounter} deltaFrames=${withWait.deltaFrames} rate=${withWait.rate.toFixed(4)}`);
  if (withWait.counterA === 0 && withWait.counterB === 0) {
    console.log('RESULT: E2_FATAL=WARMUP後もカウンタが0のまま。ブート未完了(WARMUP不足)の疑いがあるため測定を中断する。');
    process.exitCode = 1;
    return;
  }

  console.log('--- 陰性対照: 同期待ち無し(USE_VSYNC_WAIT=0) ---');
  const withoutWait = await measureVariant('without_wait', 0, WARMUP, MEASURE);
  console.log(`RESULT: E2_WITHOUT_WAIT counterA=${withoutWait.counterA} counterB=${withoutWait.counterB} deltaCounter=${withoutWait.deltaCounter} deltaFrames=${withoutWait.deltaFrames} rate=${withoutWait.rate.toFixed(4)}`);

  // 判定基準:
  //  - 同期待ちあり版: rate が 1 に近いこと(0.5〜2.0の範囲。境界フレームの端数や
  //    起動直後のジッタを考慮した粗い許容幅)。
  //  - 陰性対照(同期待ち無し): rate が同期待ちあり版より明確に大きい(10倍以上)こと。
  //    これが崩れる(陰性対照でもrateが1に近い)場合、「待てている」ことの証拠に
  //    ならないためFAILとする。
  const RATE_LOW = 0.5;
  const RATE_HIGH = 2.0;
  const NEGATIVE_CONTROL_MIN_RATIO = 10;

  const withWaitOk = withWait.rate >= RATE_LOW && withWait.rate <= RATE_HIGH;
  const negativeControlOk = withoutWait.rate >= withWait.rate * NEGATIVE_CONTROL_MIN_RATIO;

  console.log(`RESULT: E2_WITH_WAIT_RATE_IN_RANGE=${withWaitOk} (許容範囲 [${RATE_LOW}, ${RATE_HIGH}])`);
  console.log(`RESULT: E2_NEGATIVE_CONTROL_OK=${negativeControlOk} (同期待ち無しのrateが同期待ちありの${NEGATIVE_CONTROL_MIN_RATIO}倍以上か: without=${withoutWait.rate.toFixed(4)} with=${withWait.rate.toFixed(4)})`);

  const overallOk = withWaitOk && negativeControlOk;
  console.log(`RESULT: E2_PASS=${overallOk}`);
  console.log(`RESULT: E2_CANDIDATE=MFP_GPIP_E88001_BIT4_FALLING_EDGE`);
  if (!overallOk) process.exitCode = 1;

  console.log('---JSON---');
  console.log(JSON.stringify({
    coreOptionsSet: CORE_OPTIONS_USED,
    coreOptionDefaults: CORE_OPTION_DEFAULTS_NOT_SET,
    warmup: WARMUP,
    measure: MEASURE,
    withWait,
    withoutWait,
    withWaitOk,
    negativeControlOk,
    overallOk,
  }, null, 2));
}

await main();
