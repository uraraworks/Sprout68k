/*
 * 宿題3: テキスト画面とグラフィック画面の重なり方の実測(docs/API設計_20260819.md
 * 「テキスト画面とグラフィック画面は幅が違う」節、「API 実装時の宿題」3番)。
 *
 * Stage E-1(65536色グラフィック面 512x512)と Stage E-6(テキスト96桁x32行)は
 * それぞれ単独で実測済みだが、両者の「重なり方」(テキストの桁0がグラフィックの
 * x=0と揃っているか)は未実測。本スクリプトは推定を確認するのではなく、
 * グラフィック面の既知座標にマーカーを描き、テキストの既知桁・行に文字を出して、
 * 同じフレームバッファ上で位置関係を直接読む。
 *
 * 測定方式(2フェーズ):
 *   フェーズ1(桁・行あたりのドット数、原点、境界の実測):
 *     stage_e/src/main_e6.c(Stage E-6 実測済み、変更しない)をそのまま使い、
 *     19箇所に文字'#'を「1桁・1行につき1箇所」でrow=0..18に1つずつ配置
 *     (rowを重複させないことで、connected-componentのY方向分離を保証し、
 *     桁の値だけを自由に振れるようにした)。フレームバッファ(canvas)を
 *     直接走査し、非背景ピクセルの連結成分ごとに外接矩形を取り、
 *     ラスタ順(y→x昇順)でマーカーに対応付ける(Stage E-1 の手法を踏襲)。
 *     ここから 桁→x、行→y の対応(ピッチ・原点)を実測する。
 *     桁61〜66はそれぞれ専用行に置き、512ドット境界(桁63/64)を細かく実測する。
 *
 *   フェーズ2(前後関係・同一フレーム内での整合性確認):
 *     フェーズ1で実測したピッチ・原点をもとに、新規追加した
 *     stage_e/src/main_overlay.c(グラフィック矩形塗り+テキスト表示を同時に行う)で
 *     次の4セルを1フレームに同居させる:
 *       - 塗り+文字重ね(前後関係を見る本体)
 *       - 塗りのみ(対照。文字が無い状態の塗り色を確認)
 *       - 文字のみ(対照。グラフィック無しの文字の色・形を確認)
 *       - 何も置かない(陰性対照)
 *     さらに、フェーズ1で実測した「グラフィック面の外」に相当する桁(64以降)にも
 *     文字を出し、グラフィック用の基準マーカー(x=511, 実測済み最大可視x)と
 *     同一フレームで比較することで、境界を実測で裏付ける。
 *
 * 既知の罠(docs記載、E1/E6実測時の知見を踏襲):
 *   - px68k_no_wait_mode=enabled 必須(未設定だとコアが実時間に自己同期し進まない)
 *   - すべて同期実行。自前タイムアウト(makeDeadline)を必ず使う
 *   - __BUILD_ID__ / locateFile の2つの罠(loadFactory 内、E1/E6と同じ対処)
 *
 * 使い方: npx tsx verify/verify_overlay.mts
 * 環境変数: WEBX68K_DIR(既定 ../WebX68k)、FRAMES(既定 3000)
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

interface Image {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

interface BootResult {
  label: string;
  textLines: string[];
  lastImage: Image | null;
  columns: number;
  rows: number;
}

async function bootAndCapture(label: string, diskBytes: Uint8Array, frameCount: number): Promise<BootResult> {
  const { LibretroHost } = await import(pathToFileURL(resolve(WEBX68K_DIR, 'src/libretro-host.ts')).href);

  (globalThis as any).window = { PX68K: loadFactory() };
  let lastImage: Image | null = null;
  const context = {
    createImageData(width: number, height: number) {
      const w = Math.max(0, width | 0);
      const h = Math.max(0, height | 0);
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(img: any) {
      if (img && img.width > 0 && img.height > 0) lastImage = img;
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => context } as any;

  const host = new LibretroHost(canvas, () => {});
  host.setCoreOption('px68k_cpuspeed', '16Mhz');
  host.setCoreOption('px68k_ramsize', '1MB');
  // 既知の罠: 未設定だとコアが実時間に自己同期し runFrame() を何回呼んでも進まない
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
  const result: BootResult = {
    label,
    // 行を空行フィルタせずそのまま保持する(row インデックスと textLines の
    // 配列添字を一致させるため。verify_e6.mts の textAt/anyLineContains と
    // 同じ理由で、フィルタすると桁・行の対応付けが崩れる)。
    textLines: dump.lines.map((l: string) => l.replaceAll('​', '')),
    lastImage,
    columns: dump.diagnostics.columns,
    rows: dump.diagnostics.rows,
  };
  host.dispose();
  return result;
}

/* --- フェーズ1: テキスト校正(main_e6.c をそのまま使う) --- */

