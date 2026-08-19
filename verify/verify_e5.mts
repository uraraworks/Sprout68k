/*
 * Stage E-5: 例外ベクタを自前ハンドラへ差し替え、意図的に例外を起こしたときに
 * 実際に制御が移るか(捕捉できるか)、ハンドラから画面表示(GVRAM直書き)が
 * できるかを実測する。
 *
 * 【故障注入が本体】このステージの合格条件は「ハンドラが動いたことをhost側
 * から観測できる」ことそのものなので、host側の役割は「フラグが立つのを待つ」
 * のではなく「意図的に例外を起こしたゲストを一定フレーム走らせ、既知の番地
 * (HOSTVAR_MARKER=0x000E0030, GVRAM先頭ワード=0x00C00000)を覗いて結果を
 * 読む」こと。ハンドラは復帰(RTE)せず無限ループで停止する設計(理由は
 * stage_e/src/e5_handlers.S 冒頭コメント)なので、「DONE_FLAGが立つのを待つ」
 * 式の計測はできない。代わりに HOSTVAR_ALIVE(0x000E0034)が1になった後、
 * 固定フレーム数だけ追加で走らせてから判定する。
 *
 * 【陰性対照】MODE=1(ハンドラ差し替えなしで同じ例外を起こす)を全種別で走らせ、
 * MARKER が0のまま(=自前ハンドラは動いていない)であることを確認する。
 * 差し替えていないのに捕捉できたと出るなら、観測しているものが自前ハンドラの
 * 動作ではないことになる。
 *
 * 【正常実行での無反応】MODE=2(ハンドラ差し替えのみ、例外は起こさない)を
 * 全種別で走らせ、ALIVE=1(=正常にそこまで到達した)にも関わらずMARKERが
 * 0のままであることを確認する。
 *
 * 【3種の弁別】MODE=0(陽性)を3種別で走らせ、種別ごとに異なるMARKER値・
 * 異なるGVRAM色が観測されることを確認する。
 *
 * 【68000/68030の前提】px68k(このリポジトリの検証ハーネスが使うコア)は
 * Musashi CPUコアをCPU種別切り替えのcore option無しでビルドしており、
 * m68k_set_cpu_type()を一度も呼んでいない(stage_c/boot/cache_flush.S、
 * docs/実機互換_要件追加_20260819.md で既に実測済みの事実。このファイルでは
 * その事実を再利用するだけで、あらためて実測はしない)。つまりこの検証
 * ハーネスで実測できるのは常に68000相当の経路のみで、68030(VBRを持つ)側の
 * ベクタ差し替えは原理的に実測不可能。このステージのコード自体はVBRを一切
 * 操作せず「ベクタテーブルは番地0固定」という68000の前提で書いているため、
 * 68010以降でVBRが0以外に設定されている環境では成立しない可能性がある
 * (未検証。docs/StageE-5_実測_20260819.md に出所を分けて明記する)。
 *
 * すべて同期実行。runFrame()呼び出しごとにフレーム数を数え、
 * makeDeadline()で壁時計ベースのタイムアウトも併用する(ハンドラが捕捉に
 * 失敗してゲストが暴走・無応答になる可能性があるため、タイムアウトが
 * 必ず機能することが必須)。
 *
 * 使い方: npx tsx verify/verify_e5.mts
 * 環境変数: WEBX68K_DIR(既定 ../WebX68k)、MAX_FRAMES(既定 2000)
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

const HOSTVAR_MARKER_ADDR = 0x000e0030;
const HOSTVAR_ALIVE_ADDR = 0x000e0034;
/* GVRAM(0x00C00000)は host.peekByte/peekWord() が読む「MEM[]フラット配列」の
 * 外側(WebX68kのwebx68k_peek16は core-shim.cのコメント通りMEM[]をそのまま
 * 読むだけで、SRAM同様GVRAMのような別バッファのメモリマップドI/O領域は経由
 * しない。実測で peekWord(GVRAM先頭)が常に0を返すことを確認済み=このpeekは
 * GVRAM検証に使えない)。そのため画面表示の実測は IOCS $21 経由の文字列を
 * host.readTextScreen() で読み戻す方式にする(Stage C/E-1のverifyで既に
 * 実績のある経路)。ハンドラ側はGVRAMへも直書きしている(GVRAM直書きの経路
 * 自体は実装している)が、host側の検証はテキスト画面読み戻しのみで行う。 */

const MAX_FRAMES = Number(process.env.MAX_FRAMES ?? 2000);
const EXTRA_FRAMES_AFTER_ALIVE = 60; // ALIVE=1後、ハンドラが動く猶予として追加で走らせるフレーム数
const DEADLINE_BASE_MS = 30_000;
const DEADLINE_MS_PER_FRAME = 30;

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

