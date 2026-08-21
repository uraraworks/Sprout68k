import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

interface Manifest {
  version: 1;
  files: ManifestFile[];
  totals: { files: number; size: number; gzipSize: number };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUTPUT = resolve(ROOT, 'build/web-assets');
const TOOLCHAIN = resolve(process.env.X68KDEV_TOOLCHAIN ?? resolve(homedir(), 'x68kdev-toolchain'));
const GCC_ROOT = resolve(TOOLCHAIN, 'lib/gcc');

function posix(path: string): string {
  return path.split(sep).join('/');
}

function filesBelow(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
}

function gccVersionRoot(): string {
  const targets = readdirSync(GCC_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (targets.length !== 1) throw new Error(`GCC target ディレクトリは1個である必要があります: ${GCC_ROOT}`);
  const targetRoot = resolve(GCC_ROOT, targets[0].name);
  const versions = readdirSync(targetRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (versions.length !== 1) throw new Error(`GCC version ディレクトリは1個である必要があります: ${targetRoot}`);
  return resolve(targetRoot, versions[0].name);
}

function copy(source: string, assetPath: string): void {
  const destination = resolve(OUTPUT, assetPath);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}

rmSync(OUTPUT, { recursive: true, force: true });
mkdirSync(OUTPUT, { recursive: true });

for (const directory of ['stage_c', 'stage_d', 'lib', 'samples/breakout']) {
  const sourceRoot = resolve(ROOT, directory);
  for (const source of filesBelow(sourceRoot)) copy(source, posix(relative(ROOT, source)));
}

// 学習者の freestanding C コードが利用する GCC 標準ヘッダ一式と、リンク時に
// 必要な既定(m68000)の libgcc.a を保存する。他CPU用ランタイム等は役割が異なる。
// GCC_EXEC_PREFIX が任意の展開ルートで同じ相対配置を解決できる相対配置にする。
const gccVersion = gccVersionRoot();
for (const directory of ['include', 'include-fixed']) {
  const sourceRoot = resolve(gccVersion, directory);
  for (const source of filesBelow(sourceRoot)) {
    const name = posix(relative(gccVersion, source));
    copy(source, posix(`toolchain/lib/gcc/${relative(GCC_ROOT, gccVersion)}/${name}`));
  }
}
copy(resolve(gccVersion, 'libgcc.a'), posix(`toolchain/lib/gcc/${relative(GCC_ROOT, gccVersion)}/libgcc.a`));

const files: ManifestFile[] = filesBelow(OUTPUT).map((file) => {
  const data = readFileSync(file);
  return {
    path: posix(relative(OUTPUT, file)),
    size: statSync(file).size,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
});
const manifest: Manifest = {
  version: 1,
  files,
  totals: {
    files: files.length,
    size: files.reduce((sum, file) => sum + file.size, 0),
    gzipSize: files.reduce((sum, file) => sum + gzipSync(readFileSync(resolve(OUTPUT, file.path))).length, 0),
  },
};
writeFileSync(resolve(OUTPUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`web assets: ${manifest.totals.files} files, ${manifest.totals.size} bytes, gzip ${manifest.totals.gzipSize} bytes`);
