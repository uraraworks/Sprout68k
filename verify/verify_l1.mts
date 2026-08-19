/*
 * X68kDev L1(lib/src/x68_l1.c、65536色1ページ + 矩形追跡の部分転送)の検証。
 * px68k(WebX68k のコア)上で lib_test/src/main_l1.c を実際に走らせ、
 * host側に持つ「期待される画面」のモデル(このファイルのModelクラス)と、
 * 実際にレンダリングされたcanvas全体(512x512、サンプリングではなく全画素、
 * decode16to24でGVRAM語形式から変換)を突き合わせる。
 *
 * 【重要】GVRAMをpeekWordで直接読む方式は最初試したが機能しなかった。
 * LibretroHostのpeekByte/peekWordは「ゲストのメインメモリ」(px68k-libretro
 * 側のMEM[]フラット配列)しか読めず、GVRAM($00C00000〜)はその外にあるため、
 * 常にobserved=0という一様な結果になった(検出できていた: 「不自然に
 * 揃った数字は観測系の故障を疑う」)。verify_lib.mts と同じく、実際に
 * レンダリングされたcanvas(lastImage())を読む方式に切り替えた。
 *
 * host→guestへメモリを書き込む手段(poke)が無い(LibretroHostはpeekByte/
 * peekWordしか提供していない)ため、台本は lib_test/src/main_l1.c 側に固定で
 * 書き下ろしてある。このファイルのModelクラス(cls/pset/boxFill/line/circle)は
 * lib/src/x68_l1.c の対応する関数と1画素単位で一致するように独立実装した
 * もの(特にline/circleは同じBresenham系の式を使うことで、host側モデルが
 * 「裏バッファ全体を毎フレーム塗り直す」単純な実装のまま、ゲスト側の
 * 矩形追跡による部分転送の「結果」と全画素一致することを確認できる。
 * host側は矩形追跡そのものは再実装しない。それは実装詳細でありAPIの
 * 観測可能な結果ではないため)。
 *
 * 使い方: npx tsx verify/verify_l1.mts
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

/* --- HOSTVAR アドレス(lib_test/src/main_l1.c と一致させること) --- */
const HV2_BASE = 0x000d8000;
const HV2_PROGRESS = HV2_BASE + 0x00;
const HV2_FLIP_BYTES = (i: number) => HV2_BASE + 0x10 + i * 4;
const HV2_RGB_RESULT = (i: number) => HV2_BASE + 0x0100 + i * 4;
const HV2_DONE = HV2_BASE + 0x0200;
const HV2_DONE_MAGIC = 0xc1d2e3f4;

const W = 512, H = 512;

/* --- GVRAM 16bit色値 → 実際にcanvasへ出るRGB8の変換式(verify_lib.mtsで確定した
 * decode16to24をそのまま使う) ---
 * 【重要】webx68k_peek16/peekWordは「ゲストのメインメモリ」(core-shim.cの
 * MEM[]、コメント上も明記)しか読めず、GVRAM($00C00000〜)はメインメモリの
 * flat配列の外にあるため、GVRAMを直接peekWordで読むことはできない
 * (最初の実装ではこれに気づかず、全フレームで observed=0 という
 * 一様な不一致になった。「不自然に揃った数字は観測系の故障を疑う」を
 * 実地で踏んだ)。verify_lib.mts と同じく、実際にレンダリングされた
 * canvas(lastImage())を読み、decode16to24で変換した期待色との距離が
 * 閾値以内かで判定する。 */
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
/* canvasの拡大縮小・アンチエイリアスに伴う補間で、観測色は変換式そのままの
 * 値からずれる(lib実装_20260819.md記載の実測: 距離13.9〜30.5)。全画素比較
 * なので、この誤差を吸収しつつ取り違えないよう十分な余裕を見た閾値にする
 * (docs/L1実装_20260819.mdに実測分布を記録する)。 */
