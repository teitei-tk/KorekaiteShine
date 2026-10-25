import { detail, validDetail } from './diagnostics.ts';
import type { FailureDetail } from './diagnostics.ts';
// 外部エラー本文をログへ渡さず、信頼済み処理が確定した理由だけを境界越しに伝える。
export const failureReasons = [
  'INPUT_INVALID',
  'COST_BUDGET_EXCEEDED',
  'TOKEN_COUNT_FAILED',
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

// 子プロセス境界には固定分類だけを渡す。Error.messageや外部オブジェクトは展開しない。
export function workerFailure(error?: ReviewFailure): {
  failure: FailureReason;
  detail?: FailureDetail;
} {
  if (!error) return { failure: 'MODEL_FAILED' };
  if (error.detail === undefined) return { failure: error.reason };
  if (!validDetail(error.detail))
    return { failure: 'OUTPUT_INVALID', detail: detail('INVALID_DIAGNOSTIC') };
  return { failure: error.reason, detail: detail(error.detail.subcode, error.detail.missing) };
}
