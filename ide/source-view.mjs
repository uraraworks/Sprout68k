/** ファイル名からエディタ言語を選ぶ。68k アセンブラ対応は将来ここへ追加する。 */
export function sourceLanguage(path) {
  return /\.(?:c|h)$/i.test(path) ? 'c' : 'plain';
}

export function basename(path) {
  return path.split('/').pop() || path;
}
