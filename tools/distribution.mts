import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

export const APP_PATH = '/Sprout68k/';
export const CACHE_PREFIX = 'sprout68k-precache-';
export const IDE_STATIC_FILES = [
  'about.html',
  'help.html',
  'reference.html',
  'samples.html',
  // 作例の画面写真。**実際に動かして撮ったもの**(tools/capture_sample_shots.mts)。
  // 1枚ずつ並べるのは、作例を増やしたときにここへ書き足す手が必要＝
  // 気づかず抜けることを防ぐため。
  'samples/shots/hello.png',
  'samples/shots/shapes.png',
  'samples/shots/keyboard-input.png',
  'samples/shots/move.png',
  'samples/shots/catch.png',
  'samples/shots/breakout.png',
  'samples/shots/stars.png',
  'samples/shots/life.png',
  'manifest.webmanifest',
  'icons/sprout68k.svg',
  'icons/sprout68k-16.png',
  'icons/sprout68k-32.png',
  'icons/sprout68k-192.png',
  'icons/sprout68k-512.png',
] as const;
export const ROOT_STATIC_FILES = [
  'CONTRIBUTING.md',
  'docs/IDEキーボード入力_20260822.md',
  // 共有リンクの受け取りに使うランタイム。**受け取る側にコンパイラは要らない。**
  // 過去の版は消さないこと（古い共有リンクが動かなくなる）。
  'deploy/runtime/v1/runtime.bin',
  'deploy/runtime/v1/boot.bin',
  'deploy/runtime/v1/share_v1.mts',
  'deploy/runtime/v1/manifest.json',
] as const;

interface AssetEntry { path: string; size: number; sha256: string }
interface AssetManifest { version: number; files: AssetEntry[] }

function posix(path: string): string { return path.split(sep).join('/'); }

