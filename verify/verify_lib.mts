/*
 * Sprout68k ライブラリ第一版(L0 + 標準名の層、lib/)の検証。px68k(WebX68k のコア)
 * 上で lib_test/src/main.c を実際に走らせ、末端(ゲストメモリ・テキスト画面・
 * フレームバッファ)を実測して照合する。ブラウザは使わず Node から直接コアを
 * 回す(verify_e1〜e6.mts のコア駆動部分を踏襲。__BUILD_ID__/locateFile の2つの
 * 罠、makeDeadline の自前タイムアウト、px68k_no_wait_mode=enabled は同じ)。
 *
 * 検査の構成:
 *   - memcpy/memset: ゲスト内の自己判定だけでなく、host側がバッファの中身を
 *     直接peekByte()で読んで独立に照合する(自己申告を信じない)。
 *   - strlen/abs/rand: 結果値をhostがpeekして期待値と突き合わせる。rand()は
 *     同じ種を2回与えたときの再現性をhost側が独立に比較する。
 *   - IOCS $46(x68_iocs_disk_read): track30/side0/sector1に焼き込んだ既知
 *     パターンをhostが独立に生成し、読み込んだバッファと比較する。
 *   - x68_vsync_wait: Stage E-2と同じ方式(measure窓でのhost側runFrame()回数と
 *     ゲスト内カウンタ増分の比)で実測する。**最終カウンタが上限(300)に到達
 *     したことだけを見る判定は、即returnする実装でも同じ最終値になり区別
 *     できないため使わない**(2026-08-19、指摘を受けて修正した2つの穴のうち1つ)。
 *   - x68_iocs_bitsns: host側がsetKey(RETROK_SPACE)でSPACEキーを押し分けながら
 *     runFrame()を1回ずつ進め、ゲストが履歴配列に書いた生の戻り値を読んで
 *     押下/解放に追従しているか確認する(Stage E-4と同じ「状態を変えてから
 *     次のフレームで読む」順序)。
 *   - x68_gvram_mode_65536_1page / x68_gvram_copy_movem: フレームバッファを
 *     実際にレンダリングし、各サンプル点の観測色に最も近い「期待候補」
 *     (decode16to24(genColor(i))で算出)を求め、自分自身の期待値と一致するかを
 *     見る。**「背景色でない」「互いに区別できる」だけの判定は、転送先が
 *     1ワードずれても各点の色が別の期待色に入れ替わるだけで両条件とも保たれて
 *     しまいPASSしてしまうため使わない**(指摘を受けて修正したもう1つの穴)。
 *   - printf/puts: readTextScreen()で実際の文字表示を読み、期待した文字列と
 *     突き合わせる(自己申告で済ませない)。非対応書式は[BADFMT]が実際に
 *     表示されることを確認する。
 *
 * 故障注入(6件): memcpy_skip_last / strlen_off_by_one / printf_drop_sign
 * (以上、初回実装時の3件)に加えて vsync_no_wait / gvram_copy_offset /
 * bitsns_always_zero(上記2つの穴の指摘を受けて追加した3件)。それぞれについて
 * tools/build_lib_test.sh に fault 引数を渡した版をビルドし、対応する検査が
 * 実際にFAILすることを確認する。FAILしなければ検査が空振りしていると判定し、
 * そのテストをFAILとして報告する(緩めてPASS扱いにしない)。
 *
 * 使い方: npx tsx verify/verify_lib.mts
 * 環境変数: WEBX68K_DIR(既定 ../WebX68k)、WARMUP(既定 1500)
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

/* --- 自前タイムアウト(既存verify_*.mtsを踏襲) --- */
const DEADLINE_BASE_MS = 60_000;
const DEADLINE_MS_PER_FRAME = 20;
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
  // Stage E-2 で踏んだ既知の罠(未設定だとコアが実時間に自己同期する)への対策。
  px68k_no_wait_mode: 'enabled',
};

const WARMUP = Number(process.env.WARMUP ?? 1500);

/* --- HOSTVAR アドレス(lib_test/src/main.c と一致させること) --- */
const HV_BASE = 0x000d0000;
const HV_PROGRESS = HV_BASE + 0x0000;
const HV_RESULTS = HV_BASE + 0x0010;
const BUF_MEMCPY_SRC = HV_BASE + 0x1000;
const BUF_MEMCPY_DST = HV_BASE + 0x1100;
const BUF_MEMSET_DST = HV_BASE + 0x1200;
const HV_STRLEN_RESULT = HV_BASE + 0x1300;
const HV_ABS_RESULT = (i: number) => HV_BASE + 0x1310 + i * 4;
const HV_RAND_SEQ_A = (i: number) => HV_BASE + 0x1400 + i * 4;
const HV_RAND_SEQ_B = (i: number) => HV_BASE + 0x1420 + i * 4;
const BUF_DISKREAD_DST = HV_BASE + 0x1500;
const HV_VSYNC_COUNTER = HV_BASE + 0x2000;
const BUF_BITSNS_HISTORY = HV_BASE + 0x2100;
const HV_BITSNS_COUNT = HV_BASE + 0x2200;
const BITSNS_HISTORY_LEN = 200;
const HV_DONE = HV_BASE + 0x3000;
const HV_DONE_MAGIC = 0xc0debeef;

