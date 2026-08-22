import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ARCHIVE_NAME, MANIFEST_NAME, parseArchive, sha256 } from './wasm_release_package.mts';
import type { ReleaseManifest } from './wasm_release_package.mts';

async function readSource(source: string, name: string): Promise<Uint8Array> {
  if (/^https?:\/\//.test(source)) {
    const base = source.endsWith('/') ? source : `${source}/`;
    const response = await fetch(new URL(name, base));
    if (!response.ok) throw new Error(`${response.url}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  const path = statSync(source).isDirectory() ? resolve(source, name) : resolve(dirname(source), name);
  return readFileSync(path);
}

export async function fetchWasmRelease(options: { source: string; output: string; manifestSha256: string }): Promise<ReleaseManifest> {
  const manifestBytes = await readSource(options.source, MANIFEST_NAME);
  const actualManifestHash = sha256(manifestBytes);
  if (actualManifestHash !== options.manifestSha256) throw new Error(`manifest SHA-256不一致: actual=${actualManifestHash}`);
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as ReleaseManifest;
  if (manifest.version !== 1 || manifest.archive.name !== ARCHIVE_NAME || manifest.files.length !== 8) throw new Error('release manifestの構造が不正です');
  const archive = await readSource(options.source, ARCHIVE_NAME);
  if (archive.length !== manifest.archive.size || sha256(archive) !== manifest.archive.sha256) throw new Error('archive SHA-256またはsize不一致');
  const extracted = parseArchive(archive);
  const byPath = new Map(extracted.map((file) => [file.path, file.data]));
  if (byPath.size !== manifest.files.length) throw new Error(`archive file数不一致: ${byPath.size}`);
  for (const file of manifest.files) {
    const data = byPath.get(file.path);
    if (!data) throw new Error(`manifest記載fileがarchiveにありません: ${file.path}`);
    if (data.length !== file.size || sha256(data) !== file.sha256) throw new Error(`file SHA-256またはsize不一致: ${file.path}`);
  }
  for (const path of byPath.keys()) if (!manifest.files.some((file) => file.path === path)) throw new Error(`manifestにないfileがあります: ${path}`);

  const stage = mkdtempSync(resolve(tmpdir(), 'sprout68k-wasm-release-'));
  try {
    for (const file of manifest.files) writeFileSync(resolve(stage, file.path), byPath.get(file.path)!);
    mkdirSync(options.output, { recursive: true });
    for (const name of readdirSync(options.output).filter((name) => /^m68k-elf-(?:cc1|as|ld|objcopy)\.memfs\.(?:js|wasm)$/.test(name))) {
      rmSync(resolve(options.output, name));
    }
    for (const file of manifest.files) cpSync(resolve(stage, file.path), resolve(options.output, file.path));
  } finally { rmSync(stage, { recursive: true, force: true }); }
  console.log(`wasm release verified: ${manifest.files.length} files, archive sha256=${manifest.archive.sha256}`);
  return manifest;
}

function required(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} が必要です`);
  return process.argv[index + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await fetchWasmRelease({
    source: required('--source'), output: resolve(required('--output')),
    manifestSha256: required('--manifest-sha256').toLowerCase(),
  });
}
