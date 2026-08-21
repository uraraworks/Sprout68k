import { basenamePath, dirnamePath, resolvePath } from './hostfs.mts';
import type { HostFs } from './hostfs.mts';
import type { ToolExecutors, ToolName } from './runner.mts';

const SECTOR_SIZE = 1024;
const TOTAL_SECTORS = 1232;
const LOAD_ADDR = 0x3000;
const STACK_MARGIN = 4096;
const VALID_OPT_LEVELS = new Set(['-O0', '-O1', '-O2', '-O3', '-Os', '-Oz', '-Og', '-Ofast']);

export type BuildTarget = 'stage_c' | 'breakout';
export interface BuildToolchain { cc1: string; as: string; ld: string; objcopy: string; libgcc: string; }

export interface BuildOptions {
  target: BuildTarget;
  output: string;
  root: string;
  hostFs: HostFs;
  tools: BuildToolchain;
  executors: ToolExecutors;
  inspectBssEnd: (elfPath: string) => number | Promise<number>;
  optLevel?: string;
  buildVariant?: string;
  stackAddress?: string;
  ramSize?: string;
  buildRoot?: string;
}

export class Builder {
  private readonly options: BuildOptions;
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
    if (options.buildVariant && options.buildVariant !== 'positive') throw new Error(`無効な buildVariant: ${options.buildVariant}`);
    this.stackAddress = options.stackAddress ?? '0xF0000';
    this.stackAddressNumber = Number(this.stackAddress);
    this.ramSizeNumber = Number(options.ramSize ?? '0x100000');
    if (!Number.isSafeInteger(this.stackAddressNumber) || !Number.isSafeInteger(this.ramSizeNumber)) throw new Error('STACK_ADDR/RAM_SIZE は整数として解釈できる値を指定してください');
    this.variantSuffix = options.buildVariant ? `_${options.buildVariant}` : '';
    this.buildRoot = resolvePath(options.root, options.buildRoot ?? 'build/via_cc1');
  }

  private async run(tool: ToolName, args: string[]): Promise<void> {
    await this.options.executors.run({ tool, program: this.options.tools[tool], args, cwd: this.options.root });
  }

  private async compileC(src: string, out: string, extra: string[] = []): Promise<void> {
    const asmOut = out.replace(/\.o$/, '.s');
    await this.run('cc1', ['-quiet', '-imultilib', 'm68000', ...extra, src, '-quiet', '-dumpdir', `${dirnamePath(out)}/`, '-dumpbase', basenamePath(src), '-dumpbase-ext', '.c', '-mcpu=68000', this.optLevel, '-Wall', '-ffreestanding', '-fomit-frame-pointer', '-fno-builtin', '-o', asmOut]);
    await this.run('as', ['-mcpu=68000', '-o', out, asmOut]);
  }

  private async assembleCpp(cpu: '68000' | '68020', src: string, out: string, extra: string[] = []): Promise<void> {
    const asmOut = out.replace(/\.o$/, '.s');
    const multilib = cpu === '68000' ? ['-imultilib', 'm68000'] : [];
    await this.run('cc1', ['-E', '-lang-asm', '-quiet', ...multilib, ...extra, src, `-mcpu=${cpu}`, '-fno-directives-only', '-o', asmOut]);
    await this.run('as', [`-mcpu=${cpu}`, '-o', out, asmOut]);
  }

  private checkMemoryLayout(bodySize: number): void {
    const bodyEnd = LOAD_ADDR + bodySize;
    if (bodyEnd + STACK_MARGIN > this.stackAddressNumber) throw new Error(`本体末尾(0x${bodyEnd.toString(16)})がスタックと衝突します`);
    if (this.stackAddressNumber >= this.ramSizeNumber) throw new Error('STACK_ADDR が設定 RAM サイズ以上です');
  }

  private async linkBoot(objdir: string, bootSrc: string, sectors: number): Promise<void> {
    await this.assembleCpp('68000', bootSrc, resolvePath(objdir, 'boot.o'), ['-D', `SECTOR_COUNT=${sectors}`, '-D', `STACK_ADDR=${this.stackAddress}`]);
    await this.assembleCpp('68020', resolvePath(this.options.root, 'stage_c/boot/cache_flush.S'), resolvePath(objdir, 'cache_flush.o'));
    const linkerScript = resolvePath(objdir, 'boot_link.ld');
    this.options.hostFs.writeFile(linkerScript, 'SECTIONS { . = 0x0; .text : { *(.text) *(.rodata) *(.data) } }\n');
    await this.run('ld', ['-T', linkerScript, '-o', resolvePath(objdir, 'boot.elf'), resolvePath(objdir, 'boot.o'), resolvePath(objdir, 'cache_flush.o')]);
    await this.run('objcopy', ['-O', 'binary', resolvePath(objdir, 'boot.elf'), resolvePath(objdir, 'boot.bin')]);
    const bootSize = this.options.hostFs.size(resolvePath(objdir, 'boot.bin'));
    if (bootSize > SECTOR_SIZE) throw new Error(`ブートセクタが1024バイトを超えています(${bootSize})`);
  }

  private makeXdf(bootPath: string, bodyPath: string, sectors: number): void {
    const boot = this.options.hostFs.readFile(bootPath);
    const body = this.options.hostFs.readFile(bodyPath);
    if (boot.length > SECTOR_SIZE) throw new Error('ブートセクタが1024バイトを超えています');
    if (body.length > SECTOR_SIZE * sectors) throw new Error('本体が確保セクタ数を超えています');
    const image = new Uint8Array(SECTOR_SIZE * TOTAL_SECTORS);
    image.set(boot, 0); image.set(body, SECTOR_SIZE);
    const output = resolvePath(this.options.root, this.options.output);
    this.options.hostFs.mkdirp(dirnamePath(output));
    this.options.hostFs.writeFile(output, image);
    console.log(`wrote ${output} (${image.length} bytes, body=${sectors} sectors)`);
  }

  async buildStageC(): Promise<void> {
    const root = this.options.root; const objdir = resolvePath(this.buildRoot, `stage_c${this.variantSuffix}`);
    this.options.hostFs.mkdirp(objdir); console.log(`== Stage C を駆動層でビルド(opt=${this.optLevel}) ==`);
    await this.compileC(resolvePath(root, 'stage_c/src/main.c'), resolvePath(objdir, 'main.o'), ['-D', 'FILL_COLOR=0xFFFF']);
    await this.assembleCpp('68000', resolvePath(root, 'stage_c/crt0/crt0.S'), resolvePath(objdir, 'crt0.o'), ['-D', `STACK_ADDR=${this.stackAddress}`]);
    await this.assembleCpp('68000', resolvePath(root, 'stage_c/crt0/iocs.S'), resolvePath(objdir, 'iocs.o'));
    const elf = resolvePath(objdir, 'stage_c.elf'); const bin = resolvePath(objdir, 'stage_c.bin');
    await this.run('ld', ['-T', resolvePath(root, 'stage_c/crt0/linker.ld'), '-o', elf, resolvePath(objdir, 'crt0.o'), resolvePath(objdir, 'iocs.o'), resolvePath(objdir, 'main.o')]);
    await this.run('objcopy', ['-O', 'binary', elf, bin]);
    const bodySize = this.options.hostFs.size(bin); const sectors = Math.max(1, Math.ceil(bodySize / SECTOR_SIZE));
    if (sectors > 7) throw new Error('本体が7セクタ(7168バイト)を超えています');
    this.checkMemoryLayout(bodySize); await this.linkBoot(objdir, resolvePath(root, 'stage_c/boot/boot.S'), sectors);
    this.makeXdf(resolvePath(objdir, 'boot.bin'), bin, sectors);
  }

  async buildBreakout(): Promise<void> {
    const root = this.options.root; const objdir = resolvePath(this.buildRoot, `breakout${this.variantSuffix}`);
    this.options.hostFs.mkdirp(objdir); console.log(`== breakout を駆動層でビルド(opt=${this.optLevel}) ==`);
    const include = ['-I', resolvePath(root, 'lib/include')];
    for (const name of ['x68_std', 'x68_l0', 'x68_l1', 'x68_panic', 'x68_input']) await this.compileC(resolvePath(root, `lib/src/${name}.c`), resolvePath(objdir, `${name}.o`), include);
    await this.compileC(resolvePath(root, 'samples/breakout/main.c'), resolvePath(objdir, 'main.o'), include);
    await this.assembleCpp('68000', resolvePath(root, 'lib/asm/x68_iocs.S'), resolvePath(objdir, 'x68_iocs.o'));
    await this.assembleCpp('68000', resolvePath(root, 'lib/asm/x68_gvram_copy.S'), resolvePath(objdir, 'x68_gvram_copy.o'));
    await this.assembleCpp('68020', resolvePath(root, 'lib/asm/x68_panic.S'), resolvePath(objdir, 'x68_panic_asm.o'));
    await this.assembleCpp('68000', resolvePath(root, 'stage_c/crt0/crt0.S'), resolvePath(objdir, 'crt0.o'), ['-D', `STACK_ADDR=${this.stackAddress}`]);
    const elf = resolvePath(objdir, 'breakout.elf'); const bin = resolvePath(objdir, 'breakout.bin');
    await this.run('ld', ['-T', resolvePath(root, 'stage_c/crt0/linker.ld'), '-o', elf, resolvePath(objdir, 'crt0.o'), resolvePath(objdir, 'main.o'), ...['x68_std', 'x68_l0', 'x68_l1', 'x68_panic', 'x68_input'].map((name) => resolvePath(objdir, `${name}.o`)), resolvePath(objdir, 'x68_iocs.o'), resolvePath(objdir, 'x68_gvram_copy.o'), resolvePath(objdir, 'x68_panic_asm.o'), this.options.tools.libgcc]);
    await this.run('objcopy', ['-O', 'binary', elf, bin]);
    const bodySize = this.options.hostFs.size(bin); const sectors = Math.max(1, Math.ceil(bodySize / SECTOR_SIZE));
    this.checkMemoryLayout(bodySize);
    const bssEnd = await this.options.inspectBssEnd(elf);
    if (bssEnd + STACK_MARGIN > this.stackAddressNumber || bssEnd + STACK_MARGIN > this.ramSizeNumber) throw new Error('bss末尾がスタックまたは設定RAMサイズと衝突します');
    await this.linkBoot(objdir, resolvePath(root, 'stage_d/boot/boot.S'), sectors);
    this.makeXdf(resolvePath(objdir, 'boot.bin'), bin, sectors);
  }
}

export async function build(options: BuildOptions): Promise<void> {
  const builder = new Builder(options);
  if (options.target === 'stage_c') await builder.buildStageC(); else await builder.buildBreakout();
}
