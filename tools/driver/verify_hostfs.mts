import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from './builder.mts';
import type { BuildTarget } from './builder.mts';
import { MemoryHostFs, dirnamePath, resolvePath } from './hostfs.mts';
import type { HostFs } from './hostfs.mts';
import { NodeHostFs } from './node_hostfs.mts';
import { createNodeToolExecutors } from './node_runner.mts';
import type { EmscriptenFactory, ModeMap, ToolName } from './runner.mts';
import { MemfsWasmToolRunner, ToolExecutors } from './runner.mts';
import { resolveNativeToolchain } from './toolchain.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const RESULT = resolve(ROOT, 'build/hostfs_verify');
const nodeFs = new NodeHostFs();
// wasm ツールを作った基準ツールチェーンと native 比較側を揃える。
process.env.X68KDEV_TOOLCHAIN ??= resolve(homedir(), 'x68kdev-toolchain');
const tools = resolveNativeToolchain();
const prefix = resolve(process.env.X68KDEV_CC1_GCC_EXEC_PREFIX ?? resolve(process.env.X68KDEV_TOOLCHAIN ?? resolve(homedir(), 'x68kdev-toolchain'), 'lib/gcc'));
const modules: Record<ToolName, string> = {
  cc1: resolve(ROOT, 'build/wasm-tools/m68k-elf-cc1.memfs.js'),
  as: resolve(ROOT, 'build/wasm-tools/m68k-elf-as.memfs.js'),
  ld: resolve(ROOT, 'build/wasm-tools/m68k-elf-ld.memfs.js'),
  objcopy: resolve(ROOT, 'build/wasm-tools/m68k-elf-objcopy.memfs.js'),
};
const allNative: ModeMap = { cc1: 'native', as: 'native', ld: 'native', objcopy: 'native' };

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function copyTree(source: HostFs, destination: HostFs, path: string): void {
  if (source.isDirectory(path)) {
    destination.mkdirp(path);
    for (const entry of source.readdir(path)) copyTree(source, destination, resolvePath(path, entry));
  } else {
    destination.mkdirp(dirnamePath(path)); destination.writeFile(path, source.readFile(path));
  }
}

// factory のロードと入力採取は検証準備。以降の memfs ビルドは NodeHostFs を保持しない。
const factories = new Map<string, EmscriptenFactory>();
for (const modulePath of Object.values(modules)) {
  if (!nodeFs.exists(modulePath) || !nodeFs.exists(modulePath.replace(/\.js$/, '.wasm'))) throw new Error(`memfsツールが見つかりません: ${modulePath}`);
  const imported = await import(pathToFileURL(modulePath).href);
  factories.set(modulePath, (imported.default ?? imported) as EmscriptenFactory);
}

function prepareMemoryFs(): MemoryHostFs {
  const memory = new MemoryHostFs();
  for (const path of ['stage_c', 'stage_d', 'lib', 'samples/breakout'].map((path) => resolve(ROOT, path))) copyTree(nodeFs, memory, path);
  copyTree(nodeFs, memory, prefix);
  copyTree(nodeFs, memory, tools.libgcc);
  for (const modulePath of Object.values(modules)) {
    copyTree(nodeFs, memory, modulePath); copyTree(nodeFs, memory, modulePath.replace(/\.js$/, '.wasm'));
  }
  return memory;
}

function memoryExecutors(hostFs: MemoryHostFs): ToolExecutors {
  const runners = Object.fromEntries((Object.keys(modules) as ToolName[]).map((tool) => [tool, new MemfsWasmToolRunner({
    modulePath: modules[tool], hostFs, defaultCwd: ROOT, cc1ExecPrefix: prefix,
    loadFactory: async (modulePath) => {
      const factory = factories.get(modulePath); if (!factory) throw new Error(`factory未ロード: ${modulePath}`); return factory;
    },
  })])) as Record<ToolName, MemfsWasmToolRunner>;
  return new ToolExecutors(runners);
}

function inspectBssEnd(elf: string): number {
  const output = execFileSync(tools.nm, [elf], { encoding: 'utf8' });
  const match = output.match(/^([0-9a-fA-F]+)\s+\S\s+__bss_end$/m);
  if (!match) throw new Error('__bss_end が見つかりません');
  return Number.parseInt(match[1], 16);
}

nodeFs.mkdirp(RESULT);
const nativeBss = new Map<BuildTarget, number>();
for (const target of ['stage_c', 'breakout'] as const) {
  const output = resolve(RESULT, `native_${target}.xdf`);
  const buildRoot = resolve(RESULT, `native_${target}_objects`);
  await build({ target, output, root: ROOT, hostFs: nodeFs, tools,
    executors: createNodeToolExecutors({ modes: allNative, hostFs: nodeFs, root: ROOT }),
    inspectBssEnd: (elf) => { const value = inspectBssEnd(elf); nativeBss.set(target, value); return value; }, buildRoot });

  const memory = prepareMemoryFs();
  const memoryOutput = resolve(RESULT, `memory_${target}.xdf`);
  await build({ target, output: memoryOutput, root: ROOT, hostFs: memory, tools,
    executors: memoryExecutors(memory), inspectBssEnd: () => nativeBss.get(target) ?? 0,
    buildRoot: resolve(RESULT, `memory_${target}_objects`) });
  const expected = nodeFs.readFile(output); const actual = memory.readFile(memoryOutput);
  if (!same(expected, actual)) {
    const first = expected.findIndex((value, index) => value !== actual[index]);
    throw new Error(`${target}: MemoryHostFs と全nativeが不一致(offset=${first}, native=${expected[first]}, memory=${actual[first]})`);
  }
  console.log(`PASS(バイト一致): ${target} (${actual.length} bytes)`);
}

const faultFs = prepareMemoryFs();
const source = resolve(ROOT, 'stage_c/src/main.c');
const changed = faultFs.readFile(source);
const marker = new TextEncoder().encode('STAGE C OK');
let offset = -1;
for (let index = 0; index <= changed.length - marker.length; index += 1) {
  if (marker.every((value, inner) => changed[index + inner] === value)) { offset = index + marker.length - 1; break; }
}
if (offset < 0) throw new Error('故障注入位置が見つかりません');
changed[offset] ^= 1;
faultFs.writeFile(source, changed);
const faultOutput = resolve(RESULT, 'fault_stage_c.xdf');
await build({ target: 'stage_c', output: faultOutput, root: ROOT, hostFs: faultFs, tools,
  executors: memoryExecutors(faultFs), inspectBssEnd: () => 0,
  buildRoot: resolve(RESULT, 'fault_stage_c_objects') });
if (same(nodeFs.readFile(resolve(RESULT, 'native_stage_c.xdf')), faultFs.readFile(faultOutput))) throw new Error('故障注入FAIL: 1バイト変更後も一致');
console.log('PASS(陽性対照は不一致): stage_c/src/main.c を1バイト変更');
console.log('HostFs 検証 PASS');
