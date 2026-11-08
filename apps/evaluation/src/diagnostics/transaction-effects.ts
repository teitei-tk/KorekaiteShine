import { and, eq, exists } from 'void/db';
import { jobs, diagnosticChecks } from '@korekaite/database';
import type { createPrimaryDb } from '@korekaite/database/connection';
import type { JobTransactionEffects } from '../server/repositories/transaction-effects';

/** 診断の確認結果も元の結果・受信記録と同一transactionで保存する。 */
export function diagnosticTransactionEffects(
  db: ReturnType<typeof createPrimaryDb>,
): JobTransactionEffects {
  return {
    completed: (guard, jobId) => [
      db
        .update(diagnosticChecks)
        .set({ consumerCompletion: 'passed' })
        .where(and(eq(diagnosticChecks.jobId, jobId), guard)),
    ],
    dlqReceived: (guard, jobId, now) => [
      db
        .update(jobs)
        .set({ updatedAt: now })
        .where(
          and(
            eq(jobs.jobId, jobId),
            guard,
            exists(
              db
                .select()
                .from(diagnosticChecks)
                .where(
                  and(
                    eq(diagnosticChecks.jobId, jobId),
                    eq(diagnosticChecks.dlqReceipt, 'pending'),
                  ),
                ),
            ),
          ),
        ),
      db
        .update(diagnosticChecks)
        .set({ dlqReceipt: 'passed' })
        .where(
          and(eq(diagnosticChecks.jobId, jobId), eq(diagnosticChecks.dlqReceipt, 'pending'), guard),
        ),
    ],
  };
}
