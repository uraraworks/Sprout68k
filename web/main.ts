import { fetchJson, loadBrowserToolchain, sha256 } from './browser-toolchain.ts';
import type { BrowserToolchain } from './browser-toolchain.ts';
import { resolvePath } from '../tools/driver/hostfs.mts';

type VerifiedTarget = 'stage_c' | 'breakout';
interface Expected { version: number; targets: Record<VerifiedTarget, { sha256: string; size: number }> }
interface TargetResult { ok: boolean; sha256?: string; expected?: string; ms?: number; heapBefore?: number; heapAfter?: number; error?: string }

const resultElement = document.getElementById('result')!;
const statusElement = document.getElementById('status')!;
const targetsElement = document.getElementById('targets')!;
const faultInjection = new URLSearchParams(location.search).get('fault') === '1';

function heapSize(): number | undefined {
  return (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
}

function injectFault(toolchain: BrowserToolchain): void {
  const path = resolvePath(toolchain.root, 'stage_c/src/main.c');
  const data = toolchain.hostFs.readFile(path);
  const marker = new TextEncoder().encode('STAGE C OK');
  let offset = -1;
  for (let index = 0; index <= data.length - marker.length; index += 1) {
    if (marker.every((byte, inner) => data[index + inner] === byte)) { offset = index + marker.length - 1; break; }
  }
  if (offset < 0) throw new Error('故障注入位置が見つかりません');
  data[offset] ^= 1;
  toolchain.hostFs.writeFile(path, data);
  console.log('[fault] stage_c/src/main.c の1バイトを変更');
}

function renderTarget(target: VerifiedTarget, result: TargetResult): void {
  const row = document.createElement('div');
  row.className = 'target';
  const state = result.ok ? '一致' : result.sha256 ? '不一致' : '失敗';
  row.innerHTML = `<strong>${target}</strong><span class="${result.ok ? 'pass' : 'fail'}">${state} / ${Math.round(result.ms ?? 0)} ms</span>`;
  targetsElement.append(row);
}

async function main(): Promise<void> {
  const results: Partial<Record<VerifiedTarget, TargetResult>> = {};
  let detected = false;
  try {
    const [expected, toolchain] = await Promise.all([
      fetchJson<Expected>('/build/web-assets/expected.json'),
      loadBrowserToolchain({
        onStatus: (message) => { statusElement.textContent = message; },
        onStderr: (text) => { console.error(text); },
      }),
    ]);
    if (expected.version !== 1) throw new Error('expected JSONの版が不正です');
    if (faultInjection) injectFault(toolchain);

    for (const target of ['stage_c', 'breakout'] as const) {
      console.log(`[build] ${target} 開始`);
      statusElement.textContent = `${target} をビルドしています…`;
      const started = performance.now();
      const heapBefore = heapSize();
      try {
        const output = resolvePath(toolchain.root, 'output', `${target}.xdf`);
        const bytes = await toolchain.build(target, output);
        const actual = await sha256(bytes);
        const wanted = expected.targets[target].sha256;
        results[target] = { ok: actual === wanted, sha256: actual, expected: wanted, ms: performance.now() - started, heapBefore, heapAfter: heapSize() };
      } catch (error) {
        results[target] = { ok: false, ms: performance.now() - started, heapBefore, heapAfter: heapSize(), error: error instanceof Error ? error.message : String(error) };
      }
      renderTarget(target, results[target]!);
      console.log('[result]', target, results[target]);
    }
    detected = Boolean(faultInjection && results.stage_c?.sha256 && !results.stage_c.ok);
    const allOk = faultInjection ? detected && results.breakout?.ok === true : results.stage_c?.ok === true && results.breakout?.ok === true;
    const report = { stage_c: results.stage_c, breakout: results.breakout, faultInjection, detected, allOk };
    resultElement.textContent = JSON.stringify(report);
    statusElement.textContent = allOk ? (faultInjection ? '故障注入を正常に検出しました。' : '全ターゲットが正典と一致しました。') : '検証に失敗しました。';
    console.log('[complete]', report);
  } catch (error) {
    const report = { stage_c: results.stage_c, breakout: results.breakout, faultInjection, detected, allOk: false, error: error instanceof Error ? error.message : String(error) };
    resultElement.textContent = JSON.stringify(report);
    statusElement.textContent = '検証の初期化に失敗しました。';
    console.log('[complete]', report);
  }
}

void main();
