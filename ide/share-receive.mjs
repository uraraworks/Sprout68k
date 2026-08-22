/* 共有リンクを受け取るときの、DOM も IndexedDB も使わない判断部分。
 * verify-ide.mjs が Node で直接テストする。
 */
import { SHARE_KEYS, tagLabel } from '../tools/share_v1.mts';

/** 受け取ったソースの置き場。**既存のファイルは絶対に上書きしない。** */
export function nextSharedPath(existingPaths) {
  const taken = new Set(existingPaths);
  if (!taken.has('shared.c')) return 'shared.c';
  for (let index = 2; ; index++) {
    const candidate = `shared-${index}.c`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** フラグメントに共有データが入っているか（入っていなければ何もしない）。 */
export function hasShareFragment(fragment) {
  if (typeof fragment !== 'string' || fragment.length < 2) return false;
  return Object.values(SHARE_KEYS).some((key) => new RegExp(`(?:^|[#&])${key}=`).test(fragment));
}

/** タグの表示。知らないタグは出さない（語彙を増やす前の版でも壊れない）。 */
export function tagSummaryText(tags) {
  const labels = (tags ?? []).map((code) => tagLabel(code)).filter(Boolean);
  return labels.length > 0 ? `（${labels.join('・')}）` : '';
}
