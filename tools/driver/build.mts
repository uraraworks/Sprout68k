import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolExecutors } from './runner.mts';
import type { ModeMap, ToolName, ToolMode } from './runner.mts';
import { resolveNativeToolchain } from './toolchain.mts';
import type { NativeToolchain } from './toolchain.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SECTOR_SIZE = 1024;
const TOTAL_SECTORS = 1232;
const LOAD_ADDR = 0x3000;
const STACK_MARGIN = 4096;

export type BuildTarget = 'stage_c' | 'breakout';

export interface BuildOptions {
  target: BuildTarget;
  output: string;
  modes: ModeMap;
  optLevel?: string;
  buildVariant?: string;
  stackAddress?: string;
  ramSize?: string;
  buildRoot?: string;
}

const VALID_OPT_LEVELS = new Set(['-O0', '-O1', '-O2', '-O3', '-Os', '-Oz', '-Og', '-Ofast']);

class Builder {
  private readonly options: BuildOptions;
  private readonly tools: NativeToolchain;
  private readonly executors: ToolExecutors;
  private readonly optLevel: string;
  private readonly stackAddress: string;
  private readonly stackAddressNumber: number;
  private readonly ramSizeNumber: number;
  private readonly variantSuffix: string;
  private readonly buildRoot: string;

  constructor(options: BuildOptions) {
    this.options = options;
    this.optLevel = options.optLevel ?? '-Os';
    if (!VALID_OPT_LEVELS.has(this.optLevel)) throw new Error(`無効な最適化レベル: ${this.optLevel}`);
    if (options.buildVariant && options.buildVariant !== 'positive') {
      throw new Error(`無効な buildVariant: ${options.buildVariant}`);
    }
    this.stackAddress = options.stackAddress ?? '0xF0000';
    this.stackAddressNumber = Number(this.stackAddress);
    this.ramSizeNumber = Number(options.ramSize ?? '0x100000');
    if (!Number.isSafeInteger(this.stackAddressNumber) || !Number.isSafeInteger(this.ramSizeNumber)) {
      throw new Error('STACK_ADDR/RAM_SIZE は整数として解釈できる値を指定してください');
    }
    this.variantSuffix = options.buildVariant ? `_${options.buildVariant}` : '';
    this.buildRoot = resolve(options.buildRoot ?? resolve(ROOT, 'build/via_cc1'));
    this.tools = resolveNativeToolchain();
    this.executors = new ToolExecutors(options.modes, {
      cc1: process.env.X68KDEV_CC1_WASM_JS,
      as: process.env.X68KDEV_AS_WASM_JS,
      ld: process.env.X68KDEV_LD_WASM_JS,
      objcopy: process.env.X68KDEV_OBJCOPY_WASM_JS,
    }, {
      cc1: process.env.X68KDEV_CC1_MEMFS_JS,
      as: process.env.X68KDEV_AS_MEMFS_JS,
      ld: process.env.X68KDEV_LD_MEMFS_JS,
      objcopy: process.env.X68KDEV_OBJCOPY_MEMFS_JS,
    });
  }

  private async run(tool: ToolName, args: string[]): Promise<void> {
    await this.executors.run({ tool, program: this.tools[tool], args, cwd: ROOT });
  }

  private async compileC(src: string, out: string, extra: string[] = []): Promise<void> {
    const asmOut = out.replace(/\.o$/, '.s');
    await this.run('cc1', [
      '-quiet', '-imultilib', 'm68000', ...extra, src, '-quiet',
      '-dumpdir', `${dirname(out)}/`, '-dumpbase', basename(src), '-dumpbase-ext', '.c',
      '-mcpu=68000', this.optLevel, '-Wall', '-ffreestanding', '-fomit-frame-pointer',
      '-fno-builtin', '-o', asmOut,
    ]);
    await this.run('as', ['-mcpu=68000', '-o', out, asmOut]);
  }

  private async assembleCpp(cpu: '68000' | '68020', src: string, out: string, extra: string[] = []): Promise<void> {
    const asmOut = out.replace(/\.o$/, '.s');
    const multilib = cpu === '68000' ? ['-imultilib', 'm68000'] : [];
    await this.run('cc1', [
      '-E', '-lang-asm', '-quiet', ...multilib, ...extra, src,
      `-mcpu=${cpu}`, '-fno-directives-only', '-o', asmOut,
    ]);
    await this.run('as', [`-mcpu=${cpu}`, '-o', out, asmOut]);
  }

