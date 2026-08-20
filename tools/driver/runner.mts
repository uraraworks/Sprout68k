import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type ToolName = 'cc1' | 'as' | 'ld' | 'objcopy';
export type ToolMode = 'native' | 'wasm' | 'memfs';

export interface ToolInvocation {
  tool: ToolName;
  program: string;
  args: readonly string[];
  cwd?: string;
}

/** 1本のツールを実行する共通抽象。native/wasm の選択はツールごとに行う。 */
export interface ToolRunner {
  readonly mode: ToolMode;
  run(invocation: ToolInvocation): void | Promise<void>;
}

export class NativeToolRunner implements ToolRunner {
  readonly mode = 'native' as const;

  run({ program, args, cwd }: ToolInvocation): void {
    const result = spawnSync(program, [...args], { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${program} が終了コード ${result.status ?? '不明'} で失敗しました`);
    }
  }
}

/**
 * NODERAWFS 付き Emscripten CLI を独立した Node プロセスで実行する。
 * 生成 JS は読み込み時に process.argv から main を自動実行する非 factory 型なので、
 * 1プロセス内でのモジュール再利用は行わない。
 */
export class WasmToolRunner implements ToolRunner {
  readonly mode = 'wasm' as const;
  private readonly modulePath: string | undefined;

  constructor(modulePath: string | undefined) {
    this.modulePath = modulePath;
  }

  run({ tool, args, cwd }: ToolInvocation): void {
    if (!this.modulePath) {
      throw new Error(`${tool}=wasm の Emscripten JS が指定されていません`);
    }
    const modulePath = resolve(this.modulePath);
    if (!existsSync(modulePath)) {
      throw new Error(`${tool}=wasm の Emscripten JS が見つかりません: ${modulePath}`);
    }
    const cc1ExecPrefix = process.env.X68KDEV_CC1_GCC_EXEC_PREFIX;
    const env = tool === 'cc1' && cc1ExecPrefix
      ? { ...process.env, GCC_EXEC_PREFIX: cc1ExecPrefix }
      : process.env;
    const result = spawnSync(process.execPath, [modulePath, ...args], { cwd, stdio: 'inherit', env });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${tool}=wasm (${modulePath}) が終了コード ${result.status ?? '不明'} で失敗しました`);
    }
  }
}

interface EmscriptenMemfsModule {
  FS: {
    analyzePath(path: string): { exists: boolean };
    chdir(path: string): void;
    mkdir(path: string): void;
    readFile(path: string): Uint8Array;
    writeFile(path: string, data: Uint8Array): void;
  };
  ENV?: Record<string, string>;
  callMain(args: readonly string[]): number | void;
}

type EmscriptenFactory = (options?: Record<string, unknown>) => Promise<EmscriptenMemfsModule>;

function mkdirMemfs(module: EmscriptenMemfsModule, path: string): void {
  const absolute = resolve('/', path);
  let current = '/';
  for (const part of absolute.split('/').filter(Boolean)) {
    current = resolve(current, part);
    if (!module.FS.analyzePath(current).exists) module.FS.mkdir(current);
  }
}

function copyHostInput(module: EmscriptenMemfsModule, hostPath: string): void {
  const path = resolve(hostPath);
  const stat = statSync(path);
  if (stat.isDirectory()) {
    mkdirMemfs(module, path);
    for (const entry of readdirSync(path)) copyHostInput(module, resolve(path, entry));
    return;
  }
  if (!stat.isFile()) return;
  mkdirMemfs(module, dirname(path));
  module.FS.writeFile(path, readFileSync(path));
}

function outputPaths(tool: ToolName, args: readonly string[], cwd: string): Set<string> {
  const outputs = new Set<string>();
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === '-o') outputs.add(resolve(cwd, args[index + 1]));
  }
  if (tool === 'objcopy' && args.length > 0) outputs.add(resolve(cwd, args.at(-1)!));
  return outputs;
}

/**
 * MODULARIZE + MEMFS 版を Node 上で検証する runner。
 * 引数に現れる既存ファイル/ディレクトリを同じ絶対パスで MEMFS へ複製し、-o（および
 * objcopy の最終引数）の生成物をホストへ回収する。ブラウザ UI では同じ FS 境界へ
 * File/Uint8Array を渡すが、その結線は F-4 の範囲とする。
 */
