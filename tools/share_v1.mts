/* 共有ペイロード（第1版）の組み立て。
 *
 * **ここは Sprout68k のビルド経路と、受信側（WebX68k）の両方が使う。**
 * 同じコードを通すので「共有リンクから作った .xdf が、普通にビルドした
 * .xdf とバイト一致する」ことで検証できる（片方だけ直して食い違う事故を
 * 構造的に防ぐ）。node 組み込みモジュールを import しないこと。
 *
 * 利用者ペイロードの形（12バイトのヘッダ＋本体）:
 *   +0  'S68K'  マジック
 *   +4  u16     ABI版
 *   +6  u16     予約(0)
 *   +8  u32     本体のバイト数
 *   +12 本体（先頭が利用者コードのエントリ）
 * すべてビッグエンディアン（m68k に合わせる）。
 */

export const USER_HEADER_SIZE = 12;
export const USER_MAGIC = [0x53, 0x36, 0x38, 0x4b]; /* 'S' '6' '8' 'K' */

export interface ShareLayout {
  ABI_VERSION: number;
  RUNTIME_BASE: number;
  USER_BASE: number;
  USER_LIMIT: number;
  USER_AREA_SIZE: number;
  SECTOR_SIZE: number;
  TOTAL_SECTORS: number;
}

/** .xdf の物理サイズ（px68k の disk_xdf.c と同じ 1024×1232）。 */
export const DEFAULT_DISK = { SECTOR_SIZE: 1024, TOTAL_SECTORS: 1232 };

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readU16(source: Uint8Array, offset: number): number {
  return (source[offset] << 8) | source[offset + 1];
}

function readU32(source: Uint8Array, offset: number): number {
  return ((source[offset] << 24) | (source[offset + 1] << 16) | (source[offset + 2] << 8) | source[offset + 3]) >>> 0;
}

/** 利用者コードの生バイト列にヘッダを付ける（これがURLに載るもの）。 */
export function packUserPayload(body: Uint8Array, layout: ShareLayout): Uint8Array {
  /* 上限はメモリではなくディスク上の固定長領域で決まる（下の assembleXdf 参照）。 */
  const capacity = layout.USER_AREA_SIZE - USER_HEADER_SIZE;
  if (body.length === 0) throw new Error('利用者コードが空です');
  if (body.length > capacity) {
    throw new Error(`利用者コードが共有できる大きさを超えています (${body.length} > ${capacity} バイト)`);
  }
  const payload = new Uint8Array(USER_HEADER_SIZE + body.length);
  payload.set(USER_MAGIC, 0);
  writeU16(payload, 4, layout.ABI_VERSION);
  writeU16(payload, 6, 0);
  writeU32(payload, 8, body.length);
  payload.set(body, USER_HEADER_SIZE);
  return payload;
}

/** ヘッダを検査して本体だけ取り出す。壊れたURLをここで弾く。 */
export function unpackUserPayload(payload: Uint8Array, layout: ShareLayout): Uint8Array {
  if (payload.length < USER_HEADER_SIZE) throw new Error('ペイロードが短すぎます');
  if (USER_MAGIC.some((byte, index) => payload[index] !== byte)) throw new Error('ペイロードの目印が合いません');
  const version = readU16(payload, 4);
  if (version !== layout.ABI_VERSION) {
    throw new Error(`ランタイムの版が違います (ペイロード=${version}, このランタイム=${layout.ABI_VERSION})`);
  }
  const size = readU32(payload, 8);
  if (USER_HEADER_SIZE + size !== payload.length) {
    throw new Error(`本体のバイト数がヘッダと合いません (ヘッダ=${size}, 実際=${payload.length - USER_HEADER_SIZE})`);
  }
  return payload.subarray(USER_HEADER_SIZE);
}

/**
 * ブートセクタ＋ランタイム＋利用者ペイロードから .xdf を組み立てる。
 *
 * ブートセクタは「先頭から SECTOR_COUNT セクタぶんを RUNTIME_BASE へ連続で読む」
 * だけの既存実装をそのまま使う。そのため、ランタイムの後ろを USER_BASE まで
 * 0 で埋めて1本の連続した塊にする（ブートセクタを新しく書かずに済み、
 * 実測済みの読み込み経路をそのまま流用できる）。
 *
 * 利用者ペイロードの置き場は USER_AREA_SIZE の**固定長**にする。可変にすると
 * セクタ数が変わり、ブートセクタを作り直さないといけなくなる。受信側は
 * アセンブラを持たないので、boot.bin と runtime.bin をそのまま持てるように
 * 固定長にしてある（＝この関数の出力は毎回同じ大きさ・同じセクタ数）。
 */
export function assembleXdf(
  boot: Uint8Array, runtime: Uint8Array, userPayload: Uint8Array, layout: ShareLayout,
): { image: Uint8Array; sectorCount: number; bodySize: number } {
  const runtimeCapacity = layout.USER_BASE - layout.RUNTIME_BASE;
  if (runtime.length > runtimeCapacity) {
    throw new Error(`ランタイムが利用者領域に食い込みます (${runtime.length} > ${runtimeCapacity} バイト)`);
  }
  if (boot.length > layout.SECTOR_SIZE) throw new Error('ブートセクタが1セクタを超えています');

  if (userPayload.length > layout.USER_AREA_SIZE) {
    throw new Error(`ペイロードが固定長領域を超えています (${userPayload.length} > ${layout.USER_AREA_SIZE} バイト)`);
  }
  const body = new Uint8Array(runtimeCapacity + layout.USER_AREA_SIZE);
  body.set(runtime, 0);
  body.set(userPayload, runtimeCapacity);

  const sectorCount = Math.ceil(body.length / layout.SECTOR_SIZE);
  const image = new Uint8Array(layout.SECTOR_SIZE * layout.TOTAL_SECTORS);
  if (layout.SECTOR_SIZE * (1 + sectorCount) > image.length) throw new Error('ディスクに収まりません');
  image.set(boot, 0);
  image.set(body, layout.SECTOR_SIZE);
  return { image, sectorCount, bodySize: body.length };
}

/** URL フラグメントに載せる形（gzip は呼び出し側が行う）。 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
