/*
 * パニック画面(lib/asm/x68_panic.S + lib/src/x68_panic.c)の検証。
 *
 * docs/API設計_20260819.md 設計原則3「暴走は静かに固まるのではなく、
 * 見える形で止まる」の実装確認。verify_e5.mts/verify_l1.mts/
 * verify_breakout.mts と同じ骨格(px68k直接駆動、自前タイムアウト、
 * 故障注入が本体)を踏襲する。
 *
 * 【対象3種】アドレスエラー(vector3)・不正命令(vector4)・ゼロ除算(vector5)。
 * バスエラー(vector2)のハンドラは実装してあるが、px68k(Musashi CPUコア)は
 * m68k_pulse_bus_error() を一度も呼ばずバスエラー自体を発火させない
 * (px68k-libretro/m68000/musashi/m68kcpu.h の
 * `#define EXCEPTION_BUS_ERROR 2 /* This one is not emulated! *​/` で確認済み、
 * かつ m68k_pulse_bus_error の呼び出し箇所がリポジトリ全体に存在しないことを
 * grepで確認済み)。このため本検証ではバスエラーの発火テストは行わない
 * (行っても px68k 上では絶対に発火せずタイムアウトするだけで、検査として
 * 意味を持たない)。詳細は docs/パニック画面_20260820.md 参照。
 *
 * 【PCの実測について】表示されるPCの値そのものが「本当に例外発生位置」で
 * あることをMotorola資料以上の手段で裏取りすることはしない(実機が無い)。
 * 実測するのは「例外発生位置(PAD個のNOPで意図的にずらした位置)を変えると
 * 表示されるPCの値が変わること」「毎回0のような固定値ではないこと」で、
 * 設計書の要求「値そのものの正しさまで見るのが難しければ、毎回同じ値では
 * ないこと・例外を起こした箇所を変えると値が変わることを見る」に対応する。
 *
 * 【VBR対応の確認】lib/asm/x68_panic.S の x68_panic_install は毎回
 * VBR=0への設定を試みてから4種のベクタを差し替える(cache_flush.Sと同じ
 * 「MOVECを試し、不正命令なら諦める」手法)。この処理は本検証の全ての
 * 陽性テストで無条件に通る経路なので、陽性テストが3種ともPASSすること
 * こそが「VBR設定コードを含む版が68000で正常に起動し、既存の動作(ハンドラ
 * 差し替え)が壊れていないこと」の実測になる。68030側(MOVECが成功する経路)は
 * 本検証環境(px68k、常に68000として初期化)では原理的に実測できない
 * (docs/StageE-5_実測_20260819.md・docs/パニック画面_20260820.md参照)。
 *
 * すべて同期実行。バックグラウンドに投げない。runFrame()呼び出しごとに
 * フレーム数を数え、makeDeadline()で壁時計ベースのタイムアウトも併用する
 * (ハンドラが捕捉に失敗するとゲストが無応答になる可能性があるため、
 * タイムアウトが必ず機能することが必須。故障注入 no_install はまさに
 * この経路を踏む)。
 *
 * 使い方: npx tsx verify/verify_panic.mts
 * 環境変数: WEBX68K_DIR(既定 ../WebX68k)、MAX_FRAMES(既定 1500)
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

/* --- HOSTVAR アドレス(lib_test/src/main_panic.c と一致させること) --- */
const HV4_BASE = 0x000dc000;
const HV4_ALIVE = HV4_BASE + 0x00;
const HV4_RETURNED = HV4_BASE + 0x04;
const HV4_DONE = HV4_BASE + 0x08;
const HV4_DONE_MAGIC = 0xc3d4e5f6;

const MAX_FRAMES = Number(process.env.MAX_FRAMES ?? 1500);
const EXTRA_FRAMES_AFTER_ALIVE = 60; // ALIVE=1後、ハンドラが動く/DONEが立つ猶予
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

const CORE_OPTIONS_USED = {
  px68k_cpuspeed: '16Mhz',
  px68k_ramsize: '1MB',
  // Stage E-2で踏んだ既知の罠(未設定だとコアが実時間に自己同期する)への対策。
  px68k_no_wait_mode: 'enabled',
};

