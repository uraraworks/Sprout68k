/* 壊れた実ソースをmemfs版cc1/ldで処理し、注釈・素通し・衝突を検証する。 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotateBuildDiagnostics, matchingAnnotationRuleIds } from './diagnostic_annotations.mts';
import { collectDiagnostics } from './collect_diagnostics.mts';
import { rewriteBuildDiagnostic } from './diagnostics.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const CASE_DIR = resolve(ROOT, 'tools/diagnostic-cases');
const disableAnnotations = process.env.X68KDEV_DIAGNOSTIC_ANNOTATION_FAULT === '1';
const collected = await collectDiagnostics();
let annotatedCount = 0;
let collisionCount = 0;
let sawError = false;
let sawWarning = false;

for (const testCase of collected) {
  const normalized = rewriteBuildDiagnostic(testCase.diagnostics, {
    workspaceRoot: ROOT,
    internalSourcePath: resolve(CASE_DIR, testCase.file),
    displaySourcePath: testCase.file,
  });
  const presentation = disableAnnotations
    ? { original: normalized, annotations: [] }
    : annotateBuildDiagnostics(normalized);

  if (presentation.original !== normalized) {
    throw new Error(`${testCase.id}: GCC/ld原文が変更されました`);
  }
  for (const line of normalized.split('\n')) {
    const matches = matchingAnnotationRuleIds(line);
    if (matches.length > 1) {
      collisionCount++;
      throw new Error(`${testCase.id}: 1診断に複数規則が一致: ${matches.join(', ')}`);
    }
  }

  if (testCase.annotated) {
    if (!presentation.annotations.some((annotation) => annotation.id === testCase.id)) {
      throw new Error(`${testCase.id}: 期待する注釈が実診断に付きませんでした`);
    }
    annotatedCount++;
    sawError ||= presentation.annotations.some((annotation) => annotation.severity === 'error');
    sawWarning ||= presentation.annotations.some((annotation) => annotation.severity === 'warning');
  } else {
    if (presentation.annotations.length !== 0) {
      throw new Error(`${testCase.id}: 未知の診断に誤った注釈が付きました`);
    }
    console.log(`PASS(未知診断の素通し): ${normalized.split('\n').find((line) => line.includes('X68KDEV_RARE_DIAGNOSTIC_9173'))}`);
  }
}

const expectedCount = collected.filter((testCase) => testCase.annotated).length;
if (annotatedCount !== expectedCount) throw new Error(`注釈数不一致: ${annotatedCount}/${expectedCount}`);
if (!sawError || !sawWarning) throw new Error('エラーと警告の両方を区別して注釈できませんでした');
console.log(`PASS(実診断注釈): ${expectedCount}種類中${annotatedCount}種類に注釈、GCC/ld原文保持`);
console.log(`PASS(規則衝突): ${collisionCount}件（全診断で一致規則は最大1件）`);
console.log('診断日本語注釈検証 PASS');
