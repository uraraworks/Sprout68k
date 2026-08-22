import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeHostFs } from './node_hostfs.mts';
import { createNodeToolExecutors } from './node_runner.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const RESULT_DIR = resolve(ROOT, 'build/f2_wasm_verify');
const TOOLCHAIN = resolve(process.env.SPROUT68K_TOOLCHAIN ?? resolve(homedir(), 'x68kdev-toolchain'));
const OBJDUMP = resolve(TOOLCHAIN, 'bin/m68k-elf-objdump');
const wasmTool = (name: string): string => {
  const named = resolve(ROOT, `build/wasm-tools/m68k-elf-${name}.noderawfs.js`);
  return existsSync(named) ? named : resolve(ROOT, `build/wasm-tools/m68k-elf-${name}.js`);
};
const WASM_MODULES = {
  cc1: wasmTool('cc1'),
  as: wasmTool('as'),
  ld: wasmTool('ld'),
  objcopy: wasmTool('objcopy'),
};
const MEMFS_MODULES = {
  cc1: resolve(ROOT, 'build/wasm-tools/m68k-elf-cc1.memfs.js'),
  as: resolve(ROOT, 'build/wasm-tools/m68k-elf-as.memfs.js'),
  ld: resolve(ROOT, 'build/wasm-tools/m68k-elf-ld.memfs.js'),
  objcopy: resolve(ROOT, 'build/wasm-tools/m68k-elf-objcopy.memfs.js'),
};

const rows = [
  { no: 1, name: 'all_native', mode: 'cc1=native,as=native,ld=native,objcopy=native' },
  { no: 2, name: 'as_wasm', mode: 'cc1=native,as=wasm,ld=native,objcopy=native' },
  { no: 3, name: 'ld_wasm', mode: 'cc1=native,as=native,ld=wasm,objcopy=native' },
  { no: 4, name: 'objcopy_wasm', mode: 'cc1=native,as=native,ld=native,objcopy=wasm' },
  { no: 5, name: 'binutils_wasm', mode: 'cc1=native,as=wasm,ld=wasm,objcopy=wasm' },
  { no: 6, name: 'cc1_wasm', mode: 'cc1=wasm,as=native,ld=native,objcopy=native' },
  { no: 7, name: 'all_wasm', mode: 'cc1=wasm,as=wasm,ld=wasm,objcopy=wasm' },
  { no: 8, name: 'all_memfs', mode: 'cc1=memfs,as=memfs,ld=memfs,objcopy=memfs' },
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
  // cc1 の Emscripten JS は一部の Node/Emscripten 組合せで TTY ioctl に失敗するため、
  // 検証子プロセスの出力は pipe で受け、内容をそのまま転送する。
  const result = spawnSync(process.execPath, [resolve(HERE, 'build.mts'), target, resolve(rowDir, `${target}.xdf`), '--mode', row.mode], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      SPROUT68K_TOOLCHAIN: TOOLCHAIN,
      // wasm cc1 だけを、基準器と同じGCC内部ヘッダへ向ける。
      // GCC_EXEC_PREFIX は末尾の / が必須。
      SPROUT68K_CC1_GCC_EXEC_PREFIX: `${resolve(TOOLCHAIN, 'lib/gcc')}/`,
      SPROUT68K_DRIVER_BUILD_ROOT: resolve(rowDir, 'objects'),
      SPROUT68K_CC1_WASM_JS: WASM_MODULES.cc1,
      SPROUT68K_AS_WASM_JS: WASM_MODULES.as,
      SPROUT68K_LD_WASM_JS: WASM_MODULES.ld,
      SPROUT68K_OBJCOPY_WASM_JS: WASM_MODULES.objcopy,
      SPROUT68K_CC1_MEMFS_JS: MEMFS_MODULES.cc1,
      SPROUT68K_AS_MEMFS_JS: MEMFS_MODULES.as,
      SPROUT68K_LD_MEMFS_JS: MEMFS_MODULES.ld,
      SPROUT68K_OBJCOPY_MEMFS_JS: MEMFS_MODULES.objcopy,
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`#${row.no} ${target} のビルドが終了コード ${result.status ?? '不明'} で失敗しました`);
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

function objdumpDiagnosis(left: string, right: string, reportStem: string): string[] {
  if (!left.endsWith('.o') && !left.endsWith('.elf')) return [];
  const normalizedDump = (file: string, args: string[]): string =>
    execFileSync(OBJDUMP, [...args, file], { encoding: 'utf8' }).replaceAll(file, '<FILE>');
  const leftCode = normalizedDump(left, ['-d']);
  const rightCode = normalizedDump(right, ['-d']);
  if (leftCode === rightCode) {
    return ['objdump -d: 生成コードは一致（コード以外のELFメタ情報が不一致）'];
  }

  const leftPath = `${reportStem}.native.objdump-d.txt`;
  const rightPath = `${reportStem}.test.objdump-d.txt`;
  const diffPath = `${reportStem}.objdump-d.diff`;
  writeFileSync(leftPath, leftCode);
  writeFileSync(rightPath, rightCode);
  const diff = spawnSync('diff', ['-u', leftPath, rightPath], { encoding: 'utf8' });
  writeFileSync(diffPath, diff.stdout ?? '');
  const leftDump = leftCode.split('\n');
  const rightDump = rightCode.split('\n');
  const count = Math.max(leftDump.length, rightDump.length);
  for (let index = 0; index < count; index += 1) {
    const a = leftDump[index];
    const b = rightDump[index];
    if (a !== b) {
      return [
        `objdump -d: 生成コードが不一致; line=${index + 1}, native=${JSON.stringify(a)}, test=${JSON.stringify(b)}`,
        `逆アセンブル差分: ${relative(ROOT, diffPath)}`,
      ];
    }
  }
  return ['objdump -d: 生成コードが不一致'];
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
    if (pair.stage === '.o') {
      const reportStem = resolve(testDir, `${target}-${relative(nativeObjects, pair.left).replaceAll('/', '_')}`);
      details.push(...objdumpDiagnosis(pair.left, pair.right, reportStem));
    }
    break;
  }
  return { ok: details.length === 0, details };
}

