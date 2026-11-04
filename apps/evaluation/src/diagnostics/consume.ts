import { Temporal } from '@js-temporal/polyfill';
import type { D1Database } from '@cloudflare/workers-types';
import type { JobNotification } from '@korekaite/api-contracts/messages';
import { diagnosticChecks } from '@korekaite/database';
import { createPrimaryDb } from '@korekaite/database/connection';
import { eq } from 'void/db';
import { consumeJob, type DeliveryContext } from '../application/consume-job';
import { evaluateDiagnostic } from './evaluator';

export async function consumeDiagnostic(
  notification: JobNotification,
  context: DeliveryContext,
  binding: D1Database,
) {
  const db = createPrimaryDb(binding);
  return consumeJob(notification, context, {
    db,
    now: () => Temporal.Now.instant().epochMilliseconds,
    newId: () => crypto.randomUUID(),
    evaluate: async (jobId, attemptNumber, signal) => {
      if (signal.aborted) {
        throw new Error('評価は中止されました。');
      }
      const [check] = await db
        .select()
        .from(diagnosticChecks)
        .where(eq(diagnosticChecks.jobId, jobId));
      if (!check) {
        throw new Error('診断条件がありません。');
      }
      if (signal.aborted) {
        throw new Error('評価は中止されました。');
      }
      return evaluateDiagnostic(check.scenario, attemptNumber);
    },
  });
}
