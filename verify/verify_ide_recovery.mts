/* 実px68kで無表示プログラムからhelloへ復帰し、保存済み／未保存ソースの不変を検証する。 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { createRecoveryController } from '../ide/recovery-controller.mjs';
import { LibretroHost } from '../ide/px68k/libretro-host.ts';
import { build } from '../tools/driver/builder.mts';
import { NodeHostFs } from '../tools/driver/node_hostfs.mts';
import { createNodeToolExecutors } from '../tools/driver/node_runner.mts';
import { resolveNativeToolchain } from '../tools/driver/toolchain.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CORE_JS = resolve(ROOT, 'ide/core/px68k_libretro.js');
const IPL = new Uint8Array(readFileSync(resolve(ROOT, 'ide/system/iplrom.dat')));
const CGROM = new Uint8Array(readFileSync(resolve(ROOT, 'ide/system/cgrom.dat')));
const RESULT = resolve(ROOT, 'build/ide_recovery_verify');
const EXPECTED = 'HELLO X68000';

function loadFactory(): (options?: Record<string, unknown>) => Promise<any> {
  (globalThis as Record<string, unknown>).__BUILD_ID__ = 'node-direct';
  const source = readFileSync(CORE_JS, 'utf8');
  const cjs: { exports: any } = { exports: {} };
  const wrapper = runInThisContext(
    `(function (module, exports, require, __filename, __dirname) { ${source}\n})`,
    { filename: CORE_JS },
  ) as Function;
  wrapper(cjs, cjs.exports, createRequire(CORE_JS), CORE_JS, dirname(CORE_JS));
  const factory = typeof cjs.exports === 'function' ? cjs.exports : cjs.exports.default;
  if (typeof factory !== 'function') throw new Error('px68k factoryを取得できません');
  return (options = {}) => factory({
    ...options,
    locateFile: (path: string, scriptDirectory: string) => `${scriptDirectory}${path}`,
  });
}

async function buildUser(name: string, content: string): Promise<Uint8Array> {
  process.env.X68KDEV_TOOLCHAIN ??= resolve(homedir(), 'x68kdev-toolchain');
  const hostFs = new NodeHostFs();
  const executors = createNodeToolExecutors({
    modes: { cc1: 'native', as: 'native', ld: 'native', objcopy: 'native' },
    hostFs, root: ROOT,
  });
  const output = resolve(RESULT, `${name}.xdf`);
  await build({
    target: 'user', output, root: ROOT, hostFs, tools: resolveNativeToolchain(), executors,
    buildRoot: resolve(RESULT, `${name}_objects`), userSource: { path: `${name}.c`, content },
  });
  return hostFs.readFile(output);
}

class NodeEmulator {
  host: LibretroHost | null = null;
  boots = 0;

  async stop(): Promise<{ ok: true }> {
    if (this.host) {
      try { this.host.unloadGame(); } catch {}
      this.host.dispose();
      this.host = null;
    }
    return { ok: true };
  }

  async run({ xdf }: { xdf: Uint8Array }): Promise<{ ok: true }> {
    await this.stop();
    (globalThis as any).window = { PX68K: loadFactory() };
    const context = {
      createImageData(width: number, height: number) {
        const w = Math.max(0, width | 0);
        const h = Math.max(0, height | 0);
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      },
      putImageData() {}, clearRect() {},
    };
    const canvas = { width: 0, height: 0, getContext: () => context } as any;
    const host = new LibretroHost(canvas, () => {});
    host.setCoreOption('px68k_cpuspeed', '16Mhz');
    host.setCoreOption('px68k_ramsize', '1MB');
    host.setCoreOption('px68k_no_wait_mode', 'enabled');
    await host.init(IPL, CGROM);
    const diskPath = host.writeDiskImage('recovery.xdf', xdf);
    host.writeFile('/game/boot.cmd', new TextEncoder().encode(`px68k "${diskPath}" ""\n`));
    if (!host.loadGame('/game/boot.cmd')) throw new Error('loadGame失敗');
    host.fetchAvInfo();
    this.host = host;
    this.boots++;
    return { ok: true };
  }

  runFrames(count: number): void {
    if (!this.host) throw new Error('未実行です');
    for (let frame = 0; frame < count; frame++) this.host.runFrame();
  }

  readText(): string {
    if (!this.host) return '';
    const dump = this.host.readTextScreen();
    return dump.available ? dump.lines.join('\n') : '';
  }
}

const helloSource = readFileSync(resolve(ROOT, 'ide/samples/hello.c'), 'utf8');
const helloXdf = await buildUser('hello', helloSource);
const stuckXdf = await buildUser('stuck', 'int main(void) { for (;;) {} }\n');
const sourceState = {
  saved: helloSource,
  editing: `${helloSource}\n/* 保存前の編集中データ: あいうえお */\n`,
};
const beforeSaved = Buffer.from(sourceState.saved);
const beforeEditing = Buffer.from(sourceState.editing);
const emulator = new NodeEmulator();
const recovery = createRecoveryController({
  adapter: emulator,
  captureSource: () => JSON.stringify(sourceState),
  buildFallback: async () => ({ ok: true, filename: 'hello.xdf', xdf: helloXdf }),
});
recovery.rememberSuccessfulBuild({ ok: true, filename: 'hello.xdf', xdf: helloXdf });

await emulator.run({ xdf: stuckXdf });
emulator.runFrames(1800);
if (emulator.readText().includes(EXPECTED)) throw new Error('暴走プログラムに期待文字列が出ました');
const bootsBeforeRecovery = emulator.boots;
const recovered = await recovery.recover();
for (let frames = 0; frames < 3000 && !emulator.readText().includes(EXPECTED); frames += 50) {
  emulator.runFrames(50);
}
if (!emulator.readText().includes(EXPECTED) || emulator.boots !== bootsBeforeRecovery + 1) {
  throw new Error(`既知状態へ復帰しません: boots=${emulator.boots}, text=${JSON.stringify(emulator.readText())}`);
}
if (!beforeSaved.equals(Buffer.from(sourceState.saved)) || !beforeEditing.equals(Buffer.from(sourceState.editing))) {
  throw new Error('復帰後に保存済みまたは未保存ソースが変化しました');
}
console.log(`PASS(暴走復帰): 無表示の無限ループから ${EXPECTED} へ復帰 (${recovered.filename})`);
console.log('PASS(ソース保持): 保存済み／未保存の編集中内容がバイト一致');
await emulator.stop();

const faultState = { saved: 'int main(void) { return 0; }\n', editing: 'int main(void) { return 1; }\n' };
const faultRecovery = createRecoveryController({
  adapter: {
    stop: async () => { faultState.editing = faultState.saved; return { ok: true }; },
    run: async () => ({ ok: true }),
  },
  captureSource: () => JSON.stringify(faultState),
  buildFallback: async () => ({ ok: true, filename: 'fault.xdf', xdf: new Uint8Array(1) }),
});
faultRecovery.rememberSuccessfulBuild({ ok: true, filename: 'fault.xdf', xdf: new Uint8Array(1) });
let faultDetected = false;
try {
  await faultRecovery.recover();
} catch (error) {
  faultDetected = error instanceof Error && error.message.includes('ソースが変化しました');
}
if (!faultDetected) throw new Error('故障注入したソース書戻しを検出できません');
console.log('PASS(故障注入): 復帰処理による未保存ソースの書戻しを検出');
console.log('IDE 1クリック復帰検証 PASS');