function verifyCc1FaultInjection(): void {
  const wasm = WASM_MODULES.cc1.replace(/\.js$/, '.wasm');
  requirePath('cc1 wasm本体', wasm);
  const originalMode = statSync(wasm).mode & 0o777;
  const faultDir = resolve(RESULT_DIR, 'fault_cc1_unreadable');
  mkdirSync(faultDir, { recursive: true });
  let result: ReturnType<typeof spawnSync> | undefined;
  try {
    chmodSync(wasm, 0o000);
    result = spawnSync(process.execPath, [resolve(HERE, 'build.mts'), 'stage_c', resolve(faultDir, 'stage_c.xdf'), '--mode', rows[5].mode], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        SPROUT68K_TOOLCHAIN: TOOLCHAIN,
        SPROUT68K_CC1_GCC_EXEC_PREFIX: `${resolve(TOOLCHAIN, 'lib/gcc')}/`,
        SPROUT68K_DRIVER_BUILD_ROOT: resolve(faultDir, 'objects'),
        SPROUT68K_CC1_WASM_JS: WASM_MODULES.cc1,
        SPROUT68K_AS_WASM_JS: WASM_MODULES.as,
        SPROUT68K_LD_WASM_JS: WASM_MODULES.ld,
        SPROUT68K_OBJCOPY_WASM_JS: WASM_MODULES.objcopy,
      },
    });
  } finally {
    chmodSync(wasm, originalMode);
  }
  if (!result) throw new Error('故障注入FAIL: #6の実行結果を取得できませんでした');
  if (result.status === 0) throw new Error('故障注入FAIL: cc1.wasmを読めなくしても#6が成功（nativeへの黙示fallback疑い）');
  console.log(`故障注入 PASS: cc1.wasm mode=000 で#6が失敗し、mode=${originalMode.toString(8)}へ復元`);
}

function verifyMemfsFaultInjection(): void {
  const wasm = MEMFS_MODULES.cc1.replace(/\.js$/, '.wasm');
  requirePath('memfs cc1 wasm本体', wasm);
  const originalMode = statSync(wasm).mode & 0o777;
  const faultDir = resolve(RESULT_DIR, 'fault_memfs_cc1_unreadable');
  mkdirSync(faultDir, { recursive: true });
  let result: ReturnType<typeof spawnSync> | undefined;
  try {
    chmodSync(wasm, 0o000);
    result = spawnSync(process.execPath, [resolve(HERE, 'build.mts'), 'stage_c', resolve(faultDir, 'stage_c.xdf'), '--mode', rows[7].mode], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        SPROUT68K_TOOLCHAIN: TOOLCHAIN,
        SPROUT68K_CC1_GCC_EXEC_PREFIX: `${resolve(TOOLCHAIN, 'lib/gcc')}/`,
        SPROUT68K_DRIVER_BUILD_ROOT: resolve(faultDir, 'objects'),
        SPROUT68K_CC1_MEMFS_JS: MEMFS_MODULES.cc1,
        SPROUT68K_AS_MEMFS_JS: MEMFS_MODULES.as,
        SPROUT68K_LD_MEMFS_JS: MEMFS_MODULES.ld,
        SPROUT68K_OBJCOPY_MEMFS_JS: MEMFS_MODULES.objcopy,
      },
    });
  } finally {
    chmodSync(wasm, originalMode);
  }
  if (!result) throw new Error('故障注入FAIL: #8の実行結果を取得できませんでした');
  if (result.status === 0) throw new Error('故障注入FAIL: memfs cc1.wasmを読めなくしても#8が成功（黙示fallback疑い）');
  console.log(`故障注入 PASS: memfs cc1.wasm mode=000 で#8が失敗し、mode=${originalMode.toString(8)}へ復元`);
}