  private checkMemoryLayout(bodySize: number): void {
    const bodyEnd = LOAD_ADDR + bodySize;
    if (bodyEnd + STACK_MARGIN > this.stackAddressNumber) {
      throw new Error(`本体末尾(0x${bodyEnd.toString(16)})がスタックと衝突します`);
    }
    if (this.stackAddressNumber >= this.ramSizeNumber) {
      throw new Error('STACK_ADDR が設定 RAM サイズ以上です');
    }
  }

  private async linkBoot(objdir: string, bootSrc: string, sectors: number): Promise<void> {
    await this.assembleCpp('68000', bootSrc, resolve(objdir, 'boot.o'), [
      '-D', `SECTOR_COUNT=${sectors}`, '-D', `STACK_ADDR=${this.stackAddress}`,
    ]);
    await this.assembleCpp('68020', resolve(ROOT, 'stage_c/boot/cache_flush.S'), resolve(objdir, 'cache_flush.o'));
    const linkerScript = resolve(objdir, 'boot_link.ld');
    writeFileSync(linkerScript, 'SECTIONS { . = 0x0; .text : { *(.text) *(.rodata) *(.data) } }\n');
    await this.run('ld', ['-T', linkerScript, '-o', resolve(objdir, 'boot.elf'), resolve(objdir, 'boot.o'), resolve(objdir, 'cache_flush.o')]);
    await this.run('objcopy', ['-O', 'binary', resolve(objdir, 'boot.elf'), resolve(objdir, 'boot.bin')]);
    const bootSize = statSync(resolve(objdir, 'boot.bin')).size;
    if (bootSize > SECTOR_SIZE) throw new Error(`ブートセクタが1024バイトを超えています(${bootSize})`);
  }

  private makeXdf(bootPath: string, bodyPath: string, sectors: number): void {
    const boot = readFileSync(bootPath);
    const body = readFileSync(bodyPath);
    if (boot.length > SECTOR_SIZE) throw new Error('ブートセクタが1024バイトを超えています');
    if (body.length > SECTOR_SIZE * sectors) throw new Error('本体が確保セクタ数を超えています');
    const image = Buffer.alloc(SECTOR_SIZE * TOTAL_SECTORS);
    boot.copy(image, 0);
    body.copy(image, SECTOR_SIZE);
    const output = resolve(this.options.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, image);
    console.log(`wrote ${output} (${image.length} bytes, body=${sectors} sectors)`);
  }

  async buildStageC(): Promise<void> {
    const objdir = resolve(this.buildRoot, `stage_c${this.variantSuffix}`);
    mkdirSync(objdir, { recursive: true });
    console.log(`== Stage C を駆動層でビルド(opt=${this.optLevel}) ==`);
    await this.compileC(resolve(ROOT, 'stage_c/src/main.c'), resolve(objdir, 'main.o'), ['-D', 'FILL_COLOR=0xFFFF']);
    await this.assembleCpp('68000', resolve(ROOT, 'stage_c/crt0/crt0.S'), resolve(objdir, 'crt0.o'), ['-D', `STACK_ADDR=${this.stackAddress}`]);
    await this.assembleCpp('68000', resolve(ROOT, 'stage_c/crt0/iocs.S'), resolve(objdir, 'iocs.o'));
    const elf = resolve(objdir, 'stage_c.elf');
    const bin = resolve(objdir, 'stage_c.bin');
    await this.run('ld', ['-T', resolve(ROOT, 'stage_c/crt0/linker.ld'), '-o', elf, resolve(objdir, 'crt0.o'), resolve(objdir, 'iocs.o'), resolve(objdir, 'main.o')]);
    await this.run('objcopy', ['-O', 'binary', elf, bin]);
    const bodySize = statSync(bin).size;
    const sectors = Math.max(1, Math.ceil(bodySize / SECTOR_SIZE));
    if (sectors > 7) throw new Error('本体が7セクタ(7168バイト)を超えています');
    this.checkMemoryLayout(bodySize);
    await this.linkBoot(objdir, resolve(ROOT, 'stage_c/boot/boot.S'), sectors);
    this.makeXdf(resolve(objdir, 'boot.bin'), bin, sectors);
  }

