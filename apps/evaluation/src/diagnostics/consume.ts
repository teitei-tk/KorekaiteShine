import { diagnosticTransactionEffects } from './transaction-effects';
import { Temporal } from '@js-temporal/polyfill';
import type { D1Database } from '@cloudflare/workers-types';
import type { JobNotification } from '@korekaite/api-contracts/messages';
import { diagnosticChecks } from '@korekaite/database';
import { createPrimaryDb } from '@korekaite/database/connection';
import { eq } from 'void/db';
import { consumeJob } from '../application/consume-job';
import type { DeliveryContext } from '../application/consume-job';
import { evaluateDiagnostic } from './evaluator';

export async function consumeDiagnostic(
  notification: JobNotification,
  context: DeliveryContext,
  binding: D1Database,
) {
  const db = createPrimaryDb(binding);
  return consumeJob(notification, context, {
    db,
    effects: diagnosticTransactionEffects(db),
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
      // oxlint-disable-next-line typescript/no-unnecessary-condition, typescript/strict-boolean-expressions -- DBの空結果・外部入力・非同期更新を実行時に検査する。 DBの空結果・外部入力・非同期更新を実行時に検査する。
      if (!check) {
        throw new Error('診断条件がありません。');
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- DBの空結果・外部入力・非同期更新を実行時に検査する。
      if (signal.aborted) {
        throw new Error('評価は中止されました。');
      }
      return evaluateDiagnostic(check.scenario, attemptNumber);
    },
  });
}
