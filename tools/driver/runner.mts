import { dirnamePath, resolvePath } from './hostfs.mts';
import type { HostFs } from './hostfs.mts';

export type ToolName = 'cc1' | 'as' | 'ld' | 'objcopy';
export type ToolMode = 'native' | 'wasm' | 'memfs';
export type ModeMap = Record<ToolName, ToolMode>;

export interface ToolInvocation {
  tool: ToolName;
  program: string;
  args: readonly string[];
  cwd?: string;
}

export interface ToolRunner {
  readonly mode: ToolMode;
  run(invocation: ToolInvocation): void | Promise<void>;
}

export interface EmscriptenMemfsModule {
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

export type EmscriptenFactory = (options?: Record<string, unknown>) => Promise<EmscriptenMemfsModule>;
export type MemfsFactoryLoader = (modulePath: string) => Promise<EmscriptenFactory>;

function mkdirMemfs(module: EmscriptenMemfsModule, path: string): void {
  let current = '/';
  for (const part of resolvePath(path).split('/').filter(Boolean)) {
    current = resolvePath(current, part);
    if (!module.FS.analyzePath(current).exists) module.FS.mkdir(current);
  }
}

function copyHostInput(module: EmscriptenMemfsModule, hostFs: HostFs, hostPath: string): void {
  const path = resolvePath(hostPath);
  if (hostFs.isDirectory(path)) {
    mkdirMemfs(module, path);
    for (const entry of hostFs.readdir(path)) copyHostInput(module, hostFs, resolvePath(path, entry));
    return;
  }
  mkdirMemfs(module, dirnamePath(path));
  module.FS.writeFile(path, hostFs.readFile(path));
}

function outputPaths(tool: ToolName, args: readonly string[], cwd: string): Set<string> {
  const outputs = new Set<string>();
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === '-o') outputs.add(resolvePath(cwd, args[index + 1]));
    if (tool === 'ld' && args[index] === '-Map') outputs.add(resolvePath(cwd, args[index + 1]));
  }
  if (tool === 'objcopy' && args.length > 0) outputs.add(resolvePath(cwd, args.at(-1)!));
  return outputs;
}

export interface MemfsRunnerOptions {
  modulePath?: string;
  hostFs: HostFs;
  loadFactory: MemfsFactoryLoader;
  defaultCwd: string;
  cc1ExecPrefix?: string;
  /** Emscripten が補助ファイルを探す場合の場所。ブラウザでは絶対 URL を返す。 */
  locateFile?: (name: string, modulePath: string) => string;
}

/** MODULARIZE + MEMFS 版を HostFs 上の入出力で実行する。 */
export class MemfsWasmToolRunner implements ToolRunner {
  readonly mode = 'memfs' as const;
  private readonly options: MemfsRunnerOptions;

  constructor(options: MemfsRunnerOptions) { this.options = options; }

  async run({ tool, args, cwd = this.options.defaultCwd }: ToolInvocation): Promise<void> {
    const { modulePath, hostFs, loadFactory } = this.options;
    if (!modulePath) throw new Error(`${tool}=memfs の Emscripten factory JS が指定されていません`);
    const absoluteModulePath = resolvePath(modulePath);
    if (!hostFs.exists(absoluteModulePath)) {
      throw new Error(`${tool}=memfs の Emscripten factory JS が見つかりません（未ビルド）: ${absoluteModulePath}`);
    }
    const wasmPath = absoluteModulePath.replace(/\.js$/, '.wasm');
    if (!hostFs.exists(wasmPath)) throw new Error(`${tool}=memfs の wasm 本体が見つかりません（未ビルド）: ${wasmPath}`);
    const outputs = outputPaths(tool, args, cwd);
    const prefix = tool === 'cc1' && this.options.cc1ExecPrefix
      ? resolvePath(this.options.cc1ExecPrefix) : undefined;
    if (prefix && !hostFs.exists(prefix)) throw new Error(`cc1=memfs の GCC_EXEC_PREFIX が見つかりません: ${prefix}`);

    const factory = await loadFactory(absoluteModulePath);
    if (typeof factory !== 'function') throw new Error(`${tool}=memfs が Emscripten factory を export していません: ${absoluteModulePath}`);
    const module = await factory({
      // ブラウザでも Emscripten 自身にホストファイルを読ませない。
      wasmBinary: hostFs.readFile(wasmPath),
      locateFile: (name: string) => this.options.locateFile
        ? this.options.locateFile(name, absoluteModulePath)
        : (name.endsWith('.wasm') ? wasmPath : resolvePath(dirnamePath(absoluteModulePath), name)),
      preRun: [(preRunModule: EmscriptenMemfsModule) => {
        if (!preRunModule.FS) throw new Error(`${tool}=memfs の preRun に FS export がありません: ${absoluteModulePath}`);
        mkdirMemfs(preRunModule, cwd);
        for (const arg of args) {
          const hostPath = resolvePath(cwd, arg);
          if (!outputs.has(hostPath) && hostFs.exists(hostPath)) copyHostInput(preRunModule, hostFs, hostPath);
        }
        if (prefix) {
          copyHostInput(preRunModule, hostFs, prefix);
          if (!preRunModule.ENV) throw new Error(`${tool}=memfs の preRun に ENV export がありません: ${absoluteModulePath}`);
          preRunModule.ENV.GCC_EXEC_PREFIX = `${prefix}/`;
        }
        for (const output of outputs) mkdirMemfs(preRunModule, dirnamePath(output));
        preRunModule.FS.chdir(cwd);
      }],
    });
    if (!module.FS || typeof module.callMain !== 'function') throw new Error(`${tool}=memfs に FS/callMain export がありません: ${absoluteModulePath}`);
    try {
      const status = module.callMain(args);
      if (typeof status === 'number' && status !== 0) throw new Error(`終了コード ${status}`);
    } catch (error) {
      throw new Error(`${tool}=memfs (${absoluteModulePath}) の callMain が失敗しました`, { cause: error });
    }
    for (const output of outputs) {
      if (!module.FS.analyzePath(output).exists) throw new Error(`${tool}=memfs が出力ファイルを生成しませんでした: ${output}`);
      hostFs.mkdirp(dirnamePath(output));
      hostFs.writeFile(output, module.FS.readFile(output));
    }
  }
}

export class ToolExecutors {
  private readonly runners: Record<ToolName, ToolRunner>;
  constructor(runners: Record<ToolName, ToolRunner>) { this.runners = runners; }
  async run(invocation: ToolInvocation): Promise<void> { await this.runners[invocation.tool].run(invocation); }
}
