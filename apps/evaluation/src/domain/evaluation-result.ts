export interface EvaluationFailure {
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
}
export type EvaluationResult =
  | { ok: true; value: { summary: string } }
  | { ok: false; error: EvaluationFailure };
