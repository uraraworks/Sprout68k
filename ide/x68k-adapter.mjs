/**
 * X68kDev の UI とツールチェーン／エミュレータを隔離する差し替え境界。
 * 次の段で initialize() に実行環境準備、build() にブラウザ内 m68k ビルド、
 * run() に生成 XDF と px68k の接続を実装する。
 * UI 側はこの契約だけを呼び、個別ツールやエミュレータの状態を持たない。
 */
export function createX68kAdapter({ report }) {
  const unavailable = async (operation) => {
    const message = `${operation}アダプタは未実装です（次の段で接続します）`;
    report(message, false);
    return { ok: false, unavailable: true, message };
  };
  return {
    initialize: async () => unavailable('実行環境の初期化'),
    build: async (_source) => unavailable('ビルド'),
    run: async (_source) => unavailable('実行'),
  };
}
