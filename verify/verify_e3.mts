/*
 * Stage E-3: メインメモリ上の領域から GVRAM(65536色1ページ)へ K バイト転送する間に
 * 経過した垂直同期の回数を実測し、1フレームあたりの転送スループット(バイト/フレーム)
 * を求める。垂直同期の検出手段は Stage E-2 で実測確定した MFP GPIP($E88001) bit4 の
 * 立下りエッジ検出をそのまま使う(stage_e/src/main_e3.c 参照)。
 *
 * 検証ハーネスのコアオプションは Stage E-2 と同じ理由(feedback_core_self_paces_to_wall_clock.md)
 * で px68k_no_wait_mode=enabled を最初から使う(E-2 は無効設定→自己同期を踏んで再測定した
 * 経緯があるが、E-3 は最初から enabled で行う)。
 *
 * 測定方式:
 *   1. K = 64KB / 128KB / 256KB / 512KB それぞれについて、TRANSFER_WORDS=K/2 を
 *      埋め込んだイメージをビルドする(tools/build_stage_e3.sh)。
 *   2. WARMUP フレーム実行してブート完了(転送ループ開始前の状態)を待つ。
 *   3. DONE_FLAG($000E0010)を1フレームごとに host.peekByte() で監視し、1になるまで
 *      runFrame() を呼び続ける(呼んだ回数=host_frames)。上限 MAX_EXTRA_FRAMES を
 *      超えたらタイムアウトとして異常終了する(ハング対策の自前タイムアウト)。
 *   4. 完了後、VSYNC_COUNT($000E0014、32bit)を読む(guest_vsync_events。転送ループの
 *      中で MFP GPIP のエッジを数えた値。Stage E-2 で確定した検出手段そのもの)。
 *   5. スループット(バイト/フレーム) = K / guest_vsync_events。host_frames による
 *      裏取りも記録する(境界のずれで guest_vsync_events と host_frames が完全一致
 *      しないことがある。その場合も数値をそのまま報告し、こちらで丸めない)。
 *
 * 使い方: npx tsx verify/verify_e3.mts
 * 環境変数: WEBX68K_DIR(既定 ../WebX68k)、WARMUP(既定 1500)、MAX_EXTRA_FRAMES(既定 20000)
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
 * を使う。cpuspeed/ramsize は Stage E-1/E-2 と同じ値。 */
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

function buildStageE3Image(kBytes: number, outPath: string): void {
  execFileSync('bash', [
    resolve(DEV_ROOT, 'tools/build_stage_e3.sh'),
    String(kBytes),
    outPath,
  ], { cwd: DEV_ROOT });
}

interface KResult {
  kBytes: number;
  done: boolean;
  hostFramesAfterWarmup: number;
  guestVsyncEvents: number;
  bytesPerFrameByGuestVsync: number | null;
  bytesPerFrameByHostFrames: number | null;
}

async function measureK(kBytes: number, warmup: number, maxExtraFrames: number): Promise<KResult> {
  const label = `e3_k${kBytes}`;
  const imgPath = resolve(DEV_ROOT, `build/stage_e3_${label}.xdf`);
  buildStageE3Image(kBytes, imgPath);
  const session = await bootSession(label, new Uint8Array(readFileSync(imgPath)));
  const { hostFramesAfterWarmup, done } = session.runFramesUntilDone(warmup, maxExtraFrames, label);
  const guestVsyncEvents = session.peekVsyncCount();
  session.dispose();
  return {
    kBytes,
    done,
    hostFramesAfterWarmup,
    guestVsyncEvents,
    bytesPerFrameByGuestVsync: guestVsyncEvents > 0 ? kBytes / guestVsyncEvents : null,
    bytesPerFrameByHostFrames: hostFramesAfterWarmup > 0 ? kBytes / hostFramesAfterWarmup : null,
  };
}

