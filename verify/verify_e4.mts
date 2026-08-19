/*
 * Stage E-4: 学習用 API の key_down(key)(押されている間ずっと真になる判定)を
 * 実装するための下地を実測する。
 *
 * ゲスト側(stage_e/src/main_e4.c, stage_e/src/e4_bitsns.S)は無限ループで
 * IOCS $04(BITSNS、解読候補)を group7(LEFT/UP/RIGHT/DOWN を含む)・group6
 * (SPACE を含む)について呼び続け、結果を固定アドレス(HOSTVAR_GROUP7=$E0040,
 * HOSTVAR_GROUP6=$E0041)へ書く。HOSTVAR_POLLS($E0044、32bitカウンタ)は
 * ループが実際に回っていることの生存確認用。
 *
 * host側(このファイル)は WebX68k の LibretroHost.setKey(retrok, down) で
 * ホスト→コアの押下状態(RETRO_DEVICE_KEYBOARD の input_state_cb)を設定し、
 * runFrame() を1回呼ぶごとに HOSTVAR を peekByte() で読む。setKey()→runFrame()
 * →peekByte() という順序は本番(main.ts のDOMイベント→アニメーションループ)と
 * 同じ「状態を変えてから次のフレームで読む」形を踏襲する。
 *
 * 【この実測が答える問い】
 *  1. 読み取り手段(レジスタ規約): IOCS $04 呼び出しで実際に押下ビットが
 *     取れるか(解読候補が実測で裏付けられるか)
 *  2. 押しっぱなし: 同じキーを N フレーム連続で押した状態にしたとき、
 *     ゲスト側がN回に近い回数「押されている」と観測できるか
 *  3. 陰性対照: 何も押していない状態でNフレーム走らせても「押されている」が
 *     観測されないか
 *  4. 離鍵: 押下→解放でゲスト側の観測が変わるか
 *  5. キーの弁別: 2種類のキー(LEFT/RIGHT)を別々に押し、別のキーとして
 *     観測できるか
 *  6. 押し直し: 解放した次のフレームで同じキーを押し直したとき、新しい押下
 *     として観測できるか(本番と同じ呼び順: setKey→runFrame→観測、を都度行う)
 *
 * 【実測で判明した配送遅延(手順2実施前は未知数だった)】
 * px68k-libretro/libretro.c の retro_run() は、WinX68k_Exec()(ゲストCPUの実行。
 * この中で Keyboard_Int() が1フレームに4回呼ばれ、KeyBuf の先頭バイトをMFP割り込み
 * として配送する)を、キーボード入力のポーリング・diff検出・Keyboard_KeyDown/Up()
 * 呼び出し(=KeyBufへの書き込み)より**前**に実行する(コード上の順序を確認済み)。
 * そのため、あるフレームの setKey()→runFrame() で変えた押下状態は、その
 * runFrame() 呼び出し内ではまだ KeyBuf に積まれるだけで配送されず、**次の
 * runFrame() 呼び出しの WinX68k_Exec() で初めて配送される**。したがって
 * ゲスト側の観測(BITSNS/HOSTVAR)は setKey() の呼び出しからちょうど1フレーム
 * 遅れる。これは最初 firstPress/releasedBeforeRepress/repressed が3回とも
 * 「1つ前の遷移の結果」を示す形で食い違ったことから発見し(手順5の最初の実装で
 * 素朴に1回ずつしか runFrame() していなかったため全滅していた)、3回連続で
 * 同じ1フレームの遅れが再現することを確認して確定させた。以下の各手順はこの
 * 実測済みの遅延(DELIVERY_LAG_FRAMES)を踏まえて runFrame() の回数を調整する。
 *
 * 使い方: npx tsx verify/verify_e4.mts
 * 環境変数: WEBX68K_DIR(既定 ../WebX68k)、MAX_FRAMES(既定 20000)
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

const HOSTVAR_GROUP7_ADDR = 0x000e0040;
const HOSTVAR_GROUP6_ADDR = 0x000e0041;
const HOSTVAR_POLLS_ADDR = 0x000e0044;

/* group7/group6 内のビット位置(解読候補: group=scancode>>3, bit=scancode&7。
 * scancode は px68k-libretro libretro.c のキーマップ表で確認済み:
 * LEFT=0x3b UP=0x3c RIGHT=0x3d DOWN=0x3e SPACE=0x35)。 */
const BIT_LEFT = 1 << (0x3b & 7); // group7 bit3
const BIT_UP = 1 << (0x3c & 7); // group7 bit4
const BIT_RIGHT = 1 << (0x3d & 7); // group7 bit5
const BIT_DOWN = 1 << (0x3e & 7); // group7 bit6
const BIT_SPACE = 1 << (0x35 & 7); // group6 bit5

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