/* --- フレームバッファ上での可視性判定 ---
 * 【重要な罠(2026-08-20、並行実測 docs/重なり実測_20260820.md により発覚)】
 * 65536色グラフィックモードが有効な間、その512ドット幅の範囲(x=0〜511)では
 * テキストがText VRAMには正しく書き込まれてもフレームバッファには一切
 * 現れない(モードレベルの排他。ピクセル単位の合成ではない)。
 * host.readTextScreen()はText VRAMを直接読む経路であり、この排他を
 * 経由しないため、**readTextScreen()だけでは「実際に画面に見えているか」を
 * 検証できない**(グラフィックモードを解除し忘れても検査が空振りでPASS
 * してしまう)。このため本検証では、実際にレンダリングされたcanvas
 * (putImageDataで捕まえる、verify_l1.mts/verify_breakout.mts/
 * verify_overlay.mtsと同じ経路)上で「背景色から実際に変化した画素が
 * 一定数以上あるか」を主要な合格条件にする。 */
interface Image { width: number; height: number; data: Uint8ClampedArray; }

/* メッセージが表示される左上矩形(x:0-260,y:0-48。3行ぶん、96桁x32行の
 * テキスト座標系で桁0〜32・行0〜2相当)を、遠く離れた基準画素(x=450,y=350。
 * どのメッセージも到達しない領域)と比較する。RGB距離が閾値を超える画素の
 * 個数を返す(verify_l1.mts等のPIXEL_DIST_THRESHOLD=90より緩い40を使う。
 * 文字の輪郭は背景と完全な二値ではなくアンチエイリアシング相当のにじみを
 * 持ちうるため、実測(diffCount=1151 vs 0)を踏まえて検出感度を優先した)。 */
const TEXT_REGION = { x0: 0, y0: 0, x1: 260, y1: 48 };
const TEXT_REF_POINT = { x: 450, y: 350 };
const TEXT_VISIBLE_DIST_THRESHOLD = 40;
const TEXT_VISIBLE_MIN_DIFF_PIXELS = 50; // 実測(no_mode_restoreで0、通常で1000超)を踏まえた閾値

function samplePixel(img: Image, x: number, y: number): [number, number, number] {
  const idx = (y * img.width + x) * 4;
  return [img.data[idx], img.data[idx + 1], img.data[idx + 2]];
}

function textVisibleInFramebuffer(img: Image | null): { visible: boolean; diffCount: number } {
  if (!img || img.width <= TEXT_REF_POINT.x || img.height <= TEXT_REF_POINT.y) {
    return { visible: false, diffCount: 0 };
  }
  const ref = samplePixel(img, TEXT_REF_POINT.x, TEXT_REF_POINT.y);
  let diffCount = 0;
  for (let y = TEXT_REGION.y0; y < TEXT_REGION.y1 && y < img.height; y++) {
    for (let x = TEXT_REGION.x0; x < TEXT_REGION.x1 && x < img.width; x++) {
      const [r, g, b] = samplePixel(img, x, y);
      const dr = r - ref[0], dg = g - ref[1], db = b - ref[2];
      if (Math.sqrt(dr * dr + dg * dg + db * db) > TEXT_VISIBLE_DIST_THRESHOLD) diffCount++;
    }
  }
  return { visible: diffCount >= TEXT_VISIBLE_MIN_DIFF_PIXELS, diffCount };
}

/* --- 「グラフィックページ復元」マーカーの可視性判定(2026-08-20追加) ---
 * 【なぜ追加したか】上のtextVisibleInFramebuffer()は「テキストが見えるか」
 * だけを見ていたが、docs/VC重畳実測_20260820.mdの実測でライブラリ既定値が
 * VC_R2=0x21(グラフィックとテキストが同時に見える値)になったため、
 * x68_panic_show()がVC R2を復元しなくても(=故障注入no_mode_restoreでも)
 * テキストは見えてしまうようになった。つまりtextVisibleInFramebuffer()
 * だけではこの故障注入をもう検出できない(実際に検出できなくなったことを
 * 本ファイル改修前に実測で確認した)。
 *
 * lib_test/src/main_panic.c は例外を起こす直前に、パニックメッセージと
 * 同じ領域へシアン系の矩形(x68_rgb(0,255,255))を描いてflipしている。
 * x68_panic_show()の復元処理(VC_R2=0x20、グラフィックページ表示ビットを
 * クリア)が働けば、この矩形はフレームバッファから消えるはず(=復元が
 * 実際に効いていることの実測)。故障注入no_mode_restoreではこの復元が
 * 起きないので、矩形は消えずに残り続けるはず。 */
