import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { basename, resolve } from 'node:path';

export const RELEASE_BASENAME = 'x68kdev-wasm-tools-v1';
export const ARCHIVE_NAME = `${RELEASE_BASENAME}.tar.gz`;
export const MANIFEST_NAME = `${RELEASE_BASENAME}.manifest.json`;
const TOOL_PATTERN = /^m68k-elf-(?:cc1|as|ld|objcopy)\.memfs\.(?:js|wasm)$/;

export interface ReleaseFile { path: string; size: number; sha256: string }
export interface ReleaseManifest {
  version: 1;
  archive: { name: string; size: number; sha256: string; uncompressedSize: number };
  files: ReleaseFile[];
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function writeString(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error(`tar fieldが長すぎます: ${value}`);
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const octal = value.toString(8).padStart(length - 1, '0');
  if (octal.length >= length) throw new Error(`tar数値fieldが長すぎます: ${value}`);
  writeString(target, offset, length, `${octal}\0`);
}

function tarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  writeString(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, '0');
  writeString(header, 148, 8, `${checksumText}\0 `);
  return header;
}

export function createDeterministicArchive(files: Array<{ path: string; data: Uint8Array }>): { tar: Uint8Array; gzip: Uint8Array } {
  const chunks: Uint8Array[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    if (!TOOL_PATTERN.test(file.path) || basename(file.path) !== file.path) throw new Error(`archive pathが不正です: ${file.path}`);
    chunks.push(tarHeader(file.path, file.data.length), file.data);
    const padding = (512 - file.data.length % 512) % 512;
    if (padding) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  const tar = Buffer.concat(chunks);
  return { tar, gzip: gzipSync(tar, { level: 9, mtime: 0 }) };
}

export function parseArchive(archive: Uint8Array): Array<{ path: string; data: Uint8Array }> {
  const tar = gunzipSync(archive);
  const files: Array<{ path: string; data: Uint8Array }> = [];
  const seen = new Set<string>();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) { zeroBlocks += 1; if (zeroBlocks === 2) break; continue; }
    zeroBlocks = 0;
    const path = Buffer.from(header.subarray(0, 100)).toString('utf8').replace(/\0.*$/, '');
    const sizeText = Buffer.from(header.subarray(124, 136)).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!TOOL_PATTERN.test(path) || basename(path) !== path || seen.has(path) || header[156] !== '0'.charCodeAt(0)) {
      throw new Error(`archive entryが不正です: ${path}`);
    }
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.length) throw new Error(`archive sizeが不正です: ${path}`);
    seen.add(path);
    files.push({ path, data: tar.slice(offset, offset + size) });
    offset += Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks < 2) throw new Error('tar終端がありません');
  return files;
}

export function packageWasmTools(inputDirectory: string, outputDirectory: string): { manifest: ReleaseManifest; manifestSha256: string } {
  const names = readdirSync(inputDirectory).filter((name) => TOOL_PATTERN.test(name)).sort();
  if (names.length !== 8) throw new Error(`memfs wasm toolsは8ファイル必要です: ${names.length}`);
  const files = names.map((path) => ({ path, data: readFileSync(resolve(inputDirectory, path)) }));
  const { tar, gzip } = createDeterministicArchive(files);
  const manifest: ReleaseManifest = {
    version: 1,
    archive: { name: ARCHIVE_NAME, size: gzip.length, sha256: sha256(gzip), uncompressedSize: tar.length },
    files: files.map(({ path, data }) => ({ path, size: data.length, sha256: sha256(data) })),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(resolve(outputDirectory, ARCHIVE_NAME), gzip);
  writeFileSync(resolve(outputDirectory, MANIFEST_NAME), manifestBytes);
  return { manifest, manifestSha256: sha256(manifestBytes) };
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? resolve(process.argv[index + 1]) : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(import.meta.dirname, '..');
  const input = option('--input', resolve(root, 'build/wasm-tools'));
  const output = option('--output', resolve(root, 'build/release'));
  const result = packageWasmTools(input, output);
  const raw = result.manifest.files.reduce((sum, file) => sum + file.size, 0);
  console.log(`wasm release package: files=8 raw=${raw} tar=${result.manifest.archive.uncompressedSize} gzip=${result.manifest.archive.size}`);
  console.log(`archive sha256=${result.manifest.archive.sha256}`);
  console.log(`manifest sha256=${result.manifestSha256}`);
}
