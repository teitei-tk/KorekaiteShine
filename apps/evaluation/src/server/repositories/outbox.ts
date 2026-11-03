import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  notExists,
  or,
  sql,
} from 'void/db';
import { jobs, jobOutbox, deletedJobs, dlqReceipts } from '@korekaite/database';
import type { createPrimaryDb } from '@korekaite/database/connection';
import { runnableJobStates } from '../../domain/job-state';

import type { JobPurpose } from './job-execution';

type Database = ReturnType<typeof createPrimaryDb>;
export async function pendingNotifications(db: Database, now: number, jobId?: string) {
  return db
    .select({ notification: jobOutbox, nextAttemptAt: jobs.nextAttemptAt })
    .from(jobOutbox)
    .innerJoin(jobs, and(eq(jobs.jobId, jobOutbox.jobId), eq(jobs.purpose, jobOutbox.purpose)))
    .where(
      and(
        isNull(jobOutbox.sentAt),
        jobId === undefined ? undefined : eq(jobOutbox.jobId, jobId),
        lte(jobOutbox.scheduledAt, now),
        eq(jobOutbox.generation, jobs.generation),
        notExists(db.select().from(deletedJobs).where(eq(deletedJobs.jobId, jobs.jobId))),
        or(
          and(
            eq(jobOutbox.operation, 'notify'),
            inArray(jobs.status, runnableJobStates),
            or(isNull(jobs.nextAttemptAt), lte(jobs.nextAttemptAt, now)),
          ),
          and(eq(jobOutbox.operation, 'notify_dlq'), eq(jobs.status, 'failed')),
        ),
      ),
    )
    .orderBy(asc(jobOutbox.scheduledAt));
}

export async function markNotificationSent(db: Database, id: string, now: number): Promise<void> {
  await db
    .update(jobOutbox)
    .set({ sentAt: now })
    .where(and(eq(jobOutbox.id, id), isNull(jobOutbox.sentAt)));
}

/** DLQで回復経路を失った未完了ジョブをscheduled配送へ引き継ぐ。 */
export async function ensureRecoveryNotification(
  db: Database,
  jobId: string,
  purpose: JobPurpose,
  outboxId: string,
  now: number,
): Promise<void> {
  await db
    .insert(jobOutbox)
    .select(
      db
        .select({
          id: sql<string>`${outboxId}`.as('id'),
          jobId: jobs.jobId,
          purpose: jobs.purpose,
          operation: sql<'notify'>`'notify'`.as('operation'),
          generation: jobs.generation,
          scheduledAt: sql<number>`max(${now}, coalesce(${jobs.nextAttemptAt}, ${now}))`.as(
            'scheduled_at',
          ),
          sentAt: sql<null>`null`.as('sent_at'),
        })
        .from(jobs)
        .where(
          and(
            eq(jobs.jobId, jobId),
            eq(jobs.purpose, purpose),
            inArray(jobs.status, runnableJobStates),
            lt(jobs.attemptCount, 4),
            notExists(db.select().from(deletedJobs).where(eq(deletedJobs.jobId, jobs.jobId))),
          ),
        ),
    )
    .onConflictDoUpdate({
      target: [jobOutbox.jobId, jobOutbox.operation, jobOutbox.generation],
      set: { sentAt: null, scheduledAt: sql`excluded.scheduled_at` },
      setWhere: and(
        eq(jobOutbox.purpose, purpose),
        isNotNull(jobOutbox.sentAt),
        lte(jobOutbox.scheduledAt, now),
      ),
    });
}

const notificationRecoveryGraceMs = 30_000;

/** 配送直後の猶予を置き、未実行またはDLQ未受信の現世代通知を再送待ちへ戻す。 */
export async function recoverOverdueNotifications(db: Database, now: number): Promise<void> {
  const threshold = now - notificationRecoveryGraceMs;
  await db
    .update(jobOutbox)
    .set({ sentAt: null })
    .where(
      and(
        isNotNull(jobOutbox.sentAt),
        lte(jobOutbox.sentAt, threshold),
        lte(jobOutbox.scheduledAt, threshold),
        exists(
          db
            .select()
            .from(jobs)
            .where(
              and(
                eq(jobs.jobId, jobOutbox.jobId),
                eq(jobs.purpose, jobOutbox.purpose),
                eq(jobs.generation, jobOutbox.generation),
                notExists(db.select().from(deletedJobs).where(eq(deletedJobs.jobId, jobs.jobId))),
                or(
                  and(
                    eq(jobOutbox.operation, 'notify'),
                    inArray(jobs.status, runnableJobStates),
                    lt(jobs.attemptCount, 4),
                    or(isNull(jobs.nextAttemptAt), lte(jobs.nextAttemptAt, threshold)),
                  ),
                  and(
                    eq(jobOutbox.operation, 'notify_dlq'),
                    eq(jobs.status, 'failed'),
                    notExists(
                      db
                        .select()
                        .from(dlqReceipts)
                        .where(
                          and(
                            eq(dlqReceipts.jobId, jobs.jobId),
                            eq(dlqReceipts.purpose, jobs.purpose),
                            eq(dlqReceipts.observedStatus, 'failed'),
                          ),
                        ),
                    ),
                  ),
                ),
              ),
            ),
        ),
      ),
    );
}
