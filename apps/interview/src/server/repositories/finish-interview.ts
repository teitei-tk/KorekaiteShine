import { and, asc, eq, exists, notExists, sql } from 'void/db';
import {
  interviews,
  transcriptFragments,
  playbackReceipts,
  evaluationInputs,
  type EvaluationConfiguration,
  type EvaluationSnapshot,
} from '@korekaite/database/interviews';
import { jobs, jobOutbox } from '@korekaite/database/jobs';
import type { createPrimaryDb } from '@korekaite/database/connection';
import { validateJobNotification } from '@korekaite/api-contracts/messages/validators';
import { loadInterview } from './interviews';

type Database = ReturnType<typeof createPrimaryDb>;
interface FinishOptions {
  jobId: string;
  evaluation: EvaluationConfiguration;
  transcriptIncomplete: boolean;
}

export async function finishInterview(
  db: Database,
  actorId: string,
  interviewId: string,
  options: FinishOptions,
  now: number,
): Promise<string | null> {
  const evaluation: EvaluationConfiguration = {
    model: options.evaluation.model,
    promptVersion: options.evaluation.promptVersion,
    rubricVersion: options.evaluation.rubricVersion,
    instructions: options.evaluation.instructions,
    rubric: options.evaluation.rubric,
  };
  const interview = await loadInterview(db, actorId, interviewId);
  if (!interview) {
    return null;
  }
  const initial = and(
    eq(evaluationInputs.interviewId, interviewId),
    eq(evaluationInputs.kind, 'initial'),
  );
  const [existing] = await db
    .select({ jobId: evaluationInputs.jobId })
    .from(evaluationInputs)
    .where(initial);
  if (existing) {
    return existing.jobId;
  }
  if (
    interview.status !== 'ending' ||
    (interview.streamGeneration !== null && !options.transcriptIncomplete)
  ) {
    return null;
  }
  if (
    !validateJobNotification({ schemaVersion: 1, jobId: options.jobId }) ||
    !Number.isSafeInteger(now) ||
    now < interview.updatedAt ||
    Object.values(evaluation).some((value) => !value.trim())
  ) {
    throw new Error('終了時の評価設定が不正です。');
  }
  const fragments = await db
    .select()
    .from(transcriptFragments)
    .where(eq(transcriptFragments.interviewId, interviewId))
    .orderBy(asc(transcriptFragments.sequence));
  const playback = await db
    .select()
    .from(playbackReceipts)
    .where(eq(playbackReceipts.interviewId, interviewId))
    .orderBy(asc(playbackReceipts.generation));
  const snapshot: EvaluationSnapshot = {
    schemaVersion: 1,
    interview: {
      interviewId,
      materialHash: interview.materialHash,
      themeTitle: interview.themeTitle,
      themeHeading: interview.themeHeading,
      themeExcerpt: interview.themeExcerpt,
      background: interview.background,
      activeMs: interview.activeMs,
    },
    fragments,
    playback,
    transcriptIncomplete: interview.transcriptIncomplete || options.transcriptIncomplete,
    evaluation,
  };
  // 全ての追記・再生確認もrevisionを更新する。読取後に変化した会話では固定を成立させない。
  const finishing = and(
    eq(interviews.interviewId, interviewId),
    eq(interviews.actorId, actorId),
    eq(interviews.status, 'ending'),
    eq(interviews.revision, interview.revision),
  );
  const eligible = and(finishing, notExists(db.select().from(evaluationInputs).where(initial)));
  const createdJob = eq(jobs.jobId, options.jobId);
  const createdInput = and(
    eq(evaluationInputs.jobId, options.jobId),
    eq(evaluationInputs.interviewId, interviewId),
  );
  await db.batch([
    db.insert(jobs).select(
      db
        .select({
          jobId: sql<string>`${options.jobId}`.as('job_id'),
          actorId: interviews.actorId,
          purpose: sql<'evaluation'>`'evaluation'`.as('purpose'),
          status: sql<'pending'>`'pending'`.as('status'),
          attemptCount: sql<number>`0`.as('attempt_count'),
          acceptedAt: sql<number>`${now}`.as('accepted_at'),
          updatedAt: sql<number>`${now}`.as('updated_at'),
          finishedAt: sql<null>`null`.as('finished_at'),
          nextAttemptAt: sql<null>`null`.as('next_attempt_at'),
          lastErrorCode: sql<null>`null`.as('last_error_code'),
          ownerToken: sql<null>`null`.as('owner_token'),
          generation: sql<number>`0`.as('generation'),
          leaseUntil: sql<null>`null`.as('lease_until'),
          attemptDeadline: sql<null>`null`.as('attempt_deadline'),
        })
        .from(interviews)
        .where(eligible),
    ),
    db.insert(evaluationInputs).select(
      db
        .select({
          jobId: jobs.jobId,
          interviewId: sql<string>`${interviewId}`.as('interview_id'),
          kind: sql<'initial'>`'initial'`.as('kind'),
          lastSequence: sql<number>`${fragments.at(-1)?.sequence ?? 0}`.as('last_sequence'),
          inputJson: sql<EvaluationSnapshot>`${JSON.stringify(snapshot)}`.as('input_json'),
          model: sql<string>`${evaluation.model}`.as('model'),
          promptVersion: sql<string>`${evaluation.promptVersion}`.as('prompt_version'),
          rubricVersion: sql<string>`${evaluation.rubricVersion}`.as('rubric_version'),
          createdAt: sql<number>`${now}`.as('created_at'),
          retryOf: sql<null>`NULL`.as('retry_of'),
        })
        .from(jobs)
        .where(and(createdJob, exists(db.select().from(interviews).where(eligible)))),
    ),
    db.insert(jobOutbox).select(
      db
        .select({
          id: sql<string>`${options.jobId + ':notify:0'}`.as('id'),
          jobId: evaluationInputs.jobId,
          purpose: sql<'evaluation'>`'evaluation'`.as('purpose'),
          operation: sql<'notify'>`'notify'`.as('operation'),
          generation: sql<number>`0`.as('generation'),
          scheduledAt: sql<number>`${now}`.as('scheduled_at'),
          sentAt: sql<null>`null`.as('sent_at'),
        })
        .from(evaluationInputs)
        .where(and(createdInput, exists(db.select().from(interviews).where(finishing)))),
    ),
    db
      .update(interviews)
      .set({
        status: 'ended',
        endedAt: now,
        updatedAt: now,
        revision: interview.revision + 1,
        streamGeneration: null,
        activeSince: null,
        deadline: null,
      })
      .where(and(finishing, exists(db.select().from(evaluationInputs).where(createdInput)))),
  ]);
  const [accepted] = await db
    .select({ jobId: evaluationInputs.jobId })
    .from(evaluationInputs)
    .where(initial);
  return accepted?.jobId ?? null;
}
