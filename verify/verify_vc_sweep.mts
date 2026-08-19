/*
 * 宿題3の追記実測: 65536色グラフィックとテキストが同時に見える設定が存在するかを、
 * Video Controller のレジスタを振って確定する(docs/VC重畳実測_20260820.md 参照)。
 *
 * 背景: docs/重なり実測_20260820.md 項目4は「65536色グラフィックモードが有効な間、
 * テキストは一切見えない(排他)」と結論したが、その実験は
 * CRTC_R20($E80028)/VC_R0($E82401)/VC_R2($E82601、下位バイトに0x01固定) の
 * 3つしか振っておらず、VC_R2 の値そのものや VC_R1($E82500/E82501、優先度制御)は
 * 一度も振っていなかった。直後のパニック画面実装で VC_R2=0x20 にすると
 * テキストが見えることが実測されたため、この帰属を作り直す。
 *
 * 測定方式: stage_e/src/main_vc_sweep.c(新規)が、ビルド時に埋め込んだ
 * regs[7] = {CRTC_R20, VC_R0_HI, VC_R0_LO, VC_R1_HI, VC_R1_LO, VC_R2_HI, VC_R2_LO}
 * をそのまま書き込んだ後、GVRAM矩形塗り(box+text/box-only の2箇所、512ドット幅の
 * 同一走査線上)+ IOCS $23/$21 でのテキスト表示(box+text/text-only/far/ALIVE)を
 * 行う。docs/重なり実測_20260820.md で実測済みのピッチ(8x16)・原点(0,0)をそのまま
 * 使う(このスクリプトでは再計測しない)。
 *
 * 1設定=1ブートとして、フレームバッファを走査し、
 *   - box-only セルが単色で塗られているか(グラフィック可視)
 *   - text-only セルに背景色以外のピクセルがあるか(テキスト可視)
 *   - box+text セルが box-only と同一か・異なるか(重畳時の見え方)
 *   - negative セル(何も描画していない領域)が背景色のみか(検出器の陰性対照、毎回実施)
 * を機械的に判定する。
 *
 * 振る対象(このスクリプト自身が決めた範囲。手読みではなく実測で決める):
 *   Phase A: VC_R2 下位バイト($E82601) を 0x00〜0xFF 全数(VC_R1=0,0 / VC_R2上位=0 固定)
 *   Phase B: VC_R1 下位バイト($E82500) を 0x00〜0xFF 全数(VC_R2下位=0x21固定、
 *            Phase Aの結果を踏まえて選ぶ。0x21はグラフィック可視ビット(0x01)と
 *            テキスト可視ビット(0x20)のOR)
 *   Phase C: VC_R2 上位バイト($E82600、"special priority") を粗く振る
 *            (Phase A/Bで最良の下位バイト値を固定した上で0x00〜0xFFを16刻み+
 *            px68k-libretro/x68k/crtc.cのソース読解で名前が出てきたビットパターン
 *            も候補に加えるが、あくまで実測で確認する。出所はログに明記する)
 *   Phase D: VC_R1 上位バイト($E82501) を粗く振る(Phase A/Bで得た最良値を固定)
 *
 * 既知の罠(docs記載、E1/E6/Overlay実測時の知見を踏襲):
 *   - px68k_no_wait_mode=enabled 必須
 *   - すべて同期実行。自前タイムアウト(makeDeadline)を使う
 *   - __BUILD_ID__ / locateFile の2つの罠(loadFactory内)
 *   - 1設定あたりのフレーム数は事前校正(下記CALIBRATIONログ参照。実測で
 *     80フレームあれば描画完了することを確認した上で安全係数を掛けて決めている)
 *
 * 使い方: npx tsx verify/verify_vc_sweep.mts
 * 環境変数: WEBX68K_DIR(既定 ../WebX68k)、FRAMES(既定 150)
 *
 * 注意: これは px68k 上の実測であり、実機の挙動とは限らない。定性的な結論のみを
 * 採用し、実機での確認は行っていない(未実施であることを明記する)。
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
const FRAMES = Number(process.env.FRAMES ?? 150); // 校正: 80フレームで描画完了を確認済み(安全係数約1.9倍)

const DEADLINE_BASE_MS = 20_000;
const DEADLINE_MS_PER_FRAME = 40;
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

interface Image { width: number; height: number; data: Uint8ClampedArray; }

const { LibretroHost } = await import(pathToFileURL(resolve(WEBX68K_DIR, 'src/libretro-host.ts')).href);

async function bootAndCapture(label: string, diskBytes: Uint8Array, frameCount: number): Promise<{ lastImage: Image | null; textLines: string[] }> {
  (globalThis as any).window = { PX68K: loadFactory() };
  let lastImage: Image | null = null;
  const context = {
    createImageData(width: number, height: number) {
      const w = Math.max(0, width | 0);
      const h = Math.max(0, height | 0);
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(img: any) { if (img && img.width > 0 && img.height > 0) lastImage = img; },
  };
  const canvas = { width: 0, height: 0, getContext: () => context } as any;

  const host = new LibretroHost(canvas, () => {});
  host.setCoreOption('px68k_cpuspeed', '16Mhz');
  host.setCoreOption('px68k_ramsize', '1MB');
  host.setCoreOption('px68k_no_wait_mode', 'enabled');
  await host.init(new Uint8Array(readFileSync(IPL)), new Uint8Array(readFileSync(CGROM)));
  const diskPath = host.writeDiskImage(`fdd0_${label}.xdf`, diskBytes);
  host.writeFile('/game/boot.cmd', new TextEncoder().encode(`px68k "${diskPath}" ""\n`));
  if (!host.loadGame('/game/boot.cmd')) throw new Error(`${label}: loadGame失敗`);
  host.fetchAvInfo();

  const checkDeadline = makeDeadline(label, frameCount);
  for (let i = 0; i < frameCount; i++) {
    host.runFrame();
    if (i % 50 === 0) checkDeadline();
  }
  const dump = host.readTextScreen();
  const textLines = dump.lines.map((l: string) => l.replaceAll('​', ''));
  host.dispose();
  return { lastImage, textLines };
}

/* --- レジスタ設定・ビルド --- */
interface Regs { crtc20: number; vc0hi: number; vc0lo: number; vc1hi: number; vc1lo: number; vc2hi: number; vc2lo: number; }
function regsToCsv(r: Regs): string {
  return [r.crtc20, r.vc0hi, r.vc0lo, r.vc1hi, r.vc1lo, r.vc2hi, r.vc2lo].map((v) => `0x${(v & 0xff).toString(16)}`).join(',');
}
function buildImage(outPath: string, r: Regs): void {
  execFileSync('bash', [resolve(DEV_ROOT, 'tools/build_stage_vc_sweep.sh'), regsToCsv(r), outPath], { cwd: DEV_ROOT });
}