async function verifyMemfsCallMainAndFreshInstances(): Promise<void> {
  const probeDir = resolve(RESULT_DIR, 'memfs_runtime_probe');
  mkdirSync(probeDir, { recursive: true });
  const runner = createNodeToolExecutors({
    modes: { cc1: 'native', as: 'memfs', ld: 'native', objcopy: 'native' },
    hostFs: new NodeHostFs(), root: ROOT, memfsModules: MEMFS_MODULES,
  });
  let invalidRejected = false;
  const exitCodeBeforeFault = process.exitCode;
  try {
    await runner.run({ tool: 'as', program: '', cwd: ROOT, args: ['--sprout68k-invalid-option'] });
  } catch (error) {
    invalidRejected = error instanceof Error && error.message.includes('callMain が失敗しました')
      && String(error.cause).includes('終了コード 1');
  } finally {
    // 意図的な callMain 失敗で Emscripten が設定した終了コードを持ち越さない。
    process.exitCode = exitCodeBeforeFault;
  }
  if (!invalidRejected) throw new Error('memfs callMain 故障検査FAIL: 不正引数の非0終了を捕捉できませんでした');

  const source = resolve(probeDir, 'probe.s');
  const first = resolve(probeDir, 'first.o');
  const second = resolve(probeDir, 'second.o');
  writeFileSync(source, '.text\n\tnop\n');
  await runner.run({ tool: 'as', program: '', cwd: ROOT, args: ['-mcpu=68000', '-o', first, source] });
  await runner.run({ tool: 'as', program: '', cwd: ROOT, args: ['-mcpu=68000', '-o', second, source] });
  if (!readFileSync(first).equals(readFileSync(second))) {
    throw new Error('memfs factory 再生成検査FAIL: 同じrunnerの連続実行で出力が一致しません');
  }
  console.log('memfs駆動 PASS: callMainの非0戻り値を捕捉、同じrunnerでfactoryを2回生成して連続実行成功');
}

for (const [label, path] of Object.entries(WASM_MODULES)) requirePath(`${label} wasm JS`, path);
requirePath('cc1 wasm本体', WASM_MODULES.cc1.replace(/\.js$/, '.wasm'));
requirePath('native objdump', OBJDUMP);
const nativeAsVersion = version(resolve(TOOLCHAIN, 'bin/m68k-elf-as'), ['--version']);
if (!nativeAsVersion.includes('2.44')) throw new Error(`native as が binutils 2.44 ではありません: ${nativeAsVersion}`);
for (const [label, path] of Object.entries(WASM_MODULES).filter(([label]) => label !== 'cc1')) {
  const wasmVersion = version(process.execPath, [path, '--version']);
  if (!wasmVersion.includes('2.44')) throw new Error(`${label} wasm が binutils 2.44 ではありません: ${wasmVersion}`);
}
console.log(`native基準器: ${nativeAsVersion}`);
rmSync(RESULT_DIR, { recursive: true, force: true });
mkdirSync(RESULT_DIR, { recursive: true });

verifyCc1FaultInjection();

const missingMemfs = Object.entries(MEMFS_MODULES).flatMap(([label, js]) =>
  [js, js.replace(/\.js$/, '.wasm')]
    .filter((path) => !existsSync(path))
    .map((path) => `${label}:${relative(ROOT, path)}`));
const runnableRows = missingMemfs.length === 0 ? rows : rows.filter((row) => row.no !== 8);
if (missingMemfs.length > 0) {
  console.log(`#8 stage_c/breakout: SKIP(memfs版未ビルド: ${missingMemfs.join(', ')})`);
} else {
  verifyMemfsFaultInjection();
  await verifyMemfsCallMainAndFreshInstances();
}

for (const row of runnableRows) {
  for (const target of ['stage_c', 'breakout'] as const) runBuild(row, target);
}

let failed = false;
for (const row of runnableRows) {
  for (const target of ['stage_c', 'breakout'] as const) {
    const result = row.no === 1 ? { ok: true, details: [] } : compareTarget(row, target);
    console.log(`#${row.no} ${target}: ${result.ok ? 'PASS(基準と全成果物バイト一致)' : 'FAIL(不一致)'}`);
    for (const detail of result.details) console.log(`  ${detail}`);
    failed ||= !result.ok;
  }
}
if (failed) throw new Error('wasm 混成比較 FAIL');
console.log(`wasm 混成比較 PASS（実行=${runnableRows.length}構成、スキップ=${rows.length - runnableRows.length}構成）`);
