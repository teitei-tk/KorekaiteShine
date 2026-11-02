import type { diagnosticChecks } from '@korekaite/database';
import type { EvaluationResult } from '../domain/evaluation-result';

type Scenario = typeof diagnosticChecks.$inferSelect.scenario;
export async function evaluateDiagnostic(
  scenario: Scenario,
  attemptNumber: number,
): Promise<EvaluationResult> {
  if (scenario === 'exhaust_retries' || (scenario === 'retry_then_success' && attemptNumber === 1))
    return { ok: false, error: { code: 'SIMULATED_AI_FAILURE', retryable: true } };
  return { ok: true, value: { summary: 'ローカル診断の評価が完了しました。' } };
}
