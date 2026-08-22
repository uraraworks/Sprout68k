#!/usr/bin/env node
/* 共有ランタイム方式（第1版）の検証。
 *
 * 見るのは4点:
 *   1. 生成物(ジャンプテーブル・番地表・リンカスクリプト)が入力から作った
 *      ものと一致する
 *   2. ABI表 runtime/abi_v1.txt が lib/include/x68.h の公開関数と一致し、
 *      ジャンプテーブルの実番地が番地表どおりに並んでいる（実際にビルドした
 *      ELF のシンボルで確かめる。表を読み合わせるだけにしない）
 *   3. runtime/layout_v1.txt の不等式が、実際のビルド結果に対して成立する
 *      （ランタイムが利用者領域に食い込まない・裏バッファがスタックを侵さない）
 *   4. 共有ペイロードの往復（pack → unpack、base64url の往復）が元に戻る
 * すべて故障注入つき。
 *
 * 前提: tools/build_shared.sh を1回通してあること（build/shared_obj/*.elf を見る）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { resolve } from 'node:path';
import { ROOT, ABI_SLOT_SIZE, abiAddress, readAbi, readLayout,
         renderAbiLinkerScript, renderJumpTable, renderRuntimeLinkerScript, renderUserLinkerScript } from './build_abi.mts';
import { DEFAULT_DISK, SHARE_KEYS, SHARE_METHOD_DEFLATE_RAW, SHARE_METHOD_STORED, SHARE_URL_SAFE_LIMIT, USER_HEADER_SIZE, assembleXdf,
         decodeShareFragment, decodeSourceText, encodeShareFragment, encodeSourceText,
         normalizeTags, packUserPayload, tagLabel, unpackUserPayload, toBase64Url, fromBase64Url,
         SHARE_TAGS } from './share_v1.mts';

const NM = process.env.M68K_NM ?? `${process.env.HOME}/x68kdev-toolchain/bin/m68k-elf-nm`;
const RUNTIME_ELF = resolve(ROOT, 'build/shared_obj/runtime.elf');
const USER_ELF = resolve(ROOT, 'build/shared_obj/user.elf');

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (condition) console.log(`PASS: ${message}`);
  else { console.log(`FAIL: ${message}`); failures.push(message); }
}

const layout = readLayout();
const names = readAbi();

/* ---- 1. 生成物が最新か ------------------------------------------- */
const generated: [string, string][] = [
  ['runtime/generated/jumptable_v1.S', renderJumpTable(names, layout)],
  ['runtime/generated/abi_v1.ld', renderAbiLinkerScript(names, layout)],
  ['runtime/generated/runtime_v1.ld', renderRuntimeLinkerScript(layout)],
  ['runtime/generated/user_v1.ld', renderUserLinkerScript(layout)],
];
for (const [path, expected] of generated) {
  check(readFileSync(resolve(ROOT, path), 'utf8') === expected, `${path} が入力から生成したものと一致する`);
}

