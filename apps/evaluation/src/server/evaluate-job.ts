import { Temporal } from '@js-temporal/polyfill';
import { reserveEvaluation } from './repositories/evaluation-usage';
import { EvaluationProviderError } from '../domain/evaluation-result';
import { and, eq, notExists } from 'void/db';
import { jobs, deletedJobs } from '@korekaite/database/jobs';
import { evaluationInputs } from '@korekaite/database/interviews';
import type { createPrimaryDb } from '@korekaite/database/connection';
import { evaluateInterview, type EvaluationGenerator } from '../application/evaluate-interview';
import type { EvaluationDependencies } from '../application/consume-job';

export function createJobEvaluator(
  db: ReturnType<typeof createPrimaryDb>,
  generate: EvaluationGenerator,
  now: () => number = () => Temporal.Now.instant().epochMilliseconds,
): EvaluationDependencies['evaluate'] {
  return async (jobId, attemptNumber, signal) => {
    const [saved] = await db
      .select({ input: evaluationInputs.inputJson, actorId: jobs.actorId })
      .from(evaluationInputs)
      .innerJoin(jobs, eq(jobs.jobId, evaluationInputs.jobId))
      .where(
        and(
          eq(jobs.jobId, jobId),
          eq(jobs.purpose, 'evaluation'),
          eq(jobs.status, 'running'),
          eq(jobs.attemptCount, attemptNumber),
          notExists(db.select().from(deletedJobs).where(eq(deletedJobs.jobId, jobId))),
        ),
      );
    if (!saved) {
      return { ok: false, error: { code: 'EVALUATION_INPUT_UNAVAILABLE', retryable: false } };
    }
    return evaluateInterview(saved.input, signal, async (input, activeSignal) => {
      if (!(await reserveEvaluation(db, { jobId, actorId: saved.actorId, now: now() }))) {
        throw new EvaluationProviderError({ code: 'EVALUATION_USAGE_LIMIT', retryable: false });
      }
      if (activeSignal.aborted) {
        throw new EvaluationProviderError({ code: 'AI_ABORTED', retryable: true });
      }
      return generate(input, activeSignal);
    });
  };
}
