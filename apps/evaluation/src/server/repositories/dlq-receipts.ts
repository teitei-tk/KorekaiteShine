import type { JobTransactionEffects } from './transaction-effects';
import { and, eq, exists, gt, inArray, isNull, notExists, or, sql } from 'void/db';
import {
  jobs,
  deletedJobs,
  dlqReceipts,
  executionSlots,
  jobOutbox,
} from '@korekaite/database/jobs';
import type { createPrimaryDb } from '@korekaite/database/connection';
import type { DeliveryContext } from '../../application/consume-job';
import { terminalJobStates, runnableJobStates } from '../../domain/job-state';

type Database = ReturnType<typeof createPrimaryDb>;

export async function recordDlqReceipt(
  db: Database,
  jobId: string,
  context: DeliveryContext,
  now: number,
  effects?: JobTransactionEffects,
): Promise<boolean> {
  const matchingJob = and(
    eq(jobs.jobId, jobId),
    eq(jobs.purpose, context.expectedPurpose),
    or(
      inArray(jobs.status, terminalJobStates),
      and(
        eq(jobs.status, 'running'),
        gt(jobs.leaseUntil, now),
        gt(jobs.attemptDeadline, now),
        exists(
          db
            .select()
            .from(executionSlots)
            .where(
              and(
                eq(executionSlots.actorId, jobs.actorId),
                eq(executionSlots.jobId, jobs.jobId),
                eq(executionSlots.ownerToken, jobs.ownerToken),
                eq(executionSlots.generation, jobs.generation),
                gt(executionSlots.leaseUntil, now),
              ),
            ),
        ),
      ),
      and(
        inArray(jobs.status, runnableJobStates),
        exists(
          db
            .select()
            .from(jobOutbox)
            .where(
              and(
                eq(jobOutbox.jobId, jobs.jobId),
                eq(jobOutbox.purpose, jobs.purpose),
                eq(jobOutbox.generation, jobs.generation),
                eq(jobOutbox.operation, 'notify'),
                or(isNull(jobOutbox.sentAt), gt(jobOutbox.scheduledAt, now)),
              ),
            ),
        ),
      ),
    ),
    notExists(db.select().from(deletedJobs).where(eq(deletedJobs.jobId, jobs.jobId))),
  );
  const receipt = db
    .select()
    .from(dlqReceipts)
    .where(
      and(
        eq(dlqReceipts.queueName, context.queueName),
        eq(dlqReceipts.messageId, context.messageId),
        eq(dlqReceipts.jobId, jobId),
        eq(dlqReceipts.purpose, context.expectedPurpose),
      ),
    );
  const [recorded] = await db.batch([
    db
      .insert(dlqReceipts)
      .select(
        db
          .select({
            queueName: sql<string>`${context.queueName}`.as('queue_name'),
            messageId: sql<string>`${context.messageId}`.as('message_id'),
            jobId: jobs.jobId,
            purpose: jobs.purpose,
            observedStatus: jobs.status,
            firstReceivedAt: sql<number>`${now}`.as('first_received_at'),
            lastReceivedAt: sql<number>`${now}`.as('last_received_at'),
          })
          .from(jobs)
          .where(matchingJob),
      )
      .onConflictDoUpdate({
        target: [dlqReceipts.queueName, dlqReceipts.messageId],
        set: { lastReceivedAt: now },
      })
      .returning({ jobId: dlqReceipts.jobId }),
    ...(effects?.dlqReceived?.(
      exists(
        db
          .select()
          .from(jobs)
          .where(and(matchingJob, exists(receipt))),
      ),
      jobId,
      now,
    ) ?? []),
  ]);
  return recorded.length === 1;
}
