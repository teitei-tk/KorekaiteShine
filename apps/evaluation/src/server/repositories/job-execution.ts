import { runnableJobStates, terminalJobStates } from '../../domain/job-state';
import type { EvaluationFailure } from '../../domain/evaluation-result';
import { maxEvaluationAttempts, retryDelayMs } from '../../domain/retry-policy';
import { and, eq, exists, gt, inArray, isNull, lt, lte, ne, notExists, or, sql } from 'void/db';
import {
  jobs,
  jobOutbox,
  executionSlots,
  jobAttempts,
  diagnosticChecks,
  deletedJobs,
} from '@korekaite/database';
import type { createPrimaryDb } from '@korekaite/database/connection';
import { executionTiming } from '../../domain/lease';

type Database = ReturnType<typeof createPrimaryDb>;
export type JobPurpose = typeof jobs.$inferSelect.purpose;
export interface ExecutionLease {
  jobId: string;
  ownerToken: string;
  generation: number;
  attemptNumber: number;
  deadline: number;
}

export async function acquireExecution(
  db: Database,
  jobId: string,
  purpose: JobPurpose,
  ownerToken: string,
  now: number,
): Promise<ExecutionLease | null> {
  const available = and(
    eq(jobs.jobId, jobId),
    eq(jobs.purpose, purpose),
    inArray(jobs.status, runnableJobStates),
    lt(jobs.attemptCount, maxEvaluationAttempts),
    or(isNull(jobs.nextAttemptAt), lte(jobs.nextAttemptAt, now)),
    notExists(db.select().from(deletedJobs).where(eq(deletedJobs.jobId, jobs.jobId))),
  );
  const slot = db
    .select()
    .from(executionSlots)
    .where(
      and(
        eq(executionSlots.actorId, jobs.actorId),
        eq(executionSlots.jobId, jobs.jobId),
        eq(executionSlots.ownerToken, ownerToken),
        eq(executionSlots.generation, sql`${jobs.generation} + 1`),
      ),
    );
  const deadline = now + executionTiming.attemptLimitMs;
  const [, , attempts] = await db.batch([
    db
      .insert(executionSlots)
      .select(
        db
          .select({
            actorId: jobs.actorId,
            jobId: jobs.jobId,
            ownerToken: sql<string>`${ownerToken}`.as('owner_token'),
            generation: sql<number>`${jobs.generation} + 1`.as('generation'),
            leaseUntil: sql<number>`${deadline}`.as('lease_until'),
          })
          .from(jobs)
          .where(available),
      )
      .onConflictDoNothing(),
    db
      .update(jobs)
      .set({
        status: 'running',
        ownerToken,
        generation: sql`${jobs.generation} + 1`,
        attemptCount: sql`${jobs.attemptCount} + 1`,
        leaseUntil: deadline,
        attemptDeadline: deadline,
        updatedAt: now,
        nextAttemptAt: null,
      })
      .where(and(available, exists(slot))),
    db
      .insert(jobAttempts)
      .select(
        db
          .select({
            jobId: jobs.jobId,
            attemptNumber: jobs.attemptCount,
            startedAt: sql<number>`${now}`.as('started_at'),
            finishedAt: sql<null>`null`.as('finished_at'),
            errorCode: sql<null>`null`.as('error_code'),
            resultJson: sql<null>`null`.as('result_json'),
          })
          .from(jobs)
          .where(
            and(eq(jobs.jobId, jobId), eq(jobs.status, 'running'), eq(jobs.ownerToken, ownerToken)),
          ),
      )
      .returning({ attemptNumber: jobAttempts.attemptNumber }),
  ]);
  if (!attempts[0]) {
    return null;
  }
  const [job] = await db
    .select({ generation: jobs.generation })
    .from(jobs)
    .where(and(eq(jobs.jobId, jobId), eq(jobs.ownerToken, ownerToken)));
  if (!job) {
    return null;
  }
  return {
    jobId,
    ownerToken,
    generation: job.generation,
    attemptNumber: attempts[0].attemptNumber,
    deadline,
  };
}

