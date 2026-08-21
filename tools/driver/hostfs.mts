/** ビルド駆動層が利用するホスト側ファイルシステム境界。 */
export interface HostFs {
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array | string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  size(path: string): number;
  readdir(path: string): string[];
  isDirectory(path: string): boolean;
}

function parts(path: string): string[] {
  if (!path.startsWith('/')) throw new Error(`絶対パスではありません: ${path}`);
  const result: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') result.pop();
    else result.push(part);
  }
  return result;
}

export function resolvePath(...paths: string[]): string {
  let result: string[] = [];
  for (const path of paths) {
    if (path.startsWith('/')) result = [];
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') result.pop();
      else result.push(part);
    }
  }
  return `/${result.join('/')}`;
}

export function dirnamePath(path: string): string {
  const value = parts(resolvePath(path));
  value.pop();
  return `/${value.join('/')}`;
}

export function basenamePath(path: string): string {
  return parts(resolvePath(path)).at(-1) ?? '';
}

/** Node 組み込みに依存しない、POSIX 絶対パス用のメモリファイルシステム。 */
export class MemoryHostFs implements HostFs {
  private readonly files = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>(['/']);

  readFile(path: string): Uint8Array {
    const normalized = resolvePath(path);
    const data = this.files.get(normalized);
    if (!data) throw new Error(`ファイルが見つかりません: ${normalized}`);
    return data.slice();
  }

  writeFile(path: string, data: Uint8Array | string): void {
    const normalized = resolvePath(path);
    const parent = dirnamePath(normalized);
    if (!this.directories.has(parent)) throw new Error(`親ディレクトリが見つかりません: ${parent}`);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.files.set(normalized, bytes.slice());
  }

  exists(path: string): boolean {
    const normalized = resolvePath(path);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  mkdirp(path: string): void {
    let current = '/';
    for (const part of parts(resolvePath(path))) {
      current = resolvePath(current, part);
      if (this.files.has(current)) throw new Error(`ファイルをディレクトリにできません: ${current}`);
      this.directories.add(current);
    }
  }

  size(path: string): number {
    return this.readFile(path).length;
  }

  readdir(path: string): string[] {
    const normalized = resolvePath(path);
    if (!this.directories.has(normalized)) throw new Error(`ディレクトリが見つかりません: ${normalized}`);
    const prefix = normalized === '/' ? '/' : `${normalized}/`;
    const entries = new Set<string>();
    for (const candidate of [...this.directories, ...this.files.keys()]) {
      if (!candidate.startsWith(prefix) || candidate === normalized) continue;
      const entry = candidate.slice(prefix.length).split('/')[0];
      if (entry) entries.add(entry);
    }
    return [...entries].sort();
  }

  isDirectory(path: string): boolean {
    return this.directories.has(resolvePath(path));
  }
}
