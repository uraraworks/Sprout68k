import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './builder.mts';
import { NodeHostFs } from './node_hostfs.mts';
import { createNodeToolExecutors } from './node_runner.mts';
import { resolveNativeToolchain } from './toolchain.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const RESULT = resolve(ROOT, 'build/user_target_verify');
process.env.X68KDEV_TOOLCHAIN ??= resolve(homedir(), 'x68kdev-toolchain');
const hostFs = new NodeHostFs();
const tools = resolveNativeToolchain();
const modes = { cc1: 'native', as: 'native', ld: 'native', objcopy: 'native' } as const;
const executors = createNodeToolExecutors({ modes, hostFs, root: ROOT });
const sourcePath = resolve(ROOT, 'samples/breakout/main.c');
const source = readFileSync(sourcePath);

async function buildTarget(target: 'breakout' | 'user', output: string, content = source): Promise<Uint8Array> {
  await build({
    target, output, root: ROOT, hostFs, tools, executors,
    buildRoot: resolve(RESULT, 'objects'),
    userSource: target === 'user' ? { path: 'main.c', content } : undefined,
  });
  return hostFs.readFile(output);
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

const reference = await buildTarget('breakout', resolve(RESULT, 'breakout.xdf'));
const user = await buildTarget('user', resolve(RESULT, 'user.xdf'));
if (!same(reference, user)) throw new Error('利用者ターゲットと breakout ターゲットが不一致です');
console.log(`PASS(バイト一致): user(main.c同一内容) 対 breakout (${user.length} bytes)`);

const changed = Buffer.from(source);
const marker = Buffer.from('#define PADDLE_W 64');
const offset = changed.indexOf(marker);
if (offset < 0) throw new Error('故障注入位置が見つかりません');
changed[offset + marker.length - 1] = '5'.charCodeAt(0);
const fault = await buildTarget('user', resolve(RESULT, 'user_fault.xdf'), changed);
if (same(reference, fault)) throw new Error('故障注入FAIL: ソース1バイト変更を検出できませんでした');
console.log('PASS(故障注入): 利用者ソースを1バイト変更すると breakout 正典と不一致');

const hello = readFileSync(resolve(ROOT, 'ide/samples/hello.c'));
const helloXdf = await buildTarget('user', resolve(RESULT, 'hello.xdf'), hello);
if (helloXdf.length !== 1_261_568) throw new Error(`IDE サンプルの XDF サイズが不正です: ${helloXdf.length}`);
console.log(`PASS(IDEサンプル): hello.c (${helloXdf.length} bytes)`);

const diagnostics: string[] = [];
const wasmRoot = resolve(ROOT, 'build/wasm-tools');
const memfsExecutors = createNodeToolExecutors({
  modes: { cc1: 'memfs', as: 'memfs', ld: 'memfs', objcopy: 'memfs' },
  hostFs, root: ROOT,
  cc1ExecPrefix: resolve(process.env.X68KDEV_TOOLCHAIN!, 'lib/gcc'),
  memfsModules: {
    cc1: resolve(wasmRoot, 'm68k-elf-cc1.memfs.js'),
    as: resolve(wasmRoot, 'm68k-elf-as.memfs.js'),
    ld: resolve(wasmRoot, 'm68k-elf-ld.memfs.js'),
    objcopy: resolve(wasmRoot, 'm68k-elf-objcopy.memfs.js'),
  },
  onStderr: (text) => diagnostics.push(text),
});
const exitCodeBeforeDiagnostic = process.exitCode;
try {
  await build({
    target: 'user', output: resolve(RESULT, 'invalid.xdf'), root: ROOT, hostFs, tools,
    executors: memfsExecutors, buildRoot: resolve(RESULT, 'diagnostic_objects'),
    userSource: { path: 'main.c', content: 'void main(void) {\n  this is invalid;\n}\n' },
  });
  throw new Error('診断検証FAIL: 不正な C が成功しました');
} catch (error) {
  if (error instanceof Error && error.message === '診断検証FAIL: 不正な C が成功しました') throw error;
} finally {
  process.exitCode = exitCodeBeforeDiagnostic;
}
const rawDiagnostic = diagnostics.find((line) => /main\.c:\d+:\d+: error:/.test(line));
if (!rawDiagnostic) throw new Error(`診断検証FAIL: 行・桁付き原文を捕捉できませんでした: ${diagnostics.join('\n')}`);
console.log(`PASS(診断捕捉): ${rawDiagnostic}`);
console.log('利用者ターゲット検証 PASS');
