import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { dirname, extname, relative, resolve, sep } from 'node:path';
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
const REFERENCE_OUTPUT = resolve(ROOT, 'build/web-assets-reference');
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
rmSync(REFERENCE_OUTPUT, { recursive: true, force: true });
mkdirSync(OUTPUT, { recursive: true });
mkdirSync(REFERENCE_OUTPUT, { recursive: true });

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
  // README等を「今回参照されないから」ではなく、コンパイル入力となるヘッダでは
  // ないから除外する。将来追加される文書類も同じ役割基準で束へ入れない。
  for (const source of filesBelow(sourceRoot).filter((file) => extname(file) === '.h')) {
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
const unsafeFetchPaths = files
  .map((file) => file.path)
  // ViteのSPA fallbackで200のindex.htmlへ化け得る、拡張子なし（末尾dotも含む）の
  // 配信パスを生成段階で拒否する。manifest検査まで不正応答を持ち越さない。
  .filter((path) => !extname(path) || extname(path) === '.');
if (unsafeFetchPaths.length > 0) {
  throw new Error(`dev server のfallback対象になり得る配信パスがあります: ${unsafeFetchPaths.join(', ')}`);
}
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

// ブラウザ側の判定値は生成物から独立したネイティブ gcc driver 正典で毎回作る。
// ハッシュをページやこのスクリプトへ固定値として埋め込まない。
const referenceOutputs = {
  stage_c: resolve(REFERENCE_OUTPUT, 'stage_c.xdf'),
  breakout: resolve(REFERENCE_OUTPUT, 'breakout.xdf'),
};
const nativeEnv = { ...process.env, PATH: `${resolve(TOOLCHAIN, 'bin')}:${process.env.PATH ?? ''}` };
execFileSync(resolve(ROOT, 'tools/build_stage_c.sh'), ['0xFFFF', referenceOutputs.stage_c], {
  cwd: ROOT, stdio: 'inherit', env: nativeEnv,
});
execFileSync(resolve(ROOT, 'tools/build_breakout_plain.sh'), [referenceOutputs.breakout], {
  cwd: ROOT, stdio: 'inherit', env: nativeEnv,
});
const expected = {
  version: 1,
  targets: Object.fromEntries(Object.entries(referenceOutputs).map(([target, file]) => {
    const data = readFileSync(file);
    return [target, { sha256: createHash('sha256').update(data).digest('hex'), size: data.length }];
  })),
};
writeFileSync(resolve(OUTPUT, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
console.log(`web assets: ${manifest.totals.files} files, ${manifest.totals.size} bytes, gzip ${manifest.totals.gzipSize} bytes`);
console.log(`expected SHA-256: stage_c=${expected.targets.stage_c.sha256}, breakout=${expected.targets.breakout.sha256}`);
