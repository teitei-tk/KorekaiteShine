import type { JobNotification } from '@korekaite/api-contracts/messages';
import type { createPrimaryDb } from '@korekaite/database/connection';
import { jobs, deletedJobs } from '@korekaite/database/jobs';
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
  // oxlint-disable-next-line typescript/no-unnecessary-condition, typescript/strict-boolean-expressions -- DBの空結果・外部入力・非同期更新を実行時に検査する。 DBの空結果・外部入力・非同期更新を実行時に検査する。
  if (deleted) {
    return { kind: 'deleted' };
  }
  const [job] = await db.select().from(jobs).where(eq(jobs.jobId, notification.jobId));
  // oxlint-disable-next-line typescript/no-unnecessary-condition, typescript/strict-boolean-expressions -- DBの空結果・外部入力・非同期更新を実行時に検査する。 DBの空結果・外部入力・非同期更新を実行時に検査する。
  return job ? { kind: 'job', job } : { kind: 'missing' };
}
