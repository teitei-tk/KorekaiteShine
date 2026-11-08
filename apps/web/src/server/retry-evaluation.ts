import { and, eq, sql } from 'void/db';
import {
  validateInterviewId,
  validateRetryEvaluationAccepted,
  validateRetryEvaluationRequest,
} from '@korekaite/api-contracts/http/application-validators';
import { interviews, evaluationInputs } from '@korekaite/database/interviews';
import { jobs, jobOutbox, deletedJobs } from '@korekaite/database/jobs';
import type { createPrimaryDb } from '@korekaite/database/connection';
import { applicationFailure } from './application-response';
import { readJsonBody } from './json-body';

export async function retryEvaluationRequest(
  request: Request,
  interviewId: string,
  deps: {
    db: ReturnType<typeof createPrimaryDb>;
    actor(request: Request): string | null;
    now(): number;
    newId(): string;
  },
) {
  const actor = deps.actor(request);
  if (!actor) {
    return applicationFailure('FORBIDDEN');
  }
  const parsed = await readJsonBody(request, 1024);
  if (
    !validateInterviewId(interviewId) ||
    !parsed.ok ||
    !validateRetryEvaluationRequest(parsed.value)
  ) {
    return applicationFailure('INVALID_REQUEST');
  }
  const parent = parsed.value.failedJobId;
  const { db } = deps;
  try {
    const [source] = await db
      .select({ status: jobs.status, interviewStatus: interviews.status })
      .from(evaluationInputs)
      .innerJoin(interviews, eq(interviews.interviewId, evaluationInputs.interviewId))
      .innerJoin(jobs, eq(jobs.jobId, evaluationInputs.jobId))
      .where(
        and(
          eq(interviews.actorId, actor),
          eq(jobs.actorId, actor),
          eq(jobs.purpose, 'evaluation'),
          eq(interviews.interviewId, interviewId),
          eq(jobs.jobId, parent),
        ),
      );
    if (!source) {
      return applicationFailure('NOT_FOUND');
    }
    if (source.status !== 'failed' || source.interviewStatus !== 'ended') {
      return applicationFailure('CONFLICT');
    }
    const id = deps.newId();
    const now = deps.now();
    await db.batch([
      db.insert(jobs).select(
        db
          .select({
            jobId: sql<string>`${id}`.as('job_id'),
            actorId: jobs.actorId,
            purpose: sql<'evaluation'>`'evaluation'`.as('purpose'),
            status: sql<'pending'>`'pending'`.as('status'),
            attemptCount: sql<number>`0`.as('attempt_count'),
            acceptedAt: sql<number>`${now}`.as('accepted_at'),
            updatedAt: sql<number>`${now}`.as('updated_at'),
            finishedAt: sql<null>`NULL`.as('finished_at'),
            nextAttemptAt: sql<null>`NULL`.as('next_attempt_at'),
            lastErrorCode: sql<null>`NULL`.as('last_error_code'),
            ownerToken: sql<null>`NULL`.as('owner_token'),
            generation: sql<number>`0`.as('generation'),
            leaseUntil: sql<null>`NULL`.as('lease_until'),
            attemptDeadline: sql<null>`NULL`.as('attempt_deadline'),
          })
          .from(jobs)
          .innerJoin(evaluationInputs, eq(jobs.jobId, evaluationInputs.jobId))
          .innerJoin(interviews, eq(interviews.interviewId, evaluationInputs.interviewId))
          .where(
            and(
              eq(jobs.jobId, parent),
              eq(jobs.status, 'failed'),
              eq(jobs.purpose, 'evaluation'),
              eq(jobs.actorId, actor),
              eq(interviews.actorId, actor),
              eq(interviews.interviewId, interviewId),
              eq(interviews.status, 'ended'),
              sql`NOT EXISTS (SELECT 1 FROM ${deletedJobs} WHERE job_id=${parent})`,
              sql`NOT EXISTS (SELECT 1 FROM ${evaluationInputs} WHERE retry_of=${parent})`,
              sql`${jobs.jobId} = (SELECT job_id FROM ${evaluationInputs} WHERE interview_id=${interviewId} ORDER BY created_at DESC,job_id DESC LIMIT 1)`,
            ),
          ),
      ),
      db.insert(evaluationInputs).select(
        db
          .select({
            jobId: sql<string>`${id}`.as('job_id'),
            interviewId: evaluationInputs.interviewId,
            kind: sql<'manual'>`'manual'`.as('kind'),
            lastSequence: evaluationInputs.lastSequence,
            inputJson: evaluationInputs.inputJson,
            model: evaluationInputs.model,
            promptVersion: evaluationInputs.promptVersion,
            rubricVersion: evaluationInputs.rubricVersion,
            createdAt: sql<number>`MAX(${now},${evaluationInputs.createdAt}+1)`.as('created_at'),
            retryOf: evaluationInputs.jobId,
          })
          .from(evaluationInputs)
          .where(and(eq(evaluationInputs.jobId, parent), sql`changes()=1`)),
      ),
      db.insert(jobOutbox).select(
        db
          .select({
            id: sql<string>`${id + ':notify:0'}`.as('id'),
            jobId: evaluationInputs.jobId,
            purpose: sql<'evaluation'>`'evaluation'`.as('purpose'),
            operation: sql<'notify'>`'notify'`.as('operation'),
            generation: sql<number>`0`.as('generation'),
            scheduledAt: sql<number>`${now}`.as('scheduled_at'),
            sentAt: sql<null>`NULL`.as('sent_at'),
          })
          .from(evaluationInputs)
          .where(and(eq(evaluationInputs.jobId, id), sql`changes()=1`)),
      ),
    ]);
    const [accepted] = await db
      .select({ jobId: evaluationInputs.jobId })
      .from(evaluationInputs)
      .innerJoin(interviews, eq(interviews.interviewId, evaluationInputs.interviewId))
      .where(
        and(
          eq(interviews.actorId, actor),
          eq(interviews.interviewId, interviewId),
          eq(evaluationInputs.retryOf, parent),
        ),
      );
    if (!accepted) {
      return applicationFailure('CONFLICT');
    }
    if (!validateRetryEvaluationAccepted(accepted)) {
      return applicationFailure('UNAVAILABLE');
    }
    return Response.json(accepted, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return applicationFailure('UNAVAILABLE');
  }
}