const PIXEL_DIST_THRESHOLD = 90;
function distSq(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/* ============================================================
 * host側モデル(lib/src/x68_l1.c の描画プリミティブと1画素単位で一致させる)。
 * 矩形追跡による部分転送は再実装しない(観測可能な結果だけを見る)。
 * ============================================================ */
function clampi(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
function xRgb(r: number, g: number, b: number): number {
  r = clampi(r, 0, 255); g = clampi(g, 0, 255); b = clampi(b, 0, 255);
  const r5 = (r >> 3) & 0x1f, g5 = (g >> 3) & 0x1f, b5 = (b >> 3) & 0x1f;
  return ((g5 << 11) | (r5 << 6) | (b5 << 1) | 1) >>> 0;
}

class Model {
  grid = new Uint16Array(W * H);
  cls(color: number) { this.grid.fill(color); }
  pset(x: number, y: number, color: number) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    this.grid[y * W + x] = color;
  }
  boxFill(x: number, y: number, w: number, h: number, color: number) {
    if (w <= 0 || h <= 0) return;
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(W, x + w), y1 = Math.min(H, y + h);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.grid[yy * W + xx] = color;
  }
  /* lib/src/x68_l1.c の x68_box と同じく、4辺をboxFillで描く(枠のみ)。 */
  box(x: number, y: number, w: number, h: number, color: number) {
    if (w <= 0 || h <= 0) return;
    this.boxFill(x, y, w, 1, color);
    this.boxFill(x, y + h - 1, w, 1, color);
    this.boxFill(x, y, 1, h, color);
    this.boxFill(x + w - 1, y, 1, h, color);
  }
  /* lib/src/x68_l1.c の x68_line と同じBresenham(標準形)。 */
  line(x1: number, y1: number, x2: number, y2: number, color: number) {
    let dx = x2 - x1; if (dx < 0) dx = -dx;
    const sx = x1 < x2 ? 1 : -1;
    let dy = y2 - y1; if (dy > 0) dy = -dy;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx + dy;
    let cx = x1, cy = y1;
    for (;;) {
      if (cx >= 0 && cx < W && cy >= 0 && cy < H) this.grid[cy * W + cx] = color;
      if (cx === x2 && cy === y2) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; cx += sx; }
      if (e2 <= dx) { err += dx; cy += sy; }
    }
  }
  /* lib/src/x68_l1.c の x68_circle と同じミッドポイント円(整数演算のみ)。 */
  circle(cx: number, cy: number, r: number, color: number) {
    if (r <= 0) return;
    const plot = (px: number, py: number) => { if (px >= 0 && px < W && py >= 0 && py < H) this.grid[py * W + px] = color; };
    let x = 0, y = r, d = 3 - 2 * r;
    while (x <= y) {
      plot(cx + x, cy + y); plot(cx - x, cy + y); plot(cx + x, cy - y); plot(cx - x, cy - y);
      plot(cx + y, cy + x); plot(cx - y, cy + x); plot(cx + y, cy - x); plot(cx - y, cy - x);
      if (d < 0) { d += 4 * x + 6; } else { d += 4 * (x - y) + 10; y--; }
      x++;
    }
  }
}

/* --- 台本(lib_test/src/main_l1.cと1桁単位で一致させること) --- */
const C_BG1 = xRgb(0, 0, 0);
const C_BG2 = xRgb(255, 255, 255);
const C_MOVER = xRgb(255, 255, 0);
const C_EDGE = xRgb(0, 255, 255);
const C_POINT = xRgb(255, 0, 255);
const C_LINE = xRgb(128, 0, 255);
const C_CIRCLE = xRgb(0, 255, 0);

function buildMainScriptFrames(): Uint16Array[] {
  const model = new Model();
  const frames: Uint16Array[] = [];
  for (let frame = 0; frame < 8; frame++) {
    const bg = frame < 6 ? C_BG1 : C_BG2;
    model.cls(bg);
    const mx = 40 + frame * 20;
    model.boxFill(mx, 100, 16, 16, C_MOVER);
    if (frame >= 2 && frame <= 4) model.boxFill(495, 300, 40, 20, C_EDGE);
    if (frame === 5) {
      model.pset(256, 50, C_POINT);
      model.line(10, 10, 120, 90, C_LINE);
      model.line(-50, -50, -10, -10, C_LINE);
      model.circle(300, 300, 25, C_CIRCLE);
      model.box(350, 150, 40, 30, C_EDGE);
    }
    frames.push(model.grid.slice());
  }
  return frames;
}

function buildEmptyScriptFrames(): Uint16Array[] {
  const model = new Model();
  model.cls(C_BG1);
  return [model.grid.slice()];
}

/* --- 差分転送を狙った台本(lib_test/src/main_l1.cのX68_L1_DIFF_SCRIPTと
 * 1桁単位で一致させること)。host側モデルは「裏バッファを毎フレーム
 * 塗り直す」素直な実装のままでよい(差分転送はGVRAM転送量だけの話で、
 * 全画素の結果は変わらないはず)。 --- */