function ownedExecution(db: Database, lease: ExecutionLease, now: number) {
  return and(
    eq(jobs.jobId, lease.jobId),
    eq(jobs.ownerToken, lease.ownerToken),
    eq(jobs.generation, lease.generation),
    eq(jobs.status, 'running'),
    gt(jobs.leaseUntil, now),
    gt(jobs.attemptDeadline, now),
    notExists(db.select().from(deletedJobs).where(eq(deletedJobs.jobId, jobs.jobId))),
    exists(
      db
        .select()
        .from(executionSlots)
        .where(
          and(
            eq(executionSlots.actorId, jobs.actorId),
            eq(executionSlots.jobId, jobs.jobId),
            eq(executionSlots.ownerToken, lease.ownerToken),
            eq(executionSlots.generation, lease.generation),
            gt(executionSlots.leaseUntil, now),
          ),
        ),
    ),
  );
}

export async function completeExecution(
  db: Database,
  lease: ExecutionLease,
  result: { summary: string },
  now: number,
): Promise<boolean> {
  const owned = ownedExecution(db, lease, now);
  const ownedJob = db.select().from(jobs).where(owned);
  const [, , completed] = await db.batch([
    db
      .update(jobAttempts)
      .set({ finishedAt: now, resultJson: JSON.stringify(result) })
      .where(
        and(
          eq(jobAttempts.jobId, lease.jobId),
          eq(jobAttempts.attemptNumber, lease.attemptNumber),
          isNull(jobAttempts.finishedAt),
          exists(ownedJob),
        ),
      ),
    db
      .update(diagnosticChecks)
      .set({ consumerCompletion: 'passed' })
      .where(and(eq(diagnosticChecks.jobId, lease.jobId), exists(ownedJob))),
    db
      .update(jobs)
      .set({
        status: 'completed',
        finishedAt: now,
        updatedAt: now,
        ownerToken: null,
        leaseUntil: null,
        attemptDeadline: null,
        nextAttemptAt: null,
      })
      .where(owned)
      .returning({ jobId: jobs.jobId }),
    db.delete(executionSlots).where(
      and(
        eq(executionSlots.jobId, lease.jobId),
        eq(executionSlots.ownerToken, lease.ownerToken),
        eq(executionSlots.generation, lease.generation),
        exists(
          db
            .select()
            .from(jobs)
            .where(
              and(
                eq(jobs.jobId, lease.jobId),
                eq(jobs.generation, lease.generation),
                eq(jobs.status, 'completed'),
              ),
            ),
        ),
      ),
    ),
  ]);
  return completed.length === 1;
}

export async function isTerminalJob(
  db: Database,
  jobId: string,
  purpose: JobPurpose,
): Promise<boolean> {
  const [job] = await db
    .select({ jobId: jobs.jobId })
    .from(jobs)
    .where(
      and(
        eq(jobs.jobId, jobId),
        eq(jobs.purpose, purpose),
        inArray(jobs.status, terminalJobStates),
      ),
    );
  return Boolean(job);
}

export async function hasActiveExecution(
  db: Database,
  jobId: string,
  purpose: JobPurpose,
  now: number,
): Promise<boolean> {
  const [job] = await db
    .select({ jobId: jobs.jobId })
    .from(jobs)
    .innerJoin(
      executionSlots,
      and(
        eq(executionSlots.actorId, jobs.actorId),
        eq(executionSlots.jobId, jobs.jobId),
        eq(executionSlots.ownerToken, jobs.ownerToken),
        eq(executionSlots.generation, jobs.generation),
      ),
    )
    .where(
      and(
        eq(jobs.jobId, jobId),
        eq(jobs.purpose, purpose),
        eq(jobs.status, 'running'),
        gt(jobs.leaseUntil, now),
        gt(jobs.attemptDeadline, now),
        gt(executionSlots.leaseUntil, now),
        notExists(db.select().from(deletedJobs).where(eq(deletedJobs.jobId, jobs.jobId))),
      ),
    );
  return Boolean(job);
}

