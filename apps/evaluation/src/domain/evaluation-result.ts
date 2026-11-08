import type { components } from '@korekaite/api-contracts/http';

export type EvaluationValue = { summary: string } | components['schemas']['InterviewEvaluation'];
export interface EvaluationFailure {
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
}
export type EvaluationResult =
  | { ok: true; value: EvaluationValue }
  | { ok: false; error: EvaluationFailure };

export class EvaluationProviderError extends Error {
  constructor(readonly failure: EvaluationFailure) {
    super(failure.code);
  }
}
