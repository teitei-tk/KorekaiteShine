import type { JobNotification } from '@korekaite/api-contracts/messages';
import type { createPrimaryDb } from '@korekaite/database/connection';
import { jobs, deletedJobs } from '@korekaite/database';
import { eq } from 'void/db';

type DeliveryClassification =
  | { kind: 'missing' }
  | { kind: 'deleted' }
  | { kind: 'job'; job: typeof jobs.$inferSelect };

/** 契約検証済みのIDだけを、primary接続で照合する。 */
export async function classifyDelivery(
  db: ReturnType<typeof createPrimaryDb>,
  notification: JobNotification,
): Promise<DeliveryClassification> {
  const [deleted] = await db
    .select()
    .from(deletedJobs)
    .where(eq(deletedJobs.jobId, notification.jobId));
  if (deleted) return { kind: 'deleted' };
  const [job] = await db.select().from(jobs).where(eq(jobs.jobId, notification.jobId));
  return job ? { kind: 'job', job } : { kind: 'missing' };
}
