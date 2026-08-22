import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface NativeToolchain {
  cc1: string;
  as: string;
  ld: string;
  objcopy: string;
  libgcc: string;
}

function capture(program: string, args: string[]): string {
  return execFileSync(program, args, { encoding: 'utf8' }).trim();
}

function requireFile(label: string, path: string): string {
  if (!existsSync(path)) throw new Error(`${label} が見つかりません: ${path}`);
  return path;
}

/**
 * -m68000 用 libgcc の場所は gcc 自身に答えさせる。
 * multilib のディレクトリ名を決め打ちすると、--with-cpu=m68000 でビルドした
 * gcc(既定 multilib が m68000)では見つからない。実際に一度そうなった。
 */
function libgccFileName(gcc: string): string {
  return capture(gcc, ['-m68000', '-print-libgcc-file-name']);
}

/** SPROUT68K_TOOLCHAIN 未指定時は、従来どおり PATH 上の Homebrew ツールを使う。 */
export function resolveNativeToolchain(): NativeToolchain {
  const rootValue = process.env.SPROUT68K_TOOLCHAIN;
  if (!rootValue) {
    const gcc = capture('which', ['m68k-elf-gcc']);
    const cc1 = capture(gcc, ['-print-prog-name=cc1']);
    const version = cc1.split('/').at(-2);
    const prefix = cc1.includes('/libexec/gcc/') ? cc1.slice(0, cc1.indexOf('/libexec/gcc/')) : '';
    if (!version || !prefix) throw new Error(`cc1 の配置を解釈できません: ${cc1}`);
    return {
      cc1: requireFile('cc1', cc1),
      as: capture('which', ['m68k-elf-as']),
      ld: capture('which', ['m68k-elf-ld']),
      objcopy: capture('which', ['m68k-elf-objcopy']),
      libgcc: requireFile('libgcc', libgccFileName(join(prefix, 'bin/m68k-elf-gcc'))),
    };
  }

  const root = resolve(rootValue);
  const versionsDir = join(root, 'libexec/gcc/m68k-elf');
  const versions = existsSync(versionsDir)
    ? readdirSync(versionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];
  if (versions.length !== 1) {
    throw new Error(`${versionsDir} の GCC バージョンディレクトリは1個である必要があります(検出: ${versions.join(', ') || 'なし'})`);
  }
  const version = versions[0];
  return {
    cc1: requireFile('cc1', join(versionsDir, version, 'cc1')),
    as: requireFile('as', join(root, 'bin/m68k-elf-as')),
    ld: requireFile('ld', join(root, 'bin/m68k-elf-ld')),
    objcopy: requireFile('objcopy', join(root, 'bin/m68k-elf-objcopy')),
    libgcc: requireFile('libgcc', libgccFileName(join(root, 'bin/m68k-elf-gcc'))),
  };
}