/* Stage E-2/E-3と同じ理由でno_wait_mode=enabledを最初から使う
 * (px68k-libretroのretro_run()が実時間へ自己同期する罠を避ける。
 * Stage E-2で実測済みの既知の罠)。 */
const CORE_OPTIONS_USED = {
  px68k_cpuspeed: '16Mhz',
  px68k_ramsize: '1MB',
  px68k_no_wait_mode: 'enabled',
};

interface Session {
  runFrame(): void;
  peekByteAt(addr: number): number;
  peekWordAt(addr: number): number;
  readTextLines(): string[];
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

  return {
    runFrame() {
      host.runFrame();
    },
    peekByteAt(addr: number) {
      return host.peekByte(addr);
    },
    peekWordAt(addr: number) {
      return host.peekWord(addr);
    },
    readTextLines() {
      const dump = host.readTextScreen();
      return (dump.lines as string[]).filter((l) => l.trim()).map((l) => l.replaceAll('​', ''));
    },
    dispose() {
      host.dispose();
    },
  };
}

function buildStageE5Image(excType: 0 | 1 | 2, mode: 0 | 1 | 2, outPath: string): void {
  execFileSync('bash', [
    resolve(DEV_ROOT, 'tools/build_stage_e5.sh'),
    String(excType),
    String(mode),
    outPath,
  ], { cwd: DEV_ROOT });
}

interface RunResult {
  aliveSeen: boolean;
  framesToAlive: number;
  markerAfter: number;
  textLines: string[];
  timedOut: boolean;
}

/* host側で runFrame() を1回ずつ呼びながら HOSTVAR_ALIVE が立つのを待ち、
 * 立った後さらに EXTRA_FRAMES_AFTER_ALIVE フレーム走らせてから
 * HOSTVAR_MARKER / テキスト画面を読む。DONE_FLAG的な完了合図が無い
 * (ハンドラは無限ループで停止する設計のため)ので、この「追加フレーム」方式
 * で判定する。 */
async function runAndMeasure(excType: 0 | 1 | 2, mode: 0 | 1 | 2): Promise<RunResult> {
  const label = `e5_t${excType}_m${mode}`;
  const imgPath = resolve(DEV_ROOT, `build/stage_e5_${label}.xdf`);
  buildStageE5Image(excType, mode, imgPath);
  const session = await bootSession(label, new Uint8Array(readFileSync(imgPath)));

  const checkDeadline = makeDeadline(label, MAX_FRAMES);
  let framesToAlive = 0;
  let aliveSeen = session.peekByteAt(HOSTVAR_ALIVE_ADDR) === 1;
  let timedOut = false;
  try {
    while (!aliveSeen && framesToAlive < MAX_FRAMES) {
      session.runFrame();
      framesToAlive++;
      if (framesToAlive % 100 === 0) checkDeadline();
      aliveSeen = session.peekByteAt(HOSTVAR_ALIVE_ADDR) === 1;
    }
    if (aliveSeen) {
      for (let i = 0; i < EXTRA_FRAMES_AFTER_ALIVE; i++) {
        session.runFrame();
        if (i % 20 === 0) checkDeadline();
      }
    }
  } catch (e) {
    timedOut = true;
  }

  const markerAfter = session.peekWordAt(HOSTVAR_MARKER_ADDR);
  const textLines = session.readTextLines();
  session.dispose();
  return { aliveSeen, framesToAlive, markerAfter, textLines, timedOut };
}

const EXC_NAMES: Record<number, string> = { 0: 'ADDRESS_ERROR(vector3)', 1: 'ILLEGAL_INSTRUCTION(vector4)', 2: 'ZERO_DIVIDE(vector5)' };
const EXPECTED_MARKER: Record<number, number> = { 0: 0xe501, 1: 0xe502, 2: 0xe503 };
const EXPECTED_TEXT: Record<number, string> = {
  0: 'STAGE E5: ADDRESS ERROR CAUGHT',
  1: 'STAGE E5: ILLEGAL INSTRUCTION CAUGHT',
  2: 'STAGE E5: ZERO DIVIDE CAUGHT',
};

