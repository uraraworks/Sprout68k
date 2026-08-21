import { resolve } from 'node:path';

export default {
  // 設定ファイルの場所を基準にする。起動時の CWD に依存させない
  root: __dirname,
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  build: {
    outDir: 'build/web-page',
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'web/index.html') },
  },
};
