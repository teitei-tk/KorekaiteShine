import { Temporal } from '@js-temporal/polyfill';
import { databaseOperation } from './database-error';
import { and, eq } from 'void/db';
import { jobs, jobOutbox, diagnosticRequests, diagnosticChecks } from '@korekaite/database';
import type { createPrimaryDb } from '@korekaite/database/connection';
import type {
  GetCheckJobResponses,
  StartCheckJobData,
  StartCheckJobResponses,
} from '@korekaite/api-contracts/http';

type Start = StartCheckJobData['body'];
type Accepted = StartCheckJobResponses[202];
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
    if (!existing) {
      throw error;
    }
    if (existing.scenario !== input.scenario) {
      return 'conflict';
    }
    return {
      jobId: existing.jobId,
      scenario: existing.scenario,
      acceptedAt: Temporal.Instant.fromEpochMilliseconds(existing.acceptedAt).toString({
        fractionalSecondDigits: 3,
      }),
    };
  }
  return {
    jobId,
    scenario: input.scenario,
    acceptedAt: Temporal.Instant.fromEpochMilliseconds(acceptedAt).toString({
      fractionalSecondDigits: 3,
    }),
  };
}

type CheckStatus = GetCheckJobResponses[200];

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
  if (!row) {
    return null;
  }
  const { job, check } = row;
  return {
    jobId: job.jobId,
    scenario: check.scenario,
    status: job.status,
    attemptCount: job.attemptCount,
    acceptedAt: Temporal.Instant.fromEpochMilliseconds(job.acceptedAt).toString({
      fractionalSecondDigits: 3,
    }),
    updatedAt: Temporal.Instant.fromEpochMilliseconds(job.updatedAt).toString({
      fractionalSecondDigits: 3,
    }),
    finishedAt:
      job.finishedAt === null
        ? null
        : Temporal.Instant.fromEpochMilliseconds(job.finishedAt).toString({
            fractionalSecondDigits: 3,
          }),
    nextAttemptAt:
      job.nextAttemptAt === null
        ? null
        : Temporal.Instant.fromEpochMilliseconds(job.nextAttemptAt).toString({
            fractionalSecondDigits: 3,
          }),
    lastErrorCode: job.lastErrorCode,
    checks: {
      doPersistence: check.doPersistence,
      consumerCompletion: check.consumerCompletion,
      dlqReceipt: check.dlqReceipt,
    },
  };
}
