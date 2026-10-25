// 外部エラー本文をログへ渡さず、信頼済み処理が確定した理由だけを境界越しに伝える。
export const failureReasons = [
  'INPUT_INVALID',
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
  constructor(reason: FailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}
export function validFailureReason(value: string | undefined): value is FailureReason {
  return typeof value === 'string' && failureReasons.some((reason) => reason === value);
}