const CORE_OPTIONS_USED = {
  px68k_cpuspeed: '16Mhz',
  px68k_ramsize: '1MB',
  // Stage E-2 で踏んだ既知の罠(未設定だとコアが実時間に自己同期し、host が
  // runFrame() を何回呼んでもゲストが進まない)への対策として必ず設定する。
  px68k_no_wait_mode: 'enabled',
};

async function buildStageE4Image(outPath: string): Promise<void> {
  execFileSync('bash', [resolve(DEV_ROOT, 'tools/build_stage_e4.sh'), outPath], { cwd: DEV_ROOT });
}

interface Session {
  host: any;
  runFrame(): void;
  peekByte(addr: number): number;
  setKey(retrok: number, down: boolean): void;
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
    host,
    runFrame() {
      host.runFrame();
    },
    peekByte(addr: number) {
      return host.peekByte(addr);
    },
    setKey(retrok: number, down: boolean) {
      host.setKey(retrok, down);
    },
    dispose() {
      host.dispose();
    },
  };
}

/* RETROK 値(WebX68k src/keyboard.ts と同じ、SDL retro_key enum 準拠)。 */
const RETROK_LEFT = 276;
const RETROK_RIGHT = 275;
const RETROK_UP = 273;
const RETROK_DOWN = 274;
const RETROK_SPACE = 32;

interface FrameSample {
  group7: number;
  group6: number;
  polls: number;
}
function sample(session: Session): FrameSample {
  return {
    group7: session.peekByte(HOSTVAR_GROUP7_ADDR),
    group6: session.peekByte(HOSTVAR_GROUP6_ADDR),
    polls: session.peekByte(HOSTVAR_POLLS_ADDR) * 0x1000000 +
      session.peekByte(HOSTVAR_POLLS_ADDR + 1) * 0x10000 +
      session.peekByte(HOSTVAR_POLLS_ADDR + 2) * 0x100 +
      session.peekByte(HOSTVAR_POLLS_ADDR + 3),
  };
}

