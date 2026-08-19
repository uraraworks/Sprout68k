/*
 * Stage E-6: 学習用 API `print_at(col, row, s)`(座標指定で文字列を表示する)を
 * 実装するための手段を実測する。ブラウザは使わず Node から直接コアを回す
 * (verify/verify_e1.mts のコア駆動部分を踏襲。__BUILD_ID__/locateFile の2つの罠、
 * makeDeadline の自前タイムアウトは同じ実装を使う)。
 *
 * 候補(解読による): D0=0x23 TRAP #15(D1.L=col, D2.L=row)を「B_LOCATE」候補として
 * 使う。出所は datacrystal.tcrf.net の X68k/IOCS ページを WebFetch で読んだ内容
 * (このスクリプト自身は一次資料ではない)。IOCS $46 の A0/A1 取り違えの実績が
 * あるため、この候補を「実測済み」とは呼ばず、以下の実測でしか裏付けを取らない。
 * 文字列表示そのもの(IOCS $21)は Stage A/C で実測済みのものをそのまま使う。
 *
 * 測定方式:
 *   1. 陰性対照A(マーカー無し): 何も表示しない検体で readTextScreen() が
 *      全マス空であることを確認する(観測系そのものの健全性チェック)。
 *   2. 一次実測(4箇所・入力追従): 左上・右寄り・下寄り・中央の4箇所に、
 *      iocs_locate() で位置指定してから iocs_print() で別々の文字列を表示する。
 *      readTextScreen() の該当行・該当列に、指定した文字列がそのまま
 *      現れることを実測する(位置と内容を同時に突き合わせる)。
 *   3. 陰性対照B(座標指定なし): 同じ4文字列を iocs_locate() を呼ばずに
 *      iocs_print() だけで出す。手順2と同じ4箇所には出ないことを確認する。
 *   4. 範囲外座標: 負の値・列/行の上限超えを含む座標を与え、(a) 暴走せず
 *      直後のiocs_print("RECOVER")が期待通りの位置に出ること(観測が続けられる
 *      ことの証拠)、(b) 範囲外に指定した文字列がどこかに出現するか(出るなら
 *      どこか、出ないなら無視されたのか)を全画面走査で記録する。
 *   5. 境界値: 手順1/2で実測した columns/rows を使い、最終有効セル
 *      (columns-1, rows-1) と、その直後(columns, rows)を突き合わせる。
 *
 * 使い方: npx tsx verify/verify_e6.mts
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

/* 自前タイムアウト(verify_e1.mts を踏襲)。範囲外座標でゲストが暴走(無限ループ・
 * 例外連鎖等)した場合に検証プロセスごと固まらないようにするための保険。 */
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

/* Stage E-2/E-3 と同じ理由で no_wait_mode=enabled を最初から使う
 * (px68k-libretro の retro_run() が実時間へ自己同期する罠。既知の罠として
 * 指示済み)。cpuspeed/ramsize は Stage E-1 と同じ値。 */
const CORE_OPTIONS_USED = {
  px68k_cpuspeed: '16Mhz',
  px68k_ramsize: '1MB',
  px68k_no_wait_mode: 'enabled',
};

interface TextScreenResult {
  available: boolean;
  unavailableReason?: string;
  lines: string[];
  columns: number;
  rows: number;
  nonEmptyCells: number;
}

async function bootAndReadText(label: string, diskBytes: Uint8Array, frameCount: number): Promise<TextScreenResult> {
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

  const checkDeadline = makeDeadline(label, frameCount);
  for (let i = 0; i < frameCount; i++) {
    host.runFrame();
    if (i % 50 === 0) checkDeadline();
  }

  const dump = host.readTextScreen();
  const result: TextScreenResult = {
    available: dump.available,
    unavailableReason: dump.unavailableReason,
    lines: dump.lines,
    columns: dump.diagnostics.columns,
    rows: dump.diagnostics.rows,
    nonEmptyCells: dump.diagnostics.nonEmptyCells,
  };
  host.dispose();
  return result;
}

interface MarkerSpec {
  col: number;
  row: number;
  useLocate: boolean;
  text: string;
}

function specToJson(markers: MarkerSpec[]): string {
  return JSON.stringify(markers.map((m) => [m.col, m.row, m.useLocate ? 1 : 0, m.text]));
}

function buildStageE6Image(outPath: string, markers: MarkerSpec[]): void {
  execFileSync('bash', [
    resolve(DEV_ROOT, 'tools/build_stage_e6.sh'),
    specToJson(markers),
    outPath,
  ], { cwd: DEV_ROOT });
}

