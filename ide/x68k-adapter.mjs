import { loadBrowserToolchain } from '../web/browser-toolchain.ts';
import { rewriteBuildDiagnostic } from '../tools/driver/diagnostics.mts';
import { annotateBuildDiagnostics } from '../tools/driver/diagnostic_annotations.mts';
import { basenamePath, resolvePath } from '../tools/driver/hostfs.mts';
import { X68kRuntime } from './px68k-runtime.ts';
import { DEFAULT_DISK, assembleXdf, encodeShareFragment, packUserPayload } from '../tools/share_v1.mts';

/**
 * Sprout68k の UI とツールチェーン／エミュレータを隔離する差し替え境界。
 * build() は共有ブラウザツールチェーン、run() は同梱 px68k に接続する。
 * UI は個別ツールやエミュレータの内部状態を持たない。
 */
/**
 * ブラウザの圧縮。共有URLは deflate-raw を使う（gzip のヘッダ・フッタ・CRC の
 * 18バイトが丸ごと不要になり、base64 で24文字ぶん短くなる）。
 */
async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

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
        console.error('Sprout68k build failure', error);
        if (rawDiagnostics.length) console.error('Sprout68k raw tool diagnostics\n' + rawDiagnostics.join('\n'));
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

    /**
     * 共有用にビルドする。通常ビルドと違い、ライブラリを利用者コードに
     * リンクせず、ランタイム側の固定番地のジャンプテーブル越しに呼ばせる。
     * そのぶん利用者側の成果物が小さくなり、URLに載る。
     *
     * .xdf の組み立ては tools/share_v1.mts に任せる（**受信側とまったく同じ
     * 関数**を通す。ここで別に組み立てると、送信側と受信側が静かに食い違う）。
     */
    buildShared: async (source, tags = []) => {
      rawDiagnostics = [];
      try {
        const toolchain = await ensureToolchain();
        report(`${source.path} を共有用にビルドしています…`, false);
        const built = await toolchain.buildShared({ path: source.path, content: source.text });
        const shareLayout = { ...built.layout, ...DEFAULT_DISK };
        const payload = packUserPayload(built.user, shareLayout);
        const { image, sectorCount } = assembleXdf(built.boot, built.runtime, payload, shareLayout);
        const fragment = await encodeShareFragment('binary', payload, deflateRaw, tags);
        report(`共有用のビルド完了: 利用者コード ${built.user.length} バイト`, false);
        return { ok: true, payload, xdf: image, sectorCount, fragment, userSize: built.user.length };
      } catch (error) {
        console.error('Sprout68k shared build failure', error);
        if (rawDiagnostics.length) console.error('Sprout68k raw tool diagnostics\n' + rawDiagnostics.join('\n'));
        report('共有用のビルドに失敗しました', true);
        return { ok: false, message: error.message };
      }
    },

    run: async ({ xdf }) => runtime.runXdf(xdf),
    stop: async () => runtime.stop(),
  };
}
