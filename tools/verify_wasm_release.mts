import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  ARCHIVE_NAME, MANIFEST_NAME, createDeterministicArchive, packageWasmTools, parseArchive, sha256,
} from './wasm_release_package.mts';
import type { ReleaseManifest } from './wasm_release_package.mts';
import { fetchWasmRelease } from './fetch_wasm_release.mts';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = resolve(ROOT, 'build/wasm-tools');
const temporary = mkdtempSync(resolve(tmpdir(), 'x68kdev-release-verify-'));
try {
  const first = resolve(temporary, 'first');
  const second = resolve(temporary, 'second');
  const firstResult = packageWasmTools(SOURCE, first);
  const secondResult = packageWasmTools(SOURCE, second);
  const archiveA = readFileSync(resolve(first, ARCHIVE_NAME));
  const archiveB = readFileSync(resolve(second, ARCHIVE_NAME));
  if (!archiveA.equals(archiveB) || firstResult.manifestSha256 !== secondResult.manifestSha256) throw new Error('同一入力のpackageがバイト一致しません');
  console.log(`PASS(再現性): archive sha256=${firstResult.manifest.archive.sha256}`);

  const installed = resolve(temporary, 'installed');
  // directoryではなくarchiveそのもののlocal file pathを渡し、sidecarを同じ場所から解決する。
  const manifest = await fetchWasmRelease({ source: resolve(first, ARCHIVE_NAME), output: installed, manifestSha256: firstResult.manifestSha256 });
  for (const file of manifest.files) {
    if (!readFileSync(resolve(SOURCE, file.path)).equals(readFileSync(resolve(installed, file.path)))) throw new Error(`取得結果が元fileと不一致: ${file.path}`);
  }
  console.log('PASS(一巡): local package -> manifest/archive検証 -> 展開、8ファイルが元とバイト一致');

  const byteFault = resolve(temporary, 'byte-fault');
  packageWasmTools(SOURCE, byteFault);
  const corrupt = readFileSync(resolve(byteFault, ARCHIVE_NAME));
  corrupt[Math.floor(corrupt.length / 2)] ^= 1;
  writeFileSync(resolve(byteFault, ARCHIVE_NAME), corrupt);
  let byteRejected = false;
  try { await fetchWasmRelease({ source: byteFault, output: resolve(temporary, 'bad-byte-out'), manifestSha256: firstResult.manifestSha256 }); }
  catch (error) { byteRejected = String(error).includes('archive SHA-256'); console.log(`PASS(故障注入1): ${String(error)}`); }
  if (!byteRejected) throw new Error('archive 1バイト破損を検出できません');

  const missingFault = resolve(temporary, 'missing-fault');
  packageWasmTools(SOURCE, missingFault);
  const originalManifest = JSON.parse(readFileSync(resolve(missingFault, MANIFEST_NAME), 'utf8')) as ReleaseManifest;
  const entries = parseArchive(readFileSync(resolve(missingFault, ARCHIVE_NAME))).slice(0, -1);
  const missingArchive = createDeterministicArchive(entries);
  writeFileSync(resolve(missingFault, ARCHIVE_NAME), missingArchive.gzip);
  originalManifest.archive = {
    ...originalManifest.archive, size: missingArchive.gzip.length,
    uncompressedSize: missingArchive.tar.length, sha256: sha256(missingArchive.gzip),
  };
  const missingManifestBytes = Buffer.from(`${JSON.stringify(originalManifest, null, 2)}\n`);
  writeFileSync(resolve(missingFault, MANIFEST_NAME), missingManifestBytes);
  let missingRejected = false;
  try {
    await fetchWasmRelease({ source: missingFault, output: resolve(temporary, 'missing-out'), manifestSha256: sha256(missingManifestBytes) });
  } catch (error) {
    missingRejected = String(error).includes('archive file数不一致') || String(error).includes('archiveにありません');
    console.log(`PASS(故障注入2): ${String(error)}`);
  }
  if (!missingRejected) throw new Error('manifest記載fileの欠落を検出できません');

  const raw = manifest.files.reduce((sum, file) => sum + file.size, 0);
  console.log(`wasm release検証 PASS: raw=${raw}, tar=${manifest.archive.uncompressedSize}, gzip=${manifest.archive.size}, manifest-sha256=${firstResult.manifestSha256}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
