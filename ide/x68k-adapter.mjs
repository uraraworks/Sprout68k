import { loadBrowserToolchain } from '../web/browser-toolchain.ts';
import { resolvePath } from '../tools/driver/hostfs.mts';
import { X68kRuntime } from './px68k-runtime.ts';

/**
 * X68kDev の UI とツールチェーン／エミュレータを隔離する差し替え境界。
 * build() は共有ブラウザツールチェーン、run() は同梱 px68k に接続する。
 * UI は個別ツールやエミュレータの内部状態を持たない。
 */
export function createX68kAdapter({ report, canvas }) {
  let toolchainPromise;
  let diagnostics = [];
  const runtime = new X68kRuntime(canvas, report);

  const ensureToolchain = () => {
    if (!toolchainPromise) {
      toolchainPromise = loadBrowserToolchain({
        onStatus: (message) => report(message, false),
        onStderr: (text) => { diagnostics.push(text); },
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
      diagnostics = [];
      try {
        const toolchain = await ensureToolchain();
        report(`${source.path} をビルドしています…`, false);
        const output = resolvePath(toolchain.root, 'output', 'user.xdf');
        const xdf = await toolchain.build('user', output, { path: source.path, content: source.text });
        if (xdf.length !== 1_261_568) throw new Error(`XDF サイズが不正です: ${xdf.length} bytes`);
        report(`ビルド完了: user.xdf (${xdf.length} bytes)`, false);
        return { ok: true, xdf, filename: 'user.xdf', diagnostics: [...diagnostics] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report(`ビルド失敗: ${message}`, true);
        return { ok: false, message, diagnostics: [...diagnostics] };
      }
    },

    run: async ({ xdf }) => runtime.runXdf(xdf),
  };
}
