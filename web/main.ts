import { build } from '../tools/driver/builder.mts';
import type { BuildTarget, BuildToolchain } from '../tools/driver/builder.mts';
import { dirnamePath, MemoryHostFs, resolvePath } from '../tools/driver/hostfs.mts';
import type { EmscriptenFactory, ToolName, ToolRunner } from '../tools/driver/runner.mts';
import { MemfsWasmToolRunner, ToolExecutors } from '../tools/driver/runner.mts';

interface ManifestFile { path: string; size: number; sha256: string }
interface Manifest { version: number; files: ManifestFile[] }
interface Expected { version: number; targets: Record<BuildTarget, { sha256: string; size: number }> }
interface TargetResult { ok: boolean; sha256?: string; expected?: string; ms?: number; heapBefore?: number; heapAfter?: number; error?: string }

const ROOT = '/workspace';
const tools = ['cc1', 'as', 'ld', 'objcopy'] as const;
const resultElement = document.getElementById('result')!;
const statusElement = document.getElementById('status')!;
const targetsElement = document.getElementById('targets')!;
const faultInjection = new URLSearchParams(location.search).get('fault') === '1';
const factoryCache = new Map<string, Promise<EmscriptenFactory>>();

function heapSize(): number | undefined {
  return (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return await response.json() as T;
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// 既存のmemfs JSはNode検証と共用するCommonJS/AMD factory。内容をそのまま取得し、
// export文だけを加えたBlobをdynamic importして、生成物の再ビルドなしでWebから使う。
async function importMemfsFactory(url: string): Promise<EmscriptenFactory> {
  let cached = factoryCache.get(url);
  if (!cached) {
    cached = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      const source = await response.text();
      const blob = new Blob([source, '\nexport default Module;\n'], { type: 'text/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      try {
        const imported = await import(/* @vite-ignore */ blobUrl) as { default: EmscriptenFactory };
        if (typeof imported.default !== 'function') throw new Error(`${url}: factory export がありません`);
        return imported.default;
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    })();
    factoryCache.set(url, cached);
  }
  return cached;
}

async function populateAssets(hostFs: MemoryHostFs, manifest: Manifest): Promise<void> {
  hostFs.mkdirp(ROOT);
  for (const [index, entry] of manifest.files.entries()) {
    statusElement.textContent = `アセット読込 ${index + 1}/${manifest.files.length}: ${entry.path}`;
    const data = await fetchBytes(`/build/web-assets/${entry.path}`);
    if (data.length !== entry.size || await sha256(data) !== entry.sha256) throw new Error(`manifest 不一致: ${entry.path}`);
    const destination = resolvePath(ROOT, entry.path);
    hostFs.mkdirp(dirnamePath(destination));
    hostFs.writeFile(destination, data);
  }
}

function injectFault(hostFs: MemoryHostFs): void {
  const path = resolvePath(ROOT, 'stage_c/src/main.c');
  const data = hostFs.readFile(path);
  const marker = new TextEncoder().encode('STAGE C OK');
  let offset = -1;
  for (let index = 0; index <= data.length - marker.length; index += 1) {
    if (marker.every((byte, inner) => data[index + inner] === byte)) { offset = index + marker.length - 1; break; }
  }
  if (offset < 0) throw new Error('故障注入位置が見つかりません');
  data[offset] ^= 1;
  hostFs.writeFile(path, data);
  console.log('[fault] stage_c/src/main.c の1バイトを変更');
}

async function createExecutors(hostFs: MemoryHostFs): Promise<{ executors: ToolExecutors; toolchain: BuildToolchain }> {
  const runners = {} as Record<ToolName, ToolRunner>;
  for (const tool of tools) {
    const name = `m68k-elf-${tool}.memfs`;
    const modulePath = `/tools/${name}.js`;
    const jsUrl = `/build/wasm-tools/${name}.js`;
    const wasmUrl = new URL(`/build/wasm-tools/${name}.wasm`, location.href).href;
    const [jsMarker, wasm] = await Promise.all([fetchBytes(jsUrl), fetchBytes(wasmUrl)]);
    hostFs.mkdirp(dirnamePath(modulePath));
    hostFs.writeFile(modulePath, jsMarker);
    hostFs.writeFile(modulePath.replace(/\.js$/, '.wasm'), wasm);
    runners[tool] = new MemfsWasmToolRunner({
      modulePath, hostFs, defaultCwd: ROOT,
      cc1ExecPrefix: resolvePath(ROOT, 'toolchain/lib/gcc'),
      loadFactory: async () => importMemfsFactory(jsUrl),
      locateFile: (file) => new URL(file.endsWith('.wasm') ? wasmUrl : file, location.href).href,
    });
  }
  const libgcc = findLibgcc(hostFs);
  return {
    executors: new ToolExecutors(runners),
    toolchain: { cc1: '/tools/cc1', as: '/tools/as', ld: '/tools/ld', objcopy: '/tools/objcopy', libgcc },
  };
}

function findLibgcc(hostFs: MemoryHostFs): string {
  const walk = (path: string): string | undefined => {
    if (!hostFs.isDirectory(path)) return path.endsWith('/libgcc.a') ? path : undefined;
    for (const entry of hostFs.readdir(path)) { const found = walk(resolvePath(path, entry)); if (found) return found; }
  };
  const found = walk(resolvePath(ROOT, 'toolchain'));
  if (!found) throw new Error('bundle に libgcc.a がありません');
  return found;
}

function renderTarget(target: BuildTarget, result: TargetResult): void {
  const row = document.createElement('div');
  row.className = 'target';
  const state = result.ok ? '一致' : result.sha256 ? '不一致' : '失敗';
  row.innerHTML = `<strong>${target}</strong><span class="${result.ok ? 'pass' : 'fail'}">${state} / ${Math.round(result.ms ?? 0)} ms</span>`;
  targetsElement.append(row);
}

async function main(): Promise<void> {
  const results: Partial<Record<BuildTarget, TargetResult>> = {};
  let detected = false;
  try {
    const [manifest, expected] = await Promise.all([
      fetchJson<Manifest>('/build/web-assets/manifest.json'),
      fetchJson<Expected>('/build/web-assets/expected.json'),
    ]);
    if (manifest.version !== 1 || expected.version !== 1) throw new Error('JSONの版が不正です');
    const hostFs = new MemoryHostFs();
    await populateAssets(hostFs, manifest);
    if (faultInjection) injectFault(hostFs);
    statusElement.textContent = 'WebAssemblyツールを読み込んでいます…';
    const { executors, toolchain } = await createExecutors(hostFs);

    for (const target of ['stage_c', 'breakout'] as const) {
      console.log(`[build] ${target} 開始`);
      statusElement.textContent = `${target} をビルドしています…`;
      const started = performance.now();
      const heapBefore = heapSize();
      try {
        const output = resolvePath(ROOT, 'output', `${target}.xdf`);
        await build({ target, output, root: ROOT, hostFs, tools: toolchain, executors, buildRoot: resolvePath(ROOT, 'objects') });
        const bytes = hostFs.readFile(output);
        const actual = await sha256(bytes);
        const wanted = expected.targets[target].sha256;
        results[target] = { ok: actual === wanted, sha256: actual, expected: wanted, ms: performance.now() - started, heapBefore, heapAfter: heapSize() };
      } catch (error) {
        results[target] = { ok: false, ms: performance.now() - started, heapBefore, heapAfter: heapSize(), error: error instanceof Error ? error.message : String(error) };
      }
      renderTarget(target, results[target]!);
      console.log('[result]', target, results[target]);
    }
    detected = Boolean(faultInjection && results.stage_c?.sha256 && !results.stage_c.ok);
    const allOk = faultInjection ? detected && results.breakout?.ok === true : results.stage_c?.ok === true && results.breakout?.ok === true;
    const report = { stage_c: results.stage_c, breakout: results.breakout, faultInjection, detected, allOk };
    resultElement.textContent = JSON.stringify(report);
    statusElement.textContent = allOk ? (faultInjection ? '故障注入を正常に検出しました。' : '全ターゲットが正典と一致しました。') : '検証に失敗しました。';
    console.log('[complete]', report);
  } catch (error) {
    const report = { stage_c: results.stage_c, breakout: results.breakout, faultInjection, detected, allOk: false, error: error instanceof Error ? error.message : String(error) };
    resultElement.textContent = JSON.stringify(report);
    statusElement.textContent = '検証の初期化に失敗しました。';
    console.log('[complete]', report);
  }
}

void main();