const DIFF_BLK_W = 20, DIFF_BLK_H = 20, DIFF_BLK_Y = 20;
const diffBlkX = (i: number) => 20 + i * 40;
const DIFF_MOVER_W = 16, DIFF_MOVER_H = 16, DIFF_MOVER_Y = 200;
const DIFF_BURST_COUNT = 70;
const DIFF_BURST_Y = 400;

const DIFF_C_BG = xRgb(0, 0, 0);
const DIFF_C_S0 = xRgb(200, 50, 50);
const DIFF_C_S1 = xRgb(50, 200, 50);
const DIFF_C_S2 = xRgb(50, 50, 200);
const DIFF_C_S2_NEW = xRgb(50, 200, 200);
const DIFF_C_S3 = xRgb(200, 200, 50);
const DIFF_C_S4 = xRgb(200, 50, 200);
const DIFF_C_MOVER = xRgb(255, 255, 0);
const DIFF_C_BURST = xRgb(128, 128, 128);

function buildDiffScriptFrames(): Uint16Array[] {
  const model = new Model();
  const frames: Uint16Array[] = [];
  for (let frame = 0; frame < 7; frame++) {
    model.cls(DIFF_C_BG);
    model.boxFill(diffBlkX(0), DIFF_BLK_Y, DIFF_BLK_W, DIFF_BLK_H, DIFF_C_S0);
    model.boxFill(diffBlkX(1), DIFF_BLK_Y, DIFF_BLK_W, DIFF_BLK_H, DIFF_C_S1);
    model.boxFill(diffBlkX(2), DIFF_BLK_Y, DIFF_BLK_W, DIFF_BLK_H, frame >= 2 ? DIFF_C_S2_NEW : DIFF_C_S2);
    model.boxFill(diffBlkX(3), DIFF_BLK_Y, DIFF_BLK_W, DIFF_BLK_H, DIFF_C_S3);
    if (frame <= 1) {
      model.boxFill(diffBlkX(4), DIFF_BLK_Y, DIFF_BLK_W, DIFF_BLK_H, DIFF_C_S4);
    }
    const mx = 40 + frame * 10;
    model.boxFill(mx, DIFF_MOVER_Y, DIFF_MOVER_W, DIFF_MOVER_H, DIFF_C_MOVER);
    if (frame === 4) {
      for (let i = 0; i < DIFF_BURST_COUNT; i++) model.pset(10 + i, DIFF_BURST_Y, DIFF_C_BURST);
    }
    frames.push(model.grid.slice());
  }
  return frames;
}

/* ============================================================
 * px68k駆動
 * ============================================================ */
interface Image { width: number; height: number; data: Uint8ClampedArray; }

interface Session {
  runFrame(): void;
  peekU32(addr: number): number;
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
    peekU32(addr: number) {
      const hi = host.peekWord(addr) >>> 0;
      const lo = host.peekWord(addr + 2) >>> 0;
      return (hi * 0x10000 + lo) >>> 0;
    },
    lastImage() { return lastImg; },
    dispose() { host.dispose(); },
  };
}

function buildL1TestImage(outPath: string, fault: string, script: string): void {
  const args = [resolve(DEV_ROOT, 'tools/build_l1_test.sh'), outPath, fault, script];
  execFileSync('bash', args, { cwd: DEV_ROOT });
}

interface CompareResult {
  ok: boolean;
  mismatchCount: number;
  firstMismatch: { x: number; y: number; expected16: number; expectedRgb: number[]; observedRgb: number[]; dist: number } | null;
}

/* 期待グリッド(16bit色値、512x512)と実際にレンダリングされたcanvas画像を
 * 全画素比較する(サンプリングではない)。canvas側はdecode16to24で変換した
 * RGBとの距離がPIXEL_DIST_THRESHOLD以内かどうかで判定する
 * (量子化+補間による実測誤差を吸収するため。docs/L1実装_20260819.md参照)。 */
