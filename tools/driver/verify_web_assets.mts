import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from './builder.mts';
import type { BuildTarget, BuildToolchain } from './builder.mts';
import { MemoryHostFs, resolvePath } from './hostfs.mts';
import type { EmscriptenFactory, ToolName, ToolRunner } from './runner.mts';
import { MemfsWasmToolRunner, ToolExecutors } from './runner.mts';
import { NodeHostFs } from './node_hostfs.mts';
import { createNodeToolExecutors } from './node_runner.mts';
import { resolveNativeToolchain } from './toolchain.mts';

interface ManifestFile { path: string; size: number; sha256: string }
interface Manifest {
  version: number;
  files: ManifestFile[];
  totals: { files: number; size: number; gzipSize: number };
}
interface Expected {
  version: number;
  targets: Record<BuildTarget, { sha256: string; size: number }>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const RESULT_DIR = resolve(ROOT, 'build/web_assets_verify');
const ASSET_DIR = resolve(ROOT, 'build/web-assets');
const VIRTUAL_ROOT = '/workspace';
const TOOLCHAIN = resolve(process.env.SPROUT68K_TOOLCHAIN ?? resolve(homedir(), 'x68kdev-toolchain'));
const WASM_DIR = resolve(ROOT, 'build/wasm-tools');
const toolJs = (tool: ToolName): string => resolve(WASM_DIR, `m68k-elf-${tool}.memfs.js`);

function same(label: string, left: Uint8Array, right: Uint8Array): void {
  if (left.length !== right.length || left.some((byte, index) => byte !== right[index])) {
    const offset = left.findIndex((byte, index) => byte !== right[index]);
    throw new Error(`${label}: FAIL(バイト不一致 offset=${offset}, native=${left[offset]}, bundle=${right[offset]})`);
  }
  console.log(`${label}: PASS(${left.length} bytes バイト一致)`);
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(resolve(ASSET_DIR, 'manifest.json'), 'utf8')) as Manifest;
}

function populateAssets(manifest: Manifest, omitted?: string): MemoryHostFs {
  const hostFs = new MemoryHostFs();
  hostFs.mkdirp(VIRTUAL_ROOT);
  for (const entry of manifest.files) {
    const source = resolve(ASSET_DIR, entry.path);
    const data = readFileSync(source);
    if (data.length !== entry.size) throw new Error(`manifest size 不一致: ${entry.path}`);
    if (createHash('sha256').update(data).digest('hex') !== entry.sha256) throw new Error(`manifest SHA-256 不一致: ${entry.path}`);
    if (entry.path === omitted) continue;
    const destination = resolvePath(VIRTUAL_ROOT, entry.path);
    hostFs.mkdirp(dirname(destination));
    hostFs.writeFile(destination, data);
  }
  return hostFs;
}

function addWasmTools(hostFs: MemoryHostFs): Record<ToolName, string> {
  const modules = {} as Record<ToolName, string>;
  for (const tool of ['cc1', 'as', 'ld', 'objcopy'] as const) {
    const js = toolJs(tool);
    const wasm = js.replace(/\.js$/, '.wasm');
    if (!existsSync(js) || !existsSync(wasm)) throw new Error(`memfs wasm tool が見つかりません: ${js}`);
    // wasm tool 自体は bundle と別に取得する実行物。Node版の生成JSは wasmBinary
    // より同階層の実ファイルを優先するため、その絶対パスを明示して起動する。
    hostFs.mkdirp(dirname(js));
    hostFs.writeFile(js, new Uint8Array());
    hostFs.writeFile(wasm, readFileSync(wasm));
    modules[tool] = js;
  }
  return modules;
}

function memfsExecutors(hostFs: MemoryHostFs): ToolExecutors {
  const modules = addWasmTools(hostFs);
  const runners = {} as Record<ToolName, ToolRunner>;
  for (const tool of ['cc1', 'as', 'ld', 'objcopy'] as const) {
    const loadFactory = async (): Promise<EmscriptenFactory> => {
      const imported = await import(pathToFileURL(toolJs(tool)).href);
      return (imported.default ?? imported) as EmscriptenFactory;
    };
    runners[tool] = new MemfsWasmToolRunner({
      modulePath: modules[tool], hostFs, loadFactory, defaultCwd: VIRTUAL_ROOT,
      cc1ExecPrefix: resolvePath(VIRTUAL_ROOT, 'toolchain/lib/gcc'),
    });
  }
  return new ToolExecutors(runners);
}

function virtualToolchain(manifest: Manifest): BuildToolchain {
  const libgcc = manifest.files.find((entry) => entry.path.endsWith('/libgcc.a'));
  if (!libgcc) throw new Error('bundle に libgcc.a がありません');
  return {
    cc1: '/tools/cc1', as: '/tools/as', ld: '/tools/ld', objcopy: '/tools/objcopy',
    libgcc: resolvePath(VIRTUAL_ROOT, libgcc.path),
  };
}

async function nativeReference(target: BuildTarget, tools: BuildToolchain): Promise<Uint8Array> {
  const hostFs = new NodeHostFs();
  const output = resolve(RESULT_DIR, 'native', `${target}.xdf`);
  await build({
    target, output, root: ROOT, hostFs, tools,
    executors: createNodeToolExecutors({
      modes: { cc1: 'native', as: 'native', ld: 'native', objcopy: 'native' }, hostFs, root: ROOT,
    }),
    buildRoot: resolve(RESULT_DIR, 'native_objects'),
  });
  return readFileSync(output);
}

