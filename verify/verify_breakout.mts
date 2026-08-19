/*
 * X68kDev 作例「ブロック崩し」(samples/breakout/main.c)の検証。
 *
 * ホストが実際にキーを押してゲームを動かし(Stage E-4で確定した経路。
 * setKey()→runFrame()に一貫して1フレームの配送遅延があることを踏まえて
 * runFrame()の回数を調整する。docs/StageE-4_実測_20260819.md参照)、
 * 次の5項目を実測する:
 *   1. パドルが左右キーで動く(陰性対照込み)
 *   2. ボールが移動している
 *   3. ボールが壁で反射する
 *   4. ブロックが実際に消える(GVRAM/canvasの実測、自己申告だけにしない)
 *   5. スコアが増える(テキスト画面を実際に読んで数値を突き合わせる)
 *
 * 内部状態(パドル/ボール座標・スコア・生存ブロック数)はゲスト側が固定
 * アドレス(HV3_*)へ自己申告するが、4と5はそれを鵜呑みにせず、実際に
 * レンダリングされたcanvas(decode16to24、verify_l1.mtsで確定した変換式)と
 * 実際のテキスト画面(readTextScreen())を独立に読んで突き合わせる。
 *
 * 使い方: npx tsx verify/verify_breakout.mts
 * 環境変数: WEBX68K_DIR(既定 ../WebX68k)
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

/* --- 自前タイムアウト(既存verify_*.mtsを踏襲。バックグラウンドに投げず同期実行する) --- */
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

/* --- HOSTVAR アドレス(samples/breakout/main.c と一致させること) --- */
const HV3_BASE = 0x000da000;
const HV3_PROGRESS = HV3_BASE + 0x00;
const HV3_PADDLE_X = HV3_BASE + 0x04;
const HV3_BALL_X = HV3_BASE + 0x08;
const HV3_BALL_Y = HV3_BASE + 0x0c;
const HV3_BALL_DX = HV3_BASE + 0x10;
const HV3_BALL_DY = HV3_BASE + 0x14;
const HV3_SCORE = HV3_BASE + 0x18;
const HV3_BLOCKS_ALIVE = HV3_BASE + 0x1c;
const HV3_LAST_DESTROYED = HV3_BASE + 0x20;
const HV3_FLIP_BYTES = HV3_BASE + 0x24;

/* --- ブロック崩し本体の定数(samples/breakout/main.c と一致させること) --- */
const BLOCK_ROWS = 4;
const BLOCK_COLS = 8;
const BLOCK_W = 56;
const BLOCK_H = 16;
const BLOCK_GAP_X = 4;
const BLOCK_GAP_Y = 4;
const BLOCK_X0 = 8;
const BLOCK_Y0 = 40;
const TOTAL_BLOCKS = BLOCK_ROWS * BLOCK_COLS;

/* RETROK 値(verify_e4.mtsと同じ、SDL retro_key enum準拠)。 */
const RETROK_LEFT = 276;
const RETROK_RIGHT = 275;

