/*
 * 共有URLの経路を端から端まで通す検証。
 *
 *   利用者の .c
 *     → 駆動層(ブラウザと同じ tools/driver/builder.mts)で共有ビルド
 *     → 共有フラグメント(#p1=... deflate-raw + base64url)にする
 *     → **フラグメントから復元**して .xdf を組み立てる（受信側と同じ share_v1.mts）
 *     → px68k で起動して画面の文字を読む
 *
 * ここまで通って初めて「共有リンクが動く」と言える。ビルドが通ることや
 * バイト一致だけでは、**受け取った人の画面に何か出る保証にならない**。
 *
 * 使い方: npx tsx verify/verify_share_boot.mts
 * 前提: 正典のツールチェーン(gcc 13.4.0)が PATH にあること。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, } from 'node:url';
import { runInThisContext } from 'node:vm';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { Builder } from '../tools/driver/builder.mts';
import { NodeHostFs } from '../tools/driver/node_hostfs.mts';
import { createNodeToolExecutors } from '../tools/driver/node_runner.mts';
import { resolveNativeToolchain } from '../tools/driver/toolchain.mts';
import { DEFAULT_DISK, assembleXdf, decodeShareFragment, encodeShareFragment,
         packUserPayload, unpackUserPayload } from '../tools/share_v1.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEBX68K = resolve(ROOT, process.env.WEBX68K_DIR ?? '../WebX68k');
const CORE_JS = resolve(WEBX68K, 'public/core/px68k_libretro.js');
const EXPECTED_TEXT = 'HELLO X68000';

function loadFactory(): any {
  (globalThis as any).__BUILD_ID__ = 'node-direct';
  const source = readFileSync(CORE_JS, 'utf8');
  const cjs: { exports: any } = { exports: {} };
  const wrapper = runInThisContext(`(function (module, exports, require, __filename, __dirname) { ${source}\n})`, { filename: CORE_JS }) as Function;
  wrapper(cjs, cjs.exports, createRequire(CORE_JS), CORE_JS, dirname(CORE_JS));
  const factory = typeof cjs.exports === 'function' ? cjs.exports : cjs.exports.default;
  return (opts?: any) => factory({ ...(opts ?? {}), locateFile: (p: string, d: string) => d + p });
}

async function bootAndReadText(xdf: Uint8Array, label: string): Promise<string> {
  const { LibretroHost } = await import(resolve(ROOT, 'ide/px68k/libretro-host.ts'));
  (globalThis as any).window = { PX68K: loadFactory() };
  const context = {
    createImageData(width: number, height: number) {
      const w = Math.max(0, width | 0); const h = Math.max(0, height | 0);
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData() {},
  };
  const canvas = { width: 0, height: 0, getContext: () => context } as any;
  const host = new LibretroHost(canvas, () => {});
  host.setCoreOption('px68k_cpuspeed', '16Mhz');
  host.setCoreOption('px68k_ramsize', '1MB');
  host.setCoreOption('px68k_no_wait_mode', 'enabled');
  await host.init(
    new Uint8Array(readFileSync(resolve(ROOT, 'ide/system/iplrom.dat'))),
    new Uint8Array(readFileSync(resolve(ROOT, 'ide/system/cgrom.dat'))),
  );
  const diskPath = host.writeDiskImage(`${label}.xdf`, xdf);
  host.writeFile('/game/boot.cmd', new TextEncoder().encode(`px68k "${diskPath}" ""\n`));
  if (!host.loadGame('/game/boot.cmd')) throw new Error(`${label}: loadGame 失敗`);
  host.fetchAvInfo();
  const started = Date.now();
  let text = '';
  for (let frames = 0; frames < 4000; frames++) {
    host.runFrame();
    if (frames >= 800 && frames % 50 === 0) {
      const dump = host.readTextScreen();
      text = dump.available ? dump.lines.join('\n') : '';
      if (text.includes(EXPECTED_TEXT)) break;
    }
    if (Date.now() - started > 120_000) throw new Error(`${label}: 120000ms タイムアウト`);
  }
  host.dispose();
  return text;
}

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (condition) console.log(`PASS: ${message}`);
  else { console.log(`FAIL: ${message}`); failures.push(message); }
}

/* --- 1. 駆動層（ブラウザと同じコード）で共有ビルド --- */
const toolchain = resolveNativeToolchain();
const gccVersion = execFileSync(`${toolchain.cc1.replace(/\/libexec\/gcc\/.*$/, '')}/bin/m68k-elf-gcc`,
  ['-dumpversion'], { encoding: 'utf8' }).trim();