export class MemfsWasmToolRunner implements ToolRunner {
  readonly mode = 'memfs' as const;
  private readonly modulePath: string | undefined;

  constructor(modulePath: string | undefined) {
    this.modulePath = modulePath;
  }

  async run({ tool, args, cwd = process.cwd() }: ToolInvocation): Promise<void> {
    if (!this.modulePath) throw new Error(`${tool}=memfs の Emscripten factory JS が指定されていません`);
    const modulePath = resolve(this.modulePath);
    if (!existsSync(modulePath)) {
      throw new Error(`${tool}=memfs の Emscripten factory JS が見つかりません（未ビルド）: ${modulePath}`);
    }
    const wasmPath = modulePath.replace(/\.js$/, '.wasm');
    if (!existsSync(wasmPath)) {
      throw new Error(`${tool}=memfs の wasm 本体が見つかりません（未ビルド）: ${wasmPath}`);
    }

    const imported = await import(pathToFileURL(modulePath).href);
    const factory = (imported.default ?? imported) as EmscriptenFactory;
    if (typeof factory !== 'function') {
      throw new Error(`${tool}=memfs が Emscripten factory を export していません: ${modulePath}`);
    }
    const module = await factory({
      locateFile: (name: string) => name.endsWith('.wasm') ? wasmPath : resolve(dirname(modulePath), name),
    });
    if (!module.FS || typeof module.callMain !== 'function') {
      throw new Error(`${tool}=memfs に FS/callMain export がありません: ${modulePath}`);
    }

    const outputs = outputPaths(tool, args, cwd);
    mkdirMemfs(module, cwd);
    for (const arg of args) {
      const hostPath = resolve(cwd, arg);
      if (!outputs.has(hostPath) && existsSync(hostPath)) copyHostInput(module, hostPath);
    }
    const cc1ExecPrefix = process.env.X68KDEV_CC1_GCC_EXEC_PREFIX;
    if (tool === 'cc1' && cc1ExecPrefix) {
      const prefix = resolve(cc1ExecPrefix);
      if (!existsSync(prefix)) throw new Error(`cc1=memfs の GCC_EXEC_PREFIX が見つかりません: ${prefix}`);
      copyHostInput(module, prefix);
      if (!module.ENV) throw new Error(`${tool}=memfs に ENV export がありません: ${modulePath}`);
      module.ENV.GCC_EXEC_PREFIX = `${prefix}/`;
    }
    for (const output of outputs) mkdirMemfs(module, dirname(output));
    module.FS.chdir(cwd);

    try {
      const status = module.callMain(args);
      if (typeof status === 'number' && status !== 0) {
        throw new Error(`終了コード ${status}`);
      }
    } catch (error) {
      throw new Error(`${tool}=memfs (${modulePath}) の callMain が失敗しました`, { cause: error });
    }
    for (const output of outputs) {
      if (!module.FS.analyzePath(output).exists) {
        throw new Error(`${tool}=memfs が出力ファイルを生成しませんでした: ${output}`);
      }
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, module.FS.readFile(output));
    }
  }

}

export type ModeMap = Record<ToolName, ToolMode>;

export class ToolExecutors {
  private readonly runners: Record<ToolName, ToolRunner>;

  constructor(
    modes: ModeMap,
    wasmModules: Partial<Record<ToolName, string>> = {},
    memfsModules: Partial<Record<ToolName, string>> = {},
  ) {
    this.runners = Object.fromEntries(
      (Object.keys(modes) as ToolName[]).map((tool) => [
        tool,
        modes[tool] === 'native' ? new NativeToolRunner()
          : modes[tool] === 'wasm' ? new WasmToolRunner(wasmModules[tool])
            : new MemfsWasmToolRunner(memfsModules[tool]),
      ]),
    ) as Record<ToolName, ToolRunner>;
  }

  async run(invocation: ToolInvocation): Promise<void> {
    await this.runners[invocation.tool].run(invocation);
  }
}