/* --- GVRAM 16bit色値 → 実RGB8(verify_lib.mts/verify_l1.mtsで確定したdecode16to24)。--- */
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
const PIXEL_DIST_THRESHOLD = 90; // L1実装_20260819.mdと同じ閾値(canvas補間による実測ずれを吸収)
function distRgb(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}
const COLOR_BG16 = ((0 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0; // x68_rgb(0,0,0)
const COLOR_BG_RGB = decode16to24(COLOR_BG16);

/* ============================================================
 * px68k駆動(verify_e4.mts + verify_l1.mtsのSession定義を合成)
 * ============================================================ */
interface Image { width: number; height: number; data: Uint8ClampedArray; }
interface Session {
  runFrame(): void;
  peekByte(addr: number): number;
  peekU32(addr: number): number;
  peekI32(addr: number): number;
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
      const w = Math.max(0, width | 0), h = Math.max(0, height | 0);
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
    peekByte(addr: number) { return host.peekByte(addr); },
    peekU32(addr: number) {
      const hi = host.peekWord(addr) >>> 0;
      const lo = host.peekWord(addr + 2) >>> 0;
      return (hi * 0x10000 + lo) >>> 0;
    },
    peekI32(addr: number) {
      const hi = host.peekWord(addr) >>> 0;
      const lo = host.peekWord(addr + 2) >>> 0;
      return ((hi * 0x10000 + lo) >>> 0) | 0; // 32bit符号付きへ変換
    },
    setKey(retrok: number, down: boolean) { host.setKey(retrok, down); },
    readTextScreen() { return host.readTextScreen(); },
    lastImage() { return lastImg; },
    dispose() { host.dispose(); },
  };
}

function buildImage(outPath: string, fault: string): void {
  execFileSync('bash', [resolve(DEV_ROOT, 'tools/build_breakout.sh'), outPath, fault], { cwd: DEV_ROOT });
}

interface Snapshot {
  progress: number;
  paddleX: number;
  ballX: number;
  ballY: number;
  ballDx: number;
  ballDy: number;
  score: number;
  blocksAlive: number;
  lastDestroyed: number;
  flipBytes: number;
}
function snapshot(s: Session): Snapshot {
  return {
    progress: s.peekU32(HV3_PROGRESS),
    paddleX: s.peekI32(HV3_PADDLE_X),
    ballX: s.peekI32(HV3_BALL_X),
    ballY: s.peekI32(HV3_BALL_Y),
    ballDx: s.peekI32(HV3_BALL_DX),
    ballDy: s.peekI32(HV3_BALL_DY),
    score: s.peekI32(HV3_SCORE),
    blocksAlive: s.peekI32(HV3_BLOCKS_ALIVE),
    lastDestroyed: s.peekI32(HV3_LAST_DESTROYED),
    flipBytes: s.peekU32(HV3_FLIP_BYTES),
  };
}

function blockRect(index: number): { x: number; y: number; w: number; h: number } {
  const r = Math.floor(index / BLOCK_COLS);
  const c = index % BLOCK_COLS;
  return {
    x: BLOCK_X0 + c * (BLOCK_W + BLOCK_GAP_X),
    y: BLOCK_Y0 + r * (BLOCK_H + BLOCK_GAP_Y),
    w: BLOCK_W,
    h: BLOCK_H,
  };
}

function sampleCanvasRgb(img: Image | null, x: number, y: number): [number, number, number] | null {
  if (!img || x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const idx = (y * img.width + x) * 4;
  return [img.data[idx], img.data[idx + 1], img.data[idx + 2]];
}

/* ============================================================
 * 検査本体。stopEarlyOnFail=true(故障注入版)のときは、対象項目が
 * FAILと判明した時点で打ち切ってよい(壊れているのが分かればそれ以上進める
 * 必要が無い)。
 * ============================================================ */
interface RunResult {
  booted: boolean;
  bootFrames: number;
  // (1) パドル
  negControlOk: boolean;
  paddleLeftMoved: boolean;
  paddleRightMoved: boolean;
  // (2) ボール移動
  ballMoved: boolean;
  // (3) ボール反射
  dxFlipped: boolean;
  dyFlipped: boolean;
  reflectFrames: number;
  // (4) ブロック破壊
  blockDestroyed: boolean;
  blockCanvasOk: boolean;
  blockDestroyedFrame: number;
  // (5) スコア
  scoreTextOk: boolean;
  scoreTextObserved: string;
  scoreExpected: number;
  // 転送量実測
  flipBytesSamples: number[];
}

async function runFullCheck(label: string, diskBytes: Uint8Array, log: (s: string) => void): Promise<RunResult> {
  const session = await bootSession(label, diskBytes);
  const BOOT_BUDGET = 3000;
  const checkDeadlineBoot = makeDeadline(`${label}:boot`, BOOT_BUDGET);

  let bootFrames = 0;
  let snap = snapshot(session);
  while (snap.progress === 0 && bootFrames < BOOT_BUDGET) {
    session.runFrame();
    bootFrames++;
    if (bootFrames % 100 === 0) checkDeadlineBoot();
    snap = snapshot(session);
  }
  const booted = snap.progress > 0;
  log(`  boot: booted=${booted} bootFrames=${bootFrames}`);
  if (!booted) {
    session.dispose();
    return {
      booted: false, bootFrames, negControlOk: false, paddleLeftMoved: false, paddleRightMoved: false,
      ballMoved: false, dxFlipped: false, dyFlipped: false, reflectFrames: 0,
      blockDestroyed: false, blockCanvasOk: false, blockDestroyedFrame: -1,
      scoreTextOk: false, scoreTextObserved: '', scoreExpected: 0, flipBytesSamples: [],
    };
  }

  // === (1) パドル: 陰性対照 → LEFT → RIGHT ===
  const s0 = snapshot(session);
  const paddle0 = s0.paddleX;
  const NEG_N = 200;
  for (let i = 0; i < NEG_N; i++) session.runFrame();
  const sNeg = snapshot(session);
  const paddleAfterNeg = sNeg.paddleX;
  const negControlOk = paddleAfterNeg === paddle0;
  log(`  paddle negative control: x0=${paddle0}(progress=${s0.progress}) xAfter=${paddleAfterNeg}(progress=${sNeg.progress}) ok=${negControlOk}`);

  session.setKey(RETROK_LEFT, true);
  const HOLD_N = 200;
  for (let i = 0; i < HOLD_N; i++) session.runFrame();
  const sLeft = snapshot(session);
  const paddleAfterLeft = sLeft.paddleX;
  session.setKey(RETROK_LEFT, false);
  for (let i = 0; i < 10; i++) session.runFrame(); // 配送遅延ぶんの余裕を空ける
  const paddleLeftMoved = paddleAfterLeft < paddleAfterNeg;
  log(`  paddle LEFT: before=${paddleAfterNeg} after=${paddleAfterLeft}(progress=${sLeft.progress}) moved=${paddleLeftMoved}`);

  session.setKey(RETROK_RIGHT, true);
  for (let i = 0; i < HOLD_N; i++) session.runFrame();
  const sRight = snapshot(session);
  const paddleAfterRight = sRight.paddleX;
  session.setKey(RETROK_RIGHT, false);
  for (let i = 0; i < 10; i++) session.runFrame();
  const paddleRightMoved = paddleAfterRight > paddleAfterLeft;
  log(`  paddle RIGHT: before=${paddleAfterLeft} after=${paddleAfterRight}(progress=${sRight.progress}) moved=${paddleRightMoved}`);

  // === (2) ボール移動 ===
  const ballA = snapshot(session);
  // ブロック崩し本体は毎フレーム全ブロック+パドル+ボールをcurRectsへ積むため
  // (下記「転送量の実測」参照)、1回のx68_screen_flip()実行に複数host runFrame()
  // ぶんのCPU時間がかかる(実測: 概ね20host frameで1ループ)。ボールが確実に
  // 動いたと言えるだけ十分な余裕を持たせる。
  const MOVE_N = 100;
  for (let i = 0; i < MOVE_N; i++) session.runFrame();
  const ballB = snapshot(session);
  const ballMoved = ballA.ballX !== ballB.ballX || ballA.ballY !== ballB.ballY;
  log(`  ball move: (${ballA.ballX},${ballA.ballY}) -> (${ballB.ballX},${ballB.ballY}) moved=${ballMoved}`);

  // === (3)(4)(5): 反射・ブロック破壊・スコアを同じ連続実行の中で観測する ===
  // ブロック崩し本体は毎フレーム全ブロックを再描画するため1ゲストループが
  // 概ね20host frame前後かかる(実測)。X方向の壁反射を拾うには画面幅ぶんの
  // 移動(最大約256ループ)が要るため、十分な余裕を持たせる。
  const RUN_BUDGET = 8000;
  const checkDeadlineRun = makeDeadline(`${label}:run`, RUN_BUDGET);
  let prevDx = ballB.ballDx, prevDy = ballB.ballDy;
  let dxFlipped = false, dyFlipped = false, reflectFrames = -1;
  let blockDestroyed = false, blockDestroyedFrame = -1, destroyedIndex = -1;
  const flipBytesSamples: number[] = [];

  for (let i = 0; i < RUN_BUDGET; i++) {
    session.runFrame();
    if (i % 100 === 0) checkDeadlineRun();
    const s = snapshot(session);
    flipBytesSamples.push(s.flipBytes);
    if (Math.sign(s.ballDx) !== 0 && Math.sign(prevDx) !== 0 && Math.sign(s.ballDx) !== Math.sign(prevDx)) dxFlipped = true;
    if (Math.sign(s.ballDy) !== 0 && Math.sign(prevDy) !== 0 && Math.sign(s.ballDy) !== Math.sign(prevDy)) dyFlipped = true;
    if (dxFlipped && dyFlipped && reflectFrames < 0) reflectFrames = i;
    prevDx = s.ballDx; prevDy = s.ballDy;

    if (!blockDestroyed && s.lastDestroyed >= 0) {
      blockDestroyed = true;
      blockDestroyedFrame = i;
      destroyedIndex = s.lastDestroyed;
      // 破壊直後のフレームでは映像へまだ反映されていない可能性があるので、
      // 何回か追加でrunFrame()してから(L1実装_20260819.mdと同じ配送遅延の
      // 吸収パターン)canvasを読む。
      for (let s2 = 0; s2 < 3; s2++) session.runFrame();
    }
    if (blockDestroyed && dxFlipped && dyFlipped) break;
  }
  log(`  reflect: dxFlipped=${dxFlipped} dyFlipped=${dyFlipped} atFrame=${reflectFrames}`);
  log(`  block destroyed: ${blockDestroyed} atFrame=${blockDestroyedFrame} index=${destroyedIndex}`);

  // --- (4) ブロック消滅の実測: 破壊されたはずの矩形の中心が背景色になっているか ---
  let blockCanvasOk = false;
  if (blockDestroyed) {
    const rect = blockRect(destroyedIndex);
    const cx = rect.x + Math.floor(rect.w / 2);
    const cy = rect.y + Math.floor(rect.h / 2);
    const observed = sampleCanvasRgb(session.lastImage(), cx, cy);
    if (observed) {
      const d = distRgb(COLOR_BG_RGB, observed);
      blockCanvasOk = d <= PIXEL_DIST_THRESHOLD;
      log(`  block canvas check: index=${destroyedIndex} rect=${JSON.stringify(rect)} observedRgb=${JSON.stringify(observed)} expectedBgRgb=${JSON.stringify(COLOR_BG_RGB)} dist=${d.toFixed(1)} ok=${blockCanvasOk}`);
    } else {
      log('  block canvas check: canvas未取得(失敗)');
    }
  }

  // --- (5) スコア表示の実測: テキスト画面を読んで、壊れたブロック数から独立に
  // 求めた期待スコアと突き合わせる(自己申告のHV3_SCOREをそのまま信用しない。
  // ブロック1個=10点は固定ルールなので、観測した生存ブロック数から算出する)。 ---
  const finalSnap = snapshot(session);
  const destroyedCount = TOTAL_BLOCKS - finalSnap.blocksAlive;
  const scoreExpected = destroyedCount * 10;
  const dump = session.readTextScreen();
  const line0 = (dump.lines?.[0] ?? '').trim();
  const scoreTextObserved = line0;
  const m = /SCORE:(\d+)/.exec(line0);
  const scoreTextValue = m ? parseInt(m[1], 10) : NaN;
  const scoreTextOk = blockDestroyed && !Number.isNaN(scoreTextValue) && scoreTextValue === scoreExpected;
  log(`  score text: line0="${line0}" parsed=${scoreTextValue} expected(from blocksAlive=${finalSnap.blocksAlive})=${scoreExpected} ok=${scoreTextOk}`);

  session.dispose();
  return {
    booted, bootFrames, negControlOk, paddleLeftMoved, paddleRightMoved,
    ballMoved, dxFlipped, dyFlipped, reflectFrames,
    blockDestroyed, blockCanvasOk, blockDestroyedFrame,
    scoreTextOk, scoreTextObserved, scoreExpected, flipBytesSamples,
  };
}

async function main(): Promise<void> {
  console.log(`WEBX68K_DIR=${WEBX68K_DIR}`);
  const log = (s: string) => console.log(s);
  let overallOk = true;
  const fail = (msg: string) => { log(`RESULT: BREAKOUT_FAIL ${msg}`); overallOk = false; };

  // === 通常ビルド: 5項目の実測 ===
  log('=== 通常ビルド ===');
  const normalImg = resolve(DEV_ROOT, 'build/breakout_normal.xdf');
  buildImage(normalImg, '');
  const r = await runFullCheck('normal', new Uint8Array(readFileSync(normalImg)), log);

  if (!r.booted) fail('起動しなかった');
  if (!r.negControlOk) fail('陰性対照: キーを押していないのにパドルが動いた');
  else log('RESULT: PADDLE_NEGATIVE_CONTROL_OK=true');
  if (!r.paddleLeftMoved) fail('(1) パドルがLEFTキーで動かなかった');
  if (!r.paddleRightMoved) fail('(1) パドルがRIGHTキーで動かなかった');
  if (r.paddleLeftMoved && r.paddleRightMoved) log('RESULT: PADDLE_FOLLOWS_KEYS=true');

  if (!r.ballMoved) fail('(2) ボールが複数フレームで移動しなかった');
  else log('RESULT: BALL_MOVES=true');

  if (!r.dxFlipped) fail('(3) ボールのX方向反射が観測できなかった');
  if (!r.dyFlipped) fail('(3) ボールのY方向反射が観測できなかった');
  if (r.dxFlipped && r.dyFlipped) log(`RESULT: BALL_REFLECTS=true atFrame=${r.reflectFrames}`);

  if (!r.blockDestroyed) fail('(4) ブロックが破壊されなかった(タイムアウト)');
  else if (!r.blockCanvasOk) fail('(4) ブロック破壊後の領域がGVRAM上で背景色になっていなかった');
  else log(`RESULT: BLOCK_DESTROYED_ON_CANVAS=true atFrame=${r.blockDestroyedFrame}`);

  if (!r.scoreTextOk) fail(`(5) スコア表示がテキスト画面上で期待値と一致しなかった(observed="${r.scoreTextObserved}" expected=SCORE:${r.scoreExpected})`);
  else log(`RESULT: SCORE_TEXT_OK=true text="${r.scoreTextObserved}"`);

  // === 実負荷での転送量の実測(API設計_20260819.md「API実装時の宿題」1を閉じる) ===
  const bytes = r.flipBytesSamples;
  if (bytes.length > 0) {
    const maxBytes = Math.max(...bytes);
    const avgBytes = bytes.reduce((a, b) => a + b, 0) / bytes.length;
    const STAGE_E3_MOVEM_BUDGET = 53227; // Stage E-3実測(16MHz, MOVEM.L)
    const L1_SCRIPT_AVG = 5615; // L1実装_20260819.md記載の台本平均(全画面転送を除く)
    log(`RESULT: BREAKOUT_FLIP_BYTES samples=${bytes.length} max=${maxBytes} avg=${avgBytes.toFixed(1)}`);
    log(`RESULT: BREAKOUT_FLIP_BYTES_RATIO max/budget=${(maxBytes / STAGE_E3_MOVEM_BUDGET * 100).toFixed(2)}% avg/budget=${(avgBytes / STAGE_E3_MOVEM_BUDGET * 100).toFixed(2)}% (budget=${STAGE_E3_MOVEM_BUDGET}B, Stage E-3実測)`);
    log(`RESULT: BREAKOUT_VS_L1_SCRIPT avg=${avgBytes.toFixed(1)}B (L1台本平均${L1_SCRIPT_AVG}Bとの比=${(avgBytes / L1_SCRIPT_AVG * 100).toFixed(1)}%)`);
    if (avgBytes > STAGE_E3_MOVEM_BUDGET) {
      log(`RESULT: BREAKOUT_FLIP_BYTES_OVER_BUDGET=true (平均${avgBytes.toFixed(1)}Bが予算${STAGE_E3_MOVEM_BUDGET}Bを超えている。これは実測結果であり、対策は本検証では行わない)`);
    } else {
      log('RESULT: BREAKOUT_FLIP_BYTES_OVER_BUDGET=false');
    }
  } else {
    fail('転送量の実測サンプルが1つも取れなかった');
  }

  // ==========================================================
  // 故障注入(3件)。それぞれ「意図的に壊した版で実際にFAILすること」を確認する。
  // ==========================================================
  const faults: { name: string; desc: string; check: (fr: RunResult) => { failed: boolean; detail: string } }[] = [
    {
      name: 'paddle_ignore_input',
      desc: 'パドルがキー入力を無視する',
      check: (fr) => ({
        failed: !(fr.booted && (fr.paddleLeftMoved || fr.paddleRightMoved)),
        detail: `paddleLeftMoved=${fr.paddleLeftMoved} paddleRightMoved=${fr.paddleRightMoved}`,
      }),
    },
    {
      name: 'block_no_hit',
      desc: 'ブロックの当たり判定を常に外れにする',
      check: (fr) => ({
        failed: !(fr.booted && (fr.blockDestroyed && fr.blockCanvasOk && fr.scoreTextOk)),
        detail: `blockDestroyed=${fr.blockDestroyed} blockCanvasOk=${fr.blockCanvasOk} scoreTextOk=${fr.scoreTextOk}`,
      }),
    },
    {
      name: 'ball_frozen',
      desc: 'ボールを静止させる',
      check: (fr) => ({
        failed: !(fr.booted && (fr.ballMoved && fr.dxFlipped && fr.dyFlipped)),
        detail: `ballMoved=${fr.ballMoved} dxFlipped=${fr.dxFlipped} dyFlipped=${fr.dyFlipped}`,
      }),
    },
  ];

  let idx = 0;
  for (const f of faults) {
    idx++;
    log(`=== 故障注入${idx}/${faults.length}: ${f.name}(${f.desc}) ===`);
    const img = resolve(DEV_ROOT, `build/breakout_fault_${f.name}.xdf`);
    buildImage(img, f.name);
    const fr = await runFullCheck(`fault_${f.name}`, new Uint8Array(readFileSync(img)), log);
    const { failed, detail } = f.check(fr);
    log(`RESULT: FAULT_${f.name.toUpperCase()} detected_fail=${failed} (${detail})`);
    if (!failed) fail(`故障注入(${f.name})を検査が検出できなかった(検査が空振りしている)`);
  }

  log(`RESULT: BREAKOUT_OVERALL_PASS=${overallOk}`);
  if (!overallOk) process.exitCode = 1;
}

await main();