export async function deferForBusySlot(
  db: Database,
  jobId: string,
  purpose: JobPurpose,
  outboxId: string,
  now: number,
): Promise<boolean> {
  const pending = and(
    eq(jobs.jobId, jobId),
    eq(jobs.purpose, purpose),
    inArray(jobs.status, runnableJobStates),
    notExists(db.select().from(deletedJobs).where(eq(deletedJobs.jobId, jobs.jobId))),
  );
  const busy = exists(
    db
      .select()
      .from(executionSlots)
      .where(
        and(
          eq(executionSlots.actorId, jobs.actorId),
          ne(executionSlots.jobId, jobs.jobId),
          gt(executionSlots.leaseUntil, now),
        ),
      ),
  );
  const nextAttemptAt = now + executionTiming.slotWaitMs;
  await db.batch([
    db
      .update(jobs)
      .set({ nextAttemptAt, updatedAt: now, generation: sql`${jobs.generation} + 1` })
      .where(and(pending, busy, or(isNull(jobs.nextAttemptAt), lte(jobs.nextAttemptAt, now)))),
    db
      .insert(jobOutbox)
      .select(
        db
          .select({
            id: sql<string>`${outboxId}`.as('id'),
            jobId: jobs.jobId,
            purpose: jobs.purpose,
            operation: sql<'notify'>`'notify'`.as('operation'),
            generation: jobs.generation,
            scheduledAt: sql<number>`${jobs.nextAttemptAt}`.as('scheduled_at'),
            sentAt: sql<null>`null`.as('sent_at'),
          })
          .from(jobs)
          .where(and(pending, busy, eq(jobs.nextAttemptAt, nextAttemptAt))),
      )
      .onConflictDoNothing(),
  ]);
  const [scheduled] = await db
    .select({ jobId: jobs.jobId })
    .from(jobs)
    .innerJoin(
      jobOutbox,
      and(
        eq(jobOutbox.jobId, jobs.jobId),
        eq(jobOutbox.purpose, jobs.purpose),
        eq(jobOutbox.operation, 'notify'),
        eq(jobOutbox.generation, jobs.generation),
        eq(jobOutbox.scheduledAt, jobs.nextAttemptAt),
      ),
    )
    .where(and(pending, gt(jobs.nextAttemptAt, now)));
  return Boolean(scheduled);
}

export async function renewExecution(
  db: Database,
  lease: ExecutionLease,
  now: number,
): Promise<boolean> {
  const owned = ownedExecution(db, lease, now);
  const ownedJob = db.select().from(jobs).where(owned);
  const nextLeaseUntil = sql<number>`min(${jobs.attemptDeadline}, ${now + executionTiming.leaseDurationMs})`;
  const [renewedJobs, renewedSlots] = await db.batch([
    db
      .update(jobs)
      .set({ leaseUntil: nextLeaseUntil, updatedAt: now })
      .where(owned)
      .returning({ jobId: jobs.jobId }),
    db
      .update(executionSlots)
      .set({
        leaseUntil: sql<number>`(${db.select({ leaseUntil: jobs.leaseUntil }).from(jobs).where(eq(jobs.jobId, lease.jobId))})`,
      })
      .where(
        and(
          eq(executionSlots.jobId, lease.jobId),
          eq(executionSlots.ownerToken, lease.ownerToken),
          eq(executionSlots.generation, lease.generation),
          exists(ownedJob),
        ),
      )
      .returning({ jobId: executionSlots.jobId }),
  ]);
  return renewedJobs.length === 1 && renewedSlots.length === 1;
}

export async function failExecution(
  db: Database,
  lease: ExecutionLease,
  failure: EvaluationFailure,
  outboxId: string,
  now: number,
): Promise<boolean> {
  return persistExecutionFailure(db, lease, failure, outboxId, now, ownedExecution(db, lease, now));
}