const R_MEMCPY = 0, R_MEMSET = 1, R_STRLEN = 2, R_ABS = 3, R_RAND = 4, R_DISKREAD = 5, R_BITSNS = 6;

/* x68_vsync_wait のペーシング判定基準(Stage E-2 verify_e2.mts と同じ値)。 */
const RATE_LOW = 0.5;
const RATE_HIGH = 2.0;

const RETROK_SPACE = 32;
const BIT_SPACE = 1 << (0x35 & 7); // group6 bit5(docs/API設計_20260819.md のX68_KEY_SPACEと同じ)

/* --- GVRAM色生成式(lib_test/src/main.cのgen_color()と同じ。5-5-5-1、Stage E-1のgenColor()を踏襲) --- */
function genColor(i: number): number {
  const g = (i * 7) % 32;
  const r = (i * 11) % 32;
  const b = (i * 17) % 32;
  return ((g & 0x1f) << 11) | ((r & 0x1f) << 6) | ((b & 0x1f) << 1) | 1;
}
const GVRAM_DIRECT_OFF_A = 100;
const GVRAM_DIRECT_OFF_B = 300;
const GVRAM_COPY_BASE_OFF = 20000;
const GVRAM_COPY_WORDS = 16; // x68_gvram_copy_movemで転送する1バッチぶんのワード数
const GVRAM_STRIDE = 512; // Stage E-1で実測確定

/* --- GVRAM 16bit色値 → 実際にcanvasへ出るRGB8の変換式 ---
 * px68k-libretro(x68k/palette.c Pal_SetColor、libretro/windraw.c)と
 * WebX68k(src/libretro-host.ts の handleVideoRefresh、RGB565→RGBA8変換)の
 * ソースを実際に読んで確認した変換パイプライン(このverifyスクリプトを書く
 * 時点でエージェントが該当ソースを検索し実装を確認済み。手読みで済ませず
 * ソースの記述そのものを根拠にしている):
 *   1. GVRAM語(G5 R5 B5 I1、bit15-11=G、bit10-6=R、bit5-1=B、bit0=I)から
 *      G5/R5/B5/Iを抜き出す。
 *   2. 内部的にRGB565へ詰め直す。R5→R565(5bitそのまま)、B5→B565(5bitそのまま)、
 *      G565(6bit)は "G5<<1 | I" (Iビットはgreenの最下位ビットに落ちる。
 *      赤・青には効かない、というこのエミュレータ実装固有の簡略化)。
 *   3. RGB565→RGB888は5bit/6bitのビット複製方式: (v<<3)|(v>>2)(5bit)、
 *      (v<<2)|(v>>4)(6bit)。
 * ただし実際にcanvasから読み取れる色は、この変換に加えてcanvas側の
 * 拡大縮小に伴う補間(アンチエイリアス)で背景色と混ざるため、変換式通りの
 * 値と完全一致はしない(実測: 単純な非背景判定+相互区別だけでは transferの
 * オフセットずれを検出できないという指摘を受け、以下のGVRAM検査では
 * 「観測色に最も近い期待候補」を求める方式にした。混色があっても、期待候補
 * 同士は離れているぶん最近傍判定は揺らがない)。 */
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

/* --- ディスク読み込みテストの期待パターン(tools/build_lib_test.shと同じ生成規則) --- */
function expectedDiskPattern(): Uint8Array {
  const sig = Buffer.from('X68DISKTEST', 'ascii');
  const buf = new Uint8Array(1024);
  buf.set(sig, 0);
  for (let i = sig.length; i < 1024; i++) buf[i] = i & 0xff;
  return buf;
}

interface Image { width: number; height: number; data: Uint8ClampedArray; }

interface Session {
  host: any;
  runFrame(): void;
  peekByte(addr: number): number;
  peekU32(addr: number): number;
  setKey(retrok: number, down: boolean): void;
  readTextScreen(): { lines: string[] };
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
    host,
    runFrame() { host.runFrame(); },
    peekByte(addr: number) { return host.peekByte(addr); },
    peekU32(addr: number) {
      const hi = host.peekWord(addr) >>> 0;
      const lo = host.peekWord(addr + 2) >>> 0;
      return (hi * 0x10000 + lo) >>> 0;
    },
    setKey(retrok: number, down: boolean) { host.setKey(retrok, down); },
    readTextScreen() { return host.readTextScreen(); },
    lastImage() { return lastImg; },
    dispose() { host.dispose(); },
  };
}

