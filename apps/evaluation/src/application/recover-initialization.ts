import { and, asc, eq, isNull, lte, notExists, or } from 'void/db';
import { jobs, jobOutbox, deletedJobs } from '@korekaite/database';
import { createPrimaryDb } from '@korekaite/database/connection';
import type { D1Database } from '@cloudflare/workers-types';

export async function recoverInitializations(
  binding: D1Database,
  initialize: (jobId: string) => Promise<void>,
  now: () => number = Date.now,
): Promise<void> {
  const db = createPrimaryDb(binding);
  const pending = await db
    .selectDistinct({ jobId: jobs.jobId })
    .from(jobs)
    .innerJoin(jobOutbox, eq(jobOutbox.jobId, jobs.jobId))
    .where(
      and(
        eq(jobs.purpose, 'diagnostics'),
        eq(jobs.actorId, 'local-developer'),
        eq(jobs.status, 'pending'),
        eq(jobOutbox.purpose, 'diagnostics'),
        isNull(jobOutbox.sentAt),
        lte(jobOutbox.scheduledAt, now()),
        or(
          eq(jobOutbox.operation, 'initialize_do'),
          and(eq(jobOutbox.operation, 'notify'), eq(jobOutbox.generation, 0)),
        ),
        notExists(db.select().from(deletedJobs).where(eq(deletedJobs.jobId, jobs.jobId))),
      ),
    )
    .orderBy(asc(jobOutbox.scheduledAt));
  for (const { jobId } of pending) {
    try {
      await initialize(jobId);
    } catch {
      // 未送信記録を残し、次のscheduledイベントで再試行する。
      console.info(JSON.stringify({ event: 'diagnostic_initialization_deferred', jobId }));
    }
  }
}