/* 行文字列の col 位置に text がそのまま現れているかを判定する。
 * readTextScreen() は行末の空白をトリムする(text-screen.ts の trimLineEnd)ため、
 * 行が短くても col+text.length が行長を超えていること自体は不一致の直接証拠には
 * ならない(単に後ろが空白だった可能性がある)。ここでは「行を必要な長さまで
 * 空白でパディングしてから比較」することでその影響を除く。 */
function textAt(lines: string[], row: number, col: number, text: string): boolean {
  if (row < 0 || row >= lines.length) return false;
  const line = lines[row];
  if (col < 0) return false;
  const padded = line.padEnd(col + text.length, ' ');
  return padded.slice(col, col + text.length) === text;
}

function anyLineContains(lines: string[], text: string): { row: number; col: number }[] {
  const hits: { row: number; col: number }[] = [];
  for (let r = 0; r < lines.length; r++) {
    let idx = lines[r].indexOf(text);
    while (idx !== -1) {
      hits.push({ row: r, col: idx });
      idx = lines[r].indexOf(text, idx + 1);
    }
  }
  return hits;
}

async function main(): Promise<void> {
  console.log(`WEBX68K_DIR=${WEBX68K_DIR}`);
  const FRAMES = Number(process.env.FRAMES ?? 3000);

  const results: string[] = [];
  const log = (s: string) => { console.log(s); results.push(s); };
  let overallOk = true;
  const fail = (msg: string) => { log(`RESULT: E6_FAIL ${msg}`); overallOk = false; };

  // === 手順1: 陰性対照A(マーカー無し。観測系そのものの健全性) ===
  log('--- 陰性対照A(マーカー無し) ---');
  const emptyImg = resolve(DEV_ROOT, 'build/stage_e6_empty.xdf');
  buildStageE6Image(emptyImg, []);
  const empty = await bootAndReadText('e6_empty', new Uint8Array(readFileSync(emptyImg)), FRAMES);
  if (!empty.available) {
    log(`RESULT: E6_FATAL=テキスト画面取得不可(${empty.unavailableReason})`);
    process.exitCode = 1;
    return;
  }
  log(`empty: columns=${empty.columns} rows=${empty.rows} nonEmptyCells=${empty.nonEmptyCells}`);
  const columns = empty.columns;
  const rows = empty.rows;
  // main_e6.c は marker_count=0 でも最後に "E6 DONE" を無指定(現在位置)で出すため、
  // 陰性対照Aは「マス空」ではなく「E6 DONEが1箇所だけ出ている」が正しい期待値。
  const emptyDoneHits = anyLineContains(empty.lines, 'E6 DONE');
  const expectedNonEmpty = 'E6 DONE'.replaceAll(' ', '').length; // 空白セルはnonEmptyCellsに数えない
  const emptyControlOk = emptyDoneHits.length === 1 && empty.nonEmptyCells === expectedNonEmpty;
  log(`RESULT: E6_EMPTY_CONTROL_OK=${emptyControlOk} E6_DONE位置=${JSON.stringify(emptyDoneHits)} nonEmptyCells=${empty.nonEmptyCells}(期待=${expectedNonEmpty})`);
  if (!emptyControlOk) fail('陰性対照Aで想定外の表示。観測系または起動直後のカーソル既定位置の前提が崩れている');

  // === 手順2: 一次実測(4箇所・入力追従) ===
  log('--- 一次実測(4箇所) ---');
  const primaryTargets: MarkerSpec[] = [
    { col: 2, row: 1, useLocate: true, text: 'TOPLEFT' },
    { col: Math.min(70, Math.max(columns - 10, 0)), row: 3, useLocate: true, text: 'RIGHTSIDE' },
    { col: 5, row: Math.max(rows - 4, 0), useLocate: true, text: 'BOTTOM' },
    { col: Math.floor(columns / 2), row: Math.floor(rows / 2), useLocate: true, text: 'CENTER' },
  ];
  log(`primary targets: ${JSON.stringify(primaryTargets)}`);
  const primaryImg = resolve(DEV_ROOT, 'build/stage_e6_primary.xdf');
  buildStageE6Image(primaryImg, primaryTargets);
  const primary = await bootAndReadText('e6_primary', new Uint8Array(readFileSync(primaryImg)), FRAMES);
  log(`primary: lines=${JSON.stringify(primary.lines.filter((l) => l.trim()))}`);
  const primaryHits = primaryTargets.map((m) => ({ ...m, hit: textAt(primary.lines, m.row, m.col, m.text) }));
  for (const h of primaryHits) log(`  N=${h.text} target=(col=${h.col},row=${h.row}) hit=${h.hit}`);
  const primaryAllHit = primaryHits.every((h) => h.hit);
  log(`RESULT: E6_PRIMARY_FOUR_POINTS_OK=${primaryAllHit}`);
  if (!primaryAllHit) fail('4箇所のうち少なくとも1箇所が指定通りに出ていない');

  // === 手順3: 陰性対照B(座標指定なし。同じ4文字列) ===
  log('--- 陰性対照B(座標指定なし) ---');
  const negativeTargets: MarkerSpec[] = primaryTargets.map((m) => ({ ...m, useLocate: false }));
  const negativeImg = resolve(DEV_ROOT, 'build/stage_e6_negative.xdf');
  buildStageE6Image(negativeImg, negativeTargets);
  const negative = await bootAndReadText('e6_negative', new Uint8Array(readFileSync(negativeImg)), FRAMES);
  log(`negative: lines=${JSON.stringify(negative.lines.filter((l) => l.trim()))}`);
  const negativeSamePositionHits = primaryTargets.filter((m) => textAt(negative.lines, m.row, m.col, m.text));
  const negativeControlOk = negativeSamePositionHits.length === 0;
  log(`RESULT: E6_NEGATIVE_CONTROL_OK=${negativeControlOk}` + (negativeSamePositionHits.length ? ` 一致してしまった箇所=${JSON.stringify(negativeSamePositionHits)}` : ''));
  if (!negativeControlOk) fail('座標指定なしでも手順2と同じ位置に出た(座標指定が効いていない疑い)');

  // === 手順4: 範囲外座標 ===
  log('--- 範囲外座標 ---');
  const outOfRangeTargets: MarkerSpec[] = [
    { col: -1, row: 5, useLocate: true, text: 'NEGCOL' },
    { col: 5, row: -1, useLocate: true, text: 'NEGROW' },
    { col: 9999, row: 5, useLocate: true, text: 'BIGCOL' },
    { col: 5, row: 9999, useLocate: true, text: 'BIGROW' },
    { col: -9999, row: -9999, useLocate: true, text: 'BOTHNEG' },
    { col: 1, row: 1, useLocate: true, text: 'RECOVER' },
  ];
  const oorImg = resolve(DEV_ROOT, 'build/stage_e6_oor.xdf');
  buildStageE6Image(oorImg, outOfRangeTargets);
  let oorSurvived = false;
  let oorRecoverHit = false;
  let oorLines: string[] = [];
  try {
    const oor = await bootAndReadText('e6_oor', new Uint8Array(readFileSync(oorImg)), FRAMES);
    oorSurvived = true;
    oorLines = oor.lines;
    oorRecoverHit = textAt(oor.lines, 1, 1, 'RECOVER');
    log(`oor: lines=${JSON.stringify(oor.lines.filter((l) => l.trim()))}`);
    for (const label of ['NEGCOL', 'NEGROW', 'BIGCOL', 'BIGROW', 'BOTHNEG']) {
      const hits = anyLineContains(oor.lines, label);
      log(`  ${label} occurrences=${JSON.stringify(hits)}`);
    }
  } catch (err) {
    log(`oor: 例外/タイムアウト = ${err instanceof Error ? err.message : String(err)}`);
  }
  log(`RESULT: E6_OOR_SURVIVED=${oorSurvived}(暴走せずタイムアウト無しで完走したか)`);
  log(`RESULT: E6_OOR_RECOVER_OK=${oorRecoverHit}(範囲外指定の直後でも次の正常な座標指定が効いたか)`);
  if (!oorSurvived) fail('範囲外座標でハング/例外が発生した(自前タイムアウトで検出)');
  else if (!oorRecoverHit) fail('範囲外座標の後、正常な座標指定(RECOVER)が効かなくなった(観測が続けられない)');

  // === 手順5: 境界値(columns-1,rows-1 と columns,rows) ===
  // 最初の実装は (columns-1, rows-1)(画面の右下隅そのもの)に1文字マーカーを
  // 置いていたが、失敗した。原因を切り分けたところ locate 自体は右下隅を
  // 正しく受け付けており(build/stage_e6_scan.xdf での単独実測で確認)、
  // main_e6.c が全マーカー処理後に必ず locate 無しで "E6 DONE" を追加印字する
  // ため、右下隅への印字直後に画面右下を埋めた状態でさらに次の文字を置こうとして
  // 自動スクロールが起き、直前に置いた文字の行がずれるだけだった(locateの
  // 失敗ではなく、印字が画面末尾に達したときの折り返し/スクロールという別の
  // 挙動が写り込んでいた)。これを避けるため、最終列(col=columns-1)の実測は
  // 安全な行で、最終行(row=rows-1)の実測は安全な列で、それぞれ単独に行う
  // (右下隅ちょうどの組み合わせは、後続の強制印字による巻き込みを排除できず
  // 未確定のまま残す)。
  log('--- 境界値 ---');
  const boundaryTargets: MarkerSpec[] = [
    { col: columns - 1, row: 5, useLocate: true, text: 'M' },   // 最終列(安全な行)
    { col: 5, row: rows - 1, useLocate: true, text: 'N' },       // 最終行(安全な列)
    { col: columns, row: 6, useLocate: true, text: 'C' },        // 列が1つ超過
    { col: 6, row: rows, useLocate: true, text: 'R' },           // 行が1つ超過
    { col: 0, row: 0, useLocate: true, text: 'K' },               // 復帰確認
  ];
  const boundaryImg = resolve(DEV_ROOT, 'build/stage_e6_boundary.xdf');
  buildStageE6Image(boundaryImg, boundaryTargets);
  let boundarySurvived = false;
  let maxColHit = false;
  let maxRowHit = false;
  let ok2Hit = false;
  let atColNHits: { row: number; col: number }[] = [];
  let atRowNHits: { row: number; col: number }[] = [];
  try {
    const boundary = await bootAndReadText('e6_boundary', new Uint8Array(readFileSync(boundaryImg)), FRAMES);
    boundarySurvived = true;
    log(`boundary: lines=${JSON.stringify(boundary.lines.filter((l) => l.trim()))}`);
    maxColHit = textAt(boundary.lines, 5, columns - 1, 'M');
    maxRowHit = textAt(boundary.lines, rows - 1, 5, 'N');
    ok2Hit = textAt(boundary.lines, 0, 0, 'K');
    atColNHits = anyLineContains(boundary.lines, 'C');
    atRowNHits = anyLineContains(boundary.lines, 'R');
    log(`  M(最終列 col=${columns - 1},row=5) hit=${maxColHit}`);
    log(`  N(最終行 col=5,row=${rows - 1}) hit=${maxRowHit}`);
    log(`  C(col=${columns}=columns,row=6) occurrences=${JSON.stringify(atColNHits)}`);
    log(`  R(col=6,row=${rows}=rows) occurrences=${JSON.stringify(atRowNHits)}`);
    log(`  K(復帰確認, col=0,row=0) hit=${ok2Hit}`);
  } catch (err) {
    log(`boundary: 例外/タイムアウト = ${err instanceof Error ? err.message : String(err)}`);
  }
  log(`RESULT: E6_BOUNDARY_SURVIVED=${boundarySurvived}`);
  log(`RESULT: E6_BOUNDARY_MAXCOL=${maxColHit}(最終列col=${columns - 1}に出たか)`);
  log(`RESULT: E6_BOUNDARY_MAXROW=${maxRowHit}(最終行row=${rows - 1}に出たか)`);
  log(`RESULT: E6_BOUNDARY_RECOVER_OK=${ok2Hit}`);
  if (!boundarySurvived) fail('境界値でハング/例外が発生した');
  else {
    if (!maxColHit) fail('最終列(columns-1)に出なかった');
    if (!maxRowHit) fail('最終行(rows-1)に出なかった');
    if (!ok2Hit) fail('境界値の後、正常な座標指定(K)が効かなくなった');
  }

  log(`RESULT: E6_COLUMNS=${columns}`);
  log(`RESULT: E6_ROWS=${rows}`);
  log(`RESULT: E6_PASS=${overallOk}`);
  if (!overallOk) process.exitCode = 1;

  console.log('---JSON---');
  console.log(JSON.stringify({
    columns,
    rows,
    emptyControlOk,
    primaryHits,
    negativeControlOk,
    negativeSamePositionHits,
    oorSurvived,
    oorRecoverHit,
    boundarySurvived,
    maxColHit,
    maxRowHit,
    ok2Hit,
    atColNHits,
    atRowNHits,
    overallOk,
  }, null, 2));
}

await main();