function compareFull(expected: Uint16Array, img: Image | null): CompareResult {
  if (!img || img.width < W || img.height < H) {
    return { ok: false, mismatchCount: W * H, firstMismatch: null };
  }
  let mismatchCount = 0;
  let first: CompareResult['firstMismatch'] = null;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const exp16 = expected[y * W + x];
      const expRgb = decode16to24(exp16);
      const idx = (y * img.width + x) * 4;
      const obsRgb: [number, number, number] = [img.data[idx], img.data[idx + 1], img.data[idx + 2]];
      const d = Math.sqrt(distSq(expRgb, obsRgb));
      if (d > PIXEL_DIST_THRESHOLD) {
        mismatchCount++;
        if (!first) {
          first = { x, y, expected16: exp16, expectedRgb: expRgb, observedRgb: obsRgb, dist: d };
        }
      }
    }
  }
  return { ok: mismatchCount === 0, mismatchCount, firstMismatch: first };
}

/* 台本を実際に走らせ、各flip完了直後にGVRAM全体をexpectedFramesと突き合わせる。
 * stopAtFirstMismatch=true のときは最初の不一致フレームで打ち切る
 * (故障注入版の確認用。壊れているのが分かればそれ以上進める必要が無い)。 */
async function runScript(
  label: string,
  diskBytes: Uint8Array,
  expectedFrames: Uint16Array[],
  stopAtFirstMismatch: boolean,
  log: (s: string) => void,
): Promise<{ allOk: boolean; perFrame: CompareResult[]; flipBytes: number[]; reachedDone: boolean }> {
  const session = await bootSession(label, diskBytes);
  const NFRAMES = expectedFrames.length;
  const FRAME_BUDGET = 2000 + NFRAMES * 50;
  const checkDeadline = makeDeadline(label, FRAME_BUDGET);

  const perFrame: CompareResult[] = [];
  const flipBytes: number[] = [];
  let lastProgress = 0;
  let dbgFrames = 0;
  let done = 0;
  let allOk = true;

  while (dbgFrames < FRAME_BUDGET) {
    session.runFrame();
    dbgFrames++;
    if (dbgFrames % 50 === 0) checkDeadline();

    const progress = session.peekU32(HV2_PROGRESS);
    done = session.peekU32(HV2_DONE);

    if (progress > lastProgress) {
      // lib_test/src/main_l1.c は各flip()の直後に「何も描かない垂直同期待ち」を
      // 3回はさむ(host側がpx68kのビデオリフレッシュを確実に拾うための静止区間。
      // この間は裏バッファ・GVRAMどちらも変化しない)。ここで2回だけ追加の
      // runFrame()を呼んでからlastImage()を読むことで、GVRAM書き込み直後の
      // 1フレームでは映像へ未反映、という配送遅延を安全マージン1回残して吸収する。
      session.runFrame(); dbgFrames++;
      session.runFrame(); dbgFrames++;

      // progress は「完了したflip()の回数」。lastProgress..progress-1 の
      // 各フレームぶんを順に処理する(取りこぼし対策。通常は1つずつ進む)。
      for (let f = lastProgress; f < progress && f < NFRAMES; f++) {
        const cmp = compareFull(expectedFrames[f], session.lastImage());
        perFrame[f] = cmp;
        flipBytes[f] = session.peekU32(HV2_FLIP_BYTES(f));
        if (!cmp.ok) {
          allOk = false;
          log(`  frame${f}: MISMATCH count=${cmp.mismatchCount} first=${JSON.stringify(cmp.firstMismatch)}`);
          if (stopAtFirstMismatch) { lastProgress = progress; break; }
        } else {
          log(`  frame${f}: OK (flip_bytes=${flipBytes[f]})`);
        }
      }
      lastProgress = progress;
      if (stopAtFirstMismatch && !allOk) break;
    }

    if (done === HV2_DONE_MAGIC) break;
  }

  const reachedDone = done === HV2_DONE_MAGIC;
  session.dispose();
  return { allOk, perFrame, flipBytes, reachedDone };
}