async function persistExecutionFailure(
  db: Database,
  lease: ExecutionLease,
  failure: EvaluationFailure,
  outboxId: string,
  now: number,
  owned: ReturnType<typeof ownedExecution>,
): Promise<boolean> {
  const delay = retryDelayMs(lease.attemptNumber, failure);
  const nextAttemptAt = delay === null ? null : now + delay;
  const status = nextAttemptAt === null ? 'failed' : 'retry_wait';
  const operation = nextAttemptAt === null ? 'notify_dlq' : 'notify';
  const ownedJob = db.select().from(jobs).where(owned);
  const [, , changed] = await db.batch([
    db
      .update(jobAttempts)
      .set({ finishedAt: now, errorCode: failure.code })
      .where(
        and(
          eq(jobAttempts.jobId, lease.jobId),
          eq(jobAttempts.attemptNumber, lease.attemptNumber),
          isNull(jobAttempts.finishedAt),
          exists(ownedJob),
        ),
      ),
    db
      .insert(jobOutbox)
      .select(
        db
          .select({
            id: sql<string>`${outboxId}`.as('id'),
            jobId: jobs.jobId,
            purpose: jobs.purpose,
            operation: sql<'notify' | 'notify_dlq'>`${operation}`.as('operation'),
            generation: jobs.generation,
            scheduledAt: sql<number>`${nextAttemptAt ?? now}`.as('scheduled_at'),
            sentAt: sql<null>`null`.as('sent_at'),
          })
          .from(jobs)
          .where(owned),
      )
      .onConflictDoNothing(),
    db
      .update(jobs)
      .set({
        status,
        nextAttemptAt,
        finishedAt: status === 'failed' ? now : null,
        lastErrorCode: failure.code,
        updatedAt: now,
        ownerToken: null,
        leaseUntil: null,
        attemptDeadline: null,
      })
      .where(owned)
      .returning({ jobId: jobs.jobId }),
    db.delete(executionSlots).where(
      and(
        eq(executionSlots.jobId, lease.jobId),
        eq(executionSlots.ownerToken, lease.ownerToken),
        eq(executionSlots.generation, lease.generation),
        exists(
          db
            .select()
            .from(jobs)
            .where(
              and(
                eq(jobs.jobId, lease.jobId),
                eq(jobs.generation, lease.generation),
                eq(jobs.status, status),
                isNull(jobs.ownerToken),
              ),
            ),
        ),
      ),
    ),
  ]);
  return changed.length === 1;
}

export async function recoverExpiredExecution(
  db: Database,
  jobId: string,
  purpose: JobPurpose,
  outboxId: string,
  now: number,
): Promise<boolean> {
  const expired = and(
    eq(jobs.jobId, jobId),
    eq(jobs.purpose, purpose),
    eq(jobs.status, 'running'),
    lte(jobs.leaseUntil, now - executionTiming.takeoverGraceMs),
    notExists(db.select().from(deletedJobs).where(eq(deletedJobs.jobId, jobs.jobId))),
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
            lte(executionSlots.leaseUntil, now - executionTiming.takeoverGraceMs),
          ),
        ),
    ),
  );
  const [job] = await db.select().from(jobs).where(expired);
  if (!job || job.ownerToken === null || job.leaseUntil === null || job.attemptDeadline === null) {
    return false;
  }
  const lease: ExecutionLease = {
    jobId,
    ownerToken: job.ownerToken,
    generation: job.generation,
    attemptNumber: job.attemptCount,
    deadline: job.attemptDeadline,
  };
  return persistExecutionFailure(
    db,
    lease,
    { code: 'EXECUTION_LEASE_EXPIRED', retryable: true },
    outboxId,
    now,
    and(
      expired,
      eq(jobs.ownerToken, lease.ownerToken),
      eq(jobs.generation, lease.generation),
      eq(jobs.leaseUntil, job.leaseUntil),
    ),
  );
}
