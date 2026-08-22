export function offlineStartupMode({ development, serviceWorkerSupported, inScope }) {
  if (development) return 'development-disabled';
  if (!serviceWorkerSupported || !inScope) return 'error';
  return 'register';
}

export function offlineStatusPresentation(state) {
  if (state === 'ready') return { text: 'オフラインでも使えます', error: false };
  if (state === 'development-disabled') return { text: 'オフライン: 開発サーバでは無効', error: false };
  if (state === 'error') return { text: 'オフライン準備に失敗しました', error: true };
  return { text: 'オフライン: 準備中', error: false };
}
