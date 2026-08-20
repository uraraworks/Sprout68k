import { spawnSync } from 'node:child_process';

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
 * Emscripten 生成 .js の factory を読み込み、仮想FSを準備して main を呼ぶ実装予定地。
 * F-3 で実物の入出力規約が確定するまでは、動作したふりをせず必ず停止する。
 */
export class WasmToolRunner implements ToolRunner {
  readonly mode = 'wasm' as const;
  private readonly modulePath: string | undefined;

  constructor(modulePath: string | undefined) {
    this.modulePath = modulePath;
  }

  run({ tool }: ToolInvocation): never {
    const pathInfo = this.modulePath ? ` (指定モジュール: ${this.modulePath})` : '';
    throw new Error(
      `${tool}=wasm は未実装です${pathInfo}。Emscripten .js の factory/main と仮想FSの接続は F-3 で実装します`,
    );
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
