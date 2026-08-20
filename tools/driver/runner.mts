import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type ToolName = 'cc1' | 'as' | 'ld' | 'objcopy';
export type ToolMode = 'native' | 'wasm';

export interface ToolInvocation {
  tool: ToolName;
  program: string;
  args: readonly string[];
  cwd?: string;
}

/** 1本のツールを実行する共通抽象。native/wasm の選択はツールごとに行う。 */
export interface ToolRunner {
  readonly mode: ToolMode;
  run(invocation: ToolInvocation): void;
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
    const result = spawnSync(process.execPath, [modulePath, ...args], { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${tool}=wasm (${modulePath}) が終了コード ${result.status ?? '不明'} で失敗しました`);
    }
  }
}

export type ModeMap = Record<ToolName, ToolMode>;

export class ToolExecutors {
  private readonly runners: Record<ToolName, ToolRunner>;

  constructor(modes: ModeMap, wasmModules: Partial<Record<ToolName, string>> = {}) {
    this.runners = Object.fromEntries(
      (Object.keys(modes) as ToolName[]).map((tool) => [
        tool,
        modes[tool] === 'native'
          ? new NativeToolRunner()
          : new WasmToolRunner(wasmModules[tool]),
      ]),
    ) as Record<ToolName, ToolRunner>;
  }

  run(invocation: ToolInvocation): void {
    this.runners[invocation.tool].run(invocation);
  }
}
