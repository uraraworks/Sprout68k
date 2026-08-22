import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = resolve(ROOT, 'build/web-assets');
const OUTPUT = resolve(ROOT, 'deploy/web-assets');
const manifest = JSON.parse(readFileSync(resolve(SOURCE, 'manifest.json'), 'utf8')) as {
  version: number; files: Array<{ path: string; size: number; sha256: string }>;
};
if (manifest.version !== 1) throw new Error('web-assets manifestの版が不正です');
for (const entry of manifest.files) {
  const file = resolve(SOURCE, entry.path);
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (statSync(file).size !== entry.size || hash !== entry.sha256) throw new Error(`manifest不一致: ${entry.path}`);
}
rmSync(OUTPUT, { recursive: true, force: true });
mkdirSync(dirname(OUTPUT), { recursive: true });
cpSync(SOURCE, OUTPUT, { recursive: true });
console.log(`web-assets snapshot: ${manifest.files.length} manifest files + manifest/expected`);