async function main(): Promise<void> {
  console.log(`WEBX68K_DIR=${WEBX68K_DIR}`);
  console.log(`RESULT: E5_CORE_OPTIONS_SET=${JSON.stringify(CORE_OPTIONS_USED)}`);
  console.log(`MAX_FRAMES=${MAX_FRAMES} EXTRA_FRAMES_AFTER_ALIVE=${EXTRA_FRAMES_AFTER_ALIVE}`);

  const excTypes: (0 | 1 | 2)[] = [0, 1, 2];
  let allPositiveOk = true;
  let allNegativeOk = true;
  let allNoFireOk = true;
  const positiveMarkers: Record<number, number> = {};
  const positiveTextOk: Record<number, boolean> = {};

  console.log('--- 手順1(陽性): MODE=0(ハンドラ差し替え+例外を起こす) 3種 ---');
  for (const t of excTypes) {
    const r = await runAndMeasure(t, 0);
    const expectedMarker = EXPECTED_MARKER[t];
    const expectedText = EXPECTED_TEXT[t];
    const textOk = r.textLines.some((l) => l.includes(expectedText));
    const ok = r.aliveSeen && !r.timedOut && r.markerAfter === expectedMarker && textOk;
    positiveMarkers[t] = r.markerAfter;
    positiveTextOk[t] = textOk;
    allPositiveOk = allPositiveOk && ok;
    console.log(`RESULT: E5_POSITIVE type=${EXC_NAMES[t]} aliveSeen=${r.aliveSeen} framesToAlive=${r.framesToAlive} timedOut=${r.timedOut} marker=0x${r.markerAfter.toString(16)}(expected 0x${expectedMarker.toString(16)}) textOk=${textOk} ok=${ok}`);
    console.log(`RESULT: E5_POSITIVE_TEXTLINES type=${EXC_NAMES[t]} textLines=${JSON.stringify(r.textLines)}`);
  }
  console.log(`RESULT: E5_ALL_POSITIVE_OK=${allPositiveOk}`);

  console.log('--- 手順2(陰性対照): MODE=1(ハンドラ差し替えなし+同じ例外を起こす) 3種 ---');
  for (const t of excTypes) {
    const r = await runAndMeasure(t, 1);
    // 差し替えていないので自前ハンドラは動かず、MARKERは初期値(0)のまま、
    // ハンドラが表示するはずのメッセージも画面に出ないはず。
    const expectedText = EXPECTED_TEXT[t];
    const textAbsent = !r.textLines.some((l) => l.includes(expectedText));
    const ok = !r.timedOut && r.markerAfter === 0 && textAbsent;
    allNegativeOk = allNegativeOk && ok;
    console.log(`RESULT: E5_NEGATIVE_CONTROL type=${EXC_NAMES[t]} aliveSeen=${r.aliveSeen} timedOut=${r.timedOut} marker=0x${r.markerAfter.toString(16)}(expected 0x0) textAbsent=${textAbsent} ok=${ok}`);
  }
  console.log(`RESULT: E5_ALL_NEGATIVE_CONTROL_OK=${allNegativeOk}`);

  console.log('--- 手順3(正常実行での無反応): MODE=2(ハンドラ差し替えのみ、例外を起こさない) 3種 ---');
  for (const t of excTypes) {
    const r = await runAndMeasure(t, 2);
    const expectedText = EXPECTED_TEXT[t];
    const textAbsent = !r.textLines.some((l) => l.includes(expectedText));
    const ok = r.aliveSeen && !r.timedOut && r.markerAfter === 0 && textAbsent;
    allNoFireOk = allNoFireOk && ok;
    console.log(`RESULT: E5_NO_FIRE_ON_NORMAL_EXEC type=${EXC_NAMES[t]} aliveSeen=${r.aliveSeen} timedOut=${r.timedOut} marker=0x${r.markerAfter.toString(16)}(expected 0x0) textAbsent=${textAbsent} ok=${ok}`);
  }
  console.log(`RESULT: E5_ALL_NO_FIRE_ON_NORMAL_EXEC_OK=${allNoFireOk}`);

  console.log('--- 手順4(3種の弁別): 手順1で得たMARKER値が3種とも異なるか ---');
  const markerValues = excTypes.map((t) => positiveMarkers[t]);
  const markersDistinct = new Set(markerValues).size === excTypes.length;
  const allTextOk = excTypes.every((t) => positiveTextOk[t]);
  console.log(`RESULT: E5_MARKERS_DISTINCT=${markersDistinct} values=${markerValues.map((v) => '0x' + v.toString(16)).join(',')}`);
  console.log(`RESULT: E5_ALL_TEXT_OK=${allTextOk}(3種それぞれ固有のメッセージが画面(テキストVRAM読み戻し)に出たか)`);

  console.log('--- 結論 ---');
  const overallOk = allPositiveOk && allNegativeOk && allNoFireOk && markersDistinct && allTextOk;
  console.log(`RESULT: E5_PASS=${overallOk}`);
  if (!overallOk) process.exitCode = 1;

  console.log('---JSON---');
  console.log(JSON.stringify({
    coreOptionsSet: CORE_OPTIONS_USED,
    allPositiveOk,
    allNegativeOk,
    allNoFireOk,
    markersDistinct,
    allTextOk,
    positiveMarkers,
    overallOk,
  }, null, 2));
}

await main();
