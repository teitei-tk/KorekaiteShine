import { and, eq } from 'void/db';
import { deliveryAnomalies } from '@korekaite/database/jobs';
import type { createPrimaryDb } from '@korekaite/database/connection';
import type { DeliveryContext } from '../../application/consume-job';
import type { JobPurpose } from './job-execution';

export interface AnomalyDetails {
  code: string;
  schemaVersion: number | null;
  jobId: string | null;
  observedPurpose: JobPurpose | null;
}
export async function recordDeliveryAnomaly(
  db: ReturnType<typeof createPrimaryDb>,
  context: DeliveryContext,
  details: AnomalyDetails,
  now: number,
): Promise<void> {
  await db
    .insert(deliveryAnomalies)
    .values({
      queueName: context.queueName,
      messageId: context.messageId,
      expectedPurpose: context.expectedPurpose,
      ...details,
      firstDetectedAt: now,
      lastDetectedAt: now,
      status: 'unresolved',
      resolution: null,
    })
    .onConflictDoUpdate({
      target: [deliveryAnomalies.queueName, deliveryAnomalies.messageId],
      set: { lastDetectedAt: now },
    });
}

type DeliveryIdentity = Pick<DeliveryContext, 'queueName' | 'messageId'>;
function sameDelivery(context: DeliveryIdentity) {
  return and(
    eq(deliveryAnomalies.queueName, context.queueName),
    eq(deliveryAnomalies.messageId, context.messageId),
  );
}

export async function refreshRecordedAnomaly(
  db: ReturnType<typeof createPrimaryDb>,
  context: DeliveryIdentity,
  now: number,
): Promise<boolean> {
  const rows = await db
    .update(deliveryAnomalies)
    .set({ lastDetectedAt: now })
    .where(sameDelivery(context))
    .returning({ messageId: deliveryAnomalies.messageId });
  return rows.length > 0;
}

export async function isQuarantinedDelivery(
  db: ReturnType<typeof createPrimaryDb>,
  context: DeliveryIdentity,
): Promise<boolean> {
  const rows = await db
    .select({ messageId: deliveryAnomalies.messageId })
    .from(deliveryAnomalies)
    .where(sameDelivery(context));
  return rows.length > 0;
}