async function main(): Promise<void> {
  console.log(`WEBX68K_DIR=${WEBX68K_DIR}`);
  console.log(`RESULT: E4_CORE_OPTIONS_SET=${JSON.stringify(CORE_OPTIONS_USED)}`);

  const MAX_FRAMES = Number(process.env.MAX_FRAMES ?? 20000);
  const imgPath = resolve(DEV_ROOT, 'build/stage_e4.xdf');
  await buildStageE4Image(imgPath);

  const session = await bootSession('e4', new Uint8Array(readFileSync(imgPath)));
  const checkDeadline = makeDeadline('boot', MAX_FRAMES);

  // === 手順0: 起動確認(HOSTVAR_POLLS が動き出すまで待つ) ===
  let bootFrames = 0;
  let s = sample(session);
  while (s.polls === 0 && bootFrames < MAX_FRAMES) {
    session.runFrame();
    bootFrames++;
    if (bootFrames % 200 === 0) checkDeadline();
    s = sample(session);
  }
  const booted = s.polls > 0;
  console.log(`RESULT: E4_BOOTED=${booted} bootFrames=${bootFrames} initialGroup7=0x${s.group7.toString(16)} initialGroup6=0x${s.group6.toString(16)}`);
  if (!booted) {
    console.log('RESULT: E4_PASS=false (ゲストが起動しなかった。以降の手順を打ち切る)');
    session.dispose();
    process.exitCode = 1;
    return;
  }

  const N = 60; // 「最低30フレーム以上押しっぱなし」の指示に対し余裕を見て60

  // === 手順0.5: 配送遅延の校正 ===
  // setKey()→runFrame() の何回後に HOSTVAR へ反映されるかを、3回独立に測って
  // 一貫した値になることを確認する(1回だけでは「たまたま」を排除できない)。
  console.log('--- 手順0.5: 配送遅延の校正(SPACEを3回押して測る) ---');
  const CALIBRATION_TRIALS = 3;
  const CALIBRATION_MAX_LAG = 10;
  const measuredLags: number[] = [];
  for (let trial = 0; trial < CALIBRATION_TRIALS; trial++) {
    session.setKey(RETROK_SPACE, true);
    let lag = -1;
    for (let i = 0; i < CALIBRATION_MAX_LAG; i++) {
      session.runFrame();
      if (sample(session).group6 & BIT_SPACE) {
        lag = i; // 0 = setKey直後のrunFrame()で即座に反映、1 = 1回余分にrunFrame()が要る、…
        break;
      }
    }
    session.setKey(RETROK_SPACE, false);
    for (let i = 0; i < CALIBRATION_MAX_LAG; i++) {
      session.runFrame();
      if (!(sample(session).group6 & BIT_SPACE)) break;
    }
    measuredLags.push(lag);
    console.log(`RESULT: E4_LAG_TRIAL trial=${trial} lag=${lag}`);
  }
  const lagConsistent = measuredLags.every((l) => l === measuredLags[0]) && measuredLags[0] >= 0;
  const DELIVERY_LAG_FRAMES = lagConsistent ? measuredLags[0] : Math.max(...measuredLags, 0);
  console.log(`RESULT: E4_DELIVERY_LAG_FRAMES=${DELIVERY_LAG_FRAMES} consistent=${lagConsistent} trials=${JSON.stringify(measuredLags)}`);

  // === 手順1: 陰性対照(何も押さない) ===
  console.log('--- 手順1: 陰性対照(何も押さない、N=60フレーム) ---');
  let negativeLeftSeen = 0;
  let negativeRightSeen = 0;
  let negativeSpaceSeen = 0;
  for (let i = 0; i < N; i++) {
    session.runFrame();
    const s1 = sample(session);
    if (s1.group7 & BIT_LEFT) negativeLeftSeen++;
    if (s1.group7 & BIT_RIGHT) negativeRightSeen++;
    if (s1.group6 & BIT_SPACE) negativeSpaceSeen++;
  }
  const negativeOk = negativeLeftSeen === 0 && negativeRightSeen === 0 && negativeSpaceSeen === 0;
  console.log(`RESULT: E4_NEGATIVE_CONTROL leftSeen=${negativeLeftSeen}/${N} rightSeen=${negativeRightSeen}/${N} spaceSeen=${negativeSpaceSeen}/${N} ok=${negativeOk}`);

  // === 手順2: 押しっぱなし(LEFT を N フレーム連続で押した状態にする) ===
  console.log('--- 手順2: 押しっぱなし(LEFTをN=60フレーム連続で押す) ---');
  session.setKey(RETROK_LEFT, true);
  let heldLeftSeen = 0;
  for (let i = 0; i < N; i++) {
    session.runFrame();
    const s2 = sample(session);
    if (s2.group7 & BIT_LEFT) heldLeftSeen++;
  }
  const HOLD_THRESHOLD = N - 5; // 割り込み配送の立ち上がり遅延を数フレーム許容する
  const heldOk = heldLeftSeen >= HOLD_THRESHOLD;
  console.log(`RESULT: E4_HOLD leftSeen=${heldLeftSeen}/${N} threshold>=${HOLD_THRESHOLD} ok=${heldOk}`);

  // === 手順3: 離鍵(LEFTを離して観測が変わるか) ===
  // 配送遅延(DELIVERY_LAG_FRAMES)ぶんは「離す前の押下状態」がまだ残っていて
  // 当然なので、遅延ぶんのフレームを除いた残りが全て0であることを条件にする
  // (「観測が変わる」ことの確認であって、遅延そのものを無かったことにする調整
  // ではない。遅延フレーム数と食い違った場合はそのまま報告する)。
  console.log('--- 手順3: 離鍵(LEFTを離す) ---');
  session.setKey(RETROK_LEFT, false);
  const releaseSamples: number[] = [];
  const RELEASE_FRAMES = 10;
  for (let i = 0; i < RELEASE_FRAMES; i++) {
    session.runFrame();
    const s3 = sample(session);
    releaseSamples.push((s3.group7 & BIT_LEFT) ? 1 : 0);
  }
  const releasedLeftSeen = releaseSamples.reduce((a, b) => a + b, 0);
  const releaseAfterLagAllClear = releaseSamples.slice(DELIVERY_LAG_FRAMES).every((v) => v === 0);
  const releaseLagMatchesMeasured = releaseSamples.slice(0, DELIVERY_LAG_FRAMES).every((v) => v === 1);
  const releaseOk = releaseAfterLagAllClear && releaseLagMatchesMeasured;
  console.log(`RESULT: E4_RELEASE leftSeenAfterRelease=${releasedLeftSeen}/${RELEASE_FRAMES} samples=${JSON.stringify(releaseSamples)} lagFrames=${DELIVERY_LAG_FRAMES} ok=${releaseOk}`);

  // === 手順4: キーの弁別(RIGHTを押し、LEFTとは別のキーとして観測できるか) ===
  console.log('--- 手順4: キーの弁別(RIGHTを押す。LEFTは押していない) ---');
  session.setKey(RETROK_RIGHT, true);
  let rightSeenWhileNotLeft = 0;
  let leftSeenWhileRightHeld = 0;
  for (let i = 0; i < N; i++) {
    session.runFrame();
    const s4 = sample(session);
    if (s4.group7 & BIT_RIGHT) rightSeenWhileNotLeft++;
    if (s4.group7 & BIT_LEFT) leftSeenWhileRightHeld++;
  }
  const distinguishOk = rightSeenWhileNotLeft >= HOLD_THRESHOLD && leftSeenWhileRightHeld === 0;
  console.log(`RESULT: E4_DISTINGUISH rightSeen=${rightSeenWhileNotLeft}/${N} leftSeenWhileRightHeld=${leftSeenWhileRightHeld}/${N} ok=${distinguishOk}`);
  session.setKey(RETROK_RIGHT, false);
  session.runFrame();

  // === 手順5: 押し直し(解放した次のフレームで同じキーを押し直す。本番と同じ呼び順) ===
  // 「解放した次のフレームで押し直す」は setKey() の呼び順としては1フレーム
  // ごとに実施する(過去に踏んだ「解放直後の押し直しがポーリングの呼び順の都合で
  // 消える」不具合を再現できるよう、部品単体でなく setKey→runFrame の本番と同じ
  // 呼び順を貫く)。観測側は手順0.5で実測した配送遅延(DELIVERY_LAG_FRAMES)ぶん
  // 追加で runFrame() してから判定する(遅延を無視すると「反映される前に見て
  // false」という別の失敗を「バグ」と誤診断してしまうため)。
  console.log('--- 手順5: 押し直し(SPACE: 押す→放す→次のフレームで押し直す) ---');
  function runFrames(k: number): void {
    for (let i = 0; i < k; i++) session.runFrame();
  }

  session.setKey(RETROK_SPACE, true);
  runFrames(1); // 「解放した次のフレームで押し直す」の1フレーム単位はここを基準にする
  runFrames(DELIVERY_LAG_FRAMES); // 配送遅延ぶんだけ観測を待つ
  const firstPressSample = sample(session);
  const firstPress = (firstPressSample.group6 & BIT_SPACE) !== 0;

  session.setKey(RETROK_SPACE, false);
  runFrames(1);
  runFrames(DELIVERY_LAG_FRAMES);
  const releasedSample = sample(session);
  const releasedBeforeRepress = (releasedSample.group6 & BIT_SPACE) === 0;

  session.setKey(RETROK_SPACE, true);
  runFrames(1);
  runFrames(DELIVERY_LAG_FRAMES);
  const repressedSample = sample(session);
  const repressed = (repressedSample.group6 & BIT_SPACE) !== 0;

  // 押し直し後、さらに数フレーム保持できているかも確認(単発の取りこぼしでないこと)
  let repressHeldSeen = 0;
  const REPRESS_HOLD_FRAMES = 10;
  for (let i = 0; i < REPRESS_HOLD_FRAMES; i++) {
    session.runFrame();
    if (sample(session).group6 & BIT_SPACE) repressHeldSeen++;
  }
  session.setKey(RETROK_SPACE, false);

  const repressOk = firstPress && releasedBeforeRepress && repressed && repressHeldSeen >= REPRESS_HOLD_FRAMES - 2;
  console.log(`RESULT: E4_REPRESS firstPress=${firstPress} releasedBeforeRepress=${releasedBeforeRepress} repressed=${repressed} repressHeldSeen=${repressHeldSeen}/${REPRESS_HOLD_FRAMES} ok=${repressOk} lagFramesUsed=${DELIVERY_LAG_FRAMES}`);

  session.dispose();

  const overallOk = booted && lagConsistent && negativeOk && heldOk && releaseOk && distinguishOk && repressOk;
  console.log(`RESULT: E4_PASS=${overallOk}`);
  if (!overallOk) process.exitCode = 1;

  console.log('---JSON---');
  console.log(JSON.stringify({
    coreOptionsSet: CORE_OPTIONS_USED,
    booted,
    bootFrames,
    deliveryLag: { measuredLags, DELIVERY_LAG_FRAMES, consistent: lagConsistent },
    negative: { leftSeen: negativeLeftSeen, rightSeen: negativeRightSeen, spaceSeen: negativeSpaceSeen, N, ok: negativeOk },
    hold: { leftSeen: heldLeftSeen, N, threshold: HOLD_THRESHOLD, ok: heldOk },
    release: { leftSeenAfterRelease: releasedLeftSeen, samples: releaseSamples, frames: RELEASE_FRAMES, lagFrames: DELIVERY_LAG_FRAMES, ok: releaseOk },
    distinguish: { rightSeen: rightSeenWhileNotLeft, leftSeenWhileRightHeld, N, ok: distinguishOk },
    repress: { firstPress, releasedBeforeRepress, repressed, repressHeldSeen, REPRESS_HOLD_FRAMES, lagFramesUsed: DELIVERY_LAG_FRAMES, ok: repressOk },
    overallOk,
  }, null, 2));
}

await main();