function buildLibTestImage(outPath: string, fault: string): void {
  const args = [resolve(DEV_ROOT, 'tools/build_lib_test.sh'), outPath];
  if (fault) args.push(fault);
  execFileSync('bash', args, { cwd: DEV_ROOT });
}

interface RunResult {
  reachedDone: boolean;
  results: number[]; // R_MEMCPY..R_BITSNS
  memcpySrc: Uint8Array;
  memcpyDst: Uint8Array;
  memsetDst: Uint8Array;
  strlenResult: number;
  absResults: number[];
  randA: number[];
  randB: number[];
  diskBuf: Uint8Array;
  vsyncCounter: number;
  vsyncRate: number; // (measure窓でのHV_VSYNC_COUNTER増分) / (measure窓のhostフレーム数)
  bitsnsHistory: number[];
  bitsnsCount: number;
  textLines: string[];
  lastImage: Image | null;
}

/* 本体プログラムを起動し、完了(HV_DONE)まで駆動して全結果を回収する。
 * driveKey=true のときだけ SPACE キーを押し分けながら BITSNS 履歴を実測する
 * (故障注入版の確認では毎回この重い駆動をする必要が無いので false にできる)。 */
async function runFullProgram(label: string, diskBytes: Uint8Array, driveKey: boolean): Promise<RunResult> {
  const session = await bootSession(label, diskBytes);
  const FRAME_BUDGET = WARMUP + 300 + BITSNS_HISTORY_LEN + 400;
  const checkDeadline = makeDeadline(label, FRAME_BUDGET);
  let frames = 0;
  const step = () => { session.runFrame(); frames++; if (frames % 50 === 0) checkDeadline(); };

  // 1〜4を1フレーム単位で統合する。
  // 【実測で判明した罠】WARMUPぶん(1500フレーム)を先にまとめて消費してから
  // HV_PROGRESS/HV_BITSNS_COUNTを見る実装(旧版)だと、その時点で既に
  // HV_DONEまで到達していた(=BITSNSテスト区間がWARMUP消化の途中で丸ごと
  // 過ぎ去っていた)。この環境ではブート完了後の1プログラム丸ごとの実行が
  // 1500ホストフレームよりずっと短い時間で終わる(px68k_no_wait_mode有効時の
  // 実際の消化ペースは事前に仮定できない)。**したがって粗いWARMUPの一括消化は
  // 使わず、起動直後から1フレームずつ進めてHV_BITSNS_COUNTを見ながらキーを
  // 押し分ける**(捉え損ないを避けるため、フレームの粒度を最初から最後まで
  // 一定に保つ)。
  const MAX_TOTAL_FRAMES = WARMUP + 500;
  let progress = 0;
  let count = 0;
  let done = 0;
  let dbgFrames = 0;
  let lastCount = -1;

  // x68_vsync_wait のペーシング実測(Stage E-2と同じ「host側フレーム数と
  // ゲスト内カウンタ増分の比」)。HV_PROGRESSが7になった瞬間(run_vsync_test
  // 開始直後、まだ1回も待っていない)を基準点にし、そこから固定のVSYNC_MEASURE_
  // FRAMESぶんだけhostフレームを進めた時点のHV_VSYNC_COUNTER増分を見る。
  // 【注意】最終的なHV_VSYNC_COUNTERが300(ループの上限)に到達したことだけを
  // 見る判定は、x68_vsync_waitが即returnする実装でも最終値が同じ300になり
  // 区別できない(指摘を受けて修正)。measure窓をループの上限(300)よりずっと
  // 小さくすることで、「正しく待てていれば窓内では終わらない」状態を作り、
  // 即returnする実装との違いを速さの比として検出できるようにする。
  const VSYNC_MEASURE_FRAMES = 50;
  let vsyncStartFrame = -1;
  let vsyncCounterAtStart = 0;
  let vsyncCounterAtMeasure = -1;

  while (done !== HV_DONE_MAGIC && dbgFrames < MAX_TOTAL_FRAMES) {
    const pressed = driveKey && count >= 60 && count < 140;
    session.setKey(RETROK_SPACE, pressed);
    step();
    dbgFrames++;
    progress = session.peekU32(HV_PROGRESS);
    count = session.peekU32(HV_BITSNS_COUNT);
    done = session.peekU32(HV_DONE);

    const vsyncCounterNow = session.peekU32(HV_VSYNC_COUNTER);
    if (vsyncStartFrame === -1 && progress >= 7) {
      vsyncStartFrame = dbgFrames;
      vsyncCounterAtStart = vsyncCounterNow;
    }
    if (vsyncStartFrame !== -1 && vsyncCounterAtMeasure === -1 && dbgFrames >= vsyncStartFrame + VSYNC_MEASURE_FRAMES) {
      vsyncCounterAtMeasure = vsyncCounterNow;
    }

    if (process.env.DEBUG_BITSNS && count !== lastCount) {
      console.log(`DBG frame=${dbgFrames} pressed=${pressed} progress=${progress} count=${count} done=${done.toString(16)}`);
      lastCount = count;
    }
  }
  session.setKey(RETROK_SPACE, false);
  if (process.env.DEBUG_BITSNS) {
    console.log(`DBG main loop finished at frame=${dbgFrames} progress=${progress} count=${count} done=${done.toString(16)}`);
  }
  // measure窓に届く前にHV_DONEへ到達してしまった場合(=極端に速い、故障注入の
  // 疑いが強いケース)のフォールバック: ループ終了時点までの実際の経過フレームと
  // カウンタ増分で比を計算する(それでも「速すぎる」ことは比の大きさに出る)。
  if (vsyncStartFrame !== -1 && vsyncCounterAtMeasure === -1) {
    vsyncCounterAtMeasure = session.peekU32(HV_VSYNC_COUNTER);
  }
  const vsyncMeasureFramesActual = vsyncStartFrame === -1 ? 0 : Math.max(1, Math.min(VSYNC_MEASURE_FRAMES, dbgFrames - vsyncStartFrame));
  const vsyncRate = vsyncStartFrame === -1 ? NaN : (vsyncCounterAtMeasure - vsyncCounterAtStart) / vsyncMeasureFramesActual;

  // 5. フレームバッファ確定のための settle。
  for (let i = 0; i < 120; i++) step();

  const results: number[] = [];
  for (let i = 0; i <= R_BITSNS; i++) results.push(session.peekByte(HV_RESULTS + i));

  const memcpySrc = new Uint8Array(64);
  const memcpyDst = new Uint8Array(64);
  const memsetDst = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    memcpySrc[i] = session.peekByte(BUF_MEMCPY_SRC + i);
    memcpyDst[i] = session.peekByte(BUF_MEMCPY_DST + i);
    memsetDst[i] = session.peekByte(BUF_MEMSET_DST + i);
  }

  const strlenResult = session.peekU32(HV_STRLEN_RESULT);
  const absResults = [0, 1, 2, 3].map((i) => session.peekU32(HV_ABS_RESULT(i)) | 0);
  const randA = [0, 1, 2, 3, 4].map((i) => session.peekU32(HV_RAND_SEQ_A(i)));
  const randB = [0, 1, 2, 3, 4].map((i) => session.peekU32(HV_RAND_SEQ_B(i)));

  const diskBuf = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) diskBuf[i] = session.peekByte(BUF_DISKREAD_DST + i);

  const vsyncCounter = session.peekU32(HV_VSYNC_COUNTER);
  const bitsnsHistory: number[] = [];
  for (let i = 0; i < BITSNS_HISTORY_LEN; i++) bitsnsHistory.push(session.peekByte(BUF_BITSNS_HISTORY + i));
  const bitsnsCount = session.peekU32(HV_BITSNS_COUNT);

  const dump = session.readTextScreen();
  const textLines: string[] = (dump as any).lines ?? [];
  const lastImage = session.lastImage();

  session.dispose();

  return {
    reachedDone: done === HV_DONE_MAGIC,
    results, memcpySrc, memcpyDst, memsetDst, strlenResult, absResults, randA, randB,
    diskBuf, vsyncCounter, vsyncRate, bitsnsHistory, bitsnsCount, textLines, lastImage,
  };
}

