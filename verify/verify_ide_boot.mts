/* IDEの利用者ターゲットと同じhello.cをビルドし、IDE同梱px68kで文字表示まで実測する。 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { LibretroHost } from '../ide/px68k/libretro-host.ts';
import { build } from '../tools/driver/builder.mts';
import { NodeHostFs } from '../tools/driver/node_hostfs.mts';
import { createNodeToolExecutors } from '../tools/driver/node_runner.mts';
import { resolveNativeToolchain } from '../tools/driver/toolchain.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CORE_JS = resolve(ROOT, 'ide/core/px68k_libretro.js');
const IPL = resolve(ROOT, 'ide/system/iplrom.dat');
const CGROM = resolve(ROOT, 'ide/system/cgrom.dat');
const RESULT = resolve(ROOT, 'build/ide_boot_verify');
const EXPECTED_TEXT = 'HELLO X68000';

function loadFactory(): (options?: Record<string, unknown>) => Promise<unknown> {
  // Node直実行ではViteのdefineが無いので先に定義する。
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
  // glue側のキャッシュバスター付きwasm URLを、Nodeの実ファイルパスへ戻す。
  return (options = {}) => factory({
    ...options,
    locateFile: (path: string, scriptDirectory: string) => `${scriptDirectory}${path}`,
  });
}

async function buildHello(): Promise<Uint8Array> {
  process.env.X68KDEV_TOOLCHAIN ??= resolve(homedir(), 'x68kdev-toolchain');
  const hostFs = new NodeHostFs();
  const tools = resolveNativeToolchain();
  const executors = createNodeToolExecutors({
    modes: { cc1: 'native', as: 'native', ld: 'native', objcopy: 'native' },
    hostFs, root: ROOT,
  });
  const output = resolve(RESULT, 'hello.xdf');
  await build({
    target: 'user', output, root: ROOT, hostFs, tools, executors,
    buildRoot: resolve(RESULT, 'objects'),
    userSource: { path: 'hello.c', content: readFileSync(resolve(ROOT, 'ide/samples/hello.c')) },
  });
  return hostFs.readFile(output);
}

interface BootResult { frames: number; text: string }

async function boot(label: string, xdf: Uint8Array, maxFrames: number, stopOnExpected: boolean): Promise<BootResult> {
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
  host.setCoreOption('px68k_cpuspeed', '16Mhz');
  host.setCoreOption('px68k_ramsize', '1MB');
  host.setCoreOption('px68k_no_wait_mode', 'enabled');
  await host.init(new Uint8Array(readFileSync(IPL)), new Uint8Array(readFileSync(CGROM)));
  const diskPath = host.writeDiskImage(`${label}.xdf`, xdf);
  host.writeFile('/game/boot.cmd', new TextEncoder().encode(`px68k "${diskPath}" ""\n`));
  if (!host.loadGame('/game/boot.cmd')) throw new Error(`${label}: loadGame失敗`);
  host.fetchAvInfo();

  const started = Date.now();
  let text = '';
  let frames = 0;
  for (; frames < maxFrames; frames++) {
    host.runFrame();
    if (frames >= 800 && frames % 50 === 0) {
      const dump = host.readTextScreen();
      text = dump.available ? dump.lines.join('\n') : '';
      if (stopOnExpected && text.includes(EXPECTED_TEXT)) break;
    }
    if (Date.now() - started > 60_000) throw new Error(`${label}: 60000msタイムアウト`);
  }
  if (!text) {
    const dump = host.readTextScreen();
    text = dump.available ? dump.lines.join('\n') : '';
  }
  host.dispose();
  return { frames, text };
}

const helloXdf = await buildHello();
if (helloXdf.length !== 1_261_568) throw new Error(`hello.xdfサイズ不正: ${helloXdf.length}`);
const positive = await boot('hello', helloXdf, 3000, true);
if (!positive.text.includes(EXPECTED_TEXT)) {
  throw new Error(`期待文字列が出ません: frames=${positive.frames} text=${JSON.stringify(positive.text)}`);
}
console.log(`PASS(IDE起動): ${EXPECTED_TEXT} をテキスト画面で確認 (frames=${positive.frames})`);

const negative = await boot('zero', new Uint8Array(1_261_568), Math.max(1800, positive.frames), false);
if (negative.text.includes(EXPECTED_TEXT)) throw new Error('陰性対照に期待文字列が出ました');
console.log(`PASS(陰性対照): 全バイト0のXDFには ${EXPECTED_TEXT} が出ない (frames=${negative.frames})`);
console.log('IDE px68k 起動検証 PASS');