interface E6MarkerSpec {
  col: number;
  row: number;
  useLocate: boolean;
  text: string;
}

function specToJsonE6(markers: E6MarkerSpec[]): string {
  return JSON.stringify(markers.map((m) => [m.col, m.row, m.useLocate ? 1 : 0, m.text]));
}

function buildE6Image(outPath: string, markers: E6MarkerSpec[]): void {
  execFileSync('bash', [
    resolve(DEV_ROOT, 'tools/build_stage_e6.sh'),
    specToJsonE6(markers),
    outPath,
  ], { cwd: DEV_ROOT });
}

/* --- フェーズ2: グラフィック矩形塗り + テキスト同時表示(main_overlay.c、新規) --- */

interface BoxSpec { x: number; y: number; w: number; h: number; color: string; }
interface TextSpec { col: number; row: number; text: string; }

function specToJsonOverlay(boxes: BoxSpec[], texts: TextSpec[]): string {
  return JSON.stringify({
    boxes: boxes.map((b) => [b.x, b.y, b.w, b.h, b.color]),
    texts: texts.map((t) => [t.col, t.row, t.text]),
  });
}

function buildOverlayImage(outPath: string, boxes: BoxSpec[], texts: TextSpec[]): void {
  execFileSync('bash', [
    resolve(DEV_ROOT, 'tools/build_stage_overlay.sh'),
    specToJsonOverlay(boxes, texts),
    outPath,
  ], { cwd: DEV_ROOT });
}

/* --- フレームバッファ解析(connected component) --- */