async function main(): Promise<void> {
  console.log(`WEBX68K_DIR=${WEBX68K_DIR}`);
  console.log(`RESULT: E3_CORE_OPTIONS_SET=${JSON.stringify(CORE_OPTIONS_USED)}`);
  console.log(`RESULT: E3_CORE_OPTIONS_DEFAULT=${JSON.stringify(CORE_OPTION_DEFAULTS_NOT_SET)}`);

  // WARMUP はブート完了までの余裕。no_wait_mode=enabled 時の実測(Stage E-2)では
  // ブート完了は概ね80フレーム以内だったため、余裕を見て既定150。大きくしすぎると
  // 転送(K=512KBでも100フレーム強)がWARMUP中に終わってしまい
  // hostFramesAfterWarmupによる裏取りが取れなくなる(実測: WARMUP=1500では
  // 全K値でhostFramesAfterWarmup=0になった。guestVsyncEventsの値自体はWARMUPを
  // 変えても不変だったため主指標はguestVsyncEvents側)。
  const WARMUP = Number(process.env.WARMUP ?? 150);
  const MAX_EXTRA_FRAMES = Number(process.env.MAX_EXTRA_FRAMES ?? 20000);
  console.log(`WARMUP=${WARMUP} MAX_EXTRA_FRAMES=${MAX_EXTRA_FRAMES}`);

  const K_LIST = [64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024];
  const results: KResult[] = [];
  for (const k of K_LIST) {
    console.log(`--- K=${k} bytes (${k / 1024}KB) ---`);
    const r = await measureK(k, WARMUP, MAX_EXTRA_FRAMES);
    results.push(r);
    console.log(`RESULT: E3_K=${r.kBytes} done=${r.done} hostFramesAfterWarmup=${r.hostFramesAfterWarmup} guestVsyncEvents=${r.guestVsyncEvents} bytesPerFrame(guestVsync)=${r.bytesPerFrameByGuestVsync?.toFixed(2)} bytesPerFrame(hostFrames)=${r.bytesPerFrameByHostFrames?.toFixed(2)}`);
    if (!r.done) {
      console.log(`RESULT: E3_FATAL K=${k}: MAX_EXTRA_FRAMES=${MAX_EXTRA_FRAMES}以内にDONE_FLAGが立たなかった(タイムアウト)`);
    }
  }

  const allDone = results.every((r) => r.done);
  console.log(`RESULT: E3_ALL_TRANSFERS_COMPLETED=${allDone}`);

  // 512KB(全画面)が1フレームに収まるか: 512KB分の guestVsyncEvents が 1 以下なら
  // 「転送中に帰線期間の立下りエッジをまたいだのは高々1回」=1フレーム以内で完了したとみなす。
  const full = results.find((r) => r.kBytes === 512 * 1024);
  const fullFitsInOneFrame = full ? full.done && full.guestVsyncEvents <= 1 : null;
  console.log(`RESULT: E3_512KB_FITS_IN_ONE_FRAME=${fullFitsInOneFrame}`);

  // 1フレームあたり転送できる最大バイト数: 実測4点のうち guestVsyncEvents が最も大きい
  // (=境界誤差の影響が相対的に最も小さい)K の bytesPerFrameByGuestVsync を採用する。
  const withRate = results.filter((r) => r.bytesPerFrameByGuestVsync !== null);
  let bestRatePoint: KResult | null = null;
  for (const r of withRate) {
    if (!bestRatePoint || r.guestVsyncEvents > bestRatePoint.guestVsyncEvents) bestRatePoint = r;
  }
  const throughputBytesPerFrame = bestRatePoint?.bytesPerFrameByGuestVsync ?? null;
  console.log(`RESULT: E3_THROUGHPUT_BYTES_PER_FRAME=${throughputBytesPerFrame?.toFixed(2)} (based on K=${bestRatePoint?.kBytes}, guestVsyncEvents=${bestRatePoint?.guestVsyncEvents})`);

  const FULL_SCREEN_BYTES = 512 * 1024; // Stage E-1 実測: 512x512ワード = 0x80000バイト
  const fractionOfFullScreen = throughputBytesPerFrame !== null ? throughputBytesPerFrame / FULL_SCREEN_BYTES : null;
  console.log(`RESULT: E3_MAX_FRAME_BYTES_AS_FRACTION_OF_FULLSCREEN=${fractionOfFullScreen !== null ? (fractionOfFullScreen * 100).toFixed(2) + '%' : 'null'}`);

  console.log(`RESULT: E3_PASS=${allDone}`);
  if (!allDone) process.exitCode = 1;

  console.log('---JSON---');
  console.log(JSON.stringify({
    coreOptionsSet: CORE_OPTIONS_USED,
    coreOptionDefaults: CORE_OPTION_DEFAULTS_NOT_SET,
    warmup: WARMUP,
    maxExtraFrames: MAX_EXTRA_FRAMES,
    results,
    allDone,
    fullFitsInOneFrame,
    throughputBytesPerFrame,
    fractionOfFullScreen,
  }, null, 2));
}

await main();
