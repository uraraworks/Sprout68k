import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const retiredName = ['x68k', 'dev'].join('');
const retainedToolchainDirectory = `${retiredName}-toolchain`;
const allowedRetainedCounts = new Map<string, number>([
  // ツールチェーンの置き場だけは旧名のまま。prefix が cc1 に焼き込まれていて
  // 改名すると内部ヘッダを見失うため（docs/コンパイラwasm化_20260820.md）。
  // **ファイルごとに出現回数まで書く**ので、増えても減っても検出する。
  ['README.md', 1],
  ['docs/コンパイラwasm化_20260820.md', 1],
  ['mcp/README.md', 4],
  ['tools/build_for_mcp.mts', 1],
  ['tools/build_native_toolchain.sh', 1],
  ['tools/build_wasm_binutils.sh', 1],
  ['tools/build_wasm_gcc.sh', 2],
  ['tools/build_web_assets.mts', 1],
  ['tools/driver/collect_diagnostics.mts', 1],
  ['tools/driver/verify_hostfs.mts', 2],
  ['tools/driver/verify_user_target.mts', 1],
  ['tools/driver/verify_wasm.mts', 1],
  ['tools/driver/verify_web_assets.mts', 1],
  ['tools/verify_reference.mts', 1],
  ['tools/verify_runtime.mts', 2],
  ['verify/verify_ide_boot.mts', 1],
  ['verify/verify_ide_keyboard.mts', 1],
  ['verify/verify_ide_recovery.mts', 1],
]);
const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT })
  .toString('utf8').split('\0').filter((path) => path && existsSync(resolve(ROOT, path)));
// コミット前にも、この新設検査自身を走査対象へ含める。
const scanned = [...new Set([...tracked, 'tools/verify_branding.mts'])];
const hits: string[] = [];
const retainedCounts = new Map<string, number>();

function inspect(path: string, source: string): void {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lower = lines[index].toLowerCase();
    let offset = lower.indexOf(retiredName);
    while (offset >= 0) {
      const retained = lower.slice(offset, offset + retainedToolchainDirectory.length) === retainedToolchainDirectory;
      if (!retained || !allowedRetainedCounts.has(path)) hits.push(`${path}:${index + 1}`);
      else retainedCounts.set(path, (retainedCounts.get(path) ?? 0) + 1);
      offset = lower.indexOf(retiredName, offset + retiredName.length);
    }
  }
}
for (const path of scanned) {
  const bytes = readFileSync(resolve(ROOT, path));
  if (!bytes.includes(0)) inspect(path, bytes.toString('utf8'));
}
for (const [path, expected] of allowedRetainedCounts) {
  const actual = retainedCounts.get(path) ?? 0;
  if (actual !== expected) hits.push(`${path}: 基準器pathの許可数 expected=${expected}, actual=${actual}`);
}
if (hits.length) throw new Error(`旧製品名の不許可残骸があります:\n${hits.join('\n')}`);

const beforeFault = hits.length;
inspect('README.md', `INJECTED_${retiredName}_CACHE`);
if (hits.length === beforeFault) throw new Error('旧製品名の故障注入を検出できません');
hits.length = beforeFault;
console.log('PASS(故障注入): 許可外ファイルの旧製品名を拒否');

const required: Array<[string, string]> = [
  ['package.json', '"name": "sprout68k"'],
  ['ide/index.html', '<h1>Sprout68k</h1>'],
  ['ide/project-fs.mjs', "databaseName = 'Sprout68kProjectFS'"],
  ['ide/workbench.js', "const LAST_PATH_KEY = 'sprout68k:last-path'"],
  ['ide/workbench.js', "const SPROUT68K_SCOPE_PATH = '/Sprout68k/'"],
  ['ide/workbench.js', "new URL('sprout68k-sw.js'"],
  ['ide/workbench.js', 'window.sprout68kWorkbench'],
  ['ide/px68k-runtime.ts', 'window.sprout68kEmulatorProbe'],
  ['tools/distribution.mts', "export const CACHE_PREFIX = 'sprout68k-precache-'"],
  ['tools/distribution.mts', "writeFileSync(resolve(outDir, 'sprout68k-sw.js')"],
  ['vite.config.ts', 'base: APP_PATH'],
  ['tools/wasm_release_package.mts', "RELEASE_BASENAME = 'sprout68k-wasm-tools-v1'"],
  ['tools/fetch_wasm_release.mts', 'ARCHIVE_NAME, MANIFEST_NAME'],
  ['.github/workflows/deploy-pages.yml', 'name: Deploy Sprout68k to GitHub Pages'],
  ['.github/workflows/deploy-pages.yml', 'node tools/fetch_wasm_release.mts'],
  ['docs/Release配布手順_20260822.md', '/uraraworks/Sprout68k/releases/download/wasm-tools-v1/'],
];
for (const [path, marker] of required) {
  if (!readFileSync(resolve(ROOT, path), 'utf8').includes(marker)) {
    throw new Error(`新ブランド識別子がありません: ${path}: ${marker}`);
  }
}

const retainedTotal = [...retainedCounts.values()].reduce((sum, count) => sum + count, 0);
console.log(`ブランド検証 PASS: 追跡${tracked.length}ファイル＋検査自身、基準器pathのみ${retainedTotal}件許可、新識別子${required.length}件`);
