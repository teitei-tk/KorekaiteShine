import { isJsonObject } from './json.ts';
import type { JsonInput } from './json.ts';
import { validCoverage, renderCoverage } from './coverage-diagnostic.ts';
import type { CoverageDiagnostic } from './coverage-diagnostic.ts';

export const modelSubcodes = [
  'MODEL_UNSPECIFIED',
  'MISSING_CONTEXT',
  'NO_REVIEWABLE_LINE',
  'UNRESOLVED_CONFLICT',
] as const;
export const subcodes = [
  'API_INCOMPLETE',
  'TOKEN_LIMIT',
  'CONTENT_FILTER',
  'EMPTY_OUTPUT',
  'OUTPUT_LIMIT',
  'INVALID_JSON',
  'INVALID_RESULT',
  'REVIEW_FORMAT_INVALID',
  'FINDING_LOCATION_INVALID',
  'FINDING_DUPLICATE',
  'CHECK_TARGET_MISMATCH',
  'CHECK_RESULT_INVALID',
  'COVERAGE_MISMATCH',
  'EVIDENCE_MISMATCH',
  'CHECK_EVIDENCE_MISMATCH',
  'TASK_KIND_MISMATCH',
  'INVALID_DIAGNOSTIC',
  ...modelSubcodes,
  'UNCLASSIFIED',
] as const;
export const missingKinds = [
  'IMPLEMENTATION',
  'CALLER',
  'CONTRACT',
  'SPECIFICATION',
  'PRIOR_EVIDENCE',
  'REVIEWABLE_LINE',
] as const;
export type Subcode = (typeof subcodes)[number];
export type MissingKind = (typeof missingKinds)[number];
export type FailureDetail = {
  subcode: Subcode;
  missing: MissingKind[];
  coverage?: CoverageDiagnostic;
};
export type DetailInput = {
  subcode?: string;
  missing?: string[];
  coverage?: Partial<CoverageDiagnostic>;
};
type SourceRange = {
  id: string;
  start: number;
  end: number;
  revisions: ('head' | 'base' | 'ancestor')[];
};
export type TaskScope = {
  kind: 'unit' | 'boundary' | 'history' | 'reconcile';
  sourceCount: number;
  obligationCount: number;
  sources: SourceRange[];
  obligations: string[];
};
export type Diagnostic = {
  scope?: TaskScope;
} & FailureDetail;
export type DiagnosticInput = {
  scope?: {
    kind?: string;
    sourceCount?: number;
    obligationCount?: number;
    sources?: { id?: string; start?: number; end?: number; revisions?: string[] }[];
    obligations?: string[];
  };
} & DetailInput;
const only = (value: object, keys: string[]) =>
  !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
const count = (n: JsonInput): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000;
const id = (value: JsonInput): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function classification(value: Record<string, JsonInput>): boolean {
  return (
    (value.coverage === undefined ||
      (value.subcode === 'COVERAGE_MISMATCH' && validCoverage(value.coverage))) &&
    subcodes.some((code) => code === value.subcode) &&
    Array.isArray(value.missing) &&
    value.missing.length <= missingKinds.length &&
    new Set(value.missing).size === value.missing.length &&
    value.missing.every((kind) => missingKinds.some((allowed) => allowed === kind))
  );
}
export function validDetail(value: JsonInput): value is FailureDetail {
  return (
    isJsonObject(value) && only(value, ['subcode', 'missing', 'coverage']) && classification(value)
  );
}
export function detail(
  subcode: Subcode,
  missing: MissingKind[] = [],
  coverage?: CoverageDiagnostic,
): FailureDetail {
  const value = { subcode, missing: [...missing], ...(coverage ? { coverage } : {}) };
  if (!validDetail(value)) {
    throw new Error('診断分類が不正です');
  }
  return value;
}
export function validDiagnostic(value: JsonInput): value is Diagnostic {
  if (
    !isJsonObject(value) ||
    !only(value, ['subcode', 'missing', 'scope', 'coverage']) ||
    !classification(value)
  ) {
    return false;
  }
  const { scope } = value;
  if (scope === undefined) {
    return true;
  }
  if (
    !isJsonObject(scope) ||
    !only(scope, ['kind', 'sourceCount', 'obligationCount', 'sources', 'obligations']) ||
    typeof scope.kind !== 'string' ||
    !['unit', 'boundary', 'history', 'reconcile'].includes(scope.kind) ||
    !count(scope.sourceCount) ||
    !count(scope.obligationCount) ||
    !Array.isArray(scope.sources) ||
    scope.sources.length !== Math.min(8, scope.sourceCount) ||
    !Array.isArray(scope.obligations) ||
    scope.obligations.length !== Math.min(8, scope.obligationCount) ||
    !scope.obligations.every(
      (value) => typeof value === 'string' && /^[a-f0-9]{16}$/u.test(value),
    ) ||
    new Set(scope.obligations).size !== scope.obligations.length ||
    new Set(scope.sources.map((s) => (isJsonObject(s) ? s.id : undefined))).size !==
      scope.sources.length
  ) {
    return false;
  }
  return scope.sources.every(
    (s) =>
      isJsonObject(s) &&
      only(s, ['id', 'start', 'end', 'revisions']) &&
      id(s.id) &&
      count(s.start) &&
      s.start > 0 &&
      count(s.end) &&
      s.end >= s.start &&
      Array.isArray(s.revisions) &&
      s.revisions.length > 0 &&
      s.revisions.length <= 3 &&
      new Set(s.revisions).size === s.revisions.length &&
      s.revisions.every((r) => typeof r === 'string' && ['head', 'base', 'ancestor'].includes(r)),
  );
}
export function renderDiagnostic(value: DiagnosticInput): string {
  if (!validDiagnostic(value)) {
    throw new Error('診断の形式が不正です');
  }
  const lines = [
    `サブコード: ${value.subcode}。不足情報: ${value.missing.join(', ') || '申告なし'}。`,
  ];
  if (value.coverage) {
    lines.push(renderCoverage(value.coverage));
  }
  if (value.scope) {
    const s = value.scope;
    lines.push(
      `作業種別: ${s.kind}。資料: ${s.sources.length}/${s.sourceCount}件、確認対象: ${s.obligations.length}/${s.obligationCount}件を表示。`,
      ...s.sources.map(
        (source) =>
          `資料ID: ${source.id}、行: ${source.start}-${source.end}、版: ${source.revisions.join(', ')}。`,
      ),
      ...s.obligations.map((obligation) => `確認対象ID: ${obligation}。`),
    );
  }
  return lines.join('\n\n');
}
