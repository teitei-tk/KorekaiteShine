import type { FailureDetail } from './diagnostics.ts';
// 外部エラー本文をログへ渡さず、信頼済み処理が確定した理由だけを境界越しに伝える。
export const failureReasons = [
  'INPUT_INVALID',
  'COST_BUDGET_EXCEEDED',
  'TOKEN_COUNT_FAILED',
  'INPUT_TOKEN_LIMIT',
  'TIME_BUDGET_EXCEEDED',
  'USAGE_INVALID',
  'TARGET_FAILED',
  'HISTORY_FAILED',
  'COLLECTION_FAILED',
  'UNRESOLVED_REFERENCE',
  'BUDGET_EXCEEDED',
  'AUTH_FAILED',
  'MODEL_FAILED',
  'OUTPUT_INVALID',
  'INCOMPLETE',
  'CONFLICT',
  'MISSING_EVIDENCE',
  'ARTIFACT_INVALID',
] as const;
export type FailureReason = (typeof failureReasons)[number];
export class ReviewFailure extends Error {
  readonly reason: FailureReason;
  readonly detail?: FailureDetail;
  constructor(reason: FailureReason, message: string, detail?: FailureDetail) {
    super(message);
    this.reason = reason;
    this.detail = detail;
  }
}
export function validFailureReason(value: string | undefined): value is FailureReason {
  return typeof value === 'string' && failureReasons.some((reason) => reason === value);
}
