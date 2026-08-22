/**
 * エディタから独立した復帰境界。
 * ソースの読み書きAPIは受け取らず、captureSource() は不変確認だけに使う。
 */
export function createRecoveryController({ adapter, buildFallback, captureSource }) {
  let lastSuccessfulBuild = null;

  function snapshot() {
    const value = captureSource();
    if (typeof value !== 'string') throw new TypeError('ソーススナップショットは文字列で指定してください');
    return value;
  }

  function assertSourceUnchanged(before) {
    if (snapshot() !== before) throw new Error('復帰中に編集中のソースが変化しました');
  }

  function rememberSuccessfulBuild(result) {
    if (!result?.ok || !(result.xdf instanceof Uint8Array)) return false;
    lastSuccessfulBuild = {
      ok: true,
      filename: result.filename || 'user.xdf',
      xdf: result.xdf.slice(),
    };
    return true;
  }

  async function stop() {
    const before = snapshot();
    await adapter.stop();
    assertSourceUnchanged(before);
    return { ok: true };
  }

  async function recover() {
    const before = snapshot();
    await adapter.stop();
    assertSourceUnchanged(before);

    let artifact = lastSuccessfulBuild;
    let source = 'last-successful';
    if (!artifact) {
      const fallback = await buildFallback();
      if (!rememberSuccessfulBuild(fallback)) throw new Error('同梱サンプルのビルドに失敗しました');
      artifact = lastSuccessfulBuild;
      source = 'bundled-sample';
    }
    assertSourceUnchanged(before);
    await adapter.run({ xdf: artifact.xdf, filename: artifact.filename });
    assertSourceUnchanged(before);
    return { ok: true, filename: artifact.filename, source };
  }

  return Object.freeze({
    rememberSuccessfulBuild,
    hasSuccessfulBuild: () => lastSuccessfulBuild !== null,
    stop,
    recover,
  });
}
