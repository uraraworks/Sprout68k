/* 実物のmemfs版cc1/ldを動かし、注釈規則の根拠となる生診断を採取する。 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './builder.mts';
import { DIAGNOSTIC_CASES, type DiagnosticCase } from './diagnostic_cases.mts';
import { NodeHostFs } from './node_hostfs.mts';
import { createNodeToolExecutors } from './node_runner.mts';
import type { ToolExecutors } from './runner.mts';
import { resolveNativeToolchain } from './toolchain.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const CASE_DIR = resolve(ROOT, 'tools/diagnostic-cases');
const RESULT = resolve(ROOT, 'build/diagnostic-annotations');
const WASM_ROOT = resolve(ROOT, 'build/wasm-tools');
process.env.X68KDEV_TOOLCHAIN ??= resolve(homedir(), 'x68kdev-toolchain');

export interface CollectedDiagnosticCase extends DiagnosticCase {
  source: string;
  diagnostics: string;
}

function createExecutors(hostFs: NodeHostFs, diagnostics: string[]): ToolExecutors {
  return createNodeToolExecutors({
    modes: { cc1: 'memfs', as: 'memfs', ld: 'memfs', objcopy: 'memfs' },
    hostFs, root: ROOT,
    cc1ExecPrefix: resolve(process.env.X68KDEV_TOOLCHAIN!, 'lib/gcc'),
    memfsModules: {
      cc1: resolve(WASM_ROOT, 'm68k-elf-cc1.memfs.js'),
      as: resolve(WASM_ROOT, 'm68k-elf-as.memfs.js'),
      ld: resolve(WASM_ROOT, 'm68k-elf-ld.memfs.js'),
      objcopy: resolve(WASM_ROOT, 'm68k-elf-objcopy.memfs.js'),
    },
    onStderr: (text) => diagnostics.push(text),
  });
}

async function runCc1(sourcePath: string, executors: ToolExecutors, hostFs: NodeHostFs): Promise<void> {
  const output = resolve(RESULT, 'cc1', `${basename(sourcePath, '.c')}.s`);
  hostFs.mkdirp(dirname(output));
  await executors.run({
    tool: 'cc1', program: resolveNativeToolchain().cc1, cwd: ROOT,
    args: [
      '-quiet', '-imultilib', 'm68000', '-I', resolve(ROOT, 'lib/include'), sourcePath,
      '-quiet', '-dumpdir', `${dirname(output)}/`, '-dumpbase', basename(sourcePath),
      '-dumpbase-ext', '.c', '-mcpu=68000', '-Os', '-Wall', '-ffreestanding',
      '-fomit-frame-pointer', '-fno-builtin', '-o', output,
    ],
  });
}

async function collectOne(testCase: DiagnosticCase): Promise<CollectedDiagnosticCase> {
  const hostFs = new NodeHostFs();
  const diagnostics: string[] = [];
  const executors = createExecutors(hostFs, diagnostics);
  const sourcePath = resolve(CASE_DIR, testCase.file);
  const source = readFileSync(sourcePath, 'utf8');
  const exitCodeBefore = process.exitCode;
  try {
    if (testCase.stage === 'cc1') {
      await runCc1(sourcePath, executors, hostFs);
    } else {
      await build({
        target: 'user', output: resolve(RESULT, `${testCase.id}.xdf`), root: ROOT,
        hostFs, tools: resolveNativeToolchain(), executors,
        buildRoot: resolve(RESULT, 'link', testCase.id),
        userSource: { path: testCase.file, content: source },
      });
    }
  } catch {
    // エラーを起こすこと自体が採取目的。診断の有無は下で検査する。
  } finally {
    process.exitCode = exitCodeBefore;
  }
  if (diagnostics.length === 0) throw new Error(`${testCase.id}: 診断を採取できませんでした`);
  return { ...testCase, source, diagnostics: diagnostics.join('\n') };
}

export async function collectDiagnostics(): Promise<CollectedDiagnosticCase[]> {
  const results: CollectedDiagnosticCase[] = [];
  for (const testCase of DIAGNOSTIC_CASES) results.push(await collectOne(testCase));
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const result of await collectDiagnostics()) {
    console.log(`\n===== ${result.id} (${result.file}, ${result.stage}) =====`);
    console.log(result.diagnostics);
  }
}
