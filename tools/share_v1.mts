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

/* ============================================================
 * 共有URLのフラグメント（第1版）
 *
 * 2種類あり、開く先が違う。**どちらもサーバへは送られない**
 * （# 以降はブラウザの中だけに留まる）。
 *
 *   #p1=<データ>  利用者コードのバイナリ。WebX68k で「遊ぶ」ためのもの。
 *                 受け手に要るのは px68k だけ。ただしランタイムのABI版に
 *                 縛られるので、過去版のランタイムを捨ててはいけない。
 *   #s1=<データ>  ソースそのもの。Sprout68k で「読む・直す」ためのもの。
 *                 受け手にコンパイラ(20MB)が要るかわりに、**ABI版に縛られない**
 *                 （受け取った側でコンパイルし直すため、ランタイムが
 *                 v2, v3 と進んでも動き続ける）。
 *
 * データ部の中身は [方式1バイト] + [本体] を base64url にしたもの。
 *   方式 0x00 … 無圧縮
 *   方式 0x01 … deflate-raw
 * gzip ではなく deflate-raw を使うのは、ヘッダ・フッタ・CRC の18バイトが
 * 丸ごと不要になるため（実測: 全ケースで18バイト＝base64で24文字ぶん小さい）。
 * 小さいプログラムは圧縮がほとんど効かない（実測: hello.c は 64→63バイト）ので、
 * 縮まなければ無圧縮を選ぶ。**この判断は送信側が行い、方式バイトで受信側に伝える**
 * （受信側が推測しなくて済むようにする）。
 * 圧縮の実装はブラウザ(CompressionStream)とNode(zlib)で違うので、この層では
 * 関数として受け取る（このファイルは受信側と共用するため node 組み込みを import しない）。
 * ============================================================ */

export type Deflate = (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array;
export type Inflate = (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array;

/** データ部の先頭1バイト。**一度公開したら値の意味を変えない**。 */
export const SHARE_METHOD_STORED = 0x00;
export const SHARE_METHOD_DEFLATE_RAW = 0x01;

export type ShareKind = 'binary' | 'source';

/** フラグメントの鍵。**一度公開したら変えない**（古いリンクが開けなくなる）。 */
export const SHARE_KEYS: Record<ShareKind, string> = { binary: 'p1', source: 's1' };

/** X に貼っても「リンク」として扱われる安全圏（実測値。超えると生の文字列になる）。 */
export const SHARE_URL_SAFE_LIMIT = 4000;

export async function encodeShareFragment(kind: ShareKind, bytes: Uint8Array, deflate: Deflate): Promise<string> {
  const compressed = new Uint8Array(await deflate(bytes));
  /* 縮まなかったら無圧縮で載せる（短いプログラムでは圧縮が増やすことがある）。 */
  const useCompressed = compressed.length < bytes.length;
  const body = useCompressed ? compressed : bytes;
  const data = new Uint8Array(1 + body.length);
  data[0] = useCompressed ? SHARE_METHOD_DEFLATE_RAW : SHARE_METHOD_STORED;
  data.set(body, 1);
  return `${SHARE_KEYS[kind]}=${toBase64Url(data)}`;
}

export async function decodeShareFragment(
  fragment: string, inflate: Inflate,
): Promise<{ kind: ShareKind; bytes: Uint8Array }> {
  const text = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  for (const [kind, key] of Object.entries(SHARE_KEYS) as [ShareKind, string][]) {
    /* 鍵は先頭に来る想定だが、他のパラメータと & で並んでいても拾えるようにする。 */
    const match = new RegExp(`(?:^|&)${key}=([A-Za-z0-9_-]+)`).exec(text);
    if (!match) continue;
    const data = fromBase64Url(match[1]);
    if (data.length < 1) throw new Error('共有データが空です');
    const method = data[0];
    const body = data.subarray(1);
    if (method === SHARE_METHOD_STORED) return { kind, bytes: new Uint8Array(body) };
    if (method === SHARE_METHOD_DEFLATE_RAW) return { kind, bytes: new Uint8Array(await inflate(body)) };
    throw new Error(`知らない圧縮方式です (0x${method.toString(16)})`);
  }
  throw new Error('共有データが見つかりません');
}

/** ソースはUTF-8で載せる（日本語のコメントをそのまま運ぶため）。 */
export function encodeSourceText(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

export function decodeSourceText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
