import { loadBrowserToolchain } from '../web/browser-toolchain.ts';
import { rewriteBuildDiagnostic } from '../tools/driver/diagnostics.mts';
import { annotateBuildDiagnostics } from '../tools/driver/diagnostic_annotations.mts';
import { basenamePath, resolvePath } from '../tools/driver/hostfs.mts';
import { X68kRuntime } from './px68k-runtime.ts';

/**
 * X68kDev の UI とツールチェーン／エミュレータを隔離する差し替え境界。
 * build() は共有ブラウザツールチェーン、run() は同梱 px68k に接続する。
 * UI は個別ツールやエミュレータの内部状態を持たない。
 */
export function createX68kAdapter({ report, canvas }) {
  let toolchainPromise;
  let rawDiagnostics = [];
  const runtime = new X68kRuntime(canvas, report);

  const ensureToolchain = () => {
    if (!toolchainPromise) {
      toolchainPromise = loadBrowserToolchain({
        onStatus: (message) => report(message, false),
        onStderr: (text) => { rawDiagnostics.push(text); },
      }).catch((error) => {
        toolchainPromise = undefined;
        throw error;
      });
    }
    return toolchainPromise;
  };

  return {
    initialize: async () => {
      report('ビルド環境は最初のビルド時に読み込みます', false);
      return { ok: true };
    },

    build: async (source) => {
      rawDiagnostics = [];
      let diagnosticOptions;
      try {
        const toolchain = await ensureToolchain();
        diagnosticOptions = {
          workspaceRoot: toolchain.root,
          internalSourcePath: resolvePath(toolchain.root, 'objects/user/source', basenamePath(source.path)),
          displaySourcePath: source.path,
        };
        report(`${source.path} をビルドしています…`, false);
        const output = resolvePath(toolchain.root, 'output', 'user.xdf');
        const xdf = await toolchain.build('user', output, { path: source.path, content: source.text });
        if (xdf.length !== 1_261_568) throw new Error(`XDF サイズが不正です: ${xdf.length} bytes`);
        report(`ビルド完了: user.xdf (${xdf.length} bytes)`, false);
        const diagnostics = rawDiagnostics.map((text) => rewriteBuildDiagnostic(text, diagnosticOptions));
        return {
          ok: true, xdf, filename: 'user.xdf',
          diagnostics,
          annotations: annotateBuildDiagnostics(diagnostics.join('\n')).annotations,
        };
      } catch (error) {
        // 内部モード・資産パス・cause は開発者コンソールに残し、学習者UIには出さない。
        console.error('X68kDev build failure', error);
        if (rawDiagnostics.length) console.error('X68kDev raw tool diagnostics\n' + rawDiagnostics.join('\n'));
        const diagnostics = diagnosticOptions
          ? rawDiagnostics.map((text) => rewriteBuildDiagnostic(text, diagnosticOptions))
          : [];
        const message = diagnostics.some((text) => /(?:fatal )?error:/i.test(text))
          ? 'コンパイルでエラーが出ました'
          : 'ビルドに失敗しました';
        report(`ビルド失敗: ${message}`, true);
        return {
          ok: false, message, diagnostics,
          annotations: annotateBuildDiagnostics(diagnostics.join('\n')).annotations,
        };
      }
    },

    run: async ({ xdf }) => runtime.runXdf(xdf),
  };
}
