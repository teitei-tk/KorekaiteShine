import { ensureRecoveryNotification } from '../server/repositories/outbox';
import type { JobNotification } from '@korekaite/api-contracts/messages';
import type { DeliveryContext, DeliveryDecision, EvaluationDependencies } from './consume-job';
import { recordDlqReceipt } from '../server/repositories/dlq-receipts';

/** 契約・存在・用途を共通入口で確認した後だけ呼ぶ。DLQではAIを実行しない。 */
export async function consumeDlq(
  notification: JobNotification,
  context: DeliveryContext,
  deps: EvaluationDependencies,
): Promise<DeliveryDecision> {
  const now = deps.now();
  if (await recordDlqReceipt(deps.db, notification.jobId, context, now, deps.effects)) {
    return { action: 'ack' };
  }
  await ensureRecoveryNotification(
    deps.db,
    notification.jobId,
    context.expectedPurpose,
    deps.newId(),
    now,
  );
  return (await recordDlqReceipt(deps.db, notification.jobId, context, now, deps.effects))
    ? { action: 'ack' }
    : { action: 'retry', delaySeconds: 30 };
}
