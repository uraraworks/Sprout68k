import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const RESULT_DIR = resolve(ROOT, 'build/f2_wasm_verify');
const TOOLCHAIN = resolve(process.env.X68KDEV_TOOLCHAIN ?? resolve(homedir(), 'x68kdev-toolchain'));
const OBJDUMP = resolve(TOOLCHAIN, 'bin/m68k-elf-objdump');
const WASM_MODULES = {
  as: resolve(ROOT, 'build/wasm-tools/m68k-elf-as.js'),
  ld: resolve(ROOT, 'build/wasm-tools/m68k-elf-ld.js'),
  objcopy: resolve(ROOT, 'build/wasm-tools/m68k-elf-objcopy.js'),
};

const rows = [
  { no: 1, name: 'all_native', mode: 'cc1=native,as=native,ld=native,objcopy=native' },
  { no: 2, name: 'as_wasm', mode: 'cc1=native,as=wasm,ld=native,objcopy=native' },
  { no: 3, name: 'ld_wasm', mode: 'cc1=native,as=native,ld=wasm,objcopy=native' },
  { no: 4, name: 'objcopy_wasm', mode: 'cc1=native,as=native,ld=native,objcopy=wasm' },
  { no: 5, name: 'binutils_wasm', mode: 'cc1=native,as=wasm,ld=wasm,objcopy=wasm' },
] as const;

function requirePath(label: string, path: string): void {
  if (!existsSync(path)) throw new Error(`${label} が見つかりません: ${path}`);
}

function version(program: string, args: string[]): string {
  return execFileSync(program, args, { cwd: ROOT, encoding: 'utf8' }).split('\n')[0];
}

function runBuild(row: typeof rows[number], target: 'stage_c' | 'breakout'): void {
  const rowDir = resolve(RESULT_DIR, row.name);
  mkdirSync(rowDir, { recursive: true });
  execFileSync(process.execPath, [resolve(HERE, 'build.mts'), target, resolve(rowDir, `${target}.xdf`), '--mode', row.mode], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      X68KDEV_TOOLCHAIN: TOOLCHAIN,
      X68KDEV_DRIVER_BUILD_ROOT: resolve(rowDir, 'objects'),
      X68KDEV_AS_WASM_JS: WASM_MODULES.as,
      X68KDEV_LD_WASM_JS: WASM_MODULES.ld,
      X68KDEV_OBJCOPY_WASM_JS: WASM_MODULES.objcopy,
    },
  });
}

function filesWithSuffix(root: string, suffix: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
}

function firstCmpDifference(left: string, right: string): string {
  const result = spawnSync('cmp', ['-l', left, right], { encoding: 'utf8' });
  const first = result.stdout.trim().split('\n')[0];
  if (first) {
    const [position, leftByte, rightByte] = first.trim().split(/\s+/);
    return `cmp -l: 1始まりoffset=${position}, native=${leftByte}(8進), test=${rightByte}(8進)`;
  }
  const a = readFileSync(left);
  const b = readFileSync(right);
  return `cmp -l: 共通部分は一致、size native=${a.length}, test=${b.length}`;
}

function firstObjdumpDifference(left: string, right: string): string | undefined {
  if (!left.endsWith('.o') && !left.endsWith('.elf')) return undefined;
  const args = ['-drs', left];
  const leftDump = execFileSync(OBJDUMP, args, { encoding: 'utf8' }).split('\n');
  const rightDump = execFileSync(OBJDUMP, ['-drs', right], { encoding: 'utf8' }).split('\n');
  const count = Math.max(leftDump.length, rightDump.length);
  for (let index = 0; index < count; index += 1) {
    const a = leftDump[index]?.replace(left, '<FILE>');
    const b = rightDump[index]?.replace(right, '<FILE>');
    if (a !== b) return `objdump -drs: line=${index + 1}, native=${JSON.stringify(a)}, test=${JSON.stringify(b)}`;
  }
  return 'objdump -drs: 表示内容は一致（ELFメタデータ差の可能性）';
}

interface Comparison {
  ok: boolean;
  details: string[];
}

function compareTarget(row: typeof rows[number], target: 'stage_c' | 'breakout'): Comparison {
  const nativeDir = resolve(RESULT_DIR, rows[0].name);
  const testDir = resolve(RESULT_DIR, row.name);
  const nativeObjects = resolve(nativeDir, 'objects', target);
  const testObjects = resolve(testDir, 'objects', target);
  const pairs: Array<{ stage: string; left: string; right: string }> = [];
  for (const [stage, suffix] of [['.o', '.o'], ['.elf', '.elf'], ['.bin', '.bin']] as const) {
    for (const left of filesWithSuffix(nativeObjects, suffix)) {
      const rel = relative(nativeObjects, left);
      pairs.push({ stage, left, right: resolve(testObjects, rel) });
    }
  }
  pairs.push({
    stage: '.xdf',
    left: resolve(nativeDir, `${target}.xdf`),
    right: resolve(testDir, `${target}.xdf`),
  });

  const details: string[] = [];
  for (const pair of pairs) {
    if (!existsSync(pair.right)) {
      details.push(`${pair.stage} 欠落: ${relative(ROOT, pair.right)}`);
      continue;
    }
    if (readFileSync(pair.left).equals(readFileSync(pair.right))) continue;
    const rel = pair.stage === '.xdf' ? `${target}.xdf` : relative(nativeObjects, pair.left);
    details.push(`${pair.stage} 最初の不一致ファイル: ${rel}; ${firstCmpDifference(pair.left, pair.right)}`);
    const dump = firstObjdumpDifference(pair.left, pair.right);
    if (dump) details.push(dump);
    break;
  }
  return { ok: details.length === 0, details };
}

for (const [label, path] of Object.entries(WASM_MODULES)) requirePath(`${label} wasm JS`, path);
requirePath('native objdump', OBJDUMP);
const nativeAsVersion = version(resolve(TOOLCHAIN, 'bin/m68k-elf-as'), ['--version']);
if (!nativeAsVersion.includes('2.44')) throw new Error(`native as が binutils 2.44 ではありません: ${nativeAsVersion}`);
for (const [label, path] of Object.entries(WASM_MODULES)) {
  const wasmVersion = version(process.execPath, [path, '--version']);
  if (!wasmVersion.includes('2.44')) throw new Error(`${label} wasm が binutils 2.44 ではありません: ${wasmVersion}`);
}
console.log(`native基準器: ${nativeAsVersion}`);
rmSync(RESULT_DIR, { recursive: true, force: true });
mkdirSync(RESULT_DIR, { recursive: true });

for (const row of rows) {
  for (const target of ['stage_c', 'breakout'] as const) runBuild(row, target);
}

let failed = false;
for (const row of rows) {
  for (const target of ['stage_c', 'breakout'] as const) {
    const result = row.no === 1 ? { ok: true, details: [] } : compareTarget(row, target);
    console.log(`#${row.no} ${target}: ${result.ok ? 'PASS(基準と全成果物バイト一致)' : 'FAIL(不一致)'}`);
    for (const detail of result.details) console.log(`  ${detail}`);
    failed ||= !result.ok;
  }
}
if (failed) throw new Error('F-2 wasm 混成比較 FAIL');
console.log('F-2 wasm 混成比較 PASS');
