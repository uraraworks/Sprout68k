import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './builder.mts';
import { rewriteBuildDiagnostic } from './diagnostics.mts';
import { NodeHostFs } from './node_hostfs.mts';
import { createNodeToolExecutors } from './node_runner.mts';
import { resolveNativeToolchain } from './toolchain.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const RESULT = resolve(ROOT, 'build/user_target_verify');
process.env.SPROUT68K_TOOLCHAIN ??= resolve(homedir(), 'x68kdev-toolchain');
const hostFs = new NodeHostFs();
const tools = resolveNativeToolchain();
const modes = { cc1: 'native', as: 'native', ld: 'native', objcopy: 'native' } as const;
const executors = createNodeToolExecutors({ modes, hostFs, root: ROOT });
const sourcePath = resolve(ROOT, 'samples/breakout/block.c');
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
const marker = Buffer.from('kPaddleWidth = 64');
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
  cc1ExecPrefix: resolve(process.env.SPROUT68K_TOOLCHAIN!, 'lib/gcc'),
  memfsModules: {
    cc1: resolve(wasmRoot, 'm68k-elf-cc1.memfs.js'),
    as: resolve(wasmRoot, 'm68k-elf-as.memfs.js'),
    ld: resolve(wasmRoot, 'm68k-elf-ld.memfs.js'),
    objcopy: resolve(wasmRoot, 'm68k-elf-objcopy.memfs.js'),
  },
  onStderr: (text) => diagnostics.push(text),
});
const exitCodeBeforeDiagnostic = process.exitCode;
let diagnosticFailure: unknown;
try {
  await build({
    target: 'user', output: resolve(RESULT, 'invalid.xdf'), root: ROOT, hostFs, tools,
    executors: memfsExecutors, buildRoot: resolve(RESULT, 'diagnostic_objects'),
    userSource: { path: 'main.c', content: 'void main(void) {\n  this is invalid;\n}\n' },
  });
  throw new Error('診断検証FAIL: 不正な C が成功しました');
} catch (error) {
  if (error instanceof Error && error.message === '診断検証FAIL: 不正な C が成功しました') throw error;
  diagnosticFailure = error;
} finally {
  process.exitCode = exitCodeBeforeDiagnostic;
}
const rawDiagnostic = diagnostics.find((line) => /main\.c:\d+:\d+: error:/.test(line));
if (!rawDiagnostic) throw new Error(`診断検証FAIL: 行・桁付き原文を捕捉できませんでした: ${diagnostics.join('\n')}`, { cause: diagnosticFailure });
const rawText = diagnostics.join('\n');
const internalSourcePath = resolve(RESULT, 'diagnostic_objects/user/source/main.c');
if (!rawText.includes(internalSourcePath)) throw new Error('診断書換検証FAIL: 本物の診断に内部ソースパスがありません');
const rewriteOptions = { workspaceRoot: ROOT, internalSourcePath, displaySourcePath: 'main.c' };
// 検査系の陽性対照用。製品コードでは無効化できない。
const rewritten = process.env.SPROUT68K_DIAGNOSTIC_REWRITE_FAULT === '1'
  ? rawText
  : rewriteBuildDiagnostic(rawText, rewriteOptions);
if (rewritten.includes(ROOT) || rewritten.includes('/workspace') || rewritten.includes('objects/user')) {
  throw new Error('診断書換検証FAIL: 内部パスが残っています');
}

const escapedSource = internalSourcePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const location = rawText.match(new RegExp(`${escapedSource}:(\\d+):(\\d+): ((?:fatal )?error: .+)`));
if (!location) throw new Error('診断書換検証FAIL: 行・桁・本文を原文から抽出できません');
if (!rewritten.includes(`main.c:${location[1]}:${location[2]}: ${location[3]}`)) {
  throw new Error('診断書換検証FAIL: 行・桁・メッセージ本文が保たれていません');
}
const rawLines = rawText.split('\n');
const rewrittenLines = rewritten.split('\n');
for (let index = 0; index < rawLines.length; index++) {
  if (rawLines[index].includes(internalSourcePath)) {
    const expected = rawLines[index].split(internalSourcePath).join('main.c');
    if (rewrittenLines[index] !== expected) {
      throw new Error(`診断書換検証FAIL: パス以外の文脈を変更しました: ${rawLines[index]}`);
    }
  }
}
const caretLine = rawLines.find((line) => /^\s*\|\s*\^~*\s*$/.test(line));
if (!caretLine || !rewrittenLines.includes(caretLine)) throw new Error('診断書換検証FAIL: キャレット行が保たれていません');
for (let index = 0; index < rawLines.length; index++) {
  if (!rawLines[index].includes(ROOT) && rawLines[index] !== rewrittenLines[index]) {
    throw new Error(`診断書換検証FAIL: 内部パスを含まない行を変更しました: ${rawLines[index]}`);
  }
}
console.log(`PASS(診断書換): 内部パス0件、行=${location[1]}、桁=${location[2]}、本文・キャレット保持`);
console.log('PASS(素通し): 内部パスを含まない診断行は全行バイト一致');

diagnostics.length = 0;
await build({
  target: 'user', output: resolve(RESULT, 'memfs_hello.xdf'), root: ROOT, hostFs, tools,
  executors: memfsExecutors, buildRoot: resolve(RESULT, 'tool_name_objects'),
  userSource: { path: 'hello.c', content: hello },
});
const linkerWarning = diagnostics.find((line) => /m68k-elf-ld: warning:/.test(line));
if (linkerWarning || diagnostics.some((line) => /LOAD segment with RWX permissions/.test(line))) {
  throw new Error(`RWX警告の限定抑制FAIL: ${diagnostics.join('\n')}`);
}
console.log('PASS(RWX警告): hello.cの実ビルド診断に0件');

diagnostics.length = 0;
await build({
  target: 'user', output: resolve(RESULT, 'warning.xdf'), root: ROOT, hostFs, tools,
  executors: memfsExecutors, buildRoot: resolve(RESULT, 'warning_objects'),
  userSource: { path: 'warning.c', content: 'void main(void) {\n  int unused = 1;\n}\n' },
});
const learnerWarning = diagnostics.find((line) => /warning\.c:\d+:\d+: warning: unused variable 'unused'/.test(line));
if (!learnerWarning || diagnostics.some((line) => /LOAD segment with RWX permissions/.test(line))) {
  throw new Error(`学習者向け警告の保持FAIL: ${diagnostics.join('\n')}`);
}
console.log(`PASS(他警告を保持): ${learnerWarning}`);
console.log('利用者ターゲット検証 PASS');
