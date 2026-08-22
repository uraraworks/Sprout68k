export type DiagnosticSeverity = 'error' | 'warning';

export interface DiagnosticAnnotation {
  id: string;
  severity: DiagnosticSeverity;
  file?: string;
  line?: number;
  column?: number;
  what: string;
  next: string;
}

interface AnnotationRule {
  id: string;
  pattern: RegExp;
  specificity: number;
  what: string;
  next: string;
}

/* 2026-08-22に同梱memfs版cc1/ldから採取した文面だけを規則化する。 */
const RULES: readonly AnnotationRule[] = [
  {
    id: 'missing_semicolon', specificity: 220,
    pattern: /error: expected (?:',' or )?';' before /,
    what: 'この行より前の文が、セミコロン（;）で終わっていない可能性があります。',
    next: '示された行の直前を見て、文末の「;」が抜けていないか確認してください。',
  },
  {
    id: 'missing_parenthesis', specificity: 220,
    pattern: /error: expected '\)' before /,
    what: '開き丸括弧「(」に対応する閉じ丸括弧「)」が、この位置までに見つかりません。',
    next: 'キャレットから左へたどり、if・for・関数呼び出しで開いた「(」を「)」で閉じてください。',
  },
  {
    id: 'missing_brace', specificity: 240,
    pattern: /error: expected declaration or statement at end of input/,
    what: 'ファイル末尾まで読んでも、開いた処理ブロックが閉じられていません。',
    next: 'この行より上の「{」と「}」を対応させ、閉じていないブロックに「}」を追加してください。',
  },
  {
    id: 'undeclared_variable', specificity: 230,
    pattern: /error: '[^']+' undeclared \(first use in this function\)/,
    what: 'キャレット位置の名前は、使う前に変数として宣言されていません。',
    next: '名前の綴りを確認し、新しい変数なら、この関数内で使う前に型と名前を宣言してください。',
  },
  {
    id: 'undeclared_function', specificity: 230,
    pattern: /warning: implicit declaration of function '[^']+'/,
    what: '呼び出した関数の宣言が、この位置より前に見つかりません。',
    next: '関数名の綴り、必要な#include、または関数定義より前のプロトタイプ宣言を確認してください。',
  },
  {
    id: 'integer_to_pointer', specificity: 250,
    pattern: /warning: assignment to '[^']*\*' from '[^']+' makes pointer from integer without a cast/,
    what: '文字列やアドレスを入れる変数へ、整数を代入しています。',
    next: 'キャレット右側の値を確認し、文字列なら引用符で囲み、数値なら受け取る変数の型を見直してください。',
  },
  {
    id: 'assignment_in_condition', specificity: 250,
    pattern: /warning: suggest parentheses around assignment used as truth value/,
    what: 'ifなどの条件の中で、比較ではなく代入「=」が使われています。',
    next: '等しいか比べるつもりなら「==」に直してください。代入が目的なら括弧で意図を明示してください。',
  },
  {
    id: 'missing_header', specificity: 180,
    pattern: /fatal error: [^:]+: No such file or directory/,
    what: '#includeに書いたヘッダファイルが見つかりません。',
    next: '#include行のファイル名と綴りを確認し、X68kDevに用意されているヘッダ名へ直してください。',
  },
  {
    id: 'too_few_arguments', specificity: 240,
    pattern: /error: too few arguments to function '[^']+'/,
    what: '関数を呼ぶときに渡した値の数が、関数の宣言より少なくなっています。',
    next: '呼び出しの丸括弧内と「declared here」の宣言を見比べ、足りない引数を追加してください。',
  },
  {
    id: 'wrong_argument_type', specificity: 260,
    pattern: /warning: passing argument \d+ of '[^']+' makes pointer from integer without a cast/,
    what: '関数が文字列やアドレスを求める位置へ、整数を渡しています。',
    next: 'キャレットの引数と「expected ...」の行を見比べ、文字列なら引用符で囲むなど型を合わせてください。',
  },
  {
    id: 'misspelled_main', specificity: 300,
    pattern: /undefined reference to [`']main'/,
    what: '起動処理が、プログラムの入口になるmain関数を見つけられません。',
    next: '関数定義が「main」という綴りになっているか確認してください（例: mianの誤記）。',
  },
  {
    id: 'unused_variable', specificity: 220,
    pattern: /warning: unused variable '[^']+'/,
    what: '宣言した変数が、この関数の中で一度も使われていません。',
    next: '使う予定なら処理に組み込み、不要ならキャレット位置の宣言を削除してください。',
  },
  {
    id: 'missing_return', specificity: 260,
    pattern: /warning: no return statement in function returning non-void/,
    what: '値を返す関数として定義されていますが、return文がありません。',
    next: '閉じる「}」の前で「return 値;」を追加するか、値を返さない関数なら戻り値の型をvoidにしてください。',
  },
  {
    id: 'unterminated_string', specificity: 280,
    pattern: /(?:warning|error): missing terminating " character/,
    what: '文字列を始めた二重引用符「"」が閉じられていません。',
    next: 'キャレットの行で文字列の終わりに「"」を追加し、その後ろにセミコロンを書いてください。',
  },
];

interface ParsedLocation {
  severity: DiagnosticSeverity;
  file?: string;
  line?: number;
  column?: number;
}

function parseLocation(text: string): ParsedLocation {
  const located = text.match(/^(.+?):(\d+):(\d+): (warning|(?:fatal )?error): /);
  if (located) {
    return {
      file: located[1], line: Number(located[2]), column: Number(located[3]),
      severity: located[4] === 'warning' ? 'warning' : 'error',
    };
  }
  return { severity: /warning:/.test(text) ? 'warning' : 'error' };
}

export function matchingAnnotationRuleIds(diagnosticLine: string): string[] {
  return RULES.filter((rule) => rule.pattern.test(diagnosticLine)).map((rule) => rule.id);
}

function selectRule(diagnosticLine: string): AnnotationRule | undefined {
  const matches = RULES.filter((rule) => rule.pattern.test(diagnosticLine));
  matches.sort((left, right) => right.specificity - left.specificity);
  return matches[0];
}

/** 原文は変更せず保持し、診断行に根拠がある場合だけ日本語注釈を別データで重ねる。 */
export function annotateBuildDiagnostics(original: string): { original: string; annotations: DiagnosticAnnotation[] } {
  const annotations: DiagnosticAnnotation[] = [];
  const dedupe = new Map<string, number>();
  for (const line of original.split('\n')) {
    const rule = selectRule(line);
    if (!rule) continue;
    const location = parseLocation(line);
    const annotation: DiagnosticAnnotation = { id: rule.id, ...location, what: rule.what, next: rule.next };
    const key = `${rule.id}:${location.file ?? ''}:${location.line ?? ''}:${location.column ?? ''}`;
    const previousIndex = dedupe.get(key);
    if (previousIndex === undefined) {
      dedupe.set(key, annotations.length);
      annotations.push(annotation);
    } else if (annotations[previousIndex].severity === 'warning' && annotation.severity === 'error') {
      annotations[previousIndex] = annotation;
    }
  }
  return { original, annotations };
}
