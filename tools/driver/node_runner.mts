import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolvePath } from './hostfs.mts';
import type { HostFs } from './hostfs.mts';
import { MemfsWasmToolRunner, ToolExecutors } from './runner.mts';
import type { EmscriptenFactory, ModeMap, ToolInvocation, ToolName, ToolRunner } from './runner.mts';

export class NativeToolRunner implements ToolRunner {
  readonly mode = 'native' as const;
  private readonly onStderr: ((text: string) => void) | undefined;
  /* onStderr を渡すと、ツールの stderr を親へ素通しせずここへ届ける。
   * 渡さなければ従来どおり 'inherit'（既存の検証スクリプトの見え方を変えない）。
   * コンパイル・リンクのエラー本文は診断のいちばん大事な部分なので、
   * 拾える経路を native にも用意する。 */
  constructor(onStderr?: (text: string) => void) { this.onStderr = onStderr; }
  run({ program, args, cwd }: ToolInvocation): void {
    const capture = Boolean(this.onStderr);
    const result = spawnSync(program, [...args], {
      cwd, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: capture ? 'utf8' : undefined,
    } as any);
    if (capture) {
      const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (text.trim()) this.onStderr!(text);
    }
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${program} が終了コード ${result.status ?? '不明'} で失敗しました`);
  }
}

export class WasmToolRunner implements ToolRunner {
  readonly mode = 'wasm' as const;
  private readonly modulePath: string | undefined;
  private readonly cc1ExecPrefix: string | undefined;
  constructor(modulePath: string | undefined, cc1ExecPrefix?: string) {
    this.modulePath = modulePath; this.cc1ExecPrefix = cc1ExecPrefix;
  }
  run({ tool, args, cwd }: ToolInvocation): void {
    if (!this.modulePath) throw new Error(`${tool}=wasm の Emscripten JS が指定されていません`);
    const modulePath = resolvePath(this.modulePath);
    // Node の子プロセスを起動する前に、従来どおり明確な診断を返す。
    if (!existsSync(modulePath)) {
      throw new Error(`${tool}=wasm の Emscripten JS が見つかりません: ${modulePath}`);
    }
    const env = tool === 'cc1' && this.cc1ExecPrefix
      ? { ...process.env, GCC_EXEC_PREFIX: this.cc1ExecPrefix } : process.env;
    const result = spawnSync(process.execPath, [modulePath, ...args], { cwd, stdio: 'inherit', env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${tool}=wasm (${modulePath}) が終了コード ${result.status ?? '不明'} で失敗しました`);
  }
}

export interface NodeToolExecutorOptions {
  modes: ModeMap;
  hostFs: HostFs;
  root: string;
  wasmModules?: Partial<Record<ToolName, string>>;
  memfsModules?: Partial<Record<ToolName, string>>;
  cc1ExecPrefix?: string;
  onStderr?: (text: string) => void;
}

export function createNodeToolExecutors(options: NodeToolExecutorOptions): ToolExecutors {
  const loadFactory = async (modulePath: string): Promise<EmscriptenFactory> => {
    const imported = await import(pathToFileURL(modulePath).href);
    return (imported.default ?? imported) as EmscriptenFactory;
  };
  const runners = Object.fromEntries((Object.keys(options.modes) as ToolName[]).map((tool) => [
    tool,
    options.modes[tool] === 'native' ? new NativeToolRunner(options.onStderr)
      : options.modes[tool] === 'wasm' ? new WasmToolRunner(
        options.wasmModules?.[tool] ? resolvePath(options.root, options.wasmModules[tool]!) : undefined,
        options.cc1ExecPrefix,
      )
        : new MemfsWasmToolRunner({
          modulePath: options.memfsModules?.[tool] ? resolvePath(options.root, options.memfsModules[tool]!) : undefined,
          hostFs: options.hostFs, loadFactory, defaultCwd: options.root,
          cc1ExecPrefix: options.cc1ExecPrefix ? resolvePath(options.root, options.cc1ExecPrefix) : undefined,
          onStderr: options.onStderr,
        }),
  ])) as Record<ToolName, ToolRunner>;
  return new ToolExecutors(runners);
}
