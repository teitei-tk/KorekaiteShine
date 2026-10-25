import type { ReviewPlan, ReviewTask } from './partition.ts';

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
export interface FailureDetail {
  subcode: Subcode;
  missing: MissingKind[];
}
export interface DetailInput {
  subcode?: string;
  missing?: string[];
}
interface SourceRange {
  id: string;
  start: number;
  end: number;
  revisions: ('head' | 'base' | 'ancestor')[];
}
export interface TaskScope {
  kind: ReviewTask['kind'];
  sourceCount: number;
  obligationCount: number;
  sources: SourceRange[];
  obligations: string[];
}
export interface Diagnostic extends FailureDetail {
  scope?: TaskScope;
}
export interface DiagnosticInput extends DetailInput {
  scope?: {
    kind?: string;
    sourceCount?: number;
    obligationCount?: number;
    sources?: { id?: string; start?: number; end?: number; revisions?: string[] }[];
    obligations?: string[];
  };
}
const only = (value: object, keys: string[]) =>
  !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
const count = (n: number | undefined): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000;
const id = (value: string | undefined): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function classification(value: DetailInput): boolean {
  return (
    subcodes.some((code) => code === value.subcode) &&
    Array.isArray(value.missing) &&
    value.missing.length <= missingKinds.length &&
    new Set(value.missing).size === value.missing.length &&
    value.missing.every((kind) => missingKinds.some((allowed) => allowed === kind))
  );
}
export function validDetail(value: DetailInput | null | undefined): value is FailureDetail {
  return (
    !!value &&
    typeof value === 'object' &&
    only(value, ['subcode', 'missing']) &&
    classification(value)
  );
}
export function detail(subcode: Subcode, missing: MissingKind[] = []): FailureDetail {
  const value = { subcode, missing: [...missing] };
  if (!validDetail(value)) throw new Error('診断分類が不正です');
  return value;
}
export function validDiagnostic(value: DiagnosticInput | null | undefined): value is Diagnostic {
  if (
    !value ||
    typeof value !== 'object' ||
    !only(value, ['subcode', 'missing', 'scope']) ||
    !classification(value)
  )
    return false;
  const scope = value.scope;
  if (scope === undefined) return true;
  if (
    !scope ||
    typeof scope !== 'object' ||
    !only(scope, ['kind', 'sourceCount', 'obligationCount', 'sources', 'obligations']) ||
    !['unit', 'boundary', 'history', 'reconcile'].includes(scope.kind ?? '') ||
    !count(scope.sourceCount) ||
    !count(scope.obligationCount) ||
    !Array.isArray(scope.sources) ||
    scope.sources.length !== Math.min(8, scope.sourceCount) ||
    !Array.isArray(scope.obligations) ||
    scope.obligations.length !== Math.min(8, scope.obligationCount) ||
    !scope.obligations.every(
      (value) => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value),
    ) ||
    new Set(scope.obligations).size !== scope.obligations.length ||
    new Set(scope.sources.map((s) => s?.id)).size !== scope.sources.length
  )
    return false;
  return scope.sources.every(
    (s) =>
      !!s &&
      typeof s === 'object' &&
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
      s.revisions.every((r) => ['head', 'base', 'ancestor'].includes(r)),
  );
}
export function taskScope(plan: ReviewPlan, task: ReviewTask): TaskScope {
  const scope: TaskScope = {
    kind: task.kind,
    sourceCount: task.sources.length,
    obligationCount: task.obligations.length,
    sources: task.sources.slice(0, 8).map((sourceId) => {
      const source = plan.sources.find((s) => s.id === sourceId);
      if (!source) throw new Error('診断資料が台帳にありません');
      return {
        id: source.id,
        start: source.start,
        end: source.end,
        revisions: (['head', 'base', 'ancestor'] as const).filter((key) =>
          source.revisions.includes(plan.metadata[key] ?? ''),
        ),
      };
    }),
    obligations: task.obligations.slice(0, 8),
  };
  if (!validDiagnostic({ ...detail('UNCLASSIFIED'), scope })) throw new Error('診断範囲が不正です');
  return scope;
}
export function renderDiagnostic(value: DiagnosticInput): string {
  if (!validDiagnostic(value)) throw new Error('診断の形式が不正です');
  const lines = [
    `サブコード: ${value.subcode}。不足情報: ${value.missing.join(', ') || '申告なし'}。`,
  ];
  if (value.scope) {
    const s = value.scope;
    lines.push(
      `作業種別: ${s.kind}。資料: ${s.sources.length}/${s.sourceCount}件、確認対象: ${s.obligations.length}/${s.obligationCount}件を表示。`,
    );
    lines.push(
      ...s.sources.map(
        (source) =>
          `資料ID: ${source.id}、行: ${source.start}-${source.end}、版: ${source.revisions.join(', ')}。`,
      ),
    );
    lines.push(...s.obligations.map((obligation) => `確認対象ID: ${obligation}。`));
  }
  return lines.join('\n\n');
}
