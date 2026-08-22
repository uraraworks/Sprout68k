import { resolve } from 'node:path';
import { APP_PATH, computeBuildId, stageDistribution } from './tools/distribution.mts';

const buildId = computeBuildId(__dirname);

export default {
  // 設定ファイルの場所を基準にする。起動時の CWD に依存させない
  root: __dirname,
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  // コピーしたWebX68kホストはこの識別子をwasmキャッシュバスターへ使う。
  base: APP_PATH,
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [{
    name: 'x68kdev-distribution',
    closeBundle() { stageDistribution(__dirname, resolve(__dirname, 'build/web-page'), buildId); },
  }],
  build: {
    outDir: 'build/web-page',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        web: resolve(__dirname, 'web/index.html'),
        ide: resolve(__dirname, 'ide/index.html'),
      },
    },
  },
};
