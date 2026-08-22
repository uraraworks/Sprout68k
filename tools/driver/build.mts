import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './builder.mts';
import type { BuildTarget } from './builder.mts';
import { NodeHostFs } from './node_hostfs.mts';
import { createNodeToolExecutors } from './node_runner.mts';
import type { ModeMap, ToolName, ToolMode } from './runner.mts';
import { resolveNativeToolchain } from './toolchain.mts';

export * from './builder.mts';

function parseMode(value: string | undefined, tool: ToolName): ToolMode {
  const mode = value ?? 'native';
  if (mode !== 'native' && mode !== 'wasm' && mode !== 'memfs') throw new Error(`${tool} のモードが不正です: ${mode}`);
  return mode;
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '../..');
  const args = process.argv.slice(2);
  const target = args.shift(); const output = args.shift();
  if ((target !== 'stage_c' && target !== 'breakout') || !output) throw new Error('使い方: node tools/driver/build.mts <stage_c|breakout> <output.xdf> [--mode cc1=native,as=wasm|memfs,...]');
  const modes: ModeMap = {
    cc1: parseMode(process.env.SPROUT68K_CC1_MODE, 'cc1'), as: parseMode(process.env.SPROUT68K_AS_MODE, 'as'),
    ld: parseMode(process.env.SPROUT68K_LD_MODE, 'ld'), objcopy: parseMode(process.env.SPROUT68K_OBJCOPY_MODE, 'objcopy'),
  };
  while (args.length) {
    const flag = args.shift(); if (flag !== '--mode') throw new Error(`未知の引数: ${flag}`);
    const spec = args.shift(); if (!spec) throw new Error('--mode の値がありません');
    for (const entry of spec.split(',')) {
      const [tool, value] = entry.split('=');
      if (!(['cc1', 'as', 'ld', 'objcopy'] as string[]).includes(tool)) throw new Error(`未知のツール: ${tool}`);
      modes[tool as ToolName] = parseMode(value, tool as ToolName);
    }
  }
  const hostFs = new NodeHostFs();
  const tools = resolveNativeToolchain();
  const cc1ExecPrefix = process.env.SPROUT68K_CC1_GCC_EXEC_PREFIX;
  const executors = createNodeToolExecutors({
    modes, hostFs, root, cc1ExecPrefix,
    wasmModules: { cc1: process.env.SPROUT68K_CC1_WASM_JS, as: process.env.SPROUT68K_AS_WASM_JS, ld: process.env.SPROUT68K_LD_WASM_JS, objcopy: process.env.SPROUT68K_OBJCOPY_WASM_JS },
    memfsModules: { cc1: process.env.SPROUT68K_CC1_MEMFS_JS, as: process.env.SPROUT68K_AS_MEMFS_JS, ld: process.env.SPROUT68K_LD_MEMFS_JS, objcopy: process.env.SPROUT68K_OBJCOPY_MEMFS_JS },
  });
  await build({
    target: target as BuildTarget, output: resolve(output), root, hostFs, tools, executors,
    optLevel: process.env.CC1_OPT_LEVEL, buildVariant: process.env.CC1_BUILD_VARIANT,
    stackAddress: process.env.STACK_ADDR, ramSize: process.env.RAM_SIZE,
    buildRoot: process.env.SPROUT68K_DRIVER_BUILD_ROOT ? resolve(process.env.SPROUT68K_DRIVER_BUILD_ROOT) : undefined,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
