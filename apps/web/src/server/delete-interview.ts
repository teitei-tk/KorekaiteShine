import { closeAudioPeriod } from '@korekaite/database/audio-periods';
import { and, eq, exists, inArray, ne, notExists, sql } from 'void/db';
import { validateInterviewId } from '@korekaite/api-contracts/http/application-validators';
import {
  interviews,
  deletedInterviews,
  evaluationInputs,
  transcriptFragments,
  playbackReceipts,
} from '@korekaite/database/interviews';
import {
  jobs,
  deletedJobs,
  jobOutbox,
  jobAttempts,
  executionSlots,
  dlqReceipts,
  deliveryAnomalies,
} from '@korekaite/database/jobs';
import { materialAnalyses } from '@korekaite/database/materials';
import type { createPrimaryDb } from '@korekaite/database/connection';
import { applicationFailure } from './application-response';

export async function deleteInterviewRequest(
  request: Request,
  id: string,
  deps: {
    db: ReturnType<typeof createPrimaryDb>;
    actor(request: Request): string | null;
    now(): number;
    discard(actor: string, id: string): Promise<void>;
  },
) {
  const actor = deps.actor(request);
  if (!actor) {
    return applicationFailure('FORBIDDEN');
  }
  if (!validateInterviewId(id)) {
    return applicationFailure('INVALID_REQUEST');
  }
  const db = deps.db;
  const owner = and(eq(interviews.interviewId, id), eq(interviews.actorId, actor));
  const marked = db
    .select()
    .from(deletedInterviews)
    .where(and(eq(deletedInterviews.interviewId, id), eq(deletedInterviews.actorId, actor)));
  const scope = exists(marked);
  const jobIds = db
    .select({ id: deletedJobs.jobId })
    .from(deletedJobs)
    .where(and(eq(deletedJobs.interviewId, id), scope));
  const now = deps.now();
  try {
    await db.batch([
      closeAudioPeriod(db, owner, sql<number>`min(${now}, ${interviews.updatedAt})`),
      db
        .insert(deletedInterviews)
        .select(
          db
            .select({
              interviewId: interviews.interviewId,
              actorId: interviews.actorId,
              deletedAt: sql<number>`${now}`.as('deleted_at'),
            })
            .from(interviews)
            .where(owner),
        )
        .onConflictDoNothing(),
      db
        .insert(deletedJobs)
        .select(
          db
            .select({
              jobId: evaluationInputs.jobId,
              deletedAt: sql<number>`${now}`.as('deleted_at'),
              interviewId: evaluationInputs.interviewId,
            })
            .from(evaluationInputs)
            .where(and(eq(evaluationInputs.interviewId, id), scope)),
        )
        .onConflictDoNothing(),
      db.delete(executionSlots).where(inArray(executionSlots.jobId, jobIds)),
      db.delete(jobOutbox).where(inArray(jobOutbox.jobId, jobIds)),
      db.delete(jobAttempts).where(inArray(jobAttempts.jobId, jobIds)),
      db
        .delete(deliveryAnomalies)
        .where(
          and(
            inArray(deliveryAnomalies.jobId, jobIds),
            exists(db.select().from(interviews).where(owner)),
          ),
        ),
      db
        .delete(dlqReceipts)
        .where(
          and(
            inArray(dlqReceipts.jobId, jobIds),
            exists(db.select().from(interviews).where(owner)),
          ),
        ),
      db.delete(evaluationInputs).where(and(eq(evaluationInputs.interviewId, id), scope)),
      db.delete(jobs).where(inArray(jobs.jobId, jobIds)),
      db.delete(playbackReceipts).where(and(eq(playbackReceipts.interviewId, id), scope)),
      db.delete(transcriptFragments).where(and(eq(transcriptFragments.interviewId, id), scope)),
      db.delete(materialAnalyses).where(
        and(
          eq(materialAnalyses.actorId, actor),
          inArray(
            materialAnalyses.analysisId,
            db.select({ id: interviews.analysisId }).from(interviews).where(owner),
          ),
          notExists(
            db
              .select()
              .from(interviews)
              .where(
                and(
                  ne(interviews.interviewId, id),
                  eq(interviews.analysisId, materialAnalyses.analysisId),
                ),
              ),
          ),
        ),
      ),
      db.delete(interviews).where(owner),
    ]);
    if (!(await marked).length) {
      return applicationFailure('NOT_FOUND');
    }
    await deps.discard(actor, id);
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return applicationFailure('UNAVAILABLE');
  }
}