const MARKER_REGION = { x0: 0, y0: 0, x1: 240, y1: 40 }; // main_panic.cが描くx68_box_fill(0,0,240,40,...)と一致させる
const MARKER_RGB_16 = ((31 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0; // x68_rgb(0,255,255): g5=31,r5=0,b5=31,I=1
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
const MARKER_RGB = decode16to24(MARKER_RGB_16);
const MARKER_DIST_THRESHOLD = 40;
const MARKER_MIN_MATCH_PIXELS = 50; // 矩形240x40=9600pxのうち、一部でも残っていれば検出したい

function markerVisibleInFramebuffer(img: Image | null): { visible: boolean; matchCount: number } {
  if (!img) return { visible: false, matchCount: 0 };
  let matchCount = 0;
  for (let y = MARKER_REGION.y0; y < MARKER_REGION.y1 && y < img.height; y++) {
    for (let x = MARKER_REGION.x0; x < MARKER_REGION.x1 && x < img.width; x++) {
      const [r, g, b] = samplePixel(img, x, y);
      const dr = r - MARKER_RGB[0], dg = g - MARKER_RGB[1], db = b - MARKER_RGB[2];
      if (Math.sqrt(dr * dr + dg * dg + db * db) <= MARKER_DIST_THRESHOLD) matchCount++;
    }
  }
  return { visible: matchCount >= MARKER_MIN_MATCH_PIXELS, matchCount };
}

interface Session {
  runFrame(): void;
  peekByteAt(addr: number): number;
  peekU32(addr: number): number;
  readTextLines(): string[];
  lastImage(): Image | null;
  dispose(): void;
}

async function bootSession(label: string, diskBytes: Uint8Array): Promise<Session> {
  const { LibretroHost } = await import(pathToFileURL(resolve(WEBX68K_DIR, 'src/libretro-host.ts')).href);

  (globalThis as any).window = { PX68K: loadFactory() };
  let lastImg: Image | null = null;
  const context = {
    createImageData(width: number, height: number) {
      const w = Math.max(0, width | 0);
      const h = Math.max(0, height | 0);
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
  const diskPath = host.writeDiskImage(`fdd0_${label}.xdf`, diskBytes);
  host.writeFile('/game/boot.cmd', new TextEncoder().encode(`px68k "${diskPath}" ""\n`));
  if (!host.loadGame('/game/boot.cmd')) throw new Error(`${label}: loadGame失敗`);
  host.fetchAvInfo();

  return {
    runFrame() { host.runFrame(); },
    peekByteAt(addr: number) { return host.peekByte(addr); },
    peekU32(addr: number) {
      const hi = host.peekWord(addr) >>> 0;
      const lo = host.peekWord(addr + 2) >>> 0;
      return (hi * 0x10000 + lo) >>> 0;
    },
    readTextLines() {
      const dump = host.readTextScreen();
      return (dump.lines as string[]).filter((l: string) => l.trim());
    },
    lastImage() { return lastImg; },
    dispose() { host.dispose(); },
  };
}

function buildPanicImage(outPath: string, fault: string, mode: 0 | 1, excType: number, pad: number): void {
  execFileSync('bash', [
    resolve(DEV_ROOT, 'tools/build_panic_test.sh'),
    outPath, fault, String(mode), String(excType), String(pad),
  ], { cwd: DEV_ROOT, stdio: 'pipe' });
}

interface RunResult {
  aliveSeen: boolean;
  doneSeen: boolean;
  returnedSeen: boolean;
  framesRun: number;
  timedOut: boolean;
  textLines: string[];
  fbVisible: boolean;
  fbDiffCount: number;
  markerVisible: boolean;
  markerMatchCount: number;
}

/* HV4_ALIVEが立つのを待ち、その後 EXTRA_FRAMES_AFTER_ALIVE フレームだけ
 * 追加で走らせてから判定する(ハンドラは無限ループで停止する設計のため、
 * 「捕捉できた」ことを示すDONE_FLAG的な合図は無い。verify_e5.mtsと同じ方式)。 */
async function runAndMeasure(label: string, diskBytes: Uint8Array): Promise<RunResult> {
  const session = await bootSession(label, diskBytes);
  const checkDeadline = makeDeadline(label, MAX_FRAMES);
  let framesRun = 0;
  let aliveSeen = session.peekByteAt(HV4_ALIVE) === 1;
  let timedOut = false;
  try {
    while (!aliveSeen && framesRun < MAX_FRAMES) {
      session.runFrame();
      framesRun++;
      if (framesRun % 100 === 0) checkDeadline();
      aliveSeen = session.peekByteAt(HV4_ALIVE) === 1;
    }
    if (aliveSeen) {
      for (let i = 0; i < EXTRA_FRAMES_AFTER_ALIVE; i++) {
        session.runFrame();
        framesRun++;
        if (i % 20 === 0) checkDeadline();
      }
    }
  } catch (e) {
    timedOut = true;
  }
  const doneSeen = session.peekU32(HV4_DONE) === HV4_DONE_MAGIC;
  const returnedSeen = session.peekByteAt(HV4_RETURNED) === 1;
  const textLines = session.readTextLines();
  const lastImg = session.lastImage();
  const { visible: fbVisible, diffCount: fbDiffCount } = textVisibleInFramebuffer(lastImg);
  const { visible: markerVisible, matchCount: markerMatchCount } = markerVisibleInFramebuffer(lastImg);
  session.dispose();
  return { aliveSeen, doneSeen, returnedSeen, framesRun, timedOut, textLines, fbVisible, fbDiffCount, markerVisible, markerMatchCount };
}

async function runBuild(label: string, fault: string, mode: 0 | 1, excType: number, pad: number): Promise<RunResult> {
  const imgPath = resolve(DEV_ROOT, `build/panic_${label}.xdf`);
  buildPanicImage(imgPath, fault, mode, excType, pad);
  return runAndMeasure(label, new Uint8Array(readFileSync(imgPath)));
}

/* --- 種別ごとの期待値(lib/asm/x68_panic.Sの.byte列と一致する文字列。
 * host側はJSのUTF-8リテラルとして独立に書き下ろす。1文字ずつ照合するのが
 * 目的ではなく「host側が期待する日本語がそのままテキストVRAMから読み戻せる
 * か」を実測するのが目的なので、ここでの一致がすなわち実測結果になる)。 --- */
const EXC_NAMES: Record<number, string> = { 3: 'ADDRESS_ERROR(vector3)', 4: 'ILLEGAL_INSTRUCTION(vector4)', 5: 'ZERO_DIVIDE(vector5)' };
const EXPECTED_TEXT: Record<number, string> = {
  3: 'アドレスエラーが発生しました',
  4: '不正な命令を実行しました',
  5: 'ゼロで割り算をしました',
};
const STOP_TEXT = 'プログラムを停止します';

function extractPc(lines: string[]): number | undefined {
  for (const line of lines) {
    const m = line.match(/PC\s*=\s*\$([0-9a-fA-F]+)/);
    if (m) return parseInt(m[1], 16);
  }
  return undefined;
}

function hasAnyExpectedText(lines: string[]): number[] {
  const found: number[] = [];
  for (const t of [3, 4, 5]) {
    if (lines.some((l) => l.includes(EXPECTED_TEXT[t]))) found.push(t);
  }
  return found;
}

async function main(): Promise<void> {
  console.log(`WEBX68K_DIR=${WEBX68K_DIR}`);
  console.log(`RESULT: PANIC_CORE_OPTIONS_SET=${JSON.stringify(CORE_OPTIONS_USED)}`);
  console.log(`MAX_FRAMES=${MAX_FRAMES} EXTRA_FRAMES_AFTER_ALIVE=${EXTRA_FRAMES_AFTER_ALIVE}`);

  let overallOk = true;
  const fail = (msg: string) => { console.log(`FAIL: ${msg}`); overallOk = false; };

  /* ---- 手順1: 3種の陽性テスト(通常ビルド、PAD=0) ---- */
  console.log('--- 手順1: 3種の陽性テスト(パニック画面が出るか・PCが表示されるか) ---');
  const positivePc: Record<number, number | undefined> = {};
  const positiveTextsFound: Record<number, number[]> = {};
  for (const t of [3, 4, 5]) {
    const r = await runBuild(`pos_t${t}`, '', 0, t, 0);
    const pc = extractPc(r.textLines);
    const found = hasAnyExpectedText(r.textLines);
    const stopOk = r.textLines.some((l) => l.includes(STOP_TEXT));
    const expectOk = found.length === 1 && found[0] === t;
    positivePc[t] = pc;
    positiveTextsFound[t] = found;
    // 【重要】readTextScreen()(Text VRAM直読み)だけでなく、実際に
    // レンダリングされたcanvas上で文字が見えているか(r.fbVisible)も
    // 合格条件に含める。65536色グラフィックモードがテキストを隠す罠
    // (docs/重なり実測_20260820.md)を検査自体が踏んでいないことの担保。
    // さらに、VC_R2既定値が0x21になった(docs/VC重畳実測_20260820.md)ことで
    // fbVisibleだけでは「復元処理が実際に効いているか」を検出できなくなった
    // ため、markerVisible===false(グラフィックページ復元マーカーが消えて
    // いること)も合格条件に含める(下記「故障4」参照)。
    const ok = r.aliveSeen && !r.timedOut && !r.returnedSeen && !r.doneSeen && expectOk && pc !== undefined && stopOk && r.fbVisible && !r.markerVisible;
    console.log(`RESULT: PANIC_POSITIVE type=${EXC_NAMES[t]} aliveSeen=${r.aliveSeen} timedOut=${r.timedOut} returnedSeen=${r.returnedSeen} doneSeen=${r.doneSeen} foundTypes=${JSON.stringify(found)} pc=${pc !== undefined ? '0x' + pc.toString(16) : 'undefined'} stopOk=${stopOk} fbVisible=${r.fbVisible}(diffCount=${r.fbDiffCount}) markerVisible=${r.markerVisible}(matchCount=${r.markerMatchCount}) ok=${ok}`);
    console.log(`RESULT: PANIC_POSITIVE_TEXTLINES type=${EXC_NAMES[t]} textLines=${JSON.stringify(r.textLines)}`);
    if (!ok) fail(`陽性テスト(${EXC_NAMES[t]})が不合格`);
  }

  /* ---- 手順2: 3種の弁別(手順1で得たメッセージが3種とも別々か) ---- */
  console.log('--- 手順2: 3種の弁別 ---');
  const distinctMessages = new Set([3, 4, 5].map((t) => positiveTextsFound[t][0])).size === 3
    && [3, 4, 5].every((t) => positiveTextsFound[t].length === 1);
  console.log(`RESULT: PANIC_TYPES_DISTINCT=${distinctMessages}`);
  if (!distinctMessages) fail('3種のパニック画面が別々のメッセージとして弁別できなかった');

  /* ---- 手順3: PCの値が「毎回同じ値ではない」「例外を起こした箇所を変えると
   * 変わる」ことを確認する(EXC_TYPE=4固定、PADで発生位置をずらす) ---- */
  console.log('--- 手順3: PCが例外発生位置に応じて変わるか(PAD=0 と PAD=8 を比較) ---');
  const rPad0 = await runBuild('pad0', '', 0, 4, 0);
  const rPad8 = await runBuild('pad8', '', 0, 4, 8);
  const pcPad0 = extractPc(rPad0.textLines);
  const pcPad8 = extractPc(rPad8.textLines);
  const pcChanges = pcPad0 !== undefined && pcPad8 !== undefined && pcPad0 !== pcPad8;
  const pcNonZero = pcPad0 !== undefined && pcPad0 !== 0 && pcPad8 !== undefined && pcPad8 !== 0;
  console.log(`RESULT: PANIC_PC_CHANGES_WITH_LOCATION pad0=${pcPad0 !== undefined ? '0x' + pcPad0.toString(16) : 'undefined'} pad8=${pcPad8 !== undefined ? '0x' + pcPad8.toString(16) : 'undefined'} changes=${pcChanges} nonZero=${pcNonZero}`);
  if (!pcChanges) fail('PADを変えてもPCの表示値が変化しなかった');
  if (!pcNonZero) fail('PCの表示値が0だった(常に0を表示している疑い)');

  /* ---- 手順4: 陰性対照(例外を起こさない通常実行ではパニック画面が出ない) ---- */
  console.log('--- 手順4: 陰性対照(MODE=1、例外を起こさない) ---');
  let negControlOk = true;
  for (const t of [3, 4, 5]) {
    const r = await runBuild(`neg_t${t}`, '', 1, t, 0);
    const found = hasAnyExpectedText(r.textLines);
    const ok = r.aliveSeen && !r.timedOut && !r.returnedSeen && r.doneSeen && found.length === 0;
    negControlOk = negControlOk && ok;
    console.log(`RESULT: PANIC_NEGATIVE_CONTROL type=${EXC_NAMES[t]} aliveSeen=${r.aliveSeen} timedOut=${r.timedOut} doneSeen=${r.doneSeen} foundTypes=${JSON.stringify(found)} ok=${ok}`);
  }
  console.log(`RESULT: PANIC_NEGATIVE_CONTROL_ALL_OK=${negControlOk}`);
  if (!negControlOk) fail('陰性対照(例外を起こさない実行)でパニック画面相当の兆候が出た、または正常終了に到達しなかった');

  /* ---- 手順5: 故障注入(4件、それぞれ実際にFAILすることを確認) ---- */
  console.log('--- 手順5: 故障注入(4件、それぞれ検査が実際にFAILすることを確認) ---');
  let faultInjectionOk = true;

  // 故障1: no_install(ハンドラを差し替えない) → パニック画面が出ずFAILするはず
  {
    const r = await runBuild('fault_no_install', 'no_install', 0, 4, 0);
    const found = hasAnyExpectedText(r.textLines);
    // 「パニック画面が出ないこと」自体が故障の症状。検査(=陽性テストと同じ
    // 判定式)を適用すると当然FAILになるはずなので、それを確認する。
    const detectionFailedAsExpected = found.length === 0; // 期待メッセージが出ていない=検査がFAILする状況を検出できている
    faultInjectionOk = faultInjectionOk && detectionFailedAsExpected;
    console.log(`RESULT: PANIC_FAULT_NO_INSTALL aliveSeen=${r.aliveSeen} timedOut=${r.timedOut} returnedSeen=${r.returnedSeen} foundTypes=${JSON.stringify(found)} detectionFailedAsExpected=${detectionFailedAsExpected}`);
    if (!detectionFailedAsExpected) fail('故障注入no_installで、壊れているのにパニック画面が出てしまった(検査が空振り)');
  }

  // 故障2: same_message(3種すべて同じメッセージ) → 弁別検査がFAILするはず
  {
    const foundByType: Record<number, number[]> = {};
    for (const t of [3, 4, 5]) {
      const r = await runBuild(`fault_same_message_t${t}`, 'same_message', 0, t, 0);
      foundByType[t] = hasAnyExpectedText(r.textLines);
    }
    // same_messageは常にILLEGAL(4)のメッセージを出す実装なので、
    // 3種とも foundByType[t] = [4] になり、弁別検査(手順2と同じ式)はFAILするはず。
    const wouldBeDistinct = new Set([3, 4, 5].map((t) => foundByType[t][0])).size === 3
      && [3, 4, 5].every((t) => foundByType[t].length === 1);
    const detectionFailedAsExpected = !wouldBeDistinct;
    faultInjectionOk = faultInjectionOk && detectionFailedAsExpected;
    console.log(`RESULT: PANIC_FAULT_SAME_MESSAGE foundByType=${JSON.stringify(foundByType)} wouldBeDistinct=${wouldBeDistinct} detectionFailedAsExpected=${detectionFailedAsExpected}`);
    if (!detectionFailedAsExpected) fail('故障注入same_messageで、壊れているのに3種が弁別できてしまった(検査が空振り)');
  }

  // 故障3: pc_zero(PCの値を常に0で表示する) → PC非ゼロ検査がFAILするはず
  {
    const r = await runBuild('fault_pc_zero', 'pc_zero', 0, 4, 0);
    const pc = extractPc(r.textLines);
    const detectionFailedAsExpected = pc === 0; // 「非ゼロであるべき」検査が期待通りFAILする(pc===0)状況を検出
    faultInjectionOk = faultInjectionOk && detectionFailedAsExpected;
    console.log(`RESULT: PANIC_FAULT_PC_ZERO pc=${pc !== undefined ? '0x' + pc.toString(16) : 'undefined'} detectionFailedAsExpected=${detectionFailedAsExpected}`);
    if (!detectionFailedAsExpected) fail('故障注入pc_zeroで、壊れているのにPCが非ゼロのまま表示された(検査が空振り)');
  }

  // 故障4(2026-08-20追加、同日中に検出方法を改修): no_mode_restore
  // (65536色グラフィックモードを解除しない)。
  //
  // 【改修の経緯(誤りの記録)】当初はこの故障を「readTextScreen()には
  // メッセージが出るが、実際にレンダリングされたフレームバッファには
  // 出ない」で検出していた(r.fbVisibleがFAILすることを期待)。ところが
  // 同日中に並行して進んだdocs/VC重畳実測_20260820.mdの実測で、
  // x68_gvram_mode_65536_1page()の既定値がVC_R2=0x01→0x21(グラフィックと
  // テキストが同時に見える値)へ修正された。この修正により、
  // x68_panic_show()が復元処理をしなくてもテキストは既定でフレーム
  // バッファに見えるようになったため、上記の検出方法(r.fbVisibleが
  // FAILする)が成立しなくなった(本ファイルの改修前に実際に空振り
  // <detectionFailedAsExpected=false>することを実測で確認した)。
  //
  // 代わりに、lib_test/src/main_panic.c が例外直前に描く「グラフィック
  // ページ復元マーカー」(x68_box_fill+x68_rgb(0,255,255)の矩形)を使う。
  // 復元処理(VC_R2=0x20でグラフィックページ表示ビットをクリア)が働けば
  // このマーカーは消えるはずで、故障注入(復元しない)では消えずに残る
  // はず。マーカーが残っている(markerVisible===true)ことが、この故障の
  // 検出条件になる。
  {
    const r = await runBuild('fault_no_mode_restore', 'no_mode_restore', 0, 4, 0);
    const found = hasAnyExpectedText(r.textLines);
    const textVramStillHasMessage = found.length === 1 && found[0] === 4; // Text VRAM経路(readTextScreen)には出ている
    const detectionFailedAsExpected = r.markerVisible; // マーカーが消えずに残っている(=検査がFAILする状況を検出)
    faultInjectionOk = faultInjectionOk && detectionFailedAsExpected;
    console.log(`RESULT: PANIC_FAULT_NO_MODE_RESTORE textVramStillHasMessage=${textVramStillHasMessage} fbVisible=${r.fbVisible}(diffCount=${r.fbDiffCount}) markerVisible=${r.markerVisible}(matchCount=${r.markerMatchCount}) detectionFailedAsExpected=${detectionFailedAsExpected}`);
    if (!textVramStillHasMessage) fail('故障注入no_mode_restoreで、前提(Text VRAMにはメッセージが書かれているはず)が崩れた');
    if (!detectionFailedAsExpected) fail('故障注入no_mode_restoreで、グラフィックページ復元マーカーが消えてしまった(検査が空振り)');
  }

  console.log(`RESULT: PANIC_FAULT_INJECTION_ALL_DETECTED=${faultInjectionOk}`);
  if (!faultInjectionOk) fail('故障注入のいずれかが検査をすり抜けた(空振り)');

  /* ---- 手順6: 既存検証の回帰確認 ---- */
  console.log('--- 手順6: 既存検証の回帰確認(verify_lib/verify_l1/verify_breakout) ---');
  const REGRESSION_SCRIPTS = ['verify/verify_lib.mts', 'verify/verify_l1.mts', 'verify/verify_breakout.mts'];
  const regressionResults: Record<string, boolean> = {};
  for (const script of REGRESSION_SCRIPTS) {
    let ok = true;
    try {
      execFileSync('npx', ['tsx', script], { cwd: DEV_ROOT, stdio: 'pipe', timeout: 300_000 });
    } catch (e) {
      ok = false;
    }
    regressionResults[script] = ok;
    console.log(`RESULT: PANIC_REGRESSION script=${script} ok=${ok}`);
    if (!ok) fail(`回帰確認: ${script} がFAILした(x68_screen_open()の変更による影響の疑い)`);
  }

  console.log('--- 結論 ---');
  console.log(`RESULT: PANIC_PASS=${overallOk}`);
  if (!overallOk) process.exitCode = 1;

  console.log('---JSON---');
  console.log(JSON.stringify({
    positivePc: Object.fromEntries(Object.entries(positivePc).map(([k, v]) => [k, v !== undefined ? '0x' + v.toString(16) : null])),
    distinctMessages,
    pcChanges,
    pcNonZero,
    negControlOk,
    faultInjectionOk,
    regressionResults,
    overallOk,
  }, null, 2));
}

await main();
