export interface DiagnosticCase {
  id: string;
  file: string;
  stage: 'cc1' | 'link';
  annotated: boolean;
}

export const DIAGNOSTIC_CASES: readonly DiagnosticCase[] = [
  { id: 'missing_semicolon', file: '01_missing_semicolon.c', stage: 'cc1', annotated: true },
  { id: 'missing_parenthesis', file: '02_missing_parenthesis.c', stage: 'cc1', annotated: true },
  { id: 'missing_brace', file: '03_missing_brace.c', stage: 'cc1', annotated: true },
  { id: 'undeclared_variable', file: '04_undeclared_variable.c', stage: 'cc1', annotated: true },
  { id: 'undeclared_function', file: '05_undeclared_function.c', stage: 'cc1', annotated: true },
  { id: 'integer_to_pointer', file: '06_integer_to_pointer.c', stage: 'cc1', annotated: true },
  { id: 'assignment_in_condition', file: '07_assignment_in_condition.c', stage: 'cc1', annotated: true },
  { id: 'missing_header', file: '08_missing_header.c', stage: 'cc1', annotated: true },
  { id: 'too_few_arguments', file: '09_too_few_arguments.c', stage: 'cc1', annotated: true },
  { id: 'wrong_argument_type', file: '10_wrong_argument_type.c', stage: 'cc1', annotated: true },
  { id: 'misspelled_main', file: '11_misspelled_main.c', stage: 'link', annotated: true },
  { id: 'unused_variable', file: '12_unused_variable.c', stage: 'cc1', annotated: true },
  { id: 'missing_return', file: '13_missing_return.c', stage: 'cc1', annotated: true },
  { id: 'unterminated_string', file: '14_unterminated_string.c', stage: 'cc1', annotated: true },
  { id: 'unknown_passthrough', file: '99_unknown_pragma_error.c', stage: 'cc1', annotated: false },
];
