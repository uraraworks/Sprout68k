import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { runInNewContext } from 'node:vm';
import { APP_PATH, CACHE_PREFIX, IDE_STATIC_FILES, ROOT_STATIC_FILES, resolveWebAssetsRoot } from './distribution.mts';
import { verifyHtmlUrls } from './html_url_verifier.mts';
import { offlineStatusPresentation } from '../ide/offline-support.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = resolve(ROOT, 'build/web-page');
interface Entry { path: string; size: number; sha256: string }
interface OfflineManifest { version: number; buildId: string; scope: string; cachePrefix: string; files: Entry[] }
interface AssetManifest { version: number; files: Entry[] }

function posix(path: string): string { return path.split(sep).join('/'); }
function filesBelow(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => resolve(entry.parentPath, entry.name)).sort();
}
function digest(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

function verifySvgHasNoEmbeddedRaster(source: string): void {
  assert(!source.toLowerCase().includes('base64'), 'SVGにbase64埋め込みがあります');
  assert(!/<image(?:\s|>)/i.test(source), 'SVGにimage要素があります');
}

const iconSvg = readFileSync(resolve(ROOT, 'ide/icons/sprout68k.svg'), 'utf8');
verifySvgHasNoEmbeddedRaster(iconSvg);
let embeddedRasterRejected = false;
try {
  verifySvgHasNoEmbeddedRaster(iconSvg.replace('</svg>', '<image href="data:image/png;base64,AA=="/></svg>'));
} catch { embeddedRasterRejected = true; }
assert(embeddedRasterRejected, 'SVG画像埋め込みの故障注入を検出できません');
console.log('PASS(故障注入): SVGのbase64 image埋め込みを拒否');

const workbench = readFileSync(resolve(ROOT, 'ide/workbench.js'), 'utf8');
const sw = readFileSync(resolve(DIST, 'sprout68k-sw.js'), 'utf8');
const offline = JSON.parse(readFileSync(resolve(DIST, 'offline-manifest.json'), 'utf8')) as OfflineManifest;

function verifyIsolation(workbenchSource: string, swSource: string): void {
  assert(APP_PATH !== '/', 'アプリのscopeがルートです');
  assert(workbenchSource.includes(`const SPROUT68K_SCOPE_PATH = '${APP_PATH}'`), '登録scopeがSprout68k配下ではありません');
  assert(workbenchSource.includes('scope: SPROUT68K_SCOPE_PATH'), '登録時にscopeを明示していません');
  assert(swSource.includes(`const APP_SCOPE_PATH = ${JSON.stringify(APP_PATH)}`), 'SWのfetch境界がSprout68k配下ではありません');
  assert(swSource.includes(`const CACHE_PREFIX = ${JSON.stringify(CACHE_PREFIX)}`), '専用cache接頭辞がありません');
  assert(swSource.includes('.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)'), '古いcache削除が専用接頭辞に限定されていません');
}

verifyIsolation(workbench, sw);
const retiredScope = `/${['X68k', 'Dev'].join('')}/`;
for (const [name, brokenWorkbench, brokenSw] of [
  ['ルートscope', workbench.replace(`const SPROUT68K_SCOPE_PATH = '${APP_PATH}'`, "const SPROUT68K_SCOPE_PATH = '/'"), sw],
  ['旧製品scope', workbench.replace(`const SPROUT68K_SCOPE_PATH = '${APP_PATH}'`, `const SPROUT68K_SCOPE_PATH = '${retiredScope}'`), sw],
  ['接頭辞なし削除', workbench, sw.replace('.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)', '.filter((name) => name !== CACHE_NAME)')],
] as const) {
  let rejected = false;
  try { verifyIsolation(brokenWorkbench, brokenSw); } catch { rejected = true; }
  assert(rejected, `故障注入を検出できません: ${name}`);
  console.log(`PASS(故障注入): ${name}を拒否`);
}

assert(offline.version === 1 && offline.scope === APP_PATH && offline.cachePrefix === CACHE_PREFIX, 'offline manifestの識別情報が不正です');
const actualPublic = filesBelow(DIST).map((file) => posix(relative(DIST, file)))
  .filter((path) => path !== 'offline-manifest.json' && path !== 'sprout68k-sw.js');
const listed = offline.files.map((entry) => entry.path);
assert(JSON.stringify(listed) === JSON.stringify([...listed].sort()), 'precache一覧が安定順ではありません');
assert(new Set(listed).size === listed.length, 'precache一覧に重複があります');
assert(JSON.stringify(listed) === JSON.stringify(actualPublic), '公開物とprecache一覧が一致しません');
for (const entry of offline.files) {
  const file = resolve(DIST, entry.path);
  assert(statSync(file).size === entry.size && digest(file) === entry.sha256, `公開物の内容不一致: ${entry.path}`);
}

const precacheMatch = sw.match(/const PRECACHE_ENTRIES = (\[[\s\S]*?\]);\nconst ENTRY_BY_URL/);
assert(precacheMatch, 'SWのprecache一覧を取得できません');
const swEntries = JSON.parse(precacheMatch[1]) as Entry[];
assert(JSON.stringify(swEntries) === JSON.stringify(offline.files), 'SWとoffline manifestのprecache一覧が一致しません');
for (const contract of [
  "repairPrecache('install', true)", "repairPrecache('activate')", "repairPrecache('client-check')",
  "repairPrecache('fetch-miss')", 'await caches.delete(CACHE_NAME)', 'console.error(`[Sprout68k precache]',
]) assert(sw.includes(contract), `SW自己修復契約がありません: ${contract}`);
assert(!sw.includes('cache.addAll('), '失敗URLを隠すatomic addAllが残っています');

async function createSwHarness(failPath?: string) {
  type Listener = (event: Record<string, unknown>) => void;
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, Response>>();
  const statusMessages: unknown[] = [];
  const errors: string[] = [];
  let skipWaitingCalled = false;
  const keyOf = (request: string | Request, ignoreSearch = false) => {
    const url = new URL(typeof request === 'string' ? request : request.url);
    if (ignoreSearch) url.search = '';
    return url.href;
  };
  const cachesMock = {
    async open(name: string) {
      let store = stores.get(name);
      if (!store) { store = new Map(); stores.set(name, store); }
      return {
        async match(request: string | Request, options?: { ignoreSearch?: boolean }) {
          return store!.get(keyOf(request, options?.ignoreSearch))?.clone();
        },
        async put(request: string | Request, response: Response) { store!.set(keyOf(request), response.clone()); },
      };
    },
    async delete(name: string) { return stores.delete(name); },
    async keys() { return [...stores.keys()]; },
  };
  const selfMock = {
    registration: { scope: `https://example.test${APP_PATH}` },
    location: { origin: 'https://example.test' },
    clients: {
      async matchAll() { return [{ postMessage(message: unknown) { statusMessages.push(message); } }]; },
      async claim() {},
    },
    addEventListener(type: string, listener: Listener) { listeners.set(type, listener); },
    async skipWaiting() { skipWaitingCalled = true; },
  };
  const fetchMock = async (request: Request) => {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.slice(APP_PATH.length));
    if (path === failPath) throw new Error('INJECTED_NETWORK_FAILURE');
    const file = resolve(DIST, path);
    return new Response(readFileSync(file), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };
  runInNewContext(sw, {
    self: selfMock, caches: cachesMock, fetch: fetchMock, Request, Response, URL,
    crypto: globalThis.crypto, Uint8Array, console: { error: (...args: unknown[]) => errors.push(args.map(String).join(' ')) },
  });
  async function dispatch(type: string, extra: Record<string, unknown> = {}) {
    let lifetime: Promise<unknown> | undefined;
    const listener = listeners.get(type);
    assert(listener, `SW listenerがありません: ${type}`);
    listener({ ...extra, waitUntil(promise: Promise<unknown>) { lifetime = promise; } });
    assert(lifetime, `waitUntilが呼ばれません: ${type}`);
    return await lifetime;
  }
  return { stores, statusMessages, errors, dispatch, get skipWaitingCalled() { return skipWaitingCalled; } };
}

const swHarness = await createSwHarness();
await swHarness.dispatch('install');
assert(swHarness.skipWaitingCalled, '全件格納後にskipWaitingしていません');
const installedCache = [...swHarness.stores.values()][0];
assert(installedCache?.size === offline.files.length, `install実行結果が全件cacheではありません: ${installedCache?.size}`);
swHarness.stores.clear();
let clientReply: unknown;
await swHarness.dispatch('message', {
  data: { type: 'SPROUT68K_CHECK_CACHE' }, ports: [{ postMessage(message: unknown) { clientReply = message; } }],
});
assert([...swHarness.stores.values()][0]?.size === offline.files.length, 'client起動照会で空cacheを自己修復できません');
assert((clientReply as { state?: string })?.state === 'ready', '自己修復後にreadyを返していません');
const readyPresentation = offlineStatusPresentation('ready');
assert(!readyPresentation.error && readyPresentation.text === 'オフラインでも使えます', 'readyが本番UIの成功表示になりません');
console.log(`PASS(SW実行モデル): install全${offline.files.length}件、空cacheからclient-checkで全件自己修復、UI=オフラインでも使えます`);

const injectedPath = offline.files[0].path;
const faultHarness = await createSwHarness(injectedPath);
let installRejected = false;
try { await faultHarness.dispatch('install'); } catch { installRejected = true; }
assert(installRejected && faultHarness.stores.size === 0 && !faultHarness.skipWaitingCalled, 'install失敗時に部分cacheを破棄してactivateを阻止できません');
assert(faultHarness.errors.some((line) => line.includes(injectedPath) && line.includes('INJECTED_NETWORK_FAILURE')), 'install失敗ログにURLと原因がありません');
assert(faultHarness.statusMessages.some((message) => (message as { state?: string }).state === 'error'), 'install失敗をclientへ通知していません');
const failurePresentation = offlineStatusPresentation('error');
assert(failurePresentation.error && failurePresentation.text === 'オフライン準備に失敗しました', 'precache失敗がUIで赤色表示になりません');
console.log(`PASS(故障注入): ${injectedPath}取得失敗をURL付き記録、部分cache破棄、activate阻止、UI=error(赤)`);

const sourceAssets = JSON.parse(readFileSync(resolve(resolveWebAssetsRoot(ROOT), 'manifest.json'), 'utf8')) as AssetManifest;
assert(sourceAssets.version === 1, 'web-assets manifestの版が不正です');
for (const entry of sourceAssets.files) {
  const published = resolve(DIST, 'build/web-assets', entry.path);
  assert(statSync(published).size === entry.size && digest(published) === entry.sha256, `manifest資産が公開物にありません: ${entry.path}`);
}
const tools = listed.filter((path) => /^build\/wasm-tools\/m68k-elf-(?:cc1|as|ld|objcopy)\.memfs\.(?:js|wasm)$/.test(path));
assert(tools.length === 8, `wasmツールの公開物が8ファイルではありません: ${tools.length}`);

for (const htmlPath of ['ide/index.html', 'web/index.html']) {
  const html = readFileSync(resolve(DIST, htmlPath), 'utf8');
  const documentPath = `${APP_PATH}${htmlPath.replace(/index\.html$/, '')}`;
  const references = verifyHtmlUrls(html, `https://example.test${documentPath}`, DIST, APP_PATH, htmlPath === 'ide/index.html');
  console.log(`PASS(dist HTML URL解決): ${htmlPath} ${references.length}件${htmlPath === 'ide/index.html' ? '（favicon/manifest含む）' : ''}`);
}

// 開発HTMLが指すロゴ・favicon・manifestの安定URLも、dist公開ルートで同じく
// 200相当になることを、HTMLのタグから抽出して確認する。
const sourceIdeHtml = readFileSync(resolve(ROOT, 'ide/index.html'), 'utf8');
const sourceBrandTags = [...sourceIdeHtml.matchAll(/<(?:link|img)\b[^>]*>/g)].map((match) => match[0])
  .filter((tag) => /rel="(?:icon|manifest)"/.test(tag) || /class="app-icon"/.test(tag));
const sourceBrandReferences = verifyHtmlUrls(
  `<html><head>${sourceBrandTags.filter((tag) => tag.startsWith('<link')).join('')}</head><body>${sourceBrandTags.filter((tag) => tag.startsWith('<img')).join('')}</body></html>`,
  `https://example.test${APP_PATH}ide/`, DIST, APP_PATH,
);
const stableBrandUrls = [...new Set(sourceBrandReferences.map((entry) => entry.url.pathname))];
assert(stableBrandUrls.length === 4, `distで200相当になる安定ブランドURLが4件ではありません: ${stableBrandUrls.join(', ')}`);
console.log(`PASS(dist安定URL解決): ${stableBrandUrls.join(',')}`);

const distIdeHtml = readFileSync(resolve(DIST, 'ide/index.html'), 'utf8');
const duplicatedBaseDistHtml = distIdeHtml.replace(
  /(<link rel="icon" href=")[^"]+"/,
  `$1${APP_PATH}${APP_PATH.slice(1)}ide/icons/sprout68k.svg"`,
);
assert(duplicatedBaseDistHtml !== distIdeHtml, 'dist base二重化の故障注入対象がありません');
let duplicatedBaseDistRejected = false;
let duplicatedBaseDistError = '';
try {
  verifyHtmlUrls(duplicatedBaseDistHtml, `https://example.test${APP_PATH}ide/`, DIST, APP_PATH);
} catch (error) {
  duplicatedBaseDistError = error instanceof Error ? error.message : String(error);
  duplicatedBaseDistRejected = duplicatedBaseDistError.includes(`${APP_PATH}${APP_PATH.slice(1)}`);
}
assert(duplicatedBaseDistRejected, `dist base二重化を検出できません: ${duplicatedBaseDistError}`);
console.log(`PASS(故障注入・dist base二重): ${duplicatedBaseDistError}`);

const ideManifestPath = resolve(DIST, 'ide/manifest.webmanifest');
const ideManifest = JSON.parse(readFileSync(ideManifestPath, 'utf8')) as {
  icons: Array<{ src: string; sizes: string; type: string }>;
};
const expectedStatic = IDE_STATIC_FILES.map((path) => `ide/${path}`);
for (const path of [...expectedStatic, ...ROOT_STATIC_FILES]) {
  assert(listed.includes(path) && statSync(resolve(DIST, path)).size > 0, `IDE静的資産が公開物にありません: ${path}`);
}
const helpPath = 'ide/help.html';
function verifyHelpPublished(paths: Set<string>): void {
  assert(paths.has(helpPath), 'ヘルプが公開物とprecacheにありません');
  const help = readFileSync(resolve(DIST, helpPath), 'utf8');
  for (const match of help.matchAll(/(?:src|href)="((?:\.\.\/|\.\/)[^"?#]+)"/g)) {
    const target = posix(relative(DIST, resolve(DIST, 'ide', match[1])));
    assert(paths.has(target), `ヘルプ参照先が公開物とprecacheにありません: ${match[1]}`);
  }
}
verifyHelpPublished(new Set(listed));
let helpOmissionRejected = false;
try {
  const broken = new Set(listed); broken.delete(helpPath); verifyHelpPublished(broken);
} catch { helpOmissionRejected = true; }
assert(helpOmissionRejected, 'ヘルプ欠落の故障注入を検出できません');
console.log('PASS(故障注入): ide/help.htmlの公開・precache欠落を拒否');
for (const icon of ideManifest.icons) {
  assert(icon.src.startsWith(APP_PATH), `manifest iconがアプリscope外です: ${icon.src}`);
  const path = icon.src.slice(APP_PATH.length);
  assert(listed.includes(path) && statSync(resolve(DIST, path)).size > 0, `manifest iconが公開物にありません: ${icon.src}`);
}
assert(ideManifest.icons.some((icon) => icon.sizes === '192x192' && icon.type === 'image/png'), 'manifestに192px PNGがありません');
assert(ideManifest.icons.some((icon) => icon.sizes === '512x512' && icon.type === 'image/png'), 'manifestに512px PNGがありません');

/**
 * ブラウザのpreload実装そのものではなく、IDEが早期外部要求を持たず、文書確定後の
 * bootstrapが必要CSS/moduleをcacheだけから取得してentryまで到達できることを検査する。
 */
function verifyOfflineAssembly(html: string, cachedPaths: Set<string>): { styles: string[]; modules: string[]; entry: string } {
  assert(!/<script type="module"[^>]+src=/.test(html), 'IDEに早期entry module要求が残っています');
  assert(!/<link rel="(?:modulepreload|stylesheet)"/.test(html), 'IDEに早期link要求が残っています');
  assert(html.includes('id="sprout68k-controlled-bootstrap"'), '制御確定後bootstrapがありません');
  for (const contract of [
    'await fetchRequired(url)', 'document.head.append(style)',
    'let entrySource = await (await fetchRequired(ENTRY_MODULE)).text()',
    'entrySource.replaceAll', 'await import(entryBlobUrl)',
  ]) {
    assert(html.includes(contract), `オフライン組立契約がありません: ${contract}`);
  }
  function jsonConstant(name: string): unknown {
    const match = html.match(new RegExp(`const ${name} = ([^;]+);`));
    assert(match, `bootstrap定数を取得できません: ${name}`);
    return JSON.parse(match[1]);
  }
  const styles = jsonConstant('REQUIRED_STYLES') as string[];
  const modules = jsonConstant('REQUIRED_MODULES') as string[];
  const entry = jsonConstant('ENTRY_MODULE') as string;
  assert(styles.length > 0 && entry.endsWith('.js'), 'CSSまたはentry moduleがありません');
  for (const url of [...styles, ...modules, entry]) {
    assert(url.startsWith(APP_PATH), `bootstrap資産がアプリscope外です: ${url}`);
    const path = url.slice(APP_PATH.length);
    assert(cachedPaths.has(path), `bootstrap資産がprecacheにありません: ${path}`);
    assert(statSync(resolve(DIST, path)).size > 0, `bootstrap資産が空です: ${path}`);
  }
  assert(!html.includes('await import(ENTRY_MODULE)'), 'entry URLをnative importするSW素通り経路が残っています');
  return { styles, modules, entry };
}

const ideHtml = readFileSync(resolve(DIST, 'ide/index.html'), 'utf8');
const assembly = verifyOfflineAssembly(ideHtml, new Set(listed));
assert(assembly.modules.every((url) => url.endsWith('.js')), 'modulepreload対象にJS以外があります');
const entryAbsolute = new URL(assembly.entry, 'https://example.test');
const entryDirectory = new URL('.', entryAbsolute).href;
let modeledEntry = readFileSync(resolve(DIST, assembly.entry.slice(APP_PATH.length)), 'utf8');
for (const moduleUrl of assembly.modules) {
  const moduleAbsolute = new URL(moduleUrl, 'https://example.test').href;
  const specifier = moduleAbsolute.startsWith(entryDirectory) ? `./${moduleAbsolute.slice(entryDirectory.length)}` : moduleAbsolute;
  assert(modeledEntry.includes(`"${specifier}"`) || modeledEntry.includes(`'${specifier}'`), `entryの静的依存を取得できません: ${specifier}`);
  modeledEntry = modeledEntry.replaceAll(`"${specifier}"`, '"blob:verified-dependency"')
    .replaceAll(`'${specifier}'`, "'blob:verified-dependency'");
  const dependency = readFileSync(resolve(DIST, moduleUrl.slice(APP_PATH.length)), 'utf8');
  assert(!/(?:from\s*|import\()\s*["']\.\//.test(dependency), `依存chunkに未解決の相対importがあります: ${moduleUrl}`);
}
assert(!/(?:from\s*|import\()\s*["']\.\//.test(modeledEntry), 'Blob entryに未解決の相対importが残ります');
let assemblyFaultRejected = false;
try {
  const brokenCache = new Set(listed);
  brokenCache.delete(assembly.entry.slice(APP_PATH.length));
  verifyOfflineAssembly(ideHtml, brokenCache);
} catch { assemblyFaultRejected = true; }
assert(assemblyFaultRejected, 'entry module欠落のオフライン組立故障を検出できません');
console.log(`PASS(オフライン組立): CSS=${assembly.styles.length}, preload=${assembly.modules.length}, entry=1をcacheから解決しBlob依存を閉包`);
console.log('PASS(故障注入): entry module欠落でオフライン組立を拒否');

const omitted = listed.find((path) => path.endsWith('m68k-elf-cc1.memfs.wasm'))!;
let omissionRejected = false;
try {
  const broken = new Set(listed); broken.delete(omitted);
  assert(actualPublic.every((path) => broken.has(path)), `公開物がprecacheから欠落: ${omitted}`);
} catch { omissionRejected = true; }
assert(omissionRejected, '公開物欠落の故障注入を検出できません');
console.log(`PASS(故障注入): ${omitted}の欠落を拒否`);
console.log(`配布検証 PASS: build=${offline.buildId}, 公開/precache=${listed.length}ファイル, web-assets=${sourceAssets.files.length}, wasm-tools=${tools.length}`);
