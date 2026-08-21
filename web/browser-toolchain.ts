import { build } from '../tools/driver/builder.mts';
import type { BuildTarget, BuildToolchain, UserSource } from '../tools/driver/builder.mts';
import { dirnamePath, MemoryHostFs, resolvePath } from '../tools/driver/hostfs.mts';
import type { EmscriptenFactory, ToolName, ToolRunner } from '../tools/driver/runner.mts';
import { MemfsWasmToolRunner, ToolExecutors } from '../tools/driver/runner.mts';

export interface ManifestFile { path: string; size: number; sha256: string }
export interface AssetManifest { version: number; files: ManifestFile[] }
export interface BrowserToolchainOptions {
  onStatus?: (message: string) => void;
  onStderr?: (text: string) => void;
}

const ROOT = '/workspace';
const TOOL_NAMES = ['cc1', 'as', 'ld', 'objcopy'] as const;
const factoryCache = new Map<string, Promise<EmscriptenFactory>>();

export async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return await response.json() as T;
}

export async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Node検証と共用する生成JSへexportだけを加え、再ビルドせずブラウザでfactoryを得る。
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

async function populateAssets(hostFs: MemoryHostFs, manifest: AssetManifest, onStatus: (message: string) => void): Promise<void> {
  hostFs.mkdirp(ROOT);
  for (const [index, entry] of manifest.files.entries()) {
    onStatus(`アセット読込 ${index + 1}/${manifest.files.length}: ${entry.path}`);
    const data = await fetchBytes(`/build/web-assets/${entry.path}`);
    if (data.length !== entry.size || await sha256(data) !== entry.sha256) throw new Error(`manifest 不一致: ${entry.path}`);
    const destination = resolvePath(ROOT, entry.path);
    hostFs.mkdirp(dirnamePath(destination));
    hostFs.writeFile(destination, data);
  }
}

function findLibgcc(hostFs: MemoryHostFs): string {
  const walk = (path: string): string | undefined => {
    if (!hostFs.isDirectory(path)) return path.endsWith('/libgcc.a') ? path : undefined;
    for (const entry of hostFs.readdir(path)) {
      const found = walk(resolvePath(path, entry));
      if (found) return found;
    }
  };
  const found = walk(resolvePath(ROOT, 'toolchain'));
  if (!found) throw new Error('bundle に libgcc.a がありません');
  return found;
}

async function createExecutors(hostFs: MemoryHostFs, onStderr?: (text: string) => void): Promise<{ executors: ToolExecutors; toolchain: BuildToolchain }> {
  const runners = {} as Record<ToolName, ToolRunner>;
  for (const tool of TOOL_NAMES) {
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
      onStderr,
    });
  }
  return {
    executors: new ToolExecutors(runners),
    toolchain: {
      cc1: '/tools/m68k-elf-cc1', as: '/tools/m68k-elf-as',
      ld: '/tools/m68k-elf-ld', objcopy: '/tools/m68k-elf-objcopy',
      libgcc: findLibgcc(hostFs),
    },
  };
}

export class BrowserToolchain {
  readonly root = ROOT;
  readonly hostFs: MemoryHostFs;
  private readonly executors: ToolExecutors;
  private readonly tools: BuildToolchain;

  constructor(hostFs: MemoryHostFs, executors: ToolExecutors, tools: BuildToolchain) {
    this.hostFs = hostFs;
    this.executors = executors;
    this.tools = tools;
  }

  async build(target: BuildTarget, output: string, userSource?: UserSource): Promise<Uint8Array> {
    await build({
      target, output, userSource, root: ROOT, hostFs: this.hostFs,
      tools: this.tools, executors: this.executors, buildRoot: resolvePath(ROOT, 'objects'),
    });
    return this.hostFs.readFile(output);
  }
}

export async function loadBrowserToolchain(options: BrowserToolchainOptions = {}): Promise<BrowserToolchain> {
  const onStatus = options.onStatus ?? (() => {});
  const manifest = await fetchJson<AssetManifest>('/build/web-assets/manifest.json');
  if (manifest.version !== 1) throw new Error('manifest の版が不正です');
  const hostFs = new MemoryHostFs();
  await populateAssets(hostFs, manifest, onStatus);
  onStatus('WebAssemblyツールを読み込んでいます…');
  const { executors, toolchain } = await createExecutors(hostFs, options.onStderr);
  return new BrowserToolchain(hostFs, executors, toolchain);
}
