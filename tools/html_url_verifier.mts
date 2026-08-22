import { existsSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export interface ResolvedHtmlReference {
  attribute: 'href' | 'src';
  reference: string;
  url: URL;
  file: string;
}

function attribute(tag: string, name: string): string {
  return tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`, 'i'))?.slice(1).find(Boolean) ?? '';
}

function publicFile(publicRoot: string, scopePath: string, url: URL): string {
  const pathname = decodeURIComponent(url.pathname);
  if (!pathname.startsWith(scopePath)) throw new Error(`アプリscope外のローカルURLです: ${pathname}`);
  const relativePath = pathname.slice(scopePath.length);
  let file = resolve(publicRoot, relativePath);
  const fromRoot = relative(publicRoot, file);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) throw new Error(`公開ルート外を参照しています: ${pathname}`);
  if (existsSync(file) && statSync(file).isDirectory()) file = resolve(file, 'index.html');
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`HTML URLを公開物へ解決できません: ${pathname} -> ${relative(publicRoot, file)}`);
  }
  return file;
}

export function verifyHtmlUrls(
  html: string,
  documentUrl: string,
  publicRoot: string,
  scopePath: string,
  requireIconAndManifest = true,
): ResolvedHtmlReference[] {
  const document = new URL(documentUrl);
  const results: ResolvedHtmlReference[] = [];
  for (const match of html.matchAll(/<(?:link|script|img|a)\b[^>]*\s(href|src)=(?:"([^"]*)"|'([^']*)')[^>]*>/gi)) {
    const reference = match[2] ?? match[3] ?? '';
    if (!reference) continue;
    const url = new URL(reference, document);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== document.origin) continue;
    results.push({ attribute: match[1].toLowerCase() as 'href' | 'src', reference, url,
      file: publicFile(publicRoot, scopePath, url) });
  }
  if (results.length === 0) throw new Error('HTMLからローカルURLを抽出できません');

  if (requireIconAndManifest) {
    const linkTags = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
    const iconLinks = linkTags.filter((tag) => attribute(tag, 'rel').split(/\s+/).includes('icon'));
    const manifestLinks = linkTags.filter((tag) => attribute(tag, 'rel').split(/\s+/).includes('manifest'));
    if (iconLinks.length === 0) throw new Error('favicon参照がありません');
    if (manifestLinks.length !== 1) throw new Error(`manifest参照が1件ではありません: ${manifestLinks.length}`);
    for (const tag of [...iconLinks, ...manifestLinks]) {
      const reference = attribute(tag, 'href');
      if (!results.some((entry) => entry.reference === reference)) {
        throw new Error(`favicon/manifest URLを解決できません: ${reference}`);
      }
    }
  }
  return results;
}
