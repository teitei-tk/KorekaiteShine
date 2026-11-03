import { Temporal } from '@js-temporal/polyfill';
import type { D1Database } from '@cloudflare/workers-types';
import { and, asc, eq, lte, notExists } from 'void/db';
import { jobs, deletedJobs } from '@korekaite/database';
import { createPrimaryDb } from '@korekaite/database/connection';
import { executionTiming } from '../domain/lease';
import { recoverExpiredExecution } from '../server/repositories/job-execution';

export async function recoverExecutions(
  binding: D1Database,
  now: () => number = () => Temporal.Now.instant().epochMilliseconds,
): Promise<void> {
  const db = createPrimaryDb(binding);
  const expired = await db
    .select({ jobId: jobs.jobId, purpose: jobs.purpose })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, 'running'),
        lte(jobs.leaseUntil, now() - executionTiming.takeoverGraceMs),
        notExists(db.select().from(deletedJobs).where(eq(deletedJobs.jobId, jobs.jobId))),
      ),
    )
    .orderBy(asc(jobs.leaseUntil));
  for (const { jobId, purpose } of expired) {
    try {
      await recoverExpiredExecution(db, jobId, purpose, crypto.randomUUID(), now());
    } catch {
      // 状態と実行権は残し、次の定期実行で再確認する。
      console.info(JSON.stringify({ event: 'execution_recovery_deferred', jobId }));
    }
  }
}