check(gccVersion === '13.4.0', `正典のツールチェーンを使っている (gcc ${gccVersion})`);

const hostFs = new NodeHostFs();
const layout = { ...JSON.parse(readFileSync(resolve(ROOT, 'runtime/generated/layout_v1.json'), 'utf8')), ...DEFAULT_DISK };
const builder = new Builder({
  target: 'shared', output: resolve(ROOT, 'build/share_boot/out.xdf'), root: ROOT, hostFs,
  tools: toolchain,
  executors: createNodeToolExecutors({
    modes: { cc1: 'native', as: 'native', ld: 'native', objcopy: 'native' },
    hostFs, root: ROOT, wasmModules: {}, memfsModules: {},
  }),
  userSource: { path: 'hello.c', content: readFileSync(resolve(ROOT, 'ide/samples/hello.c'), 'utf8') },
  sharedLayout: layout,
  buildRoot: resolve(ROOT, 'build/share_boot'),
});
const built = await builder.buildShared();

/* --- 2. 共有フラグメントにして、そこから復元する --- */
const deflate = (bytes: Uint8Array) => new Uint8Array(deflateRawSync(bytes, { level: 9 }));
const inflate = (bytes: Uint8Array) => new Uint8Array(inflateRawSync(bytes));
const fragment = await encodeShareFragment('binary', packUserPayload(built.user, layout), deflate, ['ai']);
const dataLength = fragment.length - fragment.indexOf('=') - 1;
console.log(`  共有フラグメント: ${fragment.length} 文字 (利用者コード ${built.user.length} バイト)`);

const decoded = await decodeShareFragment(`#${fragment}`, inflate);
check(decoded.tags.join(',') === 'ai', 'タグが復元される');
const restored = unpackUserPayload(decoded.bytes, layout);
check(restored.length === built.user.length && restored.every((byte, index) => byte === built.user[index]),
  '復元した利用者コードがビルド結果とバイト一致する');

/* --- 3. 受信側と同じ関数で .xdf を組み立てて、実際に起動する --- */
const { image } = assembleXdf(built.boot, built.runtime, packUserPayload(restored, layout), layout);
const text = await bootAndReadText(image, 'share_boot');
check(text.includes(EXPECTED_TEXT), `復元した .xdf が起動して "${EXPECTED_TEXT}" を表示する`);
if (!text.includes(EXPECTED_TEXT)) {
  console.log(`  画面:\n${text.split('\n').filter((line) => line.trim()).slice(0, 5).join('\n')}`);
}

/* --- 4. 故障注入: ペイロードを1バイト壊したら起動しないこと ---
 * 「起動した」を主張する前に、**壊れていれば起動しない**ことを確かめる
 * （何を渡しても同じ画面が出るなら、この検査は何も見ていない）。 */
const brokenUser = new Uint8Array(restored);
brokenUser[0] ^= 0xff;
const brokenImage = assembleXdf(built.boot, built.runtime, packUserPayload(brokenUser, layout), layout).image;
const brokenText = await bootAndReadText(brokenImage, 'share_boot_fault');
check(!brokenText.includes(EXPECTED_TEXT), '故障注入: 利用者コードを1バイト壊すと表示されない');

if (failures.length > 0) {
  console.log(`\n不合格 ${failures.length} 件`);
  process.exit(1);
}
console.log('\nすべて合格');
