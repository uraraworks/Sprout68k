import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import type { HostFs } from './hostfs.mts';

export class NodeHostFs implements HostFs {
  readFile(path: string): Uint8Array { return readFileSync(path); }
  writeFile(path: string, data: Uint8Array | string): void { writeFileSync(path, data); }
  exists(path: string): boolean { return existsSync(path); }
  mkdirp(path: string): void { mkdirSync(path, { recursive: true }); }
  size(path: string): number { return statSync(path).size; }
  readdir(path: string): string[] { return readdirSync(path); }
  isDirectory(path: string): boolean { return statSync(path).isDirectory(); }
}