async function main(): Promise<void> {
  console.log(`WEBX68K_DIR=${WEBX68K_DIR}`);
  const log = (s: string) => console.log(s);
  let overallOk = true;
  const fail = (msg: string) => { log(`RESULT: L1_FAIL ${msg}`); overallOk = false; };

  const mainFrames = buildMainScriptFrames();
  const emptyFrames = buildEmptyScriptFrames();

  // === 通常ビルド: 主台本(動く矩形・画面端はみ出し・背景色変更・点/線/円) ===
  log('=== 通常ビルド: 主台本(8フレーム) ===');
  const normalImg = resolve(DEV_ROOT, 'build/l1_test_normal.xdf');
  buildL1TestImage(normalImg, '', '');
  const normal = await runScript('normal', new Uint8Array(readFileSync(normalImg)), mainFrames, false, log);
  log(`reachedDone=${normal.reachedDone}`);
  if (!normal.reachedDone) fail('HV2_DONEに到達しなかった(タイムアウトまたはハング)');
  if (!normal.allOk) fail('主台本: 全画素比較が一致しないフレームがあった');
  else log('RESULT: MAIN_SCRIPT_ALL_FRAMES_MATCH=true');

  // --- 転送量の実測(API設計_20260819.md「API実装時の宿題」1) ---
  const bytesList = normal.flipBytes;
  const maxBytes = Math.max(...bytesList);
  const avgBytes = bytesList.reduce((a, b) => a + b, 0) / bytesList.length;
  const STAGE_E3_MOVEM_BUDGET = 53227; // Stage E-3実測(16MHz, MOVEM.L, 1フレームあたりの実測スループット)
  log(`RESULT: FLIP_BYTES per_frame=${JSON.stringify(bytesList)} max=${maxBytes} avg=${avgBytes.toFixed(1)}`);
  log(`RESULT: FLIP_BYTES_RATIO max/budget=${(maxBytes / STAGE_E3_MOVEM_BUDGET * 100).toFixed(2)}% avg/budget=${(avgBytes / STAGE_E3_MOVEM_BUDGET * 100).toFixed(2)}% (budget=${STAGE_E3_MOVEM_BUDGET}B, Stage E-3実測)`);

  // --- x68_rgb() のhost独立照合(3点) ---
  {
    const session = await bootSession('rgbcheck', new Uint8Array(readFileSync(normalImg)));
    // 直前の主台本実行が既に走らせているので、単純にちょっとだけ回して値が出るのを待つ。
    let ok = false;
    for (let i = 0; i < 200 && !ok; i++) {
      session.runFrame();
      const p = session.peekU32(HV2_PROGRESS);
      if (p >= 1) ok = true;
    }
    const r0 = session.peekU32(HV2_RGB_RESULT(0));
    const r1 = session.peekU32(HV2_RGB_RESULT(1));
    const r2 = session.peekU32(HV2_RGB_RESULT(2));
    const expected = [C_BG1, C_MOVER, C_CIRCLE];
    const observed = [r0, r1, r2];
    const rgbOk = expected.every((v, i) => v === observed[i]);
    log(`RESULT: RGB_CHECK expected=${JSON.stringify(expected)} observed=${JSON.stringify(observed)} ok=${rgbOk}`);
    if (!rgbOk) fail('x68_rgb: host独立計算式の結果と不一致');
    session.dispose();
  }

  // === 陰性対照: 何も描かない台本 ===
  log('=== 陰性対照: 何も描かない台本 ===');
  const emptyImg = resolve(DEV_ROOT, 'build/l1_test_empty.xdf');
  buildL1TestImage(emptyImg, '', 'empty');
  const empty = await runScript('empty', new Uint8Array(readFileSync(emptyImg)), emptyFrames, false, log);
  if (!empty.reachedDone) fail('陰性対照: HV2_DONEに到達しなかった');
  if (!empty.allOk) fail('陰性対照: 背景だけのはずが不一致(観測系の異常)');
  else log('RESULT: NEGATIVE_CONTROL_OK=true');

  // ==========================================================
  // 故障注入(5件)。それぞれ「意図的に壊した版で実際にFAILすること」を確認する。
  // FAILしなければ検査が空振りしていると判定する。
  // ==========================================================
  const faults: { name: string; desc: string }[] = [
    { name: 'skip_prev', desc: '前フレームの矩形を転送対象に含めない(消し残り)' },
    { name: 'shrink_rect', desc: '矩形を1px小さく記録する(端が欠ける)' },
    { name: 'cls_no_fill', desc: 'x68_clsが前フレーム矩形を塗り戻さない' },
    { name: 'cls_no_full_repaint', desc: '背景色変更時に全画面を塗り直さない' },
    { name: 'no_clip', desc: 'クリップを外す(画面外描画が隣の行へ回り込む)' },
  ];

  let faultIdx = 0;
  for (const f of faults) {
    faultIdx++;
    log(`=== 故障注入${faultIdx}/${faults.length}: ${f.name}(${f.desc}) ===`);
    const img = resolve(DEV_ROOT, `build/l1_test_fault_${f.name}.xdf`);
    buildL1TestImage(img, f.name, '');
    const r = await runScript(`fault_${f.name}`, new Uint8Array(readFileSync(img)), mainFrames, true, log);
    const detected = !r.allOk;
    log(`RESULT: FAULT_${f.name.toUpperCase()} detected_fail=${detected}`);
    if (!detected) fail(`故障注入(${f.name})を検査が検出できなかった(検査が空振りしている)`);
  }

  // ==========================================================
  // 差分転送(2026-08-20導入)の台本。静止物+動く物の同居・色だけの変更・
  // 命令数が減る場面・一覧が溢れる場面を1本にまとめてある
  // (docs/L1実装_20260819.md「差分転送」節参照)。
  // ==========================================================
  log('=== 差分転送台本(7フレーム) ===');
  const diffFrames = buildDiffScriptFrames();
  const diffImg = resolve(DEV_ROOT, 'build/l1_test_diff.xdf');
  buildL1TestImage(diffImg, '', 'diff');
  const diffRun = await runScript('diff', new Uint8Array(readFileSync(diffImg)), diffFrames, false, log);
  if (!diffRun.reachedDone) fail('差分転送台本: HV2_DONEに到達しなかった');
  if (!diffRun.allOk) fail('差分転送台本: 全画素比較が一致しないフレームがあった');
  else log('RESULT: DIFF_SCRIPT_ALL_FRAMES_MATCH=true');

  const db = diffRun.flipBytes;
  log(`RESULT: DIFF_FLIP_BYTES per_frame=${JSON.stringify(db)}`);
  // F0: 初回force_full(全画面) / F1: 静止物+動く物の同居、モーターだけ転送
  // されるはず(全画面よりずっと小さい) / F4,F5: overflowフォールバックで
  // 全画面(524288) / F6: 差分転送に復帰、再び小さくなるはず。
  const FULL = 512 * 512 * 2;
  const diffEfficient = db.length >= 7 && db[1] < FULL / 4 && db[6] < FULL / 4;
  const diffOverflowFallback = db.length >= 7 && db[4] === FULL && db[5] === FULL;
  log(`RESULT: DIFF_TRANSFER_EFFICIENT=${diffEfficient} (F1=${db[1]} F6=${db[6]}, 全画面=${FULL}の1/4未満であること)`);
  log(`RESULT: DIFF_OVERFLOW_FALLBACK_BYTES=${diffOverflowFallback} (F4=${db[4]} F5=${db[5]}, 全画面=${FULL}と一致すること)`);
  if (!diffEfficient) fail('差分転送: 静止物+動く物が同居するフレームで転送量が十分小さくならなかった');
  if (!diffOverflowFallback) fail('差分転送: 一覧が溢れたフレーム(および直後)で全画面フォールバックの転送量にならなかった');

  // --- 故障注入(4件)。それぞれ「意図的に壊した版で実際にFAILすること」を確認する。 ---
  const diffFaults: { name: string; desc: string }[] = [
    { name: 'skip_prev', desc: '変わった命令の前フレーム側の矩形を転送しない(消し残り)' },
    { name: 'diff_ignore_shrink', desc: '命令数が減った場合を差分に含めない(消えない)' },
    { name: 'diff_color_blind', desc: '色だけ違う命令を同一と誤判定する(色が変わらない)' },
    { name: 'diff_no_overflow_fallback', desc: '一覧が溢れてもフォールバックしない(消し残り)' },
  ];
  let diffFaultIdx = 0;
  for (const f of diffFaults) {
    diffFaultIdx++;
    log(`=== 差分転送 故障注入${diffFaultIdx}/${diffFaults.length}: ${f.name}(${f.desc}) ===`);
    const img = resolve(DEV_ROOT, `build/l1_test_diff_fault_${f.name}.xdf`);
    buildL1TestImage(img, f.name, 'diff');
    const r = await runScript(`diff_fault_${f.name}`, new Uint8Array(readFileSync(img)), diffFrames, true, log);
    const detected = !r.allOk;
    log(`RESULT: DIFF_FAULT_${f.name.toUpperCase()} detected_fail=${detected}`);
    if (!detected) fail(`差分転送の故障注入(${f.name})を検査が検出できなかった(検査が空振りしている)`);
  }

  log(`RESULT: L1_OVERALL_PASS=${overallOk}`);
  if (!overallOk) process.exitCode = 1;
}

await main();