async function bundledBuild(target: BuildTarget, manifest: Manifest, omitted?: string): Promise<Uint8Array> {
  const hostFs = populateAssets(manifest, omitted);
  const output = resolvePath(VIRTUAL_ROOT, 'output', `${target}.xdf`);
  await build({
    target, output, root: VIRTUAL_ROOT, hostFs, tools: virtualToolchain(manifest),
    executors: memfsExecutors(hostFs), buildRoot: resolvePath(VIRTUAL_ROOT, 'objects'),
  });
  const result = hostFs.readFile(output);
  if (!omitted) writeFileSync(resolve(RESULT_DIR, 'bundle', `${target}.xdf`), result);
  return result;
}

rmSync(RESULT_DIR, { recursive: true, force: true });
mkdirSync(RESULT_DIR, { recursive: true });
mkdirSync(resolve(RESULT_DIR, 'bundle'), { recursive: true });
execFileSync(process.execPath, [resolve(ROOT, 'tools/build_web_assets.mts')], {
  cwd: ROOT, stdio: 'inherit', env: { ...process.env, SPROUT68K_TOOLCHAIN: TOOLCHAIN },
});
const manifest = loadManifest();
const expected = JSON.parse(readFileSync(resolve(ASSET_DIR, 'expected.json'), 'utf8')) as Expected;
if (expected.version !== 1) throw new Error('expected.json の版が不正です');
if (manifest.version !== 1 || manifest.files.length !== manifest.totals.files) throw new Error('manifest 構造が不正です');
const unsafeFetchPath = manifest.files.find((entry) => !extname(entry.path) || extname(entry.path) === '.');
if (unsafeFetchPath) throw new Error(`manifest にdev serverのfallback対象になり得るパスがあります: ${unsafeFetchPath.path}`);
const rawSize = manifest.files.reduce((sum, entry) => sum + entry.size, 0);
const gzipSize = manifest.files.reduce((sum, entry) => sum + gzipSync(readFileSync(resolve(ASSET_DIR, entry.path))).length, 0);
if (rawSize !== manifest.totals.size || gzipSize !== manifest.totals.gzipSize) throw new Error('manifest totals が実体と一致しません');

const previousToolchain = process.env.SPROUT68K_TOOLCHAIN;
process.env.SPROUT68K_TOOLCHAIN = TOOLCHAIN;
const nativeTools = resolveNativeToolchain();
if (previousToolchain === undefined) delete process.env.SPROUT68K_TOOLCHAIN;
else process.env.SPROUT68K_TOOLCHAIN = previousToolchain;
for (const target of ['stage_c', 'breakout'] as const) {
  const bundled = await bundledBuild(target, manifest);
  if (target === 'stage_c' && process.env.SPROUT68K_VERIFY_WEB_ASSETS_CORRUPT_XDF === '1') bundled[0] ^= 1;
  const native = await nativeReference(target, nativeTools);
  same(`${target}: bundle memfs 対 all-native`, native, bundled);
  const nativeSha256 = createHash('sha256').update(native).digest('hex');
  if (expected.targets[target]?.sha256 !== nativeSha256 || expected.targets[target]?.size !== native.length) {
    throw new Error(`${target}: expected.json が native 正典と一致しません`);
  }
  console.log(`${target}: expected.json SHA-256 PASS(${nativeSha256})`);
}

const omitted = manifest.files.find((entry) => entry.path.endsWith('/include/stdarg.h'))?.path;
if (!omitted) throw new Error('故障注入対象 stdarg.h が bundle にありません');
let faultMessage = '';
const exitCodeBeforeFault = process.exitCode;
try {
  await bundledBuild('breakout', manifest, omitted);
} catch (error) {
  faultMessage = error instanceof Error ? error.message : String(error);
} finally {
  // Emscripten の Node 用 quit_ が意図した失敗でも process.exitCode を1にする。
  // 陽性対照を捕捉した後は、検証開始前の値へ戻して最終結果と終了値を一致させる。
  process.exitCode = exitCodeBeforeFault;
}
if (!faultMessage) throw new Error(`故障注入 FAIL: ${omitted} を除外しても breakout が成功`);
console.log(`故障注入 PASS: ${omitted} を除外すると breakout が失敗 (${faultMessage.split('\n')[0]})`);

let wasmRaw = 0; let wasmGzip = 0;
for (const tool of ['cc1', 'as', 'ld', 'objcopy'] as const) {
  for (const file of [toolJs(tool), toolJs(tool).replace(/\.js$/, '.wasm')]) {
    const data = readFileSync(file); wasmRaw += data.length; wasmGzip += gzipSync(data).length;
  }
}
console.log(`bundle size: ${manifest.totals.files} files, raw=${rawSize}, gzip=${gzipSize}`);
console.log(`bundle + wasm tools: ${manifest.totals.files + 8} files, raw=${rawSize + wasmRaw}, gzip=${gzipSize + wasmGzip}`);
console.log('web assets 検証 PASS');