function filesBelow(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function resolveWebAssetsRoot(root: string): string {
  const generated = resolve(root, 'build/web-assets');
  if (existsSync(resolve(generated, 'manifest.json'))) return generated;
  const snapshot = resolve(root, 'deploy/web-assets');
  if (existsSync(resolve(snapshot, 'manifest.json'))) return snapshot;
  throw new Error('web-assetsがありません（build生成物またはdeploy snapshotが必要です）');
}

/**
 * 直近コミットの日時(unix秒)。フッタの日付に使う。
 * **壁時計は使わない**（同じコミットから何度ビルドしても同じ表記にするため）。
 * git が使えない場合は例外を投げずに null を返し、表示側が「date unknown」と出す
 * （ビルドを失敗させない・もっともらしい値で埋めない）。
 */
export function commitTimestamp(root: string): number | null {
  try {
    const output = execFileSync('git', ['log', '-1', '--format=%ct', 'HEAD'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const seconds = Number(output);
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

/** UIと公開資産の内容から、キャッシュ更新と画面表示に共用する短いIDを作る。 */
export function computeBuildId(root: string): string {
  const hash = createHash('sha256');
  const inputs = [
    ...['ide', 'web'].flatMap((directory) => filesBelow(resolve(root, directory))),
    resolve(root, 'COPYING'), ...ROOT_STATIC_FILES.map((file) => resolve(root, file)),
    resolve(root, 'vite.config.ts'), resolve(root, 'tools/distribution.mts'),
    resolve(resolveWebAssetsRoot(root), 'manifest.json'),
    ...filesBelow(resolve(root, 'build/wasm-tools'))
      .filter((file) => /m68k-elf-(?:cc1|as|ld|objcopy)\.memfs\.(?:js|wasm)$/.test(file)),
  ].sort();
  for (const file of inputs) hash.update(`${posix(relative(root, file))}\0`).update(readFileSync(file));
  return hash.digest('hex').slice(0, 12);
}

function serviceWorkerSource(buildId: string, entries: AssetEntry[]): string {
  return `/* Sprout68k generated service worker: do not edit. */
const APP_SCOPE_PATH = ${JSON.stringify(APP_PATH)};
const CACHE_PREFIX = ${JSON.stringify(CACHE_PREFIX)};
const CACHE_NAME = CACHE_PREFIX + ${JSON.stringify(buildId)};
const PRECACHE_ENTRIES = ${JSON.stringify(entries, null, 2)};
const ENTRY_BY_URL = new Map(PRECACHE_ENTRIES.map((entry) => [new URL(entry.path, self.registration.scope).href, entry]));
let repairPromise;
let lastStatus = { state: 'preparing', detail: 'オフライン資産を確認しています' };

async function notifyStatus(state, detail) {
  lastStatus = { state, detail };
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clients) client.postMessage({ type: 'SPROUT68K_OFFLINE_STATUS', ...lastStatus });
}

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchAndCacheEntry(cache, entry) {
  const url = new URL(entry.path, self.registration.scope).href;
  let response;
  try {
    response = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
  } catch (error) {
    throw new Error(\`\${url}: network error: \${error instanceof Error ? error.message : String(error)}\`);
  }
  if (!response.ok) throw new Error(\`\${url}: HTTP \${response.status}\`);
  const bytes = await response.clone().arrayBuffer();
  const actualHash = await sha256(bytes);
  if (bytes.byteLength !== entry.size || actualHash !== entry.sha256) {
    throw new Error(\`\${url}: content mismatch (size=\${bytes.byteLength}, sha256=\${actualHash})\`);
  }
  await cache.put(url, response);
}

async function repairPrecache(reason, resetOnFailure = false) {
  if (repairPromise) return repairPromise;
  repairPromise = (async () => {
    await notifyStatus('preparing', \`オフライン資産を確認中 (\${reason})\`);
    const cache = await caches.open(CACHE_NAME);
    try {
      for (const entry of PRECACHE_ENTRIES) {
        const url = new URL(entry.path, self.registration.scope).href;
        if (!await cache.match(url, { ignoreSearch: true })) await fetchAndCacheEntry(cache, entry);
      }
      const missing = [];
      for (const entry of PRECACHE_ENTRIES) {
        const url = new URL(entry.path, self.registration.scope).href;
        if (!await cache.match(url, { ignoreSearch: true })) missing.push(url);
      }
      if (missing.length) throw new Error(\`cacheへの格納後も不足: \${missing.join(', ')}\`);
      await notifyStatus('ready', \`\${PRECACHE_ENTRIES.length}件のオフライン資産を利用できます\`);
      return lastStatus;
    } catch (error) {
      if (resetOnFailure) await caches.delete(CACHE_NAME);
      const detail = error instanceof Error ? error.message : String(error);
      console.error(\`[Sprout68k precache] \${reason}: \${detail}\`);
      await notifyStatus('error', detail);
      throw error;
    }
  })();
  try { return await repairPromise; } finally { repairPromise = undefined; }
}

self.addEventListener('install', (event) => {
  // 逐次取得で失敗URLを特定する。初回installの部分cacheは削除し、rejectでactivateを阻止する。
  event.waitUntil(repairPrecache('install', true).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(repairPrecache('activate').then(() => caches.keys()).then((names) => Promise.all(names
    .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
    .map((name) => caches.delete(name)))).then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'SPROUT68K_CHECK_CACHE') return;
  event.waitUntil(repairPrecache('client-check').then(
    (status) => event.ports[0]?.postMessage({ type: 'SPROUT68K_OFFLINE_STATUS', ...status }),
    () => event.ports[0]?.postMessage({ type: 'SPROUT68K_OFFLINE_STATUS', ...lastStatus }),
  ));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(APP_SCOPE_PATH)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    let cached = await cache.match(event.request, { ignoreSearch: true });
    if (!cached && url.pathname.endsWith('/')) cached = await cache.match(new URL('index.html', url).href);
    if (cached) return cached;
    // cache退去後の最初の要求を直しつつ、残りもevent lifetime内で補充する。
    if (ENTRY_BY_URL.has(url.href)) {
      try {
        await fetchAndCacheEntry(cache, ENTRY_BY_URL.get(url.href));
        const repaired = await cache.match(event.request, { ignoreSearch: true });
        const repair = repairPrecache('fetch-miss');
        event.waitUntil(repair.catch(() => {}));
        if (repaired) return repaired;
      } catch {
        const repair = repairPrecache('fetch-miss');
        event.waitUntil(repair.catch(() => {}));
        // 詳細はrepairPrecacheがURL付きで記録・通知する。最後にnetwork fallbackを試す。
      }
    }
    return fetch(event.request);
  })());
});
`;
}

/**
 * Chromiumのpreload scannerは、SWが返したnavigationのclient制御が確定する前に
 * head内の外部script/linkをnetworkへ出す場合がある。外部タグを除き、deferされる
 * inline moduleから文書確定後に同じ資産を取得して組み立てる。
 */
function installControlledBootstrap(outDir: string): void {
  const htmlPath = resolve(outDir, 'ide/index.html');
  let html = readFileSync(htmlPath, 'utf8');
  const entryMatch = html.match(/\s*<script type="module"(?: crossorigin)? src="([^"]+)"><\/script>/);
  if (!entryMatch) throw new Error('IDE entry moduleを生成HTMLから取得できません');
  const entryModule = entryMatch[1];
  const modulePreloads = [...html.matchAll(/\s*<link rel="modulepreload"(?: crossorigin)? href="([^"]+)">/g)]
    .map((match) => match[1]);
  const styles = [...html.matchAll(/\s*<link rel="stylesheet"(?: crossorigin)? href="([^"]+)">/g)]
    .map((match) => match[1]);
  if (styles.length === 0) throw new Error('IDE stylesheetを生成HTMLから取得できません');
  html = html
    .replace(entryMatch[0], '')
    .replace(/\s*<link rel="modulepreload"(?: crossorigin)? href="[^"]+">/g, '')
    .replace(/\s*<link rel="stylesheet"(?: crossorigin)? href="[^"]+">/g, '');
  const bootstrap = `
  <script type="module" id="sprout68k-controlled-bootstrap">
    // 外部タグの先読みを避け、navigation先のSW制御が確定した実行段階で取得する。
    const REQUIRED_STYLES = ${JSON.stringify(styles)};
    const REQUIRED_MODULES = ${JSON.stringify(modulePreloads)};
    const ENTRY_MODULE = ${JSON.stringify(entryModule)};
    async function fetchRequired(url) {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(\`必須資産を取得できません: \${url} (HTTP \${response.status})\`);
      return response;
    }
    try {
      for (const url of REQUIRED_STYLES) {
        const style = document.createElement('style');
        style.dataset.sprout68kSource = url;
        style.textContent = await (await fetchRequired(url)).text();
        document.head.append(style);
      }
      // Chromiumではこの状況のnative dynamic importだけがSWを経由しないため、
      // module sourceも明示fetchし、静的依存をBlob URLへ結び替えて読み込む。
      const moduleBlobUrls = new Map();
      for (const url of REQUIRED_MODULES) {
        const source = await (await fetchRequired(url)).text();
        moduleBlobUrls.set(new URL(url, location.href).href,
          URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      }
      const entryAbsolute = new URL(ENTRY_MODULE, location.href);
      const entryDirectory = new URL('.', entryAbsolute).href;
      let entrySource = await (await fetchRequired(ENTRY_MODULE)).text();
      for (const [moduleAbsolute, blobUrl] of moduleBlobUrls) {
        const specifier = moduleAbsolute.startsWith(entryDirectory)
          ? \`./\${moduleAbsolute.slice(entryDirectory.length)}\` : moduleAbsolute;
        const before = entrySource;
        entrySource = entrySource.replaceAll(\`"\${specifier}"\`, \`"\${blobUrl}"\`)
          .replaceAll(\`'\${specifier}'\`, \`'\${blobUrl}'\`);
        if (entrySource === before) throw new Error(\`entryの依存moduleを結び替えられません: \${specifier}\`);
      }
      const entryBlobUrl = URL.createObjectURL(new Blob([entrySource], { type: 'text/javascript' }));
      try { await import(entryBlobUrl); } finally {
        URL.revokeObjectURL(entryBlobUrl);
        for (const blobUrl of moduleBlobUrls.values()) URL.revokeObjectURL(blobUrl);
      }
    } catch (error) {
      console.error('Sprout68kの起動に失敗しました', error);
      document.documentElement.dataset.sprout68kBootstrap = 'error';
    }
  </script>`;
  html = html.replace('</head>', `${bootstrap}\n</head>`);
  writeFileSync(htmlPath, html);
}

/** Vite出力へ、生成済み束・memfsツール・内容由来precacheを収集する。 */
export function stageDistribution(root: string, outDir: string, buildId: string): void {
  const assetRoot = resolveWebAssetsRoot(root);
  const manifest = JSON.parse(readFileSync(resolve(assetRoot, 'manifest.json'), 'utf8')) as AssetManifest;
  if (manifest.version !== 1) throw new Error('web-assets manifest の版が不正です');
  for (const entry of manifest.files) {
    const source = resolve(assetRoot, entry.path);
    if (statSync(source).size !== entry.size || sha256(source) !== entry.sha256) {
      throw new Error(`web-assets manifest 不一致: ${entry.path}`);
    }
    const destination = resolve(outDir, 'build/web-assets', entry.path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  for (const name of ['manifest.json', 'expected.json']) {
    const destination = resolve(outDir, 'build/web-assets', name);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(resolve(assetRoot, name), destination);
  }

  for (const relativePath of IDE_STATIC_FILES) {
    const destination = resolve(outDir, 'ide', relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(resolve(root, 'ide', relativePath), destination);
  }
  for (const relativePath of ROOT_STATIC_FILES) {
    const destination = resolve(outDir, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(resolve(root, relativePath), destination);
  }

  const toolFiles = filesBelow(resolve(root, 'build/wasm-tools'))
    .filter((file) => /m68k-elf-(?:cc1|as|ld|objcopy)\.memfs\.(?:js|wasm)$/.test(file));
  if (toolFiles.length !== 8) throw new Error(`公開するmemfsツールは8ファイル必要です: ${toolFiles.length}`);
  for (const source of toolFiles) {
    const destination = resolve(outDir, 'build/wasm-tools', source.split(sep).at(-1)!);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }

  installControlledBootstrap(outDir);

  const entries = filesBelow(outDir).map((file) => ({
    path: posix(relative(outDir, file)), size: statSync(file).size, sha256: sha256(file),
  }));
  const offlineManifest = { version: 1, buildId, scope: APP_PATH, cachePrefix: CACHE_PREFIX, files: entries };
  writeFileSync(resolve(outDir, 'offline-manifest.json'), `${JSON.stringify(offlineManifest, null, 2)}\n`);
  writeFileSync(resolve(outDir, 'sprout68k-sw.js'), serviceWorkerSource(buildId, entries));
  console.log(`Sprout68k distribution: build=${buildId}, precache=${entries.length} files`);
}