  async buildBreakout(): Promise<void> {
    const objdir = resolve(this.buildRoot, `breakout${this.variantSuffix}`);
    mkdirSync(objdir, { recursive: true });
    console.log(`== breakout を駆動層でビルド(opt=${this.optLevel}) ==`);
    const include = ['-I', resolve(ROOT, 'lib/include')];
    for (const name of ['x68_std', 'x68_l0', 'x68_l1', 'x68_panic', 'x68_input']) {
      await this.compileC(resolve(ROOT, `lib/src/${name}.c`), resolve(objdir, `${name}.o`), include);
    }
    await this.compileC(resolve(ROOT, 'samples/breakout/main.c'), resolve(objdir, 'main.o'), include);
    await this.assembleCpp('68000', resolve(ROOT, 'lib/asm/x68_iocs.S'), resolve(objdir, 'x68_iocs.o'));
    await this.assembleCpp('68000', resolve(ROOT, 'lib/asm/x68_gvram_copy.S'), resolve(objdir, 'x68_gvram_copy.o'));
    await this.assembleCpp('68020', resolve(ROOT, 'lib/asm/x68_panic.S'), resolve(objdir, 'x68_panic_asm.o'));
    await this.assembleCpp('68000', resolve(ROOT, 'stage_c/crt0/crt0.S'), resolve(objdir, 'crt0.o'), ['-D', `STACK_ADDR=${this.stackAddress}`]);
    const elf = resolve(objdir, 'breakout.elf');
    const bin = resolve(objdir, 'breakout.bin');
    await this.run('ld', [
      '-T', resolve(ROOT, 'stage_c/crt0/linker.ld'), '-o', elf,
      resolve(objdir, 'crt0.o'), resolve(objdir, 'main.o'),
      ...['x68_std', 'x68_l0', 'x68_l1', 'x68_panic', 'x68_input'].map((name) => resolve(objdir, `${name}.o`)),
      resolve(objdir, 'x68_iocs.o'), resolve(objdir, 'x68_gvram_copy.o'), resolve(objdir, 'x68_panic_asm.o'),
      this.tools.libgcc,
    ]);
    await this.run('objcopy', ['-O', 'binary', elf, bin]);
    const bodySize = statSync(bin).size;
    const sectors = Math.max(1, Math.ceil(bodySize / SECTOR_SIZE));
    this.checkMemoryLayout(bodySize);
    const nmOutput = execFileSync(this.tools.nm, [elf], { encoding: 'utf8' });
    const match = nmOutput.match(/^([0-9a-fA-F]+)\s+\S\s+__bss_end$/m);
    if (!match) throw new Error('__bss_end シンボルが ELF に見つかりません');
    const bssEnd = Number.parseInt(match[1], 16);
    if (bssEnd + STACK_MARGIN > this.stackAddressNumber || bssEnd + STACK_MARGIN > this.ramSizeNumber) {
      throw new Error('bss末尾がスタックまたは設定RAMサイズと衝突します');
    }
    await this.linkBoot(objdir, resolve(ROOT, 'stage_d/boot/boot.S'), sectors);
    this.makeXdf(resolve(objdir, 'boot.bin'), bin, sectors);
  }
}

export async function build(options: BuildOptions): Promise<void> {
  const builder = new Builder(options);
  if (options.target === 'stage_c') await builder.buildStageC();
  else await builder.buildBreakout();
}

function parseMode(value: string | undefined, tool: ToolName): ToolMode {
  const mode = value ?? 'native';
  if (mode !== 'native' && mode !== 'wasm' && mode !== 'memfs') throw new Error(`${tool} のモードが不正です: ${mode}`);
  return mode;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = args.shift();
  const output = args.shift();
  if ((target !== 'stage_c' && target !== 'breakout') || !output) {
    throw new Error('使い方: node tools/driver/build.mts <stage_c|breakout> <output.xdf> [--mode cc1=native,as=wasm|memfs,...]');
  }
  const modes: ModeMap = {
    cc1: parseMode(process.env.X68KDEV_CC1_MODE, 'cc1'),
    as: parseMode(process.env.X68KDEV_AS_MODE, 'as'),
    ld: parseMode(process.env.X68KDEV_LD_MODE, 'ld'),
    objcopy: parseMode(process.env.X68KDEV_OBJCOPY_MODE, 'objcopy'),
  };
  while (args.length) {
    const flag = args.shift();
    if (flag !== '--mode') throw new Error(`未知の引数: ${flag}`);
    const spec = args.shift();
    if (!spec) throw new Error('--mode の値がありません');
    for (const entry of spec.split(',')) {
      const [tool, value] = entry.split('=');
      if (!(['cc1', 'as', 'ld', 'objcopy'] as string[]).includes(tool)) throw new Error(`未知のツール: ${tool}`);
      modes[tool as ToolName] = parseMode(value, tool as ToolName);
    }
  }
  await build({
    target,
    output,
    modes,
    optLevel: process.env.CC1_OPT_LEVEL,
    buildVariant: process.env.CC1_BUILD_VARIANT,
    stackAddress: process.env.STACK_ADDR,
    ramSize: process.env.RAM_SIZE,
    buildRoot: process.env.X68KDEV_DRIVER_BUILD_ROOT,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
