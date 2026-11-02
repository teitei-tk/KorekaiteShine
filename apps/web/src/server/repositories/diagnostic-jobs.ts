import { databaseOperation } from './database-error';
import { and, eq } from 'void/db';
import { jobs, jobOutbox, diagnosticRequests, diagnosticChecks } from '@korekaite/database';
import type { createPrimaryDb } from '@korekaite/database/connection';
import type { operations } from '@korekaite/api-contracts/http';

type Start = operations['startCheckJob']['requestBody']['content']['application/json'];
type Accepted = operations['startCheckJob']['responses'][202]['content']['application/json'];
export interface AcceptanceContext {
  db: ReturnType<typeof createPrimaryDb>;
  environment: 'development' | 'test';
  actorId: string;
  now(): number;
  newId(): string;
}

export async function acceptDiagnosticJob(
  context: AcceptanceContext,
  key: string,
  input: Start,
): Promise<Accepted | 'conflict'> {
  const { db, environment, actorId } = context;
  const scope = and(
    eq(diagnosticRequests.environment, environment),
    eq(diagnosticRequests.actorId, actorId),
    eq(diagnosticRequests.operation, 'start_check'),
    eq(diagnosticRequests.idempotencyKey, key),
  );
  const jobId = context.newId();
  const acceptedAt = context.now();
  const requestRecordId = context.newId();
  const outboxId = context.newId();
  try {
    await databaseOperation(async () =>
      db.batch([
        db.insert(jobs).values({
          jobId,
          actorId,
          purpose: 'diagnostics',
          status: 'pending',
          acceptedAt,
          updatedAt: acceptedAt,
        }),
        db.insert(diagnosticChecks).values({
          jobId,
          scenario: input.scenario,
          doPersistence: 'pending',
          consumerCompletion: input.scenario === 'exhaust_retries' ? 'not_expected' : 'pending',
          dlqReceipt: input.scenario === 'exhaust_retries' ? 'pending' : 'not_expected',
        }),
        db.insert(diagnosticRequests).values({
          id: requestRecordId,
          environment,
          actorId,
          operation: 'start_check',
          idempotencyKey: key,
          scenario: input.scenario,
          jobId,
          acceptedAt,
        }),
        db.insert(jobOutbox).values({
          id: outboxId,
          jobId,
          purpose: 'diagnostics',
          operation: 'initialize_do',
          scheduledAt: acceptedAt,
        }),
      ]),
    );
  } catch (error) {
    // batchの失敗時は全体がrollbackされる。競合した確定済み受付だけを読み直す。
    const [existing] = await databaseOperation(async () =>
      db.select().from(diagnosticRequests).where(scope),
    );
    if (!existing) throw error;
    if (existing.scenario !== input.scenario) return 'conflict';
    return {
      jobId: existing.jobId,
      scenario: existing.scenario,
      acceptedAt: new Date(existing.acceptedAt).toISOString(),
    };
  }
  return { jobId, scenario: input.scenario, acceptedAt: new Date(acceptedAt).toISOString() };
}

type CheckStatus = operations['getCheckJob']['responses'][200]['content']['application/json'];

export async function findDiagnosticJob(
  context: AcceptanceContext,
  jobId: string,
): Promise<CheckStatus | null> {
  const [row] = await databaseOperation(async () =>
    context.db
      .select({ job: jobs, check: diagnosticChecks })
      .from(jobs)
      .innerJoin(diagnosticChecks, eq(jobs.jobId, diagnosticChecks.jobId))
      .where(
        and(
          eq(jobs.jobId, jobId),
          eq(jobs.actorId, context.actorId),
          eq(jobs.purpose, 'diagnostics'),
        ),
      ),
  );
  if (!row) return null;
  const { job, check } = row;
  return {
    jobId: job.jobId,
    scenario: check.scenario,
    status: job.status,
    attemptCount: job.attemptCount,
    acceptedAt: new Date(job.acceptedAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    finishedAt: job.finishedAt === null ? null : new Date(job.finishedAt).toISOString(),
    nextAttemptAt: job.nextAttemptAt === null ? null : new Date(job.nextAttemptAt).toISOString(),
    lastErrorCode: job.lastErrorCode,
    checks: {
      doPersistence: check.doPersistence,
      consumerCompletion: check.consumerCompletion,
      dlqReceipt: check.dlqReceipt,
    },
  };
}
