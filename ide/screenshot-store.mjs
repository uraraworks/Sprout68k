/* 実行画面のスクリーンショット。
 *
 * 用途は「X などに画像として手で添付するため」。#以降のフラグメントは
 * サーバへ送られないので、共有リンクから OGP 画像を作ることは原理的に
 * できない。そのぶん、作者が自分で画像を貼れることが投稿の見え方を決める。
 *
 * project-fs.mjs(ProjectFS) は文字列しか扱わない契約なので、画像はここで
 * 別のデータベースに持つ。ProjectFS 側を画像対応に広げると、保存方式を
 * 差し替えるときの契約が重くなるため。
 *
 * 判断のいる部分（倍率・名前・古いものの整理）は DOM も IndexedDB も
 * 使わない純粋な関数にしてあり、verify-ide.mjs が Node で直接テストする。
 */

/** 溜めておける枚数。超えたら古いものから捨てる。 */
export const SCREENSHOT_LIMIT = 20;

/** 書き出しの長辺の目安。等倍(512)のままだと投稿先の表示で潰れる。 */
export const SCREENSHOT_MIN_LONG_SIDE = 1024;
export const SCREENSHOT_MAX_SCALE = 4;

/**
 * 実ピクセルを何倍にして書き出すかを決める。
 * 整数倍だけを使う（1.5倍などにすると、補間なしでは点の大きさが不揃いになり、
 * ドット絵が汚れる）。
 */
export function screenshotScale(width, height, {
  minLongSide = SCREENSHOT_MIN_LONG_SIDE, maxScale = SCREENSHOT_MAX_SCALE,
} = {}) {
  const longSide = Math.max(width, height);
  if (!Number.isFinite(longSide) || longSide <= 0) return 1;
  return Math.min(maxScale, Math.max(1, Math.ceil(minLongSide / longSide)));
}

function pad(value, length) {
  return String(value).padStart(length, '0');
}

/**
 * 撮影時刻から名前を作る。同じ秒に2枚撮れることがあるので、既存と
 * ぶつかったら連番を足す（黙って上書きしない）。
 */
export function nextScreenshotName(existingNames, now) {
  const date = new Date(now);
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}`
    + `-${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}`;
  const taken = new Set(existingNames);
  const base = `sprout68k-${stamp}.png`;
  if (!taken.has(base)) return base;
  for (let index = 2; ; index++) {
    const candidate = `sprout68k-${stamp}-${index}.png`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 新しい順に limit 枚だけ残し、捨てるものを返す。 */
export function pruneScreenshots(records, limit = SCREENSHOT_LIMIT) {
  const sorted = [...records].sort((left, right) => right.takenAt - left.takenAt);
  return { keep: sorted.slice(0, limit), discard: sorted.slice(limit) };
}

/**
 * canvas の現在の内容を、整数倍に拡大した PNG の Blob にする。
 * 補間は切る（image-rendering: pixelated と同じ見え方にする）。
 */
export async function captureCanvas(canvas, { createCanvas } = {}) {
  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) throw new Error('実行画面がまだ表示されていません');
  const scale = screenshotScale(width, height);
  const make = createCanvas ?? ((w, h) => {
    const element = document.createElement('canvas');
    element.width = w;
    element.height = h;
    return element;
  });
  const target = make(width * scale, height * scale);
  const context = target.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.drawImage(canvas, 0, 0, target.width, target.height);
  const blob = await new Promise((resolve) => target.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('画像を作れませんでした');
  return { blob, width: target.width, height: target.height, scale };
}

/** 画像だけを持つ小さな保管庫（ProjectFS とは別のデータベース）。 */
export class ScreenshotStore {
  constructor({ indexedDB = globalThis.indexedDB, databaseName = 'Sprout68kScreenshots' } = {}) {
    if (!indexedDB) throw new Error('IndexedDB を利用できません');
    this.indexedDB = indexedDB;
    this.databaseName = databaseName;
    this.database = null;
  }

  async open() {
    if (this.database) return this;
    this.database = await new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('shots', { keyPath: 'name' });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    return this;
  }

  async request(mode, action) {
    await this.open();
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction('shots', mode);
      const request = action(transaction.objectStore('shots'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** 新しい順。 */
  async list() {
    const records = await this.request('readonly', (store) => store.getAll());
    return records.sort((left, right) => right.takenAt - left.takenAt);
  }

  async add({ blob, width, height }, now = Date.now()) {
    const existing = await this.list();
    const name = nextScreenshotName(existing.map((record) => record.name), now);
    const record = { name, blob, width, height, takenAt: now };
    await this.request('readwrite', (store) => store.put(record));
    const { discard } = pruneScreenshots([...existing, record]);
    for (const old of discard) await this.delete(old.name);
    return record;
  }

  async delete(name) {
    await this.request('readwrite', (store) => store.delete(name));
  }
}
