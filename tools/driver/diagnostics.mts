export interface DiagnosticRewriteOptions {
  workspaceRoot: string;
  internalSourcePath: string;
  displaySourcePath: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * 学習者のソースは表示名へ戻し、残る作業領域内の生成物は basename のみにする。
 * パス以外の文字や改行には触れないため、GCC の文脈・ソース・キャレット行を保つ。
 */
export function rewriteBuildDiagnostic(text: string, options: DiagnosticRewriteOptions): string {
  let rewritten = text.split(options.internalSourcePath).join(options.displaySourcePath);
  const root = options.workspaceRoot.replace(/\/+$/, '');
  const internalPath = new RegExp(`${escapeRegExp(root)}/[^\\s:'"()]+`, 'g');
  rewritten = rewritten.replace(internalPath, (path) => basename(path));
  return rewritten;
}
