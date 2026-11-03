import type { EvaluationFailure } from './evaluation-result';

export const retryDelaysMs = [30_000, 120_000, 300_000] as const;
export const maxEvaluationAttempts = retryDelaysMs.length + 1;

export function retryDelayMs(attemptNumber: number, failure: EvaluationFailure): number | null {
  const delay = retryDelaysMs[attemptNumber - 1];
  if (!failure.retryable || delay === undefined) {
    return null;
  }
  const retryAfter = failure.retryAfterMs ?? 0;
  if (!Number.isFinite(retryAfter) || retryAfter < 0) {
    throw new Error('再試行時刻が不正です。');
  }
  return Math.max(delay, retryAfter);
}
