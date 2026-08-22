/* DOMと同じRETROK経路を通し、ゲストCプログラムのTVRAM出力で入力を検証する。 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import {
  RETROK, X68K_KEYS_WITHOUT_HOST_CODE, CODE_TO_RETROK, keyboardEventToRetrok,
} from '../ide/px68k/keyboard.ts';
import { LibretroHost } from '../ide/px68k/libretro-host.ts';
import { build } from '../tools/driver/builder.mts';
import { NodeHostFs } from '../tools/driver/node_hostfs.mts';
import { createNodeToolExecutors } from '../tools/driver/node_runner.mts';
import { resolveNativeToolchain } from '../tools/driver/toolchain.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CORE_JS = resolve(ROOT, 'ide/core/px68k_libretro.js');
const RESULT = resolve(ROOT, 'build/ide_keyboard_verify');

const keyFallbackCases = [
  ['ArrowLeft', RETROK.LEFT], ['ArrowUp', RETROK.UP], ['ArrowRight', RETROK.RIGHT],
  ['ArrowDown', RETROK.DOWN], [' ', RETROK.SPACE], ['Enter', RETROK.RETURN],
  ['Escape', RETROK.ESCAPE], ['A', RETROK.a], ['7', RETROK[7]],
] as const;
for (const [key, expected] of keyFallbackCases) {
  if (keyboardEventToRetrok({ code: '', key }) !== expected) {
    throw new Error(`KeyboardEvent.keyフォールバック不一致: ${JSON.stringify(key)}`);
  }
}
console.log(`PASS(event.keyフォールバック): code空でも${keyFallbackCases.length}種類を解決`);

function loadFactory(): (options?: Record<string, unknown>) => Promise<any> {
  (globalThis as Record<string, unknown>).__BUILD_ID__ = 'node-direct';
  const source = readFileSync(CORE_JS, 'utf8');
  const cjs: { exports: any } = { exports: {} };
  const wrapper = runInThisContext(
    `(function (module, exports, require, __filename, __dirname) { ${source}\n})`,
    { filename: CORE_JS },
  ) as Function;
  wrapper(cjs, cjs.exports, createRequire(CORE_JS), CORE_JS, dirname(CORE_JS));
  const factory = typeof cjs.exports === 'function' ? cjs.exports : cjs.exports.default;
  if (typeof factory !== 'function') throw new Error('px68k factoryを取得できません');
  return (options = {}) => factory({
    ...options,
    locateFile: (path: string, scriptDirectory: string) => `${scriptDirectory}${path}`,
  });
}

async function buildProbe(): Promise<Uint8Array> {
  process.env.SPROUT68K_TOOLCHAIN ??= resolve(homedir(), 'x68kdev-toolchain');
  const hostFs = new NodeHostFs();
  const executors = createNodeToolExecutors({
    modes: { cc1: 'native', as: 'native', ld: 'native', objcopy: 'native' }, hostFs, root: ROOT,
  });
  const output = resolve(RESULT, 'keyboard_probe.xdf');
  await build({
    target: 'user', output, root: ROOT, hostFs, tools: resolveNativeToolchain(), executors,
    buildRoot: resolve(RESULT, 'objects'),
    userSource: {
      path: 'keyboard-input.c', content: readFileSync(resolve(ROOT, 'ide/samples/keyboard-input.c'), 'utf8'),
    },
  });
  return hostFs.readFile(output);
}

function count(text: string, token: string): number {
  return text.split(token).length - 1;
}

const context = {
  createImageData(width: number, height: number) {
    const w = Math.max(0, width | 0);
    const h = Math.max(0, height | 0);
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  },
  putImageData() {}, clearRect() {},
};
(globalThis as any).window = { PX68K: loadFactory() };
const canvas = { width: 0, height: 0, getContext: () => context } as any;
const host = new LibretroHost(canvas, () => {});
host.setCoreOption('px68k_cpuspeed', '16Mhz');
host.setCoreOption('px68k_ramsize', '1MB');
host.setCoreOption('px68k_no_wait_mode', 'enabled');
await host.init(
  new Uint8Array(readFileSync(resolve(ROOT, 'ide/system/iplrom.dat'))),
  new Uint8Array(readFileSync(resolve(ROOT, 'ide/system/cgrom.dat'))),
);
const xdf = await buildProbe();
const diskPath = host.writeDiskImage('keyboard_probe.xdf', xdf);
host.writeFile('/game/boot.cmd', new TextEncoder().encode(`px68k "${diskPath}" ""\n`));
if (!host.loadGame('/game/boot.cmd')) throw new Error('loadGame失敗');
host.fetchAvInfo();

function textScreen(): string {
  const dump = host.readTextScreen();
  return dump.available ? dump.lines.join('\n') : '';
}

function runUntil(predicate: () => boolean, maxFrames = 500): number {
  for (let frame = 1; frame <= maxFrames; frame++) {
    host.runFrame();
    if (predicate()) return frame;
  }
  throw new Error(`ゲスト画面が期限内に変化しません: ${JSON.stringify(textScreen())}`);
}

runUntil(() => textScreen().includes('[READY]'), 3000);
const cases = [
  { name: 'LEFT', retrok: RETROK.LEFT },
  { name: 'UP', retrok: RETROK.UP },
  { name: 'RIGHT', retrok: RETROK.RIGHT },
  { name: 'DOWN', retrok: RETROK.DOWN },
  { name: 'SPACE', retrok: RETROK.SPACE },
  { name: 'ENTER', retrok: RETROK.RETURN },
  { name: 'ESC', retrok: RETROK.ESCAPE },
  { name: 'A', retrok: RETROK.a },
  { name: '1', retrok: RETROK[1] },
];
for (const testCase of cases) {
  const token = `[${testCase.name}]`;
  const before = count(textScreen(), token);
  host.setKey(testCase.retrok, true);
  runUntil(() => count(textScreen(), token) === before + 1);
  const releaseBefore = count(textScreen(), '[REL]');
  host.setKey(testCase.retrok, false);
  runUntil(() => count(textScreen(), '[REL]') === releaseBefore + 1);
  console.log(`PASS(ゲスト画面): ${testCase.name} -> ${token}, release -> [REL]`);
}

// releaseを1フレーム配送した直後に同じキーを再押下しても、押下が消えないことを確認する。
const leftBefore = count(textScreen(), '[LEFT]');
host.setKey(RETROK.LEFT, true);
runUntil(() => count(textScreen(), '[LEFT]') === leftBefore + 1);
const relBefore = count(textScreen(), '[REL]');
host.setKey(RETROK.LEFT, false);
host.runFrame();
host.setKey(RETROK.LEFT, true);
runUntil(() => count(textScreen(), '[REL]') === relBefore + 1 && count(textScreen(), '[LEFT]') === leftBefore + 2);
host.setKey(RETROK.LEFT, false);
runUntil(() => count(textScreen(), '[REL]') === relBefore + 2);
console.log('PASS(押下・解放): releaseを1フレーム配送後の再押下と再解放をゲスト画面で確認');

// 短押下の境界: retro_runを挟まない0フレーム押下は見えず、1フレームなら見える。
const zeroFrameABefore = count(textScreen(), '[A]');
host.setKey(RETROK.a, true);
host.setKey(RETROK.a, false);
for (let frame = 0; frame < 60; frame++) host.runFrame();
if (count(textScreen(), '[A]') !== zeroFrameABefore) throw new Error('0フレーム押下がゲストに残りました');

const oneFrameABefore = count(textScreen(), '[A]');
const oneFrameRelBefore = count(textScreen(), '[REL]');
host.setKey(RETROK.a, true);
host.runFrame();
host.setKey(RETROK.a, false);
runUntil(() => count(textScreen(), '[A]') === oneFrameABefore + 1
  && count(textScreen(), '[REL]') === oneFrameRelBefore + 1);
console.log('PASS(短押下境界): 0フレームは未検出、1フレームはゲスト画面で検出');

// 押している限りはラッチ時間で切れず、少なくとも120フレーム状態が維持される。
const heldOneBefore = count(textScreen(), '[1]');
const heldRelBefore = count(textScreen(), '[REL]');
host.setKey(RETROK[1], true);
runUntil(() => count(textScreen(), '[1]') === heldOneBefore + 1);
for (let frame = 0; frame < 120; frame++) host.runFrame();
if (count(textScreen(), '[REL]') !== heldRelBefore) throw new Error('押下中にゲストが解放を検出しました');
host.setKey(RETROK[1], false);
runUntil(() => count(textScreen(), '[REL]') === heldRelBefore + 1);
console.log('PASS(保持時間): keyupまで少なくとも120フレーム押下を維持');

// 陽性対照: ENTERを期待する場面でAを送ると、Aだけが出てENTER条件は失敗する。
const enterBefore = count(textScreen(), '[ENTER]');
const faultABefore = count(textScreen(), '[A]');
host.setKey(RETROK.a, true);
runUntil(() => count(textScreen(), '[A]') === faultABefore + 1);
host.setKey(RETROK.a, false);
const faultRelBefore = count(textScreen(), '[REL]');
runUntil(() => count(textScreen(), '[REL]') === faultRelBefore + 1);
let faultDetected = false;
try {
  runUntil(() => count(textScreen(), '[ENTER]') === enterBefore + 1, 60);
} catch {
  faultDetected = true;
}
if (!faultDetected) throw new Error('違うキーを送る故障注入が画面検査を通過しました');
console.log('PASS(故障注入): ENTERの代わりにAを送るとゲスト画面条件が不成立');

const hostCodes = new Set(Object.values(CODE_TO_RETROK));
const incorrectlyListed = X68K_KEYS_WITHOUT_HOST_CODE.filter((key) => hostCodes.has(key.retrok));
if (incorrectlyListed.length) throw new Error(`未到達キー一覧に到達可能キーがあります: ${incorrectlyListed.map((key) => key.label)}`);
console.log(`PASS(未到達キー棚卸し): ${X68K_KEYS_WITHOUT_HOST_CODE.length}キー`);
host.dispose();
console.log('IDE キーボード入力検証 PASS');
