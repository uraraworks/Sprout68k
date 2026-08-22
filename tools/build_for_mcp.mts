/* MCP サーバーから使うビルド入口。
 *
 * ネイティブのツールチェーンで直接ビルドする（ブラウザの wasm 経路より
 * 25倍以上速い。実測 0.07秒 / 1.93秒）。**版が正典でなければ失敗させる**
 * （別のGCCで黙って通ると、出るバイナリが変わる）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder } from './driver/builder.mts';
import { NodeHostFs } from './driver/node_hostfs.mts';
import { createNodeToolExecutors } from './driver/node_runner.mts';
import { resolveNativeToolchain } from './driver/toolchain.mts';
import { rewriteBuildDiagnostic } from './driver/diagnostics.mts';
import { annotateBuildDiagnostics } from './driver/diagnostic_annotations.mts';
import { DEFAULT_DISK, assembleXdf, packUserPayload } from './share_v1.mts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CANONICAL_GCC_VERSION = '13.4.0';

export interface BuildOutcome {
  ok: boolean;
  /** 日本語の注釈を付けた診断（コンパイルエラー・警告）。 */
  diagnostics: string[];
  annotations: { message: string; hint?: string }[];
  /** 起動できる .xdf（共有方式なのでランタイム込み）。 */
  xdf?: Uint8Array;
  /** URLに載る利用者コード（ヘッダ込み）。 */
  payload?: Uint8Array;
  userSize?: number;
}

export function checkToolchain(): string {
  const toolchain = resolveNativeToolchain();
  const gcc = `${toolchain.cc1.replace(/\/libexec\/gcc\/.*$/, '')}/bin/m68k-elf-gcc`;
  const version = execFileSync(gcc, ['-dumpversion'], { encoding: 'utf8' }).trim();
  if (version !== CANONICAL_GCC_VERSION) {
    throw new Error(
      `ツールチェーンの版が違います (gcc ${version}、期待 ${CANONICAL_GCC_VERSION})。`
      + ` PATH に ~/x68kdev-toolchain/bin を通してください。`,
    );
  }
  return version;
}

/** 共有ランタイム方式でビルドする。診断は日本語注釈つきで返す。 */
export async function buildSource(source: string, options: { root?: string; path?: string } = {}): Promise<BuildOutcome> {
  const root = options.root ?? ROOT;
  const path = options.path ?? 'main.c';
  checkToolchain();
  const hostFs = new NodeHostFs();
  const stderr: string[] = [];
  const layout = { ...JSON.parse(readFileSync(resolve(root, 'runtime/generated/layout_v1.json'), 'utf8')), ...DEFAULT_DISK };
  const buildRoot = resolve(root, 'build/mcp');
  const builder = new Builder({
    target: 'shared', output: resolve(buildRoot, 'out.xdf'), root, hostFs,
    tools: resolveNativeToolchain(),
    executors: createNodeToolExecutors({
      modes: { cc1: 'native', as: 'native', ld: 'native', objcopy: 'native' },
      hostFs, root, wasmModules: {}, memfsModules: {},
      onStderr: (text: string) => { stderr.push(text); },
    } as any),
    userSource: { path, content: source },
    sharedLayout: layout,
    buildRoot,
  });

  const diagnosticOptions = {
    workspaceRoot: root,
    internalSourcePath: resolve(buildRoot, 'shared/source', path),
    displaySourcePath: path,
  };
  const dress = () => {
    const diagnostics = stderr.map((text) => rewriteBuildDiagnostic(text, diagnosticOptions));
    return { diagnostics, annotations: annotateBuildDiagnostics(diagnostics.join('\n')).annotations };
  };

  try {
    const built = await builder.buildShared();
    const payload = packUserPayload(built.user, layout);
    const { image } = assembleXdf(built.boot, built.runtime, payload, layout);
    return { ok: true, ...dress(), xdf: image, payload, userSize: built.user.length };
  } catch (error) {
    const dressed = dress();
    if (dressed.diagnostics.length === 0) dressed.diagnostics.push(String((error as Error).message));
    return { ok: false, ...dressed };
  }
}
