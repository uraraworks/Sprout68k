import coreJsUrl from './core/px68k_libretro.js?url';
import coreWasmUrl from './core/px68k_libretro.wasm?url';
import iplromUrl from './system/iplrom.dat?url';
import cgromUrl from './system/cgrom.dat?url';
import { LibretroHost } from './px68k/libretro-host';
import type { PX68KModule } from './px68k/libretro-host';

type CoreFactory = (options?: Record<string, unknown>) => Promise<PX68KModule>;
export type EmulatorState = 'idle' | 'running' | 'error';

export interface EmulatorProbe {
  readTextScreen(): string;
  getFrameCount(): number;
  getState(): EmulatorState;
}

declare global {
  interface Window {
    x68kdevEmulatorProbe: EmulatorProbe;
  }
}

let factoryPromise: Promise<CoreFactory> | undefined;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** glue JS は classic script なので、Blob ESM に export を1行だけ補ってfactoryを得る。 */
async function loadCoreFactory(): Promise<CoreFactory> {
  if (!factoryPromise) {
    factoryPromise = (async () => {
      const response = await fetch(coreJsUrl);
      if (!response.ok) throw new Error(`${coreJsUrl}: HTTP ${response.status}`);
      const source = await response.text();
      const blobUrl = URL.createObjectURL(new Blob([source, '\nexport default PX68K;\n'], { type: 'text/javascript' }));
      try {
        const imported = await import(/* @vite-ignore */ blobUrl) as { default: CoreFactory };
        const factory = imported.default;
        if (typeof factory !== 'function') throw new Error('px68k factory を取得できません');
        // libretro-host側のlocateFileはビルドID付きURLを返す。Blobからは相対解決できないため、
        // Viteが確定した同梱wasm URLへここで必ず差し替える。
        return (options = {}) => factory({
          ...options,
          locateFile: (path: string) => path.endsWith('.wasm') ? coreWasmUrl : path,
        });
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    })().catch((error) => {
      factoryPromise = undefined;
      throw error;
    });
  }
  return factoryPromise;
}

export class X68kRuntime {
  private readonly canvas: HTMLCanvasElement;
  private readonly report: (message: string, error?: boolean) => void;
  private host: LibretroHost | null = null;
  private animationFrame: number | null = null;
  private generation = 0;
  private frameCount = 0;
  private state: EmulatorState = 'idle';

  constructor(canvas: HTMLCanvasElement, report: (message: string, error?: boolean) => void) {
    this.canvas = canvas;
    this.report = report;
    window.x68kdevEmulatorProbe = Object.freeze({
      readTextScreen: () => this.readTextScreen(),
      getFrameCount: () => this.frameCount,
      getState: () => this.state,
    });
  }

  private stopCurrent(): void {
    this.generation++;
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    if (this.host) {
      try { this.host.unloadGame(); } catch {}
      this.host.dispose();
      this.host = null;
    }
  }

  async runXdf(xdf: Uint8Array): Promise<{ ok: true }> {
    this.stopCurrent();
    const generation = this.generation;
    this.frameCount = 0;
    this.state = 'running';
    this.report('px68k を初期化しています…', false);
    try {
      const [factory, iplrom, cgrom] = await Promise.all([
        loadCoreFactory(), fetchBytes(iplromUrl), fetchBytes(cgromUrl),
      ]);
      if (generation !== this.generation) return { ok: true };
      window.PX68K = factory;
      const host = new LibretroHost(this.canvas, () => {});
      host.setCoreOption('px68k_cpuspeed', '16Mhz');
      host.setCoreOption('px68k_ramsize', '1MB');
      host.setCoreOption('px68k_no_wait_mode', 'enabled');
      await host.init(iplrom, cgrom);
      this.host = host;

      const diskPath = host.writeDiskImage('user.xdf', xdf);
      host.writeFile('/game/boot.cmd', new TextEncoder().encode(`px68k "${diskPath}" ""\n`));
      if (!host.loadGame('/game/boot.cmd')) throw new Error('px68k loadGame() が失敗しました');
      host.fetchAvInfo();
      this.report('X68000 を実行中', false);
      this.schedule(generation);
      return { ok: true };
    } catch (error) {
      this.state = 'error';
      const message = error instanceof Error ? error.message : String(error);
      this.report(`実行エラー: ${message}`, true);
      throw error;
    }
  }

  private schedule(generation: number): void {
    const tick = () => {
      if (generation !== this.generation || this.state !== 'running' || !this.host) return;
      try {
        // 起動待ちを短縮しつつUIを占有しすぎないよう、1描画周期に2フレーム進める。
        this.host.runFrame();
        this.host.runFrame();
        this.frameCount += 2;
        this.animationFrame = requestAnimationFrame(tick);
      } catch (error) {
        this.state = 'error';
        const message = error instanceof Error ? error.message : String(error);
        this.report(`実行エラー: ${message}`, true);
      }
    };
    this.animationFrame = requestAnimationFrame(tick);
  }

  readTextScreen(): string {
    if (!this.host) return '';
    const dump = this.host.readTextScreen();
    return dump.available ? dump.lines.join('\n') : '';
  }
}
