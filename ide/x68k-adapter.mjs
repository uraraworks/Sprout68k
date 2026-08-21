import { loadBrowserToolchain } from '../web/browser-toolchain.ts';
import { resolvePath } from '../tools/driver/hostfs.mts';

/**
 * X68kDev の UI とツールチェーン／エミュレータを隔離する差し替え境界。
 * build() は共有ブラウザツールチェーンへ接続済み。次段では run() に、保持した
 * XDF と px68k の接続を実装する。UI は個別ツールやエミュレータ状態を持たない。
 */
export function createX68kAdapter({ report }) {
  let toolchainPromise;
  let diagnostics = [];

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

    run: async (_source) => {
      const message = '実行アダプタは未実装です（次の段で接続します）';
      report(message, false);
      return { ok: false, unavailable: true, message };
    },
  };
}
