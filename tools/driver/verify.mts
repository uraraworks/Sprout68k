import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const RESULT_DIR = resolve(ROOT, 'build/f3_driver');
mkdirSync(RESULT_DIR, { recursive: true });

function run(program: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync(program, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
}

function expectSame(label: string, left: string, right: string): void {
  const a = readFileSync(left);
  const b = readFileSync(right);
  if (!a.equals(b)) throw new Error(`FAIL(不一致): ${label}`);
  console.log(`PASS(バイト一致): ${label} (${a.length} bytes)`);
}

function expectDifferent(label: string, left: string, right: string): void {
  const a = readFileSync(left);
  const b = readFileSync(right);
  if (a.equals(b)) throw new Error(`FAIL(陽性対照が一致): ${label}`);
  console.log(`PASS(陽性対照は不一致): ${label}`);
}

const nativeBuildRoot = resolve(RESULT_DIR, 'native_objects');
const positiveBuildRoot = resolve(RESULT_DIR, 'positive_objects');
for (const target of ['stage_c', 'breakout'] as const) {
  // 比較相手は gcc driver 経由の既存ビルドスクリプトにする。
  // tools/build_via_cc1.sh は駆動層のラッパーになったため、そちらと比べても
  // 同語反復にしかならない(実際に一度その形になっていた)。
  const shellOutput = resolve(RESULT_DIR, `${target}_gccdriver.xdf`);
  const driverOutput = resolve(RESULT_DIR, `${target}_driver.xdf`);
  const gccDriverScript = target === 'stage_c'
    ? { path: 'tools/build_stage_c.sh', args: ['0xFFFF', shellOutput] }
    : { path: 'tools/build_breakout_plain.sh', args: [shellOutput] };
  run(resolve(ROOT, gccDriverScript.path), gccDriverScript.args);
  run('node', [resolve(HERE, 'build.mts'), target, driverOutput], {
    SPROUT68K_DRIVER_BUILD_ROOT: nativeBuildRoot,
  });
  expectSame(`${target}: gcc driver 経由 対 全native駆動層`, shellOutput, driverOutput);
}

const positiveOutput = resolve(RESULT_DIR, 'stage_c_positive_o0.xdf');
run('node', [resolve(HERE, 'build.mts'), 'stage_c', positiveOutput], {
  CC1_OPT_LEVEL: '-O0',
  SPROUT68K_DRIVER_BUILD_ROOT: positiveBuildRoot,
});
expectDifferent(
  'stage_c: 駆動層の -Os 対 -O0',
  resolve(RESULT_DIR, 'stage_c_driver.xdf'),
  positiveOutput,
);

console.log('F-3 駆動層検証 PASS');

