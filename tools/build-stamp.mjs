// フッタに出すビルド表記を組み立てる純関数。
//
// git を叩く側（tools/distribution.mts の commitTimestamp）と分けてあるので、
// 整形だけを Node から直接テストできる。
//
// 方針:
// - **壁時計を使わない。** 日付はコミット日時(コミッターdate, %ct)から取る。
//   同じコミットから何度ビルドしても同じ文字列になり、「配布物が本当に
//   コミットXのものか」を後から確認できる。
// - JST(UTC+9)は固定オフセットで計算する。toLocaleString/getHours 等の
//   ローカルタイムゾーン依存APIは使わない（ビルドする端末の設定で表記が
//   変わらないようにする）。日本に夏時間は無いので年間を通じてこれで正しい。
// - 括弧の中は **buildId（配布物の内容ハッシュ）**。コミットハッシュではない。
//   Service Worker のキャッシュ判定に使っている値そのもので、デプロイ直後に
//   「新しい版が届いているか」を突き合わせるのはこちら。
// - 日時が取れない場合は、もっともらしい値で埋めずに「date unknown」と出す。

function pad2(value) {
  return String(value).padStart(2, '0');
}

export const UNKNOWN_BUILD_DATE = 'date unknown';

/** コミット日時(unix秒)を JST の "YYYY-MM-DD HH:MM JST" にする。 */
export function formatBuildDate(commitTimestampSeconds) {
  if (!Number.isFinite(commitTimestampSeconds)) return UNKNOWN_BUILD_DATE;
  const jst = new Date(commitTimestampSeconds * 1000 + 9 * 3600 * 1000);
  const year = jst.getUTCFullYear();
  const month = pad2(jst.getUTCMonth() + 1);
  const day = pad2(jst.getUTCDate());
  const hour = pad2(jst.getUTCHours());
  const minute = pad2(jst.getUTCMinutes());
  return `${year}-${month}-${day} ${hour}:${minute} JST`;
}

/** フッタに出す1行。 */
export function formatBuildStamp(commitTimestampSeconds, buildId) {
  return `${formatBuildDate(commitTimestampSeconds)} (${buildId})`;
}
