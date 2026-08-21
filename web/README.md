# ブラウザ実ビルド検証

先に配信用bundleとネイティブ正典の期待値を生成し、リポジトリ直下を配信する。

```sh
node tools/build_web_assets.mts
../WebX68k/node_modules/.bin/vite --config vite.config.ts
```

- 通常検証: <http://127.0.0.1:5180/web/>
- 故障注入: <http://127.0.0.1:5180/web/?fault=1>

完了時は成功・失敗とも `#result` の `textContent` に1行JSONが入る。
