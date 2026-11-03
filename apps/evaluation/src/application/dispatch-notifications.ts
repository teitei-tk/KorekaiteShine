import type { D1Database } from '@cloudflare/workers-types';
import type { JobNotification } from '@korekaite/api-contracts/messages';
import { validateJobNotification } from '@korekaite/api-contracts/messages/validators';
import { createPrimaryDb } from '@korekaite/database/connection';
import type { JobPurpose } from '../server/repositories/job-execution';
import { pendingNotifications, markNotificationSent } from '../server/repositories/outbox';

// Cloudflare Queuesと固定版MiniflareのdelaySeconds上限。
export const maximumQueueDelaySeconds = 86_400;
export interface NotificationDependencies {
  database: D1Database;
  now(): number;
  sendNotification(
    purpose: JobPurpose,
    operation: 'notify' | 'notify_dlq',
    notification: JobNotification,
    delaySeconds: number,
  ): Promise<void>;
}
export interface RecoverySummary {
  outboxSent: number;
  outboxDeferred: number;
}
export async function dispatchNotifications(
  deps: NotificationDependencies,
  options: {
    jobId?: string;
    includeFuture?: boolean;
    expectedPurpose?: JobPurpose;
    operation?: 'notify' | 'notify_dlq';
  } = {},
): Promise<RecoverySummary> {
  const db = createPrimaryDb(deps.database);
  const summary = { outboxSent: 0, outboxDeferred: 0 };
  const horizon = deps.now() + (options.includeFuture ? maximumQueueDelaySeconds * 1_000 : 0);
  for (const { notification: row, nextAttemptAt } of await pendingNotifications(
    db,
    horizon,
    options.jobId,
  )) {
    if (options.expectedPurpose !== undefined && row.purpose !== options.expectedPurpose) continue;
    if (row.operation !== 'notify' && row.operation !== 'notify_dlq') continue;
    if (options.operation !== undefined && row.operation !== options.operation) continue;
    try {
      const notification = { schemaVersion: 1, jobId: row.jobId };
      if (!validateJobNotification(notification)) throw new Error('通知契約が不正です。');
      const delaySeconds = Math.max(
        0,
        Math.ceil((Math.max(row.scheduledAt, nextAttemptAt ?? 0) - deps.now()) / 1_000),
      );
      if (delaySeconds > maximumQueueDelaySeconds) continue;
      await deps.sendNotification(row.purpose, row.operation, notification, delaySeconds);
      await markNotificationSent(db, row.id, deps.now());
      summary.outboxSent++;
    } catch {
      summary.outboxDeferred++;
      console.info(JSON.stringify({ event: 'notification_delivery_deferred', jobId: row.jobId }));
    }
  }
  return summary;
}