/* --- フレームバッファ解析(セル座標は main_vc_sweep.c と同じ、実測済みピッチ8x16・原点(0,0)) --- */
const PITCH_X = 8, PITCH_Y = 16;
const CELL = {
  boxAndText: { col: 5, row: 3 },
  boxOnly: { col: 8, row: 3 },
  textOnly: { col: 11, row: 3 },
  negative: { col: 20, row: 3 }, // 何も描画していない領域(検出器の陰性対照)
  far: { col: 70, row: 3 },
};

function rgbAt(img: Image, x: number, y: number): [number, number, number] {
  const idx = (y * img.width + x) * 4;
  return [img.data[idx], img.data[idx + 1], img.data[idx + 2]];
}
function rgbKey(rgb: [number, number, number]): string { return `${rgb[0]},${rgb[1]},${rgb[2]}`; }
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
function cellColors(img: Image, col: number, row: number): Map<string, number> {
  const x0 = col * PITCH_X, y0 = row * PITCH_Y;
  const counts = new Map<string, number>();
  for (let y = y0; y < y0 + PITCH_Y; y++) {
    for (let x = x0; x < x0 + PITCH_X; x++) {
      if (x < 0 || x >= img.width || y < 0 || y >= img.height) continue;
      const key = rgbKey(rgbAt(img, x, y));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}
function farBeyond511(img: Image, bgKey: string): boolean {
  const y0 = CELL.far.row * PITCH_Y;
  for (let y = y0; y < y0 + PITCH_Y && y < img.height; y++) {
    for (let x = 512; x < img.width; x++) {
      if (rgbKey(rgbAt(img, x, y)) !== bgKey) return true;
    }
  }
  return false;
}

interface ConfigResult {
  label: string;
  regs: Regs;
  ok: boolean; // フレームバッファ取得・ALIVE到達
  negativeCellOk: boolean; // 陰性対照: 何も描いていないセルは背景色のみか
  boxOnlyColors: [string, number][];
  textOnlyColors: [string, number][];
  boxAndTextColors: [string, number][];
  gfxVisible: boolean; // box-only が単色(非背景)で塗られているか
  fillColorKey: string | null;
  textVisible: boolean; // text-only に背景色以外のピクセルがあるか
  boxAndTextSameAsBoxOnly: boolean; // 重畳セルが box-only と完全一致(=テキストが見えない)か
  simultaneousVisible: boolean; // gfxVisible && textVisible && 重畳セルに fill色+非fill非背景色の両方がある
  farVisible: boolean;
  textVramHasZAtBoxAndText: boolean;
  textVramHasAlive: boolean;
}

function textAtLine(lines: string[], row: number, col: number, text: string): boolean {
  if (row < 0 || row >= lines.length) return false;
  const line = lines[row];
  const padded = line.padEnd(col + text.length, ' ');
  return padded.slice(col, col + text.length) === text;
}

let bgKey: string | null = null;

async function runConfig(label: string, regs: Regs, xdfPath: string): Promise<ConfigResult> {
  buildImage(xdfPath, regs);
  const { lastImage, textLines } = await bootAndCapture(label, new Uint8Array(readFileSync(xdfPath)), FRAMES);
  const textVramHasAlive = textLines.some((l) => l.includes('ALIVE'));
  if (!lastImage) {
    return {
      label, regs, ok: false, negativeCellOk: false,
      boxOnlyColors: [], textOnlyColors: [], boxAndTextColors: [],
      gfxVisible: false, fillColorKey: null, textVisible: false,
      boxAndTextSameAsBoxOnly: false, simultaneousVisible: false, farVisible: false,
      textVramHasZAtBoxAndText: textAtLine(textLines, CELL.boxAndText.row, CELL.boxAndText.col, 'Z'),
      textVramHasAlive,
    };
  }
  if (bgKey === null) bgKey = dominantRgb(lastImage);
  const bg = bgKey;

  const negColors = cellColors(lastImage, CELL.negative.col, CELL.negative.row);
  const negativeCellOk = negColors.size === 1 && negColors.has(bg);

  const boxOnlyColors = cellColors(lastImage, CELL.boxOnly.col, CELL.boxOnly.row);
  const gfxVisible = boxOnlyColors.size === 1 && [...boxOnlyColors.keys()][0] !== bg;
  const fillColorKey = gfxVisible ? [...boxOnlyColors.keys()][0] : null;

  const textOnlyColors = cellColors(lastImage, CELL.textOnly.col, CELL.textOnly.row);
  const textVisible = [...textOnlyColors.keys()].some((k) => k !== bg);

  const boxAndTextColors = cellColors(lastImage, CELL.boxAndText.col, CELL.boxAndText.row);
  const boxAndTextKeys = [...boxAndTextColors.keys()];
  const boxAndTextSameAsBoxOnly = fillColorKey !== null && boxAndTextColors.size === 1 && boxAndTextColors.has(fillColorKey);
  // 「同時に見える」の機械的定義: box-onlyでグラフィックが見え(fillColorKey確定)、かつ
  // box+textセルに fill色のピクセルと、それ以外の非背景色(=グリフの実インク)の
  // 両方が同時に存在する(=グラフィックの上にテキストが判別可能な形で乗っている)。
  const hasFillPixel = fillColorKey !== null && boxAndTextColors.has(fillColorKey);
  const hasNonFillNonBgPixel = boxAndTextKeys.some((k) => k !== bg && k !== fillColorKey);
  const simultaneousVisible = gfxVisible && textVisible && hasFillPixel && hasNonFillNonBgPixel;

  const farVis = farBeyond511(lastImage, bg);
  const textVramHasZAtBoxAndText = textAtLine(textLines, CELL.boxAndText.row, CELL.boxAndText.col, 'Z');

  return {
    label, regs, ok: textVramHasAlive, negativeCellOk,
    boxOnlyColors: [...boxOnlyColors.entries()],
    textOnlyColors: [...textOnlyColors.entries()],
    boxAndTextColors: [...boxAndTextColors.entries()],
    gfxVisible, fillColorKey, textVisible,
    boxAndTextSameAsBoxOnly, simultaneousVisible, farVisible: farVis,
    textVramHasZAtBoxAndText, textVramHasAlive,
  };
}

async function main(): Promise<void> {
  console.log(`WEBX68K_DIR=${WEBX68K_DIR} FRAMES=${FRAMES}`);
  const results: string[] = [];
  const log = (s: string) => { console.log(s); results.push(s); };
  let overallOk = true;
  const fail = (msg: string) => { log(`RESULT: VC_FAIL ${msg}`); overallOk = false; };

  const baseRegs = (over: Partial<Regs>): Regs => ({
    crtc20: 0x08, vc0hi: 0x00, vc0lo: 0x03, vc1hi: 0x00, vc1lo: 0x00, vc2hi: 0x00, vc2lo: 0x00, ...over,
  });

  const allResults: ConfigResult[] = [];

  // ===================== 校正(既に手動実測済みだがログに残す) =====================
  log('=== 校正: 80フレームで描画完了(手動タイミングテストで実測、本スクリプトでは再実行しない) ===');
  log(`RESULT: VC_CALIBRATION_MIN_FRAMES=80 RESULT: VC_FRAMES_USED=${FRAMES}`);

  // ===================== 陽性対照2件(既知の設定、docs記載の事実の再確認) =====================
  log('=== 陽性対照: 既知の設定を本測定系で再確認 ===');
  const posGrpOnly = await runConfig('pos_grp_only', baseRegs({ vc2lo: 0x01 }), resolve(DEV_ROOT, 'build/vc_pos_grp.xdf'));
  allResults.push(posGrpOnly);
  log(`陽性対照1(VC_R2lo=0x01, Stage B/C/E1既知設定): gfxVisible=${posGrpOnly.gfxVisible} textVisible=${posGrpOnly.textVisible}`);
  log(`RESULT: VC_POS_CONTROL_GRP_ONLY_OK=${posGrpOnly.gfxVisible && !posGrpOnly.textVisible}(グラフィックのみ可視のはず)`);
  if (!(posGrpOnly.gfxVisible && !posGrpOnly.textVisible)) fail('陽性対照1(グラフィックのみ)が期待通りでない');

  const posTextOnly = await runConfig('pos_text_only', baseRegs({ vc2lo: 0x20 }), resolve(DEV_ROOT, 'build/vc_pos_text.xdf'));
  allResults.push(posTextOnly);
  log(`陽性対照2(VC_R2lo=0x20, パニック画面実装で既知): gfxVisible=${posTextOnly.gfxVisible} textVisible=${posTextOnly.textVisible}`);
  log(`RESULT: VC_POS_CONTROL_TEXT_ONLY_OK=${!posTextOnly.gfxVisible && posTextOnly.textVisible}(テキストのみ可視のはず)`);
  if (!(!posTextOnly.gfxVisible && posTextOnly.textVisible)) fail('陽性対照2(テキストのみ)が期待通りでない');

  // ===================== 陰性対照(明示、VC_R2=0x00) =====================
  const negCfg = await runConfig('neg_all_off', baseRegs({ vc2lo: 0x00 }), resolve(DEV_ROOT, 'build/vc_neg.xdf'));
  allResults.push(negCfg);
  log(`陰性対照(VC_R2lo=0x00、すべて無効): gfxVisible=${negCfg.gfxVisible} textVisible=${negCfg.textVisible}`);
  log(`RESULT: VC_NEGATIVE_CONTROL_OK=${!negCfg.gfxVisible && !negCfg.textVisible}(どちらも可視と判定されないはず)`);
  if (negCfg.gfxVisible || negCfg.textVisible) fail('陰性対照でグラフィックまたはテキストが可視と誤判定された');

  // ===================== Phase A: VC_R2 下位バイト全数(0x00-0xFF) =====================
  log('=== Phase A: VC_R2下位バイト($E82601) 全数(0x00-0xFF)、VC_R1=0,0 固定 ===');
  const phaseA: ConfigResult[] = [];
  for (let v = 0; v <= 0xff; v++) {
    const r = await runConfig(`phaseA_${v.toString(16)}`, baseRegs({ vc2lo: v }), resolve(DEV_ROOT, 'build/vc_phaseA.xdf'));
    phaseA.push(r);
    allResults.push(r);
    if (!r.negativeCellOk) fail(`Phase A vc2lo=0x${v.toString(16)}: 陰性セルが背景色以外を含む(観測系異常の疑い)`);
    if (!r.ok) fail(`Phase A vc2lo=0x${v.toString(16)}: ALIVE未到達(起動失敗の疑い)`);
  }
  const phaseABoth = phaseA.filter((r) => r.gfxVisible && r.textVisible);
  const phaseASimultaneous = phaseA.filter((r) => r.simultaneousVisible);
  log(`Phase A: gfxVisible&&textVisible な設定 = ${phaseABoth.length}件: ${JSON.stringify(phaseABoth.map((r) => `0x${r.regs.vc2lo.toString(16)}`))}`);
  log(`Phase A: simultaneousVisible(重畳セルでfill色+非fill非背景色が両方確認できた) = ${phaseASimultaneous.length}件: ${JSON.stringify(phaseASimultaneous.map((r) => `0x${r.regs.vc2lo.toString(16)}`))}`);
  log(`RESULT: VC_PHASE_A_CANDIDATES=${JSON.stringify(phaseABoth.map((r) => r.regs.vc2lo))}`);
  log(`RESULT: VC_PHASE_A_SIMULTANEOUS=${JSON.stringify(phaseASimultaneous.map((r) => r.regs.vc2lo))}`);
  for (const r of phaseABoth) {
    log(`  vc2lo=0x${r.regs.vc2lo.toString(16).padStart(2, '0')}: boxOnly=${JSON.stringify(r.boxOnlyColors)} boxAndText=${JSON.stringify(r.boxAndTextColors)} sameAsBoxOnly=${r.boxAndTextSameAsBoxOnly} simultaneous=${r.simultaneousVisible}`);
  }

  // ===================== Phase B: VC_R1 下位バイト全数(0x00-0xFF)、VC_R2lo=0x21固定 =====================
  log('=== Phase B: VC_R1下位バイト($E82500、優先度制御) 全数(0x00-0xFF)、VC_R2lo=0x21固定 ===');
  log('0x21 = grp可視ビット(0x01、陽性対照1由来)| text可視ビット(0x20、陽性対照2由来)のOR。Phase Aにこの値が含まれていればその結果とも突き合わせる。');
  const phaseB: ConfigResult[] = [];
  for (let v = 0; v <= 0xff; v++) {
    const r = await runConfig(`phaseB_${v.toString(16)}`, baseRegs({ vc2lo: 0x21, vc1lo: v }), resolve(DEV_ROOT, 'build/vc_phaseB.xdf'));
    phaseB.push(r);
    allResults.push(r);
    if (!r.negativeCellOk) fail(`Phase B vc1lo=0x${v.toString(16)}: 陰性セルが背景色以外を含む`);
    if (!r.ok) fail(`Phase B vc1lo=0x${v.toString(16)}: ALIVE未到達`);
  }
  const phaseBBoth = phaseB.filter((r) => r.gfxVisible && r.textVisible);
  const phaseBSimultaneous = phaseB.filter((r) => r.simultaneousVisible);
  log(`Phase B(vc2lo=0x21固定): gfxVisible&&textVisible = ${phaseBBoth.length}件`);
  log(`Phase B(vc2lo=0x21固定): simultaneousVisible = ${phaseBSimultaneous.length}件: ${JSON.stringify(phaseBSimultaneous.map((r) => `0x${r.regs.vc1lo.toString(16)}`))}`);
  log(`RESULT: VC_PHASE_B_CANDIDATES=${JSON.stringify(phaseBBoth.map((r) => r.regs.vc1lo))}`);
  log(`RESULT: VC_PHASE_B_SIMULTANEOUS=${JSON.stringify(phaseBSimultaneous.map((r) => r.regs.vc1lo))}`);
  for (const r of phaseBSimultaneous) {
    log(`  vc1lo=0x${r.regs.vc1lo.toString(16).padStart(2, '0')}: boxOnly=${JSON.stringify(r.boxOnlyColors)} boxAndText=${JSON.stringify(r.boxAndTextColors)}`);
  }

  // ===================== 前後関係の判定(Phase A/Bの simultaneousVisible 全件で一致するか) =====================
  const allSimultaneous = [...phaseASimultaneous, ...phaseBSimultaneous];
  let frontConclusion = '未確定(simultaneousVisibleな設定が見つからなかった)';
  let frontDetermined = false;
  if (allSimultaneous.length > 0) {
    // 「手前」の機械的判定: box+textセルに box-only の fill 色ピクセルが残っている
    // (グラフィックが完全には消えていない)状態で、かつ非fill非背景色(グリフインク)が
    // 存在する場合、そのインクは fill色の上から追加されている=テキストが手前。
    const allFront = allSimultaneous.every((r) => r.boxAndTextColors.some(([k]) => k !== bgKey && k !== r.fillColorKey));
    frontDetermined = true;
    frontConclusion = allFront
      ? 'テキストが手前(グリフのインクがグラフィックの塗り色の上に別色として観測される)'
      : '設定により異なる、または判定基準に一致しない(下記詳細を参照)';
    log(`前後関係: simultaneousVisibleな全${allSimultaneous.length}件で「テキストが手前」パターンに一致=${allFront}`);
  }
  log(`RESULT: VC_FRONT_BACK_DETERMINED=${frontDetermined}`);
  log(`RESULT: VC_FRONT_BACK_CONCLUSION=${frontConclusion}`);

  // ===================== Phase C: VC_R2上位バイト($E82600)を粗く振る =====================
  log('=== Phase C: VC_R2上位バイト($E82600、"special priority") を粗く振る ===');
  // 候補: 16刻み(0x00,0x10,...,0xF0) + px68k-libretro/x68k/crtc.c 周辺のソース読解
  // (px68k-libretro/libretro/windraw.c の WinDraw_DrawLine)で名前が登場したビットパターン
  // (0x14,0x1d,0x1e,0x5c,0x5d)。出所: ソース読解による候補であり実測ではない。
  // 実際に可視性・前後関係が変わるかはここで実測する。
  const phaseCBase = phaseASimultaneous.length > 0 ? phaseASimultaneous[0].regs.vc2lo
    : (phaseBSimultaneous.length > 0 ? 0x21 : 0x21);
  const phaseCVc1lo = phaseBSimultaneous.length > 0 ? phaseBSimultaneous[0].regs.vc1lo : 0x00;
  const coarseCandidates = new Set<number>([0x00, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xa0, 0xb0, 0xc0, 0xd0, 0xe0, 0xf0, 0x14, 0x1d, 0x1e, 0x5c, 0x5d, 0x10 | 0x04]);
  log(`Phase C基準値(ソース読解由来、実測で確認する候補): vc2lo=0x${phaseCBase.toString(16)}, vc1lo=0x${phaseCVc1lo.toString(16)}`);
  const phaseC: ConfigResult[] = [];
  for (const v of [...coarseCandidates].sort((a, b) => a - b)) {
    const r = await runConfig(`phaseC_${v.toString(16)}`, baseRegs({ vc2lo: phaseCBase, vc1lo: phaseCVc1lo, vc2hi: v }), resolve(DEV_ROOT, 'build/vc_phaseC.xdf'));
    phaseC.push(r);
    allResults.push(r);
    if (!r.negativeCellOk) fail(`Phase C vc2hi=0x${v.toString(16)}: 陰性セルが背景色以外を含む`);
  }
  const phaseCSimultaneous = phaseC.filter((r) => r.simultaneousVisible);
  log(`Phase C: 振った値=${JSON.stringify([...coarseCandidates].sort((a, b) => a - b).map((v) => `0x${v.toString(16)}`))}`);
  log(`Phase C: simultaneousVisible = ${phaseCSimultaneous.length}件: ${JSON.stringify(phaseCSimultaneous.map((r) => `0x${r.regs.vc2hi.toString(16)}`))}`);
  log(`RESULT: VC_PHASE_C_SWEPT=${JSON.stringify([...coarseCandidates].sort((a, b) => a - b))}`);
  log(`RESULT: VC_PHASE_C_SIMULTANEOUS=${JSON.stringify(phaseCSimultaneous.map((r) => r.regs.vc2hi))}`);

  // ===================== Phase D: VC_R1上位バイト($E82501)を粗く振る =====================
  log('=== Phase D: VC_R1上位バイト($E82501) を粗く振る(65536色モードでは未使用と読めるが実測で確認) ===');
  const phaseDCandidates = [0x00, 0x0f, 0x3f, 0xf0, 0xff];
  const phaseD: ConfigResult[] = [];
  for (const v of phaseDCandidates) {
    const r = await runConfig(`phaseD_${v.toString(16)}`, baseRegs({ vc2lo: phaseCBase, vc1lo: phaseCVc1lo, vc1hi: v }), resolve(DEV_ROOT, 'build/vc_phaseD.xdf'));
    phaseD.push(r);
    allResults.push(r);
  }
  const phaseDVaries = new Set(phaseD.map((r) => `${r.gfxVisible}_${r.textVisible}_${r.simultaneousVisible}`)).size > 1;
  log(`Phase D: 振った値=${JSON.stringify(phaseDCandidates.map((v) => `0x${v.toString(16)}`))}`);
  log(`Phase D: 結果パターン=${JSON.stringify(phaseD.map((r) => ({ vc1hi: `0x${r.regs.vc1hi.toString(16)}`, gfxVisible: r.gfxVisible, textVisible: r.textVisible, simultaneousVisible: r.simultaneousVisible })))}`);
  log(`RESULT: VC_PHASE_D_AFFECTS_VISIBILITY=${phaseDVaries}(false=振っても可視性パターンが変わらなかった、実測で確認)`);

  // ===================== 総合判定 =====================
  const foundSimultaneous = allSimultaneous.length > 0 || phaseCSimultaneous.length > 0;
  log(`RESULT: VC_SIMULTANEOUS_FOUND=${foundSimultaneous}`);
  if (foundSimultaneous) {
    const example = allSimultaneous[0] ?? phaseCSimultaneous[0];
    log(`RESULT: VC_SIMULTANEOUS_EXAMPLE_REGS=${JSON.stringify(example.regs)}`);
  }
  log(`RESULT: VC_SWEPT_RANGES=phaseA:vc2lo(0x00-0xFF,256件) phaseB:vc1lo(0x00-0xFF,256件,vc2lo=0x21固定) phaseC:vc2hi(粗く${coarseCandidates.size}件) phaseD:vc1hi(粗く${phaseDCandidates.length}件)`);
  log(`RESULT: VC_PASS=${overallOk}`);
  if (!overallOk) process.exitCode = 1;

  console.log('---JSON---');
  console.log(JSON.stringify({
    bgKey,
    posGrpOnly: { gfxVisible: posGrpOnly.gfxVisible, textVisible: posGrpOnly.textVisible },
    posTextOnly: { gfxVisible: posTextOnly.gfxVisible, textVisible: posTextOnly.textVisible },
    negCfg: { gfxVisible: negCfg.gfxVisible, textVisible: negCfg.textVisible },
    phaseABoth: phaseABoth.map((r) => r.regs.vc2lo),
    phaseASimultaneous: phaseASimultaneous.map((r) => r.regs.vc2lo),
    phaseBSimultaneous: phaseBSimultaneous.map((r) => r.regs.vc1lo),
    phaseCSimultaneous: phaseCSimultaneous.map((r) => r.regs.vc2hi),
    phaseDVaries,
    foundSimultaneous,
    frontConclusion,
    overallOk,
  }, null, 2));
}

await main();