/* --- フレームバッファ解析(Stage E-1のrgbAt/dominantRgbを踏襲) --- */
function rgbAt(img: Image, x: number, y: number): [number, number, number] {
  const idx = (y * img.width + x) * 4;
  return [img.data[idx], img.data[idx + 1], img.data[idx + 2]];
}
function dominantRgb(img: Image): string {
  const counts = new Map<string, number>();
  for (let i = 0; i < img.data.length; i += 4) {
    const key = `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = ''; let bestCount = -1;
  for (const [k, c] of counts) if (c > bestCount) { best = k; bestCount = c; }
  return best;
}

function textAt(lines: string[], row: number, col: number, text: string): boolean {
  if (row < 0 || row >= lines.length) return false;
  const line = lines[row];
  if (col < 0) return false;
  const padded = line.padEnd(col + text.length, ' ');
  return padded.slice(col, col + text.length) === text;
}
function anyLineContains(lines: string[], text: string): boolean {
  return lines.some((l) => l.includes(text));
}

/* --- GVRAM検査: 観測色に最も近い「期待候補」を求め、自分自身の期待値と
 * 一致するか(かつ距離が閾値内か)を見る。単純な「背景色でない」「互いに
 * 区別できる」だけの判定だと、x68_gvram_copy_movemの転送先が1ワードずれても
 * (=各点の色がすべて「隣の期待色」に入れ替わるだけ)非背景かつ相互に区別
 * できる状態は保たれてしまいFAILしない、という指摘を受けて実装した。 */
interface GvramCandidate { label: string; rgb: [number, number, number]; }

function buildGvramCandidates(): GvramCandidate[] {
  const candidates: GvramCandidate[] = [{ label: 'background', rgb: [0, 0, 0] }];
  candidates.push({ label: 'direct_A', rgb: decode16to24(genColor(200)) });
  candidates.push({ label: 'direct_B', rgb: decode16to24(genColor(201)) });
  for (let i = 0; i < GVRAM_COPY_WORDS; i++) {
    candidates.push({ label: `copy_${i}`, rgb: decode16to24(genColor(i)) });
  }
  return candidates;
}

function distSq(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function nearestCandidate(rgb: [number, number, number], candidates: GvramCandidate[]): { label: string; dist: number } {
  let best = candidates[0];
  let bestDistSq = Infinity;
  for (const c of candidates) {
    const d = distSq(rgb, c.rgb);
    if (d < bestDistSq) { bestDistSq = d; best = c; }
  }
  return { label: best.label, dist: Math.sqrt(bestDistSq) };
}

/* canvasの拡大縮小に伴う補間で観測色は変換式そのままの値からずれるため
 * (verify_lib.mts冒頭のdecode16to24コメント参照)、実測(通常ビルド)で観測された
 * ずれ(距離約25〜31)に十分な余裕を見た閾値にする。期待候補同士(genColor()で
 * 生成した17色)は互いに大きく離れているため、この閾値でも取り違えは起きない。 */
const GVRAM_DIST_THRESHOLD = 80;

function checkGvram(img: Image | null, log: (s: string) => void): boolean {
  if (!img) { log('RESULT: GVRAM_FATAL=フレームバッファ未取得'); return false; }
  const backgroundRgb = dominantRgb(img);
  const candidates = buildGvramCandidates();
  const points: { n: number; label: string }[] = [
    { n: GVRAM_DIRECT_OFF_A, label: 'direct_A' },
    { n: GVRAM_DIRECT_OFF_B, label: 'direct_B' },
    { n: GVRAM_COPY_BASE_OFF + 0, label: 'copy_0' },
    { n: GVRAM_COPY_BASE_OFF + 5, label: 'copy_5' },
    { n: GVRAM_COPY_BASE_OFF + 10, label: 'copy_10' },
    { n: GVRAM_COPY_BASE_OFF + 15, label: 'copy_15' },
  ];
  log(`RESULT: GVRAM background=${backgroundRgb}`);
  let ok = true;
  for (const p of points) {
    const x = p.n % GVRAM_STRIDE;
    const y = Math.floor(p.n / GVRAM_STRIDE);
    const observed = rgbAt(img, x, y);
    const nearest = nearestCandidate(observed, candidates);
    const matchOwn = nearest.label === p.label;
    const withinThreshold = nearest.dist <= GVRAM_DIST_THRESHOLD;
    if (!matchOwn || !withinThreshold) ok = false;
    log(`  ${p.label} n=${p.n} (x=${x},y=${y}) observed=${observed.join(',')} nearest=${nearest.label}(dist=${nearest.dist.toFixed(1)}) matchOwn=${matchOwn} withinThreshold=${withinThreshold}`);
  }
  log(`RESULT: GVRAM_OK=${ok}`);
  return ok;
}

async function main(): Promise<void> {
  console.log(`WEBX68K_DIR=${WEBX68K_DIR}`);
  console.log(`WARMUP=${WARMUP}`);
  const log = (s: string) => console.log(s);
  let overallOk = true;
  const fail = (msg: string) => { log(`RESULT: LIB_FAIL ${msg}`); overallOk = false; };

  // === 陰性対照: memcpy/memsetを一切呼ばない検体では期待するバッファ内容が
  // 出ないことを確認する(観測系そのものの健全性チェック)。
  // → 通常ビルドの結果とは独立に、送り込む前のバッファ初期値(番兵0xEE/0x00)を
  //   test関数自身が毎回書き直すため、「呼ばない」検体は別途用意せず、
  //   通常ビルドの「書く前」の値(0xEE/0x00固定)そのものを陰性対照として扱う
  //   (test_memcpy/test_memsetがバッファをクリアしてから呼ぶ実装のため、
  //   もし関数が全く動作しなければ番兵のまま残り、これを陰性対照とみなせる)。

  log('=== 通常ビルド ===');
  const normalImg = resolve(DEV_ROOT, 'build/lib_test_normal.xdf');
  buildLibTestImage(normalImg, '');
  const normal = await runFullProgram('normal', new Uint8Array(readFileSync(normalImg)), true);

  log(`reachedDone=${normal.reachedDone}`);
  if (!normal.reachedDone) {
    fail('HV_DONEに到達しなかった(タイムアウトまたはハング)');
  }

  // --- memcpy ---
  const memcpyMatch = normal.memcpyDst.every((v, i) => v === normal.memcpySrc[i]);
  log(`RESULT: MEMCPY self=${normal.results[R_MEMCPY]} host_independent_match=${memcpyMatch}`);
  if (!(normal.results[R_MEMCPY] === 1 && memcpyMatch)) fail('memcpy: 自己判定またはhost独立照合が不一致');

  // --- memset ---
  const memsetMatch = normal.memsetDst.every((v) => v === 0xa5);
  log(`RESULT: MEMSET self=${normal.results[R_MEMSET]} host_independent_match=${memsetMatch}`);
  if (!(normal.results[R_MEMSET] === 1 && memsetMatch)) fail('memset: 自己判定またはhost独立照合が不一致');

  // --- strlen ---
  log(`RESULT: STRLEN self=${normal.results[R_STRLEN]} value=${normal.strlenResult}(期待=12)`);
  if (!(normal.results[R_STRLEN] === 1 && normal.strlenResult === 12)) fail('strlen: 期待値12と不一致');

  // --- abs ---
  const absExpected = [5, 5, 0, 2147483647];
  const absOk = normal.absResults.every((v, i) => v === absExpected[i]);
  log(`RESULT: ABS self=${normal.results[R_ABS]} values=${JSON.stringify(normal.absResults)} expected=${JSON.stringify(absExpected)}`);
  if (!(normal.results[R_ABS] === 1 && absOk)) fail('abs: 期待値と不一致');

  // --- rand(srand決定性。hostが独立にA==Bを比較) ---
  const randEq = normal.randA.every((v, i) => v === normal.randB[i]);
  const randInRange = [...normal.randA, ...normal.randB].every((v) => v >= 0 && v <= 0x7fff);
  log(`RESULT: RAND self=${normal.results[R_RAND]} A=${JSON.stringify(normal.randA)} B=${JSON.stringify(normal.randB)} host_eq=${randEq} in_range=${randInRange}`);
  if (!(normal.results[R_RAND] === 1 && randEq && randInRange)) fail('rand: 決定性またはRAND_MAX範囲チェックに不一致');

  // --- x68_iocs_disk_read ---
  const expectedDisk = expectedDiskPattern();
  let diskMismatch = -1;
  for (let i = 0; i < 1024; i++) { if (normal.diskBuf[i] !== expectedDisk[i]) { diskMismatch = i; break; } }
  log(`RESULT: DISKREAD self=${normal.results[R_DISKREAD]} host_independent_match=${diskMismatch === -1}` + (diskMismatch !== -1 ? ` first_mismatch_at=${diskMismatch}` : ''));
  if (!(normal.results[R_DISKREAD] === 1 && diskMismatch === -1)) fail('x68_iocs_disk_read: 読み込んだ内容が既知パターンと不一致');

  // --- x68_vsync_wait(Stage E-2と同じ「host側フレーム数とゲスト内カウンタ
  // 増分の比」判定に戻した) ---
  // 【指摘を受けて修正】最終的なHV_VSYNC_COUNTERが300(ループの上限)に到達した
  // ことだけを見る判定は、x68_vsync_waitが一切待たず即returnする実装でも
  // 最終的には同じ300に達してしまい(ループ自体は300回まわるので)区別できず、
  // PASSしてしまっていた(「到達したこと」は「待った」ことの証拠にならない)。
  // runFullProgram側でStage E-2と同じ比(measure窓でのカウンタ増分/host
  // フレーム数)を実測しているので、それが1に近いかどうかで判定する。
  log(`RESULT: VSYNC rate=${normal.vsyncRate.toFixed(4)}(許容範囲[${RATE_LOW},${RATE_HIGH}]、Stage E-2と同じ基準) counter_final=${normal.vsyncCounter}(参考値)`);
  const vsyncRateOk = Number.isFinite(normal.vsyncRate) && normal.vsyncRate >= RATE_LOW && normal.vsyncRate <= RATE_HIGH;
  if (!vsyncRateOk) fail('x68_vsync_wait: host側フレーム数とゲスト内カウンタ増分の比が1から大きく外れている(待てていない疑い)');

  // --- x68_iocs_bitsns(押下区間[60,140)、それ以外は解放を期待) ---
  // 配送遅延(Stage E-4で実測済みの罠)を考慮し、遷移直後2サンプルは判定から除外する。
  const LAG = 2;
  const pressedWindow = normal.bitsnsHistory.slice(60 + LAG, 140);
  const releasedWindowA = normal.bitsnsHistory.slice(0, 60 - LAG);
  const releasedWindowB = normal.bitsnsHistory.slice(140 + LAG, BITSNS_HISTORY_LEN);
  const pressedFrac = pressedWindow.filter((b) => (b & BIT_SPACE) !== 0).length / Math.max(1, pressedWindow.length);
  const releasedFrac = [...releasedWindowA, ...releasedWindowB].filter((b) => (b & BIT_SPACE) === 0).length
    / Math.max(1, releasedWindowA.length + releasedWindowB.length);
  log(`RESULT: BITSNS self=${normal.results[R_BITSNS]} pressedFrac=${pressedFrac.toFixed(3)} releasedFrac=${releasedFrac.toFixed(3)} history=${JSON.stringify(normal.bitsnsHistory)}`);
  const bitsnsOk = normal.results[R_BITSNS] === 1 && pressedFrac >= 0.9 && releasedFrac >= 0.9;
  if (!bitsnsOk) fail('x68_iocs_bitsns: 押下/解放の追従が不十分');

  // --- GVRAM(mode設定 + movemコピー) ---
  // 【指摘を受けて修正】以前は「背景色でないこと」「6点が互いに異なる色で
  // 区別できること」だけを見ていたが、これだと x68_gvram_copy_movem の
  // 転送先が1ワードずれても(=各点の色がすべて「隣の期待色」に入れ替わる
  // だけ)非背景・相互区別という条件はどちらも保たれてしまいPASSしてしまう
  // (「変化したこと」は「正しいこと」の証拠にならない)。checkGvram()では
  // 各点の観測色に最も近い期待候補を求め、それが自分自身の期待値と一致するか
  // (かつ量子化+補間による誤差の範囲内か)を見る方式にした。
  const gvramOk = checkGvram(normal.lastImage, log);
  if (!gvramOk) fail('GVRAM: モード設定またはmovemコピーの内容が期待した色と不一致');

  // === printf/puts: テキスト画面を実際に読んで突き合わせる ===
  const lines = normal.textLines;
  log(`textLines=${JSON.stringify(lines.filter((l) => l.trim()))}`);
  const putsOk = textAt(lines, 1, 0, 'PUTSLINE1') && textAt(lines, 2, 0, 'PUTSLINE2');
  log(`RESULT: PUTS_OK=${putsOk}(puts()が改行を追加して次のputsが次の行に出ているか)`);
  if (!putsOk) fail('puts: 期待した位置に出ていない(改行付加が効いていない疑い)');

  const fmtExpected = 'FMT D=-42 U=42 X=2a C=A S=hi PCT=%';
  const fmtOk = textAt(lines, 4, 0, fmtExpected);
  log(`RESULT: PRINTF_FMT_OK=${fmtOk} expected="${fmtExpected}"`);
  if (!fmtOk) fail('printf: %d/%u/%x/%c/%s/%%の組み合わせ出力が期待と不一致');

  const badfmtOk = anyLineContains(lines, '[BADFMT]');
  log(`RESULT: PRINTF_BADFMT_VISIBLE=${badfmtOk}(非対応書式で目に見えるマーカーが出たか)`);
  if (!badfmtOk) fail('printf: 非対応書式でも[BADFMT]が出なかった(黙って誤動作している疑い)');

  // === 陰性対照: 表示していない文字列が出ていないこと ===
  const negativeOk = !anyLineContains(lines, 'NEVERSHOWN');
  log(`RESULT: NEGATIVE_TEXT_CONTROL_OK=${negativeOk}`);
  if (!negativeOk) fail('陰性対照: 出していないはずの文字列が観測された(観測系の異常)');

  // ==========================================================
  // 故障注入(3件)。それぞれ「意図的に壊した版で実際にFAILすること」を確認する。
  // FAILしなければ検査が空振りしていると判定する。
  // ==========================================================
  log('=== 故障注入1/6: memcpy_skip_last ===');
  {
    const img2 = resolve(DEV_ROOT, 'build/lib_test_fault_memcpy.xdf');
    buildLibTestImage(img2, 'memcpy_skip_last');
    const r = await runFullProgram('fault_memcpy', new Uint8Array(readFileSync(img2)), false);
    const match = r.memcpyDst.every((v, i) => v === r.memcpySrc[i]);
    const detected = r.results[R_MEMCPY] === 0 || !match;
    log(`RESULT: FAULT_MEMCPY self=${r.results[R_MEMCPY]} host_match=${match} detected_fail=${detected} last_byte(src=${r.memcpySrc[63]},dst=${r.memcpyDst[63]})`);
    if (!detected) fail('故障注入(memcpy_skip_last)を検査が検出できなかった(検査が空振りしている)');
  }

  log('=== 故障注入2/6: strlen_off_by_one ===');
  {
    const img3 = resolve(DEV_ROOT, 'build/lib_test_fault_strlen.xdf');
    buildLibTestImage(img3, 'strlen_off_by_one');
    const r = await runFullProgram('fault_strlen', new Uint8Array(readFileSync(img3)), false);
    const detected = r.results[R_STRLEN] === 0 || r.strlenResult !== 12;
    log(`RESULT: FAULT_STRLEN self=${r.results[R_STRLEN]} value=${r.strlenResult}(正常なら12) detected_fail=${detected}`);
    if (!detected) fail('故障注入(strlen_off_by_one)を検査が検出できなかった(検査が空振りしている)');
  }

  log('=== 故障注入3/6: printf_drop_sign ===');
  {
    const img4 = resolve(DEV_ROOT, 'build/lib_test_fault_printf.xdf');
    buildLibTestImage(img4, 'printf_drop_sign');
    const r = await runFullProgram('fault_printf', new Uint8Array(readFileSync(img4)), false);
    const stillMatches = textAt(r.textLines, 4, 0, fmtExpected);
    const detected = !stillMatches;
    log(`RESULT: FAULT_PRINTF stillMatchesExpected=${stillMatches} detected_fail=${detected} line4="${(r.textLines[4] ?? '').trimEnd()}"`);
    if (!detected) fail('故障注入(printf_drop_sign)を検査が検出できなかった(検査が空振りしている)');
  }

  // ==========================================================
  // 追加の故障注入(3件)。既存3件は「穴のあった2箇所(vsync/GVRAM)」に
  // 当たっていなかったため、コーディネータからの指摘を受けて追加した。
  // ==========================================================
  log('=== 故障注入4/6: vsync_no_wait(x68_vsync_waitが即returnする) ===');
  {
    const img5 = resolve(DEV_ROOT, 'build/lib_test_fault_vsync.xdf');
    buildLibTestImage(img5, 'vsync_no_wait');
    const r = await runFullProgram('fault_vsync', new Uint8Array(readFileSync(img5)), false);
    const rateOk = Number.isFinite(r.vsyncRate) && r.vsyncRate >= RATE_LOW && r.vsyncRate <= RATE_HIGH;
    const detected = !rateOk;
    log(`RESULT: FAULT_VSYNC rate=${Number.isFinite(r.vsyncRate) ? r.vsyncRate.toFixed(4) : 'NaN'} detected_fail=${detected}`);
    if (!detected) fail('故障注入(vsync_no_wait)を検査が検出できなかった(検査が空振りしている)');
  }

  log('=== 故障注入5/6: gvram_copy_offset(転送先を1ワードずらす) ===');
  {
    const img6 = resolve(DEV_ROOT, 'build/lib_test_fault_gvram.xdf');
    buildLibTestImage(img6, 'gvram_copy_offset');
    const r = await runFullProgram('fault_gvram', new Uint8Array(readFileSync(img6)), false);
    const gOk = checkGvram(r.lastImage, log);
    const detected = !gOk;
    log(`RESULT: FAULT_GVRAM_COPY_OFFSET detected_fail=${detected}`);
    if (!detected) fail('故障注入(gvram_copy_offset)を検査が検出できなかった(検査が空振りしている)');
  }

  log('=== 故障注入6/6: bitsns_always_zero(x68_iocs_bitsnsが常に0を返す) ===');
  {
    const img7 = resolve(DEV_ROOT, 'build/lib_test_fault_bitsns.xdf');
    buildLibTestImage(img7, 'bitsns_always_zero');
    const r = await runFullProgram('fault_bitsns', new Uint8Array(readFileSync(img7)), true);
    const LAG = 2;
    const pressedWindow = r.bitsnsHistory.slice(60 + LAG, 140);
    const pressedFrac = pressedWindow.filter((b) => (b & BIT_SPACE) !== 0).length / Math.max(1, pressedWindow.length);
    const detected = r.results[R_BITSNS] === 0 || pressedFrac < 0.9;
    log(`RESULT: FAULT_BITSNS self=${r.results[R_BITSNS]} pressedFrac=${pressedFrac.toFixed(3)} detected_fail=${detected}`);
    if (!detected) fail('故障注入(bitsns_always_zero)を検査が検出できなかった(検査が空振りしている)');
  }

  log(`RESULT: LIB_OVERALL_PASS=${overallOk}`);
  if (!overallOk) process.exitCode = 1;
}

await main();