/* ---- 2. ABI表と x68.h / 実ELF の突き合わせ ------------------------ */
const header = readFileSync(resolve(ROOT, 'lib/include/x68.h'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const declared = new Set<string>();
for (const match of header.matchAll(/^(?:const\s+)?(?:unsigned\s+|signed\s+)?[a-z_][a-z0-9_]*\s+\*?([a-z_][a-z0-9_]*)\s*\([^;]*\)\s*;/gmi)) {
  declared.add(match[1]);
}
const missing = [...declared].filter((name) => !names.includes(name));
check(missing.length === 0, `x68.h の全関数が ABI 表にある (不足: ${missing.join(', ') || 'なし'})`);
const strays = names.filter((name) => !declared.has(name));
check(strays.length === 0, `ABI 表に x68.h 由来でない名前が無い (余分: ${strays.join(', ') || 'なし'})`);
check(new Set(names).size === names.length, 'ABI 表に重複が無い');

function symbols(elf: string): Map<string, number> {
  const out = execFileSync(NM, [elf], { encoding: 'utf8' });
  const table = new Map<string, number>();
  for (const line of out.split('\n')) {
    const match = /^([0-9a-f]+)\s+\S\s+(\S+)$/.exec(line.trim());
    if (match) table.set(match[2], parseInt(match[1], 16));
  }
  return table;
}

if (!existsSync(RUNTIME_ELF) || !existsSync(USER_ELF)) {
  check(false, `build/shared_obj の ELF が無い。先に tools/build_shared.sh を通すこと`);
} else {
  /* 利用者コード側で、各ライブラリ関数がジャンプテーブルの番地に解決されているか。
   * 「表どおりのはず」ではなく、実際にリンクされた結果を見る。 */
  const userSymbols = symbols(USER_ELF);
  const wrong = names
    .map((name, index) => ({ name, want: abiAddress(layout, index), got: userSymbols.get(name) }))
    .filter((entry) => entry.got !== undefined && entry.got !== entry.want);
  for (const entry of wrong) console.log(`  ${entry.name}: want=0x${entry.want.toString(16)} got=0x${entry.got!.toString(16)}`);
  check(wrong.length === 0, `利用者コードの参照がジャンプテーブルの番地に解決されている (ずれ: ${wrong.length}件)`);

  const resolvedCount = names.filter((name) => userSymbols.has(name)).length;
  check(resolvedCount > 0, `利用者コードが実際にライブラリ関数を参照している (${resolvedCount}件)`);

  /* ランタイム側に実体があるか（ジャンプテーブルが飛ぶ先） */
  const runtimeSymbols = symbols(RUNTIME_ELF);
  const noBody = names.filter((name) => !runtimeSymbols.has(name));
  check(noBody.length === 0, `ABI の全関数がランタイムに実体を持つ (欠落: ${noBody.join(', ') || 'なし'})`);

  /* ---- 3. 配置の不等式 ------------------------------------------- */
  const runtimeEnd = runtimeSymbols.get('__runtime_end')!;
  const bssEnd = runtimeSymbols.get('__bss_end')!;
  check(runtimeEnd <= layout.get('USER_BASE')!,
    `ランタイムが利用者領域に食い込まない (末尾=0x${runtimeEnd.toString(16)} <= USER_BASE=0x${layout.get('USER_BASE')!.toString(16)}, 余り ${layout.get('USER_BASE')! - runtimeEnd} バイト)`);
  const stackFloor = layout.get('STACK_ADDR')! - layout.get('STACK_MARGIN')!;
  check(bssEnd <= stackFloor,
    `裏バッファがスタックを侵さない (bss末尾=0x${bssEnd.toString(16)} <= スタック-マージン=0x${stackFloor.toString(16)}, 余り ${stackFloor - bssEnd} バイト)`);
  check(layout.get('STACK_ADDR')! < layout.get('RAM_SIZE')!, 'スタックが搭載RAMの内側にある');
  check(layout.get('USER_LIMIT')! === layout.get('RUNTIME_BSS_BASE')!, '利用者領域の終端と裏バッファの先頭が接している');
  check(layout.get('ABI_TABLE_BASE')! === layout.get('RUNTIME_BASE')! + 8, 'ジャンプテーブルがランタイム先頭+8にある');

  const userEnd = symbols(USER_ELF).get('__bss_end')!;
  check(userEnd <= layout.get('USER_LIMIT')!,
    `利用者コードが利用者領域に収まる (末尾=0x${userEnd.toString(16)} <= USER_LIMIT=0x${layout.get('USER_LIMIT')!.toString(16)})`);
}

/* Node 側の圧縮実装。ブラウザは CompressionStream('deflate-raw') を使う。 */
const deflate = (bytes: Uint8Array) => new Uint8Array(deflateRawSync(bytes, { level: 9 }));
const inflate = (bytes: Uint8Array) => new Uint8Array(inflateRawSync(bytes));

/* ---- 4. ペイロードの往復 ------------------------------------------ */
const shareLayout = {
  ABI_VERSION: layout.get('ABI_VERSION')!, RUNTIME_BASE: layout.get('RUNTIME_BASE')!,
  USER_BASE: layout.get('USER_BASE')!, USER_LIMIT: layout.get('USER_LIMIT')!,
  USER_AREA_SIZE: layout.get('USER_AREA_SIZE')!, ...DEFAULT_DISK,
};
const body = new Uint8Array(Array.from({ length: 777 }, (_, index) => (index * 37) & 0xff));
const payload = packUserPayload(body, shareLayout);
check(payload.length === USER_HEADER_SIZE + body.length, 'ヘッダ長ぶんだけ増えている');
const restored = unpackUserPayload(fromBase64Url(toBase64Url(payload)), shareLayout);
check(restored.length === body.length && restored.every((byte, index) => byte === body[index]),
  'pack → base64url → 復号 → unpack で元のバイト列に戻る');

function rejects(label: string, mutate: (bytes: Uint8Array) => void): void {
  const broken = new Uint8Array(payload);
  mutate(broken);
  let rejected = false;
  try { unpackUserPayload(broken, shareLayout); } catch { rejected = true; }
  check(rejected, `故障注入: ${label} を弾く`);
}
rejects('目印の1バイト改変', (bytes) => { bytes[0] ^= 0xff; });
rejects('ABI版の改変', (bytes) => { bytes[5] = 2; });
rejects('本体バイト数の改変', (bytes) => { bytes[11] ^= 0x01; });
{
  let rejected = false;
  try { unpackUserPayload(payload.subarray(0, payload.length - 1), shareLayout); } catch { rejected = true; }
  check(rejected, '故障注入: 末尾1バイトが欠けたペイロードを弾く');
}
{
  let rejected = false;
  try { packUserPayload(new Uint8Array(layout.get('USER_LIMIT')! - layout.get('USER_BASE')!), shareLayout); } catch { rejected = true; }
  check(rejected, '故障注入: 利用者領域に収まらない大きさを弾く');
}
/* 生成物の故障注入: ABI表を1行入れ替えたら番地表が変わることを確かめる
 * （検査そのものが番地を見ていることの陽性対照）。 */
{
  const swapped = [...names];
  [swapped[4], swapped[5]] = [swapped[5], swapped[4]];
  check(renderAbiLinkerScript(swapped, layout) !== renderAbiLinkerScript(names, layout),
    '故障注入: ABI表の並べ替えが番地表に現れる');
}

/* ---- 5. 共有URLからの復元がビルド成果物とバイト一致するか --------- *
 * これが「合体処理はビルド経路と同じ」の実証。受信側は boot.bin と
 * runtime.bin を固定で持ち、URLから復元したペイロードを差し込むだけ。 */
const bootBin = resolve(ROOT, 'build/shared_obj/boot.bin');
const runtimeBin = resolve(ROOT, 'build/shared_obj/runtime.bin');
const builtXdf = resolve(ROOT, 'build/shared_breakout.xdf');
const builtPayload = resolve(ROOT, 'build/shared_breakout.payload');
if (![bootBin, runtimeBin, builtXdf, builtPayload].every(existsSync)) {
  check(false, 'build/shared_breakout.xdf 等が無い。先に tools/build_shared.sh を通すこと');
} else {
  const payloadBytes = new Uint8Array(readFileSync(builtPayload));
  /* 送信側と同じ道を通す（鍵と圧縮方式の選択まで含めて encodeShareFragment に任せる）。 */
  const fragment = await encodeShareFragment('binary', payloadBytes, deflate);
  const url = fragment.slice(SHARE_KEYS.binary.length + 1);
  console.log(`  共有URLのデータ部: ${url.length} 文字 (X の安全圏 4000 文字の ${(url.length / 40).toFixed(0)}%)`);
  check(url.length <= 4000, `共有URLがXの安全圏(4000文字)に収まる (${url.length} 文字)`);
  check(/^[A-Za-z0-9_-]+$/.test(url), '共有URLのデータ部がURLで安全な文字だけでできている');

  /* 受信側の道: base64url復号 → gunzip → 検査 → 組み立て */
  const received = unpackUserPayload((await decodeShareFragment(fragment, inflate)).bytes, shareLayout);
  const rebuilt = assembleXdf(
    new Uint8Array(readFileSync(bootBin)), new Uint8Array(readFileSync(runtimeBin)),
    packUserPayload(received, shareLayout), shareLayout,
  );
  const built = new Uint8Array(readFileSync(builtXdf));
  const same = rebuilt.image.length === built.length && rebuilt.image.every((byte, index) => byte === built[index]);
  check(same, `共有URLから復元した .xdf がビルドした .xdf とバイト一致する (${rebuilt.sectorCount} セクタ)`);

  /* 故障注入: URLの1文字を変えたら一致しない（または復号で弾かれる） */
  const brokenUrl = `${url.slice(0, 20)}${url[20] === 'A' ? 'B' : 'A'}${url.slice(21)}`;
  check(brokenUrl !== url, '故障注入: URLを実際に1文字書き換えた（陽性対照）');
  let detected = false;
  try {
    const broken = unpackUserPayload(
      (await decodeShareFragment(`${SHARE_KEYS.binary}=${brokenUrl}`, inflate)).bytes, shareLayout);
    const image = assembleXdf(
      new Uint8Array(readFileSync(bootBin)), new Uint8Array(readFileSync(runtimeBin)),
      packUserPayload(broken, shareLayout), shareLayout,
    ).image;
    detected = !image.every((byte, index) => byte === built[index]);
  } catch { detected = true; }
  check(detected, '故障注入: URLを1文字書き換えると復元結果が変わる（または弾かれる）');
}

/* ---- 6. 共有フラグメントの2種類（バイナリ / ソース） --------------- */
{
  /* ソース共有: 日本語コメント入りのソースがそのまま戻ること。
   * ソースはUTF-8で載せるので、ここで壊れると学習者のコメントが化ける。 */
  const source = readFileSync(resolve(ROOT, 'samples/breakout/block.c'), 'utf8');
  const fragment = await encodeShareFragment('source', encodeSourceText(source), deflate);
  const decoded = await decodeShareFragment(`#${fragment}`, inflate);
  check(decoded.kind === 'source', `ソースのフラグメントが source として判別される (鍵=${SHARE_KEYS.source})`);
  check(decodeSourceText(decoded.bytes) === source, 'ソース共有が1文字も変わらずに戻る');
  const length = fragment.length - SHARE_KEYS.source.length - 1;
  console.log(`  ソース共有のデータ部: ${length} 文字 (安全圏 ${SHARE_URL_SAFE_LIMIT} の ${(length / SHARE_URL_SAFE_LIMIT * 100).toFixed(0)}%)`);
  check(length <= SHARE_URL_SAFE_LIMIT, `ブロック崩しのソース共有が安全圏に収まる (${length} 文字)`);

  /* 圧縮が効かない小さいソースでは無圧縮が選ばれ、それでも往復すること。
   * 「縮まなければ無圧縮」の分岐が実際に踏まれることを、方式バイトで確かめる。 */
  const tiny = 'x';
  const tinyFragment = await encodeShareFragment('source', encodeSourceText(tiny), deflate);
  const tinyMethod = fromBase64Url(tinyFragment.split('=')[1])[0];
  check(tinyMethod === SHARE_METHOD_STORED, `圧縮が効かない入力では無圧縮が選ばれる (方式=0x${tinyMethod.toString(16)})`);
  check(decodeSourceText((await decodeShareFragment(tinyFragment, inflate)).bytes) === tiny, '無圧縮のまま往復する');
  const bigMethod = fromBase64Url(fragment.split('=')[1])[0];
  check(bigMethod === SHARE_METHOD_DEFLATE_RAW, `よく縮む入力では deflate-raw が選ばれる (方式=0x${bigMethod.toString(16)})`);

  /* 日本語を含む短いソースでも往復すること（陽性対照として別の入力でも見る） */
  const japanese = '#include "x68.h"\n\n// 星をばらまく（日本語コメント）\nvoid main(void) { x68_screen_open(); }\n';
  const roundTrip = decodeSourceText((await decodeShareFragment(
    await encodeShareFragment('source', encodeSourceText(japanese), deflate), inflate)).bytes);
  check(roundTrip === japanese, '日本語コメント入りの短いソースも往復する');

  /* バイナリ共有がソースと取り違えられないこと */
  const payloadBytes = new Uint8Array(readFileSync(resolve(ROOT, 'build/shared_breakout.payload')));
  const binaryFragment = await encodeShareFragment('binary', payloadBytes, deflate);
  const binaryDecoded = await decodeShareFragment(`#${binaryFragment}`, inflate);
  check(binaryDecoded.kind === 'binary', `バイナリのフラグメントが binary として判別される (鍵=${SHARE_KEYS.binary})`);
  check(binaryDecoded.bytes.length === payloadBytes.length
    && binaryDecoded.bytes.every((byte, index) => byte === payloadBytes[index]), 'バイナリ共有が元のバイト列に戻る');

  /* 故障注入 */
  let rejected = false;
  try { await decodeShareFragment('#q9=AAAA', inflate); } catch { rejected = true; }
  check(rejected, '故障注入: 知らない鍵のフラグメントを弾く');
  rejected = false;
  try { await decodeShareFragment('#', inflate); } catch { rejected = true; }
  check(rejected, '故障注入: 空のフラグメントを弾く');
  rejected = false;
  try { decodeSourceText(new Uint8Array([0xff, 0xfe, 0xfd])); } catch { rejected = true; }
  check(rejected, '故障注入: UTF-8として壊れたソースを弾く');
  rejected = false;
  try { await decodeShareFragment(`${SHARE_KEYS.source}=${toBase64Url(new Uint8Array([0x7f, 1, 2, 3]))}`, inflate); } catch { rejected = true; }
  check(rejected, '故障注入: 知らない圧縮方式(0x7f)を弾く');

  /* ---- タグ（作者の自己申告） ---- */
  const tagged = await encodeShareFragment('binary', payloadBytes, deflate, ['mod', 'ai']);
  const taggedBack = await decodeShareFragment(`#${tagged}`, inflate);
  check(taggedBack.tags.join(',') === 'ai,mod', `タグが語彙の順に正規化されて戻る (${taggedBack.tags.join(',')})`);
  check(taggedBack.bytes.length === payloadBytes.length, 'タグを付けてもデータ部は変わらない');

  /* 知らないタグは黙って捨てる。これがあるので、後から語彙を増やしても
   * 古い受信側が壊れない（＝増やす側だけ直せばよい）。 */
  const withUnknown = await decodeShareFragment(`${SHARE_KEYS.binary}=${tagged.split('=')[1].split('&')[0]}&t=ai,zzz,beg`, inflate);
  check(withUnknown.tags.join(',') === 'ai,beg', `知らないタグを捨てて残りを活かす (${withUnknown.tags.join(',')})`);

  /* 同じ組み合わせなら常に同じURLになること（順序で別物にならない） */
  const orderA = await encodeShareFragment('binary', payloadBytes, deflate, ['beg', 'ai']);
  const orderB = await encodeShareFragment('binary', payloadBytes, deflate, ['ai', 'beg']);
  check(orderA === orderB, '同じタグの組み合わせなら並べ方が違っても同じURLになる');

  /* タグ無しのときは余計なものを足さない（短いほうが良い） */
  const noTag = await encodeShareFragment('binary', payloadBytes, deflate, []);
  check(!noTag.includes('&'), 'タグが無ければURLに何も足さない');
  check((await decodeShareFragment(noTag, inflate)).tags.length === 0, 'タグ無しは空で戻る');

  /* 語彙は表示できること（受信側でバッジにする） */
  check(SHARE_TAGS.every((tag) => tagLabel(tag.code)), '全タグに表示名がある');
  check(tagLabel('zzz') === null, '知らないタグには表示名が無い');
  check(normalizeTags(['ai', 'ai']).length === 1, '同じタグを2回書いても1つになる');
  const tagCost = tagged.length - noTag.length;
  console.log(`  タグ2件ぶんのURL増加: ${tagCost} 文字`);
}

console.log(`\nABI v${layout.get('ABI_VERSION')}: ${names.length} 関数 / スロット ${ABI_SLOT_SIZE} バイト`);
if (failures.length > 0) {
  console.log(`不合格 ${failures.length} 件`);
  process.exit(1);
}
console.log('すべて合格');