function rgbAt(img: Image, x: number, y: number): [number, number, number] {
  const idx = (y * img.width + x) * 4;
  return [img.data[idx], img.data[idx + 1], img.data[idx + 2]];
}
function rgbKey(rgb: [number, number, number]): string {
  return `${rgb[0]},${rgb[1]},${rgb[2]}`;
}
function dominantRgb(img: Image): string {
  const counts = new Map<string, number>();
  for (let i = 0; i < img.data.length; i += 4) {
    const key = `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = '';
  let bestCount = -1;
  for (const [k, c] of counts) if (c > bestCount) { best = k; bestCount = c; }
  return best;
}

interface Component {
  minX: number; minY: number; maxX: number; maxY: number;
  pixelCount: number;
  colors: Set<string>;
}

/* 非背景ピクセルの8近傍連結成分を求め、外接矩形と含まれる色集合を返す。
 * ラスタ順(y→x昇順)にソートして返す(Stage E-1 の matchMarkersToClusters と
 * 同じ「N昇順=ラスタ順」前提を、ここでは「マーカーのrow昇順=y昇順」に対応させる)。
 *
 * 実測で判明した注意点: ANKフォントの字形("6"や"D"等の曲線を含む文字)は、
 * 4近傍(上下左右)だけでは1文字の内部が複数成分に分裂する(斜め方向にしか
 * 隣接しないドットがあるため)。8近傍にしたところ1文字=1成分になった
 * (実測で確認、"E6 DONE"で4近傍31成分→8近傍6成分)。 */
function connectedComponents(img: Image, backgroundKey: string): Component[] {
  const w = img.width, h = img.height;
  const visited = new Uint8Array(w * h);
  const isBg = (x: number, y: number) => rgbKey(rgbAt(img, x, y)) === backgroundKey;
  const comps: Component[] = [];
  const stackX = new Int32Array(w * h);
  const stackY = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (visited[idx] || isBg(x, y)) continue;
      let sp = 0;
      stackX[sp] = x; stackY[sp] = y; sp++;
      visited[idx] = 1;
      const comp: Component = { minX: x, maxX: x, minY: y, maxY: y, pixelCount: 0, colors: new Set() };
      while (sp > 0) {
        sp--;
        const cx = stackX[sp], cy = stackY[sp];
        comp.pixelCount++;
        comp.colors.add(rgbKey(rgbAt(img, cx, cy)));
        if (cx < comp.minX) comp.minX = cx;
        if (cx > comp.maxX) comp.maxX = cx;
        if (cy < comp.minY) comp.minY = cy;
        if (cy > comp.maxY) comp.maxY = cy;
        const neighbors: [number, number][] = [
          [cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1],
          [cx - 1, cy - 1], [cx + 1, cy - 1], [cx - 1, cy + 1], [cx + 1, cy + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const nidx = ny * w + nx;
          if (visited[nidx] || isBg(nx, ny)) continue;
          visited[nidx] = 1;
          stackX[sp] = nx; stackY[sp] = ny; sp++;
        }
      }
      comps.push(comp);
    }
  }
  return comps.sort((a, b) => (a.minY - b.minY) || (a.minX - b.minX));
}

/* readTextScreen() の行文字列の col 位置に text がそのまま現れているかを判定する
 * (verify_e6.mts の textAt と同じ考え方。行末トリムの影響を除くためパディングする)。 */
function textAtLine(lines: string[], row: number, col: number, text: string): boolean {
  if (row < 0 || row >= lines.length) return false;
  const line = lines[row];
  if (col < 0) return false;
  const padded = line.padEnd(col + text.length, ' ');
  return padded.slice(col, col + text.length) === text;
}

/* --- フェーズ1: 桁・行の校正マーカー ---
 * rowを1マーカー1行で重複させないことで、桁の値を自由に振っても
 * connected component が縦方向で確実に分離される(=桁ピッチの測定に
 * 桁同士の水平衝突リスクを持ち込まない)。桁61〜66は512ドット境界
 * (桁63/64相当)を細かく見るための専用点。 */
const CAL_COLS = [0, 2, 4, 8, 16, 32, 48, 60, 61, 62, 63, 64, 65, 66, 70, 80, 90, 94, 95];

async function main(): Promise<void> {
  console.log(`WEBX68K_DIR=${WEBX68K_DIR}`);
  const FRAMES = Number(process.env.FRAMES ?? 3000);
  const results: string[] = [];
  const log = (s: string) => { console.log(s); results.push(s); };
  let overallOk = true;
  const fail = (msg: string) => { log(`RESULT: OVL_FAIL ${msg}`); overallOk = false; };
  const undetermined: string[] = [];

  // ===================== フェーズ1: テキスト校正 =====================
  log('=== フェーズ1: テキスト桁・行の校正(main_e6.c 流用) ===');

  // 陰性対照: マーカー無し(main_e6.c は必ず末尾に無指定で"E6 DONE"を出すため、
  // 観測系の健全性チェックとしてそれ以外に何も出ないことを見る)
  const emptyImg = resolve(DEV_ROOT, 'build/stage_overlay_cal_empty.xdf');
  buildE6Image(emptyImg, []);
  const empty = await bootAndCapture('cal_empty', new Uint8Array(readFileSync(emptyImg)), FRAMES);
  if (!empty.lastImage) { log('RESULT: OVL_FATAL=フェーズ1陰性対照でフレームバッファ取得不可'); process.exitCode = 1; return; }
  const bgKey = dominantRgb(empty.lastImage);
  log(`background rgb=${bgKey} (columns=${empty.columns} rows=${empty.rows})`);
  // "E6 DONE" は空白を挟むため、8近傍連結成分としては空白を除く6文字ぶん
  // (E,6,D,O,N,E)の6成分に分かれる(実測で確認済み。事前の決め打ちではない:
  // 下のデバッグ実測で4近傍31成分→8近傍6成分になることを確認した上でこの値を使う)。
  const DONE_GLYPH_COUNT = 6;
  const emptyComps = connectedComponents(empty.lastImage, bgKey);
  log(`negative control components=${emptyComps.length} (期待: "E6 DONE"の${DONE_GLYPH_COUNT}個のみ)`);
  const calNegativeControlOk = emptyComps.length === DONE_GLYPH_COUNT;
  log(`RESULT: OVL_CAL_NEGATIVE_CONTROL_OK=${calNegativeControlOk}`);
  if (!calNegativeControlOk) fail('フェーズ1陰性対照で想定外の成分数(観測系または起動直後の状態の前提が崩れている)');

  // 校正マーカー本体: row=index, col=CAL_COLS[index] で桁ごとに専用行を使う
  const calMarkers: E6MarkerSpec[] = CAL_COLS.map((col, row) => ({ col, row, useLocate: true, text: '#' }));
  const calImg = resolve(DEV_ROOT, 'build/stage_overlay_cal.xdf');
  buildE6Image(calImg, calMarkers);
  const cal = await bootAndCapture('cal', new Uint8Array(readFileSync(calImg)), FRAMES);
  if (!cal.lastImage) { log('RESULT: OVL_FATAL=フェーズ1校正でフレームバッファ取得不可'); process.exitCode = 1; return; }
  // "E6 DONE" 分の成分が1個混ざるので、それを除いた個数がCAL_COLS.lengthと一致するはず。
  // "E6 DONE" は末尾・無指定表示のため、校正マーカーの後(現在カーソル位置)に出る=
  // 校正マーカーより下の行になるとは限らないため、成分数の不一致で検出する。
  const calComps = connectedComponents(cal.lastImage, bgKey);
  const expectedTotal = CAL_COLS.length + DONE_GLYPH_COUNT;
  log(`calibration components=${calComps.length} (期待: ${CAL_COLS.length}個の'#' + ${DONE_GLYPH_COUNT}個の"E6 DONE" = ${expectedTotal})`);
  const calCountOk = calComps.length === expectedTotal;
  log(`RESULT: OVL_CAL_COMPONENT_COUNT_OK=${calCountOk}`);
  if (!calCountOk) {
    fail(`校正マーカーの成分数が期待と不一致(実測=${calComps.length}, 期待=${expectedTotal})。ピッチ・原点は確定できない`);
    undetermined.push('桁・行あたりのドット数(成分数不一致のため対応付け不能)');
    undetermined.push('原点のずれ(同上)');
    undetermined.push('512ドット境界に対応する桁(同上)');
    log(`RESULT: OVL_PASS=false`);
    process.exitCode = 1;
    console.log('---JSON---');
    console.log(JSON.stringify({ overallOk: false, undetermined }, null, 2));
    return;
  }
  // calComps は(minY,minX)昇順ソート済み。校正マーカーは行0〜18(CAL_COLS.length個、
  // 各1行専用)、"E6 DONE"は最後のマーカー(row=18)より後の行に無指定で追記されるため、
  // y座標が校正マーカー群より必ず大きくなるはず。先頭CAL_COLS.length個を校正マーカー、
  // 残りをDONEとみなし、実際に両群のY範囲が重ならないことを検証してから使う
  // (仮定のまま使わず、実測で分離できているかを確認する)。
  const markerComps = calComps.slice(0, CAL_COLS.length);
  const doneComps = calComps.slice(CAL_COLS.length);
  const markerMaxY = Math.max(...markerComps.map((c) => c.maxY));
  const doneMinY = Math.min(...doneComps.map((c) => c.minY));
  const ySeparationOk = markerMaxY < doneMinY;
  log(`校正マーカー群のY範囲(maxY=${markerMaxY}) と "E6 DONE" 群のY範囲(minY=${doneMinY}): 分離=${ySeparationOk}`);
  if (!ySeparationOk) {
    fail('校正マーカーと"E6 DONE"のY範囲が重なっており、機械的な前方${CAL_COLS.length}個切り出しでは対応付けられない');
    undetermined.push('桁・行あたりのドット数(マーカーと"E6 DONE"の分離に失敗)');
    log(`RESULT: OVL_PASS=false`);
    process.exitCode = 1;
    return;
  }

  interface CalPoint { col: number; row: number; minX: number; minY: number; maxX: number; maxY: number; }
  const calPoints: CalPoint[] = markerComps.map((c, i) => ({
    col: CAL_COLS[i], row: i, minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY,
  }));
  log('col,row -> (minX,minY)-(maxX,maxY):');
  for (const p of calPoints) log(`  col=${p.col} row=${p.row} -> (${p.minX},${p.minY})-(${p.maxX},${p.maxY})`);

  // row 昇順(=CAL_COLSのindex昇順、連続値)から行ピッチを求める(隣接差分すべてを実測し、
  // 全部一致するかどうかで「一定ピッチ」を検証する。1点だけでは判断しない)。
  const rowPitches: number[] = [];
  for (let i = 1; i < calPoints.length; i++) rowPitches.push(calPoints[i].minY - calPoints[i - 1].minY);
  const rowPitchSet = new Set(rowPitches);
  const rowPitchUniform = rowPitchSet.size === 1;
  const pitchY = rowPitchUniform ? rowPitches[0] : null;
  log(`row pitch candidates=${JSON.stringify(rowPitches)} uniform=${rowPitchUniform} pitchY=${pitchY}`);

  // col -> x の対応から桁ピッチを求める(複数点間の差分すべてを見て、線形(等間隔)で
  // 説明できるかを検証する。Stage E-1 の「候補stride全数一致検査」と同じ考え方)。
  const colXPairs = calPoints.map((p) => ({ col: p.col, x: p.minX }));
  const pitchCandidates: number[] = [];
  for (let i = 1; i < colXPairs.length; i++) {
    const dc = colXPairs[i].col - colXPairs[i - 1].col;
    const dx = colXPairs[i].x - colXPairs[i - 1].x;
    if (dc !== 0 && dx % dc === 0) pitchCandidates.push(dx / dc);
  }
  const pitchXCandidateSet = new Set(pitchCandidates);
  let pitchX: number | null = null;
  let pitchXConsistent = false;
  if (pitchXCandidateSet.size === 1) {
    pitchX = [...pitchXCandidateSet][0];
    // 全点を x = x0 + col*pitchX で説明できるか検証(x0 は col=0 の点から取る)
    const zeroPoint = colXPairs.find((p) => p.col === 0);
    if (zeroPoint) {
      const x0 = zeroPoint.x;
      pitchXConsistent = colXPairs.every((p) => x0 + p.col * (pitchX as number) === p.x);
    }
  }
  log(`col->x pitch candidates(隣接差分)=${JSON.stringify(pitchCandidates)} 単一値=${pitchXCandidateSet.size === 1} 全点整合=${pitchXConsistent} pitchX=${pitchX}`);

  const col0 = calPoints.find((p) => p.col === 0)!;
  const row0X = col0.minX;
  const row0Y = col0.minY;
  log(`col=0,row=0 の実測位置(左上): x=${row0X}, y=${row0Y}`);

  // 結論1: 原点のずれ(col=0,row=0がグラフィックのどの座標に対応するか)
  const originConfirmed = pitchXConsistent && rowPitchUniform;
  log(`RESULT: OVL_ORIGIN_X=${row0X}`);
  log(`RESULT: OVL_ORIGIN_Y=${row0Y}`);
  log(`RESULT: OVL_ORIGIN_DETERMINED=${originConfirmed}`);
  if (!originConfirmed) undetermined.push('原点のずれの有無(ピッチが一定と確認できなかった)');

  // 結論2: 1桁・1行あたりのドット数
  log(`RESULT: OVL_PITCH_X_DETERMINED=${pitchXConsistent}`);
  log(`RESULT: OVL_PITCH_X=${pitchX}`);
  log(`RESULT: OVL_PITCH_Y_DETERMINED=${rowPitchUniform}`);
  log(`RESULT: OVL_PITCH_Y=${pitchY}`);
  if (!pitchXConsistent) undetermined.push('1桁あたりのドット数(全点で整合するピッチが得られなかった)');
  if (!rowPitchUniform) undetermined.push('1行あたりのドット数(隣接差分が一定でなかった)');

  // 結論3: グラフィック面(512ドット幅、Stage E-1実測)に収まる最大桁
  // 実測した col->x を直接使う(推定の外挿ではなく、桁61〜66は実測点そのもの)。
  const boundaryPoints = calPoints.filter((p) => p.col >= 60 && p.col <= 66);
  log('境界付近(桁60〜66)の実測 minX/maxX:');
  for (const p of boundaryPoints) log(`  col=${p.col}: minX=${p.minX} maxX=${p.maxX}`);
  const GVRAM_MAX_X = 511; // Stage E-1 実測: グラフィック面はx=0..511が可視
  const lastColInsideByMaxX = boundaryPoints.filter((p) => p.maxX <= GVRAM_MAX_X).map((p) => p.col);
  const firstColOutsideByMinX = boundaryPoints.filter((p) => p.minX > GVRAM_MAX_X).map((p) => p.col);
  const boundaryMaxCol = lastColInsideByMaxX.length ? Math.max(...lastColInsideByMaxX) : null;
  const boundaryFirstOutsideCol = firstColOutsideByMinX.length ? Math.min(...firstColOutsideByMinX) : null;
  log(`RESULT: OVL_LAST_COL_INSIDE_GVRAM=${boundaryMaxCol}(この桁までグラフィック面512ドット幅に収まる。実測点内での最大値)`);
  log(`RESULT: OVL_FIRST_COL_OUTSIDE_GVRAM=${boundaryFirstOutsideCol}(この桁からグラフィック面の外)`);
  const boundaryDetermined = boundaryMaxCol !== null && boundaryFirstOutsideCol !== null && boundaryFirstOutsideCol === boundaryMaxCol + 1;
  log(`RESULT: OVL_BOUNDARY_DETERMINED=${boundaryDetermined}`);
  if (!boundaryDetermined) undetermined.push('グラフィック面(512ドット幅)に収まる最大桁(境界が実測点内で1桁刻みに確定できなかった)');

  // ===================== フェーズ2: 前後関係 + 同一フレーム内整合性 =====================
  log('=== フェーズ2: グラフィック矩形とテキストの重ね合わせ(main_overlay.c、同一フレーム) ===');

  if (pitchX === null || pitchY === null) {
    log('RESULT: OVL_PHASE2_SKIPPED=true (フェーズ1でピッチが確定できなかったためセル位置を計算できない)');
    undetermined.push('前後関係(フェーズ1のピッチ未確定のためセルを配置できず未実施)');
  } else {
    const cellX = (col: number) => row0X + col * pitchX!;
    const cellY = (row: number) => row0Y + row * pitchY!;

    const FILL_COLOR = '0xF803'; // 明色(G=31,R=0,B=0付近。テキスト前景色との混同を避けるため強い単色を選ぶ)
    const boxAndTextCol = 5, boxAndTextRow = 3;
    const boxOnlyCol = 8, boxOnlyRow = 3;
    const textOnlyCol = 11, textOnlyRow = 3;
    const negativeCol = 20, negativeRow = 3;
    const farCol = 70, farRow = 3; // グラフィック面の外側(実測でOVL_FIRST_COL_OUTSIDE_GVRAM以降)にあたる桁

    const boxes: BoxSpec[] = [
      { x: cellX(boxAndTextCol), y: cellY(boxAndTextRow), w: pitchX, h: pitchY, color: FILL_COLOR },
      { x: cellX(boxOnlyCol), y: cellY(boxOnlyRow), w: pitchX, h: pitchY, color: FILL_COLOR },
      // 実測済み最大可視x(511)に基準ドットを置き、桁70の文字がその外側にあることを
      // 同一フレームで視覚的に裏付ける(GVRAM書き込み側は幅512の外へ書けないため、
      // この基準ドットが「グラフィック面で表現できる最右端」の実測上の目印になる)。
      { x: 511, y: cellY(farRow), w: 1, h: 1, color: FILL_COLOR },
    ];
    const texts: TextSpec[] = [
      { col: boxAndTextCol, row: boxAndTextRow, text: 'Z' },
      { col: textOnlyCol, row: textOnlyRow, text: 'Z' },
      { col: farCol, row: farRow, text: 'FAR' },
      { col: 0, row: 31, text: 'ALIVE' }, // 生存確認(セルから離れた安全な位置)
    ];
    log(`cellX/cellY 計算に使ったピッチ: pitchX=${pitchX} pitchY=${pitchY} origin=(${row0X},${row0Y})`);
    log(`boxAndText cell=(col=${boxAndTextCol},row=${boxAndTextRow}) -> pixel box (${cellX(boxAndTextCol)},${cellY(boxAndTextRow)}) w=${pitchX} h=${pitchY}`);

    const overlayImg = resolve(DEV_ROOT, 'build/stage_overlay_phase2.xdf');
    buildOverlayImage(overlayImg, boxes, texts);
    const overlay = await bootAndCapture('overlay_phase2', new Uint8Array(readFileSync(overlayImg)), FRAMES);
    if (!overlay.lastImage) {
      fail('フェーズ2でフレームバッファ取得不可');
      undetermined.push('前後関係(フェーズ2の起動に失敗)');
    } else {
      const img = overlay.lastImage;
      // 生存確認: "ALIVE" がテキスト画面に出ているか(readTextScreen側でも確認)
      const aliveOk = overlay.textLines.some((l) => l.includes('ALIVE'));
      log(`RESULT: OVL_PHASE2_ALIVE_OK=${aliveOk}`);
      if (!aliveOk) fail('フェーズ2: ゲストが生存確認("ALIVE")まで到達しなかった');

      function cellPixelColors(col: number, row: number): Map<string, number> {
        const x0 = cellX(col), y0 = cellY(row);
        const counts = new Map<string, number>();
        for (let y = y0; y < y0 + pitchY!; y++) {
          for (let x = x0; x < x0 + pitchX!; x++) {
            if (x < 0 || x >= img.width || y < 0 || y >= img.height) continue;
            const key = rgbKey(rgbAt(img, x, y));
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
        return counts;
      }

      const negColors = cellPixelColors(negativeCol, negativeRow);
      const negOnlyBg = negColors.size === 1 && negColors.has(bgKey);
      log(`negative cell(col=${negativeCol},row=${negativeRow}) colors=${JSON.stringify([...negColors.entries()])}`);
      log(`RESULT: OVL_PHASE2_NEGATIVE_CONTROL_OK=${negOnlyBg}(何も置いていないセルが背景色のみか)`);
      if (!negOnlyBg) fail('フェーズ2: 陰性対照セルに背景色以外のピクセルが出た');

      const boxOnlyColors = cellPixelColors(boxOnlyCol, boxOnlyRow);
      log(`box-only cell(col=${boxOnlyCol},row=${boxOnlyRow}) colors=${JSON.stringify([...boxOnlyColors.entries()])}`);
      const boxOnlyIsSolidFill = boxOnlyColors.size === 1 && [...boxOnlyColors.keys()][0] !== bgKey;
      log(`RESULT: OVL_PHASE2_BOX_ONLY_SOLID=${boxOnlyIsSolidFill}(塗りのみセルが単色で埋まっているか=対照の健全性)`);
      if (!boxOnlyIsSolidFill) fail('フェーズ2: 塗りのみセルが期待通り単色で埋まっていない(グラフィック描画自体が疑わしい)');
      const fillColorKey = boxOnlyIsSolidFill ? [...boxOnlyColors.keys()][0] : null;

      // 文字のみセル(グラフィックの塗り無し)。ここに文字が「見えない」場合、
      // それ自体が結論(後述)であって観測系の異常ではない。ただし本当に
      // iocs_locate/iocs_print が実行されたかどうかは readTextScreen(Text VRAM を
      // 直接読む経路。フレームバッファとは独立)で裏付けを取ってから判定する。
      const textOnlyColors = cellPixelColors(textOnlyCol, textOnlyRow);
      log(`text-only cell(col=${textOnlyCol},row=${textOnlyRow}) colors=${JSON.stringify([...textOnlyColors.entries()])}`);
      const textOnlyVisibleInFramebuffer = [...textOnlyColors.keys()].some((k) => k !== bgKey);
      const textOnlyWrittenToTextVram = textAtLine(overlay.textLines, textOnlyRow, textOnlyCol, 'Z');
      log(`RESULT: OVL_PHASE2_TEXT_ONLY_IN_TEXTVRAM=${textOnlyWrittenToTextVram}(Text VRAM側にはZが書き込まれているか)`);
      log(`RESULT: OVL_PHASE2_TEXT_ONLY_VISIBLE_IN_FRAMEBUFFER=${textOnlyVisibleInFramebuffer}(フレームバッファ上に見えているか)`);

      const boxAndTextColors = cellPixelColors(boxAndTextCol, boxAndTextRow);
      log(`box+text cell(col=${boxAndTextCol},row=${boxAndTextRow}) colors=${JSON.stringify([...boxAndTextColors.entries()])}`);
      const boxAndTextIsSameAsBoxOnly = fillColorKey !== null && boxAndTextColors.size === 1 && boxAndTextColors.has(fillColorKey);
      const boxAndTextWrittenToTextVram = textAtLine(overlay.textLines, boxAndTextRow, boxAndTextCol, 'Z');
      log(`RESULT: OVL_PHASE2_BOXTEXT_IN_TEXTVRAM=${boxAndTextWrittenToTextVram}(Text VRAM側にはZが書き込まれているか)`);
      log(`RESULT: OVL_PHASE2_BOXTEXT_SAME_AS_BOXONLY=${boxAndTextIsSameAsBoxOnly}(文字を重ねても塗りセルの見た目が変化しないか)`);

      // フェーズ1(main_e6.c、65536色モード未使用)ではフレームバッファ上に
      // 文字が正しく描画されることを既に実測済み(校正マーカー25成分が検出できた
      // 事実そのものが証拠)。したがって、この フェーズ2 で文字がText VRAMには
      // 書き込まれているのにフレームバッファに出ない場合、原因は
      // 「文字表示機能自体の欠陥」ではなく「65536色グラフィックモードが
      // 有効な間、その512ドット幅の範囲内でテキストが一切見えなくなる」
      // というモードレベルの排他だと切り分けられる(観測系の異常ではない)。
      let frontConclusion: string;
      let frontDetermined = false;
      if (fillColorKey === null) {
        frontConclusion = '未確定(塗りのみ対照が単色にならなかったため判定不能)';
      } else if (textOnlyWrittenToTextVram && boxAndTextWrittenToTextVram && !textOnlyVisibleInFramebuffer && boxAndTextIsSameAsBoxOnly) {
        frontConclusion = 'グラフィックが手前(というより排他): 65536色グラフィックモード有効時、その512ドット幅の範囲内ではテキストはフレームバッファに一切現れない。' +
          'Text VRAMには文字が正しく書き込まれている(readTextScreenで確認済み)が、描画結果には反映されない。' +
          'これはピクセル単位の合成ではなく、グラフィック塗りの有無に関わらず(文字のみセルでも)起きるモード全体の排他である(フェーズ1で同じ文字表示手段がグラフィックモード無しでは正しく描画されることを実測済みのため、原因はグラフィックモードのON/OFFに切り分けられる)。';
        frontDetermined = true;
      } else if (textOnlyVisibleInFramebuffer && !boxAndTextIsSameAsBoxOnly) {
        frontConclusion = 'テキストが手前: グラフィックの塗りと文字が同一セル内に共存して見えている';
        frontDetermined = true;
      } else {
        frontConclusion = '未確定(想定外の色構成。上記の色ダンプを参照)';
      }
      log(`RESULT: OVL_FRONT_BACK_DETERMINED=${frontDetermined}`);
      log(`RESULT: OVL_FRONT_BACK_CONCLUSION=${frontConclusion}`);
      if (!frontDetermined) { fail('前後関係が判定できない色構成だった'); undetermined.push('文字とグラフィックの前後関係'); }

      // 桁70(グラフィック外相当)の文字が、実測した最大可視x(511)より右側の
      // canvas領域に出ているかを確認する(境界の裏付け、同一フレーム内)
      const farHit = overlay.textLines.some((l) => l.includes('FAR'));
      log(`RESULT: OVL_PHASE2_FAR_TEXT_PRESENT=${farHit}(readTextScreen上でFARが出ているか)`);
      // フレームバッファ上でも x>511 の範囲に非背景ピクセルがあるか(farRowの帯のみ走査)
      const farRowY0 = cellY(farRow);
      let farBeyond511 = false;
      for (let y = farRowY0; y < farRowY0 + pitchY! && y < img.height; y++) {
        for (let x = 512; x < img.width; x++) {
          if (rgbKey(rgbAt(img, x, y)) !== bgKey) { farBeyond511 = true; break; }
        }
        if (farBeyond511) break;
      }
      log(`RESULT: OVL_FAR_TEXT_BEYOND_X511=${farBeyond511}(桁${farCol}の文字がx>511の領域に実際に描画されているか)`);
      if (!farHit || !farBeyond511) fail('境界確認用の桁(グラフィック面の外側想定)で期待した描画が確認できなかった');
    }
  }

  log(`RESULT: OVL_UNDETERMINED_ITEMS=${JSON.stringify(undetermined)}`);
  log(`RESULT: OVL_PASS=${overallOk}`);
  if (!overallOk) process.exitCode = 1;

  console.log('---JSON---');
  console.log(JSON.stringify({
    bgKey,
    pitchX, pitchY, originX: row0X, originY: row0Y,
    boundaryMaxCol, boundaryFirstOutsideCol,
    overallOk, undetermined,
  }, null, 2));
}

await main();
